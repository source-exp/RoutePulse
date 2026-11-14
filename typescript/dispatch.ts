import { CHARGING_MINUTES, DAY, HOUR, PLATES_MINUTES, visitAt } from "./planner.ts"
import type { BuiltOrderStops, MapGraph, SnowTracker } from "./planner.ts"
import type { RosterSupplyModel } from "./market.ts"
import type { ParsedLegNote } from "./notes.ts"
import type { Audience, DriverProfile, FeeStep, OfferAction, Order, PriceRequest, StopRef } from "./types.ts"

export type SingleScheduleContext = {
  now: number
  level: number
  baseRefFeeCents: number
  orderPriceCents: number
  routeKm: number
  pickupPlaceId: string
  deliveryPlaceId: string
  effectiveLastPickupAt: number
  earliestPickupAt: number
  audience: Audience
  hasPrivatePickup: boolean
  hasPrivateDelivery: boolean
  isTradeInTwoLegs: boolean
  withCharging: boolean
  withPlates: boolean
  snowOverlap: boolean
  fluActive: boolean
  urgent: boolean
  isPastDeadline: boolean
  highTrustDealer: boolean
}

function normalizeSteps(steps: FeeStep[], now: number): FeeStep[] {
  const sorted = [...steps]
    .map((s) => ({ at: Math.max(now, Math.round(s.at)), feeCents: Math.max(1, Math.round(s.feeCents)) }))
    .sort((a, b) => a.at - b.at)

  const deduped: FeeStep[] = []
  for (const step of sorted) {
    const prev = deduped[deduped.length - 1]
    const monoFee = prev ? Math.max(prev.feeCents, step.feeCents) : step.feeCents
    if (prev && prev.at === step.at) {
      prev.feeCents = monoFee
    } else {
      deduped.push({ at: step.at, feeCents: monoFee })
    }
  }
  return deduped.slice(0, 48)
}

