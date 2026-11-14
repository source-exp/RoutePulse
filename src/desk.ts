import {
  findBestTwoOrderBundle,
  tryExtendTwoToThreeOrderBundle,
} from "./bundling.ts"
import type { BundleOrderEntry } from "./bundling.ts"
import { buildSingleGigSchedule, bumpScheduleAfterDrop, currentScheduleFee } from "./dispatch.ts"
import { unroundedListPriceCents } from "./estimator.ts"
import type { BatchQuoteContext, RecordedQuoteMeta } from "./estimator.ts"
import { PricingEngine } from "./market.ts"
import {
  createDefaultLegNote,
  effectiveOrderDeadline,
  parseDealerNote,
  reconcileNotesAfterOrderChange,
} from "./notes.ts"
import type { ParsedLegNote } from "./notes.ts"
import { DirectOfferTracker } from "./offers.ts"
import type { ActiveDriverCommitment, OfferGigTarget } from "./offers.ts"
import { ActionOutbox } from "./outbox.ts"
import {
  buildStopsForOrder,
  CHARGING_MINUTES,
  EMPTY_RETRY,
  MapGraph,
  MAX_MULTI_CAR_ROAD_MINUTES,
  PLATES_MINUTES,
  SnowTracker,
  visitAt,
} from "./planner.ts"
import type { BuiltOrderStops, RetryState } from "./planner.ts"
import { rejoinDeskState } from "./rejoin.ts"
import type { World } from "./spread.ts"
import { RosterSupplyModel } from "./supply.ts"
import {
  clampTriggerToAwakeWindow,
  DAY,
  dayOf,
  dayStartOf,
  HOUR,
  openingSlotForDay,
} from "./time.ts"
import type {
  Action,
  ActionResult,
  Audience,
  DeskEvent,
  DeskSnapshot,
  DriverProfile,
  FeeStep,
  Leg,
  Order,
  PriceRequest,
  StopRef,
  VisitFailedEvent,
  WorldMap,
} from "./types.ts"

export type GigState = {
  id: string
  stops: StopRef[]
  audience: Audience
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
  endWorldRescueEscalated: boolean
  zombieCleared: boolean
  offerWave: number
  nextOfferCheckAt: number
}

export type BatchState = {
  batchId: string
  seenIds: Set<string>
  wonIds: Set<string>
  lostIds: Set<string>
}

function hasUndeliveredLegs(order: Order): boolean {
  for (let i = 0; i < order.legs.length; i++) {
    if (order.deliveredAt[i] === null) return true
  }
  return false
}

function undeliveredLegs(order: Order): number[] {
  const out: number[] = []
  for (let i = 0; i < order.legs.length; i++) {
    if (order.deliveredAt[i] === null) out.push(i)
  }
  return out
}

function hasMultipleOrdersInStops(stops: readonly StopRef[]): boolean {
  if (stops.length <= 1) return false
  const firstId = stops[0]!.orderId
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.orderId !== firstId) return true
  }
  return false
}

export class Desk {
  readonly world: World
  readonly level: number
  readonly map: MapGraph
  readonly snow = new SnowTracker()
  readonly supply: RosterSupplyModel
  readonly pricing: PricingEngine
  readonly offers = new DirectOfferTracker()
  readonly outbox = new ActionOutbox()

  now: number
  endsAt: number

  readonly requests = new Map<string, PriceRequest>()
  readonly notesByOrder = new Map<string, ParsedLegNote[]>()
  readonly quoteMetaByReq = new Map<string, RecordedQuoteMeta>()
  readonly pendingPriceRequests = new Map<string, PriceRequest>()
  readonly unresolvedQuotes = new Map<string, RecordedQuoteMeta>()
  readonly batches = new Map<string, BatchState>()

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
  midnightFluDrops = 0
  fluActiveToday = false
  fluUsedThisWeek = false
  needsImmediateOfferPass = false
  lastNonUrgentOfferMs = 0
  isFinal = false

  constructor(
    world: World,
    level: number,
    now: number,
    endsAt: number,
    rawMap: WorldMap,
    roster: DriverProfile[] = [],
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

  // --- Core State & Graph Helpers ---

  private recordOrderReachedFee(orderId: string, feeCents: number): void {
    if (feeCents <= 0) return
    const prev = this.maxReachedFeeByOrder.get(orderId) ?? 0
    if (feeCents > prev) this.maxReachedFeeByOrder.set(orderId, feeCents)
  }

  checkDayRollover(): void {
    const day = dayOf(this.now)
    if (day !== this.fluDayTracker) {
      if (this.fluActiveToday) this.fluUsedThisWeek = true
      this.fluDayTracker = day
      this.midnightFluDrops = 0
      this.fluActiveToday = false
    }
  }

  recordMidnightFluDrop(): void {
    this.midnightFluDrops++
    if (this.midnightFluDrops >= (this.supply.totalDrivers < 740 ? 6 : 8)) {
      this.fluActiveToday = true
    }
  }

  getLegRetry(orderId: string, leg: number): RetryState {
    return this.retries.get(orderId)?.get(leg) ?? EMPTY_RETRY
  }

  setLegRetry(orderId: string, leg: number, next: RetryState): void {
    let m = this.retries.get(orderId)
    if (!m) {
      m = new Map()
      this.retries.set(orderId, m)
    }
    m.set(leg, next)
  }

  applyVisitFailedRetry(
    orderId: string,
    leg: number,
    reason: VisitFailedEvent["reason"],
    at: number,
    order: Order | undefined,
  ): void {
    const req = this.requests.get(orderId)
    const prev = this.getLegRetry(orderId, leg)
    const carNotThere = reason === "not_ready" || reason === "closed"
    const pickupFrom =
      carNotThere && order && req ? this.computeRetryFrom(order, req, leg, at) : prev.pickupFrom
    this.setLegRetry(orderId, leg, {
      pickupFrom,
      manualLicence: prev.manualLicence || reason === "licence",
      plates: prev.plates || reason === "no_plates",
    })
  }

  getNotes(orderId: string): ParsedLegNote[] {
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
    return order.legs.map((l) => createDefaultLegNote(l))
  }

  linkGig(gig: GigState): void {
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

  private hasRemainingUndeliveredPickups(stops: readonly StopRef[]): boolean {
    for (const s of stops) {
      if (s.kind !== "pickup") continue
      const o = this.orders.get(s.orderId)
      if (o && o.deliveredAt[s.leg] === null) return true
    }
    return false
  }

  private measureStopsRoadStats(stops: readonly StopRef[]): {
    totalRoadMinutes: number
    maxDeadheadMinutes: number
  } {
    let totalRoadMinutes = 0
    let maxDeadheadMinutes = 0
    let prevPl: string | undefined
    let prevWasDeliv = false

    for (const s of stops) {
      const o = this.orders.get(s.orderId)
      const leg = o?.legs[s.leg]
      if (!leg) continue
      const pl = s.kind === "pickup" ? leg.pickup.placeId : leg.delivery.placeId
      if (prevPl !== undefined && prevPl !== pl) {
        const seg = this.map.roadMinutes(prevPl, pl)
        totalRoadMinutes += seg
        if (prevWasDeliv && s.kind === "pickup" && seg > maxDeadheadMinutes) {
          maxDeadheadMinutes = seg
        }
      }
      prevWasDeliv = s.kind === "delivery"
      prevPl = pl
    }

    return { totalRoadMinutes, maxDeadheadMinutes }
  }

  unscheduledLegsForOrder(order: Order, checkPendingOutbox = false): number[] {
    const legMap = this.legGigs.get(order.id)
    const out: number[] = []
    for (let i = 0; i < order.legs.length; i++) {
      if (order.deliveredAt[i] !== null) continue
      if (legMap?.has(i)) continue
      if (checkPendingOutbox && this.outbox.hasPendingPostForLeg(order.id, i)) continue
      out.push(i)
    }
    return out
  }

  // --- Portfolio, Load & Synergy Queries ---

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

      const { totalRoadMinutes } = this.measureStopsRoadStats(g.stops)
      const estStart =
        g.status === "working" && g.startedAt !== null
          ? g.startedAt
          : Math.max(
              this.now,
              pickups[0]!.window?.from ?? firstOrd.legs[pickups[0]!.leg]!.pickup.window.from,
            )
      const estFinish = Math.max(this.now + 5, estStart + totalRoadMinutes + pickups.length * 25)
      list.push({
        gigId: g.id,
        driverId: g.driverId,
        status: g.status,
        pickupPlaceId: pPlace,
        deliveryPlaceId: dPlace,
        estStartAt: estStart,
        estFinishAt: estFinish,
        driveMinutes: totalRoadMinutes,
      })
    }
    return list
  }

