import { CompetitorMarketEstimator, optionMultiplier, sigmoid } from "./estimator.ts"
import type { BatchQuoteContext, OptKind, RecordedQuoteMeta } from "./estimator.ts"
import type { ParsedLegNote } from "./notes.ts"
import { computeOptionPlan } from "./planner.ts"
import type { MapGraph, OptionPlan, SnowTracker } from "./planner.ts"
import type { RosterSupplyModel } from "./supply.ts"
import { DAY, dayOf, HOUR, weekdayOfDay } from "./time.ts"
import type { DeliveryOption, PriceRequest } from "./types.ts"

export type QuotePortfolioContext = {
  now: number
  startMinute?: number
  wonOrdersTotal: number
  deliveredOrdersTotal: number
  deliveredOnTimeTotal: number
  overdueUndeliveredCount?: number
  unbookedOrdersCount: number
  openPickupsInCluster30: (placeId: string) => number
  pendingPickupsInCluster30?: (placeId: string) => number
  activeOrdersOnDeadlineDay: (deadlineDay: number) => number
  inFlightDealerOrders?: (dealerId: string) => number
  hasArrivingDriverSynergy: (pickupId: string, deliveryId: string, earliestMin: number, latestMin: number) => boolean
  roundTripPartnerCredit: (
    pickupId: string,
    deliveryId: string,
    earliestPickupAt: number,
    effectiveLastPickupAt: number,
    effectiveDeadline: number,
  ) => number
  batchInfo?: BatchQuoteContext
  fluActiveToday: boolean
}

export type MenuChoiceResult = {
  pWin: number
  winSd: number
  winNd: number
  win3d: number
}

export function evaluateMenuChoice(
  hasSdOffered: boolean,
  hasNdOffered: boolean,
  has3dOffered: boolean,
  tildeCNdCents: number,
  pSdCents: number | undefined,
  pNdCents: number | undefined,
  p3dCents: number | undefined,
): MenuChoiceResult {
  const safeScale = Math.max(1, tildeCNdCents)
  const rSd = pSdCents !== undefined ? pSdCents / safeScale : undefined
  const rNd = pNdCents !== undefined ? pNdCents / safeScale : undefined
  const r3d = p3dCents !== undefined ? p3dCents / safeScale : undefined

  const headWin = (x: number): number => sigmoid(-(x >= 0 ? 13.0 : 9.8) * x)
  const pSd = hasSdOffered && rSd !== undefined ? headWin(Math.log(Math.max(1e-6, rSd / 1.08))) : 0
  const pNd = hasNdOffered && rNd !== undefined ? headWin(Math.log(Math.max(1e-6, rNd))) : 0
  const p3d = has3dOffered && r3d !== undefined ? headWin(Math.log(Math.max(1e-6, r3d / 0.93))) : 0

  let b0 = pSd
  let b1 = pNd
  let b2 = p3d
  if (b0 > b1) { const t = b0; b0 = b1; b1 = t }
  if (b1 > b2) { const t = b1; b1 = b2; b2 = t }
  if (b0 > b1) { const t = b0; b0 = b1; b1 = t }

  let winSd = 0
  let winNd = 0
  let win3d = 0
  let prev = 0

  for (let step = 0; step < 3; step++) {
    const cur = step === 0 ? b0 : step === 1 ? b1 : b2
    const du = cur - prev
    if (du <= 1e-9) {
      prev = cur
      continue
    }
    const mid = 0.5 * (prev + cur)
    const wSd = mid <= pSd && rSd !== undefined
    const wNd = mid <= pNd && rNd !== undefined
    const w3d = mid <= p3d && r3d !== undefined

    if (wSd && wNd && w3d) {
      const sSd = sigmoid(4.8 * (0.092 - Math.log(rSd / rNd)))
      const s3d = sigmoid(5.2 * (Math.log(rNd / r3d) - 0.092))
      winSd += du * sSd
      win3d += du * (1 - sSd) * s3d
      winNd += du * (1 - sSd) * (1 - s3d)
    } else if (wSd && wNd) {
      const sSd = sigmoid(4.8 * (0.092 - Math.log(rSd / rNd)))
      const k3d = has3dOffered && rNd > 1.08 ? sigmoid(6.0 * (0.42 - Math.log(rNd / 0.93))) : 1.0
      winSd += du * sSd
      winNd += du * (1 - sSd) * k3d
    } else if (wNd && w3d) {
      const kSd = hasSdOffered ? 1 - sigmoid(4.8 * (0.092 - Math.log(1.08 / rNd))) : 1.0
      const s3d = sigmoid(5.2 * (Math.log(rNd / r3d) - 0.092))
      win3d += du * kSd * s3d
      winNd += du * kSd * (1 - s3d)
    } else if (wSd && w3d) {
      const sSd = sigmoid(4.8 * (0.092 - Math.log(rSd / 1.0)))
      const s3d = sigmoid(5.2 * (Math.log(1.0 / r3d) - 0.092))
      winSd += du * sSd
      win3d += du * (1 - sSd) * s3d
    } else if (wSd) {
      const kNd = hasNdOffered ? sigmoid(4.8 * (0.18 - Math.log(rSd / 1.0))) : 1.0
      winSd += du * kNd
    } else if (wNd) {
      const kSd = hasSdOffered ? 1 - sigmoid(4.8 * (0.092 - Math.log(1.08 / rNd))) : 1.0
      const k3d = has3dOffered && rNd > 1.08 ? sigmoid(6.0 * (0.42 - Math.log(rNd / 0.93))) : 1.0
      winNd += du * kSd * k3d
    } else if (w3d) {
      const kFast = hasNdOffered
        ? sigmoid(5.2 * (Math.log(1.0 / r3d) - 0.092))
        : hasSdOffered
          ? sigmoid(5.2 * (Math.log(1.08 / r3d) - 0.184))
          : 1.0
      win3d += du * kFast
    }
    prev = cur
  }

  return { pWin: winSd + winNd + win3d, winSd, winNd, win3d }
}

