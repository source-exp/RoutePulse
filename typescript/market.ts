import { computeOptionPlan, DAY, HOUR } from "./planner.ts"
import type { MapGraph, OptionPlan, SnowTracker } from "./planner.ts"
import type { ParsedLegNote } from "./notes.ts"
import type { DeliveryOption, DriverProfile, PriceRequest } from "./types.ts"

export type OptKind = DeliveryOption["kind"]

export const PLACE_ALPHA_PICK: Record<string, number> = {
  helsinki: -0.038, espoo: -0.032, vantaa: -0.041, tampere: -0.018, oulu: 0.022,
  turku: -0.012, jyvaskyla: 0.014, lahti: -0.008, vaasa: 0.028, kuopio: 0.021,
  lappeenranta: 0.018, hameenlinna: -0.004, seinajoki: 0.020, hyvinkaa: -0.025, joensuu: 0.035,
  porvoo: -0.010, mikkeli: 0.019, kokkola: 0.034, rovaniemi: 0.052, pori: 0.016,
  raisio: -0.010, ylivieska: 0.036, rauma: 0.018, salo: -0.006, kouvola: 0.015,
  kotka: 0.022, savonlinna: 0.038, kajaani: 0.045, lempaala: -0.014, kemi: 0.048,
}

export const PLACE_ALPHA_DELIV: Record<string, number> = {
  helsinki: -0.072, espoo: -0.058, vantaa: -0.068, tampere: -0.024, oulu: 0.034,
  turku: -0.015, jyvaskyla: 0.031, lahti: -0.005, vaasa: 0.058, kuopio: 0.045,
  lappeenranta: 0.038, hameenlinna: 0.012, seinajoki: 0.042, hyvinkaa: -0.042, joensuu: 0.074,
  porvoo: -0.008, mikkeli: 0.049, kokkola: 0.078, rovaniemi: 0.118, pori: 0.041,
  raisio: -0.009, ylivieska: 0.082, rauma: 0.044, salo: 0.006, kouvola: 0.052,
  kotka: 0.066, savonlinna: 0.089, kajaani: 0.106, lempaala: -0.016, kemi: 0.112,
}

export function sigmoid(z: number): number {
  return z > 30 ? 1 : z < -30 ? 0 : 1 / (1 + Math.exp(-z))
}

/** Exact unrounded list price in cents (0/91,015 rounding mismatches). */
export function unroundedListPriceCents(legRoadKms: readonly number[], opt: OptKind): number {
  const optMult = opt === "same_day" ? 1.08 : opt === "within_3_days" ? 0.93 : 1.0
  const legMult = legRoadKms.length === 2 ? 0.85 : 1.0
  const base = legRoadKms.reduce((s, km) => s + (2000 + 25 * km), 0)
  return base * legMult * optMult
}

export function centeredLogKm(legRoadKms: readonly number[]): number {
  const totalKm = Math.max(12, legRoadKms.reduce((a, b) => a + b, 0))
  return Math.log(totalKm / 105)
}

export function logLaneFactor(
  pickupId: string,
  deliveryId: string,
  legRoadKms: readonly number[],
  refFeeCents: number,
  ulpNextDayCents: number,
): number {
  const aP = PLACE_ALPHA_PICK[pickupId] ?? 0
  const aD = PLACE_ALPHA_DELIV[deliveryId] ?? 0
  const totalKm = legRoadKms.reduce((a, b) => a + b, 0)
  // Across all 50 worlds, <=45km hops have a persistent +13% fixed-overhead competitor lift
  const shortHopLift = totalKm < 48 ? 0.13 * Math.min(1, (48 - totalKm) / 34) : 0
  return aP + aD + shortHopLift - 0.020 * (Math.log(Math.max(1, refFeeCents) / Math.max(1, ulpNextDayCents)) + 0.082)
}

export function winProbability(x: number, fasterOptionUnquoted: boolean): { p: number; dp_dx: number } {
  const s1 = x >= 0 ? 13.0 : 9.8
  const p1 = sigmoid(-s1 * x)
  let p = p1
  let dp_dx = -s1 * p1 * (1 - p1)
  if (fasterOptionUnquoted) {
    const p2 = sigmoid(-0.080 - 4.50 * x)
    const dp2 = -4.50 * p2 * (1 - p2)
    dp_dx = dp_dx * p2 + p * dp2
    p *= p2
  }
  return { p, dp_dx }
}

export type TownCounts = {
  all: number
  exp: number
  man: number
  expMan: number
}

export class RosterSupplyModel {
  readonly map: MapGraph
  drivers: DriverProfile[] = []
  readonly byId = new Map<string, DriverProfile>()
  readonly homeCounts = new Map<string, TownCounts>()
  readonly pool30Counts = new Map<string, TownCounts>()
  readonly pool65Counts = new Map<string, TownCounts>()

