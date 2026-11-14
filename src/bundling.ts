import { normalizeSteps } from "./dispatch.ts"
import type { ParsedLegNote } from "./notes.ts"
import { CHARGING_MINUTES, PLATES_MINUTES, visitAt } from "./planner.ts"
import type { BuiltOrderStops, MapGraph, SnowTracker } from "./planner.ts"
import type { RosterSupplyModel } from "./supply.ts"
import { clampOutOfNight, DAY, dayOf, dayStartOf, HOUR } from "./time.ts"
import type { Audience, FeeStep, Order, PriceRequest, StopRef } from "./types.ts"

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

export function computeTwoOrderBundleSplitAt(postedAt: number, minLastPickup: number): number {
  const crossesNight =
    Number.isFinite(minLastPickup) &&
    dayOf(minLastPickup) > dayOf(postedAt) &&
    minLastPickup - postedAt >= 600
  return crossesNight
    ? Math.min(minLastPickup - 240, Math.max(postedAt + 150, dayStartOf(minLastPickup) + 9 * HOUR + 15))
    : Math.min(postedAt + 125, minLastPickup - 210)
}

function isCleanSoloBundleLeg(entry: BundleOrderEntry, now: number): boolean {
  if (entry.order.legs.length !== 1) return false
  const leg = entry.order.legs[0]!
  if (leg.car.premium || leg.pickup.privateAddress || leg.delivery.privateAddress) return false
  if ((entry.notes[0]?.releasedAt ?? 0) > now) return false
  return true
}

function isEligibleTwoBundleFirst(entry: BundleOrderEntry, now: number): boolean {
  if (entry.order.legs.length !== 1) return false
  const leg = entry.order.legs[0]!
  if (leg.pickup.privateAddress || leg.delivery.privateAddress) return false
  if ((entry.notes[0]?.releasedAt ?? 0) > now) return false
  return true
}