export function buildSingleGigSchedule(
  map: MapGraph,
  supply: RosterSupplyModel,
  ctx: SingleScheduleContext,
): FeeStep[] {
  const Q30 = supply.pool30(ctx.pickupPlaceId, ctx.audience.experienced, ctx.audience.manualLicence)
  const D_home = supply.homeDrivers(ctx.deliveryPlaceId)
  const sameCluster30 = map.isSameCluster30(ctx.pickupPlaceId, ctx.deliveryPlaceId)
  const isLongOrDeadEnd = ctx.routeKm > 250 || (D_home <= 12 && !sameCluster30)

  const pickDay = Math.floor(Math.max(ctx.now, ctx.earliestPickupAt) / DAY)
  const pickWd = ((pickDay % 7) + 7) % 7
  const pickTod = Math.max(ctx.now, ctx.earliestPickupAt) % DAY
  const isEveningOrSat = pickWd === 5 || pickTod >= 17 * HOUR

  const hasExtras =
    ctx.hasPrivatePickup ||
    ctx.hasPrivateDelivery ||
    ctx.isTradeInTwoLegs ||
    ctx.audience.experienced ||
    ctx.withCharging ||
    ctx.withPlates

  let m0 = 0.85
  if (D_home >= 80 && Q30 >= 40 && !hasExtras && !ctx.snowOverlap && !ctx.fluActive && ctx.routeKm <= 220) {
    m0 -= 0.04 // 0.81x on dense hub->hub where returning/local drivers abound
  }
  if (D_home <= 5 && !sameCluster30) m0 += 0.08
  else if (D_home <= 12 && !sameCluster30) m0 += 0.05

  if (Q30 === 0) m0 += 0.12
  else if (Q30 <= 5) m0 += 0.07
  else if (Q30 <= 15) m0 += 0.03

  if (ctx.routeKm > 260) m0 += 0.07
  if (ctx.routeKm > 400) m0 += 0.06
  if (ctx.hasPrivatePickup && !ctx.isTradeInTwoLegs) m0 += 0.14
  if (ctx.hasPrivateDelivery && !ctx.isTradeInTwoLegs) m0 += 0.16
  if (ctx.isTradeInTwoLegs) m0 += 0.14
  if (ctx.audience.experienced) m0 += 0.18
  if (ctx.withCharging) m0 += 0.08
  if (ctx.withPlates || ctx.audience.manualLicence) m0 += 0.04
  if (isEveningOrSat) m0 += 0.06
  if (ctx.snowOverlap) m0 += 0.12
  if (ctx.fluActive) m0 += 0.10

  m0 = Math.max(0.80, Math.min(1.32, m0))

  if (ctx.level === 1) {
    const flatMult = ctx.isPastDeadline ? 2.20 : ctx.urgent ? Math.max(1.48, m0 + 0.35) : m0
    return [{ at: ctx.now, feeCents: Math.max(1, Math.round(ctx.baseRefFeeCents * flatMult)) }]
  }

  // Rescue mode for orders already past deadline: avoid -200% undelivered penalty at all costs!
  if (ctx.isPastDeadline) {
    const rescueMults = [
      Math.max(m0 + 0.45, 1.58),
      Math.max(m0 + 0.75, 1.88),
      Math.max(m0 + 1.05, 2.22),
      Math.max(m0 + 1.40, 2.60),
      Math.max(m0 + 1.80, 3.00),
    ]
    return normalizeSteps(
      rescueMults.map((mult, k) => ({
        at: ctx.now + k * 35,
        feeCents: Math.round(ctx.baseRefFeeCents * mult),
      })),
      ctx.now,
    )
  }

  const slackMin = ctx.effectiveLastPickupAt - ctx.now
  const maxUrgentMult = ctx.highTrustDealer ? 2.55 : 2.40

  if (ctx.urgent || slackMin <= 210) {
    const stepMults = [
      Math.max(m0 + 0.30, 1.38),
      Math.max(m0 + 0.52, 1.60),
      Math.max(m0 + 0.76, 1.84),
      Math.max(m0 + 1.02, 2.12),
      Math.max(m0 + 1.26, maxUrgentMult),
    ]
    return normalizeSteps(
      stepMults.map((mult, k) => ({
        at: ctx.now + k * 25,
        feeCents: Math.round(ctx.baseRefFeeCents * mult),
      })),
      ctx.now,
    )
  }

  const lpa = ctx.effectiveLastPickupAt
  const lpaDayStart = Math.floor(lpa / DAY) * DAY
  const crossesNight = Math.floor(lpa / DAY) > Math.floor(ctx.now / DAY)

  const rampOffsets: Array<{ at: number; mult: number }> = [
    { at: ctx.now, mult: m0 },
  ]

  // On ultra-long (>400km, e.g. Oulu/Kemi) overnight hauls, step gently 9h before lastPickupAt so evening train drivers book!
  if (crossesNight && ctx.routeKm > 400) {
    const eveTrainAt = Math.max(ctx.now + 75, ctx.earliestPickupAt - 360, lpa - 540)
    if (eveTrainAt < lpaDayStart + 6 * HOUR + 20) {
      rampOffsets.push({
        at: eveTrainAt,
        mult: Math.max(m0 + 0.08, 1.04),
      })
    }
  }

  // On long-haul (>250km) or low-destination-supply routes crossing overnight, step up gently at 06:40
  // so full-day drivers claim the long trip before booking shorter morning gigs!
  if (crossesNight && isLongOrDeadEnd) {
    const morningWaveAt = Math.max(ctx.now + 90, ctx.earliestPickupAt - 60, lpaDayStart + 6 * HOUR + 40)
    if (morningWaveAt < lpa - 260) {
      rampOffsets.push({
        at: morningWaveAt,
        mult: Math.max(m0 + 0.12, 1.08),
      })
    }
  }

  const minRampStart = Math.max(
    ctx.earliestPickupAt,
    crossesNight
      ? Math.max(ctx.now + 120, lpaDayStart + (isLongOrDeadEnd ? 7 * HOUR + 45 : 8 * HOUR + 45))
      : ctx.now + 80,
  )

  const anchors: Array<{ beforeLpa: number; add: number; floor: number }> = [
    { beforeLpa: 360, add: 0.11, floor: 0.98 },
    { beforeLpa: 265, add: 0.23, floor: 1.12 },
    { beforeLpa: 185, add: 0.39, floor: 1.30 },
    { beforeLpa: 115, add: 0.60, floor: 1.56 },
    { beforeLpa: 60, add: 0.88, floor: 1.88 },
  ]

  for (const a of anchors) {
    const t = Math.max(minRampStart, lpa - a.beforeLpa)
    if (t < lpa - 15) {
      rampOffsets.push({
        at: t,
        mult: Math.min(maxUrgentMult, Math.max(m0 + a.add, a.floor)),
      })
    }
  }

  return normalizeSteps(
    rampOffsets.map((r) => ({
      at: r.at,
      feeCents: Math.round(ctx.baseRefFeeCents * r.mult),
    })),
    ctx.now,
  )
}