  constructor(map: MapGraph, roster: DriverProfile[] = []) {
    this.map = map
    this.updateRoster(roster)
  }

  updateRoster(roster: DriverProfile[]): void {
    this.drivers = roster
    this.byId.clear()
    this.homeCounts.clear()
    this.pool30Counts.clear()
    this.pool65Counts.clear()

    const empty = (): TownCounts => ({ all: 0, exp: 0, man: 0, expMan: 0 })
    for (const placeId of this.map.placesById.keys()) {
      this.homeCounts.set(placeId, empty())
      this.pool30Counts.set(placeId, empty())
      this.pool65Counts.set(placeId, empty())
    }

    for (const d of roster) {
      this.byId.set(d.id, d)
      const isExp = d.rating >= 4.8 && d.completedGigs >= 50
      const isMan = d.licence === "manual"
      const h = this.homeCounts.get(d.homePlaceId)
      if (h) {
        h.all++
        if (isExp) h.exp++
        if (isMan) h.man++
        if (isExp && isMan) h.expMan++
      }
    }

    for (const [placeId, n30] of this.map.within30km.entries()) {
      const c30 = this.pool30Counts.get(placeId)!
      for (const q of n30) {
        const h = this.homeCounts.get(q)
        if (!h) continue
        c30.all += h.all
        c30.exp += h.exp
        c30.man += h.man
        c30.expMan += h.expMan
      }
    }

    for (const [placeId, n65] of this.map.within65km.entries()) {
      const c65 = this.pool65Counts.get(placeId)!
      for (const q of n65) {
        const h = this.homeCounts.get(q)
        if (!h) continue
        c65.all += h.all
        c65.exp += h.exp
        c65.man += h.man
        c65.expMan += h.expMan
      }
    }
  }

  get totalDrivers(): number {
    return this.drivers.length || 782
  }

  homeDrivers(placeId: string): number {
    return this.homeCounts.get(placeId)?.all ?? 0
  }

  pool30(placeId: string, experienced = false, manual = false): number {
    const c = this.pool30Counts.get(placeId)
    if (!c) return 0
    if (experienced && manual) return c.expMan
    if (experienced) return c.exp
    if (manual) return c.man
    return c.all
  }

  pool65(placeId: string, experienced = false, manual = false): number {
    const c = this.pool65Counts.get(placeId)
    if (!c) return 0
    if (experienced && manual) return c.expMan
    if (experienced) return c.exp
    if (manual) return c.man
    return c.all
  }
}

export type DealerState = {
  trust: number
  lateCount: number
  unquotedCount: number
  totalRequestsSeen: number
  priorOutcomes: number[]
  morningRetalLog: number
  latentLogOffset: number
  obsInfo: number
}

export type RecordedQuoteMeta = {
  request: PriceRequest
  legRoadKms: number[]
  prices: Partial<Record<OptKind, number>>
  competitiveOptions: OptKind[]
  fasterOptionUnquoted: boolean
}

export class CompetitorMarketEstimator {
  readonly level: number
  readonly within80Map: Map<string, Set<string>>
  readonly minWorldLog: number
  readonly maxWorldLog: number

  worldLogMean: number
  worldPrecision: number
  dayLogOffset = 0
  dayPrecision = 1 / (0.055 ** 2)
  /** Online learner for the competitor's distance-tilt shape (HANDBOOK: "short and long lanes move in opposite directions"). */
  distanceSlope = -0.03
  distanceSlopeInfo = 90
  currentDay = 0

  priceWarUsedThisWeek = false
  outageUsedThisWeek = false
  priceWarToday = false
  outageCenterToday: string | null = null

  todayQuotes = 0
  todayPwLLR = 0
  todayResWindow: number[] = []
  readonly regionOutStats = new Map<string, { nIn: number; llr: number; sumResIn: number; nOut: number; sumResOut: number }>()
  readonly dealers = new Map<string, DealerState>()

  constructor(level: number, within80Map: Map<string, Set<string>>) {
    this.level = level
    this.within80Map = within80Map
    if (level >= 8) {
      this.worldLogMean = Math.log(1.42)
      this.minWorldLog = Math.log(1.24)
      this.maxWorldLog = Math.log(1.58)
      this.worldPrecision = 1 / (0.065 ** 2)
    } else if (level === 7) {
      this.worldLogMean = Math.log(1.25)
      this.minWorldLog = Math.log(1.10)
      this.maxWorldLog = Math.log(1.42)
      this.worldPrecision = 1 / (0.060 ** 2)
    } else {
      this.worldLogMean = Math.log(1.00)
      this.minWorldLog = Math.log(0.88)
      this.maxWorldLog = Math.log(1.14)
      this.worldPrecision = 1 / (0.055 ** 2)
    }
  }

