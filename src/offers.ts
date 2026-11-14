import type { MapGraph } from "./planner.ts"
import { isExperiencedDriver } from "./supply.ts"
import type { RosterSupplyModel } from "./supply.ts"
import { DAY, dayOf, HOUR, weekdayOfDay } from "./time.ts"
import type { Audience, DriverProfile, OfferAction } from "./types.ts"

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

export type GigViewerInfo = {
  firstAt: number
  lastAt: number
  count: number
}

function evaluateDriverCommitments(
  map: MapGraph,
  dComms: readonly ActiveDriverCommitment[],
  gig: OfferGigTarget,
  execDay: number,
): { dayDriveMins: number; overlaps: boolean; chained: boolean } {
  let dayDriveMins = 0
  let overlaps = false
  let chained = false

  for (const c of dComms) {
    if (dayOf(c.estStartAt) !== execDay) continue
    dayDriveMins += c.driveMinutes
    const link = map.roadMinutes(c.deliveryPlaceId, gig.pickupPlaceId)
    if (c.estFinishAt + link <= gig.effectiveLastPickupAt - 15 && map.distKm(c.deliveryPlaceId, gig.pickupPlaceId) <= 35) {
      chained = true
    } else if (
      gig.earliestPickupAt + gig.driveMinutes + 30 + map.roadMinutes(gig.deliveryPlaceId, c.pickupPlaceId) <=
      c.estStartAt
    ) {
      // Fits cleanly before existing commitment
    } else {
      overlaps = true
    }
  }

  return { dayDriveMins, overlaps, chained }
}

function computeOfferFeeCents(params: {
  gig: OfferGigTarget
  chained: boolean
  vInfo: GigViewerInfo | undefined
  isRepeatViewer: boolean
  isSingleViewer: boolean
  isDenseHubSolo: boolean
  isUrgent: boolean
  isScarce: boolean
  slackMin: number
  distP: number
  distD: number
  destPool30: number
  sameCluster: boolean
  isEveningOrSat: boolean
  sameDayExec: boolean
}): number {
  const {
    gig,
    chained,
    vInfo,
    isRepeatViewer,
    isSingleViewer,
    isDenseHubSolo,
    isUrgent,
    isScarce,
    slackMin,
    distP,
    distD,
    destPool30,
    sameCluster,
    isEveningOrSat,
    sameDayExec,
  } = params

  if (gig.orderIds.length > 1) {
    const baseCapRatio = gig.orderIds.length >= 3 ? 0.68 : 0.75
    const extraRatio = (gig.audience.experienced ? 0.10 : 0) + (gig.hasPrivateStop ? 0.05 : 0)
    const maxBundleCap = Math.round(gig.refFeeCents * (baseCapRatio + extraRatio))
    const targetBundleOffer = Math.round(
      gig.currentAppFeeCents * (chained ? 0.96 : vInfo ? 1.05 : 1.02 + gig.offerWave * 0.04),
    )
    return chained
      ? Math.min(maxBundleCap, Math.max(Math.round(gig.currentAppFeeCents * 0.94), targetBundleOffer))
      : Math.max(gig.currentAppFeeCents, Math.min(maxBundleCap, targetBundleOffer))
  }

  let mult =
    chained && distD <= 30 ? 0.88 :
    chained ? 0.94 :
    distD <= 30 && distP > 30 ? (isScarce || vInfo ? 1.00 : 0.97) :
    distP <= 30 && distD <= 30 ? 0.96 :
    distP <= 30 ? 1.00 :
    isScarce ? 1.08 : 1.03

  if (gig.driveMinutes > 195) mult += 0.06
  if (gig.driveMinutes > 290) mult += 0.05
  if (destPool30 <= 12 && !sameCluster) mult += 0.06
  if (gig.hasPrivateStop) mult += 0.09
  if (gig.audience.experienced) mult += 0.14
  if (isEveningOrSat) mult += 0.05
  if (!sameDayExec) mult += 0.03
  mult += gig.offerWave * 0.08

  if (gig.isPastDeadline) {
    mult = Math.max(mult, 1.55 + gig.offerWave * 0.22)
  } else if (isUrgent && slackMin <= 190) {
    mult = Math.max(mult, 1.38 + gig.offerWave * 0.15)
  } else if (isScarce && slackMin <= 360) {
    mult = Math.max(mult, 1.15 + gig.offerWave * 0.09)
  }

  const rawFee = Math.round(gig.refFeeCents * Math.min(2.65, mult))
  if (isUrgent && slackMin <= 190) {
    return Math.max(rawFee, Math.round(gig.currentAppFeeCents * 1.04))
  }
  if (isRepeatViewer) {
    const floorSweet = Math.round(gig.currentAppFeeCents * (isDenseHubSolo ? 1.04 : 1.06))
    const capSweet = Math.round(gig.currentAppFeeCents * (isDenseHubSolo ? 1.08 : 1.13))
    return Math.max(floorSweet, Math.min(rawFee, capSweet))
  }
  if (isSingleViewer) {
    const floorSweet = Math.round(gig.currentAppFeeCents * 1.03)
    const capSweet = Math.round(gig.currentAppFeeCents * (isDenseHubSolo ? 1.06 : 1.09))
    return Math.max(floorSweet, Math.min(rawFee, capSweet))
  }
  return Math.max(rawFee, gig.currentAppFeeCents)
}