export type BundleOrderEntry = {
  order: Order
  request: PriceRequest
  notes: readonly ParsedLegNote[]
  built: BuiltOrderStops
  wonAt: number
}

export type BundledGigPlan = {
  firstOrderId: string
  secondOrderId: string
  stops: StopRef[]
  audience: Audience
  schedule: FeeStep[]
  tier: 1 | 2
  splitAt: number
}

function evaluateOrderedBundle(
  map: MapGraph,
  snow: SnowTracker,
  supply: RosterSupplyModel,
  a: BundleOrderEntry,
  b: BundleOrderEntry,
  now: number,
  fluActive: boolean,
): { plan: BundledGigPlan; score: number } | undefined {
  if (a.order.id === b.order.id) return undefined
  if (a.order.legs.length !== 1 || b.order.legs.length !== 1) return undefined

  const leg1 = a.order.legs[0]!
  const leg2 = b.order.legs[0]!
  const n1 = a.notes[0]
  const n2 = b.notes[0]

  if (leg1.pickup.privateAddress || leg1.delivery.privateAddress) return undefined
  if (leg2.pickup.privateAddress || leg2.delivery.privateAddress) return undefined
  if (leg1.car.premium || leg2.car.premium) return undefined
  if ((n1?.releasedAt ?? 0) > now || (n2?.releasedAt ?? 0) > now) return undefined

  const P1 = leg1.pickup.placeId
  const D1 = leg1.delivery.placeId
  const P2 = leg2.pickup.placeId
  const D2 = leg2.delivery.placeId

  if (n1?.summerTyres && snow.overlaps(P1, D1, now, a.order.deadline)) return undefined
  if (n2?.summerTyres && snow.overlaps(P2, D2, now, b.order.deadline)) return undefined

  const r1 = map.roadMinutes(P1, D1)
  const dh = map.roadMinutes(D1, P2)
  const r2 = map.roadMinutes(P2, D2)
  const ret = map.roadMinutes(D2, P1)
  const totalRoad = r1 + dh + r2

  if (dh > 50 || totalRoad > 675) return undefined

  const manualLicence = Boolean(a.built.audience.manualLicence || b.built.audience.manualLicence)
  const poolP1 = supply.pool30(P1, false, manualLicence)
  const poolD2 = supply.pool30(D2, false, false)

  if (manualLicence && poolP1 < 30) return undefined
  if (poolP1 < 6 && supply.pool65(P1, false, manualLicence) < 20) return undefined

  let tier: 1 | 2
  if (dh <= 45 && ret <= 50) tier = 1
  else if (dh <= 50 && (ret <= 125 || poolD2 >= 18)) tier = 2
  else return undefined

  const minLastPickup = Math.min(a.built.effectiveLastPickupAt, b.built.effectiveLastPickupAt)
  if (minLastPickup - now < 260) return undefined

  const p1Stop = a.built.stops[0]!
  const d1Stop = a.built.stops[1]!
  const p2Stop = b.built.stops[0]!
  const d2Stop = b.built.stops[1]!

  const hP1 = n1?.pickupHours ?? leg1.pickup.hours
  const hD1 = n1?.deliveryHours ?? leg1.delivery.hours
  const hP2 = n2?.pickupHours ?? leg2.pickup.hours
  const hD2 = n2?.deliveryHours ?? leg2.delivery.hours

  const effDl1 = Math.min(a.order.deadline, n1?.noteDeadline ?? Infinity, d1Stop.window?.to ?? Infinity)
  const effDl2 = Math.min(b.order.deadline, n2?.noteDeadline ?? Infinity, d2Stop.window?.to ?? Infinity)

  const p1From = p1Stop.window?.from ?? leg1.pickup.window.from
  const p1To = Math.min(effDl1, p1Stop.window?.to ?? a.order.deadline)
  const p2From = p2Stop.window?.from ?? leg2.pickup.window.from
  const p2To = Math.min(effDl2, p2Stop.window?.to ?? b.order.deadline)

  const extra1 = (p1Stop.withPlates ? PLATES_MINUTES : 0) + (p1Stop.withCharging ? CHARGING_MINUTES : 0)
  const extra2 = (p2Stop.withPlates ? PLATES_MINUTES : 0) + (p2Stop.withCharging ? CHARGING_MINUTES : 0)

  const snow1 = snow.overlaps(P1, D1, now, effDl1)
  const snow2 = snow.overlaps(P2, D2, now, effDl2)
  const drive1 = Math.ceil(r1 * (snow1 ? 1.32 : 1.04))
  const driveDh = Math.ceil(dh * (snow1 || snow2 ? 1.25 : 1.02))
  const drive2 = Math.ceil(r2 * (snow2 ? 1.32 : 1.04))

  const tP1 = visitAt(Math.max(now + 60, p1From), p1To, hP1, 15)
  if (!Number.isFinite(tP1)) return undefined

  const tD1 = visitAt(Math.max(tP1 + 15 + extra1 + drive1, leg1.delivery.window.from), effDl1, hD1, 15)
  if (!Number.isFinite(tD1)) return undefined
  const tFin1 = tD1 + 15

  const tArrP2 = tFin1 + driveDh
  const tP2 = visitAt(Math.max(tArrP2, p2From), p2To, hP2, 15)
  if (!Number.isFinite(tP2)) return undefined

  if (tP2 - tArrP2 > 90) return undefined

  const tD2 = visitAt(Math.max(tP2 + 15 + extra2 + drive2, leg2.delivery.window.from), effDl2, hD2, 15)
  if (!Number.isFinite(tD2)) return undefined
  const tFin2 = tD2 + 15

  if (Math.floor(tP1 / DAY) !== Math.floor(tFin2 / DAY)) return undefined
  if (effDl1 - tFin1 < 240 || effDl2 - tFin2 < 240) return undefined

  const refSum = a.request.referenceFeeCents + b.request.referenceFeeCents
  const refMax = Math.max(a.request.referenceFeeCents, b.request.referenceFeeCents)
  const mktMult = 1.0 + (snow1 || snow2 ? 0.10 : 0) + (fluActive ? 0.08 : 0)
  const coeffs = tier === 1 ? [0.58, 0.66, 0.75, 0.85] : [0.66, 0.74, 0.83, 0.93]

  const schedule = normalizeSteps(
    coeffs.map((c, k) => ({
      at: now + k * 30,
      feeCents: Math.round(Math.max(c * refSum, (0.90 + 0.08 * k) * refMax) * mktMult),
    })),
    now,
  )

  const splitAt = Math.min(now + 120, minLastPickup - 210)
  if (splitAt <= now + 35) return undefined

  const expectedSavings = refSum - schedule[0]!.feeCents
  const hubBonus = Math.min(600, poolP1 * 2) - dh * 12 - ret * 6
  const score = expectedSavings + hubBonus

  return {
    plan: {
      firstOrderId: a.order.id,
      secondOrderId: b.order.id,
      stops: [...a.built.stops, ...b.built.stops],
      audience: { experienced: false, manualLicence },
      schedule,
      tier,
      splitAt,
    },
    score,
  }
}