type EvaluatedOption = {
  option: DeliveryOption
  plan: OptionPlan
  trueCostCents: number
  baseEffectiveCostCents: number
  paceRatio: number
  dayLoad: number
  pLate: number
}

type OptionMenuBounds = {
  minP: number
  maxP: number
  effCost: number
  trueCost: number
  dlDay: number
  dlWd: number
  dayLoad: number
}

function requestProgressFraction(now: number): number {
  const workPerDay = 10 * HOUR
  const totalWeekWork = 5 * workPerDay
  const day = Math.min(5, Math.max(0, dayOf(now)))
  if (day >= 5) return 1.0
  const tod = now % DAY
  const todayWork = Math.max(0, Math.min(workPerDay, tod - 8 * HOUR))
  return Math.min(1.0, (day * workPerDay + todayWork) / totalWeekWork)
}

function sweepMenuGrid(
  lo: number,
  hi: number,
  steps: number,
  fallbackPrice: number,
  evalAt: (cand: number) => number,
): { bestP: number; bestEv: number } {
  let bestP = fallbackPrice
  let bestEv = -1e9
  for (let s = 0; s <= steps; s++) {
    const cand = Math.round(lo + (s / steps) * (hi - lo))
    const ev = evalAt(cand)
    if (ev > bestEv) {
      bestEv = ev
      bestP = cand
    }
  }
  return { bestP, bestEv }
}

const ARCTIC_SINKS: ReadonlySet<string> = new Set(["rovaniemi", "kemi"])
const NORTHERN_SINKS: ReadonlySet<string> = new Set([
  "oulu",
  "vaasa",
  "kokkola",
  "ylivieska",
  "kajaani",
  "joensuu",
])

export class PricingEngine {
  readonly level: number
  readonly map: MapGraph
  readonly snow: SnowTracker
  readonly supply: RosterSupplyModel
  readonly estimator: CompetitorMarketEstimator

  constructor(level: number, map: MapGraph, snow: SnowTracker, supply: RosterSupplyModel) {
    this.level = level
    this.map = map
    this.snow = snow
    this.supply = supply
    this.estimator = new CompetitorMarketEstimator(level, map.within80kmSet)
  }

