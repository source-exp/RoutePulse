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
} from "./planner.ts"
import type { BuiltOrderStops, RetryState } from "./planner.ts"
import { PricingEngine, RosterSupplyModel } from "./market.ts"
import type { RecordedQuoteMeta } from "./market.ts"
import {
  buildSingleGigSchedule,
  DirectOfferTracker,
  findBestTwoOrderBundle,
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
  feeCents: number
  driverId: string | null
  isBundledTwoOrder: boolean
  splitAt: number
  urgentEscalated: boolean
  pastDeadlineEscalated: boolean
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

  readonly orders = new Map<string, Order>()
  readonly orderWonAt = new Map<string, number>()
  readonly effectiveLastPickupByOrder = new Map<string, number>()
  readonly retries = new Map<string, Map<number, RetryState>>()
  readonly urgent = new Set<string>()
  readonly doNotBundle = new Set<string>()
  readonly stripWindowsOrders = new Set<string>()
  readonly pairingBufferUntil = new Map<string, number>()

  readonly gigs = new Map<string, GigState>()
  readonly legGigs = new Map<string, Map<number, string>>()

  wonOrdersTotal = 0
  deliveredOrdersTotal = 0
  deliveredOnTimeTotal = 0
  readonly lateOrPenalizedOrders = new Set<string>()
  readonly pendingRevenueOrders = new Map<string, { dealerId: string; at: number }>()

  fluDayTracker = -1
  morningNonSnowDrops = 0
  fluActiveToday = false
  needsImmediateOfferPass = false

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
    this.endsAt = endsAt
    this.map = new MapGraph(rawMap)
    this.supply = new RosterSupplyModel(this.map, roster)
    this.pricing = new PricingEngine(level, this.map, this.snow, this.supply)
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

      const estStart = Math.max(
        this.now,
        pickups[0]!.window?.from ?? firstOrd.legs[pickups[0]!.leg]!.pickup.window.from,
      )
      const estFinish = estStart + roadSum + pickups.length * 25
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

  private countActiveOrdersOnDeadlineDay(deadlineDay: number): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (undeliveredLegs(o).length === 0) continue
      const notes = this.getNotes(o.id)
      const noteDl = notes[notes.length - 1]?.noteDeadline ?? notes[0]?.noteDeadline ?? null
      const effDl = noteDl !== null ? Math.min(o.deadline, noteDl) : o.deadline
      if (Math.floor(effDl / DAY) === deadlineDay) count++
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

  private hasOpenRoundTripPartner(pickupId: string, deliveryId: string): boolean {
    for (const bufferedId of this.pairingBufferUntil.keys()) {
      const o = this.orders.get(bufferedId)
      if (!o || o.legs.length !== 1) continue
      const l = o.legs[0]!
      if (l.car.premium || l.pickup.privateAddress || l.delivery.privateAddress) continue
      if (
        this.map.roadMinutes(l.delivery.placeId, pickupId) <= 50 &&
        this.map.roadMinutes(deliveryId, l.pickup.placeId) <= 120
      ) {
        return true
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
        return true
      }
    }
    return false
  }

  private finalizePendingRevenue(upToMinute: number): void {
    for (const [orderId, info] of this.pendingRevenueOrders.entries()) {
      if (info.at > upToMinute) continue
      this.pendingRevenueOrders.delete(orderId)
      const onTime = !this.lateOrPenalizedOrders.has(orderId)
      this.deliveredOrdersTotal++
      if (onTime) this.deliveredOnTimeTotal++
      this.pricing.estimator.onOrderDelivered(info.dealerId, onTime)
    }
  }

  async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    this.now = snapshot.now
    this.endsAt = snapshot.endsAt

    for (const ev of history) {
      if (ev.kind === "price_request") {
        this.requests.set(ev.request.id, ev.request)
        this.notesByOrder.set(ev.request.id, parseDealerNote(ev.request))
      } else if (ev.kind === "forecast") {
        this.snow.addForecast(ev.from, ev.to, ev.placeIds)
      } else if (ev.kind === "deadline_close") {
        this.urgent.add(ev.orderId)
      } else if (ev.kind === "order_won") {
        this.wonOrdersTotal++
        this.orderWonAt.set(ev.order.id, ev.at)
      } else if (ev.kind === "gig_viewed") {
        this.offers.recordView(ev.driverId, ev.at)
      } else if (ev.kind === "gig_booked") {
        this.offers.recordBooked(ev.driverId, ev.gigId, ev.at)
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
          this.lateOrPenalizedOrders.add(ev.line.orderId)
        } else if (ev.line.kind === "revenue" && ev.line.orderId) {
          const req = this.requests.get(ev.line.orderId)
          if (req) this.pendingRevenueOrders.set(ev.line.orderId, { dealerId: req.dealerId, at: ev.at })
        }
      }
      this.finalizePendingRevenue(ev.at - 1)
    }
    this.finalizePendingRevenue(snapshot.now)

    for (const order of snapshot.orders) {
      if (order.status !== "cancelled" && this.requests.has(order.id)) {
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
        feeCents: gig.feeCents,
        driverId: gig.driverId,
        isBundledTwoOrder: distinctOrders.size > 1,
        splitAt: gig.postedAt + 120,
        urgentEscalated: gig.stops.some((s) => this.urgent.has(s.orderId)),
        pastDeadlineEscalated: false,
        offerWave: 0,
        nextOfferCheckAt: snapshot.now + 30,
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
      case "gig_viewed":
        this.offers.recordView(event.driverId, event.at)
        break
      case "gig_booked":
        this.handleGigBooked(event.gigId, event.driverId, event.feeCents, event.at)
        break
      case "gig_started": {
        const g = this.gigs.get(event.gigId)
        if (g) {
          g.status = "working"
          g.driverId = event.driverId
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
        this.handleVisitFailed(event.orderId, event.leg, event.reason)
        break
      case "delivered":
        this.handleDelivered(event.gigId, event.orderId, event.leg, event.placeId, event.at)
        break
      case "deadline_close":
        this.handleDeadlineClose(event.orderId)
        break
      case "ledger":
        if ((event.line.kind === "late_refund" || event.line.kind === "undelivered_penalty") && event.line.orderId) {
          this.lateOrPenalizedOrders.add(event.line.orderId)
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
    const notes = parseDealerNote(request)
    this.notesByOrder.set(request.id, notes)
    if (request.respondBy <= this.now) return

    const meta = this.pricing.quoteRequest(request, notes, {
      now: this.now,
      wonOrdersTotal: this.wonOrdersTotal,
      deliveredOrdersTotal: this.deliveredOrdersTotal,
      deliveredOnTimeTotal: this.deliveredOnTimeTotal,
      unbookedOrdersCount: this.countUnbookedOrders(),
      openPickupsInCluster30: (p) => this.countOpenPickupsInCluster30(p),
      activeOrdersOnDeadlineDay: (dlDay) => this.countActiveOrdersOnDeadlineDay(dlDay),
      hasArrivingDriverSynergy: (p, d, eMin, lMin) => this.hasArrivingDriverSynergy(p, d, eMin, lMin),
      hasOpenRoundTripPartner: (p, d) => this.hasOpenRoundTripPartner(p, d),
      fluActiveToday: this.fluActiveToday,
    })

    if (!meta) return
    this.quoteMetaByReq.set(request.id, meta)
    this.outbox.push({
      type: "quote",
      requestId: request.id,
      prices: meta.prices,
    })
  }

  private handleOrderWon(order: Order, at: number): void {
    if (!this.requests.has(order.id) || this.orders.has(order.id)) return
    this.orders.set(order.id, order)
    this.orderWonAt.set(order.id, at)
    this.wonOrdersTotal++

    const meta = this.quoteMetaByReq.get(order.id)
    if (meta) {
      this.pricing.estimator.onQuoteResolved(meta, order.option)
    }

    this.dispatchOrderLegs(order, undeliveredLegs(order), true)
  }

  private handleOrderLost(requestId: string): void {
    const meta = this.quoteMetaByReq.get(requestId)
    if (meta) {
      this.pricing.estimator.onQuoteResolved(meta, null)
    }
  }

  private handleOrderChanged(order: Order): void {
    if (!this.orders.has(order.id)) return
    const prev = this.orders.get(order.id)!
    this.orders.set(order.id, order)
    this.stripWindowsOrders.delete(order.id)
    this.pairingBufferUntil.delete(order.id)

    for (let l = 0; l < order.legs.length; l++) {
      if (order.legs[l]!.pickup.window.from !== prev.legs[l]?.pickup.window.from) {
        const r = this.getLegRetry(order.id, l)
        if (r.pickupFrom > 0) this.setLegRetry(order.id, l, { ...r, pickupFrom: 0 })
      }
    }

    const displacedPartners = this.removeUnsentPostsForOrder(order.id)
    const openGigsToWithdraw = new Set<string>()
    const m = this.legGigs.get(order.id)
    if (m) {
      for (const gid of m.values()) {
        const g = this.gigs.get(gid)
        if (g && g.status === "open") openGigsToWithdraw.add(gid)
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
      this.splitOpenBundle(g)
      return
    }

    const order = g.stops[0] ? this.orders.get(g.stops[0].orderId) : undefined
    if (!order) return

    const legIndices = g.stops.filter((s) => s.kind === "pickup" && s.orderId === order.id).map((s) => s.leg)
    const newSchedule = this.computeSingleSchedule(order, legIndices)
    g.schedule = newSchedule
    g.offerWave++
    this.outbox.push({ type: "reprice", gigId: g.id, schedule: newSchedule })
    this.queueOffersForSingleGig(g, 2)
  }

  private handleDriverLate(gigId: string, pickupAt: number): void {
    const g = this.gigs.get(gigId)
    if (!g || g.status !== "booked" || g.isBundledTwoOrder) return
    const p0 = g.stops[0]
    if (!p0) return
    const order = this.orders.get(p0.orderId)
    if (!order) return

    const leg = order.legs[p0.leg]
    if (!leg) return
    const notes = this.getNotes(order.id)
    const note = notes[p0.leg]

    const realPickHours = note?.pickupHours ?? leg.pickup.hours
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

    const drive = this.map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId)
    const extra = (p0.withPlates ? PLATES_MINUTES : 0) + (p0.withCharging ? CHARGING_MINUTES : 0)
    const snowSlow = this.snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, pickupAt, pickupAt + drive * 2) ? 1.30 : 1.08
    const predArrival = pickupAt + 15 + extra + Math.ceil(drive * snowSlow)
    const effDl = Math.min(order.deadline, notes[notes.length - 1]?.noteDeadline ?? Infinity)
    const effLpa = this.effectiveLastPickupByOrder.get(order.id) ?? order.lastPickupAt
    const Q30 = this.supply.pool30(leg.pickup.placeId, g.audience.experienced, g.audience.manualLicence)

    if (violatesRealPickupClose || (predArrival > effDl && effLpa - this.now >= 95 && Q30 >= 4)) {
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
    g.status = "withdrawn"
    this.unlinkGig(gigId)
    if (!hadActiveLink) return

    for (const order of this.distinctLiveOrdersOfStops(g.stops)) {
      this.doNotBundle.add(order.id)
      const missing = undeliveredLegs(order).filter((l) => !this.legGigs.get(order.id)?.has(l))
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

    const order = this.orders.get(orderId)
    if (!order || order.deliveredAt[leg] !== null) return
    const gid = this.legGigs.get(orderId)?.get(leg)
    if (!gid) {
      this.dispatchOrderLegs(order, [leg], false)
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

  private handleVisitFailed(orderId: string, leg: number, reason: "not_ready" | "closed" | "licence" | "no_plates"): void {
    const order = this.orders.get(orderId)
    if (!order) return
    this.legGigs.get(orderId)?.delete(leg)
    this.doNotBundle.add(orderId)

    const req = this.requests.get(orderId)
    const prev = this.getLegRetry(orderId, leg)
    const carNotThere = reason === "not_ready" || reason === "closed"
    const pickupFrom = carNotThere && req ? this.computeRetryFrom(order, req, leg, this.now) : prev.pickupFrom

    this.setLegRetry(orderId, leg, {
      pickupFrom,
      manualLicence: prev.manualLicence || reason === "licence",
      plates: prev.plates || reason === "no_plates",
    })

    this.dispatchOrderLegs(order, [leg], false)
  }

  private handleDelivered(gigId: string, orderId: string, leg: number, placeId: string, at: number): void {
    const g = this.gigs.get(gigId)
    this.offers.recordDelivered(g?.driverId ?? null, placeId, at)
    this.legGigs.get(orderId)?.delete(leg)

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
        const legs = g.stops.filter((s) => s.kind === "pickup" && s.orderId === order.id).map((s) => s.leg)
        const sched = this.computeSingleSchedule(order, legs)
        g.schedule = sched
        g.urgentEscalated = true
        g.pastDeadlineEscalated = this.now > order.deadline
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

  private computeSingleSchedule(order: Order, legIndices: readonly number[], built?: BuiltOrderStops): FeeStep[] {
    const req = this.requests.get(order.id)!
    const notes = this.getNotes(order.id)
    const retriesMap = this.retries.get(order.id) ?? new Map<number, RetryState>()
    const b = built ?? buildStopsForOrder(this.map, this.snow, order, legIndices, notes, retriesMap, this.now, this.endsAt)
    this.effectiveLastPickupByOrder.set(order.id, b.effectiveLastPickupAt)

    const firstLeg = order.legs[legIndices[0]!]!
    const lastLeg = order.legs[legIndices[legIndices.length - 1]!]!
    const routeKm = legIndices.reduce(
      (sum, i) => sum + this.map.roadKm(order.legs[i]!.pickup.placeId, order.legs[i]!.delivery.placeId),
      0,
    )
    const baseRefFeeCents = (req.referenceFeeCents * legIndices.length) / order.legs.length
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
      b.effectiveLastPickupAt - this.now <= (highTrust ? 245 : 205)

    return buildSingleGigSchedule(this.map, this.supply, {
      now: this.now,
      level: this.level,
      baseRefFeeCents,
      orderPriceCents: order.priceCents,
      routeKm,
      pickupPlaceId: firstLeg.pickup.placeId,
      deliveryPlaceId: lastLeg.delivery.placeId,
      effectiveLastPickupAt: b.effectiveLastPickupAt,
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
    const built = buildStopsForOrder(this.map, this.snow, order, legIndices, notes, retriesMap, this.now, this.endsAt)
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

      // Hold high-slack standard D2D orders in a 22-minute pairing buffer so incoming partners can bundle cleanly!
      const leg0 = order.legs[0]!
      if (
        !leg0.car.premium &&
        !leg0.pickup.privateAddress &&
        !leg0.delivery.privateAddress &&
        (notes[0]?.releasedAt ?? 0) <= this.now &&
        built.effectiveLastPickupAt - this.now >= 480
      ) {
        this.pairingBufferUntil.set(order.id, this.now + 22)
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
    const isPastDeadline = this.now > order.deadline
    const isUrgent = isPastDeadline || this.urgent.has(order.id) || built.effectiveLastPickupAt - this.now <= 205
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
    this.needsImmediateOfferPass = true
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
      refSum += r.referenceFeeCents / o.legs.length
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
    g.nextOfferCheckAt = this.now + 45
  }

  private queueDirectOffersForOpenGigs(maxPerGig = 2): void {
    if (this.level < 3) return
    const tod = this.now % DAY
    if (tod < 7 * HOUR || tod > 22 * HOUR + 45) return

    const commitments = this.activeCommitments()
    for (const g of this.gigs.values()) {
      if (g.status !== "open") continue
      if (this.offers.openCount(g.id) >= 3) continue
      if (this.now < g.nextOfferCheckAt && !g.urgentEscalated && !g.pastDeadlineEscalated) continue

      const target = this.buildOfferTarget(g)
      if (!target) continue
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
      }
      g.nextOfferCheckAt = this.now + 45
    }
  }

  tickTimers(): void {
    this.checkDayRollover()
    this.finalizePendingRevenue(this.now)

    // 0. Flush expired pairing-buffer orders as solo posts
    for (const [bufferedId, releaseAt] of [...this.pairingBufferUntil.entries()]) {
      if (this.now >= releaseAt || this.urgent.has(bufferedId)) {
        this.pairingBufferUntil.delete(bufferedId)
        const ord = this.orders.get(bufferedId)
        if (ord) {
          const missing = undeliveredLegs(ord).filter(
            (leg) => !this.legGigs.get(ord.id)?.has(leg) && !this.hasPendingPostInOutbox(ord.id, leg),
          )
          if (missing.length > 0) this.dispatchOrderLegs(ord, missing, false)
        }
      }
    }

    // 1. Orphan guard: ensure every live undelivered order leg is carried by a gig, pairing buffer, or pending post
    for (const order of this.orders.values()) {
      if (this.pairingBufferUntil.has(order.id)) continue
      const missing = undeliveredLegs(order).filter(
        (leg) => !this.legGigs.get(order.id)?.has(leg) && !this.hasPendingPostInOutbox(order.id, leg),
      )
      if (missing.length > 0) {
        this.doNotBundle.add(order.id)
        this.dispatchOrderLegs(order, missing, false)
      }
    }

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
        if (!g.pastDeadlineEscalated && this.now > ord.deadline + 30) {
          this.escalateOrderUrgent(ord)
          continue
        }
        if (!g.urgentEscalated) {
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
      this.queueDirectOffersForOpenGigs(2)
    } else {
      this.queueDirectOffersForOpenGigs(1)
    }
  }

  nextTimerAt(): number {
    if (this.needsImmediateOfferPass && this.outbox.some((a) => a.type === "post")) {
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
      if (!g.isBundledTwoOrder && g.stops[0]) {
        const ord = this.orders.get(g.stops[0].orderId)
        if (!ord) continue
        if (!g.pastDeadlineEscalated) {
          const rescueAt = ord.deadline + 31
          if (rescueAt > this.now) next = Math.min(next, rescueAt)
        }
        if (!g.urgentEscalated) {
          const effLpa = this.effectiveLastPickupByOrder.get(ord.id) ?? ord.lastPickupAt
          const dealer = this.pricing.estimator.getDealer(ord.dealerId)
          const warnLead = this.level === 8 && dealer.trust >= 6 ? 240 : 195
          const trig = effLpa - warnLead
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

  async send(): Promise<void> {
    const actions = this.drainOutboxSorted()
    if (actions.length > 0) {
      const results = await this.world.act(actions)
      this.readResults(actions, results)
    }
  }

  readResults(actions: readonly Action[], results: readonly ActionResult[]): void {
    actions.forEach((action, i) => {
      const res = results[i]
      if (!res) return
      if (action.type === "post") {
        const meta = this.pendingPostMeta.get(action)
        if (res.ok) {
          const gig: GigState = {
            id: res.id,
            stops: action.stops,
            audience: action.audience,
            schedule: action.schedule,
            status: "open",
            postedAt: this.now,
            bookedAt: null,
            feeCents: action.schedule[0]?.feeCents ?? 0,
            driverId: null,
            isBundledTwoOrder: meta?.isBundledTwoOrder ?? false,
            splitAt: meta?.splitAt ?? Infinity,
            urgentEscalated: meta?.urgentEscalated ?? false,
            pastDeadlineEscalated: meta?.pastDeadlineEscalated ?? false,
            offerWave: 0,
            nextOfferCheckAt: this.now,
          }
          this.linkGig(gig)
        } else {
          // Fallback if a bundled or custom-window post was ever refused by the server:
          // never leave any won order orphaned without a gig!
          const failedOrders = this.distinctLiveOrdersOfStops(action.stops)
          for (const ord of failedOrders) {
            this.doNotBundle.add(ord.id)
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
          this.offers.rollbackOfferRefused(action.gigId, action.driverId, this.now)
        }
      } else if (action.type === "withdraw") {
        if (!res.ok) {
          const g = this.gigs.get(action.gigId)
          if (g && res.reason.toLowerCase().includes("book")) {
            g.status = "booked"
            this.linkGig(g)
          }
        }
      }
    })
  }
}

async function playPractice(world: World, level: number): Promise<void> {
  const [{ now, endsAt }, rawMap, roster] = await Promise.all([
    world.snapshot(),
    world.client.map(),
    world.roster(),
  ])
  const desk = new Desk(world, level, now, endsAt, rawMap, roster)

  while (desk.now < endsAt) {
    const day = Math.floor(desk.now / DAY)
    const midnight = (day + 1) * DAY
    const stopAt = Math.min(endsAt, midnight, desk.nextTimerAt())
    const actions = desk.drainOutboxSorted()
    const step = await world.advance({ untilEvent: WAKE_ON, max: stopAt, actions })
    desk.readResults(actions, step.results)
    desk.now = step.now
    for (const event of step.events) desk.handle(event)
    desk.tickTimers()
    if (Math.floor(desk.now / DAY) > day) {
      report(WEEKDAYS[day % 7]!, await world.score())
    }
  }
  await desk.send()
}

async function playFinal(world: World): Promise<void> {
  const snapshot = await world.snapshot()
  if (snapshot.now >= snapshot.endsAt) return
  const [history, worlds, rawMap, roster] = await Promise.all([
    world.events(),
    world.client.worlds(),
    world.client.map(),
    world.roster(),
  ])
  const level = worlds.find((summary) => summary.worldId === world.id)?.level ?? 8
  const desk = new Desk(world, level, snapshot.now, snapshot.endsAt, rawMap, roster)
  await desk.rejoin(snapshot, history)
  desk.tickTimers()
  await desk.send()
  if (desk.needsImmediateOfferPass || desk.outbox.length > 0) {
    desk.tickTimers()
    await desk.send()
  }

  let lastRosterFetchMs = performance.now()

  for await (const event of world.stream({ after: history.at(-1)?.seq ?? -1, idleMs: 800 })) {
    const day = Math.floor(desk.now / DAY)
    if (event === null) {
      const f = await world.client.final()
      desk.now = Math.max(desk.now, f.now)
    } else {
      desk.handle(event)
    }
    desk.tickTimers()
    await desk.send()
    if (desk.outbox.length === 0) {
      desk.queueDirectOffersForOpenGigs(2)
      if (desk.outbox.length > 0) await desk.send()
    }

    if (performance.now() - lastRosterFetchMs > 45_000) {
      lastRosterFetchMs = performance.now()
      const freshRoster = await world.roster().catch(() => null)
      if (freshRoster) desk.supply.updateRoster(freshRoster)
    }

    if (Math.floor(desk.now / DAY) > day) {
      report(WEEKDAYS[day % 7]!, await world.score())
    }
    if (desk.now >= snapshot.endsAt) return
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
  } else {
    const run = await client.create(level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, { seed: args.seed, board: args.board })
    world = run
    const name = `${args.board ? "Ranking run" : "Practice world"} ${run.id}`
    const afterStop = (deleted: boolean) =>
      args.board
        ? `${name} plays to its end without your system, and counts.`
        : deleted
          ? `${name} is deleted.`
          : `${name} is not deleted: it holds one of your eight practice slots.`
    console.log(
      `${name}, level ${level}. ${args.board ? "Ctrl-C or an error stops your system: the run then plays to its end without it, and counts." : "Ctrl-C or an error stops the run and deletes the world."}`,
    )
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