export class DirectOfferTracker {
  readonly lastActiveAt = new Map<string, number>()
  readonly gigViewers = new Map<string, Map<string, GigViewerInfo>>()
  readonly bookedOrDeliveredDay = new Map<string, Set<string>>()
  readonly recentDeliveries = new Map<string, { placeId: string; at: number }>()
  readonly offersSentByDay = new Map<string, number>()
  readonly openOffersByGig = new Map<string, Map<string, number>>()
  readonly globalOpenOfferDrivers = new Set<string>()
  readonly attemptedGigDrivers = new Set<string>()
  readonly refusedPairUntil = new Map<string, number>()
  readonly declinedMaxFee = new Map<string, number>()

  private markWorkedOnDay(driverId: string, at: number): void {
    const dayKey = String(dayOf(at))
    let set = this.bookedOrDeliveredDay.get(dayKey)
    if (!set) {
      set = new Set()
      this.bookedOrDeliveredDay.set(dayKey, set)
    }
    set.add(driverId)
  }

  private releaseGlobalDriverIfIdle(driverId: string): void {
    for (const m of this.openOffersByGig.values()) {
      if (m.has(driverId)) return
    }
    this.globalOpenOfferDrivers.delete(driverId)
  }

  recordView(driverId: string, at: number, gigId?: string): void {
    const prev = this.lastActiveAt.get(driverId) ?? -Infinity
    if (at > prev) this.lastActiveAt.set(driverId, at)
    if (gigId) {
      let byGig = this.gigViewers.get(gigId)
      if (!byGig) {
        byGig = new Map()
        this.gigViewers.set(gigId, byGig)
      }
      const cur = byGig.get(driverId)
      if (cur) {
        cur.lastAt = Math.max(cur.lastAt, at)
        cur.count++
      } else {
        byGig.set(driverId, { firstAt: at, lastAt: at, count: 1 })
      }
    }
  }

  recordBooked(driverId: string, gigId: string, at: number): void {
    this.recordView(driverId, at)
    this.markWorkedOnDay(driverId, at)
    this.clearGig(gigId)
  }

  recordDelivered(driverId: string | null, placeId: string, at: number): void {
    if (!driverId) return
    this.recordView(driverId, at)
    this.markWorkedOnDay(driverId, at)
    this.recentDeliveries.set(driverId, { placeId, at })
  }