function isEligibleTwoBundleSecond(entry: BundleOrderEntry, now: number): boolean {
  if (entry.order.legs.length !== 1) return false
  const leg = entry.order.legs[0]!
  if (leg.pickup.privateAddress) return false
  if (leg.delivery.privateAddress && leg.delivery.window.to - now < 300) return false
  if ((entry.notes[0]?.releasedAt ?? 0) > now) return false
  return true
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
  if (!isEligibleTwoBundleFirst(a, now) || !isEligibleTwoBundleSecond(b, now)) return undefined

  const leg1 = a.order.legs[0]!
  const leg2 = b.order.legs[0]!
  const n1 = a.notes[0]
  const n2 = b.notes[0]
  const hasPrivDeliv2 = leg2.delivery.privateAddress

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

  const experienced = Boolean(a.built.audience.experienced || b.built.audience.experienced)
  const manualLicence = Boolean(a.built.audience.manualLicence || b.built.audience.manualLicence)
  const poolP1 = supply.pool30(P1, experienced, manualLicence)
  const poolD2 = supply.pool30(D2, false, false)

  if (experienced && poolP1 < 22) return undefined
  if (hasPrivDeliv2 && poolP1 < 20) return undefined
  if (manualLicence && poolP1 < 30) return undefined
  if (poolP1 < 6 && supply.pool65(P1, experienced, manualLicence) < 20) return undefined

  let tier: 1 | 2
  if (dh <= 45 && ret <= 50) tier = 1
  else if (dh <= 50 && ret <= 135 && (ret <= 95 || poolD2 >= 18)) tier = 2
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
  const effDl2 = Math.min(
    b.order.deadline,
    n2?.noteDeadline ?? Infinity,
    d2Stop.window?.to ?? Infinity,
    hasPrivDeliv2 ? leg2.delivery.window.to : Infinity,
  )

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

  const curDayStart = dayStartOf(now)
  const p2AlignedStart = Math.max(now + 45, p2From - driveDh - 15 - drive1 - extra1 - 15)
  const startCandidates = [
    now + 60,
    p2AlignedStart,
    curDayStart + DAY + 7 * HOUR + 15,
    curDayStart + 2 * DAY + 7 * HOUR + 15,
  ]
  const reqPostDelivSlack1 = snow1 || snow2 ? 220 : 175
  const reqPostDelivSlack2 = hasPrivDeliv2 ? 95 : reqPostDelivSlack1
  let feasibleSim = false
  for (const candStart of startCandidates) {
    if (candStart > minLastPickup - 120) continue
    const tP1 = visitAt(Math.max(candStart, p1From), p1To, hP1, 15)
    if (!Number.isFinite(tP1)) continue
    const tD1 = visitAt(Math.max(tP1 + 15 + extra1 + drive1, leg1.delivery.window.from), effDl1, hD1, 15)
    if (!Number.isFinite(tD1)) continue
    const tFin1 = tD1 + 15
    const tArrP2 = tFin1 + driveDh
    const tP2 = visitAt(Math.max(tArrP2, p2From), p2To, hP2, 15)
    if (!Number.isFinite(tP2) || tP2 - tArrP2 > 90) continue
    const tD2 = visitAt(Math.max(tP2 + 15 + extra2 + drive2, leg2.delivery.window.from), effDl2, hD2, 15)
    if (!Number.isFinite(tD2)) continue
    const tFin2 = tD2 + 15
    if (dayOf(tP1) !== dayOf(tFin2)) continue
    if (effDl1 - tFin1 < reqPostDelivSlack1 || effDl2 - tFin2 < reqPostDelivSlack2) continue
    feasibleSim = true
    break
  }
  if (!feasibleSim) return undefined

  const refSum = a.request.referenceFeeCents + b.request.referenceFeeCents
  const refMax = Math.max(a.request.referenceFeeCents, b.request.referenceFeeCents)
  const fluTodayBundle = fluActive && dayOf(minLastPickup) === dayOf(now)
  const mktMult =
    1.0 +
    (snow1 || snow2 ? 0.10 : 0) +
    (fluTodayBundle ? 0.06 : 0) +
    (experienced ? 0.14 : 0) +
    (hasPrivDeliv2 ? 0.08 : 0)
  const deepSlackBundle = minLastPickup - now >= 500 && !experienced && !hasPrivDeliv2
  const coeffs = deepSlackBundle
    ? tier === 1
      ? [0.50, 0.58, 0.67, 0.77, 0.86]
      : [0.58, 0.66, 0.75, 0.84, 0.93]
    : tier === 1
      ? [0.58, 0.66, 0.75, 0.85]
      : [0.66, 0.74, 0.83, 0.93]

  const crossesNightBundle = dayOf(minLastPickup) > dayOf(now) && minLastPickup - now >= 600
  const lpaDayStart = dayStartOf(minLastPickup)
  const stepGap = deepSlackBundle ? 25 : 30
  const refMaxBase = deepSlackBundle ? 0.80 : 0.90
  const refMaxSlope = deepSlackBundle ? 0.07 : 0.08

  let prevStepAt2 = now
  const schedule = normalizeSteps(
    coeffs.map((c, k) => {
      const rawStepAt =
        k === 0
          ? now
          : crossesNightBundle && k >= 2
            ? Math.max(prevStepAt2 + 20, Math.max(now + k * 32, lpaDayStart + 7 * HOUR + 15 + (k - 2) * 45))
            : Math.max(prevStepAt2 + 20, clampOutOfNight(now + k * stepGap, k))
      prevStepAt2 = rawStepAt
      return {
        at: rawStepAt,
        feeCents: Math.round(Math.max(c * refSum, (refMaxBase + refMaxSlope * k) * refMax) * mktMult),
      }
    }),
    now,
  )

  const splitAt = computeTwoOrderBundleSplitAt(now, minLastPickup)
  if (splitAt <= now + 35) return undefined

  const effLpa2 = hasPrivDeliv2
    ? Math.min(b.built.effectiveLastPickupAt, leg2.delivery.window.to - drive2 - extra2 - 25)
    : b.built.effectiveLastPickupAt
  const maxP1ForP2 = effLpa2 - driveDh - 15 - drive1 - extra1 - 15
  const bundleStops = [...a.built.stops, ...b.built.stops]
  if (
    maxP1ForP2 >= Math.max(now + 45, p1From + 20) &&
    maxP1ForP2 < (p1Stop.window?.to ?? a.order.deadline)
  ) {
    bundleStops[0] = {
      ...p1Stop,
      window: {
        from: Math.max(leg1.pickup.window.from, p1From),
        to: Math.min(p1To, maxP1ForP2),
      },
    }
  }
  if (hasPrivDeliv2 && leg2.delivery.window.to > now + 60) {
    bundleStops[3] = {
      ...d2Stop,
      window: {
        from: leg2.delivery.window.from,
        to: leg2.delivery.window.to + 15,
      },
    }
  }

  const expectedSavings = refSum - schedule[0]!.feeCents
  const hubBonus = Math.min(600, poolP1 * 2) - dh * 12 - ret * 6
  const score = expectedSavings + hubBonus

  return {
    plan: {
      firstOrderId: a.order.id,
      secondOrderId: b.order.id,
      stops: bundleStops,
      audience: { experienced, manualLicence },
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

    const ab = evaluateOrderedBundle(map, snow, supply, target, cand, now, fluActive)
    const ba = evaluateOrderedBundle(map, snow, supply, cand, target, now, fluActive)

    let chosen = ab
    if (ab && ba) {
      const poolA = supply.pool30(target.order.legs[0]!.pickup.placeId)
      const poolB = supply.pool30(cand.order.legs[0]!.pickup.placeId)
      chosen =
        Math.min(poolA, poolB) < 25 && poolB !== poolA
          ? poolB > poolA
            ? ba
            : ab
          : ba.score > ab.score
            ? ba
            : ab
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
  if (fluActive || supply.totalDrivers < 760) return undefined
  const entries = [a, b, c]
  for (const e of entries) {
    if (!isCleanSoloBundleLeg(e, now)) return undefined
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

  if (dh1 > 32 || dh2 > 32 || ret > 90 || totalRoad > 440) return undefined
  const manualLicence = entries.some((e) => e.built.audience.manualLicence)
  const poolP1 = supply.pool30(P1, false, manualLicence)
  const poolD3 = supply.pool30(D3, false, false)
  if (poolP1 < 35 || (ret > 55 && poolD3 < 45)) return undefined

  const minLpa = Math.min(...entries.map((e) => e.built.effectiveLastPickupAt))
  if (minLpa - now < 300) return undefined

  const curDayStart = dayStartOf(now)
  const startCandidates = [now + 60, curDayStart + DAY + 7 * HOUR + 15]
  let anySnow = false
  let feasible3 = false

  for (const candStart of startCandidates) {
    if (candStart > minLpa - 180) break
    let curAt = candStart
    let firstDay = -1
    let ok = true
    let simSnow = false
    for (let idx = 0; idx < 3; idx++) {
      const e = entries[idx]!
      const prevE = idx > 0 ? entries[idx - 1]! : undefined
      const leg = e.order.legs[0]!
      const n = e.notes[0]
      const pStop = e.built.stops[0]!
      const dStop = e.built.stops[1]!

      const effDl = Math.min(e.order.deadline, n?.noteDeadline ?? Infinity, dStop.window?.to ?? Infinity)
      const sw = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, now, effDl)
      if (sw) simSnow = true
      const linkSw = prevE
        ? snow.overlaps(prevE.order.legs[0]!.delivery.placeId, leg.pickup.placeId, now, effDl)
        : null
      if (linkSw) simSnow = true

      const link = prevE
        ? Math.ceil(map.roadMinutes(prevE.order.legs[0]!.delivery.placeId, leg.pickup.placeId) * (linkSw ? 1.25 : 1.03))
        : 0
      const arrP = curAt + link
      const hP = n?.pickupHours ?? leg.pickup.hours
      const hD = n?.deliveryHours ?? leg.delivery.hours
      const pFrom = pStop.window?.from ?? leg.pickup.window.from
      const pTo = Math.min(effDl, pStop.window?.to ?? e.order.deadline)
      const tP = visitAt(Math.max(arrP, pFrom), pTo, hP, 15)
      if (!Number.isFinite(tP) || (idx > 0 && tP - arrP > 75)) {
        ok = false
        break
      }
      if (idx === 0) firstDay = dayOf(tP)

      const extra = (pStop.withPlates ? PLATES_MINUTES : 0) + (pStop.withCharging ? CHARGING_MINUTES : 0)
      const drv = Math.ceil(map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId) * (sw ? 1.32 : 1.04))
      const tD = visitAt(Math.max(tP + 15 + extra + drv, leg.delivery.window.from), effDl, hD, 15)
      if (!Number.isFinite(tD)) {
        ok = false
        break
      }
      const tFin = tD + 15
      if (effDl - tFin < 260 || dayOf(tFin) !== firstDay) {
        ok = false
        break
      }
      curAt = tFin
    }
    if (ok) {
      feasible3 = true
      anySnow = simSnow
      break
    }
  }
  if (!feasible3) return undefined

  const refSum = entries.reduce((s, e) => s + e.request.referenceFeeCents, 0)
  const refMax = Math.max(...entries.map((e) => e.request.referenceFeeCents))
  const mktMult = 1.0 + (anySnow ? 0.10 : 0) + (fluActive ? 0.08 : 0)
  const coeffs = [0.52, 0.60, 0.69, 0.80]
  const schedule = normalizeSteps(
    coeffs.map((kMult, k) => ({
      at: k === 0 ? now : clampOutOfNight(now + k * 30, k),
      feeCents: Math.round(Math.max(kMult * refSum, (0.98 + 0.08 * k) * refMax) * mktMult),
    })),
    now,
  )
  const crossesNight3 = dayOf(minLpa) > dayOf(now) && minLpa - now >= 600
  const splitAt = crossesNight3
    ? Math.min(minLpa - 250, Math.max(now + 150, dayStartOf(minLpa) + 9 * HOUR))
    : Math.min(now + 135, minLpa - 220)
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
