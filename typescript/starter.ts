import { parseArgs } from "node:util"
import { Client, SpreadError, Unreachable, World } from "./spread.ts"
import type {
  Action,
  ActionResult,
  DeskEvent,
  DeskEventKind,
  DeskSnapshot,
  FeeStep,
  Order,
  PostAction,
  PriceRequest,
  Score,
  StopRef,
  WorldMap,
} from "./spread.ts"
import { parseDealerNote } from "./notes.ts"
import type { ParsedLegNote } from "./notes.ts"
import {
  buildStopsForOrder,
  CHARGING_MINUTES,
  DAY,
  EMPTY_RETRY,
  HOUR,
  MapGraph,
  PLATES_MINUTES,
  SnowTracker,
  visitAt,
} from "./planner.ts"
import type { BuiltOrderStops, RetryState } from "./planner.ts"
import { PricingEngine, RosterSupplyModel, unroundedListPriceCents } from "./market.ts"
import type { BatchQuoteContext, RecordedQuoteMeta } from "./market.ts"
import {
  buildSingleGigSchedule,
  DirectOfferTracker,
  findBestTwoOrderBundle,
  tryExtendTwoToThreeOrderBundle,
} from "./dispatch.ts"
import type { ActiveDriverCommitment, BundleOrderEntry, OfferGigTarget } from "./dispatch.ts"

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

const WAKE_ON: DeskEventKind[] = [
  "price_request",
  "order_won",
  "order_changed",
  "order_cancelled",
  "visit_failed",
  "gig_expired",
  "deadline_close",
  "gig_booked",
  "gig_dropped",
  "no_show",
  "driver_late",
  "offer_answered",
  "delivered",
  "release",
  "forecast",
]

type GigState = {
  id: string
  stops: StopRef[]
  audience: { experienced: boolean; manualLicence: boolean }
  schedule: FeeStep[]
  status: "open" | "booked" | "working" | "done" | "withdrawn"
  postedAt: number
  bookedAt: number | null
  startedAt: number | null
  feeCents: number
  driverId: string | null
  isBundledTwoOrder: boolean
  splitAt: number
  urgentEscalated: boolean
  urgentEscalatedAt: number | null
  pastDeadlineEscalated: boolean
  zombieCleared: boolean
  offerWave: number
  nextOfferCheckAt: number
}

type PendingPostMeta = {
  action: PostAction
  isBundledTwoOrder: boolean
  splitAt: number
  urgentEscalated: boolean
  pastDeadlineEscalated: boolean
  strippedFallback: boolean
}

const ACTION_PRIORITY: Record<Action["type"], number> = {
  quote: 0,
  withdraw: 1,
  release: 2,
  post: 3,
  reprice: 4,
  offer: 5,
}

function undeliveredLegs(order: Order): number[] {
  return order.legs.map((_, i) => i).filter((i) => order.deliveredAt[i] === null)
}

function currentScheduleFee(schedule: readonly FeeStep[], now: number): number {
  let fee = schedule[0]?.feeCents ?? 0
  for (const step of schedule) {
    if (step.at <= now) fee = step.feeCents
  }
  return fee
}

class Desk {
  readonly world: World
  readonly level: number
  readonly map: MapGraph
  readonly snow = new SnowTracker()
  readonly supply: RosterSupplyModel
  readonly pricing: PricingEngine
  readonly offers = new DirectOfferTracker()

  now: number
  endsAt: number
  readonly outbox: Action[] = []
  readonly pendingPostMeta = new WeakMap<PostAction, PendingPostMeta>()

  readonly requests = new Map<string, PriceRequest>()
  readonly notesByOrder = new Map<string, ParsedLegNote[]>()
  readonly quoteMetaByReq = new Map<string, RecordedQuoteMeta>()
  readonly pendingPriceRequests = new Map<string, PriceRequest>()
  readonly unresolvedQuotes = new Map<string, RecordedQuoteMeta>()
  readonly batches = new Map<string, { batchId: string; seenIds: Set<string>; wonIds: Set<string>; lostIds: Set<string> }>()

  readonly orders = new Map<string, Order>()
  readonly orderWonAt = new Map<string, number>()
  readonly effectiveLastPickupByOrder = new Map<string, number>()
  readonly maxReachedFeeByOrder = new Map<string, number>()
  readonly retries = new Map<string, Map<number, RetryState>>()
  readonly urgent = new Set<string>()
  readonly doNotBundle = new Set<string>()
  readonly omitSoftCapOrders = new Set<string>()
  readonly stripWindowsOrders = new Set<string>()
  readonly postBackoffUntil = new Map<string, number>()
  readonly pairingBufferUntil = new Map<string, number>()

  readonly gigs = new Map<string, GigState>()
  readonly legGigs = new Map<string, Map<number, string>>()

  startMinute = 0
  wonOrdersTotal = 0
  deliveredOrdersTotal = 0
  deliveredOnTimeTotal = 0
  readonly lateOrPenalizedOrders = new Set<string>()
  readonly pendingRevenueOrders = new Map<string, { dealerId: string; at: number }>()
  readonly finalizedOnTimeOrders = new Map<string, string>()

  fluDayTracker = -1
  morningNonSnowDrops = 0
  fluActiveToday = false
  needsImmediateOfferPass = false
  lastNonUrgentOfferMs = 0

  constructor(
    world: World,
    level: number,
    now: number,
    endsAt: number,
    rawMap: WorldMap,
    roster = [] as Awaited<ReturnType<World["roster"]>>,
  ) {
    this.world = world
    this.level = level
    this.now = now
    this.startMinute = now
    this.endsAt = endsAt
    this.map = new MapGraph(rawMap)
    this.supply = new RosterSupplyModel(this.map, roster)
    this.pricing = new PricingEngine(level, this.map, this.snow, this.supply)
  }

  private recordOrderReachedFee(orderId: string, feeCents: number): void {
    if (feeCents <= 0) return
    const prev = this.maxReachedFeeByOrder.get(orderId) ?? 0
    if (feeCents > prev) this.maxReachedFeeByOrder.set(orderId, feeCents)
  }

  private checkDayRollover(): void {
    const day = Math.floor(this.now / DAY)
    if (day !== this.fluDayTracker) {
      this.fluDayTracker = day
      this.morningNonSnowDrops = 0
      this.fluActiveToday = false
    }
  }

  private getLegRetry(orderId: string, leg: number): RetryState {
    return this.retries.get(orderId)?.get(leg) ?? EMPTY_RETRY
  }

  private setLegRetry(orderId: string, leg: number, next: RetryState): void {
    let m = this.retries.get(orderId)
    if (!m) {
      m = new Map()
      this.retries.set(orderId, m)
    }
    m.set(leg, next)
  }

  private getNotes(orderId: string): ParsedLegNote[] {
    const cached = this.notesByOrder.get(orderId)
    if (cached) return cached
    const req = this.requests.get(orderId)
    if (req) {
      const parsed = parseDealerNote(req)
      this.notesByOrder.set(orderId, parsed)
      return parsed
    }
    const order = this.orders.get(orderId)
    if (!order) return []
    return order.legs.map((l) => ({
      readyAt: l.pickup.window.from,
      releasedAt: null,
      pickupHours: l.pickup.hours,
      deliveryHours: l.delivery.hours,
      manualGearbox: false,
      needsPlates: false,
      summerTyres: false,
      noteDeadline: null,
    }))
  }

  private linkGig(gig: GigState): void {
    this.gigs.set(gig.id, gig)
    for (const stop of gig.stops) {
      if (stop.kind !== "pickup") continue
      let m = this.legGigs.get(stop.orderId)
      if (!m) {
        m = new Map()
        this.legGigs.set(stop.orderId, m)
      }
      m.set(stop.leg, gig.id)
    }
  }

  private unlinkGig(gigId: string): void {
    const gig = this.gigs.get(gigId)
    if (!gig) return
    for (const stop of gig.stops) {
      const m = this.legGigs.get(stop.orderId)
      if (m?.get(stop.leg) === gigId) {
        m.delete(stop.leg)
      }
    }
    this.offers.clearGig(gigId)
  }

  private distinctLiveOrdersOfStops(stops: readonly StopRef[]): Order[] {
    const seen = new Set<string>()
    const list: Order[] = []
    for (const s of stops) {
      if (seen.has(s.orderId)) continue
      seen.add(s.orderId)
      const o = this.orders.get(s.orderId)
      if (o) list.push(o)
    }
    return list
  }

