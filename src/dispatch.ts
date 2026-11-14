import type { MapGraph } from "./planner.ts"
import type { RosterSupplyModel } from "./supply.ts"
import { clampOutOfNight, DAY, dayOf, dayStartOf, HOUR, weekdayOfDay } from "./time.ts"
import type { Audience, FeeStep } from "./types.ts"

export type SingleScheduleContext = {
  now: number
  endsAt: number
  level: number
  baseRefFeeCents: number
  orderPriceCents: number
  minFloorFeeCents: number
  routeKm: number
  pickupPlaceId: string
  deliveryPlaceId: string
  effectiveLastPickupAt: number
  rawLastPickupAt: number
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

export function currentScheduleFee(schedule: readonly FeeStep[], now: number): number {
  let fee = schedule[0]?.feeCents ?? 0
  for (const step of schedule) {
    if (step.at <= now) fee = step.feeCents
  }
  return fee
}

export function bumpScheduleAfterDrop(schedule: readonly FeeStep[], now: number): FeeStep[] {
  let prevAt = now
  return schedule.map((s, idx) => {
    const rawAt = idx === 0 ? now : Math.max(now + idx * 25, s.at)
    const clampedAt = idx === 0 ? now : clampOutOfNight(rawAt, idx)
    const at = idx === 0 ? now : Math.max(prevAt + 20, clampedAt)
    prevAt = at
    return {
      at,
      feeCents: Math.round(s.feeCents * 1.03),
    }
  })
}

function buildMonotonicClampedSteps(
  now: number,
  stepGap: number,
  mults: readonly number[],
  feeFn: (mult: number, k: number) => number,
): FeeStep[] {
  let prevAt = now
  return mults.map((mult, k) => {
    const at = k === 0 ? now : Math.max(prevAt + 20, clampOutOfNight(now + k * stepGap, k))
    prevAt = at
    return { at, feeCents: feeFn(mult, k) }
  })
}

export function normalizeSteps(
  steps: FeeStep[],
  now: number,
  maxFeeCents = Infinity,
  minFirstFeeCents = 1,
): FeeStep[] {
  const cap = Math.max(1, Math.round(maxFeeCents))
  const floor0 = Math.min(cap, Math.max(1, Math.round(minFirstFeeCents)))
  const sorted = [...steps]
    .map((s, idx) => ({
      at: Math.max(now, Math.round(s.at)),
      feeCents: Math.min(cap, Math.max(idx === 0 ? floor0 : 1, Math.round(s.feeCents))),
    }))
    .sort((a, b) => a.at - b.at)

  const deduped: FeeStep[] = []
  for (const step of sorted) {
    const prev = deduped[deduped.length - 1]
    const monoFee = prev ? Math.max(prev.feeCents, step.feeCents) : Math.max(floor0, step.feeCents)
    if (prev && prev.at === step.at) {
      prev.feeCents = monoFee
    } else {
      deduped.push({ at: step.at, feeCents: monoFee })
    }
  }
  return deduped.slice(0, 48)
}

function computeBaseStepMultiplier(
  ctx: SingleScheduleContext,
  Q30: number,
  D_pool30: number,
  sameCluster30: boolean,
): number {
  const execAt = Math.max(ctx.now, ctx.earliestPickupAt)
  const pickWd = weekdayOfDay(dayOf(execAt))
  const pickTod = execAt % DAY
  const isEveningOrSat = pickWd === 5 || pickTod >= 17 * HOUR

  const hasExtras =
    ctx.hasPrivatePickup ||
    ctx.hasPrivateDelivery ||
    ctx.isTradeInTwoLegs ||
    ctx.audience.experienced ||
    ctx.withCharging ||
    ctx.withPlates

  const fluToday = ctx.fluActive && dayOf(ctx.effectiveLastPickupAt) === dayOf(ctx.now)

  let m0 = 0.85
  if (D_pool30 >= 95 && Q30 >= 40 && !hasExtras && !ctx.snowOverlap && !fluToday && ctx.routeKm <= 220) {
    m0 -= 0.04
  }
  if (D_pool30 <= 5 && !sameCluster30) m0 += 0.08
  else if (D_pool30 <= 14 && !sameCluster30) m0 += 0.05

  if (Q30 === 0) m0 += 0.12
  else if (Q30 <= 5) m0 += 0.07
  else if (Q30 <= 15) m0 += 0.03

  if (ctx.routeKm > 260) m0 += 0.07
  if (ctx.routeKm > 400) m0 += 0.06
  if (ctx.hasPrivatePickup && !ctx.isTradeInTwoLegs) m0 += 0.14
  if (ctx.hasPrivateDelivery && !ctx.isTradeInTwoLegs) m0 += 0.16
  if (ctx.isTradeInTwoLegs) m0 += 0.21
  if (ctx.audience.experienced) m0 += 0.18
  if (ctx.withCharging) m0 += 0.08
  if (ctx.withPlates || ctx.audience.manualLicence) m0 += 0.04
  if (isEveningOrSat) m0 += 0.06
  if (ctx.snowOverlap) m0 += 0.12
  if (fluToday) m0 += 0.08

  return Math.max(0.80, Math.min(hasExtras || ctx.snowOverlap ? 1.45 : 1.32, m0))
}

const RAMP_ANCHORS: ReadonlyArray<{ beforeLpa: number; add: number; floor: number }> = [
  { beforeLpa: 390, add: 0.11, floor: 0.98 },
  { beforeLpa: 295, add: 0.22, floor: 1.12 },
  { beforeLpa: 220, add: 0.36, floor: 1.28 },
  { beforeLpa: 165, add: 0.54, floor: 1.48 },
  { beforeLpa: 110, add: 0.78, floor: 1.76 },
]

export function buildSingleGigSchedule(
  map: MapGraph,
  supply: RosterSupplyModel,
  ctx: SingleScheduleContext,
): FeeStep[] {
  const Q30 = supply.pool30(ctx.pickupPlaceId, ctx.audience.experienced, ctx.audience.manualLicence)
  const D_pool30 = supply.pool30(ctx.deliveryPlaceId, false, false)
  const sameCluster30 = map.isSameCluster30(ctx.pickupPlaceId, ctx.deliveryPlaceId)
  const isLongOrDeadEnd = ctx.routeKm > 250 || (D_pool30 <= 14 && !sameCluster30)
  const m0 = computeBaseStepMultiplier(ctx, Q30, D_pool30, sameCluster30)

  const maxEconFee =
    ctx.orderPriceCents > 0
      ? Math.max(Math.round(ctx.baseRefFeeCents * 2.50), Math.round(ctx.orderPriceCents * 2.85))
      : Infinity

  if (ctx.level === 1) {
    const flatMult = ctx.isPastDeadline ? 2.20 : ctx.urgent ? Math.max(1.48, m0 + 0.35) : m0
    const fee = Math.min(maxEconFee, Math.max(ctx.minFloorFeeCents, Math.round(ctx.baseRefFeeCents * flatMult)))
    return [{ at: ctx.now, feeCents: Math.max(1, fee) }]
  }

  if (ctx.isPastDeadline && ctx.endsAt - ctx.now <= 42 * HOUR) {
    const rescueMults = [
      Math.max(m0 + 0.45, 1.58),
      Math.max(m0 + 0.75, 1.88),
      Math.max(m0 + 1.05, 2.22),
      Math.max(m0 + 1.40, 2.58),
      Math.max(m0 + 1.75, 2.95),
    ]
    return normalizeSteps(
      buildMonotonicClampedSteps(ctx.now, 35, rescueMults, (mult) => Math.round(ctx.baseRefFeeCents * mult)),
      ctx.now,
      maxEconFee,
      ctx.minFloorFeeCents,
    )
  }

  if ((ctx.isPastDeadline || ctx.now > ctx.rawLastPickupAt) && !ctx.hasPrivateDelivery && ctx.endsAt - ctx.now > 42 * HOUR) {
    const lateDayMults = [
      Math.max(m0 + 0.10, 1.05),
      Math.max(m0 + 0.24, 1.20),
      Math.max(m0 + 0.40, 1.38),
      Math.max(m0 + 0.60, 1.60),
      Math.max(m0 + 0.82, 1.85),
    ]
    return normalizeSteps(
      buildMonotonicClampedSteps(ctx.now, 70, lateDayMults, (mult) => Math.round(ctx.baseRefFeeCents * mult)),
      ctx.now,
      maxEconFee,
      1,
    )
  }

  const slackMin = ctx.effectiveLastPickupAt - ctx.now
  const maxUrgentMult = ctx.highTrustDealer ? 2.42 : 2.28

  if (ctx.urgent || slackMin <= 155) {
    const leadSoft = !ctx.isPastDeadline && slackMin > 155 ? -0.08 : 0
    const stepMults = [
      Math.max(m0 + 0.24, 1.36 + leadSoft),
      Math.max(m0 + 0.44, 1.56 + leadSoft),
      Math.max(m0 + 0.68, 1.80 + leadSoft),
      Math.max(m0 + 0.94, 2.06 + leadSoft),
      Math.max(m0 + 1.18, maxUrgentMult),
    ]
    const gap = slackMin >= 175 ? 30 : 24
    return normalizeSteps(
      buildMonotonicClampedSteps(ctx.now, gap, stepMults, (mult) => Math.round(ctx.baseRefFeeCents * mult)),
      ctx.now,
      maxEconFee,
      ctx.minFloorFeeCents,
    )
  }

  const lpa = ctx.effectiveLastPickupAt
  const lpaDayStart = dayStartOf(lpa)
  const postDayStart = dayStartOf(ctx.now)
  const crossesNight = dayOf(lpa) > dayOf(ctx.now)

  const rampOffsets: Array<{ at: number; mult: number }> = [{ at: ctx.now, mult: m0 }]

  if (crossesNight && ctx.routeKm > 400) {
    const eveTrainAt = Math.max(ctx.now + 60, postDayStart + 19 * HOUR + 15)
    if (eveTrainAt <= postDayStart + 21 * HOUR + 45 && eveTrainAt < lpa - 300) {
      rampOffsets.push({ at: eveTrainAt, mult: Math.max(m0 + 0.08, 1.04) })
    }
  }

  if (dayOf(lpa) - dayOf(ctx.now) >= 2) {
    const midDayAt = Math.max(ctx.now + 120, postDayStart + DAY + 10 * HOUR)
    if (midDayAt < lpaDayStart) {
      rampOffsets.push({ at: midDayAt, mult: Math.min(0.98, m0 + 0.06) })
    }
  }

  if (crossesNight && isLongOrDeadEnd) {
    const morningWaveAt = Math.max(ctx.now + 90, lpaDayStart + 7 * HOUR + 35)
    if (morningWaveAt < lpa - 240) {
      rampOffsets.push({ at: morningWaveAt, mult: Math.max(m0 + 0.12, 1.08) })
    }
  }

  const minRampStart = Math.max(
    ctx.earliestPickupAt - 180,
    crossesNight
      ? Math.max(ctx.now + 120, lpaDayStart + (isLongOrDeadEnd ? 7 * HOUR + 55 : 8 * HOUR + 45))
      : ctx.now + 75,
  )

  const spanEnd = lpa - 45
  if (minRampStart > lpa - 390 && spanEnd > minRampStart + 25) {
    for (let idx = 0; idx < RAMP_ANCHORS.length; idx++) {
      const a = RAMP_ANCHORS[idx]!
      const frac = idx / (RAMP_ANCHORS.length - 1)
      const rawT = Math.round(minRampStart + frac * (spanEnd - minRampStart))
      const t = clampOutOfNight(rawT, idx)
      if (t < lpa - 15) {
        rampOffsets.push({ at: t, mult: Math.min(maxUrgentMult, Math.max(m0 + a.add, a.floor)) })
      }
    }
  } else {
    for (let idx = 0; idx < RAMP_ANCHORS.length; idx++) {
      const a = RAMP_ANCHORS[idx]!
      const t = clampOutOfNight(Math.max(minRampStart, lpa - a.beforeLpa), idx)
      if (t < lpa - 15) {
        rampOffsets.push({ at: t, mult: Math.min(maxUrgentMult, Math.max(m0 + a.add, a.floor)) })
      }
    }
  }

  return normalizeSteps(
    rampOffsets.map((r) => ({ at: r.at, feeCents: Math.round(ctx.baseRefFeeCents * r.mult) })),
    ctx.now,
    maxEconFee,
    ctx.minFloorFeeCents,
  )
}
