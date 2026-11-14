import { shiftDeadlineBusinessDays } from "./notes.ts"
import type { ParsedLegNote } from "./notes.ts"
import type { Audience, Car, Leg, OpeningHours, Order, Place, StopRef, TimeWindow, WorldMap } from "./types.ts"

export const HOUR = 60
export const DAY = 24 * HOUR
export const CHARGING_MINUTES = 40
export const PLATES_MINUTES = 30
export const CHARGING_ROUTE_KM = 200
export const MAX_MULTI_CAR_ROAD_MINUTES = 12 * HOUR

export type RetryState = {
  pickupFrom: number
  manualLicence: boolean
  plates: boolean
}

export const EMPTY_RETRY: RetryState = {
  pickupFrom: 0,
  manualLicence: false,
  plates: false,
}

export type SnowWindow = {
  from: number
  to: number
  places: Set<string>
}

export type OptionPlan = {
  promisedDeadline: number
  effectiveDeadline: number
  earliestPickupAt: number
  finishAt: number
  effectiveLastPickupAt: number
  pickupSlackMinutes: number
  deliverySlackMinutes: number
  totalRoadMinutes: number
  totalRoadKm: number
  privatePickupCount: number
  privateDeliveryCount: number
  needsChargingAny: boolean
  needsPlatesAny: boolean
  manualRequired: boolean
  premiumAny: boolean
  snowOverlap: boolean
  canSingleGig: boolean
}

export function haversinePlaceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

export class MapGraph {
  readonly placesById: Map<string, Place>
  readonly roads: Map<string, number>
  readonly roadKms: Map<string, number>
  readonly within30km: Map<string, string[]>
  readonly within65km: Map<string, string[]>
  readonly within80kmSet: Map<string, Set<string>>

  constructor(map: WorldMap) {
    this.placesById = new Map(map.places.map((p) => [p.id, p]))
    this.roads = new Map(map.roads.map((r) => [`${r.from}\0${r.to}`, r.minutes]))
    this.roadKms = new Map(map.roads.map((r) => [`${r.from}\0${r.to}`, r.km]))
    this.within30km = new Map()
    this.within65km = new Map()
    this.within80kmSet = new Map()

    for (const p of map.places) {
      const n30: string[] = []
      const n65: string[] = []
      const n80 = new Set<string>()
      for (const q of map.places) {
        const d = p.id === q.id ? 0 : haversinePlaceKm(p, q)
        if (d <= 30.0) n30.push(q.id)
        if (d <= 65.0) n65.push(q.id)
        if (d <= 80.0) n80.add(q.id)
      }
      this.within30km.set(p.id, n30)
      this.within65km.set(p.id, n65)
      this.within80kmSet.set(p.id, n80)
    }
  }

  roadMinutes(from: string, to: string): number {
    return this.roads.get(`${from}\0${to}`) ?? Number.POSITIVE_INFINITY
  }

  roadKm(from: string, to: string): number {
    return this.roadKms.get(`${from}\0${to}`) ?? Number.POSITIVE_INFINITY
  }

  distKm(from: string, to: string): number {
    if (from === to) return 0
    const a = this.placesById.get(from)
    const b = this.placesById.get(to)
    if (!a || !b) return Number.POSITIVE_INFINITY
    return haversinePlaceKm(a, b)
  }

  isSameCluster30(from: string, to: string): boolean {
    return this.distKm(from, to) <= 30.0
  }

  needsCharging(car: Car, from: string, to: string): boolean {
    return car.electric && car.chargePercent !== null && car.chargePercent < 30 && this.roadKm(from, to) > CHARGING_ROUTE_KM
  }
}

export class SnowTracker {
  readonly forecasts: SnowWindow[] = []

  addForecast(from: number, to: number, placeIds: readonly string[]): void {
    const existing = this.forecasts.find((f) => f.from === from && f.to === to)
    if (existing) {
      for (const p of placeIds) existing.places.add(p)
      return
    }
    this.forecasts.push({ from, to, places: new Set(placeIds) })
  }