  private removeUnsentPostsForOrder(orderId: string): StopRef[] {
    const displacedOtherStops: StopRef[] = []
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const act = this.outbox[i]!
      if (act.type === "post" && act.stops.some((s) => s.orderId === orderId)) {
        for (const s of act.stops) {
          if (s.orderId !== orderId && s.kind === "pickup") displacedOtherStops.push(s)
        }
        this.outbox.splice(i, 1)
      }
    }
    return displacedOtherStops
  }

  private hasPendingPostInOutbox(orderId: string, leg: number): boolean {
    return this.outbox.some(
      (a) => a.type === "post" && a.stops.some((s) => s.kind === "pickup" && s.orderId === orderId && s.leg === leg),
    )
  }

  private activeCommitments(): ActiveDriverCommitment[] {
    const list: ActiveDriverCommitment[] = []
    for (const g of this.gigs.values()) {
      if ((g.status !== "booked" && g.status !== "working") || !g.driverId) continue
      const pickups = g.stops.filter((s) => s.kind === "pickup")
      const delivs = g.stops.filter((s) => s.kind === "delivery")
      if (pickups.length === 0 || delivs.length === 0) continue
      const firstOrd = this.orders.get(pickups[0]!.orderId)
      const lastOrd = this.orders.get(delivs[delivs.length - 1]!.orderId)
      if (!firstOrd || !lastOrd) continue

      const pPlace = firstOrd.legs[pickups[0]!.leg]?.pickup.placeId
      const dPlace = lastOrd.legs[delivs[delivs.length - 1]!.leg]?.delivery.placeId
      if (!pPlace || !dPlace) continue

      let roadSum = 0
      let prevPlace: string | undefined
      for (const s of g.stops) {
        const o = this.orders.get(s.orderId)
        const leg = o?.legs[s.leg]
        if (!leg) continue
        const pl = s.kind === "pickup" ? leg.pickup.placeId : leg.delivery.placeId
        if (prevPlace !== undefined && prevPlace !== pl) {
          roadSum += this.map.roadMinutes(prevPlace, pl)
        }
        prevPlace = pl
      }

      const estStart =
        g.status === "working" && g.startedAt !== null
          ? g.startedAt
          : Math.max(
              this.now,
              pickups[0]!.window?.from ?? firstOrd.legs[pickups[0]!.leg]!.pickup.window.from,
            )
      const estFinish = Math.max(this.now + 5, estStart + roadSum + pickups.length * 25)
      list.push({
        gigId: g.id,
        driverId: g.driverId,
        status: g.status,
        pickupPlaceId: pPlace,
        deliveryPlaceId: dPlace,
        estStartAt: estStart,
        estFinishAt: estFinish,
        driveMinutes: roadSum,
      })
    }
    return list
  }

  private countUnbookedOrders(): number {
    let count = 0
    for (const o of this.orders.values()) {
      const undel = undeliveredLegs(o)
      if (undel.length === 0) continue
      const m = this.legGigs.get(o.id)
      const allBooked = undel.every((leg) => {
        const gid = m?.get(leg)
        const g = gid ? this.gigs.get(gid) : undefined
        return g && (g.status === "booked" || g.status === "working")
      })
      if (!allBooked) count++
    }
    return count
  }

  private pruneUnresolvedQuotes(): void {
    for (const [reqId, meta] of this.unresolvedQuotes.entries()) {
      if (meta.request.respondBy <= this.now || this.orders.has(reqId)) {
        this.unresolvedQuotes.delete(reqId)
      }
    }
  }

  private totalUnresolvedExpectedWins(): number {
    let sum = 0
    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.respondBy > this.now && !this.orders.has(meta.request.id)) {
        sum += meta.expectedWinProb
      }
    }
    return sum
  }

  private recordBatchArrival(request: PriceRequest): void {
    if (!request.batchId) return
    let st = this.batches.get(request.batchId)
    if (!st) {
      st = { batchId: request.batchId, seenIds: new Set(), wonIds: new Set(), lostIds: new Set() }
      this.batches.set(request.batchId, st)
    }
    st.seenIds.add(request.id)
  }

  private countActiveOrdersOnDeadlineDay(deadlineDay: number): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (undeliveredLegs(o).length === 0) {
        const lastDeliv = o.deliveredAt[o.deliveredAt.length - 1]
        if (lastDeliv !== null && Math.floor(lastDeliv / DAY) === deadlineDay && Math.floor(this.now / DAY) === deadlineDay) {
          count += 0.55
        }
        continue
      }
      const notes = this.getNotes(o.id)
      const noteDl = notes[notes.length - 1]?.noteDeadline ?? notes[0]?.noteDeadline ?? null
      const effDl = noteDl !== null ? Math.min(o.deadline, noteDl) : o.deadline
      if (Math.floor(effDl / DAY) === deadlineDay) count++
    }
    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.respondBy <= this.now || this.orders.has(meta.request.id)) continue
      for (const d of meta.expectedWinsByDeadlineDay) {
        if (d.deadlineDay === deadlineDay) count += d.expectedWins
      }
    }
    return count
  }

  private countOpenPickupsInCluster30(placeId: string): number {
    const cluster = new Set(this.map.within30km.get(placeId) ?? [placeId])
    let count = 0
    for (const g of this.gigs.values()) {
      if (g.status !== "open") continue
      const p0 = g.stops[0]
      if (!p0) continue
      const o = this.orders.get(p0.orderId)
      const pId = o?.legs[p0.leg]?.pickup.placeId
      if (pId && cluster.has(pId)) count++
    }
    return count
  }

  private countPendingPickupsInCluster30(placeId: string): number {
    const cluster = new Set(this.map.within30km.get(placeId) ?? [placeId])
    let count = 0
    for (const act of this.outbox) {
      if (act.type !== "post" || !act.stops[0]) continue
      const p0 = act.stops[0]
      const o = this.orders.get(p0.orderId)
      const pId = o?.legs[p0.leg]?.pickup.placeId
      if (pId && cluster.has(pId)) count++
    }
    for (const bufferedId of this.pairingBufferUntil.keys()) {
      const o = this.orders.get(bufferedId)
      if (!o) continue
      const undel = undeliveredLegs(o)
      if (undel.length === 0) continue
      const leg0 = undel[0]!
      if (this.legGigs.get(o.id)?.has(leg0) || this.hasPendingPostInOutbox(o.id, leg0)) continue
      const pId = o.legs[leg0]?.pickup.placeId
      if (pId && cluster.has(pId)) count++
    }
    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.respondBy <= this.now || this.orders.has(meta.request.id)) continue
      const pId = meta.request.legs[0]?.pickup.placeId
      if (pId && cluster.has(pId)) count += meta.expectedWinProb
    }
    return count
  }

  private countOverdueUndeliveredOrders(): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (undeliveredLegs(o).length === 0) continue
      const notes = this.getNotes(o.id)
      const noteDl = notes[notes.length - 1]?.noteDeadline ?? notes[0]?.noteDeadline ?? null
      const effDl = noteDl !== null ? Math.min(o.deadline, noteDl) : o.deadline
      if (this.now > effDl) count++
    }
    return count
  }

  private countInFlightDealerOrders(dealerId: string): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (o.dealerId !== dealerId || undeliveredLegs(o).length === 0) continue
      const notes = this.getNotes(o.id)
      const noteDl = notes[notes.length - 1]?.noteDeadline ?? notes[0]?.noteDeadline ?? null
      const effDl = noteDl !== null ? Math.min(o.deadline, noteDl) : o.deadline
      if (this.now <= effDl) count += 0.96
    }
    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.dealerId !== dealerId) continue
      if (meta.request.respondBy <= this.now || this.orders.has(meta.request.id)) continue
      count += meta.expectedWinProb
    }
    return count
  }

  private hasArrivingDriverSynergy(pickupId: string, deliveryId: string, earliestMin: number, latestMin: number): boolean {
    const comms = this.activeCommitments()
    for (const c of comms) {
      if (this.map.distKm(c.deliveryPlaceId, pickupId) > 35) continue
      const link = this.map.roadMinutes(c.deliveryPlaceId, pickupId)
      if (c.estFinishAt + link < earliestMin - 90 || c.estFinishAt + link > latestMin - 30) continue
      const prof = this.supply.byId.get(c.driverId)
      if (prof && this.map.distKm(prof.homePlaceId, deliveryId) <= 35) return true
    }
    return false
  }

  private computeRoundTripPartnerCredit(
    currentReqId: string,
    pickupId: string,
    deliveryId: string,
    earliestPickupAt: number,
    effectiveLastPickupAt: number,
    effectiveDeadline: number,
  ): number {
    for (const bufferedId of this.pairingBufferUntil.keys()) {
      const o = this.orders.get(bufferedId)
      if (!o || o.legs.length !== 1) continue
      const l = o.legs[0]!
      if (l.car.premium || l.pickup.privateAddress || l.delivery.privateAddress) continue
      if (
        this.map.roadMinutes(l.delivery.placeId, pickupId) <= 50 &&
        this.map.roadMinutes(deliveryId, l.pickup.placeId) <= 120
      ) {
        return 1.0
      }
    }
    for (const g of this.gigs.values()) {
      if (g.status !== "open" || g.isBundledTwoOrder) continue
      if (g.stops.length !== 2) continue
      const o = this.orders.get(g.stops[0]!.orderId)
      if (!o || o.legs.length !== 1) continue
      const l = o.legs[0]!
      if (l.car.premium || l.pickup.privateAddress || l.delivery.privateAddress) continue
      if (
        this.map.roadMinutes(l.delivery.placeId, pickupId) <= 50 &&
        this.map.roadMinutes(deliveryId, l.pickup.placeId) <= 120
      ) {
        return 1.0
      }
    }
    if (effectiveLastPickupAt - this.now < 300) return 0
    const myReadyDay = Math.floor(earliestPickupAt / DAY)
    const myDlDay = Math.floor(effectiveDeadline / DAY)
    const r1 = this.map.roadMinutes(pickupId, deliveryId)
    let missOpposing = 1.0
    let missLocal = 1.0
    const tod = this.now % DAY
    const inPw = tod >= 8 * HOUR && tod <= 18 * HOUR && this.level === 8 && this.pricing.estimator.priceWarToday

    const considerCandidate = (cand: PriceRequest, candWinProb: number): void => {
      if (cand.id === currentReqId || candWinProb < 0.05 || cand.legs.length !== 1) return
      const l2 = cand.legs[0]!
      if (l2.car.premium || l2.pickup.privateAddress || l2.delivery.privateAddress) return
      const n2 = this.notesByOrder.get(cand.id)?.[0]
      const P2 = l2.pickup.placeId
      const D2 = l2.delivery.placeId
      const maxCandDl = cand.options[cand.options.length - 1]?.deadline ?? 0
      if (n2?.summerTyres && this.snow.overlaps(P2, D2, this.now, maxCandDl)) return
      const candReadyDay = Math.floor(Math.max(l2.pickup.window.from, n2?.readyAt ?? 0) / DAY)
      const candDlDay = Math.floor(Math.min(maxCandDl, n2?.noteDeadline ?? Infinity) / DAY)
      if (candReadyDay > myDlDay || myReadyDay > candDlDay) return
      const dh12 = this.map.roadMinutes(deliveryId, P2)
      const dh21 = this.map.roadMinutes(D2, pickupId)
      if (dh12 > 50 || dh21 > 50 || r1 + dh12 + this.map.roadMinutes(P2, D2) > 540) return
      if (!this.map.isSameCluster30(pickupId, P2)) {
        missOpposing *= 1 - candWinProb
      } else if (dh12 <= 40 && dh21 <= 40) {
        missLocal *= 1 - 0.5 * candWinProb
      }
    }

    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.respondBy <= this.now || this.orders.has(meta.request.id)) continue
      considerCandidate(meta.request, meta.expectedWinProb)
    }
    const unquotedPriorProb = inPw ? 0.12 : 0.38
    for (const pendingReq of this.pendingPriceRequests.values()) {
      if (pendingReq.respondBy <= this.now || this.unresolvedQuotes.has(pendingReq.id)) continue
      considerCandidate(pendingReq, unquotedPriorProb)
    }
    const pOpposing = 1 - missOpposing
    const pLocal = 1 - missLocal
    return Math.min(0.85, 0.90 * pOpposing + 0.42 * (1 - pOpposing) * pLocal)
  }

  private finalizePendingRevenue(upToMinute: number): void {
    for (const [orderId, info] of this.pendingRevenueOrders.entries()) {
      if (info.at > upToMinute) continue
      this.pendingRevenueOrders.delete(orderId)
      const onTime = !this.lateOrPenalizedOrders.has(orderId)
      this.deliveredOrdersTotal++
      if (onTime) {
        this.deliveredOnTimeTotal++
        this.finalizedOnTimeOrders.set(orderId, info.dealerId)
      }
      this.pricing.estimator.onOrderDelivered(info.dealerId, onTime)
    }
  }

  private markLateOrPenalized(orderId: string): void {
    if (this.lateOrPenalizedOrders.has(orderId)) return
    this.lateOrPenalizedOrders.add(orderId)
    const pendingRev = this.pendingRevenueOrders.get(orderId)
    if (pendingRev) {
      this.pendingRevenueOrders.delete(orderId)
      this.deliveredOrdersTotal++
      this.pricing.estimator.onOrderDelivered(pendingRev.dealerId, false)
      return
    }
    const alreadyOnTimeDealer = this.finalizedOnTimeOrders.get(orderId)
    if (alreadyOnTimeDealer) {
      this.finalizedOnTimeOrders.delete(orderId)
      if (this.deliveredOnTimeTotal > 0) this.deliveredOnTimeTotal--
      const d = this.pricing.estimator.getDealer(alreadyOnTimeDealer)
      if (this.level === 8) d.trust = Math.floor(Math.max(0, d.trust - 1) / 2)
      d.lateCount = Math.min(6, d.lateCount + 1.125)
    }
  }

  async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    this.now = snapshot.now
    this.endsAt = snapshot.endsAt
    this.startMinute = history[0]?.at ?? snapshot.now

    const openReqIds = new Set(snapshot.openRequests.map((r) => r.id))

    for (const ev of history) {
      this.now = Math.max(this.now, ev.at)
      this.checkDayRollover()
      this.finalizePendingRevenue(ev.at - 1)

      if (ev.kind === "price_request") {
        this.requests.set(ev.request.id, ev.request)
        const notes = parseDealerNote(ev.request)
        this.notesByOrder.set(ev.request.id, notes)
        this.recordBatchArrival(ev.request)
        if (!openReqIds.has(ev.request.id)) {
          const meta = this.pricing.quoteRequest(ev.request, notes, {
            now: ev.at,
            startMinute: this.startMinute,
            wonOrdersTotal: this.wonOrdersTotal,
            deliveredOrdersTotal: this.deliveredOrdersTotal,
            deliveredOnTimeTotal: this.deliveredOnTimeTotal,
            unbookedOrdersCount: 10,
            openPickupsInCluster30: () => 0,
            activeOrdersOnDeadlineDay: () => 35,
            hasArrivingDriverSynergy: () => false,
            roundTripPartnerCredit: () => 0,
            fluActiveToday: this.fluActiveToday,
          })
          if (meta) this.quoteMetaByReq.set(ev.request.id, meta)
        }
      } else if (ev.kind === "forecast") {
        this.snow.addForecast(ev.from, ev.to, ev.placeIds)
      } else if (ev.kind === "deadline_close") {
        this.urgent.add(ev.orderId)
      } else if (ev.kind === "order_won") {
        this.wonOrdersTotal++
        this.orderWonAt.set(ev.order.id, ev.at)
        const req = this.requests.get(ev.order.id)
        if (req?.batchId) this.batches.get(req.batchId)?.wonIds.add(ev.order.id)
        const meta = this.quoteMetaByReq.get(ev.order.id)
        if (meta) this.pricing.estimator.onQuoteResolved(meta, ev.order.option)
      } else if (ev.kind === "order_lost") {
        const req = this.requests.get(ev.requestId)
        if (req?.batchId) this.batches.get(req.batchId)?.lostIds.add(ev.requestId)
        const meta = this.quoteMetaByReq.get(ev.requestId)
        if (meta) this.pricing.estimator.onQuoteResolved(meta, null)
      } else if (ev.kind === "order_cancelled") {
        if (this.wonOrdersTotal > 0) this.wonOrdersTotal--
        const req = this.requests.get(ev.orderId)
        if (req?.batchId) this.batches.get(req.batchId)?.wonIds.delete(ev.orderId)
      } else if (ev.kind === "order_changed") {
        const notes = this.getNotes(ev.order.id)
        for (let l = 0; l < ev.order.legs.length; l++) {
          if (notes[l]) {
            notes[l]!.deliveryHours = ev.order.legs[l]!.delivery.hours
              ? {
                  opens: ev.order.legs[l]!.delivery.hours!.opens,
                  closes: ev.order.legs[l]!.delivery.hours!.closes,
                  weekdays: [...ev.order.legs[l]!.delivery.hours!.weekdays],
                  saturday: ev.order.legs[l]!.delivery.hours!.saturday
                    ? { ...ev.order.legs[l]!.delivery.hours!.saturday! }
                    : null,
                }
              : null
          }
        }
      } else if (ev.kind === "gig_viewed") {
        this.offers.recordView(ev.driverId, ev.at, ev.gigId)
      } else if (ev.kind === "gig_booked") {
        this.offers.recordBooked(ev.driverId, ev.gigId, ev.at)
      } else if (ev.kind === "delivered") {
        this.offers.recordDelivered(null, ev.placeId, ev.at)
      } else if (ev.kind === "offer_answered") {
        const dayKey = `${Math.floor(Math.max(0, ev.at - 1) / DAY)}:${ev.driverId}`
        this.offers.offersSentByDay.set(dayKey, (this.offers.offersSentByDay.get(dayKey) ?? 0) + 1)
        this.offers.attemptedGigDrivers.add(`${ev.gigId}:${ev.driverId}`)
      } else if (ev.kind === "gig_dropped") {
        const tod = ev.at % DAY
        if (tod >= 5 * HOUR && tod <= 9 * HOUR + 30) {
          this.morningNonSnowDrops++
          if (this.morningNonSnowDrops >= 3) this.fluActiveToday = true
        }
      } else if (ev.kind === "release") {
        const notes = this.getNotes(ev.orderId)
        if (notes[ev.leg]) notes[ev.leg]!.releasedAt = ev.at
        const cur = this.getLegRetry(ev.orderId, ev.leg)
        this.setLegRetry(ev.orderId, ev.leg, { ...cur, pickupFrom: 0 })
      } else if (ev.kind === "visit_failed") {
        const ord = snapshot.orders.find((o) => o.id === ev.orderId)
        const req = this.requests.get(ev.orderId)
        const prev = this.getLegRetry(ev.orderId, ev.leg)
        const carNotThere = ev.reason === "not_ready" || ev.reason === "closed"
        const pickupFrom =
          carNotThere && ord && req ? this.computeRetryFrom(ord, req, ev.leg, ev.at) : prev.pickupFrom
        this.setLegRetry(ev.orderId, ev.leg, {
          pickupFrom,
          manualLicence: prev.manualLicence || ev.reason === "licence",
          plates: prev.plates || ev.reason === "no_plates",
        })
      } else if (ev.kind === "ledger") {
        if ((ev.line.kind === "late_refund" || ev.line.kind === "undelivered_penalty") && ev.line.orderId) {
          this.markLateOrPenalized(ev.line.orderId)
        } else if (ev.line.kind === "revenue" && ev.line.orderId) {
          const req = this.requests.get(ev.line.orderId)
          if (req) this.pendingRevenueOrders.set(ev.line.orderId, { dealerId: req.dealerId, at: ev.at })
        }
      }
    }
    this.now = snapshot.now
    this.finalizePendingRevenue(snapshot.now - 1)

    for (const order of snapshot.orders) {
      if (order.status !== "cancelled") {
        this.orders.set(order.id, order)
        if (!this.orderWonAt.has(order.id)) this.orderWonAt.set(order.id, snapshot.now)
      }
    }

    for (const gig of snapshot.gigs) {
      const distinctOrders = new Set(gig.stops.map((s) => s.orderId))
      const state: GigState = {
        id: gig.id,
        stops: gig.stops,
        audience: gig.audience,
        schedule: gig.schedule,
        status: gig.status,
        postedAt: gig.postedAt,
        bookedAt: gig.status === "booked" || gig.status === "working" ? gig.postedAt : null,
        startedAt: gig.status === "working" ? Math.max(gig.postedAt, snapshot.now - 30) : null,
        feeCents: gig.feeCents,
        driverId: gig.driverId,
        isBundledTwoOrder: distinctOrders.size > 1,
        splitAt: gig.postedAt + 120,
        urgentEscalated: gig.stops.some((s) => this.urgent.has(s.orderId)),
        urgentEscalatedAt: gig.stops.some((s) => this.urgent.has(s.orderId)) ? snapshot.now : null,
        pastDeadlineEscalated: false,
        zombieCleared: gig.stops[0] ? gig.postedAt > (this.orders.get(gig.stops[0].orderId)?.lastPickupAt ?? Infinity) : false,
        offerWave: 0,
        nextOfferCheckAt: snapshot.now + 12,
      }
      if (gig.status === "open" || gig.status === "booked" || gig.status === "working") {
        this.linkGig(state)
      } else {
        this.gigs.set(gig.id, state)
      }
    }

    for (const order of this.orders.values()) {
      const missing = undeliveredLegs(order).filter((leg) => !this.legGigs.get(order.id)?.has(leg))
      if (missing.length > 0) {
        this.dispatchOrderLegs(order, missing, false)
      }
    }

    for (const req of snapshot.openRequests) {
      if (req.respondBy > snapshot.now) {
        this.handlePriceRequest(req)
      }
    }
    this.flushPendingPriceRequests()
  }

  handle(event: DeskEvent): void {
    this.now = Math.max(this.now, event.at)
    this.checkDayRollover()
    this.finalizePendingRevenue(event.at - 1)

    switch (event.kind) {
      case "forecast":
        this.snow.addForecast(event.from, event.to, event.placeIds)
        break
      case "price_request":
        this.handlePriceRequest(event.request)
        break
      case "order_won":
        this.handleOrderWon(event.order, event.at)
        break
      case "order_lost":
        this.handleOrderLost(event.requestId)
        break
      case "order_changed":
        this.handleOrderChanged(event.order)
        break
      case "order_cancelled":
        this.handleOrderCancelled(event.orderId, event.gigs)
        break
      case "gig_viewed": {
        this.offers.recordView(event.driverId, event.at, event.gigId)
        const vg = this.gigs.get(event.gigId)
        if (vg && vg.status === "open" && this.now >= vg.postedAt + 8) {
          const vCount = this.offers.gigViewers.get(event.gigId)?.get(event.driverId)?.count ?? 0
          if (vCount >= 2) {
            vg.nextOfferCheckAt = Math.min(vg.nextOfferCheckAt, this.now + 1)
            this.needsImmediateOfferPass = true
          }
        }
        break
      }
      case "gig_booked":
        this.handleGigBooked(event.gigId, event.driverId, event.feeCents, event.at)
        break
      case "gig_started": {
        const g = this.gigs.get(event.gigId)
        if (g) {
          g.status = "working"
          g.driverId = event.driverId
          g.startedAt = event.at
        }
        break
      }
      case "gig_dropped":
      case "no_show":
        this.handleGigDroppedOrNoShow(event.gigId, event.kind === "gig_dropped")
        break
      case "driver_late":
        this.handleDriverLate(event.gigId, event.pickupAt)
        break
      case "gig_expired":
        this.handleGigExpired(event.gigId)
        break
      case "offer_answered":
        this.handleOfferAnswered(event.gigId, event.driverId, event.answer)
        break
      case "release":
        this.handleReleaseEvent(event.orderId, event.leg, event.at)
        break
      case "visit_failed":
        this.handleVisitFailed(event.gigId, event.orderId, event.leg, event.reason)
        break
      case "delivered":
        this.handleDelivered(event.gigId, event.orderId, event.leg, event.placeId, event.at)
        break
      case "deadline_close":
        this.handleDeadlineClose(event.orderId)
        break
      case "ledger":
        if ((event.line.kind === "late_refund" || event.line.kind === "undelivered_penalty") && event.line.orderId) {
          this.markLateOrPenalized(event.line.orderId)
        } else if (event.line.kind === "revenue" && event.line.orderId) {
          const ord = this.orders.get(event.line.orderId)
          const req = this.requests.get(event.line.orderId)
          const dealerId = ord?.dealerId ?? req?.dealerId
          if (dealerId) {
            this.pendingRevenueOrders.set(event.line.orderId, { dealerId, at: event.at })
          }
        }
        break
    }
  }

  private handlePriceRequest(request: PriceRequest): void {
    this.requests.set(request.id, request)
    if (!this.notesByOrder.has(request.id)) {
      this.notesByOrder.set(request.id, parseDealerNote(request))
    }
    this.recordBatchArrival(request)
    if (request.respondBy <= this.now) {
      this.pricing.estimator.getDealer(request.dealerId).unquotedCount++
      return
    }
    if (this.quoteMetaByReq.has(request.id) || this.orders.has(request.id)) return
    this.pendingPriceRequests.set(request.id, request)
  }

  private scorePendingRequestPriority(req: PriceRequest, pendingList: readonly PriceRequest[]): number {
    const leg0 = req.legs[0]!
    const lastLeg = req.legs[req.legs.length - 1]!
    const pickupId = leg0.pickup.placeId
    const deliveryId = lastLeg.delivery.placeId
    const legKms = req.legs.map((l) => this.map.roadKm(l.pickup.placeId, l.delivery.placeId))
    const refOpt = req.options.some((o) => o.kind === "next_day") ? "next_day" : req.options[0]!.kind
    const ulp = unroundedListPriceCents(legKms, refOpt)
    const dealer = this.pricing.estimator.getDealer(req.dealerId)
    const trustMult = this.level === 8 ? 1 + 0.01 * dealer.trust : 1.0
    const worldMult = this.level >= 8 ? Math.exp(this.pricing.estimator.worldLogMean) : 1.22
    const grossHeadroomCents = ulp * worldMult * trustMult - req.referenceFeeCents * 0.92
    const destPool30 = this.supply.pool30(deliveryId, false, false)
    const destBonusCents = destPool30 >= 80 ? 950 : destPool30 >= 25 ? 300 : -650

    let hasMutualOrOpenRT = false
    if (req.legs.length === 1 && !leg0.car.premium && !leg0.pickup.privateAddress && !leg0.delivery.privateAddress) {
      const maxDl = req.options[req.options.length - 1]!.deadline
      if (this.computeRoundTripPartnerCredit(req.id, pickupId, deliveryId, leg0.pickup.window.from, maxDl, maxDl) >= 0.25) {
        hasMutualOrOpenRT = true
      } else {
        hasMutualOrOpenRT = pendingList.some((other) => {
          if (other.id === req.id || other.legs.length !== 1) return false
          const ol = other.legs[0]!
          if (ol.car.premium || ol.pickup.privateAddress || ol.delivery.privateAddress) return false
          return (
            !this.map.isSameCluster30(pickupId, ol.pickup.placeId) &&
            this.map.roadMinutes(deliveryId, ol.pickup.placeId) <= 50 &&
            this.map.roadMinutes(ol.delivery.placeId, pickupId) <= 50
          )
        })
      }
    }
    const notes = this.getNotes(req.id)
    const needsCharging = req.legs.some((l) => this.map.needsCharging(l.car, l.pickup.placeId, l.delivery.placeId))
    const frictionPenaltyCents =
      (req.legs.some((l) => l.car.premium) ? 700 : 0) +
      (req.legs.some((l) => l.pickup.privateAddress || l.delivery.privateAddress) ? 800 : 0) +
      (req.legs.length > 1 ? 600 : 0) +
      (needsCharging ? 450 : 0) +
      (notes[0]?.manualGearbox ? 250 : 0)

    return grossHeadroomCents + destBonusCents + (hasMutualOrOpenRT ? 1100 : 0) - frictionPenaltyCents
  }

  flushPendingPriceRequests(): void {
    this.pruneUnresolvedQuotes()
    if (this.pendingPriceRequests.size === 0) return

    const validList: PriceRequest[] = []
    for (const req of this.pendingPriceRequests.values()) {
      if (req.respondBy <= this.now) {
        this.pendingPriceRequests.delete(req.id)
        this.pricing.estimator.getDealer(req.dealerId).unquotedCount++
        continue
      }
      validList.push(req)
    }
    if (validList.length === 0) return

    const priorities = new Map<string, number>()
    for (const req of validList) {
      priorities.set(req.id, this.scorePendingRequestPriority(req, validList))
    }
    validList.sort((a, b) => {
      const diff = (priorities.get(b.id) ?? 0) - (priorities.get(a.id) ?? 0)
      if (Math.abs(diff) > 1e-6) return diff
      if (a.arrivedAt !== b.arrivedAt) return a.arrivedAt - b.arrivedAt
      return a.id.localeCompare(b.id)
    })

    for (const request of validList) {
      this.pendingPriceRequests.delete(request.id)
      const notes = this.getNotes(request.id)
      const pendingExpWins = this.totalUnresolvedExpectedWins()

      let batchInfo: BatchQuoteContext | undefined
      if (request.batchId) {
        const st = this.batches.get(request.batchId)
        let batchUnres = 0
        for (const u of this.unresolvedQuotes.values()) {
          if (u.request.batchId === request.batchId && u.request.respondBy > this.now && !this.orders.has(u.request.id)) {
            batchUnres += u.expectedWinProb
          }
        }
        batchInfo = {
          batchId: request.batchId,
          seenCount: st?.seenIds.size ?? 1,
          wonCount: st?.wonIds.size ?? 0,
          unresolvedExpectedWins: batchUnres,
        }
      }

      const meta = this.pricing.quoteRequest(request, notes, {
        now: this.now,
        startMinute: this.startMinute,
        wonOrdersTotal: this.wonOrdersTotal + pendingExpWins,
        deliveredOrdersTotal: this.deliveredOrdersTotal,
        deliveredOnTimeTotal: this.deliveredOnTimeTotal,
        overdueUndeliveredCount: this.countOverdueUndeliveredOrders(),
        unbookedOrdersCount: this.countUnbookedOrders() + pendingExpWins,
        openPickupsInCluster30: (p) => this.countOpenPickupsInCluster30(p),
        pendingPickupsInCluster30: (p) => this.countPendingPickupsInCluster30(p),
        activeOrdersOnDeadlineDay: (dlDay) => this.countActiveOrdersOnDeadlineDay(dlDay),
        inFlightDealerOrders: (dId) => this.countInFlightDealerOrders(dId),
        hasArrivingDriverSynergy: (p, d, eMin, lMin) => this.hasArrivingDriverSynergy(p, d, eMin, lMin),
        roundTripPartnerCredit: (p, d, ePick, lPick, effDl) =>
          this.computeRoundTripPartnerCredit(request.id, p, d, ePick, lPick, effDl),
        batchInfo,
        fluActiveToday: this.fluActiveToday,
      })

      if (!meta) continue
      this.quoteMetaByReq.set(request.id, meta)
      if (meta.expectedWinProb > 0) {
        this.unresolvedQuotes.set(request.id, meta)
      }
      this.outbox.push({
        type: "quote",
        requestId: request.id,
        prices: meta.prices,
      })
    }
  }

  private handleOrderWon(order: Order, at: number): void {
    if (!this.requests.has(order.id) || this.orders.has(order.id)) return
    this.orders.set(order.id, order)
    this.orderWonAt.set(order.id, at)
    this.wonOrdersTotal++
    this.unresolvedQuotes.delete(order.id)
    this.pendingPriceRequests.delete(order.id)
    const req = this.requests.get(order.id)
    if (req?.batchId) this.batches.get(req.batchId)?.wonIds.add(order.id)

    const meta = this.quoteMetaByReq.get(order.id)
    if (meta) {
      this.pricing.estimator.onQuoteResolved(meta, order.option)
    }

    this.dispatchOrderLegs(order, undeliveredLegs(order), true)
  }

  private handleOrderLost(requestId: string): void {
    this.unresolvedQuotes.delete(requestId)
    this.pendingPriceRequests.delete(requestId)
    const req = this.requests.get(requestId)
    if (req?.batchId) this.batches.get(req.batchId)?.lostIds.add(requestId)
    const meta = this.quoteMetaByReq.get(requestId)
    if (meta) {
      this.pricing.estimator.onQuoteResolved(meta, null)
    }
  }

  private handleOrderChanged(order: Order): void {
    if (!this.orders.has(order.id)) return
    const prev = this.orders.get(order.id)!
    this.orders.set(order.id, order)
    this.omitSoftCapOrders.delete(order.id)
    this.stripWindowsOrders.delete(order.id)
    this.postBackoffUntil.delete(order.id)
    this.pairingBufferUntil.delete(order.id)

    const notes = this.getNotes(order.id)
    for (let l = 0; l < order.legs.length; l++) {
      if (order.legs[l]!.pickup.window.from !== prev.legs[l]?.pickup.window.from) {
        const r = this.getLegRetry(order.id, l)
        if (r.pickupFrom > 0) this.setLegRetry(order.id, l, { ...r, pickupFrom: 0 })
      }
      if (notes[l]) {
        if (order.legs[l]!.delivery.placeId !== prev.legs[l]?.delivery.placeId) {
          notes[l]!.noteDeadline = null
          notes[l]!.deliveryHours = order.legs[l]!.delivery.hours
            ? {
                opens: order.legs[l]!.delivery.hours!.opens,
                closes: order.legs[l]!.delivery.hours!.closes,
                weekdays: [...order.legs[l]!.delivery.hours!.weekdays],
                saturday: order.legs[l]!.delivery.hours!.saturday
                  ? { ...order.legs[l]!.delivery.hours!.saturday! }
                  : null,
              }
            : null
        } else if (order.deadline > prev.deadline && notes[l]!.noteDeadline !== null) {
          notes[l]!.noteDeadline = notes[l]!.noteDeadline! + (order.deadline - prev.deadline)
        }
      }
    }

    const undelAll = undeliveredLegs(order)
    if (undelAll.length > 0) {
      const b = buildStopsForOrder(this.map, this.snow, order, undelAll, notes, this.retries.get(order.id) ?? new Map(), this.now, this.endsAt)
      this.effectiveLastPickupByOrder.set(order.id, b.effectiveLastPickupAt)
    }

    const displacedPartners = this.removeUnsentPostsForOrder(order.id)
    const openGigsToWithdraw = new Set<string>()
    const bookedGigsToRelease = new Set<string>()
    const m = this.legGigs.get(order.id)
    if (m) {
      for (const [legIdx, gid] of m.entries()) {
        const g = this.gigs.get(gid)
        if (!g) continue
        if (g.status === "open") {
          openGigsToWithdraw.add(gid)
        } else if (g.status === "booked") {
          // If order_changed rerouted a <30% EV across >200km on a booked gig without withCharging,
          // release & repost with withCharging: true to avoid the -€100 EV fine + 90m late penalty!
          const legObj = order.legs[legIdx]
          const pStop = g.stops.find((s) => s.kind === "pickup" && s.orderId === order.id && s.leg === legIdx)
          if (
            legObj &&
            pStop &&
            !pStop.withCharging &&
            this.map.needsCharging(legObj.car, legObj.pickup.placeId, legObj.delivery.placeId)
          ) {
            bookedGigsToRelease.add(gid)
          }
        }
      }
    }

    const partnerOrders = new Set<string>()
    for (const s of displacedPartners) partnerOrders.add(s.orderId)

    for (const gid of openGigsToWithdraw) {
      const g = this.gigs.get(gid)!
      for (const o of this.distinctLiveOrdersOfStops(g.stops)) {
        if (o.id !== order.id) partnerOrders.add(o.id)
      }
      g.status = "withdrawn"
      this.unlinkGig(gid)
      this.outbox.push({ type: "withdraw", gigId: gid })
    }

    for (const gid of bookedGigsToRelease) {
      const g = this.gigs.get(gid)!
      for (const o of this.distinctLiveOrdersOfStops(g.stops)) {
        if (o.id !== order.id) partnerOrders.add(o.id)
      }
      g.status = "withdrawn"
      this.unlinkGig(gid)
      this.outbox.push({ type: "release", gigId: gid })
    }

    const missingSelf = undeliveredLegs(order).filter((leg) => !this.legGigs.get(order.id)?.has(leg))
    if (missingSelf.length > 0) {
      this.dispatchOrderLegs(order, missingSelf, false)
    }
    for (const pid of partnerOrders) {
      const po = this.orders.get(pid)
      if (!po) continue
      const missingPartner = undeliveredLegs(po).filter((leg) => !this.legGigs.get(pid)?.has(leg))
      if (missingPartner.length > 0) {
        this.dispatchOrderLegs(po, missingPartner, false)
      }
    }
  }

  private handleOrderCancelled(
    orderId: string,
    cancelledGigs: ReadonlyArray<{ gigId: string; outcome: "withdrawn" | "released" | "shortened" | "continues" }>,
  ): void {
    this.orders.delete(orderId)
    this.legGigs.delete(orderId)
    this.urgent.delete(orderId)
    this.pairingBufferUntil.delete(orderId)
    const cReq = this.requests.get(orderId)
    if (cReq?.batchId) this.batches.get(cReq.batchId)?.wonIds.delete(orderId)

    const displaced = this.removeUnsentPostsForOrder(orderId)
    const toRedispatch = new Set<string>(displaced.map((s) => s.orderId))

    for (const cg of cancelledGigs) {
      const g = this.gigs.get(cg.gigId)
      if (!g) continue
      if (cg.outcome === "withdrawn" || cg.outcome === "released") {
        for (const o of this.distinctLiveOrdersOfStops(g.stops)) {
          if (o.id !== orderId) toRedispatch.add(o.id)
        }
        g.status = "withdrawn"
        this.unlinkGig(cg.gigId)
      } else {
        g.stops = g.stops.filter((s) => s.orderId !== orderId)
        g.isBundledTwoOrder = new Set(g.stops.map((s) => s.orderId)).size > 1
      }
    }

    for (const pid of toRedispatch) {
      const po = this.orders.get(pid)
      if (!po) continue
      const missing = undeliveredLegs(po).filter((leg) => !this.legGigs.get(pid)?.has(leg))
      if (missing.length > 0) this.dispatchOrderLegs(po, missing, false)
    }
  }

  private handleGigBooked(gigId: string, driverId: string, feeCents: number, at: number): void {
    this.offers.recordBooked(driverId, gigId, at)
    const g = this.gigs.get(gigId)
    if (g) {
      // Fix same-minute race: if an earlier `order_won` in this same step tried to withdraw `g` to bundle it,
      // cancel the pending `withdraw` + bundle `post`, re-link `g` as booked, and post the new partner solo!
      let hadPendingWithdraw = false
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        const act = this.outbox[i]!
        if (act.type === "withdraw" && act.gigId === gigId) {
          this.outbox.splice(i, 1)
          hadPendingWithdraw = true
        }
      }

      g.status = "booked"
      g.driverId = driverId
      g.feeCents = feeCents
      g.bookedAt = at
      this.linkGig(g)

      if (hadPendingWithdraw) {
        const bookedOrderIds = new Set(g.stops.map((s) => s.orderId))
        const orphanedOrders = new Set<string>()
        for (let i = this.outbox.length - 1; i >= 0; i--) {
          const act = this.outbox[i]!
          if (act.type === "post" && act.stops.some((s) => bookedOrderIds.has(s.orderId))) {
            for (const s of act.stops) {
              if (!bookedOrderIds.has(s.orderId)) orphanedOrders.add(s.orderId)
            }
            this.outbox.splice(i, 1)
          }
        }
        for (const oid of orphanedOrders) {
          this.doNotBundle.add(oid)
          const o = this.orders.get(oid)
          if (!o) continue
          const missing = undeliveredLegs(o).filter((l) => !this.legGigs.get(oid)?.has(l))
          if (missing.length > 0) this.dispatchOrderLegs(o, missing, false)
        }
      }
    }

    this.queueDirectOffersForOpenGigs(1)
  }

  private handleGigDroppedOrNoShow(gigId: string, isDrop: boolean): void {
    const g = this.gigs.get(gigId)
    if (!g) return

    if (isDrop) {
      const tod = this.now % DAY
      const p0 = g.stops[0]
      const o0 = p0 ? this.orders.get(p0.orderId) : undefined
      const pickPlace = p0 && o0 ? o0.legs[p0.leg]?.pickup.placeId : undefined
      if (
        tod >= 5 * HOUR &&
        tod <= 9 * HOUR + 30 &&
        g.bookedAt !== null &&
        this.now - g.bookedAt >= 180 &&
        (!pickPlace || !this.snow.hasActiveSnow(pickPlace, this.now))
      ) {
        this.morningNonSnowDrops++
        if (this.morningNonSnowDrops >= 3) this.fluActiveToday = true
      }
    }

    g.status = "open"
    g.driverId = null
    this.offers.clearGig(gigId)

    if (g.isBundledTwoOrder) {
      // Keep dropped bundles open on the board when ample slack (>=320m) remains (+€373/wk saved vs shattering)!
      const bOrders = this.distinctLiveOrdersOfStops(g.stops)
      const minBundleLpa =
        bOrders.length > 0
          ? Math.min(...bOrders.map((o) => this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt))
          : -Infinity
      if (
        bOrders.length >= 2 &&
        minBundleLpa - this.now >= 320 &&
        bOrders.every((o) => !this.urgent.has(o.id))
      ) {
        const bumped = g.schedule.map((s, idx) => ({
          at: idx === 0 ? this.now : Math.max(this.now + idx * 25, s.at),
          feeCents: Math.round(s.feeCents * 1.03),
        }))
        g.schedule = bumped
        g.splitAt = Math.min(this.now + 115, minBundleLpa - 230)
        g.offerWave++
        g.nextOfferCheckAt = this.now + 10
        this.outbox.push({ type: "reprice", gigId: g.id, schedule: bumped })
        return
      }
      this.splitOpenBundle(g)
      return
    }

    const order = g.stops[0] ? this.orders.get(g.stops[0].orderId) : undefined
    if (!order) return

    // Preserve monotonic clearing floor after a drop/no-show so the fresh 30km notification doesn't reset to 0.85x!
    const prevLiveFee = Math.max(currentScheduleFee(g.schedule, this.now), g.feeCents)
    if (this.now <= order.lastPickupAt) {
      this.recordOrderReachedFee(order.id, Math.round(prevLiveFee * 1.03))
    }

    const legIndices = g.stops.filter((s) => s.kind === "pickup" && s.orderId === order.id).map((s) => s.leg)
    const newSchedule = this.computeSingleSchedule(order, legIndices)
    g.schedule = newSchedule
    g.offerWave++
    this.outbox.push({ type: "reprice", gigId: g.id, schedule: newSchedule })
    this.queueOffersForSingleGig(g, 2)
  }

  private handleDriverLate(gigId: string, pickupAt: number): void {
    const g = this.gigs.get(gigId)
    if (!g || g.status !== "booked") return
    const p0 = g.stops[0]
    if (!p0) return
    const order = this.orders.get(p0.orderId)
    if (!order) return

    if (g.isBundledTwoOrder) {
      const bOrders = this.distinctLiveOrdersOfStops(g.stops)
      const minEffLpa =
        bOrders.length > 0
          ? Math.min(...bOrders.map((o) => this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt))
          : -Infinity
      const missesStop0Cap = p0.window !== undefined && pickupAt > p0.window.to
      if (missesStop0Cap && minEffLpa - this.now >= 140) {
        g.status = "withdrawn"
        this.unlinkGig(gigId)
        this.outbox.push({ type: "release", gigId })
        for (const bo of bOrders) {
          this.doNotBundle.add(bo.id)
          const missing = undeliveredLegs(bo).filter((l) => !this.legGigs.get(bo.id)?.has(l))
          if (missing.length > 0) this.dispatchOrderLegs(bo, missing, false)
        }
      }
      return
    }

    const leg0 = order.legs[p0.leg]
    if (!leg0) return
    const notes = this.getNotes(order.id)
    const note0 = notes[p0.leg]

    const realPickHours = note0?.pickupHours ?? leg0.pickup.hours
    let violatesRealPickupClose = false
    if (realPickHours) {
      const day = Math.floor(pickupAt / DAY)
      const wd = ((day % 7) + 7) % 7
      const slot = wd === 5 ? realPickHours.saturday : realPickHours.weekdays.includes(wd) ? realPickHours : null
      const tod = pickupAt % DAY
      if (!slot || tod < slot.opens || tod >= slot.closes) {
        violatesRealPickupClose = true
      }
    }

    // Simulate forward across all stops on the gig (handles 2-leg trade-ins accurately!)
    let curTime = pickupAt
    let prevPlace = leg0.pickup.placeId
    for (let si = 0; si < g.stops.length; si++) {
      const s = g.stops[si]!
      const sLeg = order.legs[s.leg]
      if (!sLeg) continue
      const pl = s.kind === "pickup" ? sLeg.pickup.placeId : sLeg.delivery.placeId
      if (si > 0 && pl !== prevPlace) {
        const seg = this.map.roadMinutes(prevPlace, pl)
        const sw = this.snow.overlaps(prevPlace, pl, curTime, curTime + seg * 2) ? 1.30 : 1.08
        curTime += Math.ceil(seg * sw)
      }
      if (s.kind === "pickup") {
        const extra = (s.withPlates ? PLATES_MINUTES : 0) + (s.withCharging ? CHARGING_MINUTES : 0)
        curTime += (si === 0 ? 15 : 10) + extra
      } else if (si < g.stops.length - 1) {
        curTime += 10
      }
      prevPlace = pl
    }
    const lastStop = g.stops[g.stops.length - 1]!
    const lastLeg = order.legs[lastStop.leg] ?? leg0
    const effDl = Math.min(order.deadline, notes[lastStop.leg]?.noteDeadline ?? notes[0]?.noteDeadline ?? Infinity)
    const realDelivHours = notes[lastStop.leg]?.deliveryHours ?? lastLeg.delivery.hours
    const missesDelivery = !Number.isFinite(visitAt(curTime, effDl, realDelivHours, 1))
    const effLpa = this.effectiveLastPickupByOrder.get(order.id) ?? order.lastPickupAt
    const Q30 = this.supply.pool30(leg0.pickup.placeId, g.audience.experienced, g.audience.manualLicence)

    if (violatesRealPickupClose || (missesDelivery && effLpa - this.now >= 95 && Q30 >= 4)) {
      g.status = "withdrawn"
      this.unlinkGig(gigId)
      this.urgent.add(order.id)
      this.doNotBundle.add(order.id)
      this.outbox.push({ type: "release", gigId })
      const missing = undeliveredLegs(order).filter((l) => !this.legGigs.get(order.id)?.has(l))
      if (missing.length > 0) this.dispatchOrderLegs(order, missing, false)
    }
  }

  private handleGigExpired(gigId: string): void {
    const g = this.gigs.get(gigId)
    if (!g) return
    const hadActiveLink = g.stops.some((s) => this.legGigs.get(s.orderId)?.get(s.leg) === gigId)
    const expiredLiveFee = currentScheduleFee(g.schedule, this.now)
    g.status = "withdrawn"
    this.unlinkGig(gigId)
    if (!hadActiveLink) return

    for (const order of this.distinctLiveOrdersOfStops(g.stops)) {
      const missing = undeliveredLegs(order).filter((l) => !this.legGigs.get(order.id)?.has(l))
      const effLpa = this.effectiveLastPickupByOrder.get(order.id) ?? order.lastPickupAt
      // Preserve monotonic fee floor across effLpa -> lastPickupAt instead of crashing 2.40x -> 1.38x!
      if (!g.isBundledTwoOrder && this.now <= order.lastPickupAt) {
        this.recordOrderReachedFee(order.id, expiredLiveFee)
      }
      if (this.now >= effLpa - 2) {
        this.omitSoftCapOrders.add(order.id)
      }
      if (effLpa - this.now < 420) this.doNotBundle.add(order.id)
      if (missing.length > 0) this.dispatchOrderLegs(order, missing, false)
    }
  }

  private handleOfferAnswered(gigId: string, driverId: string, answer: "accepted" | "declined" | "expired"): void {
    this.offers.recordOfferAnswered(gigId, driverId, answer)
    const g = this.gigs.get(gigId)
    if (!g) return
    if (answer === "accepted") {
      g.status = "booked"
      g.driverId = driverId
      return
    }
    if (g.status === "open" && this.offers.openCount(gigId) === 0 && g.offerWave < 2) {
      g.offerWave++
      this.queueOffersForSingleGig(g, 1)
    }
  }

  private handleReleaseEvent(orderId: string, leg: number, at: number): void {
    const notes = this.getNotes(orderId)
    if (notes[leg]) notes[leg]!.releasedAt = at
    const cur = this.getLegRetry(orderId, leg)
    this.setLegRetry(orderId, leg, { ...cur, pickupFrom: 0 })
    this.postBackoffUntil.delete(orderId)

    const order = this.orders.get(orderId)
    if (!order || order.deliveredAt[leg] !== null) return
    if (this.pairingBufferUntil.has(orderId)) return

    const gid = this.legGigs.get(orderId)?.get(leg)
    if (!gid) {
      if (this.hasPendingPostInOutbox(orderId, leg)) {
        const stalePending = this.outbox.some(
          (a) =>
            a.type === "post" &&
            a.stops.some((s) => s.orderId === orderId && s.leg === leg && s.kind === "pickup" && (s.window?.from ?? 0) > this.now + 15),
        )
        if (stalePending) this.handleOrderChanged(order)
        return
      }
      const missing = undeliveredLegs(order).filter(
        (l) => !this.legGigs.get(orderId)?.has(l) && !this.hasPendingPostInOutbox(orderId, l),
      )
      if (missing.length > 0) this.dispatchOrderLegs(order, missing, false)
      return
    }
    const g = this.gigs.get(gid)
    if (g && g.status === "open") {
      const pStop = g.stops.find((s) => s.orderId === orderId && s.leg === leg && s.kind === "pickup")
      if (pStop?.window && pStop.window.from > this.now + 15) {
        this.handleOrderChanged(order)
      }
    }
  }

  private handleVisitFailed(
    gigId: string,
    orderId: string,
    leg: number,
    reason: "not_ready" | "closed" | "licence" | "no_plates",
  ): void {
    const order = this.orders.get(orderId)
    if (!order) return
    this.legGigs.get(orderId)?.delete(leg)
    this.doNotBundle.add(orderId)

    const g = this.gigs.get(gigId)
    if (g) {
      g.stops = g.stops.filter((s) => !(s.orderId === orderId && s.leg === leg))
      const anyRemaining = g.stops.some((s) => {
        if (s.kind !== "pickup") return false
        const o = this.orders.get(s.orderId)
        return o && o.deliveredAt[s.leg] === null
      })
      if (!anyRemaining) g.status = "done"
    }

    const req = this.requests.get(orderId)
    const prev = this.getLegRetry(orderId, leg)
    const carNotThere = reason === "not_ready" || reason === "closed"
    const pickupFrom = carNotThere && req ? this.computeRetryFrom(order, req, leg, this.now) : prev.pickupFrom

    this.setLegRetry(orderId, leg, {
      pickupFrom,
      manualLicence: prev.manualLicence || reason === "licence",
      plates: prev.plates || reason === "no_plates",
    })

    const missing = undeliveredLegs(order).filter(
      (l) => !this.legGigs.get(orderId)?.has(l) && !this.hasPendingPostInOutbox(orderId, l),
    )
    if (missing.length > 0) this.dispatchOrderLegs(order, missing, false)
  }

  private handleDelivered(gigId: string, orderId: string, leg: number, placeId: string, at: number): void {
    const g = this.gigs.get(gigId)
    this.offers.recordDelivered(g?.driverId ?? null, placeId, at)
    this.legGigs.get(orderId)?.delete(leg)
    this.needsImmediateOfferPass = true

    // Wake nearby open gigs (<=35km) immediately so the just-arrived driver gets a 0-deadhead chain offer!
    for (const openGig of this.gigs.values()) {
      if (openGig.status !== "open" || !openGig.stops[0]) continue
      const o = this.orders.get(openGig.stops[0].orderId)
      const pPlace = o?.legs[openGig.stops[0].leg]?.pickup.placeId
      if (pPlace && this.map.distKm(placeId, pPlace) <= 35) {
        openGig.nextOfferCheckAt = this.now
      }
    }

    const order = this.orders.get(orderId)
    if (order) order.deliveredAt[leg] = at

    if (g) {
      const anyRemaining = g.stops.some((s) => {
        if (s.kind !== "pickup") return false
        const o = this.orders.get(s.orderId)
        return o && o.deliveredAt[s.leg] === null
      })
      if (!anyRemaining) g.status = "done"
    }
  }

  private handleDeadlineClose(orderId: string): void {
    const order = this.orders.get(orderId)
    if (!order) return
    this.urgent.add(orderId)
    this.doNotBundle.add(orderId)
    this.escalateOrderUrgent(order)
  }

  private escalateOrderUrgent(order: Order): void {
    this.urgent.add(order.id)
    this.doNotBundle.add(order.id)

    for (const act of this.outbox) {
      if (act.type === "post" && act.stops.some((s) => s.orderId === order.id)) {
        const meta = this.pendingPostMeta.get(act)
        if (meta && !meta.isBundledTwoOrder) {
          const legs = act.stops.filter((s) => s.kind === "pickup" && s.orderId === order.id).map((s) => s.leg)
          act.schedule = this.computeSingleSchedule(order, legs)
          meta.urgentEscalated = true
        }
      }
    }

    const m = this.legGigs.get(order.id)
    if (!m) return
    const gids = new Set(m.values())
    for (const gid of gids) {
      const g = this.gigs.get(gid)
      if (!g || g.status !== "open") continue
      if (g.isBundledTwoOrder) {
        this.splitOpenBundle(g)
      } else {
        const isPastDl = this.now > order.deadline
        // Same-day no-reset guard: do not overwrite an already-climbing urgent schedule back down to Step 0 when deadline_close fires!
        if (
          g.urgentEscalated &&
          g.urgentEscalatedAt !== null &&
          this.now - g.urgentEscalatedAt <= 6 * HOUR &&
          !(isPastDl && !g.pastDeadlineEscalated)
        ) {
          g.offerWave++
          this.queueOffersForSingleGig(g, 3)
          continue
        }
        const legs = g.stops.filter((s) => s.kind === "pickup" && s.orderId === order.id).map((s) => s.leg)
        const sched = this.computeSingleSchedule(order, legs)
        g.schedule = sched
        g.urgentEscalated = true
        g.urgentEscalatedAt = this.now
        g.pastDeadlineEscalated = isPastDl
        g.offerWave++
        this.outbox.push({ type: "reprice", gigId: g.id, schedule: sched })
        this.queueOffersForSingleGig(g, 3)
      }
    }
  }

  private splitOpenBundle(g: GigState): void {
    if (g.status !== "open" || !g.isBundledTwoOrder) return
    const ordersInBundle = this.distinctLiveOrdersOfStops(g.stops)
    g.status = "withdrawn"
    this.unlinkGig(g.id)
    this.outbox.push({ type: "withdraw", gigId: g.id })

    // Smart 3-car step-down: if a 3-car bundle hits splitAt with ample slack, do NOT destroy the 2-car pair!
    if (
      ordersInBundle.length >= 3 &&
      ordersInBundle.every((o) => !this.urgent.has(o.id) && (this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt) - this.now >= 280)
    ) {
      const third = ordersInBundle[ordersInBundle.length - 1]!
      this.doNotBundle.add(third.id)
      const o0 = ordersInBundle[0]!
      const o1 = ordersInBundle[1]!
      const m0 = undeliveredLegs(o0).filter((l) => !this.legGigs.get(o0.id)?.has(l))
      if (m0.length > 0) this.dispatchOrderLegs(o0, m0, false)
      const m1 = undeliveredLegs(o1).filter((l) => !this.legGigs.get(o1.id)?.has(l))
      if (m1.length > 0) {
        // Pair o1 with buffered/open o0 if possible
        this.pairingBufferUntil.set(o0.id, this.now + 5)
        this.removeUnsentPostsForOrder(o0.id)
        this.dispatchOrderLegs(o1, m1, true)
        if (this.pairingBufferUntil.has(o0.id)) {
          this.pairingBufferUntil.delete(o0.id)
          this.dispatchOrderLegs(o0, m0, false)
        }
      }
      for (let idx = 2; idx < ordersInBundle.length; idx++) {
        const oi = ordersInBundle[idx]!
        this.doNotBundle.add(oi.id)
        const mi = undeliveredLegs(oi).filter((l) => !this.legGigs.get(oi.id)?.has(l))
        if (mi.length > 0) this.dispatchOrderLegs(oi, mi, false)
      }
      return
    }

    for (const o of ordersInBundle) {
      this.doNotBundle.add(o.id)
      const missing = undeliveredLegs(o).filter((l) => !this.legGigs.get(o.id)?.has(l))
      if (missing.length > 0) this.dispatchOrderLegs(o, missing, false)
    }
  }

  private computeRetryFrom(order: Order, request: PriceRequest, leg: number, now: number): number {
    const promised = request.options.find((o) => o.kind === order.option)?.deadline ?? order.deadline
    const delay = Math.max(0, order.deadline - promised)
    return Math.max(now + 90, order.legs[leg]!.pickup.window.from + delay)
  }

  private changedKmScaleForOrder(order: Order, req: PriceRequest, legIndices: readonly number[]): number {
    const routeKm = legIndices.reduce(
      (sum, i) => sum + this.map.roadKm(order.legs[i]!.pickup.placeId, order.legs[i]!.delivery.placeId),
      0,
    )
    const origKm = legIndices.reduce(
      (sum, i) => sum + this.map.roadKm(req.legs[i]!.pickup.placeId, req.legs[i]!.delivery.placeId),
      0,
    )
    return Math.abs(routeKm - origKm) > 5
      ? Math.min(8.5, Math.max(0.45, (1500 + 26 * routeKm) / Math.max(1500, 1500 + 26 * origKm)))
      : 1.0
  }

  private computeSingleSchedule(order: Order, legIndices: readonly number[], built?: BuiltOrderStops): FeeStep[] {
    const req = this.requests.get(order.id)!
    const notes = this.getNotes(order.id)
    const retriesMap = this.retries.get(order.id) ?? new Map<number, RetryState>()
    const omitSoftCap = this.omitSoftCapOrders.has(order.id) || this.now > order.lastPickupAt
    const b =
      built ??
      buildStopsForOrder(this.map, this.snow, order, legIndices, notes, retriesMap, this.now, this.endsAt, omitSoftCap)
    this.effectiveLastPickupByOrder.set(order.id, b.effectiveLastPickupAt)

    const firstLeg = order.legs[legIndices[0]!]!
    const lastLeg = order.legs[legIndices[legIndices.length - 1]!]!
    const routeKm = legIndices.reduce(
      (sum, i) => sum + this.map.roadKm(order.legs[i]!.pickup.placeId, order.legs[i]!.delivery.placeId),
      0,
    )
    const changedKmScale = this.changedKmScaleForOrder(order, req, legIndices)
    const baseRefFeeCents = ((req.referenceFeeCents * legIndices.length) / order.legs.length) * changedKmScale
    const pStop = b.stops[0]!
    const earliestPickupAt = Math.max(this.now, pStop.window?.from ?? firstLeg.pickup.window.from)
    const snowOverlap = Boolean(
      this.snow.overlaps(firstLeg.pickup.placeId, lastLeg.delivery.placeId, earliestPickupAt, order.deadline),
    )
    const dealer = this.pricing.estimator.getDealer(order.dealerId)
    const highTrust = this.level === 8 && dealer.trust >= 6
    const isPastDeadline = this.now > order.deadline
    const isUrgent =
      isPastDeadline ||
      this.urgent.has(order.id) ||
      b.effectiveLastPickupAt - this.now <= (highTrust ? 245 : 210)
    const minFloorFeeCents = this.now <= order.lastPickupAt ? (this.maxReachedFeeByOrder.get(order.id) ?? 1) : 1

    return buildSingleGigSchedule(this.map, this.supply, {
      now: this.now,
      endsAt: this.endsAt,
      level: this.level,
      baseRefFeeCents,
      orderPriceCents: order.priceCents,
      minFloorFeeCents,
      routeKm,
      pickupPlaceId: firstLeg.pickup.placeId,
      deliveryPlaceId: lastLeg.delivery.placeId,
      effectiveLastPickupAt: b.effectiveLastPickupAt,
      rawLastPickupAt: order.lastPickupAt,
      earliestPickupAt,
      audience: b.audience,
      hasPrivatePickup: legIndices.some((i) => order.legs[i]!.pickup.privateAddress),
      hasPrivateDelivery: legIndices.some((i) => order.legs[i]!.delivery.privateAddress),
      isTradeInTwoLegs: legIndices.length === 2 && order.legs.length === 2,
      withCharging: Boolean(pStop.withCharging),
      withPlates: Boolean(pStop.withPlates),
      snowOverlap,
      fluActive: this.fluActiveToday,
      urgent: isUrgent,
      isPastDeadline,
      highTrustDealer: highTrust,
    })
  }

  private dispatchOrderLegs(order: Order, legIndices: readonly number[], allowBundle: boolean): void {
    const req = this.requests.get(order.id)
    if (!req || legIndices.length === 0) return

    if (legIndices.length === 2) {
      const l0 = order.legs[legIndices[0]!]!
      const l1 = order.legs[legIndices[1]!]!
      const sameCust = l0.delivery.placeId === l1.pickup.placeId && l0.delivery.privateAddress && l1.pickup.privateAddress
      const link = sameCust ? 0 : this.map.roadMinutes(l0.delivery.placeId, l1.pickup.placeId)
      const totalRoad =
        this.map.roadMinutes(l0.pickup.placeId, l0.delivery.placeId) +
        link +
        this.map.roadMinutes(l1.pickup.placeId, l1.delivery.placeId)
      if (totalRoad > 12 * HOUR) {
        for (const singleLeg of legIndices) {
          this.dispatchOrderLegs(order, [singleLeg], false)
        }
        return
      }
    }

    const notes = this.getNotes(order.id)
    const retriesMap = this.retries.get(order.id) ?? new Map<number, RetryState>()
    const omitSoftCap = this.omitSoftCapOrders.has(order.id) || this.now > order.lastPickupAt
    const built = buildStopsForOrder(this.map, this.snow, order, legIndices, notes, retriesMap, this.now, this.endsAt, omitSoftCap)
    this.effectiveLastPickupByOrder.set(order.id, built.effectiveLastPickupAt)

    if (built.awaitingPrivateSlotRollover) return

    if (
      allowBundle &&
      this.level >= 3 &&
      legIndices.length === 1 &&
      order.legs.length === 1 &&
      !this.urgent.has(order.id) &&
      !this.doNotBundle.has(order.id)
    ) {
      const targetEntry: BundleOrderEntry = {
        order,
        request: req,
        notes,
        built,
        wonAt: this.orderWonAt.get(order.id) ?? this.now,
      }

      const openCandidates: BundleOrderEntry[] = []
      const candidateGigByOrder = new Map<string, GigState>()

      // 0. Check if we can extend an open 2-car bundle [A, B] into a 3-car corridor chain!
      for (const g of this.gigs.values()) {
        if (g.status !== "open" || !g.isBundledTwoOrder || g.stops.length !== 4) continue
        if (this.now - g.postedAt > 85) continue
        const o1 = this.orders.get(g.stops[0]!.orderId)
        const o2 = this.orders.get(g.stops[2]!.orderId)
        if (!o1 || !o2 || o1.id === order.id || o2.id === order.id) continue
        if (this.urgent.has(o1.id) || this.urgent.has(o2.id) || this.doNotBundle.has(o1.id) || this.doNotBundle.has(o2.id)) continue
        if (o1.deliveredAt[0] !== null || o2.deliveredAt[0] !== null) continue
        const r1 = this.requests.get(o1.id)
        const r2 = this.requests.get(o2.id)
        if (!r1 || !r2) continue
        const n1 = this.getNotes(o1.id)
        const n2 = this.getNotes(o2.id)
        const b1 = buildStopsForOrder(this.map, this.snow, o1, [0], n1, this.retries.get(o1.id) ?? new Map(), this.now, this.endsAt)
        const b2 = buildStopsForOrder(this.map, this.snow, o2, [0], n2, this.retries.get(o2.id) ?? new Map(), this.now, this.endsAt)
        if (b1.awaitingPrivateSlotRollover || b2.awaitingPrivateSlotRollover) continue
        const e1: BundleOrderEntry = { order: o1, request: r1, notes: n1, built: b1, wonAt: this.orderWonAt.get(o1.id) ?? g.postedAt }
        const e2: BundleOrderEntry = { order: o2, request: r2, notes: n2, built: b2, wonAt: this.orderWonAt.get(o2.id) ?? g.postedAt }
        const ext =
          tryExtendTwoToThreeOrderBundle(this.map, this.snow, this.supply, e1, e2, targetEntry, this.now, this.fluActiveToday) ??
          tryExtendTwoToThreeOrderBundle(this.map, this.snow, this.supply, e1, targetEntry, e2, this.now, this.fluActiveToday) ??
          tryExtendTwoToThreeOrderBundle(this.map, this.snow, this.supply, targetEntry, e1, e2, this.now, this.fluActiveToday) ??
          tryExtendTwoToThreeOrderBundle(this.map, this.snow, this.supply, e2, e1, targetEntry, this.now, this.fluActiveToday) ??
          tryExtendTwoToThreeOrderBundle(this.map, this.snow, this.supply, e2, targetEntry, e1, this.now, this.fluActiveToday) ??
          tryExtendTwoToThreeOrderBundle(this.map, this.snow, this.supply, targetEntry, e2, e1, this.now, this.fluActiveToday)
        if (ext) {
          this.pairingBufferUntil.delete(order.id)
          g.status = "withdrawn"
          this.unlinkGig(g.id)
          this.outbox.push({ type: "withdraw", gigId: g.id })
          const postAction: PostAction = {
            type: "post",
            stops: ext.stops,
            audience: ext.audience,
            schedule: ext.schedule,
          }
          this.pendingPostMeta.set(postAction, {
            action: postAction,
            isBundledTwoOrder: true,
            splitAt: ext.splitAt,
            urgentEscalated: false,
            pastDeadlineEscalated: false,
            strippedFallback: false,
          })
          this.outbox.push(postAction)
          return
        }
      }

      // 1. First include buffered unposted orders (zero withdraw needed!)
      for (const bufferedId of this.pairingBufferUntil.keys()) {
        if (bufferedId === order.id) continue
        const co = this.orders.get(bufferedId)
        const creq = co ? this.requests.get(co.id) : undefined
        if (!co || !creq || co.legs.length !== 1 || co.deliveredAt[0] !== null) continue
        if (this.urgent.has(co.id) || this.doNotBundle.has(co.id)) continue
        const cnotes = this.getNotes(co.id)
        const cretries = this.retries.get(co.id) ?? new Map<number, RetryState>()
        const cbuilt = buildStopsForOrder(this.map, this.snow, co, [0], cnotes, cretries, this.now, this.endsAt)
        if (cbuilt.awaitingPrivateSlotRollover) continue
        openCandidates.push({
          order: co,
          request: creq,
          notes: cnotes,
          built: cbuilt,
          wonAt: this.orderWonAt.get(co.id) ?? this.now,
        })
      }

      // 2. Also include open unbooked 1-order gigs
      for (const g of this.gigs.values()) {
        if (g.status !== "open" || g.isBundledTwoOrder || g.stops.length !== 2) continue
        const co = this.orders.get(g.stops[0]!.orderId)
        const creq = co ? this.requests.get(co.id) : undefined
        if (!co || !creq || co.legs.length !== 1 || co.deliveredAt[0] !== null) continue
        if (this.urgent.has(co.id) || this.doNotBundle.has(co.id)) continue
        const cnotes = this.getNotes(co.id)
        const cretries = this.retries.get(co.id) ?? new Map<number, RetryState>()
        const cbuilt = buildStopsForOrder(this.map, this.snow, co, [0], cnotes, cretries, this.now, this.endsAt)
        if (cbuilt.awaitingPrivateSlotRollover) continue
        openCandidates.push({
          order: co,
          request: creq,
          notes: cnotes,
          built: cbuilt,
          wonAt: this.orderWonAt.get(co.id) ?? g.postedAt,
        })
        candidateGigByOrder.set(co.id, g)
      }

      const bundle = findBestTwoOrderBundle(
        this.map,
        this.snow,
        this.supply,
        targetEntry,
        openCandidates,
        this.now,
        this.level,
        this.fluActiveToday,
      )

      if (bundle) {
        const partnerId = bundle.firstOrderId === order.id ? bundle.secondOrderId : bundle.firstOrderId
        if (this.pairingBufferUntil.has(partnerId)) {
          this.pairingBufferUntil.delete(partnerId)
          this.pairingBufferUntil.delete(order.id)
          const postAction: PostAction = {
            type: "post",
            stops: bundle.stops,
            audience: bundle.audience,
            schedule: bundle.schedule,
          }
          this.pendingPostMeta.set(postAction, {
            action: postAction,
            isBundledTwoOrder: true,
            splitAt: bundle.splitAt,
            urgentEscalated: false,
            pastDeadlineEscalated: false,
            strippedFallback: false,
          })
          this.outbox.push(postAction)
          this.needsImmediateOfferPass = true
          return
        }

        const partnerGig = candidateGigByOrder.get(partnerId)
        if (partnerGig && partnerGig.status === "open") {
          partnerGig.status = "withdrawn"
          this.unlinkGig(partnerGig.id)
          this.outbox.push({ type: "withdraw", gigId: partnerGig.id })

          const postAction: PostAction = {
            type: "post",
            stops: bundle.stops,
            audience: bundle.audience,
            schedule: bundle.schedule,
          }
          this.pendingPostMeta.set(postAction, {
            action: postAction,
            isBundledTwoOrder: true,
            splitAt: bundle.splitAt,
            urgentEscalated: false,
            pastDeadlineEscalated: false,
            strippedFallback: false,
          })
          this.outbox.push(postAction)
          this.needsImmediateOfferPass = true
          return
        }
      }

      // Hold high-slack standard D2D orders in a pairing buffer during active weekday request hours!
      const leg0 = order.legs[0]!
      const curDay = Math.floor(this.now / DAY)
      const curTod = this.now % DAY
      if (
        curDay < 5 &&
        curTod >= 8 * HOUR &&
        curTod <= 17 * HOUR + 40 &&
        !leg0.car.premium &&
        !leg0.pickup.privateAddress &&
        !leg0.delivery.privateAddress &&
        (notes[0]?.releasedAt ?? 0) <= this.now &&
        built.effectiveLastPickupAt - this.now >= 480
      ) {
        const bufMins = built.effectiveLastPickupAt - this.now >= 900 ? 32 : 22
        this.pairingBufferUntil.set(order.id, this.now + bufMins)
        return
      }
    }

    const useStripped = this.stripWindowsOrders.has(order.id)
    const finalStops = useStripped
      ? built.stops.map((s) => {
          const leg = order.legs[s.leg]
          if (s.kind === "pickup" && leg?.pickup.privateAddress) return s
          return { ...s, window: undefined }
        })
      : built.stops

    const schedule = this.computeSingleSchedule(order, legIndices, built)
    const dealer = this.pricing.estimator.getDealer(order.dealerId)
    const highTrust = this.level === 8 && dealer.trust >= 6
    const isPastDeadline = this.now > order.deadline
    const isUrgent =
      isPastDeadline ||
      this.urgent.has(order.id) ||
      built.effectiveLastPickupAt - this.now <= (highTrust ? 245 : 210)
    const postAction: PostAction = {
      type: "post",
      stops: finalStops,
      audience: built.audience,
      schedule,
    }
    this.pendingPostMeta.set(postAction, {
      action: postAction,
      isBundledTwoOrder: false,
      splitAt: Infinity,
      urgentEscalated: isUrgent,
      pastDeadlineEscalated: isPastDeadline,
      strippedFallback: useStripped,
    })
    this.outbox.push(postAction)
    if (isUrgent) this.needsImmediateOfferPass = true
  }

  private buildOfferTarget(g: GigState): OfferGigTarget | undefined {
    if (g.status !== "open") return undefined
    const pickups = g.stops.filter((s) => s.kind === "pickup")
    const delivs = g.stops.filter((s) => s.kind === "delivery")
    if (pickups.length === 0 || delivs.length === 0) return undefined

    const firstOrd = this.orders.get(pickups[0]!.orderId)
    const lastOrd = this.orders.get(delivs[delivs.length - 1]!.orderId)
    if (!firstOrd || !lastOrd) return undefined

    const pPlace = firstOrd.legs[pickups[0]!.leg]?.pickup.placeId
    const dPlace = lastOrd.legs[delivs[delivs.length - 1]!.leg]?.delivery.placeId
    if (!pPlace || !dPlace) return undefined

    let refSum = 0
    let minEffLpa = Infinity
    let hasPrivate = false
    let anyUrgent = g.urgentEscalated
    let anyPastDeadline = g.pastDeadlineEscalated
    const orderIds: string[] = []

    for (const p of pickups) {
      const o = this.orders.get(p.orderId)
      const r = this.requests.get(p.orderId)
      if (!o || !r) continue
      if (!orderIds.includes(o.id)) orderIds.push(o.id)
      const kmScale = this.changedKmScaleForOrder(o, r, [p.leg])
      refSum += (r.referenceFeeCents / o.legs.length) * kmScale
      const lpa = this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt
      if (lpa < minEffLpa) minEffLpa = lpa
      const leg = o.legs[p.leg]
      if (leg && (leg.pickup.privateAddress || leg.delivery.privateAddress)) hasPrivate = true
      if (this.urgent.has(o.id)) anyUrgent = true
      if (this.now > o.deadline) anyPastDeadline = true
    }

    let driveMinutes = 0
    let prev: string | undefined
    for (const s of g.stops) {
      const o = this.orders.get(s.orderId)
      const leg = o?.legs[s.leg]
      if (!leg) continue
      const pl = s.kind === "pickup" ? leg.pickup.placeId : leg.delivery.placeId
      if (prev !== undefined && prev !== pl) driveMinutes += this.map.roadMinutes(prev, pl)
      prev = pl
    }

    const earliestPickupAt = Math.max(
      this.now,
      pickups[0]!.window?.from ?? firstOrd.legs[pickups[0]!.leg]!.pickup.window.from,
    )

    return {
      gigId: g.id,
      orderIds,
      pickupPlaceId: pPlace,
      deliveryPlaceId: dPlace,
      earliestPickupAt,
      effectiveLastPickupAt: minEffLpa,
      driveMinutes,
      refFeeCents: refSum,
      currentAppFeeCents: currentScheduleFee(g.schedule, this.now),
      audience: g.audience,
      hasPrivateStop: hasPrivate,
      urgent: anyUrgent,
      isPastDeadline: anyPastDeadline,
      offerWave: g.offerWave,
    }
  }

  private queueOffersForSingleGig(g: GigState, maxNew = 2): void {
    if (this.level < 3 || g.status !== "open") return
    const target = this.buildOfferTarget(g)
    if (!target) return
    const commitments = this.activeCommitments()
    const actions = this.offers.selectOffersForGig(
      this.map,
      this.supply,
      commitments,
      target,
      this.now,
      this.level,
      maxNew,
    )
    for (const off of actions) {
      this.offers.recordOfferQueued(off.gigId, off.driverId, off.feeCents, this.now)
      this.outbox.push(off)
    }
    g.nextOfferCheckAt = this.now + (target.urgent || target.isPastDeadline ? 15 : 40)
  }

  queueDirectOffersForOpenGigs(maxPerGig = 2, isFinal = false): void {
    if (this.level < 3) return
    const tod = this.now % DAY
    if (tod < 7 * HOUR || tod > 22 * HOUR + 45) return

    const nowMs = performance.now()
    const commitments = this.activeCommitments()
    let nonUrgentQueued = 0

    for (const g of this.gigs.values()) {
      if (g.status !== "open") continue
      if (this.offers.openCount(g.id) >= 3) continue
      if (this.now < g.nextOfferCheckAt) continue

      const target = this.buildOfferTarget(g)
      if (!target) continue

      // In live --final, throttle non-urgent offers (<= 5/sec) so the 20/sec final-actions bucket always keeps >=30 burst headroom for bulk quotes!
      if (isFinal && !target.urgent && !target.isPastDeadline) {
        if (nonUrgentQueued >= 4 || nowMs - this.lastNonUrgentOfferMs < 220) continue
      }

      const actions = this.offers.selectOffersForGig(
        this.map,
        this.supply,
        commitments,
        target,
        this.now,
        this.level,
        maxPerGig,
      )
      for (const off of actions) {
        this.offers.recordOfferQueued(off.gigId, off.driverId, off.feeCents, this.now)
        this.outbox.push(off)
        if (!target.urgent && !target.isPastDeadline) {
          nonUrgentQueued++
          this.lastNonUrgentOfferMs = nowMs
        }
      }
      g.nextOfferCheckAt = this.now + (target.urgent || target.isPastDeadline ? 12 : 40)
    }
  }

  tickTimers(isFinal = false): void {
    this.checkDayRollover()
    // Only finalize strictly older minutes so same-minute [revenue, late_refund] pairs in --final are NEVER misclassified as on-time!
    this.finalizePendingRevenue(this.now >= this.endsAt ? this.now : this.now - 1)

    // 0. Flush expired pairing-buffer orders (allow bundling with any newly arrived/open partner on flush!)
    for (const [bufferedId, releaseAt] of [...this.pairingBufferUntil.entries()]) {
      if (this.now >= releaseAt || this.urgent.has(bufferedId)) {
        this.pairingBufferUntil.delete(bufferedId)
        const ord = this.orders.get(bufferedId)
        if (ord) {
          const missing = undeliveredLegs(ord).filter(
            (leg) => !this.legGigs.get(ord.id)?.has(leg) && !this.hasPendingPostInOutbox(ord.id, leg),
          )
          if (missing.length > 0) {
            const canPairOnFlush = !this.urgent.has(ord.id) && !this.doNotBundle.has(ord.id)
            // Prevent re-buffering on flush by temporarily passing allowBundle only if a partner exists; otherwise post solo
            if (canPairOnFlush) {
              this.doNotBundle.add("__flush_guard__")
              const beforeOutbox = this.outbox.length
              this.pairingBufferUntil.set("__skip__", 0)
              this.pairingBufferUntil.delete("__skip__")
              // Try pairing against existing open gigs without re-entering pairingBufferUntil:
              this.dispatchOrderLegsNoRebuffer(ord, missing)
              this.doNotBundle.delete("__flush_guard__")
              void beforeOutbox
            } else {
              this.dispatchOrderLegs(ord, missing, false)
            }
          }
        }
      }
    }

    // 1. Orphan guard: ensure every live undelivered order leg is carried by a gig, pairing buffer, or pending post
    for (const order of this.orders.values()) {
      if (this.pairingBufferUntil.has(order.id)) continue
      if ((this.postBackoffUntil.get(order.id) ?? 0) > this.now) continue
      const missing = undeliveredLegs(order).filter(
        (leg) => !this.legGigs.get(order.id)?.has(leg) && !this.hasPendingPostInOutbox(order.id, leg),
      )
      if (missing.length > 0) {
        this.doNotBundle.add(order.id)
        this.dispatchOrderLegs(order, missing, false)
      }
    }

    const curTod = this.now % DAY
    const inAwakeHours = curTod >= 7 * HOUR && curTod <= 22 * HOUR + 40

    // 2. Bundle auto-splits, proactive urgent ramps, and past-deadline rescue ramps
    for (const g of [...this.gigs.values()]) {
      if (g.status !== "open") continue
      if (g.isBundledTwoOrder && this.now >= g.splitAt) {
        this.splitOpenBundle(g)
        continue
      }

      if (!g.isBundledTwoOrder && g.stops[0]) {
        const ord = this.orders.get(g.stops[0].orderId)
        if (!ord) continue

        // Zombie-gig cleanup at lastPickupAt + 1 (only when g was genuinely on-time bookable when posted!)
        const firstStopLeg = ord.legs[g.stops[0].leg]
        const hasFirstPrivPick = Boolean(firstStopLeg?.pickup.privateAddress)
        const minRoad = firstStopLeg ? this.map.roadMinutes(firstStopLeg.pickup.placeId, ord.legs[ord.legs.length - 1]!.delivery.placeId) : 0
        const wasOnTimeWhenPosted = g.postedAt <= ord.lastPickupAt && g.postedAt + minRoad <= ord.deadline
        if (!hasFirstPrivPick && !g.zombieCleared && wasOnTimeWhenPosted && this.now > ord.lastPickupAt) {
          g.status = "withdrawn"
          g.zombieCleared = true
          this.unlinkGig(g.id)
          this.outbox.push({ type: "withdraw", gigId: g.id })
          this.omitSoftCapOrders.add(ord.id)
          this.urgent.add(ord.id)
          this.doNotBundle.add(ord.id)
          const missing = undeliveredLegs(ord).filter((l) => !this.legGigs.get(ord.id)?.has(l))
          if (missing.length > 0) this.dispatchOrderLegs(ord, missing, false)
          continue
        }

        if (!g.pastDeadlineEscalated && inAwakeHours && this.now > ord.deadline + 30) {
          this.escalateOrderUrgent(ord)
          continue
        }
        if (!g.urgentEscalated && inAwakeHours) {
          const effLpa = this.effectiveLastPickupByOrder.get(ord.id) ?? ord.lastPickupAt
          const dealer = this.pricing.estimator.getDealer(ord.dealerId)
          const warnLead = this.level === 8 && dealer.trust >= 6 ? 240 : 195
          if (effLpa - this.now <= warnLead) {
            this.escalateOrderUrgent(ord)
          }
        }
      }
    }

    if (this.needsImmediateOfferPass) {
      this.needsImmediateOfferPass = false
      this.queueDirectOffersForOpenGigs(2, isFinal)
    } else {
      this.queueDirectOffersForOpenGigs(1, isFinal)
    }
  }

  private dispatchOrderLegsNoRebuffer(order: Order, legIndices: readonly number[]): void {
    this.dispatchOrderLegs(order, legIndices, true)
    if (this.pairingBufferUntil.has(order.id)) {
      this.pairingBufferUntil.delete(order.id)
      this.dispatchOrderLegs(order, legIndices, false)
    }
  }

  nextTimerAt(): number {
    if (this.needsImmediateOfferPass) {
      const tod = this.now % DAY
      if (tod >= 7 * HOUR && tod <= 22 * HOUR + 40) {
        return this.now + 2
      }
    }

    let next = this.endsAt
    for (const releaseAt of this.pairingBufferUntil.values()) {
      if (releaseAt > this.now) next = Math.min(next, releaseAt)
    }
    const dayStart = Math.floor(this.now / DAY) * DAY
    const morningFlush = dayStart + 7 * HOUR + 5
    if (this.now < morningFlush) next = Math.min(next, morningFlush)
    else next = Math.min(next, dayStart + DAY + 7 * HOUR + 5)

    for (const g of this.gigs.values()) {
      if (g.status !== "open") continue
      if (g.isBundledTwoOrder && g.splitAt > this.now) {
        next = Math.min(next, g.splitAt)
      }
      if (g.nextOfferCheckAt > this.now) {
        const checkTod = g.nextOfferCheckAt % DAY
        if (checkTod >= 7 * HOUR && checkTod <= 22 * HOUR + 45) {
          next = Math.min(next, g.nextOfferCheckAt)
        }
      }
      if (!g.isBundledTwoOrder && g.stops[0]) {
        const ord = this.orders.get(g.stops[0].orderId)
        if (!ord) continue
        const firstStopLeg = ord.legs[g.stops[0].leg]
        const minRoad = firstStopLeg ? this.map.roadMinutes(firstStopLeg.pickup.placeId, ord.legs[ord.legs.length - 1]!.delivery.placeId) : 0
        if (
          !g.zombieCleared &&
          !firstStopLeg?.pickup.privateAddress &&
          g.postedAt <= ord.lastPickupAt &&
          g.postedAt + minRoad <= ord.deadline
        ) {
          const zombieAt = ord.lastPickupAt + 1
          if (zombieAt > this.now) next = Math.min(next, zombieAt)
        }
        if (!g.pastDeadlineEscalated) {
          let rescueAt = ord.deadline + 31
          const rTod = rescueAt % DAY
          if (rTod > 22 * HOUR + 40) rescueAt = (Math.floor(rescueAt / DAY) + 1) * DAY + 7 * HOUR + 5
          else if (rTod < 7 * HOUR) rescueAt = Math.floor(rescueAt / DAY) * DAY + 7 * HOUR + 5
          if (rescueAt > this.now) next = Math.min(next, rescueAt)
        }
        if (!g.urgentEscalated) {
          const effLpa = this.effectiveLastPickupByOrder.get(ord.id) ?? ord.lastPickupAt
          const dealer = this.pricing.estimator.getDealer(ord.dealerId)
          const warnLead = this.level === 8 && dealer.trust >= 6 ? 240 : 195
          let trig = effLpa - warnLead
          const tTod = ((trig % DAY) + DAY) % DAY
          if (tTod > 22 * HOUR + 40) trig = (Math.floor(trig / DAY) + 1) * DAY + 7 * HOUR + 5
          else if (tTod < 7 * HOUR) trig = Math.floor(trig / DAY) * DAY + 7 * HOUR + 5
          if (trig > this.now) next = Math.min(next, trig)
        }
      }
    }

    return Math.max(this.now + 1, next)
  }

  drainOutboxSorted(): Action[] {
    if (this.outbox.length === 0) return []
    const actions = this.outbox.splice(0)
    actions.sort((a, b) => ACTION_PRIORITY[a.type] - ACTION_PRIORITY[b.type])
    return actions
  }

  async sendQuotesOnly(): Promise<void> {
    const quotes: Action[] = []
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      if (this.outbox[i]!.type === "quote") {
        quotes.push(this.outbox.splice(i, 1)[0]!)
      }
    }
    quotes.reverse()
    for (let i = 0; i < quotes.length; i += 20) {
      const chunk = quotes.slice(i, i + 20)
      const res = await this.world.act(chunk)
      this.readResults(chunk, res)
    }
  }

  async send(isFinal = false): Promise<void> {
    if (this.outbox.length === 0) return
    if (!isFinal) {
      const hasCancel = this.outbox.some((a) => a.type === "withdraw" || a.type === "release")
      const hasPost = this.outbox.some((a) => a.type === "post")
      if (!hasCancel || !hasPost) {
        const actions = this.drainOutboxSorted()
        if (actions.length > 0) {
          const results = await this.world.act(actions)
          this.readResults(actions, results)
        }
        return
      }
    }

    // Phased transmission:
    // Phase 1: Urgent quote fast-lane in chunks <= 20 so bulk orders answer well inside the 4.5s respondBy budget!
    await this.sendQuotesOnly()

    // Phase 2: Withdraw & release BEFORE companion posts so a raced booking/start cancels duplicate posts!
    const cancels: Action[] = []
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const t = this.outbox[i]!.type
      if (t === "withdraw" || t === "release") {
        cancels.push(this.outbox.splice(i, 1)[0]!)
      }
    }
    cancels.reverse()
    if (cancels.length > 0) {
      const res = await this.world.act(cancels)
      this.readResults(cancels, res)
    }

    // Phase 3: Remaining posts, reprices, and offers
    const rest = this.drainOutboxSorted()
    if (rest.length > 0) {
      const res = await this.world.act(rest)
      this.readResults(rest, res)
    }
  }

  readResults(actions: readonly Action[], results: readonly ActionResult[]): void {
    actions.forEach((action, i) => {
      const res = results[i]
      if (!res) return
      if (action.type === "quote") {
        if (!res.ok) {
          this.unresolvedQuotes.delete(action.requestId)
          const req = this.requests.get(action.requestId)
          if (req) this.pricing.estimator.getDealer(req.dealerId).unquotedCount++
        }
      } else if (action.type === "post") {
        const meta = this.pendingPostMeta.get(action)
        if (res.ok) {
          const immediateOffer = Boolean(meta?.urgentEscalated || meta?.pastDeadlineEscalated)
          const gig: GigState = {
            id: res.id,
            stops: action.stops,
            audience: action.audience,
            schedule: action.schedule,
            status: "open",
            postedAt: this.now,
            bookedAt: null,
            startedAt: null,
            feeCents: action.schedule[0]?.feeCents ?? 0,
            driverId: null,
            isBundledTwoOrder: meta?.isBundledTwoOrder ?? false,
            splitAt: meta?.splitAt ?? Infinity,
            urgentEscalated: meta?.urgentEscalated ?? false,
            urgentEscalatedAt: meta?.urgentEscalated ? this.now : null,
            pastDeadlineEscalated: meta?.pastDeadlineEscalated ?? false,
            zombieCleared: false,
            offerWave: 0,
            nextOfferCheckAt: immediateOffer ? this.now : this.now + 12,
          }
          this.linkGig(gig)
        } else {
          // Fallback if a bundled or custom-window post was ever refused by the server:
          // never leave any won order orphaned, and never spin-loop if strippedFallback was already tried!
          const failedOrders = this.distinctLiveOrdersOfStops(action.stops)
          for (const ord of failedOrders) {
            this.doNotBundle.add(ord.id)
            if (meta?.strippedFallback) {
              this.postBackoffUntil.set(ord.id, this.now + 5)
              continue
            }
            if (!meta?.isBundledTwoOrder) {
              this.stripWindowsOrders.add(ord.id)
            }
            const missing = undeliveredLegs(ord).filter(
              (leg) => !this.legGigs.get(ord.id)?.has(leg) && !this.hasPendingPostInOutbox(ord.id, leg),
            )
            if (missing.length > 0) {
              this.dispatchOrderLegs(ord, missing, false)
            }
          }
        }
      } else if (action.type === "offer") {
        if (!res.ok) {
          this.offers.rollbackOfferRefused(action.gigId, action.driverId, this.now, res.reason)
        }
      } else if (action.type === "withdraw" || action.type === "release") {
        if (!res.ok) {
          const g = this.gigs.get(action.gigId)
          if (g && !/withdrawn|expired|not open|not found|unknown|already released/i.test(res.reason)) {
            g.status = /done|deliver|complete/i.test(res.reason)
              ? "done"
              : /start|work|mov|left/i.test(res.reason)
                ? "working"
                : "booked"
            if (g.status !== "done") this.linkGig(g)
            // Cancel any pending replacement post in outbox that overlaps with g's pickup (orderId:leg) pairs!
            const coveredLegs = new Set(
              g.stops.filter((s) => s.kind === "pickup").map((s) => `${s.orderId}:${s.leg}`),
            )
            const coveredOrders = new Set(g.stops.map((s) => s.orderId))
            const orphanedPartners = new Set<string>()
            for (let k = this.outbox.length - 1; k >= 0; k--) {
              const cand = this.outbox[k]!
              if (
                cand.type === "post" &&
                cand.stops.some((s) => s.kind === "pickup" && coveredLegs.has(`${s.orderId}:${s.leg}`))
              ) {
                for (const s of cand.stops) {
                  if (s.kind === "pickup" && !coveredOrders.has(s.orderId)) orphanedPartners.add(s.orderId)
                }
                this.outbox.splice(k, 1)
              }
            }
            for (const pid of orphanedPartners) {
              this.doNotBundle.add(pid)
              const po = this.orders.get(pid)
              if (!po) continue
              const missing = undeliveredLegs(po).filter((l) => !this.legGigs.get(pid)?.has(l))
              if (missing.length > 0) this.dispatchOrderLegs(po, missing, false)
            }
          }
        }
      }
    })
  }
}