  evaluateOption(
    request: PriceRequest,
    option: DeliveryOption,
    notes: readonly ParsedLegNote[],
    ctx: QuotePortfolioContext,
  ): EvaluatedOption | undefined {
    const plan = computeOptionPlan(this.map, this.snow, request.legs, notes, option.deadline, ctx.now)
    if (!plan) return undefined
    if (request.legs.length > 1 && !plan.canSingleGig) return undefined

    const pickupId = request.legs[0]!.pickup.placeId
    const deliveryId = request.legs[request.legs.length - 1]!.delivery.placeId
    const farPlaceId =
      request.legs.length === 2 && this.map.isSameCluster30(pickupId, deliveryId)
        ? request.legs[0]!.delivery.placeId
        : deliveryId
    const Q30 = this.supply.pool30(pickupId, plan.premiumAny, plan.manualRequired)
    const Q65 = this.supply.pool65(pickupId, plan.premiumAny, plan.manualRequired)
    const D_pool30 = this.supply.pool30(farPlaceId, false, false)
    const sameCluster30 = request.legs.length === 1 && this.map.isSameCluster30(pickupId, deliveryId) ? 1 : 0
    const open30 = ctx.openPickupsInCluster30(pickupId)
    const pending30 = ctx.pendingPickupsInCluster30 ? ctx.pendingPickupsInCluster30(pickupId) : 0

    let batchLoad = 0
    if (ctx.batchInfo && ctx.batchInfo.seenCount >= 12) {
      const expectedBatchWins = ctx.batchInfo.wonCount + ctx.batchInfo.unresolvedExpectedWins
      const localYardAllowance = Math.max(2.5, Math.min(26, 0.25 * Q30))
      const returnHubAllowance =
        D_pool30 >= 80 && plan.totalRoadKm <= 220 ? Math.min(10, 0.04 * D_pool30) : 0
      const effectiveBatchCap = localYardAllowance + returnHubAllowance
      batchLoad = expectedBatchWins / effectiveBatchCap

      if (batchLoad >= 1.40 && option.kind === "same_day") return undefined
      if (batchLoad >= 1.90 && D_pool30 < 80) return undefined
    }

    const roadHours = plan.totalRoadMinutes / HOUR
    const over4h = Math.max(0, roadHours - 4)
    const leadHours = Math.max(0.5, (plan.effectiveLastPickupAt - ctx.now) / HOUR)
    const pickDay = dayOf(plan.earliestPickupAt)
    const pickWd = weekdayOfDay(pickDay)

    const dlDay = dayOf(plan.effectiveDeadline)
    const dlWd = weekdayOfDay(dlDay)
    const dayCapMult = dlDay >= 7 ? 0.165 : dlWd === 4 ? 0.064 : 0.096
    const dayCap = Math.max(40, Math.round(this.supply.totalDrivers * dayCapMult))
    const dayOrders = ctx.activeOrdersOnDeadlineDay(dlDay)
    const dayLoad = dayOrders / dayCap
    if (dlWd === 4 && dayLoad >= 0.92 && option.kind === "same_day") return undefined
    if (dayLoad >= 1.05 && option.kind === "same_day") return undefined
    if (dayLoad >= 1.20) return undefined

    const hasPrivPick = plan.privatePickupCount > 0
    const isFri = pickWd === 4 && (dlDay === pickDay || hasPrivPick || dayLoad >= 0.82) ? 1 : 0
    const isSat = pickWd === 5 && (dlDay <= 6 || hasPrivPick || dayLoad >= 0.82) ? 1 : 0
    const isFluSameDay = ctx.fluActiveToday && dlDay === dayOf(ctx.now)
    const isFluShortageRollover = ctx.fluActiveToday && !isFluSameDay && this.supply.totalDrivers < 720

    if (plan.premiumAny && Q30 === 0 && (Q65 < 10 || leadHours < 12)) return undefined
    if (Q65 <= 3 && plan.totalRoadKm > 450 && leadHours < 36) return undefined
    if (plan.privateDeliveryCount > 0 && request.legs.length === 1 && (Q65 < 6 || leadHours < 3.5)) return undefined
    if (leadHours < 2.0 && Q30 < 25) return undefined

    const hubPoolThreshold = Math.min(80, Math.round(this.supply.totalDrivers * 0.095))
    const isArcticSink = ARCTIC_SINKS.has(farPlaceId)
    const isNorthernSink = NORTHERN_SINKS.has(farPlaceId)
    const isAnySink = isArcticSink || isNorthernSink
    const shortageFrac = Math.max(0, Math.min(1.1, (780 - this.supply.totalDrivers) / 135))
    const sinkEtaLift = !sameCluster30
      ? (isArcticSink ? 0.85 : isNorthernSink ? 0.35 : D_pool30 < 30 && plan.totalRoadKm > 220 ? 0.18 : 0) +
        (isAnySink && option.kind === "same_day" ? 0.35 : 0) +
        (plan.totalRoadKm > 300 && (isAnySink || D_pool30 < 25) && option.kind === "next_day" ? 0.55 : 0)
      : 0

    const etaLate =
      2.55 -
      0.82 * Math.log(Q30 + 1) +
      (Q30 === 0 ? 0.85 : 0) -
      0.16 * Math.log(D_pool30 + 1) +
      0.75 * sameCluster30 +
      0.12 * roadHours +
      0.48 * over4h -
      1.42 * Math.log(leadHours) +
      0.28 * isFri +
      0.55 * isSat +
      (request.legs.length === 1 && plan.privateDeliveryCount > 0 ? 0.60 : 0) +
      (request.legs.length === 2 ? 0.60 + (plan.totalRoadKm >= 220 ? 0.40 : 0) : 0) +
      (plan.needsChargingAny ? 0.50 : 0) +
      (plan.snowOverlap ? 0.38 : 0) +
      (isFluSameDay ? 0.32 : isFluShortageRollover ? 0.12 : 0) +
      0.30 * shortageFrac +
      sinkEtaLift +
      0.85 * Math.log(open30 + 1) +
      (dayLoad > 0.80 ? 1.4 * (dayLoad - 0.80) : 0) +
      (batchLoad > 0.65 ? 0.55 * (batchLoad - 0.65) : 0)

    const pLate = sigmoid(etaLate)

    const dealer = this.estimator.getDealer(request.dealerId)
    const progress = requestProgressFraction(ctx.now)
    const startProg = requestProgressFraction(ctx.startMinute ?? 0)
    const relProgress = Math.max(0, progress - startProg)

    const priorWeeklyReqs = dealer.totalRequestsSeen >= 4 ? 75 : 28
    const denomProg = Math.max(0.01, relProgress) + 0.05
    const estWeeklyReqs = (dealer.totalRequestsSeen + priorWeeklyReqs * 0.05) / denomProg
    const inFlightSameDealer = ctx.inFlightDealerOrders ? ctx.inFlightDealerOrders(request.dealerId) : 0
    const projTrust = Math.min(25, dealer.trust + Math.round(inFlightSameDealer))
    const isVipFranchise =
      this.level === 8 && (estWeeklyReqs >= 55 || dealer.trust >= 8 || projTrust >= 10)

    const effDeliveredTotal = ctx.deliveredOrdersTotal + (ctx.overdueUndeliveredCount ?? 0)
    const currentOnTime = (ctx.deliveredOnTimeTotal + 38) / (effDeliveredTotal + 40)
    let maxAllowedPLate =
      currentOnTime < 0.912 ? 0.018 :
      currentOnTime < 0.924 ? 0.045 :
      currentOnTime < 0.940 ? 0.090 : 0.135

    if (isVipFranchise && progress < 0.88 && option.kind === "same_day" && request.options.length > 1) {
      maxAllowedPLate = Math.min(maxAllowedPLate, projTrust >= 12 ? 0.058 : 0.072)
    }
    if (pLate > maxAllowedPLate) return undefined

    let feeMult = 0.89
    if (
      D_pool30 >= hubPoolThreshold &&
      Q30 >= 40 &&
      !plan.premiumAny &&
      plan.privatePickupCount === 0 &&
      plan.privateDeliveryCount === 0 &&
      plan.totalRoadKm <= 240
    ) {
      feeMult -= 0.04
    }
    if (!sameCluster30) {
      if (isArcticSink) {
        feeMult += 0.28 + 0.05 * Math.min(1.5, Math.max(0, plan.totalRoadKm - 220) / 300)
      } else if (isNorthernSink) {
        const scarcityAdd = D_pool30 <= 5 ? 0.04 : D_pool30 <= 15 ? 0.02 : 0
        feeMult += 0.08 + scarcityAdd + 0.03 * Math.min(1.2, Math.max(0, plan.totalRoadKm - 220) / 220)
      } else if (D_pool30 <= 5) {
        feeMult += 0.08
      } else if (D_pool30 <= 15) {
        feeMult += 0.04
      } else if (D_pool30 < 65 && plan.totalRoadKm > 220) {
        feeMult += 0.04
      }
      if (isAnySink && shortageFrac > 0) feeMult += 0.05 * shortageFrac
    }

    if (Q30 === 0) feeMult += 0.12
    else if (Q30 <= 5) feeMult += 0.07
    else if (Q30 <= 15) feeMult += 0.03

    if (plan.totalRoadKm > 260) feeMult += D_pool30 >= hubPoolThreshold ? 0.02 : 0.06
    if (plan.privatePickupCount > 0 && request.legs.length === 1) feeMult += 0.15
    if (plan.privateDeliveryCount > 0 && request.legs.length === 1) feeMult += 0.17
    if (request.legs.length === 2) feeMult += 0.20
    if (plan.premiumAny) feeMult += 0.19
    if (plan.needsChargingAny) feeMult += 0.08
    if (plan.needsPlatesAny || plan.manualRequired) feeMult += 0.04
    if (isFri || isSat) feeMult += 0.07
    if (over4h > 0) feeMult += (D_pool30 >= hubPoolThreshold ? 0.02 : 0.035) * over4h
    if (plan.snowOverlap) feeMult += 0.14
    if (isFluSameDay) feeMult += 0.10
    if (batchLoad > 0.65) feeMult += 0.08 * (batchLoad - 0.65)

    const pEscalate = sigmoid(etaLate + 1.10)
    feeMult += pEscalate * 0.34

    if (
      plan.totalRoadMinutes <= 250 &&
      !isArcticSink &&
      ctx.hasArrivingDriverSynergy(pickupId, deliveryId, plan.earliestPickupAt - 60, plan.effectiveLastPickupAt)
    ) {
      feeMult -= 0.14
    } else if (
      request.legs.length === 1 &&
      plan.totalRoadMinutes <= 215 &&
      !plan.premiumAny &&
      plan.privatePickupCount === 0 &&
      plan.privateDeliveryCount === 0
    ) {
      const rtCredit = ctx.roundTripPartnerCredit(
        pickupId,
        deliveryId,
        plan.earliestPickupAt,
        plan.effectiveLastPickupAt,
        plan.effectiveDeadline,
      )
      if (rtCredit > 0) {
        feeMult -= 0.12 * Math.min(1, rtCredit)
      }
    }

    feeMult = Math.max(0.74, feeMult)
    const expectedDriverFee = request.referenceFeeCents * feeMult

    const delivProgress = Math.min(1.0, requestProgressFraction(plan.effectiveDeadline))
    const remWinsAfterDeliv = Math.max(0, (1 - delivProgress) * estWeeklyReqs * 0.38)
    let halveUnits = 0
    if (this.level === 8 && projTrust >= 2 && remWinsAfterDeliv > 0.2) {
      const tAtDeliv = Math.min(25, projTrust)
      const tHalf = Math.floor(tAtDeliv / 2)
      const steps = Math.min(35, Math.round(remWinsAfterDeliv))
      for (let k = 0; k < steps; k++) {
        halveUnits += Math.min(25, tAtDeliv + k) - Math.min(25, tHalf + k)
      }
    }
    const healWins = Math.min(8, remWinsAfterDeliv)
    const satLossUnits = this.level >= 4 && dealer.lateCount < 5.8 ? 0.5 * healWins * 4.05 : 0
    const franchiseLossCents = Math.min(16500, Math.round((halveUnits + satLossUnits) * 102))
    const expectedRiskCost = pLate * (0.35 * option.listPriceCents * 1.45 + franchiseLossCents)
    const trueCostCents = expectedDriverFee + expectedRiskCost

    const drv = this.supply.totalDrivers
    const baseTargetWeekly =
      this.level >= 7
        ? Math.max(275, Math.min(445, Math.round(drv * (0.42 + 0.00016 * Math.max(0, drv - 690)))))
        : Math.max(450, Math.min(640, Math.round(drv * 0.26)))

    const softBacklog = Math.max(10, drv * 0.030)
    const backlogExcess = Math.max(0, (ctx.unbookedOrdersCount - softBacklog) / 16)
    const healthMult =
      this.level >= 7
        ? Math.max(
            0.86,
            Math.min(
              1.08,
              1.0 +
                0.08 * Math.max(0, Math.min(1, (currentOnTime - 0.955) / 0.025)) * Math.max(0, 1 - backlogExcess) -
                0.10 * Math.min(1.4, backlogExcess) -
                (currentOnTime < 0.942 ? 2.8 * (0.942 - currentOnTime) : 0) -
                (ctx.fluActiveToday && this.supply.totalDrivers < 720 ? 0.04 : 0),
            ),
          )
        : 1.0
    const targetWeekly = Math.round(baseTargetWeekly * healthMult)
    const expectedWonNow = targetWeekly * relProgress
    const paceRatio = (ctx.wonOrdersTotal + 16) / (expectedWonNow + 16)

    const localSat = (open30 + 0.5 * pending30) / Math.max(2.5, Q30 * 0.28)
    const daySat = Math.max(0, dayLoad - 0.64)
    const batchSat = Math.max(0, batchLoad - 0.55)

    let shadowMult =
      0.20 * Math.max(0, paceRatio - 0.72) +
      0.34 * Math.max(0, paceRatio - 1.02) +
      0.24 * backlogExcess * backlogExcess +
      0.22 * localSat * localSat +
      0.52 * daySat * daySat +
      0.32 * batchSat * batchSat
    if (isFluSameDay) shadowMult += 0.06
    if (leadHours < 5) shadowMult *= 1.18

    const slotShadowUnitCents = 520 + Math.round(135 * roadHours + 0.24 * request.referenceFeeCents)
    const refShadowCents =
      this.level >= 7
        ? Math.round(slotShadowUnitCents * Math.min(1.45, shadowMult * 1.45))
        : Math.round(request.referenceFeeCents * Math.min(0.65, shadowMult))

    let trustBonusCents = 0
    if (
      this.level === 8 &&
      !this.estimator.priceWarToday &&
      projTrust < 25 &&
      pLate <= 0.030 &&
      delivProgress < 0.78 &&
      paceRatio < 1.05
    ) {
      const gainUnits = Math.min(25 - projTrust, remWinsAfterDeliv)
      const optBonusCap = option.kind === "same_day" ? 420 : 280
      trustBonusCents = Math.min(
        optBonusCap,
        Math.round(request.referenceFeeCents * 0.18),
        Math.round(gainUnits * 36),
      )
    }

    const baseEffectiveCostCents = Math.max(
      request.referenceFeeCents * 0.65,
      Math.max(request.referenceFeeCents * 0.78, trueCostCents + refShadowCents) - trustBonusCents,
    )

    return {
      option,
      plan,
      trueCostCents,
      baseEffectiveCostCents,
      paceRatio,
      dayLoad,
      pLate,
    }
  }