  private countUnbookedOrders(): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (!hasUndeliveredLegs(o)) continue
      const m = this.legGigs.get(o.id)
      let allBooked = true
      let inEarlyDiscovery = this.pairingBufferUntil.has(o.id)
      for (let leg = 0; leg < o.legs.length; leg++) {
        if (o.deliveredAt[leg] !== null) continue
        const gid = m?.get(leg)
        const g = gid ? this.gigs.get(gid) : undefined
        if (!g || (g.status !== "booked" && g.status !== "working")) {
          allBooked = false
          if (g && g.status === "open" && !g.urgentEscalated && this.now - g.postedAt <= 95) {
            const effLpa = this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt
            if (effLpa - this.now >= 480) inEarlyDiscovery = true
          }
          break
        }
      }
      if (!allBooked) count += inEarlyDiscovery ? 0.55 : 1
    }
    return count
  }

  private countBundledDriverSavings(): number {
    let savedSlots = 0
    for (const g of this.gigs.values()) {
      if (!g.isBundledTwoOrder || g.status === "withdrawn") continue
      const distinctOrders = new Set<string>()
      for (const s of g.stops) distinctOrders.add(s.orderId)
      if (distinctOrders.size >= 2) {
        savedSlots += 0.55 * (distinctOrders.size - 1)
      }
    }
    return savedSlots
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

  recordBatchArrival(request: PriceRequest): void {
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
      if (!hasUndeliveredLegs(o)) {
        const lastDeliv = o.deliveredAt[o.deliveredAt.length - 1] ?? null
        if (lastDeliv !== null && dayOf(lastDeliv) === deadlineDay && dayOf(this.now) === deadlineDay) {
          count += 0.55
        }
        continue
      }
      if (dayOf(effectiveOrderDeadline(o, this.getNotes(o.id))) === deadlineDay) count++
    }
    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.respondBy <= this.now || this.orders.has(meta.request.id)) continue
      for (const d of meta.expectedWinsByDeadlineDay) {
        if (d.deadlineDay === deadlineDay) count += d.expectedWins
      }
    }
    return count
  }

  private cluster30Set(placeId: string): ReadonlySet<string> {
    return this.map.within30kmSet.get(placeId) ?? new Set([placeId])
  }

  private countOpenPickupsInCluster30(placeId: string): number {
    const cluster = this.cluster30Set(placeId)
    let count = 0
    for (const g of this.gigs.values()) {
      if (g.status !== "open") continue
      const p0 = g.stops[0]
      if (!p0) continue
      const o = this.orders.get(p0.orderId)
      const pId = o?.legs[p0.leg]?.pickup.placeId
      if (pId && cluster.has(pId)) {
        const effLpa = o ? (this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt) : 0
        const inDiscovery = !g.urgentEscalated && this.now - g.postedAt <= 95 && effLpa - this.now >= 480
        count += inDiscovery ? 0.55 : 1
      }
    }
    return count
  }

  private countPendingPickupsInCluster30(placeId: string): number {
    const cluster = this.cluster30Set(placeId)
    let count = 0
    for (const act of this.outbox.actions) {
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
      if (this.legGigs.get(o.id)?.has(leg0) || this.outbox.hasPendingPostForLeg(o.id, leg0)) continue
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
      if (!hasUndeliveredLegs(o)) continue
      if (this.now > effectiveOrderDeadline(o, this.getNotes(o.id))) count++
    }
    return count
  }

  private countInFlightDealerOrders(dealerId: string): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (o.dealerId !== dealerId || !hasUndeliveredLegs(o)) continue
      if (this.now <= effectiveOrderDeadline(o, this.getNotes(o.id))) count += 0.96
    }
    for (const meta of this.unresolvedQuotes.values()) {
      if (meta.request.dealerId !== dealerId) continue
      if (meta.request.respondBy <= this.now || this.orders.has(meta.request.id)) continue
      count += meta.expectedWinProb
    }
    return count
  }

  private hasArrivingDriverSynergy(
    pickupId: string,
    deliveryId: string,
    earliestMin: number,
    latestMin: number,
  ): boolean {
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

  private matchesRoundTripPartnerOrder(o: Order | undefined, pickupId: string, deliveryId: string): boolean {
    if (!o || o.legs.length !== 1) return false
    const l = o.legs[0]!
    if (l.car.premium || l.pickup.privateAddress || l.delivery.privateAddress) return false
    return (
      this.map.roadMinutes(l.delivery.placeId, pickupId) <= 50 &&
      this.map.roadMinutes(deliveryId, l.pickup.placeId) <= 120
    )
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
      if (this.matchesRoundTripPartnerOrder(this.orders.get(bufferedId), pickupId, deliveryId)) {
        return 1.0
      }
    }
    for (const g of this.gigs.values()) {
      if (g.status !== "open" || g.isBundledTwoOrder || g.stops.length !== 2) continue
      if (this.matchesRoundTripPartnerOrder(this.orders.get(g.stops[0]!.orderId), pickupId, deliveryId)) {
        return 1.0
      }
    }
    if (effectiveLastPickupAt - this.now < 300) return 0
    const myReadyDay = dayOf(earliestPickupAt)
    const myDlDay = dayOf(effectiveDeadline)
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
      const candReadyDay = dayOf(Math.max(l2.pickup.window.from, n2?.readyAt ?? 0))
      const candDlDay = dayOf(Math.min(maxCandDl, n2?.noteDeadline ?? Infinity))
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

  // --- Ledger & Dealer Trust Accounting ---

  finalizePendingRevenue(upToMinute: number): void {
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

  markLateOrPenalized(orderId: string): void {
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

  // --- Rejoin & Event Dispatch ---

  async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    rejoinDeskState(this, snapshot, history)
  }

  handle(event: DeskEvent): void {
    this.now = Math.max(this.now, event.at)
    this.checkDayRollover()
    this.finalizePendingRevenue(event.at - 1)

    switch (event.kind) {
      case "forecast":
        this.handleForecast(event.from, event.to, event.placeIds)
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
      case "gig_viewed":
        this.handleGigViewed(event.gigId, event.driverId, event.at)
        break
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

  private handleForecast(from: number, to: number, placeIds: readonly string[]): void {
    this.snow.addForecast(from, to, placeIds)
    for (const g of [...this.gigs.values()]) {
      if (g.status !== "open" || g.isBundledTwoOrder || !g.stops[0]) continue
      const ord = this.orders.get(g.stops[0].orderId)
      if (!ord) continue
      const legs = g.stops.filter((s) => s.kind === "pickup" && s.orderId === ord.id).map((s) => s.leg)
      if (legs.length === 0) continue
      const prevLpa = this.effectiveLastPickupByOrder.get(ord.id) ?? ord.lastPickupAt
      const notes = this.getNotes(ord.id)
      const omitCap = this.omitSoftCapOrders.has(ord.id) || this.now > ord.lastPickupAt
      const rebuilt = buildStopsForOrder(
        this.map,
        this.snow,
        ord,
        legs,
        notes,
        this.retries.get(ord.id) ?? new Map(),
        this.now,
        this.endsAt,
        omitCap,
      )
      this.effectiveLastPickupByOrder.set(ord.id, rebuilt.effectiveLastPickupAt)
      const prevFrom = g.stops[0].window?.from ?? ord.legs[legs[0]!]!.pickup.window.from
      const newFrom = rebuilt.stops[0]?.window?.from ?? ord.legs[legs[0]!]!.pickup.window.from
      const prevTo = g.stops[0].window?.to ?? ord.deadline
      const newTo = rebuilt.stops[0]?.window?.to ?? ord.deadline
      if (newFrom > prevFrom + 15 || prevTo - newTo >= 20 || prevLpa - rebuilt.effectiveLastPickupAt >= 20) {
        g.status = "withdrawn"
        this.unlinkGig(g.id)
        this.outbox.push({ type: "withdraw", gigId: g.id })
        this.dispatchOrderLegs(ord, legs, false)
      }
    }
  }

  private handleGigViewed(gigId: string, driverId: string, at: number): void {
    this.offers.recordView(driverId, at, gigId)
    const vg = this.gigs.get(gigId)
    if (!vg || vg.status !== "open" || this.now < vg.postedAt + 6) return

    const vCount = this.offers.gigViewers.get(gigId)?.get(driverId)?.count ?? 0
    const pairKey = `${gigId}:${driverId}`
    let isHighYieldFirstView = vg.isBundledTwoOrder
    if (!isHighYieldFirstView && vCount === 1 && vg.stops[0]) {
      const prof = this.supply.byId.get(driverId)
      const fOrd = this.orders.get(vg.stops[0].orderId)
      const lStop = vg.stops[vg.stops.length - 1]
      const lOrd = lStop ? this.orders.get(lStop.orderId) : undefined
      const pPl = fOrd?.legs[vg.stops[0].leg]?.pickup.placeId
      const dPl = lOrd && lStop ? lOrd.legs[lStop.leg]?.delivery.placeId : undefined
      if (prof && pPl && dPl && this.map.distKm(prof.homePlaceId, dPl) <= 30 && this.map.distKm(prof.homePlaceId, pPl) > 30) {
        isHighYieldFirstView = true
      }
    }
    if (
      (vCount >= 2 || (vCount === 1 && isHighYieldFirstView)) &&
      !this.offers.attemptedGigDrivers.has(pairKey) &&
      this.offers.openCount(gigId) < 3
    ) {
      vg.nextOfferCheckAt = this.now
      this.needsImmediateOfferPass = true
    }
  }

  // --- Quoting ---

  handlePriceRequest(request: PriceRequest): void {
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
        wonOrdersTotal: Math.max(0, this.wonOrdersTotal - this.countBundledDriverSavings()) + pendingExpWins,
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

  // --- Order & Gig Event Handlers ---

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
    }
    reconcileNotesAfterOrderChange(prev, order, notes)

    const undelAll = undeliveredLegs(order)
    if (undelAll.length > 0) {
      const b = buildStopsForOrder(
        this.map,
        this.snow,
        order,
        undelAll,
        notes,
        this.retries.get(order.id) ?? new Map(),
        this.now,
        this.endsAt,
      )
      this.effectiveLastPickupByOrder.set(order.id, b.effectiveLastPickupAt)
      if (b.effectiveLastPickupAt - this.now > 300) {
        this.urgent.delete(order.id)
        this.maxReachedFeeByOrder.delete(order.id)
      }
    }

    const displacedPartners = this.outbox.removePostsForOrder(order.id)
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
          const legObj = order.legs[legIdx]
          const pStop = g.stops.find((s) => s.kind === "pickup" && s.orderId === order.id && s.leg === legIdx)
          const needsNewCharge = Boolean(
            legObj &&
              pStop &&
              !pStop.withCharging &&
              this.map.needsCharging(legObj.car, legObj.pickup.placeId, legObj.delivery.placeId),
          )
          const req = this.requests.get(order.id)
          const newScale = req ? this.changedKmScaleForOrder(order, req, [legIdx]) : 1.0
          const newRef = req ? (req.referenceFeeCents / order.legs.length) * newScale : g.feeCents
          const effLpa = this.effectiveLastPickupByOrder.get(order.id) ?? order.lastPickupAt
          const Q30 = legObj ? this.supply.pool30(legObj.pickup.placeId, g.audience.experienced, g.audience.manualLicence) : 0
          const drasticShrinkWorthRelease =
            !g.isBundledTwoOrder &&
            order.legs.length === 1 &&
            newScale < 0.62 &&
            effLpa - this.now >= 480 &&
            Q30 >= 25 &&
            g.feeCents - Math.round(newRef * 0.95) >= 3500
          if (needsNewCharge || drasticShrinkWorthRelease) {
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

    const missingSelf = this.unscheduledLegsForOrder(order)
    if (missingSelf.length > 0) {
      this.dispatchOrderLegs(order, missingSelf, false)
    }
    for (const pid of partnerOrders) {
      const po = this.orders.get(pid)
      if (!po) continue
      const missingPartner = this.unscheduledLegsForOrder(po)
      if (missingPartner.length > 0) {
        this.dispatchOrderLegs(po, missingPartner, false)
      }
    }
  }

  private handleOrderCancelled(
    orderId: string,
    cancelledGigs: ReadonlyArray<{ gigId: string; outcome: "withdrawn" | "released" | "shortened" | "continues" }>,
  ): void {
    if (this.orders.delete(orderId) && this.wonOrdersTotal > 0) {
      this.wonOrdersTotal--
    }
    this.legGigs.delete(orderId)
    this.urgent.delete(orderId)
    this.pairingBufferUntil.delete(orderId)
    const cReq = this.requests.get(orderId)
    if (cReq?.batchId) this.batches.get(cReq.batchId)?.wonIds.delete(orderId)

    const displaced = this.outbox.removePostsForOrder(orderId)
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
        g.isBundledTwoOrder = hasMultipleOrdersInStops(g.stops)
      }
    }

    for (const pid of toRedispatch) {
      const po = this.orders.get(pid)
      if (!po) continue
      const missing = this.unscheduledLegsForOrder(po, true)
      if (missing.length > 0) this.dispatchOrderLegs(po, missing, false)
    }
  }

  private handleGigBooked(gigId: string, driverId: string, feeCents: number, at: number): void {
    const g = this.gigs.get(gigId)
    if (g && g.status === "booked" && g.driverId === driverId) {
      g.feeCents = feeCents
      if (g.bookedAt === null) g.bookedAt = at
      return
    }
    this.offers.recordBooked(driverId, gigId, at)
    if (g) {
      const hadPendingWithdraw = this.outbox.removeWithdrawForGig(gigId)
      g.status = "booked"
      g.driverId = driverId
      g.feeCents = feeCents
      g.bookedAt = at
      this.linkGig(g)

      if (hadPendingWithdraw) {
        const bookedOrderIds = new Set(g.stops.map((s) => s.orderId))
        const orphanedOrders = this.outbox.removePostsOverlappingOrders(bookedOrderIds)
        for (const oid of orphanedOrders) {
          this.doNotBundle.add(oid)
          const o = this.orders.get(oid)
          if (!o) continue
          const missing = this.unscheduledLegsForOrder(o)
          if (missing.length > 0) this.dispatchOrderLegs(o, missing, false)
        }
      }
    }

    this.queueDirectOffersForOpenGigs(1, this.isFinal)
  }

  private handleGigDroppedOrNoShow(gigId: string, isDrop: boolean): void {
    const g = this.gigs.get(gigId)
    if (!g) return

    if (isDrop && !this.fluUsedThisWeek && dayOf(this.now) < 5) {
      const tod = this.now % DAY
      const p0 = g.stops[0]
      const o0 = p0 ? this.orders.get(p0.orderId) : undefined
      const pickPlace = p0 && o0 ? o0.legs[p0.leg]?.pickup.placeId : undefined
      if (
        tod < 90 &&
        g.bookedAt !== null &&
        this.now - g.bookedAt >= 120 &&
        (!pickPlace || !this.snow.hasActiveSnow(pickPlace, this.now))
      ) {
        this.recordMidnightFluDrop()
      }
    }

    g.status = "open"
    g.driverId = null
    this.offers.clearGig(gigId)

    if (g.isBundledTwoOrder) {
      const bOrders = this.distinctLiveOrdersOfStops(g.stops)
      const minBundleLpa =
        bOrders.length > 0
          ? Math.min(...bOrders.map((o) => this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt))
          : -Infinity
      const { totalRoadMinutes: totalBundleRoad, maxDeadheadMinutes: maxBundleDh } =
        this.measureStopsRoadStats(g.stops)
      const dropTod = this.now % DAY
      if (
        bOrders.length >= 2 &&
        maxBundleDh <= 65 &&
        (dropTod < 90 || dropTod >= 21 * HOUR || totalBundleRoad <= 430) &&
        totalBundleRoad <= 675 &&
        minBundleLpa - this.now >= 320 &&
        bOrders.every((o) => !this.urgent.has(o.id))
      ) {
        const dayStart = dayStartOf(this.now)
        const bumped = bumpScheduleAfterDrop(g.schedule, this.now)
        g.schedule = bumped
        if (dropTod < 7 * HOUR) {
          g.splitAt = Math.min(minBundleLpa - 210, Math.max(this.now + 115, dayStart + 9 * HOUR + 15))
          g.nextOfferCheckAt = dayStart + 7 * HOUR + 10
        } else if (dropTod >= 21 * HOUR && dayOf(minBundleLpa) > dayOf(this.now)) {
          g.splitAt = Math.min(minBundleLpa - 230, Math.max(this.now + 115, dayStart + DAY + 9 * HOUR + 15))
          g.nextOfferCheckAt = dayStart + DAY + 7 * HOUR + 10
        } else {
          g.splitAt = Math.min(this.now + 115, minBundleLpa - 230)
          g.nextOfferCheckAt = this.now + 10
        }
        g.offerWave++
        this.outbox.push({ type: "reprice", gigId: g.id, schedule: bumped })
        return
      }
      this.splitOpenBundle(g)
      return
    }

    const order = g.stops[0] ? this.orders.get(g.stops[0].orderId) : undefined
    if (!order) return

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
          const missing = this.unscheduledLegsForOrder(bo)
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
      const slot = openingSlotForDay(realPickHours, dayOf(pickupAt))
      const tod = pickupAt % DAY
      if (!slot || tod < slot.opens || tod >= slot.closes) {
        violatesRealPickupClose = true
      }
    }

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

    if (
      violatesRealPickupClose ||
      (missesDelivery && ((order.lastPickupAt - this.now >= 65 && Q30 >= 15) || (effLpa - this.now >= 95 && Q30 >= 4)))
    ) {
      g.status = "withdrawn"
      this.unlinkGig(gigId)
      this.urgent.add(order.id)
      this.doNotBundle.add(order.id)
      this.outbox.push({ type: "release", gigId })
      const missing = this.unscheduledLegsForOrder(order)
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
      const missing = this.unscheduledLegsForOrder(order)
      const effLpa = this.effectiveLastPickupByOrder.get(order.id) ?? order.lastPickupAt
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

  private handleOfferAnswered(
    gigId: string,
    driverId: string,
    answer: "accepted" | "declined" | "expired",
  ): void {
    const offeredFee = this.offers.openOffersByGig.get(gigId)?.get(driverId)
    this.offers.recordOfferAnswered(gigId, driverId, answer)
    const g = this.gigs.get(gigId)
    if (!g) return
    if (answer === "accepted") {
      this.handleGigBooked(gigId, driverId, offeredFee ?? g.feeCents, this.now)
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
      if (this.outbox.hasPendingPostForLeg(orderId, leg)) {
        if (this.outbox.hasStalePendingReleasePost(orderId, leg, this.now + 15)) {
          this.handleOrderChanged(order)
        }
        return
      }
      const missing = this.unscheduledLegsForOrder(order, true)
      if (missing.length > 0) this.dispatchOrderLegs(order, missing, true)
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
    reason: VisitFailedEvent["reason"],
  ): void {
    const order = this.orders.get(orderId)
    if (!order) return
    if (this.legGigs.get(orderId)?.get(leg) === gigId) {
      this.legGigs.get(orderId)?.delete(leg)
    }
    this.doNotBundle.add(orderId)

    const g = this.gigs.get(gigId)
    if (g) {
      g.stops = g.stops.filter((s) => !(s.orderId === orderId && s.leg === leg))
      g.isBundledTwoOrder = hasMultipleOrdersInStops(g.stops)
      if (!this.hasRemainingUndeliveredPickups(g.stops)) {
        g.status = "done"
        this.unlinkGig(gigId)
      }
    }

    this.applyVisitFailedRetry(orderId, leg, reason, this.now, order)

    const missing = this.unscheduledLegsForOrder(order, true)
    if (missing.length > 0) this.dispatchOrderLegs(order, missing, false)
  }

  private handleDelivered(gigId: string, orderId: string, leg: number, placeId: string, at: number): void {
    const g = this.gigs.get(gigId)
    this.offers.recordDelivered(g?.driverId ?? null, placeId, at)
    if (this.legGigs.get(orderId)?.get(leg) === gigId) {
      this.legGigs.get(orderId)?.delete(leg)
    }
    this.needsImmediateOfferPass = true

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

    if (g && !this.hasRemainingUndeliveredPickups(g.stops)) {
      g.status = "done"
      this.unlinkGig(gigId)
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

    for (const act of this.outbox.actions) {
      if (act.type === "post" && act.stops.some((s) => s.orderId === order.id)) {
        const meta = this.outbox.getPostMeta(act)
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
        const isEndWorldRescue = isPastDl && this.endsAt - this.now <= 42 * HOUR
        if (
          g.urgentEscalated &&
          g.urgentEscalatedAt !== null &&
          this.now - g.urgentEscalatedAt <= 6 * HOUR &&
          !(isPastDl && !g.pastDeadlineEscalated) &&
          !(isEndWorldRescue && !g.endWorldRescueEscalated)
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
        g.endWorldRescueEscalated = isEndWorldRescue
        g.offerWave++
        this.outbox.push({ type: "reprice", gigId: g.id, schedule: sched })
        this.queueOffersForSingleGig(g, 3)
      }
    }
  }

  // --- Dispatch & Bundling ---

  private splitOpenBundle(g: GigState): void {
    if (g.status !== "open" || !g.isBundledTwoOrder) return
    const ordersInBundle = this.distinctLiveOrdersOfStops(g.stops)
    g.status = "withdrawn"
    this.unlinkGig(g.id)
    this.outbox.push({ type: "withdraw", gigId: g.id })

    if (
      ordersInBundle.length >= 3 &&
      ordersInBundle.every(
        (o) => !this.urgent.has(o.id) && (this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt) - this.now >= 280,
      )
    ) {
      const third = ordersInBundle[ordersInBundle.length - 1]!
      this.doNotBundle.add(third.id)
      const o0 = ordersInBundle[0]!
      const o1 = ordersInBundle[1]!
      const m0 = this.unscheduledLegsForOrder(o0)
      if (m0.length > 0) this.dispatchOrderLegs(o0, m0, false)
      const m1 = this.unscheduledLegsForOrder(o1)
      if (m1.length > 0) {
        this.pairingBufferUntil.set(o0.id, this.now + 5)
        this.outbox.removePostsForOrder(o0.id)
        this.dispatchOrderLegs(o1, m1, true)
        if (this.pairingBufferUntil.has(o0.id)) {
          this.pairingBufferUntil.delete(o0.id)
          this.dispatchOrderLegs(o0, m0, false)
        }
      }
      for (let idx = 2; idx < ordersInBundle.length; idx++) {
        const oi = ordersInBundle[idx]!
        this.doNotBundle.add(oi.id)
        const mi = this.unscheduledLegsForOrder(oi)
        if (mi.length > 0) this.dispatchOrderLegs(oi, mi, false)
      }
      return
    }

    for (const o of ordersInBundle) {
      this.doNotBundle.add(o.id)
      const missing = this.unscheduledLegsForOrder(o)
      if (missing.length > 0) this.dispatchOrderLegs(o, missing, false)
    }
  }

  private computeRetryFrom(order: Order, request: PriceRequest, leg: number, now: number): number {
    const promised = request.options.find((o) => o.kind === order.option)?.deadline ?? order.deadline
    const delay = Math.max(0, order.deadline - promised)
    return Math.max(now + 90, order.legs[leg]!.pickup.window.from + delay)
  }

  private changedKmScaleForOrder(order: Order, req: PriceRequest, legIndices: readonly number[]): number {
    const legEstRef = (p: string, d: string): number => {
      const km = this.map.roadKm(p, d)
      return this.map.isSameCluster30(p, d) ? 1450 + 7.5 * km : 1850 + 24 * km
    }
    const routeKm = legIndices.reduce(
      (sum, i) => sum + this.map.roadKm(order.legs[i]!.pickup.placeId, order.legs[i]!.delivery.placeId),
      0,
    )
    const origKm = legIndices.reduce(
      (sum, i) => sum + this.map.roadKm(req.legs[i]!.pickup.placeId, req.legs[i]!.delivery.placeId),
      0,
    )
    const newEst = legIndices.reduce(
      (sum, i) => sum + legEstRef(order.legs[i]!.pickup.placeId, order.legs[i]!.delivery.placeId),
      0,
    )
    const origEst = legIndices.reduce(
      (sum, i) => sum + legEstRef(req.legs[i]!.pickup.placeId, req.legs[i]!.delivery.placeId),
      0,
    )
    if (Math.abs(routeKm - origKm) <= 5 && Math.abs(newEst - origEst) <= 80) return 1.0

    const rawRatio = newEst / Math.max(1200, origEst)
    const baseOrigRef = (req.referenceFeeCents * legIndices.length) / Math.max(1, order.legs.length)
    const hasExtraCarCost = legIndices.some(
      (i) =>
        order.legs[i]!.car.premium ||
        this.map.needsCharging(order.legs[i]!.car, order.legs[i]!.pickup.placeId, order.legs[i]!.delivery.placeId),
    )
    if (Math.abs(routeKm - origKm) > 150 && !hasExtraCarCost && baseOrigRef > 0) {
      const targetRef = 0.65 * (baseOrigRef * rawRatio) + 0.35 * newEst
      return Math.min(8.5, Math.max(0.45, targetRef / baseOrigRef))
    }
    return Math.min(8.5, Math.max(0.45, rawRatio))
  }

  private evaluateOrderUrgency(
    order: Order,
    pickupPlaceId: string,
    audience: Audience,
    effectiveLastPickupAt: number,
  ): { highTrust: boolean; isPastDeadline: boolean; isUrgent: boolean } {
    const dealer = this.pricing.estimator.getDealer(order.dealerId)
    const highTrust = this.level === 8 && dealer.trust >= 6
    const q30 = this.supply.pool30(pickupPlaceId, audience.experienced, audience.manualLicence)
    const isPastDeadline = this.now > order.deadline
    const isUrgent =
      isPastDeadline ||
      this.urgent.has(order.id) ||
      effectiveLastPickupAt - this.now <= (highTrust || q30 <= 12 ? 185 : 155)
    return { highTrust, isPastDeadline, isUrgent }
  }

  private urgentWarnLeadMinutes(order: Order, firstStopLeg: Leg | undefined, audience: Audience): number {
    const dealer = this.pricing.estimator.getDealer(order.dealerId)
    const q30 = firstStopLeg
      ? this.supply.pool30(firstStopLeg.pickup.placeId, audience.experienced, audience.manualLicence)
      : 0
    return (this.level === 8 && dealer.trust >= 8) || q30 <= 12 ? 180 : 145
  }

  private isZombieCandidate(g: GigState, ord: Order): boolean {
    if (g.zombieCleared || !g.stops[0]) return false
    const firstStopLeg = ord.legs[g.stops[0].leg]
    if (firstStopLeg?.pickup.privateAddress) return false
    const minRoad = firstStopLeg
      ? this.map.roadMinutes(firstStopLeg.pickup.placeId, ord.legs[ord.legs.length - 1]!.delivery.placeId)
      : 0
    return g.postedAt <= ord.lastPickupAt && g.postedAt + minRoad <= ord.deadline
  }

  private computeSingleSchedule(
    order: Order,
    legIndices: readonly number[],
    built?: BuiltOrderStops,
  ): FeeStep[] {
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
    const { highTrust, isPastDeadline, isUrgent } = this.evaluateOrderUrgency(
      order,
      firstLeg.pickup.placeId,
      b.audience,
      b.effectiveLastPickupAt,
    )
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
      tier24PickupCapAt: b.tier24PickupCapAt,
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

  private tryExtendOpenBundleToThree(targetEntry: BundleOrderEntry): boolean {
    const orderId = targetEntry.order.id
    for (const g of this.gigs.values()) {
      if (g.status !== "open" || !g.isBundledTwoOrder || g.stops.length !== 4) continue
      if (this.now - g.postedAt > 85) continue
      const o1 = this.orders.get(g.stops[0]!.orderId)
      const o2 = this.orders.get(g.stops[2]!.orderId)
      if (!o1 || !o2 || o1.id === orderId || o2.id === orderId) continue
      if (this.urgent.has(o1.id) || this.urgent.has(o2.id) || this.doNotBundle.has(o1.id) || this.doNotBundle.has(o2.id)) {
        continue
      }
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
        this.pairingBufferUntil.delete(orderId)
        g.status = "withdrawn"
        this.unlinkGig(g.id)
        this.outbox.push({ type: "withdraw", gigId: g.id })
        this.outbox.enqueuePost(ext.stops, ext.audience, ext.schedule, {
          isBundledTwoOrder: true,
          splitAt: ext.splitAt,
          urgentEscalated: false,
          pastDeadlineEscalated: false,
          endWorldRescueEscalated: false,
          strippedFallback: false,
        })
        return true
      }
    }
    return false
  }

  private collectTwoOrderBundleCandidates(excludeOrderId: string): {
    openCandidates: BundleOrderEntry[]
    candidateGigByOrder: Map<string, GigState>
  } {
    const openCandidates: BundleOrderEntry[] = []
    const candidateGigByOrder = new Map<string, GigState>()

    const tryBuildCandidate = (candOrderId: string, fallbackWonAt: number): BundleOrderEntry | undefined => {
      const co = this.orders.get(candOrderId)
      const creq = co ? this.requests.get(co.id) : undefined
      if (!co || !creq || co.legs.length !== 1 || co.deliveredAt[0] !== null) return undefined
      if (this.urgent.has(co.id) || this.doNotBundle.has(co.id)) return undefined
      const cnotes = this.getNotes(co.id)
      const cretries = this.retries.get(co.id) ?? new Map<number, RetryState>()
      const cbuilt = buildStopsForOrder(this.map, this.snow, co, [0], cnotes, cretries, this.now, this.endsAt)
      if (cbuilt.awaitingPrivateSlotRollover) return undefined
      return {
        order: co,
        request: creq,
        notes: cnotes,
        built: cbuilt,
        wonAt: this.orderWonAt.get(co.id) ?? fallbackWonAt,
      }
    }

    for (const bufferedId of this.pairingBufferUntil.keys()) {
      if (bufferedId === excludeOrderId) continue
      const entry = tryBuildCandidate(bufferedId, this.now)
      if (entry) openCandidates.push(entry)
    }

    for (const g of this.gigs.values()) {
      if (g.status !== "open" || g.isBundledTwoOrder || g.stops.length !== 2) continue
      const candId = g.stops[0]!.orderId
      const entry = tryBuildCandidate(candId, g.postedAt)
      if (entry) {
        openCandidates.push(entry)
        candidateGigByOrder.set(candId, g)
      }
    }

    return { openCandidates, candidateGigByOrder }
  }

  dispatchOrderLegs(order: Order, legIndices: readonly number[], allowBundle: boolean): void {
    const req = this.requests.get(order.id)
    if (!req || legIndices.length === 0) return

    if (legIndices.length === 2) {
      const l0 = order.legs[legIndices[0]!]!
      const l1 = order.legs[legIndices[1]!]!
      const totalRoad =
        this.map.roadMinutes(l0.pickup.placeId, l0.delivery.placeId) +
        this.map.roadMinutes(l0.delivery.placeId, l1.pickup.placeId) +
        this.map.roadMinutes(l1.pickup.placeId, l1.delivery.placeId)
      if (totalRoad > MAX_MULTI_CAR_ROAD_MINUTES) {
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

      if (this.tryExtendOpenBundleToThree(targetEntry)) return

      const { openCandidates, candidateGigByOrder } = this.collectTwoOrderBundleCandidates(order.id)
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
          this.outbox.enqueuePost(bundle.stops, bundle.audience, bundle.schedule, {
            isBundledTwoOrder: true,
            splitAt: bundle.splitAt,
            urgentEscalated: false,
            pastDeadlineEscalated: false,
            endWorldRescueEscalated: false,
            strippedFallback: false,
          })
          this.needsImmediateOfferPass = true
          return
        }

        const partnerGig = candidateGigByOrder.get(partnerId)
        if (partnerGig && partnerGig.status === "open") {
          partnerGig.status = "withdrawn"
          this.unlinkGig(partnerGig.id)
          this.outbox.push({ type: "withdraw", gigId: partnerGig.id })
          this.outbox.enqueuePost(bundle.stops, bundle.audience, bundle.schedule, {
            isBundledTwoOrder: true,
            splitAt: bundle.splitAt,
            urgentEscalated: false,
            pastDeadlineEscalated: false,
            endWorldRescueEscalated: false,
            strippedFallback: false,
          })
          this.needsImmediateOfferPass = true
          return
        }
      }

      const leg0 = order.legs[0]!
      const curDay = dayOf(this.now)
      const curTod = this.now % DAY
      const curDayStart = curDay * DAY
      const summerWithUpcomingSnow = Boolean(
        notes[0]?.summerTyres &&
          this.snow.overlaps(leg0.pickup.placeId, leg0.delivery.placeId, this.now, order.deadline),
      )
      const canBufferPremium =
        !leg0.car.premium ||
        this.supply.pool30(leg0.pickup.placeId, true, built.audience.manualLicence) >= 24
      if (
        curDay < 5 &&
        curTod >= 8 * HOUR &&
        curTod <= 18 * HOUR + 5 &&
        canBufferPremium &&
        !leg0.pickup.privateAddress &&
        !leg0.delivery.privateAddress &&
        !summerWithUpcomingSnow &&
        (notes[0]?.releasedAt ?? 0) <= this.now &&
        built.effectiveLastPickupAt - this.now >= 480
      ) {
        const pickFrom = built.stops[0]?.window?.from ?? leg0.pickup.window.from
        const rawBuf =
          pickFrom >= curDayStart + DAY
            ? Math.min(75, Math.max(32, curDayStart + 18 * HOUR + 5 - this.now))
            : built.effectiveLastPickupAt - this.now >= 1100
              ? 48
              : built.effectiveLastPickupAt - this.now >= 900
                ? 34
                : 22
        const bufMins = leg0.car.premium ? Math.min(rawBuf, 22) : rawBuf
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
    const { isPastDeadline, isUrgent } = this.evaluateOrderUrgency(
      order,
      order.legs[legIndices[0]!]!.pickup.placeId,
      built.audience,
      built.effectiveLastPickupAt,
    )
    const isEndWorldRescue = isPastDeadline && this.endsAt - this.now <= 42 * HOUR
    this.outbox.enqueuePost(finalStops, built.audience, schedule, {
      isBundledTwoOrder: false,
      splitAt: Infinity,
      urgentEscalated: isUrgent,
      pastDeadlineEscalated: isPastDeadline,
      endWorldRescueEscalated: isEndWorldRescue,
      strippedFallback: useStripped,
    })
    if (isUrgent) this.needsImmediateOfferPass = true
  }

  // --- Direct Offers ---

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
    let anyUrgent = false
    let anyPastDeadline = false
    const orderIds: string[] = []

    for (const p of pickups) {
      const o = this.orders.get(p.orderId)
      const r = this.requests.get(p.orderId)
      if (!o || !r) continue
      if (!orderIds.includes(o.id)) orderIds.push(o.id)
      const kmScale = this.changedKmScaleForOrder(o, r, [p.leg])
      refSum += (r.referenceFeeCents / o.legs.length) * kmScale
      const leg = o.legs[p.leg]
      if (leg && (leg.pickup.privateAddress || leg.delivery.privateAddress)) hasPrivate = true

      const isPostLpa = this.now > o.lastPickupAt
      const lpa = isPostLpa
        ? (p.window?.to ?? this.endsAt - 45)
        : (this.effectiveLastPickupByOrder.get(o.id) ?? o.lastPickupAt)
      if (lpa < minEffLpa) minEffLpa = lpa

      if (isPostLpa) {
        const isEndWorldRescue = this.now > o.deadline && this.endsAt - this.now <= 42 * HOUR
        if (isEndWorldRescue || Boolean(leg?.delivery.privateAddress)) {
          anyUrgent = true
          if (this.now > o.deadline) anyPastDeadline = true
        }
      } else {
        if (g.urgentEscalated || this.urgent.has(o.id)) anyUrgent = true
        if (g.pastDeadlineEscalated || this.now > o.deadline) anyPastDeadline = true
      }
    }

    const { totalRoadMinutes: driveMinutes } = this.measureStopsRoadStats(g.stops)
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
    const tod = this.now % DAY
    if (tod < 7 * HOUR || tod > 22 * HOUR + 45) {
      const dayStart = dayStartOf(this.now)
      g.nextOfferCheckAt = (tod > 22 * HOUR + 45 ? dayStart + DAY : dayStart) + 7 * HOUR + 10
      return
    }
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

  // --- Timers & Periodic Maintenance ---

  tickTimers(isFinal = false): void {
    this.checkDayRollover()
    this.finalizePendingRevenue(this.now >= this.endsAt ? this.now : this.now - 1)

    for (const [bufferedId, releaseAt] of [...this.pairingBufferUntil.entries()]) {
      if (this.now >= releaseAt || this.urgent.has(bufferedId)) {
        this.pairingBufferUntil.delete(bufferedId)
        const ord = this.orders.get(bufferedId)
        if (ord) {
          const missing = this.unscheduledLegsForOrder(ord, true)
          if (missing.length > 0) {
            if (!this.urgent.has(ord.id) && !this.doNotBundle.has(ord.id)) {
              this.dispatchOrderLegsNoRebuffer(ord, missing)
            } else {
              this.dispatchOrderLegs(ord, missing, false)
            }
          }
        }
      }
    }

    for (const order of this.orders.values()) {
      if (this.pairingBufferUntil.has(order.id)) continue
      if ((this.postBackoffUntil.get(order.id) ?? 0) > this.now) continue
      const missing = this.unscheduledLegsForOrder(order, true)
      if (missing.length > 0) {
        this.dispatchOrderLegs(order, missing, false)
      }
    }

    const curTod = this.now % DAY
    const inAwakeHours = curTod >= 7 * HOUR && curTod <= 22 * HOUR + 40

    for (const g of [...this.gigs.values()]) {
      if (g.status !== "open") continue
      if (g.isBundledTwoOrder && this.now >= g.splitAt) {
        this.splitOpenBundle(g)
        continue
      }

      if (!g.isBundledTwoOrder && g.stops[0]) {
        const ord = this.orders.get(g.stops[0].orderId)
        if (!ord) continue

        const firstStopLeg = ord.legs[g.stops[0].leg]
        const ordNotes = this.getNotes(ord.id)
        if (inAwakeHours && ordNotes[0]?.summerTyres && firstStopLeg) {
          const lastOrdLeg = ord.legs[ord.legs.length - 1]!
          const driveMin = this.map.roadMinutes(firstStopLeg.pickup.placeId, lastOrdLeg.delivery.placeId)
          const activeSw = this.snow.overlaps(
            firstStopLeg.pickup.placeId,
            lastOrdLeg.delivery.placeId,
            this.now,
            this.now + driveMin + 45,
          )
          const curFrom = g.stops[0].window?.from ?? firstStopLeg.pickup.window.from
          if (activeSw && curFrom < activeSw.to && activeSw.to < ord.deadline - driveMin) {
            const legs = g.stops.filter((s) => s.kind === "pickup" && s.orderId === ord.id).map((s) => s.leg)
            g.status = "withdrawn"
            this.unlinkGig(g.id)
            this.outbox.push({ type: "withdraw", gigId: g.id })
            if (legs.length > 0) this.dispatchOrderLegs(ord, legs, false)
            continue
          }
        }

        if (this.isZombieCandidate(g, ord) && this.now > ord.lastPickupAt) {
          g.status = "withdrawn"
          g.zombieCleared = true
          this.unlinkGig(g.id)
          this.outbox.push({ type: "withdraw", gigId: g.id })
          this.omitSoftCapOrders.add(ord.id)
          this.urgent.add(ord.id)
          this.doNotBundle.add(ord.id)
          const missing = this.unscheduledLegsForOrder(ord)
          if (missing.length > 0) this.dispatchOrderLegs(ord, missing, false)
          continue
        }

        if (!g.endWorldRescueEscalated && inAwakeHours && this.now > ord.deadline && this.endsAt - this.now <= 42 * HOUR) {
          this.escalateOrderUrgent(ord)
          continue
        }
        if (!g.pastDeadlineEscalated && inAwakeHours && this.now > ord.deadline + 30) {
          this.escalateOrderUrgent(ord)
          continue
        }
        if (!g.urgentEscalated && inAwakeHours) {
          const effLpa = this.effectiveLastPickupByOrder.get(ord.id) ?? ord.lastPickupAt
          const warnLead = this.urgentWarnLeadMinutes(ord, ord.legs[g.stops[0].leg], g.audience)
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
    const dayStart = dayStartOf(this.now)
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
        if (this.isZombieCandidate(g, ord)) {
          const zombieAt = ord.lastPickupAt + 1
          if (zombieAt > this.now) next = Math.min(next, zombieAt)
        }
        if (!g.endWorldRescueEscalated) {
          const endRescueAt = clampTriggerToAwakeWindow(Math.max(ord.deadline + 31, this.endsAt - 42 * HOUR))
          if (endRescueAt > this.now) next = Math.min(next, endRescueAt)
        }
        if (!g.pastDeadlineEscalated) {
          const rescueAt = clampTriggerToAwakeWindow(ord.deadline + 31)
          if (rescueAt > this.now) next = Math.min(next, rescueAt)
        }
        if (!g.urgentEscalated) {
          const effLpa = this.effectiveLastPickupByOrder.get(ord.id) ?? ord.lastPickupAt
          const warnLead = this.urgentWarnLeadMinutes(ord, ord.legs[g.stops[0].leg], g.audience)
          const trig = clampTriggerToAwakeWindow(effLpa - warnLead)
          if (trig > this.now) next = Math.min(next, trig)
        }
      }
    }

    return Math.max(this.now + 1, next)
  }

  // --- Outbox & Phased Transmission ---

  drainOutboxSorted(): Action[] {
    return this.outbox.drainSorted()
  }

  hasPendingQuote(): boolean {
    return this.outbox.hasPendingQuote()
  }

  async sendQuotesOnly(): Promise<void> {
    await this.outbox.sendQuotesOnly(this.world, (sent, res) => this.readResults(sent, res))
  }

  async send(isFinal = false): Promise<void> {
    await this.outbox.send(this.world, isFinal, (sent, res) => this.readResults(sent, res))
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
        const meta = this.outbox.getPostMeta(action)
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
            endWorldRescueEscalated: meta?.endWorldRescueEscalated ?? false,
            zombieCleared: false,
            offerWave: 0,
            nextOfferCheckAt: immediateOffer ? this.now : this.now + 12,
          }
          this.linkGig(gig)
        } else {
          const failedOrders = this.distinctLiveOrdersOfStops(action.stops)
          const wasMultiLegSingleOrder =
            !meta?.isBundledTwoOrder &&
            failedOrders.length === 1 &&
            action.stops.filter((s) => s.kind === "pickup").length >= 2
          for (const ord of failedOrders) {
            this.doNotBundle.add(ord.id)
            const missing = this.unscheduledLegsForOrder(ord, true)
            if (wasMultiLegSingleOrder && missing.length >= 2) {
              for (const singleLeg of missing) {
                this.dispatchOrderLegs(ord, [singleLeg], false)
              }
              continue
            }
            if (meta?.strippedFallback) {
              this.postBackoffUntil.set(ord.id, this.now + 5)
              continue
            }
            if (!meta?.isBundledTwoOrder) {
              this.stripWindowsOrders.add(ord.id)
            }
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
            const coveredLegs = new Set(
              g.stops.filter((s) => s.kind === "pickup").map((s) => `${s.orderId}:${s.leg}`),
            )
            const coveredOrders = new Set(g.stops.map((s) => s.orderId))
            const orphanedPartners = this.outbox.removePostsOverlappingPickupLegs(coveredLegs, coveredOrders)
            for (const pid of orphanedPartners) {
              this.doNotBundle.add(pid)
              const po = this.orders.get(pid)
              if (!po) continue
              const missing = this.unscheduledLegsForOrder(po)
              if (missing.length > 0) this.dispatchOrderLegs(po, missing, false)
            }
          }
        }
      }
    })
  }
}