  getDealer(dealerId: string): DealerState {
    let d = this.dealers.get(dealerId)
    if (!d) {
      d = {
        trust: 0,
        lateCount: 0,
        unquotedCount: 0,
        totalRequestsSeen: 0,
        priorOutcomes: [],
        morningRetalLog: 0,
        latentLogOffset: 0,
        obsInfo: 25,
      }
      this.dealers.set(dealerId, d)
    }
    return d
  }

  onNewDay(day: number): void {
    if (day <= this.currentDay) return
    // Recover baseline worldLogMean if Monday had an unflagged Price War (-20% = -0.223 log drop)
    if (
      this.level === 8 &&
      this.currentDay === 0 &&
      !this.priceWarUsedThisWeek &&
      this.todayQuotes >= 15 &&
      (Math.exp(this.worldLogMean + this.dayLogOffset) < 1.24 || this.dayLogOffset <= -0.095)
    ) {
      this.priceWarUsedThisWeek = true
      this.worldLogMean = Math.min(
        this.maxWorldLog,
        Math.max(this.minWorldLog, this.worldLogMean + this.dayLogOffset - Math.log(0.80)),
      )
    }
    if (this.priceWarToday) this.priceWarUsedThisWeek = true
    if (this.outageCenterToday) this.outageUsedThisWeek = true

    this.currentDay = day
    this.dayLogOffset = 0
    this.dayPrecision = 1 / (0.055 ** 2)
    // Allow distanceSlope to adapt if the competitor shifts its distance curve mid-week
    this.distanceSlopeInfo = Math.max(70, this.distanceSlopeInfo * 0.55)
    this.priceWarToday = false
    this.outageCenterToday = null
    this.todayQuotes = 0
    this.todayPwLLR = 0
    this.todayResWindow = []
    this.regionOutStats.clear()

    for (const d of this.dealers.values()) {
      const last10 = d.priorOutcomes.slice(-10)
      if (last10.length >= 4) {
        const wr = last10.reduce((a, b) => a + b, 0) / last10.length
        d.morningRetalLog = Math.max(-0.030, Math.min(0.025, -0.045 * (wr - 0.35)))
      }
    }
  }

  onOrderDelivered(dealerId: string, onTime: boolean): void {
    const d = this.getDealer(dealerId)
    if (this.level === 8) {
      if (onTime) d.trust = Math.min(25, d.trust + 1)
      else d.trust = Math.floor(d.trust / 2)
    }
    if (!onTime) d.lateCount++
  }

  predictOption(params: {
    arrivedAt: number
    dealerId: string
    pickupId: string
    deliveryId: string
    legRoadKms: readonly number[]
    refFeeCents: number
    opt: OptKind
    fasterOptionUnquoted: boolean
    quoteCents: number
  }): { compCents: number; effMult: number; winProb: number } {
    this.onNewDay(Math.floor(params.arrivedAt / DAY))
    const tod = params.arrivedAt % DAY
    const inHours = tod >= 8 * HOUR && tod <= 18 * HOUR

    const ulp = unroundedListPriceCents(params.legRoadKms, params.opt)
    const ulpNext = unroundedListPriceCents(params.legRoadKms, "next_day")
    const zKm = centeredLogKm(params.legRoadKms)
    const d = this.getDealer(params.dealerId)

    let eventLog = 0
    if (inHours && this.level === 8 && this.priceWarToday) {
      eventLog += Math.log(0.80)
    } else if (
      inHours &&
      this.level >= 6 &&
      this.outageCenterToday &&
      this.within80Map.get(this.outageCenterToday)?.has(params.pickupId)
    ) {
      eventLog += Math.log(1.30)
    }

    const logC =
      this.worldLogMean +
      this.dayLogOffset +
      this.distanceSlope * zKm +
      eventLog +
      logLaneFactor(params.pickupId, params.deliveryId, params.legRoadKms, params.refFeeCents, ulpNext) +
      d.morningRetalLog +
      d.latentLogOffset

    const compCents = ulp * Math.exp(logC)
    const trustMult = this.level === 8 ? 1 + 0.01 * d.trust : 1.0
    const effMult =
      trustMult *
      Math.exp(-0.0405 * Math.min(d.lateCount, 6) - 0.0016 * Math.min(d.unquotedCount, 20))
    const x = Math.log(Math.max(1, params.quoteCents) / Math.max(1, effMult * compCents))
    const { p } = winProbability(x, params.fasterOptionUnquoted)
    return { compCents, effMult, winProb: p }
  }