async function playPractice(world: World, level: number): Promise<void> {
  const [snapshot, rawMap, roster] = await Promise.all([
    world.snapshot(),
    world.client.map(),
    world.roster(),
  ])
  const { now, endsAt } = snapshot
  const desk = new Desk(world, level, now, endsAt, rawMap, roster)
  if (now > 0) {
    const history = await world.events()
    await desk.rejoin(snapshot, history)
    desk.tickTimers(false)
  }

  while (desk.now < endsAt) {
    const day = Math.floor(desk.now / DAY)
    const midnight = (day + 1) * DAY
    const stopAt = Math.min(endsAt, midnight, desk.nextTimerAt())
    const actions = desk.drainOutboxSorted()
    const step = await world.advance({ untilEvent: WAKE_ON, max: stopAt, actions })
    desk.readResults(actions, step.results)
    desk.now = step.now
    for (const event of step.events) desk.handle(event)
    desk.flushPendingPriceRequests()
    desk.tickTimers(false)
    if (Math.floor(desk.now / DAY) > day) {
      report(WEEKDAYS[day % 7]!, await world.score())
    }
  }
  desk.finalizePendingRevenue(endsAt)
  await desk.send(false)
}

async function playFinal(world: World): Promise<void> {
  // Tear-free startup: fetch history0 BEFORE snapshot, then tail events after seq0!
  const [history0, worlds, rawMap, roster] = await Promise.all([
    world.events(),
    world.client.worlds(),
    world.client.map(),
    world.roster(),
  ])
  const snapshot = await world.snapshot()
  if (snapshot.now >= snapshot.endsAt) return
  const seq0 = history0.at(-1)?.seq ?? -1
  const level = worlds.find((summary) => summary.worldId === world.id)?.level ?? 8
  const desk = new Desk(world, level, snapshot.now, snapshot.endsAt, rawMap, roster)
  await desk.rejoin(snapshot, history0)
  const tail = await world.events(seq0)
  const quotedOpenIds = new Set(snapshot.openRequests.map((r) => r.id))
  for (const ev of tail) {
    if (ev.kind === "price_request" && quotedOpenIds.has(ev.request.id)) continue
    if (ev.kind === "order_won" && desk.orders.has(ev.order.id)) continue
    desk.handle(ev)
  }
  desk.flushPendingPriceRequests()
  const startAfterSeq = (tail.at(-1) ?? history0.at(-1))?.seq ?? -1
  desk.tickTimers(true)
  await desk.send(true)

  let lastRosterFetchMs = performance.now()

  // Background stream reader pump so WebSocket bursts (e.g. 40-car bulk orders & [revenue, late_refund] pairs)
  // are drained synchronously in micro-batches instead of blocking 1-by-1 behind HTTP RTTs!
  const pending: Array<DeskEvent | null> = []
  let streamDone = false
  let streamError: unknown = null
  let notifyPump = () => {}
  const abortCtrl = new AbortController()

  void (async () => {
    try {
      for await (const ev of world.stream({ after: startAfterSeq, idleMs: 600, signal: abortCtrl.signal })) {
        pending.push(ev)
        notifyPump()
      }
    } catch (err) {
      streamError = err
    } finally {
      streamDone = true
      notifyPump()
    }
  })()

  try {
    while (!streamDone || pending.length > 0) {
      if (streamError) throw streamError
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          notifyPump = resolve
        })
        if (pending.length === 0) continue
      }
      // 6ms micro-batch coalesce to gather simultaneous bulk-order requests & ledger pairs
      await new Promise((resolve) => setTimeout(resolve, 6))

      const day = Math.floor(desk.now / DAY)
      const batch = pending.splice(0)
      let sawNull = false
      for (const item of batch) {
        if (item === null) sawNull = true
        else desk.handle(item)
      }
      if (sawNull && batch.every((x) => x === null)) {
        const f = await world.client.final().catch(() => null)
        if (f) desk.now = Math.max(desk.now, f.now)
      }
      desk.flushPendingPriceRequests()

      // Flush any urgent quotes immediately via sendQuotesOnly() before running timer/offer passes!
      if (desk.outbox.some((a) => a.type === "quote")) {
        await desk.sendQuotesOnly()
      }
      desk.tickTimers(true)
      await desk.send(true)

      if (performance.now() - lastRosterFetchMs > 45_000) {
        lastRosterFetchMs = performance.now()
        void world
          .roster()
          .then((fresh) => {
            if (fresh) desk.supply.updateRoster(fresh)
          })
          .catch(() => null)
      }

      if (Math.floor(desk.now / DAY) > day) {
        void world
          .score()
          .then((sc) => {
            if (sc) report(WEEKDAYS[day % 7]!, sc)
          })
          .catch(() => null)
      }
      if (desk.now >= snapshot.endsAt) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        if (pending.length > 0) continue
        desk.finalizePendingRevenue(snapshot.endsAt)
        return
      }
    }
  } finally {
    abortCtrl.abort()
  }
}