  private computeOptionMenuBounds(
    request: PriceRequest,
    ev: EvaluatedOption,
    tildeCNdCents: number,
  ): OptionMenuBounds {
    const targetScale = tildeCNdCents * optionMultiplier(ev.option.kind)
    const dayIdx = dayOf(request.arrivedAt)
    const tod = request.arrivedAt % DAY
    const inHours = tod >= 8 * HOUR && tod <= 18 * HOUR
    const normalScale =
      inHours && this.level === 8 && this.estimator.priceWarToday ? targetScale / 0.80 : targetScale

    const pickupId = request.legs[0]!.pickup.placeId
    const inOutageZone = Boolean(
      inHours &&
        this.estimator.outageCenterToday &&
        this.map.within80kmSet.get(this.estimator.outageCenterToday)?.has(pickupId),
    )
    const d = this.estimator.getDealer(request.dealerId)
    const last12 = d.priorOutcomes.slice(-12)
    const recentDealerWinRate =
      last12.length >= 8 ? last12.reduce((a, b) => a + b, 0) / last12.length : 0.40
    const antiRetalShadow =
      !inOutageZone && dayIdx < 4 && recentDealerWinRate > 0.64
        ? Math.round(normalScale * Math.min(0.035, 0.14 * (recentDealerWinRate - 0.58) * (1 - 0.18 * dayIdx)))
        : 0

    const rawGrossMarginRatio = (normalScale - ev.trueCostCents) / Math.max(1, normalScale)
    const wideSpreadLift = rawGrossMarginRatio > 0.42 ? 0.32 * (rawGrossMarginRatio - 0.42) : 0
    const outageHarvestLift = inOutageZone ? 0.14 : 0
    const surplusFrac =
      this.level >= 7
        ? Math.min(
            0.72,
            Math.max(
              0,
              0.28 * Math.max(0, ev.paceRatio - 0.68) +
                0.38 * Math.max(0, ev.paceRatio - 1.00) +
                (ev.dayLoad > 0.70 ? 0.30 * (ev.dayLoad - 0.70) : 0) +
                wideSpreadLift +
                outageHarvestLift,
            ),
          )
        : 0
    const surplusShadow = surplusFrac * Math.max(0, normalScale - ev.trueCostCents)

    const pickWd = weekdayOfDay(dayOf(ev.plan.earliestPickupAt))
    const dlDay = dayOf(ev.plan.effectiveDeadline)
    const dlWd = weekdayOfDay(dlDay)

    const hiddenFriExecCost =
      dlWd === 4 && pickWd !== 4
        ? Math.round(request.referenceFeeCents * (0.065 + 0.11 * Math.max(0, ev.dayLoad - 0.55)))
        : 0

    const canBundleClean =
      request.legs.length === 1 &&
      !ev.plan.premiumAny &&
      ev.plan.privatePickupCount === 0 &&
      ev.plan.privateDeliveryCount === 0 &&
      ev.plan.totalRoadMinutes <= 240
    const sameDaySlackForfeit =
      ev.option.kind === "same_day"
        ? Math.round(
            request.referenceFeeCents *
              ((canBundleClean ? 0.055 : 0.02) + (ev.plan.totalRoadKm > 90 && pickWd !== 3 ? 0.03 : 0)),
          )
        : 0

    const inFlightD = Math.min(25, d.trust + (ev.option.kind === "within_3_days" ? 2 : 0))
    const trustDelayCost =
      ev.option.kind === "within_3_days" && this.level === 8 && inFlightD < 24 && dlDay < 7 && ev.plan.totalRoadKm < 300
        ? Math.min(280, Math.round(request.referenceFeeCents * 0.035 + 90))
        : 0

    const trueCost = ev.trueCostCents + hiddenFriExecCost
    const effCost =
      ev.baseEffectiveCostCents +
      surplusShadow +
      antiRetalShadow +
      hiddenFriExecCost +
      sameDaySlackForfeit +
      trustDelayCost

    const minMarginFloor =
      inHours && this.level === 8 && this.estimator.priceWarToday
        ? Math.max(650, Math.round(request.referenceFeeCents * 0.16))
        : 450
    const minP = Math.ceil(Math.max(trueCost + minMarginFloor, effCost + 120))
    const maxP = Math.max(minP + 500, Math.round(targetScale * 1.44))

    return { minP, maxP, effCost, trueCost, dlDay, dlWd, dayLoad: ev.dayLoad }
  }