  overlaps(placeA: string, placeB: string, startMin: number, endMin: number): SnowWindow | null {
    for (const f of this.forecasts) {
      if (endMin >= f.from && startMin < f.to && (f.places.has(placeA) || f.places.has(placeB))) {
        return f
      }
    }
    return null
  }

  hasActiveSnow(placeId: string, atMin: number): boolean {
    return this.forecasts.some((f) => atMin >= f.from && atMin < f.to && f.places.has(placeId))
  }
}

export function visitAt(earliest: number, latest: number, hours: OpeningHours | null, service: number): number {
  if (earliest > latest) return Number.POSITIVE_INFINITY
  if (!hours) return earliest + service <= latest ? earliest : Number.POSITIVE_INFINITY
  const startDay = Math.floor(earliest / DAY)
  const endDay = Math.floor(latest / DAY)
  for (let day = startDay; day <= endDay; day++) {
    const weekday = ((day % 7) + 7) % 7
    const slot = weekday === 5 ? hours.saturday : hours.weekdays.includes(weekday) ? hours : null
    if (!slot) continue
    const start = Math.max(earliest, day * DAY + slot.opens)
    const close = Math.min(latest, day * DAY + slot.closes)
    if (start + service <= close) return start
  }
  return Number.POSITIVE_INFINITY
}

export function latestOpenBefore(t: number, hours: OpeningHours | null, safetyBuffer = 0): number {
  if (!hours) return t
  const startDay = Math.floor(t / DAY)
  for (let day = startDay; day >= startDay - 7; day--) {
    const wd = ((day % 7) + 7) % 7
    const slot = wd === 5 ? hours.saturday : hours.weekdays.includes(wd) ? hours : null
    if (!slot) continue
    const openAt = day * DAY + slot.opens
    const closeLimit = day * DAY + slot.closes - 1 - safetyBuffer
    if (t < openAt) continue
    if (closeLimit >= openAt) return Math.min(t, closeLimit)
  }
  return Number.NEGATIVE_INFINITY
}