function report(label: string, score: Score): void {
  const euros = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(11)
  const percent = (share: number, width: number) => `${(100 * share).toFixed(1)}%`.padStart(width)
  const orders = `${String(score.wonOrders).padStart(4)} orders  ${percent(score.onTimeShare, 6)} on time  ${percent(score.undeliveredShare, 5)} not delivered`
  console.log(`${label.padEnd(9)}  margin €${euros(score.marginCents)}  revenue €${euros(score.revenueCents)}  ${orders}`)
}

async function nextFinal(client: Client): Promise<World> {
  for (let said = false; ; said = true) {
    const set = await client.final().catch((error: unknown) => {
      if (error instanceof SpreadError && error.status === 404) return null
      throw error
    })
    const world = set ? client.world(set.worldId) : null
    if (world) {
      const snapshot = await world.snapshot()
      if (snapshot.now < snapshot.endsAt) return world
    }
    if (!said) {
      console.log(
        "No final is set. Waiting for it: the organisers set a test final 15 minutes before its start, and the final 30 minutes before.",
      )
    }
    await new Promise((done) => setTimeout(done, 10_000))
  }
}

const USAGE =
  "Usage: bun starter.ts [--level 1-8] [--seed <text>] [--board] [--final]. Set SPREAD_URL and SPREAD_KEY first."

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      level: { type: "string", default: "8" },
      seed: { type: "string" },
      board: { type: "boolean" },
      final: { type: "boolean" },
    },
  })
  const level = Number(args.level)
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(level)) throw new SpreadError(0, `--level must be 1 to 8. ${USAGE}`)
  const client = new Client()
  let world: World | undefined
  let score: Score | undefined

  if (args.final) {
    process.once("SIGINT", () =>
      exit("Stopped. The final world keeps running without your system; start it again with --final."),
    )
    while (true) {
      try {
        if (!world) {
          world = await nextFinal(client)
          console.log(`Final world ${world.id}.`)
        }
        await playFinal(world)
        score = await world.score()
        break
      } catch (error) {
        if (error instanceof SpreadError && error.status === 401) throw error
        console.error(`spread: ${(error as Error).message}. Rebuilding and continuing in 3 seconds.`)
        await new Promise((done) => setTimeout(done, 3000))
      }
    }
  } else if (args.board) {
    process.once("SIGINT", () =>
      exit("Stopped. The ranking run stays paused on the server; re-run with --board to resume and finish it."),
    )
    const existingWorlds = await client.worlds()
    const unfinishedBoard = existingWorlds.find((w) => w.boardRun !== null && w.level === level && !w.ended)
    const run = unfinishedBoard
      ? client.world(unfinishedBoard.worldId)
      : await client.create(level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, { board: true })
    world = run
    console.log(
      `Ranking run ${run.id}${unfinishedBoard ? ` (resumed run ${unfinishedBoard.boardRun})` : ""}, level ${level}.`,
    )
    while (true) {
      try {
        await playPractice(run, level)
        break
      } catch (error) {
        if (error instanceof SpreadError && (error.status === 401 || error.status === 400)) throw error
        console.error(`spread: ${(error as Error).message}. Rebuilding ranking desk and continuing in 3 seconds.`)
        await new Promise((done) => setTimeout(done, 3000))
      }
    }
  } else {
    const run = await client.create(level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, { seed: args.seed, board: false })
    world = run
    const name = `Practice world ${run.id}`
    const afterStop = (deleted: boolean) =>
      deleted
        ? `${name} is deleted.`
        : `${name} is not deleted: it holds one of your eight practice slots.`
    console.log(`${name}, level ${level}. Ctrl-C or an error stops the run and deletes the world.`)
    const remove = () => run.delete().then(() => true, () => false)
    process.once("SIGINT", () => void remove().then((deleted) => exit(`Stopped. ${afterStop(deleted)}`)))
    await playPractice(run, level).catch(async (error: unknown) => {
      console.error(`Stopped by the error below. ${afterStop(await remove())}`)
      throw error
    })
  }

  score ??= await world.score()
  report("End", score)
  console.log(
    score.ranked
      ? "Ranked."
      : score.wonOrders === 0
        ? "Not ranked: no order won."
        : "Not ranked: the delivery minimum is 90% of the orders on time.",
  )
}

function exit(message: string): never {
  console.error(message)
  process.exit(1)
}

await main().catch((error: unknown) => {
  if (error instanceof SpreadError) exit(`spread: ${error.message}`)
  if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    exit(`${error.message}. ${USAGE}`)
  }
  throw error
})
