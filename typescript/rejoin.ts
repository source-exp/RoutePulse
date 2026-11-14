import { computeTwoOrderBundleSplitAt } from "./bundling.ts"
import type { Desk, GigState } from "./desk.ts"
import { parseDealerNote, reconcileNotesAfterOrderChange } from "./notes.ts"
import { buildStopsForOrder } from "./planner.ts"
import { DAY, dayOf, HOUR } from "./time.ts"
import type { DeskEvent, DeskSnapshot, Order } from "./types.ts"

export function rejoinDeskState(desk: Desk, snapshot: DeskSnapshot, history: DeskEvent[]): void {
  desk.now = snapshot.now
  desk.endsAt = snapshot.endsAt

  const openReqIds = new Set(snapshot.openRequests.map((r) => r.id))
  let firstOurActivityAt = Infinity
  for (const o of snapshot.orders) {
    firstOurActivityAt = Math.min(firstOurActivityAt, o.legs[0]?.pickup.window.from ?? Infinity)
  }
  for (const g of snapshot.gigs) {
    firstOurActivityAt = Math.min(firstOurActivityAt, g.postedAt)
  }
  for (const ev of history) {
    if (ev.kind === "order_won" || ev.kind === "gig_booked" || ev.kind === "offer_answered") {
      firstOurActivityAt = Math.min(firstOurActivityAt, ev.at)
    }
  }
  const hadPriorParticipation = Number.isFinite(firstOurActivityAt)
  desk.startMinute = hadPriorParticipation ? Math.min(firstOurActivityAt, history[0]?.at ?? snapshot.now) : snapshot.now

  const gigDriverById = new Map<string, string>()
  for (const g of snapshot.gigs) {
    if (g.driverId) gigDriverById.set(g.id, g.driverId)
  }
  const histOrders = new Map<string, Order>()

  for (const ev of history) {
    desk.now = Math.max(desk.now, ev.at)
    desk.checkDayRollover()
    desk.finalizePendingRevenue(ev.at - 1)

    if (ev.kind === "price_request") {
      desk.requests.set(ev.request.id, ev.request)
      const notes = parseDealerNote(ev.request)
      desk.notesByOrder.set(ev.request.id, notes)
      desk.recordBatchArrival(ev.request)
      if (!openReqIds.has(ev.request.id) && hadPriorParticipation && ev.request.respondBy >= firstOurActivityAt) {
        const meta = desk.pricing.quoteRequest(ev.request, notes, {
          now: ev.at,
          startMinute: desk.startMinute,
          wonOrdersTotal: desk.wonOrdersTotal,
          deliveredOrdersTotal: desk.deliveredOrdersTotal,
          deliveredOnTimeTotal: desk.deliveredOnTimeTotal,
          unbookedOrdersCount: 10,
          openPickupsInCluster30: () => 0,
          activeOrdersOnDeadlineDay: () => 35,
          hasArrivingDriverSynergy: () => false,
          roundTripPartnerCredit: () => 0,
          fluActiveToday: desk.fluActiveToday,
        })
        if (meta) desk.quoteMetaByReq.set(ev.request.id, meta)
      } else if (!openReqIds.has(ev.request.id)) {
        desk.pricing.estimator.getDealer(ev.request.dealerId).unquotedCount++
      }
    } else if (ev.kind === "forecast") {
      desk.snow.addForecast(ev.from, ev.to, ev.placeIds)
    } else if (ev.kind === "deadline_close") {
      desk.urgent.add(ev.orderId)
    } else if (ev.kind === "order_won") {
      desk.wonOrdersTotal++
      desk.orderWonAt.set(ev.order.id, ev.at)
      histOrders.set(ev.order.id, ev.order)
      const req = desk.requests.get(ev.order.id)
      if (req?.batchId) desk.batches.get(req.batchId)?.wonIds.add(ev.order.id)
      const meta = desk.quoteMetaByReq.get(ev.order.id)
      if (meta) desk.pricing.estimator.onQuoteResolved(meta, ev.order.option)
    } else if (ev.kind === "order_lost") {
      const req = desk.requests.get(ev.requestId)
      if (req?.batchId) desk.batches.get(req.batchId)?.lostIds.add(ev.requestId)
      const meta = desk.quoteMetaByReq.get(ev.requestId)
      if (meta) desk.pricing.estimator.onQuoteResolved(meta, null)
    } else if (ev.kind === "order_cancelled") {
      if (desk.wonOrdersTotal > 0) desk.wonOrdersTotal--
      histOrders.delete(ev.orderId)
      const req = desk.requests.get(ev.orderId)
      if (req?.batchId) desk.batches.get(req.batchId)?.wonIds.delete(ev.orderId)
    } else if (ev.kind === "order_changed") {
      const prev = histOrders.get(ev.order.id)
      histOrders.set(ev.order.id, ev.order)
      reconcileNotesAfterOrderChange(prev, ev.order, desk.getNotes(ev.order.id))
    } else if (ev.kind === "gig_viewed") {
      desk.offers.recordView(ev.driverId, ev.at, ev.gigId)
    } else if (ev.kind === "gig_booked") {
      gigDriverById.set(ev.gigId, ev.driverId)
      desk.offers.recordBooked(ev.driverId, ev.gigId, ev.at)
    } else if (ev.kind === "gig_started") {
      gigDriverById.set(ev.gigId, ev.driverId)
    } else if (ev.kind === "delivered") {
      desk.offers.recordDelivered(gigDriverById.get(ev.gigId) ?? null, ev.placeId, ev.at)
    } else if (ev.kind === "offer_answered") {
      if (ev.answer === "accepted") gigDriverById.set(ev.gigId, ev.driverId)
      const dayKey = `${dayOf(Math.max(0, ev.at - 1))}:${ev.driverId}`
      desk.offers.offersSentByDay.set(dayKey, (desk.offers.offersSentByDay.get(dayKey) ?? 0) + 1)
      desk.offers.attemptedGigDrivers.add(`${ev.gigId}:${ev.driverId}`)
    } else if (ev.kind === "gig_dropped") {
      if (!desk.fluUsedThisWeek && dayOf(ev.at) < 5 && ev.at % DAY < 90) {
        desk.recordMidnightFluDrop()
      }
    } else if (ev.kind === "release") {
      const notes = desk.getNotes(ev.orderId)
      if (notes[ev.leg]) notes[ev.leg]!.releasedAt = ev.at
      const cur = desk.getLegRetry(ev.orderId, ev.leg)
      desk.setLegRetry(ev.orderId, ev.leg, { ...cur, pickupFrom: 0 })
    } else if (ev.kind === "visit_failed") {
      const ord = snapshot.orders.find((o) => o.id === ev.orderId)
      desk.applyVisitFailedRetry(ev.orderId, ev.leg, ev.reason, ev.at, ord)
    } else if (ev.kind === "ledger") {
      if ((ev.line.kind === "late_refund" || ev.line.kind === "undelivered_penalty") && ev.line.orderId) {
        desk.markLateOrPenalized(ev.line.orderId)
      } else if (ev.line.kind === "revenue" && ev.line.orderId) {
        const req = desk.requests.get(ev.line.orderId)
        if (req) desk.pendingRevenueOrders.set(ev.line.orderId, { dealerId: req.dealerId, at: ev.at })
      }
    }
  }
  desk.now = snapshot.now
  desk.finalizePendingRevenue(snapshot.now - 1)

  for (const order of snapshot.orders) {
    if (order.status === "cancelled") continue
    desk.orders.set(order.id, order)
    if (!desk.orderWonAt.has(order.id)) desk.orderWonAt.set(order.id, snapshot.now)
    const undel: number[] = []
    for (let i = 0; i < order.legs.length; i++) {
      if (order.deliveredAt[i] === null) undel.push(i)
    }
    if (undel.length > 0) {
      const b = buildStopsForOrder(
        desk.map,
        desk.snow,
        order,
        undel,
        desk.getNotes(order.id),
        desk.retries.get(order.id) ?? new Map(),
        snapshot.now,
        snapshot.endsAt,
        snapshot.now > order.lastPickupAt,
      )
      desk.effectiveLastPickupByOrder.set(order.id, b.effectiveLastPickupAt)
    }
  }

  for (const gig of snapshot.gigs) {
    const distinctOrders = [...new Set(gig.stops.map((s) => s.orderId))]
    const isBundle = distinctOrders.length > 1
    let splitAt = gig.postedAt + 125
    if (isBundle) {
      const minLpa = Math.min(
        ...distinctOrders.map((oid) => {
          const o = desk.orders.get(oid)
          return o ? (desk.effectiveLastPickupByOrder.get(oid) ?? o.lastPickupAt) : Infinity
        }),
      )
      splitAt = computeTwoOrderBundleSplitAt(gig.postedAt, minLpa)
    }
    const p0Ord = gig.stops[0] ? desk.orders.get(gig.stops[0].orderId) : undefined
    const anyUrgent = gig.stops.some((s) => desk.urgent.has(s.orderId))
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
      isBundledTwoOrder: isBundle,
      splitAt,
      urgentEscalated: anyUrgent,
      urgentEscalatedAt: anyUrgent ? snapshot.now : null,
      pastDeadlineEscalated: Boolean(p0Ord && gig.postedAt > p0Ord.deadline),
      endWorldRescueEscalated: Boolean(p0Ord && gig.postedAt > p0Ord.deadline && snapshot.endsAt - gig.postedAt <= 42 * HOUR),
      zombieCleared: p0Ord ? gig.postedAt > p0Ord.lastPickupAt : false,
      offerWave: 0,
      nextOfferCheckAt: snapshot.now + 12,
    }
    if (gig.status === "open" || gig.status === "booked" || gig.status === "working") {
      desk.linkGig(state)
    } else {
      desk.gigs.set(gig.id, state)
    }
  }

  for (const order of desk.orders.values()) {
    const missing = desk.unscheduledLegsForOrder(order)
    if (missing.length > 0) {
      desk.dispatchOrderLegs(order, missing, false)
    }
  }

  for (const req of snapshot.openRequests) {
    if (req.respondBy > snapshot.now) {
      desk.handlePriceRequest(req)
    }
  }
  desk.flushPendingPriceRequests()
}