  quoteRequest(
    request: PriceRequest,
    notes: readonly ParsedLegNote[],
    ctx: QuotePortfolioContext,
  ): RecordedQuoteMeta | undefined {
    const d = this.estimator.getDealer(request.dealerId)
    d.totalRequestsSeen++

    const legRoadKms = request.legs.map((l) => this.map.roadKm(l.pickup.placeId, l.delivery.placeId))

    if (this.level <= 3) {
      const firstOpt = request.options[0]
      if (!firstOpt) return undefined
      const ev = this.evaluateOption(request, firstOpt, notes, ctx)
      if (!ev || firstOpt.listPriceCents <= ev.trueCostCents + 200) return undefined
      return {
        request,
        legRoadKms,
        prices: { [firstOpt.kind]: firstOpt.listPriceCents },
        competitiveOptions: [firstOpt.kind],
        fasterOptionUnquoted: false,
        expectedWinProb: 1.0,
        expectedWinsByDeadlineDay: [{ deadlineDay: dayOf(ev.plan.effectiveDeadline), expectedWins: 1.0 }],
      }
    }

    const evals = new Map<OptKind, EvaluatedOption>()
    for (const opt of request.options) {
      const ev = this.evaluateOption(request, opt, notes, ctx)
      if (ev) evals.set(opt.kind, ev)
    }

    const hasSdOffered = request.options.some((o) => o.kind === "same_day")
    const hasNdOffered = request.options.some((o) => o.kind === "next_day")
    const has3dOffered = request.options.some((o) => o.kind === "within_3_days")

    const sdEv = evals.get("same_day")
    const ndEv = evals.get("next_day")
    const d3Ev = evals.get("within_3_days")

    if (!sdEv && !ndEv && !d3Ev) {
      const declineOpt = request.options[request.options.length - 1]!
      return {
        request,
        legRoadKms,
        prices: { [declineOpt.kind]: Math.round(declineOpt.listPriceCents * 7.0) },
        competitiveOptions: [],
        fasterOptionUnquoted: false,
        expectedWinProb: 0,
        expectedWinsByDeadlineDay: [],
      }
    }

    const pickupId = request.legs[0]!.pickup.placeId
    const deliveryId =
      request.legs.length > 1 ? request.legs[0]!.delivery.placeId : request.legs[request.legs.length - 1]!.delivery.placeId
    const probeNd = this.estimator.predictOption({
      arrivedAt: request.arrivedAt,
      dealerId: request.dealerId,
      pickupId,
      deliveryId,
      legRoadKms,
      refFeeCents: request.referenceFeeCents,
      opt: "next_day",
      fasterOptionUnquoted: false,
      quoteCents: Math.max(100, request.referenceFeeCents),
    })
    const tildeCNd = Math.max(1, probeNd.effMult * probeNd.compCents)

    const sdB = sdEv ? this.computeOptionMenuBounds(request, sdEv, tildeCNd) : undefined
    const ndB = ndEv ? this.computeOptionMenuBounds(request, ndEv, tildeCNd) : undefined
    const d3B = d3Ev ? this.computeOptionMenuBounds(request, d3Ev, tildeCNd) : undefined

    const evalMenuEv = (
      pSd: number | undefined,
      pNd: number | undefined,
      p3d: number | undefined,
    ): { r: MenuChoiceResult; ev: number } => {
      const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, pSd, pNd, p3d)
      let ev = 0
      if (pSd !== undefined && sdB) ev += r.winSd * (pSd - sdB.effCost)
      if (pNd !== undefined && ndB) ev += r.winNd * (pNd - ndB.effCost)
      if (p3d !== undefined && d3B) ev += r.win3d * (p3d - d3B.effCost)
      return { r, ev }
    }