  recordOfferQueued(gigId: string, driverId: string, feeCents: number, now: number): void {
    const dayKey = `${dayOf(now)}:${driverId}`
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

  rollbackOfferRefused(gigId: string, driverId: string, now: number, reason = ""): void {
    const dayKey = `${dayOf(now)}:${driverId}`
    this.openOffersByGig.get(gigId)?.delete(driverId)
    this.releaseGlobalDriverIfIdle(driverId)
    if (/per day|three|3\s*offer|daily|limit/i.test(reason) && !/gig/i.test(reason)) {
      this.offersSentByDay.set(dayKey, 3)
    } else {
      const cur = this.offersSentByDay.get(dayKey) ?? 0
      if (cur > 0) this.offersSentByDay.set(dayKey, cur - 1)
    }
    this.refusedPairUntil.set(`${gigId}:${driverId}`, now + 25)
    this.attemptedGigDrivers.add(`${gigId}:${driverId}`)
  }

  recordOfferAnswered(gigId: string, driverId: string, answer: "accepted" | "declined" | "expired"): void {
    const offeredFee = this.openOffersByGig.get(gigId)?.get(driverId) ?? 0
    this.openOffersByGig.get(gigId)?.delete(driverId)
    this.releaseGlobalDriverIfIdle(driverId)
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
      this.openOffersByGig.delete(gigId)
      for (const driverId of open.keys()) {
        this.releaseGlobalDriverIfIdle(driverId)
      }
    }
    this.gigViewers.delete(gigId)
  }