export function computeOptionPlan(
  map: MapGraph,
  snow: SnowTracker,
  legs: readonly Leg[],
  notes: readonly ParsedLegNote[],
  rawOptionDeadline: number,
  now: number,
  deadlineAlreadyShifted = false,
): OptionPlan | undefined {
  if (legs.length === 0) return undefined
  const leg0 = legs[0]!
  const lastLeg = legs[legs.length - 1]!
  const note0 = notes[0]
  const lastNote = notes[notes.length - 1]

  const readyShiftDays =
    !deadlineAlreadyShifted && note0
      ? Math.max(0, Math.floor(note0.readyAt / DAY) - Math.floor(leg0.pickup.window.from / DAY))
      : 0
  const promisedDeadline = lastLeg.delivery.privateAddress
    ? rawOptionDeadline
    : shiftDeadlineBusinessDays(rawOptionDeadline, readyShiftDays)

  const noteDl = lastNote?.noteDeadline ?? note0?.noteDeadline ?? null
  const effectiveDeadline = noteDl !== null ? Math.min(promisedDeadline, noteDl) : promisedDeadline

  let totalRoadMinutes = 0
  let totalRoadKm = 0
  let privatePickupCount = 0
  let privateDeliveryCount = 0
  let needsChargingAny = false
  const needsPlatesAny = Boolean(note0?.needsPlates)
  const manualRequired = Boolean(note0?.manualGearbox)
  const premiumAny = legs.some((l) => l.car.premium)
  const summerTyres = Boolean(note0?.summerTyres)
  let snowOverlap = false

  // 1. Forward earliest feasible execution plan
  let at = now + 20
  let earliestPickupAt = 0
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    const prev = i > 0 ? legs[i - 1]! : undefined
    const n = notes[i]

    const sameCustomerTradeIn =
      prev !== undefined &&
      prev.delivery.placeId === leg.pickup.placeId &&
      prev.delivery.privateAddress &&
      leg.pickup.privateAddress

    const linkRoad = prev === undefined ? 0 : sameCustomerTradeIn ? 0 : map.roadMinutes(prev.delivery.placeId, leg.pickup.placeId)
    const driveRoad = map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId)
    const driveKm = map.roadKm(leg.pickup.placeId, leg.delivery.placeId)
    if (!Number.isFinite(linkRoad) || !Number.isFinite(driveRoad)) return undefined

    totalRoadMinutes += linkRoad + driveRoad
    totalRoadKm += driveKm + (prev === undefined || sameCustomerTradeIn ? 0 : map.roadKm(prev.delivery.placeId, leg.pickup.placeId))
    if (leg.pickup.privateAddress) privatePickupCount++
    if (leg.delivery.privateAddress) privateDeliveryCount++

    const charging = map.needsCharging(leg.car, leg.pickup.placeId, leg.delivery.placeId)
    if (charging) needsChargingAny = true
    const plates = i === 0 && needsPlatesAny

    const pickHours = n?.pickupHours ?? leg.pickup.hours
    const delivHours = n?.deliveryHours ?? leg.delivery.hours

    let pickEarliest = Math.max(
      at + linkRoad,
      leg.pickup.window.from,
      n?.readyAt ?? 0,
      n?.releasedAt ?? 0,
    )
    const pickLatest = leg.pickup.privateAddress
      ? leg.pickup.window.to + (sameCustomerTradeIn ? 30 : 0)
      : effectiveDeadline

    // Summer tyres cannot be collected during active snow at pickup or delivery
    const snowWin = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, pickEarliest, pickEarliest + driveRoad + 60)
    if (snowWin) {
      snowOverlap = true
      if (summerTyres) {
        pickEarliest = Math.max(pickEarliest, snowWin.to)
      }
    }

    const pickService = sameCustomerTradeIn ? 0 : 10
    let pickStart = visitAt(pickEarliest, pickLatest, pickHours, pickService)
    if (summerTyres) {
      for (let iter = 0; iter < 8 && Number.isFinite(pickStart); iter++) {
        const sw = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, pickStart, pickStart + driveRoad + 45)
        if (!sw) break
        snowOverlap = true
        pickEarliest = Math.max(pickEarliest + 1, sw.to)
        pickStart = visitAt(pickEarliest, pickLatest, pickHours, pickService)
      }
    }
    if (!Number.isFinite(pickStart)) return undefined
    if (i === 0) earliestPickupAt = pickStart

    const snowAtRun = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, pickStart, pickStart + Math.ceil(driveRoad * 1.35) + 60)
    if (snowAtRun) snowOverlap = true
    const effDrive = Math.ceil(driveRoad * (snowAtRun ? 1.32 : 1.04))
    const extraMinutes = (plates ? PLATES_MINUTES : 0) + (charging ? CHARGING_MINUTES : 0)

    const delivEarliest = Math.max(pickStart + pickService + extraMinutes + effDrive, leg.delivery.window.from)
    const delivLatest = leg.delivery.privateAddress
      ? Math.min(effectiveDeadline, leg.delivery.window.to + 30)
      : effectiveDeadline
    const delivService = 10
    const delivStart = visitAt(delivEarliest, delivLatest, delivHours, delivService)
    if (!Number.isFinite(delivStart)) return undefined

    at = delivStart + delivService
  }

  const canSingleGig = legs.length === 1 || totalRoadMinutes <= MAX_MULTI_CAR_ROAD_MINUTES

  // 2. Backward effectiveLastPickupAt (accounts for noteDeadline, note hours, plates, charging, snow, 20:00 cliff buffer)
  let latestNextPickup = Number.POSITIVE_INFINITY
  for (let i = legs.length - 1; i >= 0; i--) {
    const leg = legs[i]!
    const next = legs[i + 1]
    const n = notes[i]

    const sameCustomerNext =
      next !== undefined &&
      leg.delivery.placeId === next.pickup.placeId &&
      leg.delivery.privateAddress &&
      next.pickup.privateAddress

    const linkMinutes = !next ? 0 : sameCustomerNext ? 0 : map.roadMinutes(leg.delivery.placeId, next.pickup.placeId)
    const delivHours = n?.deliveryHours ?? leg.delivery.hours
    const pickHours = n?.pickupHours ?? leg.pickup.hours

    const delivWindowCap = leg.delivery.privateAddress ? leg.delivery.window.to + 30 : effectiveDeadline
    const delivCap = Math.min(effectiveDeadline, delivWindowCap, latestNextPickup - linkMinutes)
    // Add 15m safety buffer before dealer closing hours so stochastic drive variance doesn't roll to next morning
    const closeBuffer = delivHours ? 15 : 0
    const latestDeliv = latestOpenBefore(delivCap, delivHours, closeBuffer)
    const rawLatestDeliv = latestOpenBefore(delivCap, delivHours, 0)

    const baseDrive = map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId)
    const snowLate = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, Math.max(now, latestDeliv - baseDrive * 2), latestDeliv)
    const effDrive = Math.ceil(baseDrive * (snowLate ? 1.30 : 1.03))
    const charging = map.needsCharging(leg.car, leg.pickup.placeId, leg.delivery.placeId) ? CHARGING_MINUTES : 0
    const plates = i === 0 && needsPlatesAny ? PLATES_MINUTES : 0

    const pickWindowCap = leg.pickup.privateAddress
      ? leg.pickup.window.to + (i > 0 ? 30 : 0)
      : effectiveDeadline
    const pickCap = Math.min(latestDeliv - effDrive - charging - plates, pickWindowCap)
    const rawPickCap = Math.min(rawLatestDeliv - baseDrive - charging - plates, pickWindowCap)
    const bufferedPickup = latestOpenBefore(pickCap, pickHours, 0)
    const rawPickup = latestOpenBefore(rawPickCap, pickHours, 0)
    // Never let the 15m+3% clear-weather safety buffer jump 24-72h backward across a night/weekend boundary!
    latestNextPickup =
      !snowLate && Math.floor(bufferedPickup / DAY) < Math.floor(rawPickup / DAY)
        ? rawPickup
        : bufferedPickup
  }

  if (!Number.isFinite(latestNextPickup) || latestNextPickup < earliestPickupAt - 5 || latestNextPickup <= now + 20) {
    return undefined
  }

  const driverSearchStart = Math.max(now + 15, earliestPickupAt - 180)
  const pickupSlackMinutes = Math.max(0, latestNextPickup - Math.max(now + 15, Math.min(earliestPickupAt, latestNextPickup)))
  const rawBookingWindow = Math.max(0, latestNextPickup - now)
  void driverSearchStart

  return {
    promisedDeadline,
    effectiveDeadline,
    earliestPickupAt,
    finishAt: at,
    effectiveLastPickupAt: latestNextPickup,
    pickupSlackMinutes: Math.max(pickupSlackMinutes, Math.min(rawBookingWindow, latestNextPickup - earliestPickupAt + (earliestPickupAt - now))),
    deliverySlackMinutes: Math.max(0, effectiveDeadline - at),
    totalRoadMinutes,
    totalRoadKm,
    privatePickupCount,
    privateDeliveryCount,
    needsChargingAny,
    needsPlatesAny,
    manualRequired,
    premiumAny,
    snowOverlap,
    canSingleGig,
  }
}