    const optSolo = (
      kind: OptKind,
      b: OptionMenuBounds | undefined,
    ): { p: number; ev: number } | undefined => {
      if (!b) return undefined
      const { bestP, bestEv } = sweepMenuGrid(b.minP, b.maxP, 36, b.minP, (cand) => {
        const r = evaluateMenuChoice(
          hasSdOffered,
          hasNdOffered,
          has3dOffered,
          tildeCNd,
          kind === "same_day" ? cand : undefined,
          kind === "next_day" ? cand : undefined,
          kind === "within_3_days" ? cand : undefined,
        )
        const w = kind === "same_day" ? r.winSd : kind === "next_day" ? r.winNd : r.win3d
        return w * (cand - b.effCost)
      })
      return { p: bestP, ev: bestEv }
    }

    const soloSd = optSolo("same_day", sdB)
    const soloNd = optSolo("next_day", ndB)
    const solo3d = optSolo("within_3_days", d3B)

    let bestSd: number | undefined
    let bestNd: number | undefined
    let best3d: number | undefined
    let bestEv = -1e9
    let bestChoice: MenuChoiceResult = { pWin: 0, winSd: 0, winNd: 0, win3d: 0 }

    const considerMenu = (pSd: number | undefined, pNd: number | undefined, p3d: number | undefined): void => {
      const { r, ev } = evalMenuEv(pSd, pNd, p3d)
      if (ev > bestEv) {
        bestEv = ev
        bestSd = pSd
        bestNd = pNd
        best3d = p3d
        bestChoice = r
      }
    }

