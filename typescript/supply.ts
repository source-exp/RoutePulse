import type { MapGraph } from "./planner.ts"
import type { DriverProfile } from "./types.ts"

export type TownCounts = {
  all: number
  exp: number
  man: number
  expMan: number
}

export function isExperiencedDriver(driver: DriverProfile): boolean {
  return driver.rating >= 4.8 && driver.completedGigs >= 50
}

function emptyTownCounts(): TownCounts {
  return { all: 0, exp: 0, man: 0, expMan: 0 }
}

function addTownCounts(dst: TownCounts, src: TownCounts): void {
  dst.all += src.all
  dst.exp += src.exp
  dst.man += src.man
  dst.expMan += src.expMan
}

function selectPoolCount(counts: TownCounts | undefined, experienced: boolean, manual: boolean): number {
  if (!counts) return 0
  if (experienced && manual) return counts.expMan
  if (experienced) return counts.exp
  if (manual) return counts.man
  return counts.all
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

    for (const placeId of this.map.placesById.keys()) {
      this.homeCounts.set(placeId, emptyTownCounts())
      this.pool30Counts.set(placeId, emptyTownCounts())
      this.pool65Counts.set(placeId, emptyTownCounts())
    }

    for (const d of roster) {
      this.byId.set(d.id, d)
      const isExp = isExperiencedDriver(d)
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
        if (h) addTownCounts(c30, h)
      }
    }

    for (const [placeId, n65] of this.map.within65km.entries()) {
      const c65 = this.pool65Counts.get(placeId)!
      for (const q of n65) {
        const h = this.homeCounts.get(q)
        if (h) addTownCounts(c65, h)
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
    return selectPoolCount(this.pool30Counts.get(placeId), experienced, manual)
  }

  pool65(placeId: string, experienced = false, manual = false): number {
    return selectPoolCount(this.pool65Counts.get(placeId), experienced, manual)
  }
}