export function findBestTwoOrderBundle(
  map: MapGraph,
  snow: SnowTracker,
  supply: RosterSupplyModel,
  target: BundleOrderEntry,
  candidates: readonly BundleOrderEntry[],
  now: number,
  level: number,
  fluActive: boolean,
): BundledGigPlan | undefined {
  if (level < 3) return undefined
  let best: { plan: BundledGigPlan; score: number } | undefined

  for (const cand of candidates) {
    if (cand.order.id === target.order.id) continue
    if (now - cand.wonAt > 180) continue

    const ab = evaluateOrderedBundle(map, snow, supply, target, cand, now, fluActive)
    const ba = evaluateOrderedBundle(map, snow, supply, cand, target, now, fluActive)

    let chosen = ab
    if (ab && ba) {
      const poolA = supply.pool30(target.order.legs[0]!.pickup.placeId)
      const poolB = supply.pool30(cand.order.legs[0]!.pickup.placeId)
      chosen = poolB > poolA ? ba : poolA > poolB ? ab : ba.score > ab.score ? ba : ab
    } else if (ba) {
      chosen = ba
    }

    if (chosen && (!best || chosen.score > best.score)) {
      best = chosen
    }
  }

  return best?.plan
}

export function tryExtendTwoToThreeOrderBundle(
  map: MapGraph,
  snow: SnowTracker,
  supply: RosterSupplyModel,
  a: BundleOrderEntry,
  b: BundleOrderEntry,
  c: BundleOrderEntry,
  now: number,
  fluActive: boolean,
): BundledGigPlan | undefined {
  const entries = [a, b, c]
  for (const e of entries) {
    if (e.order.legs.length !== 1) return undefined
    const l = e.order.legs[0]!
    if (l.car.premium || l.pickup.privateAddress || l.delivery.privateAddress) return undefined
    if ((e.notes[0]?.releasedAt ?? 0) > now) return undefined
    if (e.notes[0]?.summerTyres) return undefined
  }

  const l1 = a.order.legs[0]!, l2 = b.order.legs[0]!, l3 = c.order.legs[0]!
  const P1 = l1.pickup.placeId, D1 = l1.delivery.placeId
  const P2 = l2.pickup.placeId, D2 = l2.delivery.placeId
  const P3 = l3.pickup.placeId, D3 = l3.delivery.placeId

  const r1 = map.roadMinutes(P1, D1)
  const dh1 = map.roadMinutes(D1, P2)
  const r2 = map.roadMinutes(P2, D2)
  const dh2 = map.roadMinutes(D2, P3)
  const r3 = map.roadMinutes(P3, D3)
  const ret = map.roadMinutes(D3, P1)
  const totalRoad = r1 + dh1 + r2 + dh2 + r3

  if (dh1 > 46 || dh2 > 42 || totalRoad > 560) return undefined
  const manualLicence = entries.some((e) => e.built.audience.manualLicence)
  const poolP1 = supply.pool30(P1, false, manualLicence)
  const poolD3 = supply.pool30(D3, false, false)
  if (poolP1 < 22 || (ret > 95 && poolD3 < 35)) return undefined

  const minLpa = Math.min(...entries.map((e) => e.built.effectiveLastPickupAt))
  if (minLpa - now < 280) return undefined

  let curAt = now + 60
  let firstDay = -1
  for (let idx = 0; idx < 3; idx++) {
    const e = entries[idx]!
    const prevE = idx > 0 ? entries[idx - 1]! : undefined
    const leg = e.order.legs[0]!
    const n = e.notes[0]
    const pStop = e.built.stops[0]!
    const dStop = e.built.stops[1]!

    const link = prevE
      ? Math.ceil(map.roadMinutes(prevE.order.legs[0]!.delivery.placeId, leg.pickup.placeId) * 1.03)
      : 0
    const arrP = curAt + link
    const hP = n?.pickupHours ?? leg.pickup.hours
    const hD = n?.deliveryHours ?? leg.delivery.hours
    const effDl = Math.min(e.order.deadline, n?.noteDeadline ?? Infinity, dStop.window?.to ?? Infinity)
    const pFrom = pStop.window?.from ?? leg.pickup.window.from
    const pTo = Math.min(effDl, pStop.window?.to ?? e.order.deadline)
    const tP = visitAt(Math.max(arrP, pFrom), pTo, hP, 15)
    if (!Number.isFinite(tP)) return undefined
    if (idx > 0 && tP - arrP > 75) return undefined
    if (idx === 0) firstDay = Math.floor(tP / DAY)

    const extra = (pStop.withPlates ? PLATES_MINUTES : 0) + (pStop.withCharging ? CHARGING_MINUTES : 0)
    const sw = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, now, effDl)
    const drv = Math.ceil(map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId) * (sw ? 1.32 : 1.04))
    const tD = visitAt(Math.max(tP + 15 + extra + drv, leg.delivery.window.from), effDl, hD, 15)
    if (!Number.isFinite(tD)) return undefined
    const tFin = tD + 15
    if (effDl - tFin < 260) return undefined
    if (Math.floor(tFin / DAY) !== firstDay) return undefined
    curAt = tFin
  }

  const refSum = entries.reduce((s, e) => s + e.request.referenceFeeCents, 0)
  const refMax = Math.max(...entries.map((e) => e.request.referenceFeeCents))
  const mktMult = 1.0 + (fluActive ? 0.08 : 0)
  const coeffs = [0.52, 0.60, 0.69, 0.79]
  const schedule = normalizeSteps(
    coeffs.map((kMult, k) => ({
      at: now + k * 30,
      feeCents: Math.round(Math.max(kMult * refSum, (1.02 + 0.08 * k) * refMax) * mktMult),
    })),
    now,
  )
  const splitAt = Math.min(now + 105, minLpa - 215)
  if (splitAt <= now + 35) return undefined

  return {
    firstOrderId: a.order.id,
    secondOrderId: b.order.id,
    stops: [...a.built.stops, ...b.built.stops, ...c.built.stops],
    audience: { experienced: false, manualLicence },
    schedule,
    tier: 1,
    splitAt,
  }
}

