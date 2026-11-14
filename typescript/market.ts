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
  expectedWinProb: number
  expectedWinsByDeadlineDay: ReadonlyArray<{ deadlineDay: number; expectedWins: number }>
}

export type BatchQuoteContext = {
  batchId: string
  seenCount: number
  wonCount: number
  unresolvedExpectedWins: number
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
    if (this.outageCenterToday) {
      const endSt = this.regionOutStats.get(this.outageCenterToday)
      if (endSt && (endSt.llr >= 1.5 || endSt.sumResIn / Math.max(1, endSt.nIn) >= 0.14)) {
        this.outageUsedThisWeek = true
      }
    }

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
    if (onTime) {
      d.lateCount = Math.max(0, d.lateCount - 0.125)
    } else {
      d.lateCount = Math.min(6, d.lateCount + 1)
    }
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

    const evalOpt: OptKind = meta.competitiveOptions.reduce((best, cur) => {
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
        if (bestCenter) {
          this.outageCenterToday = bestCenter
        } else if (this.outageCenterToday) {
          const curSt = this.regionOutStats.get(this.outageCenterToday)
          if (curSt && curSt.nIn >= 22 && curSt.llr <= 0.25 && curSt.sumResIn / curSt.nIn < 0.10) {
            this.outageCenterToday = null
          }
        }
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
      const k3d = has3dOffered ? sigmoid(7.5 * (0.32 - Math.log(rNd / 0.93))) : 1.0
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
      const kNd = hasNdOffered ? sigmoid(4.8 * (0.18 - Math.max(0, Math.log(rSd / 1.0)))) : 1.0
      winSd += du * kNd
    } else if (wNd) {
      const kSd = hasSdOffered ? 1 - sigmoid(4.8 * (0.092 - Math.log(1.08 / rNd))) : 1.0
      const k3d = has3dOffered ? sigmoid(7.5 * (0.32 - Math.log(rNd / 0.93))) : 1.0
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

function requestProgressFraction(now: number): number {
  const workPerDay = 10 * HOUR
  const totalWeekWork = 5 * workPerDay
  const day = Math.min(5, Math.max(0, Math.floor(now / DAY)))
  if (day >= 5) return 1.0
  const tod = now % DAY
  const todayWork = Math.max(0, Math.min(workPerDay, tod - 8 * HOUR))
  return Math.min(1.0, (day * workPerDay + todayWork) / totalWeekWork)
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

    // Single-yard bulk-order depletion guard (ONLY for large bursts seenCount >= 12; small 2-11 batches are high-margin!)
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
    const pickDay = Math.floor(plan.earliestPickupAt / DAY)
    const pickWd = ((pickDay % 7) + 7) % 7
    const isFri = pickWd === 4 ? 1 : 0
    const isSat = pickWd === 5 ? 1 : 0

    // Deadline-day capacity guard (Next Monday dlDay >= 7 has 0 new requests + 3.5 execution days!)
    const dlDay = Math.floor(plan.effectiveDeadline / DAY)
    const dlWd = ((dlDay % 7) + 7) % 7
    const dayCapMult = dlDay >= 7 ? 0.165 : dlWd === 4 ? 0.064 : 0.096
    const dayCap = Math.max(40, Math.round(this.supply.totalDrivers * dayCapMult))
    const dayOrders = ctx.activeOrdersOnDeadlineDay(dlDay)
    const dayLoad = dayOrders / dayCap
    if (dlWd === 4 && dayLoad >= 0.92 && option.kind === "same_day") return undefined
    if (dayLoad >= 1.05 && option.kind === "same_day") return undefined
    if (dayLoad >= 1.20) return undefined

    // Safety gates against zero-notification traps
    if (plan.premiumAny && Q30 === 0 && (Q65 < 10 || leadHours < 12)) return undefined
    if (plan.privateDeliveryCount > 0 && request.legs.length === 1 && (Q65 < 6 || leadHours < 3.5)) return undefined
    if (leadHours < 2.0 && Q30 < 25) return undefined

    const hubPoolThreshold = Math.min(80, Math.round(this.supply.totalDrivers * 0.095))
    const isArcticSink = ARCTIC_SINKS.has(farPlaceId)
    const isNorthernSink = NORTHERN_SINKS.has(farPlaceId)
    const isAnySink = isArcticSink || isNorthernSink
    const shortageFrac = Math.max(0, Math.min(1.1, (780 - this.supply.totalDrivers) / 135))
    const sinkEtaLift = !sameCluster30
      ? (isArcticSink ? 0.85 : isNorthernSink ? 0.35 : D_pool30 < 30 && plan.totalRoadKm > 220 ? 0.18 : 0) +
        (isAnySink && option.kind === "same_day" ? 0.35 : 0)
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
      (plan.needsChargingAny ? 0.50 : 0) +
      (plan.snowOverlap ? 0.38 : 0) +
      (ctx.fluActiveToday ? 0.35 : 0) +
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

    // Steer risky co-offered VIP same_day requests into next_day (prevents D01 Tuesday trust crashes like R3 25 -> 7!)
    if (isVipFranchise && progress < 0.88 && option.kind === "same_day" && request.options.length > 1) {
      maxAllowedPLate = Math.min(maxAllowedPLate, projTrust >= 12 ? 0.058 : 0.072)
    }
    if (pLate > maxAllowedPLate) return undefined

    // Calibrated driver fee multiplier across 50 saved worlds (hub clusters + northern/arctic sink balance)
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
    if (request.legs.length === 2) feeMult += 0.15
    if (plan.premiumAny) feeMult += 0.19
    if (plan.needsChargingAny) feeMult += 0.08
    if (plan.needsPlatesAny || plan.manualRequired) feeMult += 0.04
    if (isFri || isSat) feeMult += 0.07
    if (over4h > 0) feeMult += (D_pool30 >= hubPoolThreshold ? 0.02 : 0.035) * over4h
    if (plan.snowOverlap) feeMult += 0.14
    if (ctx.fluActiveToday) feeMult += 0.12
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

    // Exact decay-adjusted Franchise Loss (telescoping projTrust halving + 8-win decaying satisfaction loss)
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

    // Health-adaptive targetWeekly + Hybrid Per-Slot Shadow Cost
    const drv = this.supply.totalDrivers
    const baseTargetWeekly =
      this.level >= 7
        ? Math.max(275, Math.min(465, Math.round(drv * (0.425 + 0.00018 * Math.max(0, drv - 680)))))
        : Math.max(450, Math.min(640, Math.round(drv * 0.26)))

    const softBacklog = Math.max(10, drv * 0.030)
    const backlogExcess = Math.max(0, (ctx.unbookedOrdersCount - softBacklog) / 16)
    const healthMult =
      this.level >= 7
        ? Math.max(
            0.86,
            Math.min(
              1.12,
              1.0 +
                0.12 * Math.max(0, Math.min(1, (currentOnTime - 0.952) / 0.025)) * Math.max(0, 1 - backlogExcess) -
                0.10 * Math.min(1.4, backlogExcess) -
                (currentOnTime < 0.942 ? 2.8 * (0.942 - currentOnTime) : 0) -
                (ctx.fluActiveToday ? 0.07 : 0),
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
    if (ctx.fluActiveToday) shadowMult += 0.10
    if (leadHours < 5) shadowMult *= 1.18

    const slotShadowUnitCents = 520 + Math.round(135 * roadHours + 0.24 * request.referenceFeeCents)
    const refShadowCents =
      this.level >= 7
        ? Math.round(slotShadowUnitCents * Math.min(1.45, shadowMult * 1.45))
        : Math.round(request.referenceFeeCents * Math.min(0.65, shadowMult))

    // In-flight-capped telescoping Dealer Trust acquisition bonus (outside 0.78x floor so metro hops aren't clamped!)
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
  ): {
    minP: number
    maxP: number
    effCost: number
    trueCost: number
    dlDay: number
    dlWd: number
    dayLoad: number
  } {
    const optMult = ev.option.kind === "same_day" ? 1.08 : ev.option.kind === "within_3_days" ? 0.93 : 1.0
    const targetScale = tildeCNdCents * optMult
    const dayIdx = Math.floor(request.arrivedAt / DAY)
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

    // Kink-breaking surplus harvest (up to 0.72 so E_eff / targetScale crosses 0.8462 when paceRatio > 0.95 or during Outages!)
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

    const pickWd = ((Math.floor(ev.plan.earliestPickupAt / DAY) % 7) + 7) % 7
    const dlDay = Math.floor(ev.plan.effectiveDeadline / DAY)
    const dlWd = ((dlDay % 7) + 7) % 7

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

    const trustDelayCost =
      ev.option.kind === "within_3_days" && this.level === 8 && d.trust < 25 && dlDay < 7
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

  optimizeOptionPrice(
    request: PriceRequest,
    ev: EvaluatedOption,
    legRoadKms: readonly number[],
    fasterOptionUnquoted: boolean,
  ): { priceCents: number; expectedMargin: number; winProb: number } | undefined {
    const pickupId = request.legs[0]!.pickup.placeId
    const deliveryId = request.legs[request.legs.length - 1]!.delivery.placeId
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
    const tildeCNd = probeNd.effMult * probeNd.compCents
    const optMult = ev.option.kind === "same_day" ? 1.08 : ev.option.kind === "within_3_days" ? 0.93 : 1.0
    const targetScale = Math.max(1, tildeCNd * optMult)
    const b = this.computeOptionMenuBounds(request, ev, tildeCNd)

    let bestPrice = 0
    let bestObj = -1
    let bestWinProb = 0
    const steps = 48
    for (let s = 0; s <= steps; s++) {
      const cand = Math.round(b.minP + (s / steps) * (b.maxP - b.minP))
      const x = Math.log(Math.max(1, cand) / targetScale)
      const { p } = winProbability(x, fasterOptionUnquoted)
      const obj = p * (cand - b.effCost)
      if (obj > bestObj) {
        bestObj = obj
        bestPrice = cand
        bestWinProb = p
      }
    }
    if (bestPrice <= 0) return undefined
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
        expectedWinProb: 1.0,
        expectedWinsByDeadlineDay: [{ deadlineDay: Math.floor(ev.plan.effectiveDeadline / DAY), expectedWins: 1.0 }],
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
    const deliveryId = request.legs[request.legs.length - 1]!.delivery.placeId
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

    const optSolo = (
      kind: OptKind,
      b: NonNullable<typeof sdB> | undefined,
    ): { p: number; ev: number } | undefined => {
      if (!b) return undefined
      let bestP = b.minP
      let bestEv = -1e9
      const steps = 36
      for (let s = 0; s <= steps; s++) {
        const cand = Math.round(b.minP + (s / steps) * (b.maxP - b.minP))
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
        const ev = w * (cand - b.effCost)
        if (ev > bestEv) {
          bestEv = ev
          bestP = cand
        }
      }
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

    const considerMenu = (
      pSd: number | undefined,
      pNd: number | undefined,
      p3d: number | undefined,
    ): void => {
      const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, pSd, pNd, p3d)
      let ev = 0
      if (pSd !== undefined && sdB) ev += r.winSd * (pSd - sdB.effCost)
      if (pNd !== undefined && ndB) ev += r.winNd * (pNd - ndB.effCost)
      if (p3d !== undefined && d3B) ev += r.win3d * (p3d - d3B.effCost)
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
      let curSd = Math.max(sdB.minP, curNd + minSdSpread)
      for (let pass = 0; pass < 2; pass++) {
        const loSd = Math.max(sdB.minP, curNd + minSdSpread)
        const hiSd = Math.max(loSd + 200, sdB.maxP)
        let optSdP = curSd
        let optEv = -1e9
        for (let s = 0; s <= 28; s++) {
          const candSd = Math.round(loSd + (s / 28) * (hiSd - loSd))
          const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, candSd, curNd, undefined)
          const ev = r.winSd * (candSd - sdB.effCost) + r.winNd * (curNd - ndB.effCost)
          if (ev > optEv) {
            optEv = ev
            optSdP = candSd
          }
        }
        curSd = optSdP

        const loNd = ndB.minP
        const hiNd = Math.min(ndB.maxP, curSd - minSdSpread)
        if (hiNd >= loNd) {
          let optNdP = curNd
          optEv = -1e9
          for (let s = 0; s <= 28; s++) {
            const candNd = Math.round(loNd + (s / 28) * (hiNd - loNd))
            const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, curSd, candNd, undefined)
            const ev = r.winSd * (curSd - sdB.effCost) + r.winNd * (candNd - ndB.effCost)
            if (ev > optEv) {
              optEv = ev
              optNdP = candNd
            }
          }
          curNd = optNdP
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
      } else if (d3B.dlWd !== 4 && (ndB.effCost - d3B.effCost >= 380 || ndB.dlWd === 4) && soloNd) {
        const baseEvWithout3d = bestEv
        const anchorSd = bestSd
        const minSdSpread =
          sdB && anchorSd !== undefined
            ? sdB.dlWd === 3 && ndB.dlWd === 4
              ? Math.max(250, Math.round(sdB.trueCost - ndB.trueCost + 150))
              : Math.max(400, Math.round(sdB.effCost - ndB.effCost + 150))
            : 0

        let curNd = bestNd ?? soloNd.p
        let cur3d = Math.min(d3B.maxP, curNd - 300)
        for (let pass = 0; pass < 2; pass++) {
          const lo3 = d3B.minP
          const hi3 = Math.min(d3B.maxP, curNd - 300)
          if (hi3 < lo3) break
          let opt3dP = cur3d
          let optEv = -1e9
          for (let s = 0; s <= 24; s++) {
            const cand3 = Math.round(lo3 + (s / 24) * (hi3 - lo3))
            const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, anchorSd, curNd, cand3)
            const ev =
              (anchorSd !== undefined && sdB ? r.winSd * (anchorSd - sdB.effCost) : 0) +
              r.winNd * (curNd - ndB.effCost) +
              r.win3d * (cand3 - d3B.effCost)
            if (ev > optEv) {
              optEv = ev
              opt3dP = cand3
            }
          }
          cur3d = opt3dP

          const loNd = Math.max(ndB.minP, cur3d + 300)
          const hiNd = anchorSd !== undefined ? Math.min(ndB.maxP, anchorSd - minSdSpread) : ndB.maxP
          if (hiNd >= loNd) {
            let optNdP = curNd
            optEv = -1e9
            for (let s = 0; s <= 24; s++) {
              const candNd = Math.round(loNd + (s / 24) * (hiNd - loNd))
              const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, anchorSd, candNd, cur3d)
              const ev =
                (anchorSd !== undefined && sdB ? r.winSd * (anchorSd - sdB.effCost) : 0) +
                r.winNd * (candNd - ndB.effCost) +
                r.win3d * (cur3d - d3B.effCost)
              if (ev > optEv) {
                optEv = ev
                optNdP = candNd
              }
            }
            curNd = optNdP
          }
        }

        let finalSd = anchorSd
        if (sdB && finalSd !== undefined) {
          const loSd = Math.max(sdB.minP, curNd + minSdSpread)
          const hiSd = Math.max(loSd + 200, sdB.maxP)
          let optSdP = finalSd
          let optEv = -1e9
          for (let s = 0; s <= 24; s++) {
            const candSd = Math.round(loSd + (s / 24) * (hiSd - loSd))
            const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, candSd, curNd, cur3d)
            const ev =
              r.winSd * (candSd - sdB.effCost) +
              r.winNd * (curNd - ndB.effCost) +
              r.win3d * (cur3d - d3B.effCost)
            if (ev > optEv) {
              optEv = ev
              optSdP = candSd
            }
          }
          finalSd = optSdP
        }

        if (cur3d >= d3B.minP && cur3d <= curNd - 300) {
          const r = evaluateMenuChoice(hasSdOffered, hasNdOffered, has3dOffered, tildeCNd, finalSd, curNd, cur3d)
          const ev =
            (finalSd !== undefined && sdB ? r.winSd * (finalSd - sdB.effCost) : 0) +
            r.winNd * (curNd - ndB.effCost) +
            r.win3d * (cur3d - d3B.effCost)
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
