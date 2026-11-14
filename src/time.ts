import type { OpeningHours } from "./types.ts"

export const HOUR = 60
export const DAY = 24 * HOUR

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const

export function dayOf(minute: number): number {
  return Math.floor(minute / DAY)
}

export function dayStartOf(minute: number): number {
  return Math.floor(minute / DAY) * DAY
}

export function todOf(minute: number): number {
  return ((minute % DAY) + DAY) % DAY
}

export function weekdayOfDay(day: number): number {
  return ((day % 7) + 7) % 7
}

/** Shifts overnight fee-step timestamps (22:45..07:05) to morning wake (07:05 + 25m stagger). */
export function clampOutOfNight(t: number, staggerIdx = 0): number {
  const day = dayOf(t)
  const tod = todOf(t)
  if (tod >= 22 * HOUR + 45) {
    return (day + 1) * DAY + 7 * HOUR + 5 + staggerIdx * 25
  }
  if (tod < 7 * HOUR + 5) {
    return day * DAY + 7 * HOUR + 5 + staggerIdx * 25
  }
  return t
}

/** Shifts overnight timer wakeups (>22:40 or <07:00) to the next 07:05 awake boundary. */
export function clampTriggerToAwakeWindow(t: number): number {
  const tod = todOf(t)
  if (tod > 22 * HOUR + 40) return (dayOf(t) + 1) * DAY + 7 * HOUR + 5
  if (tod < 7 * HOUR) return dayStartOf(t) + 7 * HOUR + 5
  return t
}

export function cloneOpeningHours(hours: OpeningHours | null): OpeningHours | null {
  if (!hours) return null
  return {
    opens: hours.opens,
    closes: hours.closes,
    weekdays: [...hours.weekdays],
    saturday: hours.saturday ? { ...hours.saturday } : null,
  }
}

export function openingSlotForDay(
  hours: OpeningHours,
  day: number,
): { opens: number; closes: number } | null {
  const wd = weekdayOfDay(day)
  return wd === 5 ? hours.saturday : hours.weekdays.includes(wd) ? hours : null
}

/** Shifts a dealer deadline forward by `shift` business days (skipping Sat/Sun, capped at last Monday). */
export function shiftDeadlineBusinessDays(deadline: number, shift: number): number {
  if (shift <= 0) return deadline
  let day = dayOf(deadline)
  const tod = deadline % DAY
  let rem = shift
  while (rem > 0) {
    day++
    const wd = weekdayOfDay(day)
    if (wd !== 5 && wd !== 6) rem--
  }
  return Math.min(7 * DAY + tod, day * DAY + tod)
}