function hoursNarrowed(realHours: OpeningHours | null, statedHours: OpeningHours | null): boolean {
  if (!realHours || !statedHours) return false
  return realHours.opens > statedHours.opens || realHours.closes < statedHours.closes
}

function nextRealDayWindow(
  earliest: number,
  latest: number,
  realHours: OpeningHours,
  minRemainingMinutes: number,
): TimeWindow | undefined {
  const startDay = Math.floor(earliest / DAY)
  const endDay = Math.floor(latest / DAY)
  for (let day = startDay; day <= endDay; day++) {
    const wd = ((day % 7) + 7) % 7
    const slot = wd === 5 ? realHours.saturday : realHours.weekdays.includes(wd) ? realHours : null
    if (!slot) continue
    const from = Math.max(earliest, day * DAY + slot.opens)
    const to = Math.min(latest, day * DAY + slot.closes)
    if (to - from >= minRemainingMinutes) {
      return { from, to }
    }
  }
  return undefined
}

export type BuiltOrderStops = {
  stops: StopRef[]
  audience: Audience
  awaitingPrivateSlotRollover: boolean
  effectiveLastPickupAt: number
}

export function buildStopsForOrder(
  map: MapGraph,
  snow: SnowTracker,
  order: Order,
  legIndices: readonly number[],
  notes: readonly ParsedLegNote[],
  retriesByLeg: ReadonlyMap<number, RetryState>,
  now: number,
  endsAt: number,
  omitSoftPickupCap = false,
): BuiltOrderStops {
  const combinedTradeIn = legIndices.length === 2 && order.legs.length === 2
  let manualLicence = false
  let experienced = false

  for (const idx of legIndices) {
    const leg = order.legs[idx]!
    if (leg.car.premium) experienced = true
    if (notes[idx]?.manualGearbox || retriesByLeg.get(idx)?.manualLicence) manualLicence = true
  }
  if (notes[0]?.manualGearbox) manualLicence = true

  // Precompute current effectiveLastPickupAt so dealer pickup windows can guard against 20:00 road-variance cliffs
  const subLegs = legIndices.map((i) => order.legs[i]!)
  const subNotes = legIndices.map((i) => notes[i] ?? {
    readyAt: order.legs[i]!.pickup.window.from,
    releasedAt: null,
    pickupHours: order.legs[i]!.pickup.hours,
    deliveryHours: order.legs[i]!.delivery.hours,
    manualGearbox: false,
    needsPlates: false,
    summerTyres: false,
    noteDeadline: null,
  })
  const plan = computeOptionPlan(map, snow, subLegs, subNotes, order.deadline, now, true)
  const effectiveLastPickupAt = plan ? plan.effectiveLastPickupAt : order.lastPickupAt

  const stops: StopRef[] = []
  let awaitingPrivateSlotRollover = false

  for (const idx of legIndices) {
    const leg = order.legs[idx]!
    const note = notes[idx]
    const retry = retriesByLeg.get(idx) ?? EMPTY_RETRY
    const isCombinedTradeInSecondLeg = combinedTradeIn && idx === 1

    const withCharging = map.needsCharging(leg.car, leg.pickup.placeId, leg.delivery.placeId)
    const withPlates = Boolean((idx === 0 && notes[0]?.needsPlates) || note?.needsPlates || retry.plates)

    // --- PICKUP STOP ---
    const pickupStop: StopRef = {
      orderId: order.id,
      leg: idx,
      kind: "pickup",
      ...(withPlates ? { withPlates: true } : {}),
      ...(withCharging ? { withCharging: true } : {}),
    }

    if (!isCombinedTradeInSecondLeg) {
      let minStart = Math.max(
        leg.pickup.window.from,
        idx === 0 ? (note?.readyAt ?? 0) : 0,
        idx === 0 ? (note?.releasedAt ?? 0) : 0,
        retry.pickupFrom,
      )

      // Avoid snow window for summer tyres (including after overnight opening-hours jump!)
      if (notes[0]?.summerTyres || note?.summerTyres) {
        const driveMin = map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId)
        const realPickH = note?.pickupHours ?? leg.pickup.hours
        for (let iter = 0; iter < 8; iter++) {
          const candPick = visitAt(Math.max(now, minStart), endsAt, realPickH, 10)
          if (!Number.isFinite(candPick)) break
          const sw = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, candPick, candPick + driveMin + 45)
          if (!sw) break
          minStart = Math.max(minStart + 1, sw.to)
        }
      }

      if (leg.pickup.privateAddress) {
        const slotFrom = leg.pickup.window.from
        const slotTo = leg.pickup.window.to
        if (slotTo <= now + 5 || minStart > slotTo - 5) {
          awaitingPrivateSlotRollover = true
        } else if (minStart > slotFrom) {
          pickupStop.window = { from: minStart, to: slotTo }
        }
      } else {
        const realPickHours = note?.pickupHours ?? leg.pickup.hours
        const narrowedPick = hoursNarrowed(realPickHours, leg.pickup.hours)
        if (narrowedPick && realPickHours) {
          const searchEarliest = Math.max(now + 10, minStart)
          const searchLatest = omitSoftPickupCap ? endsAt - 60 : Math.max(order.deadline, searchEarliest + 3 * DAY)
          const dayWin = nextRealDayWindow(searchEarliest, Math.min(endsAt - 60, searchLatest), realPickHours, 45)
          if (dayWin && dayWin.to > now + 15) {
            pickupStop.window = {
              from: Math.max(leg.pickup.window.from, dayWin.from),
              to: dayWin.to,
            }
          }
        } else if (minStart > leg.pickup.window.from && minStart > now) {
          const toBound = !omitSoftPickupCap && order.deadline > minStart + 60 ? order.deadline : endsAt - 30
          if (toBound > minStart && toBound > now + 15) {
            pickupStop.window = { from: minStart, to: toBound }
          }
        }

        // Guard standard dealer stops against picking up 1-5m before raw lastPickupAt and missing 20:00 by drive variance,
        // AND even when omitSoftPickupCap is true, always enforce the physical end-of-world arrival cutoff before endsAt!
        if (idx === legIndices[0]) {
          const lastLegObj = order.legs[legIndices[legIndices.length - 1]!]!
          const lastNoteObj = notes[legIndices[legIndices.length - 1]!]
          const lastDelivH = lastNoteObj?.deliveryHours ?? lastLegObj.delivery.hours
          let totRoad = 0
          let extraM = 0
          for (let k = 0; k < legIndices.length; k++) {
            const li = legIndices[k]!
            const lObj = order.legs[li]!
            const nObj = notes[li]
            const rObj = retriesByLeg.get(li) ?? EMPTY_RETRY
            totRoad += map.roadMinutes(lObj.pickup.placeId, lObj.delivery.placeId)
            if (k > 0) {
              const prevObj = order.legs[legIndices[k - 1]!]!
              const sameCust =
                prevObj.delivery.placeId === lObj.pickup.placeId &&
                prevObj.delivery.privateAddress &&
                lObj.pickup.privateAddress
              if (!sameCust) totRoad += map.roadMinutes(prevObj.delivery.placeId, lObj.pickup.placeId)
              extraM += 20
            }
            if (map.needsCharging(lObj.car, lObj.pickup.placeId, lObj.delivery.placeId)) extraM += CHARGING_MINUTES
            if ((li === 0 && notes[0]?.needsPlates) || nObj?.needsPlates || rObj.plates) extraM += PLATES_MINUTES
          }
          const endWorldSw = snow.overlaps(
            leg.pickup.placeId,
            lastLegObj.delivery.placeId,
            Math.max(now, endsAt - DAY),
            endsAt,
          )
          const endWorldDeliv = lastDelivH ? latestOpenBefore(endsAt, lastDelivH, 15) : endsAt - 15
          const endWorldPickCap = endWorldDeliv - Math.ceil(totRoad * (endWorldSw ? 1.32 : 1.06)) - extraM - 20

          if (
            !omitSoftPickupCap &&
            effectiveLastPickupAt < order.lastPickupAt &&
            effectiveLastPickupAt > Math.max(now + 75, minStart + 30)
          ) {
            const curFrom = pickupStop.window?.from ?? minStart
            const curTo = pickupStop.window?.to ?? order.deadline
            const cappedTo = Math.min(curTo, effectiveLastPickupAt)
            if (cappedTo >= curFrom + 20) {
              pickupStop.window = { from: Math.max(leg.pickup.window.from, curFrom), to: cappedTo }
            }
          } else if (
            omitSoftPickupCap &&
            Number.isFinite(endWorldPickCap) &&
            endWorldPickCap < endsAt - 30 &&
            endWorldPickCap > Math.max(now + 45, minStart + 25)
          ) {
            const curFrom = pickupStop.window?.from ?? minStart
            const curTo = pickupStop.window?.to ?? endsAt - 30
            const cappedTo = Math.min(curTo, endWorldPickCap)
            if (cappedTo >= curFrom + 20) {
              pickupStop.window = { from: Math.max(leg.pickup.window.from, curFrom), to: cappedTo }
            }
          }
        }
      }
    }
    stops.push(pickupStop)

    // --- DELIVERY STOP ---
    const deliveryStop: StopRef = {
      orderId: order.id,
      leg: idx,
      kind: "delivery",
    }

    const driveMin =
      map.roadMinutes(leg.pickup.placeId, leg.delivery.placeId) +
      (withCharging ? CHARGING_MINUTES : 0) +
      (withPlates ? PLATES_MINUTES : 0)

    if (leg.delivery.privateAddress) {
      // On leg 0 of an on-time 2-leg trade-in, cap leg 0 delivery to customer's booked slot + 30m (omit when already late so server extends to endsAt!)
      if (!omitSoftPickupCap && combinedTradeIn && idx === 0) {
        const minReach = Math.max(now + 15, pickupStop.window?.from ?? leg.pickup.window.from) + driveMin + 10
        if (leg.delivery.window.to + 30 >= minReach && leg.delivery.window.to + 30 > now + 30) {
          deliveryStop.window = {
            from: leg.delivery.window.from,
            to: leg.delivery.window.to + 30,
          }
        }
      }
    } else {
      const noteDl = note?.noteDeadline ?? (idx === order.legs.length - 1 ? (notes[0]?.noteDeadline ?? null) : null)
      const effDl = noteDl !== null ? Math.min(order.deadline, noteDl) : order.deadline
      const realDelivHours = note?.deliveryHours ?? (idx === order.legs.length - 1 ? (notes[notes.length - 1]?.deliveryHours ?? leg.delivery.hours) : leg.delivery.hours)
      const narrowedDeliv = hoursNarrowed(realDelivHours, leg.delivery.hours)
      const minReachableDeliv = Math.max(now + 15, pickupStop.window?.from ?? leg.pickup.window.from) + driveMin + 20

      if (narrowedDeliv && realDelivHours) {
        if (!omitSoftPickupCap && minReachableDeliv <= effDl) {
          const firstWin = nextRealDayWindow(minReachableDeliv, effDl, realDelivHours, 30)
          if (firstWin && firstWin.to - minReachableDeliv < 150) {
            const nextDayStart = (Math.floor(firstWin.to / DAY) + 1) * DAY
            const laterWin = nextRealDayWindow(Math.max(minReachableDeliv, nextDayStart), effDl, realDelivHours, 30)
            if (laterWin && laterWin.to > now + 30) {
              deliveryStop.window = {
                from: Math.max(leg.delivery.window.from, laterWin.from),
                to: laterWin.to,
              }
            } else if (firstWin.to > now + 30) {
              deliveryStop.window = {
                from: Math.max(leg.delivery.window.from, firstWin.from),
                to: firstWin.to,
              }
            }
          } else if (firstWin && firstWin.to > now + 30) {
            deliveryStop.window = {
              from: Math.max(leg.delivery.window.from, firstWin.from),
              to: firstWin.to,
            }
          }
        } else {
          const nextWin = nextRealDayWindow(minReachableDeliv, endsAt - 30, realDelivHours, 45)
          if (nextWin && nextWin.to > now + 30) {
            deliveryStop.window = {
              from: Math.max(leg.delivery.window.from, nextWin.from),
              to: nextWin.to,
            }
          }
        }
      } else if (!omitSoftPickupCap && effDl < order.deadline && minReachableDeliv <= effDl && effDl > now + 30) {
        deliveryStop.window = {
          from: leg.delivery.window.from,
          to: effDl,
        }
      }

      if (omitSoftPickupCap && !deliveryStop.window && idx === legIndices[legIndices.length - 1] && endsAt - now <= 60 * HOUR) {
        const endWorldDeliv = realDelivHours ? latestOpenBefore(endsAt, realDelivHours, 15) : endsAt - 15
        if (
          Number.isFinite(endWorldDeliv) &&
          endWorldDeliv < endsAt - 15 &&
          endWorldDeliv >= minReachableDeliv &&
          endWorldDeliv > now + 30
        ) {
          deliveryStop.window = {
            from: leg.delivery.window.from,
            to: endWorldDeliv,
          }
        }
      }
    }

    stops.push(deliveryStop)
  }

  return {
    stops,
    audience: { experienced, manualLicence },
    awaitingPrivateSlotRollover,
    effectiveLastPickupAt,
  }
}
