import { DAY, dayOf, HOUR } from "./time.ts"
import type { DeliveryOption, PriceRequest } from "./types.ts"

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

export function optionMultiplier(opt: OptKind): number {
  return opt === "same_day" ? 1.08 : opt === "within_3_days" ? 0.93 : 1.0
}

/** Exact unrounded list price in cents (0/91,015 rounding mismatches). */
export function unroundedListPriceCents(legRoadKms: readonly number[], opt: OptKind): number {
  const legMult = legRoadKms.length === 2 ? 0.85 : 1.0
  const base = legRoadKms.reduce((s, km) => s + (2000 + 25 * km), 0)
  return base * legMult * optionMultiplier(opt)
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

type DayQuoteRecord = {
  pickupId: string
  zKm: number
  xRaw: number
  fasterOptionUnquoted: boolean
  y: number
}

type RegionOutageStats = {
  nIn: number
  llr: number
  sumResIn: number
  nOut: number
  sumResOut: number
  outDayOff: number
  outDayPrec: number
}

const DEFAULT_DAY_PRECISION = 1 / (0.055 ** 2)

function isInBusinessQuoteHours(minute: number): boolean {
  const tod = minute % DAY
  return tod >= 8 * HOUR && tod <= 18 * HOUR
}

export class CompetitorMarketEstimator {
  readonly level: number
  readonly within80Map: Map<string, Set<string>>
  readonly minWorldLog: number
  readonly maxWorldLog: number

  worldLogMean: number
  worldPrecision: number
  dayLogOffset = 0
  dayPrecision = DEFAULT_DAY_PRECISION
  distanceSlope = -0.03
  distanceSlopeInfo = 90
  currentDay = 0

  priceWarUsedThisWeek = false
  outageUsedThisWeek = false
  priceWarToday = false
  outageCenterToday: string | null = null

  dayStartWorldLogMean: number
  dayStartWorldPrecision: number
  dayStartDistanceSlope: number
  dayStartDistanceSlopeInfo: number

  monHadPwSignal = false
  monImpliedLog = 0
  tueVerifiedMon = false

  todayQuotes = 0
  todayFullPwLLR = 0
  todaySumResStart = 0
  todayHistory: DayQuoteRecord[] = []
  readonly regionOutStats = new Map<string, RegionOutageStats>()
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
      this.worldPrecision = DEFAULT_DAY_PRECISION
    }
    this.dayStartWorldLogMean = this.worldLogMean
    this.dayStartWorldPrecision = this.worldPrecision
    this.dayStartDistanceSlope = this.distanceSlope
    this.dayStartDistanceSlopeInfo = this.distanceSlopeInfo
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

  private dealerEffectiveMultiplier(d: DealerState): number {
    const trustMult = this.level === 8 ? 1 + 0.01 * d.trust : 1.0
    return trustMult * Math.exp(-0.0405 * Math.min(d.lateCount, 6) - 0.0016 * Math.min(d.unquotedCount, 20))
  }

  private activeEventLog(inHours: boolean, pickupId: string): number {
    if (inHours && this.level === 8 && this.priceWarToday) return Math.log(0.80)
    if (
      inHours &&
      this.level >= 6 &&
      this.outageCenterToday &&
      this.within80Map.get(this.outageCenterToday)?.has(pickupId)
    ) {
      return Math.log(1.30)
    }
    return 0
  }

  private applyNormalQuoteStep(grad: number, info: number, zKm: number): void {
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

    const gradSlope = grad * zKm
    const infoSlope = info * zKm * zKm
    this.distanceSlopeInfo += infoSlope
    this.distanceSlope = Math.max(-0.22, Math.min(0.22, this.distanceSlope + gradSlope / this.distanceSlopeInfo))
  }

  private replayNonEventQuotes(): void {
    this.worldLogMean = this.dayStartWorldLogMean
    this.worldPrecision = this.dayStartWorldPrecision
    this.distanceSlope = this.dayStartDistanceSlope
    this.distanceSlopeInfo = this.dayStartDistanceSlopeInfo
    this.dayLogOffset = 0
    this.dayPrecision = DEFAULT_DAY_PRECISION

    if (this.priceWarToday) return
    const outSet = this.outageCenterToday ? this.within80Map.get(this.outageCenterToday) : undefined
    for (const h of this.todayHistory) {
      if (outSet && outSet.has(h.pickupId)) continue
      const xAct = h.xRaw - (this.worldLogMean + this.dayLogOffset + this.distanceSlope * h.zKm)
      const { p, dp_dx } = winProbability(xAct, h.fasterOptionUnquoted)
      const dp_dTheta = -dp_dx
      const denom = Math.max(1e-4, p * (1 - p))
      const grad = ((h.y - p) * dp_dTheta) / denom
      const info = (dp_dTheta * dp_dTheta) / denom
      this.applyNormalQuoteStep(grad, info, h.zKm)
    }
  }

  private estimateDayImpliedLog(): number {
    let th = this.dayStartWorldLogMean
    for (let it = 0; it < 6; it++) {
      let g = 0
      let hInfo = 8.0
      for (const q of this.todayHistory) {
        const x = q.xRaw - (th + this.dayStartDistanceSlope * q.zKm)
        const { p, dp_dx } = winProbability(x, q.fasterOptionUnquoted)
        const dp = -dp_dx
        const den = Math.max(1e-4, p * (1 - p))
        g += ((q.y - p) * dp) / den
        hInfo += (dp * dp) / den
      }
      th = Math.max(Math.log(0.95), Math.min(Math.log(1.75), th + g / hInfo))
    }
    return th
  }

  onNewDay(day: number): void {
    if (day <= this.currentDay) return

    if (this.level === 8 && this.currentDay === 0 && this.todayQuotes >= 15) {
      const monImp = this.estimateDayImpliedLog()
      if (this.priceWarToday || monImp <= Math.log(1.29)) {
        this.monHadPwSignal = true
        this.monImpliedLog = monImp
        if (Math.exp(monImp) < 1.16) {
          this.priceWarUsedThisWeek = true
          const impliedNormal = Math.min(this.maxWorldLog, Math.max(this.minWorldLog, monImp - Math.log(0.80)))
          this.worldLogMean = 0.65 * this.dayStartWorldLogMean + 0.35 * impliedNormal
        } else {
          this.worldLogMean = Math.min(this.maxWorldLog, Math.max(this.minWorldLog, monImp - Math.log(0.80)))
          this.worldPrecision = 300
        }
      }
    } else if (this.priceWarToday) {
      this.priceWarUsedThisWeek = true
    } else if (
      this.level === 8 &&
      this.currentDay >= 1 &&
      this.currentDay <= 3 &&
      !this.priceWarUsedThisWeek &&
      this.todayQuotes >= 20 &&
      this.todayFullPwLLR >= 5.0 &&
      this.todaySumResStart / this.todayQuotes <= -0.15
    ) {
      this.priceWarUsedThisWeek = true
      this.worldLogMean = this.dayStartWorldLogMean
      this.worldPrecision = this.dayStartWorldPrecision
      this.distanceSlope = this.dayStartDistanceSlope
      this.distanceSlopeInfo = this.dayStartDistanceSlopeInfo
    }

    if (this.outageCenterToday) {
      const endSt = this.regionOutStats.get(this.outageCenterToday)
      const endMeanIn = endSt ? endSt.sumResIn / Math.max(1, endSt.nIn) : 0
      const endMeanOut = endSt && endSt.nOut >= 5 ? endSt.sumResOut / endSt.nOut : 0
      if (endSt && endSt.nIn >= 14 && endSt.llr >= 8.5 && endMeanIn - endMeanOut >= 0.22) {
        this.outageUsedThisWeek = true
      }
    }

    this.currentDay = day
    this.dayLogOffset = 0
    this.dayPrecision = DEFAULT_DAY_PRECISION
    this.distanceSlopeInfo = Math.max(70, this.distanceSlopeInfo * 0.55)
    this.priceWarToday = false
    this.outageCenterToday = null
    this.todayQuotes = 0
    this.todayFullPwLLR = 0
    this.todaySumResStart = 0
    this.regionOutStats.clear()
    this.todayHistory = []

    this.dayStartWorldLogMean = this.worldLogMean
    this.dayStartWorldPrecision = this.worldPrecision
    this.dayStartDistanceSlope = this.distanceSlope
    this.dayStartDistanceSlopeInfo = this.distanceSlopeInfo

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
    this.onNewDay(dayOf(params.arrivedAt))
    const inHours = isInBusinessQuoteHours(params.arrivedAt)

    const ulp = unroundedListPriceCents(params.legRoadKms, params.opt)
    const ulpNext = unroundedListPriceCents(params.legRoadKms, "next_day")
    const zKm = centeredLogKm(params.legRoadKms)
    const d = this.getDealer(params.dealerId)
    const eventLog = this.activeEventLog(inHours, params.pickupId)
    const effDayOffset = eventLog > 0 ? Math.max(-0.03, this.dayLogOffset) : this.dayLogOffset

    const logC =
      this.worldLogMean +
      effDayOffset +
      this.distanceSlope * zKm +
      eventLog +
      logLaneFactor(params.pickupId, params.deliveryId, params.legRoadKms, params.refFeeCents, ulpNext) +
      d.morningRetalLog +
      d.latentLogOffset

    const compCents = ulp * Math.exp(logC)
    const effMult = this.dealerEffectiveMultiplier(d)
    const x = Math.log(Math.max(1, params.quoteCents) / Math.max(1, effMult * compCents))
    const { p } = winProbability(x, params.fasterOptionUnquoted)
    return { compCents, effMult, winProb: p }
  }

  private updatePriceWarDetector(xRaw: number, zKm: number, fasterOptionUnquoted: boolean, y: number): void {
    if (this.level !== 8 || this.priceWarUsedThisWeek) return
    const anchorW = this.dayStartWorldLogMean
    const pwW = anchorW + Math.log(0.80)
    const baseA = winProbability(xRaw - (anchorW + this.dayStartDistanceSlope * zKm), fasterOptionUnquoted)
    const pwA = winProbability(xRaw - (pwW + this.dayStartDistanceSlope * zKm), fasterOptionUnquoted)

    const llBase = y ? Math.log(baseA.p + 1e-9) : Math.log(1 - baseA.p + 1e-9)
    const llPw = y ? Math.log(pwA.p + 1e-9) : Math.log(1 - pwA.p + 1e-9)
    this.todayFullPwLLR += llPw - llBase
    this.todaySumResStart += y - baseA.p

    const meanResStart = this.todaySumResStart / this.todayQuotes
    const reqPwQuotes = this.currentDay === 0 ? 18 : 15
    const reqPwLLR = this.currentDay === 0 ? 4.8 : 3.8
    if (
      !this.priceWarToday &&
      this.todayQuotes >= reqPwQuotes &&
      this.todayQuotes <= 65 &&
      this.todayFullPwLLR >= reqPwLLR &&
      meanResStart <= -0.22
    ) {
      this.priceWarToday = true
      this.outageCenterToday = null
      this.replayNonEventQuotes()
    } else if (this.priceWarToday && this.todayFullPwLLR < 0.8) {
      this.priceWarToday = false
      this.replayNonEventQuotes()
    }
  }

  private updateRegionalOutageDetector(
    pickupId: string,
    xRaw: number,
    zKm: number,
    fasterOptionUnquoted: boolean,
    y: number,
  ): void {
    if (this.level < 6 || this.outageUsedThisWeek || this.priceWarToday) return

    for (const [center, set] of this.within80Map.entries()) {
      let cur = this.regionOutStats.get(center)
      if (!cur) {
        cur = {
          nIn: 0,
          llr: 0,
          sumResIn: 0,
          nOut: 0,
          sumResOut: 0,
          outDayOff: 0,
          outDayPrec: this.currentDay === 0 ? 1 / (0.085 ** 2) : DEFAULT_DAY_PRECISION,
        }
        this.regionOutStats.set(center, cur)
      }
      const safeOutOff = Math.max(-0.035, Math.min(0.16, cur.outDayOff))
      const thetaOut = this.dayStartWorldLogMean + safeOutOff + this.dayStartDistanceSlope * zKm
      const xC = xRaw - thetaOut
      const baseC = winProbability(xC, fasterOptionUnquoted)

      if (set.has(pickupId)) {
        const outC = winProbability(xC - Math.log(1.30), fasterOptionUnquoted)
        const dLL =
          (y ? Math.log(outC.p + 1e-9) : Math.log(1 - outC.p + 1e-9)) -
          (y ? Math.log(baseC.p + 1e-9) : Math.log(1 - baseC.p + 1e-9))
        cur.nIn++
        cur.llr += dLL
        cur.sumResIn += y - baseC.p
      } else {
        cur.nOut++
        cur.sumResOut += y - baseC.p
        const dpTheta = -baseC.dp_dx
        const denomC = Math.max(1e-4, baseC.p * (1 - baseC.p))
        const gradC = ((y - baseC.p) * dpTheta) / denomC
        const infoC = (dpTheta * dpTheta) / denomC
        cur.outDayOff = Math.max(-0.16, Math.min(0.16, cur.outDayOff + gradC / (cur.outDayPrec + infoC)))
        cur.outDayPrec += 0.65 * infoC
      }
    }

    const prevCenter = this.outageCenterToday
    let bestCenter: string | null = null
    let bestScore = -Infinity
    const minNOut = this.currentDay === 0 ? 14 : 8
    const minNIn = this.currentDay === 0 ? 8 : 6
    for (const [center, st] of this.regionOutStats.entries()) {
      if (st.nOut < minNOut || st.nIn < minNIn) continue
      const meanIn = st.sumResIn / st.nIn
      const meanOut = st.sumResOut / st.nOut
      const contrast = meanIn - meanOut
      const reqLLR = st.nIn < 8 ? 4.8 : 3.6
      const reqContrast = st.nIn < 8 ? 0.32 : 0.22
      if (st.llr >= reqLLR && meanIn >= 0.16 && contrast >= reqContrast && meanOut < 0.12) {
        const setSize = this.within80Map.get(center)?.size ?? 5
        const score = st.llr - 0.55 * setSize
        if (score > bestScore) {
          bestScore = score
          bestCenter = center
        }
      }
    }

    if (bestCenter) {
      this.outageCenterToday = bestCenter
      if (!prevCenter) this.replayNonEventQuotes()
    } else if (this.outageCenterToday) {
      const curSt = this.regionOutStats.get(this.outageCenterToday)
      if (curSt && curSt.llr < 1.2) {
        this.outageCenterToday = null
        this.replayNonEventQuotes()
      }
    }
  }

  onQuoteResolved(meta: RecordedQuoteMeta, wonOption: OptKind | null): void {
    const req = meta.request
    this.onNewDay(dayOf(req.arrivedAt))
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
    const deliveryId =
      req.legs.length > 1 ? req.legs[0]!.delivery.placeId : req.legs[req.legs.length - 1]!.delivery.placeId
    const inHours = isInBusinessQuoteHours(req.arrivedAt)
    const ulp = unroundedListPriceCents(meta.legRoadKms, evalOpt)
    const ulpNext = unroundedListPriceCents(meta.legRoadKms, "next_day")
    const zKm = centeredLogKm(meta.legRoadKms)

    if (quoteCents >= 2.45 * ulp && wonOption === null) return

    const effMult = this.dealerEffectiveMultiplier(d)
    const fixedPredictors =
      logLaneFactor(pickupId, deliveryId, meta.legRoadKms, req.referenceFeeCents, ulpNext) +
      d.morningRetalLog +
      d.latentLogOffset
    const xRaw = Math.log(quoteCents / (effMult * ulp)) - fixedPredictors

    if (inHours) {
      this.todayQuotes++
      this.todayHistory.push({ pickupId, zKm, xRaw, fasterOptionUnquoted: meta.fasterOptionUnquoted, y })

      if (
        this.currentDay === 1 &&
        this.monHadPwSignal &&
        !this.tueVerifiedMon &&
        !this.priceWarUsedThisWeek &&
        this.todayQuotes === 16
      ) {
        this.tueVerifiedMon = true
        const tueImp = this.estimateDayImpliedLog()
        if (tueImp - this.monImpliedLog >= 0.135) {
          this.priceWarUsedThisWeek = true
          this.dayStartWorldLogMean = Math.min(
            this.maxWorldLog,
            Math.max(this.minWorldLog, this.monImpliedLog - Math.log(0.80)),
          )
        } else {
          this.dayStartWorldLogMean = Math.min(
            this.maxWorldLog,
            Math.max(this.minWorldLog, 0.5 * (this.monImpliedLog + tueImp)),
          )
        }
        this.dayStartWorldPrecision = 350
        this.replayNonEventQuotes()
      }

      this.updatePriceWarDetector(xRaw, zKm, meta.fasterOptionUnquoted, y)
      this.updateRegionalOutageDetector(pickupId, xRaw, zKm, meta.fasterOptionUnquoted, y)
    }

    const baseLogCAfter = this.worldLogMean + this.dayLogOffset + this.distanceSlope * zKm + fixedPredictors
    const xBaseAfter = Math.log(quoteCents / (effMult * ulp)) - baseLogCAfter
    const activeEventLog = this.activeEventLog(inHours, pickupId)

    const xAct = xBaseAfter - activeEventLog
    const { p, dp_dx } = winProbability(xAct, meta.fasterOptionUnquoted)
    const dp_dTheta = -dp_dx
    const denom = Math.max(1e-4, p * (1 - p))
    const grad = ((y - p) * dp_dTheta) / denom
    const info = (dp_dTheta * dp_dTheta) / denom

    const inOutageRegion = Boolean(this.outageCenterToday && this.within80Map.get(this.outageCenterToday)?.has(pickupId))
    if (!this.priceWarToday && !inOutageRegion) {
      this.applyNormalQuoteStep(grad, info, zKm)
    }

    d.obsInfo += info
    d.latentLogOffset = Math.max(-0.06, Math.min(0.06, d.latentLogOffset + (0.25 * grad) / d.obsInfo))
  }
}