    if (soloNd) considerMenu(undefined, soloNd.p, undefined)
    if (!ndB && soloSd) considerMenu(soloSd.p, undefined, undefined)
    if (!ndB && !sdB && solo3d) considerMenu(undefined, undefined, solo3d.p)
    if (ndB && soloSd && ndB.dlWd === 4 && ndB.dayLoad >= 0.85) {
      considerMenu(soloSd.p, undefined, undefined)
    }

    if (sdB && ndB && soloNd) {
      const isThuFriBypass = sdB.dlWd === 3 && ndB.dlWd === 4
      const minSdSpread = isThuFriBypass
        ? Math.max(250, Math.round(sdB.trueCost - ndB.trueCost + 150))
        : Math.max(400, Math.round(sdB.effCost - ndB.effCost + 150))

      let curNd = soloNd.p
      const sdPctFloor = isThuFriBypass ? 0 : Math.round(curNd * 1.12)
      let curSd = Math.max(sdB.minP, curNd + minSdSpread, sdPctFloor)
      for (let pass = 0; pass < 2; pass++) {
        const dynPctFloor = isThuFriBypass ? 0 : Math.round(curNd * 1.12)
        const loSd = Math.max(sdB.minP, curNd + minSdSpread, dynPctFloor)
        const hiSd = Math.max(loSd + 200, sdB.maxP)
        curSd = sweepMenuGrid(loSd, hiSd, 28, curSd, (candSd) => {
          const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, candSd, curNd, undefined)
          return r.winSd * (candSd - sdB.effCost) + r.winNd * (curNd - ndB.effCost)
        }).bestP

        const loNd = ndB.minP
        const hiNdByPct = isThuFriBypass ? Infinity : Math.floor(curSd / 1.12)
        const hiNd = Math.min(ndB.maxP, curSd - minSdSpread, hiNdByPct)
        if (hiNd >= loNd) {
          curNd = sweepMenuGrid(loNd, hiNd, 28, curNd, (candNd) => {
            const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, curSd, candNd, undefined)
            return r.winSd * (curSd - sdB.effCost) + r.winNd * (candNd - ndB.effCost)
          }).bestP
        }
      }
      considerMenu(curSd, curNd, undefined)
    }

    if (d3B) {
      if (!ndB) {
        if (sdB && soloSd && solo3d && soloSd.p >= solo3d.p + 500) {
          considerMenu(soloSd.p, undefined, solo3d.p)
        } else if (solo3d) {
          considerMenu(undefined, undefined, solo3d.p)
        }
      } else if (
        d3B.dlWd !== 4 &&
        (ndB.effCost - d3B.effCost >= 260 ||
          ndB.dlWd === 4 ||
          Boolean(ndEv && ndEv.pLate >= 0.045 && (d.trust >= 10 || ndEv.plan.totalRoadKm >= 300))) &&
        soloNd
      ) {
        const baseEvWithout3d = bestEv
        const anchorSd = bestSd
        const isThuFriBypass3d = Boolean(sdB && sdB.dlWd === 3 && ndB.dlWd === 4)
        const minSdSpread =
          sdB && anchorSd !== undefined
            ? isThuFriBypass3d
              ? Math.max(250, Math.round(sdB.trueCost - ndB.trueCost + 150))
              : Math.max(400, Math.round(sdB.effCost - ndB.effCost + 150))
            : 0

        let curNd = bestNd ?? soloNd.p
        let cur3d = Math.min(d3B.maxP, curNd - 300)
        for (let pass = 0; pass < 2; pass++) {
          const lo3 = d3B.minP
          const hi3 = Math.min(d3B.maxP, curNd - 300)
          if (hi3 < lo3) break
          cur3d = sweepMenuGrid(lo3, hi3, 24, cur3d, (cand3) => {
            const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, anchorSd, curNd, cand3)
            return (
              (anchorSd !== undefined && sdB ? r.winSd * (anchorSd - sdB.effCost) : 0) +
              r.winNd * (curNd - ndB.effCost) +
              r.win3d * (cand3 - d3B.effCost)
            )
          }).bestP

          const loNd = Math.max(ndB.minP, cur3d + 300)
          const hiNdByPct = anchorSd !== undefined && !isThuFriBypass3d ? Math.floor(anchorSd / 1.12) : Infinity
          const hiNd = anchorSd !== undefined ? Math.min(ndB.maxP, anchorSd - minSdSpread, hiNdByPct) : ndB.maxP
          if (hiNd >= loNd) {
            curNd = sweepMenuGrid(loNd, hiNd, 24, curNd, (candNd) => {
              const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, anchorSd, candNd, cur3d)
              return (
                (anchorSd !== undefined && sdB ? r.winSd * (anchorSd - sdB.effCost) : 0) +
                r.winNd * (candNd - ndB.effCost) +
                r.win3d * (cur3d - d3B.effCost)
              )
            }).bestP
          }
        }

        let finalSd = anchorSd
        if (sdB && finalSd !== undefined) {
          const dynPctFloor = isThuFriBypass3d ? 0 : Math.round(curNd * 1.12)
          const loSd = Math.max(sdB.minP, curNd + minSdSpread, dynPctFloor)
          const hiSd = Math.max(loSd + 200, sdB.maxP)
          finalSd = sweepMenuGrid(loSd, hiSd, 24, finalSd, (candSd) => {
            const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, candSd, curNd, cur3d)
            return (
              r.winSd * (candSd - sdB.effCost) +
              r.winNd * (curNd - ndB.effCost) +
              r.win3d * (cur3d - d3B.effCost)
            )
          }).bestP
        }

        if (cur3d >= d3B.minP && cur3d <= curNd - 300) {
          const { r, ev } = evalMenuEv(finalSd, curNd, cur3d)
          if (ev >= baseEvWithout3d + 25) {
            bestEv = ev
            bestSd = finalSd
            bestNd = curNd
            best3d = cur3d
            bestChoice = r
          }
        }
      }
    }

    const prices: Partial<Record<OptKind, number>> = {}
    const competitiveOptions: OptKind[] = []
    if (bestNd !== undefined) {
      prices.next_day = bestNd
      competitiveOptions.push("next_day")
    }
    if (bestSd !== undefined) {
      prices.same_day = bestSd
      competitiveOptions.push("same_day")
    }
    if (best3d !== undefined) {
      prices.within_3_days = best3d
      competitiveOptions.push("within_3_days")
    }

    if (competitiveOptions.length === 0) {
      const declineOpt = request.options[request.options.length - 1]!
      prices[declineOpt.kind] = Math.round(declineOpt.listPriceCents * 7.0)
      return {
        request,
        legRoadKms,
        prices,
        competitiveOptions: [],
        fasterOptionUnquoted: false,
        expectedWinProb: 0,
        expectedWinsByDeadlineDay: [],
      }
    }

    const fastestOffered = request.options[0]!.kind
    const fasterOptionUnquoted = !competitiveOptions.includes(fastestOffered)

    const byDay = new Map<number, number>()
    if (bestSd !== undefined && sdB && bestChoice.winSd > 0) {
      byDay.set(sdB.dlDay, (byDay.get(sdB.dlDay) ?? 0) + bestChoice.winSd)
    }
    if (bestNd !== undefined && ndB && bestChoice.winNd > 0) {
      byDay.set(ndB.dlDay, (byDay.get(ndB.dlDay) ?? 0) + bestChoice.winNd)
    }
    if (best3d !== undefined && d3B && bestChoice.win3d > 0) {
      byDay.set(d3B.dlDay, (byDay.get(d3B.dlDay) ?? 0) + bestChoice.win3d)
    }
    const expectedWinsByDeadlineDay = [...byDay.entries()].map(([deadlineDay, expectedWins]) => ({
      deadlineDay,
      expectedWins,
    }))

    return {
      request,
      legRoadKms,
      prices,
      competitiveOptions,
      fasterOptionUnquoted,
      expectedWinProb: Math.min(0.98, bestChoice.pWin),
      expectedWinsByDeadlineDay,
    }
  }
}