export type ActiveDriverCommitment = {
  gigId: string
  driverId: string
  status: "booked" | "working"
  pickupPlaceId: string
  deliveryPlaceId: string
  estStartAt: number
  estFinishAt: number
  driveMinutes: number
}

export type OfferGigTarget = {
  gigId: string
  orderIds: string[]
  pickupPlaceId: string
  deliveryPlaceId: string
  earliestPickupAt: number
  effectiveLastPickupAt: number
  driveMinutes: number
  refFeeCents: number
  currentAppFeeCents: number
  audience: Audience
  hasPrivateStop: boolean
  urgent: boolean
  isPastDeadline: boolean
  offerWave: number
}

export class DirectOfferTracker {
  readonly lastActiveAt = new Map<string, number>()
  readonly bookedOrDeliveredDay = new Map<string, Set<string>>()
  readonly recentDeliveries = new Map<string, { placeId: string; at: number }>()
  readonly offersSentByDay = new Map<string, number>()
  readonly openOffersByGig = new Map<string, Map<string, number>>()
  readonly globalOpenOfferDrivers = new Set<string>()
  readonly attemptedGigDrivers = new Set<string>()
  readonly declinedMaxFee = new Map<string, number>()

  recordView(driverId: string, at: number): void {
    const prev = this.lastActiveAt.get(driverId) ?? -Infinity
    if (at > prev) this.lastActiveAt.set(driverId, at)
  }