  offersToday(driverId: string, now: number): number {
    return this.offersSentByDay.get(`${dayOf(now)}:${driverId}`) ?? 0
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

    const pickPool30 = supply.pool30(gig.pickupPlaceId, gig.audience.experienced, gig.audience.manualLicence)
    const isScarce = pickPool30 <= 8
    const slackMin = gig.effectiveLastPickupAt - now
    const isDenseHubSolo = gig.orderIds.length === 1 && pickPool30 >= 45 && slackMin > 300
    const isUrgent = gig.urgent || gig.isPastDeadline || slackMin <= 220

    const execAt = Math.max(now, gig.earliestPickupAt)
    const execDay = dayOf(execAt)
    const execWd = weekdayOfDay(execDay)
    const isEveningOrSat = execWd === 5 || (execAt % DAY) >= 17 * HOUR
    const sameDayExec = execDay === dayOf(now)
    const workedTodaySet = this.bookedOrDeliveredDay.get(String(dayOf(now)))
    const gigViewersMap = this.gigViewers.get(gig.gigId)

    const byDriver = new Map<string, ActiveDriverCommitment[]>()
    for (const c of commitments) {
      let arr = byDriver.get(c.driverId)
      if (!arr) {
        arr = []
        byDriver.set(c.driverId, arr)
      }
      arr.push(c)
    }

    const destPool30 = supply.pool30(gig.deliveryPlaceId, false, false)
    const sameCluster = map.isSameCluster30(gig.pickupPlaceId, gig.deliveryPlaceId)
    const scored: Array<{ driver: DriverProfile; score: number; feeCents: number }> = []

    for (const d of supply.drivers) {
      const pairKey = `${gig.gigId}:${d.id}`
      if (this.globalOpenOfferDrivers.has(d.id)) continue
      if ((this.refusedPairUntil.get(pairKey) ?? -Infinity) > now) continue
      if (!isUrgent && this.attemptedGigDrivers.has(pairKey)) continue
      const usedToday = this.offersToday(d.id, now)
      if (usedToday >= 3) continue

      const isExp = isExperiencedDriver(d)
      if (gig.audience.experienced && !isExp) continue
      if (gig.audience.manualLicence && d.licence !== "manual") continue

      const lastAct = this.lastActiveAt.get(d.id) ?? -Infinity
      const minsSinceAct = now - lastAct
      const workedToday = Boolean(workedTodaySet?.has(d.id))

      const fit = evaluateDriverCommitments(map, byDriver.get(d.id) ?? [], gig, execDay)
      if (fit.overlaps || fit.dayDriveMins + gig.driveMinutes > 440) continue

      let chained = fit.chained
      if (!chained) {
        const recent = this.recentDeliveries.get(d.id)
        if (
          recent &&
          dayOf(recent.at) === execDay &&
          now - recent.at <= 180 &&
          map.distKm(recent.placeId, gig.pickupPlaceId) <= 35
        ) {
          chained = true
        }
      }

      const vInfo = gigViewersMap?.get(d.id)
      const isRepeatViewer = Boolean(vInfo && vInfo.count >= 2 && now - vInfo.lastAt <= 25)
      const isSingleViewer = Boolean(vInfo && vInfo.count === 1 && now - vInfo.lastAt <= 20)

      const maxInactiveMins = vInfo ? 20 : isUrgent || isScarce ? 90 : 35
      if (!chained && minsSinceAct > maxInactiveMins) continue

      const distP = map.distKm(d.homePlaceId, gig.pickupPlaceId)
      const distD = map.distKm(d.homePlaceId, gig.deliveryPlaceId)
      const isHomeReturnViewer = Boolean(vInfo && distD <= 30 && distP > 30)

      if (usedToday >= 2 && !isUrgent && gig.orderIds.length === 1 && !isRepeatViewer && !isHomeReturnViewer) continue
      if (!isUrgent && isDenseHubSolo && !chained && !isRepeatViewer && !isHomeReturnViewer) continue

      const positionedRepeatViewer = isRepeatViewer && slackMin >= 45
      if (!chained && !positionedRepeatViewer && distP > 65 && distD > 30) continue
      if (!isUrgent && !isScarce && !chained && !vInfo && distD > 30) continue
      if (!isUrgent && !isScarce && !chained && !vInfo && distP <= 30 && distD <= 30) continue

      const transitMin =
        chained || positionedRepeatViewer ? 0 : Math.ceil(map.roadMinutes(d.homePlaceId, gig.pickupPlaceId) * 1.22)
      if (!chained && !positionedRepeatViewer && now + transitMin + 15 > gig.effectiveLastPickupAt) continue

      let matchScore = -Infinity
      if (chained && distD <= 30) matchScore = 118
      else if (chained) matchScore = distP > 30 ? 98 : 84
      else if (distD === 0 && distP > 30) matchScore = 90 - transitMin * 0.05
      else if (distD <= 30 && distP > 30) matchScore = 82 - transitMin * 0.05
      else if (distP > 30 && distP <= 65) matchScore = isScarce || isUrgent ? 74 : 52
      else if (distP <= 30 && distD <= 30) matchScore = 58
      else if (distP <= 30) matchScore = isUrgent || isScarce ? 66 : 46
      else if (positionedRepeatViewer) matchScore = 62
      if (!Number.isFinite(matchScore)) continue

      const viewerBonus =
        isRepeatViewer ? 54 :
        isSingleViewer && distD <= 30 && distP > 30 ? 46 :
        isSingleViewer ? 30 : 0

      const activityBonus =
        minsSinceAct <= 15 ? 30 :
        minsSinceAct <= 45 ? 20 :
        workedToday ? 16 : 8

      const dropPenalty = Math.min(26, d.drops * 3.8)
      const budgetPenalty = usedToday * 12
      const expSavePenalty = !gig.audience.experienced && isExp ? 8 : 0
      const totalScore = matchScore + viewerBonus + activityBonus - dropPenalty - budgetPenalty - expSavePenalty

      if (totalScore < (isUrgent || isScarce ? 52 : 78)) continue

      const feeCents = computeOfferFeeCents({
        gig,
        chained,
        vInfo,
        isRepeatViewer,
        isSingleViewer,
        isDenseHubSolo,
        isUrgent,
        isScarce,
        slackMin,
        distP,
        distD,
        destPool30,
        sameCluster,
        isEveningOrSat,
        sameDayExec,
      })

      const prevDeclined = this.declinedMaxFee.get(pairKey) ?? 0
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