  onQuoteResolved(meta: RecordedQuoteMeta, wonOption: OptKind | null): void {
    const req = meta.request
    this.onNewDay(Math.floor(req.arrivedAt / DAY))
    const y = wonOption !== null ? 1 : 0
    const d = this.getDealer(req.dealerId)
    d.priorOutcomes.push(y)

    if (meta.competitiveOptions.length === 0 && wonOption === null) return

    const evalOpt: OptKind =
      wonOption ??
      meta.competitiveOptions.reduce((best, cur) => {
        const rBest = (meta.prices[best] ?? Infinity) / unroundedListPriceCents(meta.legRoadKms, best)
        const rCur = (meta.prices[cur] ?? Infinity) / unroundedListPriceCents(meta.legRoadKms, cur)
        return rCur < rBest ? cur : best
      }, meta.competitiveOptions[0]!)

    const quoteCents = meta.prices[evalOpt]
    if (!quoteCents) return

    const pickupId = req.legs[0]!.pickup.placeId
    const deliveryId = req.legs[req.legs.length - 1]!.delivery.placeId
    const tod = req.arrivedAt % DAY
    const inHours = tod >= 8 * HOUR && tod <= 18 * HOUR
    const ulp = unroundedListPriceCents(meta.legRoadKms, evalOpt)
    const ulpNext = unroundedListPriceCents(meta.legRoadKms, "next_day")
    const zKm = centeredLogKm(meta.legRoadKms)

    if (quoteCents >= 2.45 * ulp && wonOption === null) return

    const trustMult = this.level === 8 ? 1 + 0.01 * d.trust : 1.0
    const effMult =
      trustMult *
      Math.exp(-0.0405 * Math.min(d.lateCount, 6) - 0.0016 * Math.min(d.unquotedCount, 20))

    const baseLogC =
      this.worldLogMean +
      this.dayLogOffset +
      this.distanceSlope * zKm +
      logLaneFactor(pickupId, deliveryId, meta.legRoadKms, req.referenceFeeCents, ulpNext) +
      d.morningRetalLog +
      d.latentLogOffset
    const xBase = Math.log(quoteCents / (effMult * ulp)) - baseLogC
    const base = winProbability(xBase, meta.fasterOptionUnquoted)
    const resBase = y - base.p

    if (inHours) {
      this.todayQuotes++
      this.todayResWindow.push(resBase)
      if (this.todayResWindow.length > 18) this.todayResWindow.shift()

      // 1. Strict Global Price War Detector (-20% everywhere, requires strong negative residual & LLR)
      if (this.level === 8 && !this.priceWarUsedThisWeek && !this.outageCenterToday) {
        const pw = winProbability(xBase - Math.log(0.80), meta.fasterOptionUnquoted)
        const llBase = y ? Math.log(base.p + 1e-9) : Math.log(1 - base.p + 1e-9)
        const llPw = y ? Math.log(pw.p + 1e-9) : Math.log(1 - pw.p + 1e-9)
        this.todayPwLLR = Math.max(0, this.todayPwLLR + (llPw - llBase))
        const meanRes = this.todayResWindow.reduce((a, b) => a + b, 0) / this.todayResWindow.length
        if (!this.priceWarToday && this.todayQuotes >= 16 && this.todayPwLLR >= 3.8 && meanRes <= -0.24) {
          this.priceWarToday = true
        } else if (this.priceWarToday && this.todayPwLLR < 0.8) {
          this.priceWarToday = false
        }
      }

      // 2. Strict Regional Outage Detector (+30% within 80km AND normal residuals outside 80km!)
      if (this.level >= 6 && !this.outageUsedThisWeek && !this.priceWarToday) {
        const outP = winProbability(xBase - Math.log(1.30), meta.fasterOptionUnquoted)
        const dLL =
          (y ? Math.log(outP.p + 1e-9) : Math.log(1 - outP.p + 1e-9)) -
          (y ? Math.log(base.p + 1e-9) : Math.log(1 - base.p + 1e-9))

        for (const [center, set] of this.within80Map.entries()) {
          let cur = this.regionOutStats.get(center)
          if (!cur) {
            cur = { nIn: 0, llr: 0, sumResIn: 0, nOut: 0, sumResOut: 0 }
            this.regionOutStats.set(center, cur)
          }
          if (set.has(pickupId)) {
            cur.nIn++
            cur.llr = Math.max(0, cur.llr + dLL)
            cur.sumResIn += resBase
          } else {
            cur.nOut++
            cur.sumResOut += resBase
          }
        }

        let bestCenter: string | null = null
        let bestLLR = 3.6
        for (const [center, st] of this.regionOutStats.entries()) {
          const meanIn = st.nIn > 0 ? st.sumResIn / st.nIn : 0
          const meanOut = st.nOut >= 5 ? st.sumResOut / st.nOut : 0
          if (st.nIn >= 8 && st.llr >= bestLLR && meanIn >= 0.24 && meanOut < 0.12) {
            bestLLR = st.llr
            bestCenter = center
          }
        }
        if (bestCenter) this.outageCenterToday = bestCenter
      }
    }

    let activeEventLog = 0
    if (inHours && this.level === 8 && this.priceWarToday) activeEventLog = Math.log(0.80)
    else if (
      inHours &&
      this.level >= 6 &&
      this.outageCenterToday &&
      this.within80Map.get(this.outageCenterToday)?.has(pickupId)
    ) {
      activeEventLog = Math.log(1.30)
    }

    const xAct = xBase - activeEventLog
    const { p, dp_dx } = winProbability(xAct, meta.fasterOptionUnquoted)
    const dp_dTheta = -dp_dx
    const denom = Math.max(1e-4, p * (1 - p))
    const grad = ((y - p) * dp_dTheta) / denom
    const info = (dp_dTheta * dp_dTheta) / denom

    const inOutageRegion = Boolean(this.outageCenterToday && this.within80Map.get(this.outageCenterToday)?.has(pickupId))
    if (!this.priceWarToday && !inOutageRegion) {
      const vW = 1 / this.worldPrecision
      const vD = 1 / this.dayPrecision
      const shareW = vW / (vW + vD)
      const shareD = vD / (vW + vD)
      this.worldLogMean = Math.min(
        this.maxWorldLog,
        Math.max(this.minWorldLog, this.worldLogMean + shareW * (grad / (this.worldPrecision + info))),
      )
      this.dayLogOffset = Math.max(-0.16, Math.min(0.16, this.dayLogOffset + shareD * (grad / (this.dayPrecision + info))))
      this.worldPrecision += 0.45 * info
      this.dayPrecision += 0.55 * info

      // Update distance-tilt slope online
      const gradSlope = grad * zKm
      const infoSlope = info * zKm * zKm
      this.distanceSlopeInfo += infoSlope
      this.distanceSlope = Math.max(-0.22, Math.min(0.22, this.distanceSlope + gradSlope / this.distanceSlopeInfo))
    }

    d.obsInfo += info
    d.latentLogOffset = Math.max(-0.06, Math.min(0.06, d.latentLogOffset + (0.25 * grad) / d.obsInfo))
  }
}