  recordBooked(driverId: string, gigId: string, at: number): void {
    this.recordView(driverId, at)
    const dayKey = String(Math.floor(at / DAY))
    let set = this.bookedOrDeliveredDay.get(dayKey)
    if (!set) {
      set = new Set()
      this.bookedOrDeliveredDay.set(dayKey, set)
    }
    set.add(driverId)
    this.clearGig(gigId)
  }

  recordDelivered(driverId: string | null, placeId: string, at: number): void {
    if (!driverId) return
    this.recordView(driverId, at)
    this.recentDeliveries.set(driverId, { placeId, at })
  }

  recordOfferQueued(gigId: string, driverId: string, feeCents: number, now: number): void {
    const dayKey = `${Math.floor(now / DAY)}:${driverId}`
    this.offersSentByDay.set(dayKey, (this.offersSentByDay.get(dayKey) ?? 0) + 1)
    let open = this.openOffersByGig.get(gigId)
    if (!open) {
      open = new Map()
      this.openOffersByGig.set(gigId, open)
    }
    open.set(driverId, feeCents)
    this.globalOpenOfferDrivers.add(driverId)
    this.attemptedGigDrivers.add(`${gigId}:${driverId}`)
  }

  rollbackOfferRefused(gigId: string, driverId: string, now: number): void {
    const dayKey = `${Math.floor(now / DAY)}:${driverId}`
    const cur = this.offersSentByDay.get(dayKey) ?? 0
    if (cur > 0) this.offersSentByDay.set(dayKey, cur - 1)
    this.openOffersByGig.get(gigId)?.delete(driverId)
    this.globalOpenOfferDrivers.delete(driverId)
    this.attemptedGigDrivers.delete(`${gigId}:${driverId}`)
  }

  recordOfferAnswered(gigId: string, driverId: string, answer: "accepted" | "declined" | "expired"): void {
    const offeredFee = this.openOffersByGig.get(gigId)?.get(driverId) ?? 0
    this.openOffersByGig.get(gigId)?.delete(driverId)
    this.globalOpenOfferDrivers.delete(driverId)
    if (answer === "accepted") {
      this.clearGig(gigId)
    } else if (answer === "declined" && offeredFee > 0) {
      const key = `${gigId}:${driverId}`
      this.declinedMaxFee.set(key, Math.max(this.declinedMaxFee.get(key) ?? 0, offeredFee))
    }
  }

  clearGig(gigId: string): void {
    const open = this.openOffersByGig.get(gigId)
    if (open) {
      for (const driverId of open.keys()) {
        this.globalOpenOfferDrivers.delete(driverId)
      }
      this.openOffersByGig.delete(gigId)
    }
  }

  offersToday(driverId: string, now: number): number {
    return this.offersSentByDay.get(`${Math.floor(now / DAY)}:${driverId}`) ?? 0
  }

  openCount(gigId: string): number {
    return this.openOffersByGig.get(gigId)?.size ?? 0
  }

  selectOffersForGig(
    map: MapGraph,
    supply: RosterSupplyModel,
    commitments: readonly ActiveDriverCommitment[],
    gig: OfferGigTarget,
    now: number,
    level: number,
    maxNewOffers = 2,
  ): OfferAction[] {
    if (level < 3) return []
    const tod = now % DAY
    if (tod < 7 * HOUR || tod > 22 * HOUR + 45) return []

    const slotsLeft = Math.min(maxNewOffers, 3 - this.openCount(gig.gigId))
    if (slotsLeft <= 0) return []

    const isScarce = supply.pool30(gig.pickupPlaceId, gig.audience.experienced, gig.audience.manualLicence) <= 8
    const slackMin = gig.effectiveLastPickupAt - now
    const isUrgent = gig.urgent || gig.isPastDeadline || slackMin <= 220
    const execDay = Math.floor(Math.max(now, gig.earliestPickupAt) / DAY)
    const execWd = ((execDay % 7) + 7) % 7
    const isEveningOrSat = execWd === 5 || (Math.max(now, gig.earliestPickupAt) % DAY) >= 17 * HOUR
    const sameDayExec = execDay === Math.floor(now / DAY)
    const todayKey = String(Math.floor(now / DAY))
    const workedTodaySet = this.bookedOrDeliveredDay.get(todayKey)

    const byDriver = new Map<string, ActiveDriverCommitment[]>()
    for (const c of commitments) {
      let arr = byDriver.get(c.driverId)
      if (!arr) {
        arr = []
        byDriver.set(c.driverId, arr)
      }
      arr.push(c)
    }

    const scored: Array<{ driver: DriverProfile; score: number; feeCents: number }> = []

    for (const d of supply.drivers) {
      if (this.globalOpenOfferDrivers.has(d.id)) continue
      if (!isUrgent && this.attemptedGigDrivers.has(`${gig.gigId}:${d.id}`)) continue
      const usedToday = this.offersToday(d.id, now)
      if (usedToday >= 3) continue

      const isExp = d.rating >= 4.8 && d.completedGigs >= 50
      if (gig.audience.experienced && !isExp) continue
      if (gig.audience.manualLicence && d.licence !== "manual") continue

      const lastAct = this.lastActiveAt.get(d.id) ?? -Infinity
      const minsSinceAct = now - lastAct
      const workedToday = Boolean(workedTodaySet?.has(d.id))

      const dComms = byDriver.get(d.id) ?? []
      let dayDriveMins = 0
      let overlaps = false
      let chained = false

      for (const c of dComms) {
        if (Math.floor(c.estStartAt / DAY) === execDay) {
          dayDriveMins += c.driveMinutes
          const link = map.roadMinutes(c.deliveryPlaceId, gig.pickupPlaceId)
          if (c.estFinishAt + link <= gig.effectiveLastPickupAt - 15 && map.distKm(c.deliveryPlaceId, gig.pickupPlaceId) <= 35) {
            chained = true
          } else if (
            gig.earliestPickupAt + gig.driveMinutes + 30 + map.roadMinutes(gig.deliveryPlaceId, c.pickupPlaceId) <=
            c.estStartAt
          ) {
            // Fits before existing commitment
          } else {
            overlaps = true
          }
        }
      }
      if (overlaps || dayDriveMins + gig.driveMinutes > 440) continue

      if (!chained) {
        const recent = this.recentDeliveries.get(d.id)
        if (
          recent &&
          Math.floor(recent.at / DAY) === execDay &&
          now - recent.at <= 180 &&
          map.distKm(recent.placeId, gig.pickupPlaceId) <= 35
        ) {
          chained = true
        }
      }

      // Only send offers to drivers seen active today
      const maxInactiveMins = 540
      if (!workedToday && !chained && minsSinceAct > maxInactiveMins) continue

      const distP = map.distKm(d.homePlaceId, gig.pickupPlaceId)
      const distD = map.distKm(d.homePlaceId, gig.deliveryPlaceId)
      if (!chained && distP > 65 && distD > 30) continue

      // Ensure non-chained home-origin drivers can actually reach pickup before effectiveLastPickupAt!
      const transitMin = chained ? 0 : Math.ceil(map.roadMinutes(d.homePlaceId, gig.pickupPlaceId) * 1.25)
      if (!chained && now + transitMin + 15 > gig.effectiveLastPickupAt) continue

      let matchScore = -Infinity
      if (chained && distD <= 30) matchScore = 108
      else if (chained) matchScore = distP > 30 ? 92 : 76
      else if (distD === 0 && distP > 30) matchScore = 84 - transitMin * 0.05
      else if (distD <= 30 && distP > 30) matchScore = 76 - transitMin * 0.05
      else if (distP > 30 && distP <= 65) matchScore = isScarce || isUrgent ? 72 : 48
      else if (distP <= 30 && distD <= 30) matchScore = 54
      else if (distP <= 30) matchScore = isUrgent || isScarce ? 64 : 40

      if (!Number.isFinite(matchScore)) continue

      const activityBonus =
        workedToday ? 26 :
        minsSinceAct <= 15 ? 32 :
        minsSinceAct <= 60 ? 22 :
        12

      const dropPenalty = Math.min(26, d.drops * 3.8)
      const budgetPenalty = usedToday * 10
      const expSavePenalty = !gig.audience.experienced && isExp ? 8 : 0
      const totalScore = matchScore + activityBonus - dropPenalty - budgetPenalty - expSavePenalty

      if (totalScore < (isUrgent || isScarce ? 48 : 68)) continue

      let mult =
        chained && distD <= 30 ? 0.88 :
        chained ? 0.93 :
        distD <= 30 && distP > 30 ? (isScarce ? 0.98 : 0.93) :
        distP <= 30 && distD <= 30 ? 0.95 :
        distP <= 30 ? 1.00 :
        isScarce ? 1.08 : 1.02

      if (gig.hasPrivateStop) mult += 0.09
      if (gig.audience.experienced) mult += 0.14
      if (isEveningOrSat) mult += 0.05
      if (!sameDayExec) mult += 0.03
      mult += gig.offerWave * 0.09

      if (gig.isPastDeadline) {
        mult = Math.max(mult, 1.75 + gig.offerWave * 0.25)
      } else if (isUrgent && slackMin <= 190) {
        mult = Math.max(mult, 1.38 + gig.offerWave * 0.16)
      } else if (isScarce && slackMin <= 360) {
        mult = Math.max(mult, 1.16 + gig.offerWave * 0.10)
      }

      const rawFee = Math.round(gig.refFeeCents * Math.min(2.80, mult))
      let feeCents =
        isUrgent && slackMin <= 190
          ? Math.max(rawFee, Math.round(gig.currentAppFeeCents * 1.04))
          : rawFee
      if (distP <= 30 && feeCents < gig.currentAppFeeCents) {
        feeCents = gig.currentAppFeeCents
      }

      const prevDeclined = this.declinedMaxFee.get(`${gig.gigId}:${d.id}`) ?? 0
      if (feeCents <= prevDeclined + 50) continue

      scored.push({ driver: d, score: totalScore, feeCents: Math.max(1, feeCents) })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, slotsLeft).map((s) => ({
      type: "offer",
      gigId: gig.gigId,
      driverId: s.driver.id,
      feeCents: s.feeCents,
    }))
  }
}