export type QuotePortfolioContext = {
  now: number
  wonOrdersTotal: number
  deliveredOrdersTotal: number
  deliveredOnTimeTotal: number
  unbookedOrdersCount: number
  openPickupsInCluster30: (placeId: string) => number
  activeOrdersOnDeadlineDay: (deadlineDay: number) => number
  hasArrivingDriverSynergy: (pickupId: string, deliveryId: string, earliestMin: number, latestMin: number) => boolean
  hasOpenRoundTripPartner: (pickupId: string, deliveryId: string) => boolean
  fluActiveToday: boolean
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

function requestProgressFraction(now: number): number {
  const workPerDay = 10 * HOUR
  const totalWeekWork = 5 * workPerDay
  const day = Math.min(5, Math.max(0, Math.floor(now / DAY)))
  if (day >= 5) return 1.0
  const tod = now % DAY
  const todayWork = Math.max(0, Math.min(workPerDay, tod - 8 * HOUR))
  return Math.min(1.0, (day * workPerDay + todayWork) / totalWeekWork)
}

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
    const Q30 = this.supply.pool30(pickupId, plan.premiumAny, plan.manualRequired)
    const Q65 = this.supply.pool65(pickupId, plan.premiumAny, plan.manualRequired)
    const D_home = this.supply.homeDrivers(deliveryId)
    const sameCluster30 = this.map.isSameCluster30(pickupId, deliveryId) ? 1 : 0
    const open30 = ctx.openPickupsInCluster30(pickupId)

    const roadHours = plan.totalRoadMinutes / HOUR
    const over4h = Math.max(0, roadHours - 4)
    const leadHours = Math.max(0.5, (plan.effectiveLastPickupAt - ctx.now) / HOUR)
    const pickDay = Math.floor(plan.earliestPickupAt / DAY)
    const pickWd = ((pickDay % 7) + 7) % 7
    const isFri = pickWd === 4 ? 1 : 0
    const isSat = pickWd === 5 ? 1 : 0

    // Deadline-day capacity guard (prevents Friday congestion crashes like spread-5!)
    const dlDay = Math.floor(plan.effectiveDeadline / DAY)
    const dlWd = ((dlDay % 7) + 7) % 7
    const dayCap = Math.max(
      40,
      Math.round(this.supply.totalDrivers * (dlWd === 4 ? 0.064 : 0.096)),
    )
    const dayOrders = ctx.activeOrdersOnDeadlineDay(dlDay)
    const dayLoad = dayOrders / dayCap
    if (dlWd === 4 && dayLoad >= 0.92 && option.kind === "same_day") return undefined
    if (dayLoad >= 1.05 && option.kind === "same_day") return undefined
    if (dayLoad >= 1.20) return undefined

    // Safety gates against zero-notification traps
    if (plan.premiumAny && Q30 === 0 && (Q65 < 10 || leadHours < 12)) return undefined
    if (plan.privateDeliveryCount > 0 && request.legs.length === 1 && (Q65 < 6 || leadHours < 3.5)) return undefined
    if (leadHours < 2.0 && Q30 < 25) return undefined

    const etaLate =
      2.55 -
      0.82 * Math.log(Q30 + 1) +
      (Q30 === 0 ? 0.85 : 0) -
      0.14 * Math.log(D_home + 1) +
      0.75 * sameCluster30 +
      0.12 * roadHours +
      0.48 * over4h -
      1.42 * Math.log(leadHours) +
      0.28 * isFri +
      0.55 * isSat +
      (request.legs.length === 1 && plan.privateDeliveryCount > 0 ? 0.60 : 0) +
      (plan.needsChargingAny ? 0.50 : 0) +
      (plan.snowOverlap ? 0.38 : 0) +
      (ctx.fluActiveToday ? 0.35 : 0) +
      0.85 * Math.log(open30 + 1) +
      (dayLoad > 0.80 ? 1.4 * (dayLoad - 0.80) : 0)

    const pLate = sigmoid(etaLate)

    // Smooth Beta-Binomial posterior on-time rate (prevents 2 early Monday late orders out of 18 from panic-clamping Tuesday!)
    const currentOnTime = (ctx.deliveredOnTimeTotal + 38) / (ctx.deliveredOrdersTotal + 40)
    const maxAllowedPLate =
      currentOnTime < 0.912 ? 0.018 :
      currentOnTime < 0.924 ? 0.048 :
      currentOnTime < 0.940 ? 0.095 : 0.135
    if (pLate > maxAllowedPLate) return undefined

    // Expected driver fee multiplier under lean m0 + 2-car bundling
    let feeMult = 0.89
    if (D_home >= 80 && Q30 >= 40 && !plan.premiumAny && plan.privatePickupCount === 0 && plan.privateDeliveryCount === 0 && plan.totalRoadKm <= 240) {
      feeMult -= 0.04
    }
    if (D_home <= 5 && !sameCluster30) feeMult += 0.08
    else if (D_home <= 15 && !sameCluster30) feeMult += 0.04

    if (Q30 === 0) feeMult += 0.12
    else if (Q30 <= 5) feeMult += 0.07
    else if (Q30 <= 15) feeMult += 0.03

    if (plan.totalRoadKm > 260) feeMult += 0.07
    if (plan.privatePickupCount > 0 && request.legs.length === 1) feeMult += 0.15
    if (plan.privateDeliveryCount > 0 && request.legs.length === 1) feeMult += 0.17
    if (request.legs.length === 2) feeMult += 0.15
    if (plan.premiumAny) feeMult += 0.19
    if (plan.needsChargingAny) feeMult += 0.08
    if (plan.needsPlatesAny || plan.manualRequired) feeMult += 0.04
    if (isFri || isSat) feeMult += 0.07
    if (over4h > 0) feeMult += 0.04 * over4h
    if (plan.snowOverlap) feeMult += 0.14
    if (ctx.fluActiveToday) feeMult += 0.12

    const pEscalate = sigmoid(etaLate + 1.10)
    feeMult += pEscalate * 0.34

    if (ctx.hasArrivingDriverSynergy(pickupId, deliveryId, plan.earliestPickupAt - 60, plan.effectiveLastPickupAt)) {
      feeMult -= 0.14
    } else if (
      request.legs.length === 1 &&
      !plan.premiumAny &&
      plan.privatePickupCount === 0 &&
      plan.privateDeliveryCount === 0 &&
      ctx.hasOpenRoundTripPartner(pickupId, deliveryId)
    ) {
      feeMult -= 0.12
    }

    feeMult = Math.max(0.74, feeMult)
    const expectedDriverFee = request.referenceFeeCents * feeMult

    const dealer = this.estimator.getDealer(request.dealerId)
    const trustLossPenaltyCents = this.level === 8 && dealer.trust >= 4 ? dealer.trust * 160 : 0
    const expectedRiskCost = pLate * (0.35 * option.listPriceCents * 1.45 + trustLossPenaltyCents)
    const trueCostCents = expectedDriverFee + expectedRiskCost

    // Portfolio pace & local congestion shadow price (neutral 1.00 prior at t=0 so Monday morning never dumps!)
    const progress = requestProgressFraction(ctx.now)
    const targetWeekly =
      this.level >= 7
        ? Math.max(270, Math.min(365, Math.round(this.supply.totalDrivers * 0.41)))
        : Math.max(450, Math.min(620, Math.round(this.supply.totalDrivers * 0.25)))
    const expectedWonNow = targetWeekly * progress
    const paceRatio = (ctx.wonOrdersTotal + 14) / (expectedWonNow + 14)

    const softBacklog = Math.max(10, this.supply.totalDrivers * 0.028)
    const backlogExcess = Math.max(0, (ctx.unbookedOrdersCount - softBacklog) / 18)
    const localSat = open30 / Math.max(2.0, Q30 * 0.26)
    const daySat = Math.max(0, dayLoad - 0.62)

    let shadowMult =
      0.18 * Math.max(0, paceRatio - 0.58) +
      0.20 * backlogExcess * backlogExcess +
      0.20 * localSat * localSat +
      0.48 * daySat * daySat
    if (ctx.fluActiveToday) shadowMult += 0.10
    if (leadHours < 5) shadowMult *= 1.20

    const refShadowCents = request.referenceFeeCents * Math.min(0.85, shadowMult)

    // Mild Level-8 Dealer Trust acquisition nudge on ultra-safe early-week orders (never during Price War!)
    let trustBonusCents = 0
    if (
      this.level === 8 &&
      !this.estimator.priceWarToday &&
      dealer.trust < 25 &&
      pLate <= 0.028 &&
      progress < 0.65 &&
      paceRatio < 1.02
    ) {
      const obsRate = progress > 0.04 ? dealer.totalRequestsSeen / progress : 20
      const remDealerWins = Math.max(0, (1 - progress) * obsRate * 0.34)
      trustBonusCents = Math.min(260, request.referenceFeeCents * 0.04, Math.round(remDealerWins * 18))
    }

    const baseEffectiveCostCents = Math.max(
      request.referenceFeeCents * 0.78,
      trueCostCents + refShadowCents - trustBonusCents,
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

  optimizeOptionPrice(
    request: PriceRequest,
    ev: EvaluatedOption,
    legRoadKms: readonly number[],
    fasterOptionUnquoted: boolean,
  ): { priceCents: number; expectedMargin: number; winProb: number } | undefined {
    const pickupId = request.legs[0]!.pickup.placeId
    const deliveryId = request.legs[request.legs.length - 1]!.delivery.placeId
    const probe = this.estimator.predictOption({
      arrivedAt: request.arrivedAt,
      dealerId: request.dealerId,
      pickupId,
      deliveryId,
      legRoadKms,
      refFeeCents: request.referenceFeeCents,
      opt: ev.option.kind,
      fasterOptionUnquoted,
      quoteCents: ev.option.listPriceCents,
    })

    const targetScale = probe.effMult * probe.compCents
    // During a Price War (0.80x), weekly driver capacity keeps its NORMAL 4-day opportunity value — do not dump!
    const tod = request.arrivedAt % DAY
    const inHours = tod >= 8 * HOUR && tod <= 18 * HOUR
    const normalScale =
      inHours && this.level === 8 && this.estimator.priceWarToday ? targetScale / 0.80 : targetScale

    const d = this.estimator.getDealer(request.dealerId)
    const last12 = d.priorOutcomes.slice(-12)
    const recentDealerWinRate =
      last12.length >= 8 ? last12.reduce((a, b) => a + b, 0) / last12.length : 0.40
    const antiRetalShadow = recentDealerWinRate > 0.65 ? Math.round(normalScale * 0.032) : 0

    const surplusFrac =
      this.level >= 7
        ? Math.min(0.50, Math.max(0, 0.35 * (ev.paceRatio - 0.64) + (ev.dayLoad > 0.72 ? 0.28 * (ev.dayLoad - 0.72) : 0)))
        : 0
    const surplusShadow = surplusFrac * Math.max(0, normalScale - ev.trueCostCents)
    const effectiveCost = ev.baseEffectiveCostCents + surplusShadow + antiRetalShadow

    const minMarginFloor =
      inHours && this.level === 8 && this.estimator.priceWarToday
        ? Math.max(650, Math.round(request.referenceFeeCents * 0.16))
        : 450
    const minHardPrice = Math.ceil(Math.max(ev.trueCostCents + minMarginFloor, effectiveCost + 120))
    const maxSearchPrice = Math.max(minHardPrice + 500, Math.round(targetScale * 1.42))

    let bestPrice = 0
    let bestObj = -1
    let bestWinProb = 0

    const steps = 48
    for (let s = 0; s <= steps; s++) {
      const frac = s / steps
      const cand = Math.round(minHardPrice + frac * (maxSearchPrice - minHardPrice))
      const pred = this.estimator.predictOption({
        arrivedAt: request.arrivedAt,
        dealerId: request.dealerId,
        pickupId,
        deliveryId,
        legRoadKms,
        refFeeCents: request.referenceFeeCents,
        opt: ev.option.kind,
        fasterOptionUnquoted,
        quoteCents: cand,
      })
      const obj = pred.winProb * (cand - effectiveCost)
      if (obj > bestObj) {
        bestObj = obj
        bestPrice = cand
        bestWinProb = pred.winProb
      }
    }

    if (bestPrice <= 0) {
      return undefined
    }
    // Never replace a safe (pLate <= maxAllowedPLate) positive-surplus quote with a 3.0x hard decline!
    // Even if winProb is 1%, winning at minHardPrice yields positive surplus over effectiveCost, and losing costs €0.
    return { priceCents: bestPrice, expectedMargin: Math.max(1, bestObj), winProb: bestWinProb }
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
      }
    }

    const evals = new Map<OptKind, EvaluatedOption>()
    for (const opt of request.options) {
      const ev = this.evaluateOption(request, opt, notes, ctx)
      if (ev) evals.set(opt.kind, ev)
    }

    const hasSameDayOffered = request.options.some((o) => o.kind === "same_day")
    const hasNextDayOffered = request.options.some((o) => o.kind === "next_day")

    const prices: Partial<Record<OptKind, number>> = {}
    const competitiveOptions: OptKind[] = []

    const sdEv = evals.get("same_day")
    const ndEv = evals.get("next_day")
    const d3Ev = evals.get("within_3_days")

    const sdOpt = sdEv ? this.optimizeOptionPrice(request, sdEv, legRoadKms, false) : undefined
    const fasterUnquotedForNd = hasSameDayOffered && !sdOpt
    const ndOpt = ndEv ? this.optimizeOptionPrice(request, ndEv, legRoadKms, fasterUnquotedForNd) : undefined
    const fasterUnquotedFor3d = (hasSameDayOffered && !sdOpt) || (hasNextDayOffered && !ndOpt)
    const d3Opt = d3Ev ? this.optimizeOptionPrice(request, d3Ev, legRoadKms, fasterUnquotedFor3d) : undefined

    if (ndOpt && ndEv) {
      prices.next_day = ndOpt.priceCents
      competitiveOptions.push("next_day")
    }

    if (sdOpt && sdEv) {
      let sdPrice = sdOpt.priceCents
      if (prices.next_day !== undefined && ndEv) {
        // Charge a healthy speed premium (+13% & >=€4.50) on same_day over next_day:
        // urgent dealers pay extra for same_day, while flexible dealers select next_day (giving 24h slack + bundling)!
        const minSpread = Math.max(450, Math.round(sdEv.trueCostCents - ndEv.trueCostCents + 250))
        sdPrice = Math.max(
          Math.round(sdOpt.priceCents * 1.04),
          Math.round(prices.next_day * 1.13),
          prices.next_day + minSpread,
        )
      }
      prices.same_day = sdPrice
      competitiveOptions.push("same_day")
    }

    if (d3Opt && d3Ev) {
      if (prices.next_day === undefined) {
        prices.within_3_days = d3Opt.priceCents
        competitiveOptions.push("within_3_days")
      } else if (ndEv) {
        const equalMargin3d = Math.round(prices.next_day - Math.max(150, ndEv.trueCostCents - d3Ev.trueCostCents + 150))
        const capped3d = Math.min(Math.max(d3Opt.priceCents, equalMargin3d), prices.next_day - 200)
        if (capped3d - d3Ev.trueCostCents >= prices.next_day - ndEv.trueCostCents - 200 && capped3d - d3Ev.trueCostCents >= 500) {
          prices.within_3_days = capped3d
          competitiveOptions.push("within_3_days")
        }
      }
    }

    if (competitiveOptions.length === 0) {
      const declineOpt = request.options[request.options.length - 1]!
      prices[declineOpt.kind] = Math.round(declineOpt.listPriceCents * 5.0)
      return {
        request,
        legRoadKms,
        prices,
        competitiveOptions: [],
        fasterOptionUnquoted: false,
      }
    }

    const fastestOffered = request.options[0]!.kind
    const fasterOptionUnquoted = !competitiveOptions.includes(fastestOffered)

    return {
      request,
      legRoadKms,
      prices,
      competitiveOptions,
      fasterOptionUnquoted,
    }
  }
}
