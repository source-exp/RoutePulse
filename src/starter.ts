import { parseArgs } from "node:util"
import { Desk } from "./desk.ts"
import { Client, SpreadError, Unreachable, World } from "./spread.ts"
import type { DeskEvent, DeskEventKind, Score } from "./spread.ts"
import { DAY, dayOf, WEEKDAYS } from "./time.ts"

const WAKE_ON: DeskEventKind[] = [
  "price_request",
  "order_won",
  "order_changed",
  "order_cancelled",
  "visit_failed",
  "gig_expired",
  "deadline_close",
  "gig_booked",
  "gig_dropped",
  "no_show",
  "driver_late",
  "offer_answered",
  "delivered",
  "release",
  "forecast",
]

async function playPractice(world: World, level: number): Promise<void> {
  const [snapshot, rawMap, roster] = await Promise.all([
    world.snapshot(),
    world.client.map(),
    world.roster(),
  ])
  const { now, endsAt } = snapshot
  const desk = new Desk(world, level, now, endsAt, rawMap, roster)
  if (now > 0) {
    const history = await world.events()
    await desk.rejoin(snapshot, history)
    desk.tickTimers(false)
  }

  while (desk.now < endsAt) {
    const day = dayOf(desk.now)
    const midnight = (day + 1) * DAY
    const stopAt = Math.min(endsAt, midnight, desk.nextTimerAt())
    const actions = desk.drainOutboxSorted()
    const step = await world.advance({ untilEvent: WAKE_ON, max: stopAt, actions })
    desk.readResults(actions, step.results)
    desk.now = step.now
    for (const event of step.events) desk.handle(event)
    desk.flushPendingPriceRequests()
    desk.tickTimers(false)
    if (dayOf(desk.now) > day) {
      report(WEEKDAYS[day % 7]!, await world.score())
    }
  }
  desk.finalizePendingRevenue(endsAt)
  await desk.send(false)
}

async function playFinal(world: World): Promise<void> {
  const [worlds, rawMap, roster] = await Promise.all([
    world.client.worlds(),
    world.client.map(),
    world.roster(),
  ])
  const history0 = await world.events()
  const snapshot = await world.snapshot()
  if (snapshot.now >= snapshot.endsAt) return
  const seq0 = history0.at(-1)?.seq ?? -1
  const tail = await world.events(seq0)
  const fullHistory = [...history0, ...tail]
  const startAfterSeq = fullHistory.at(-1)?.seq ?? -1
  const level = worlds.find((summary) => summary.worldId === world.id)?.level ?? 8
  const desk = new Desk(world, level, snapshot.now, snapshot.endsAt, rawMap, roster)
  desk.isFinal = true
  await desk.rejoin(snapshot, fullHistory)
  desk.tickTimers(true)
  await desk.send(true)

  let lastRosterFetchMs = performance.now()
  let lastIdleFinalCheckMs = 0
  let lastSeq = startAfterSeq

  const pending: Array<DeskEvent | null> = []
  let streamDone = false
  let streamError: unknown = null
  let notifyPump = () => {}
  const abortCtrl = new AbortController()

  void (async () => {
    try {
      for await (const ev of world.stream({ after: startAfterSeq, idleMs: 600, signal: abortCtrl.signal })) {
        pending.push(ev)
        notifyPump()
      }
    } catch (err) {
      streamError = err
    } finally {
      streamDone = true
      notifyPump()
    }
  })()

  try {
    while (!streamDone || pending.length > 0) {
      if (streamError) throw streamError
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          notifyPump = resolve
        })
        if (pending.length === 0) continue
      }
      await new Promise((resolve) => setTimeout(resolve, 6))

      const day = dayOf(desk.now)
      const batch = pending.splice(0)
      let sawNull = false
      for (const item of batch) {
        if (item === null) sawNull = true
        else if (item.seq > lastSeq) {
          lastSeq = item.seq
          desk.handle(item)
        }
      }
      if (sawNull && batch.every((x) => x === null) && performance.now() - lastIdleFinalCheckMs >= 4_000) {
        lastIdleFinalCheckMs = performance.now()
        const f = await world.client.final().catch(() => null)
        if (f && f.now > desk.now) {
          const missed = await world.events(lastSeq).catch(() => [])
          for (const ev of missed) {
            if (ev.seq > lastSeq) {
              lastSeq = ev.seq
              desk.handle(ev)
            }
          }
          desk.now = Math.max(desk.now, f.now)
        }
      }
      desk.flushPendingPriceRequests()

      if (desk.hasPendingQuote()) {
        await desk.sendQuotesOnly()
      }
      desk.tickTimers(true)
      await desk.send(true)

      if (performance.now() - lastRosterFetchMs > 45_000) {
        lastRosterFetchMs = performance.now()
        void world
          .roster()
          .then((fresh) => {
            if (fresh) desk.supply.updateRoster(fresh)
          })
          .catch(() => null)
      }

      if (dayOf(desk.now) > day) {
        void world
          .score()
          .then((sc) => {
            if (sc) report(WEEKDAYS[day % 7]!, sc)
          })
          .catch(() => null)
      }
      if (desk.now >= snapshot.endsAt) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        if (pending.length > 0) continue
        desk.finalizePendingRevenue(snapshot.endsAt)
        return
      }
    }
    const endSnap = await world.snapshot()
    if (endSnap.now < endSnap.endsAt) {
      throw new Unreachable(0, `Stream closed early at minute ${endSnap.now}/${endSnap.endsAt}`)
    }
  } finally {
    abortCtrl.abort()
  }
}

function report(label: string, score: Score): void {
  const euros = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(11)
  const percent = (share: number, width: number) => `${(100 * share).toFixed(1)}%`.padStart(width)
  const orders = `${String(score.wonOrders).padStart(4)} orders  ${percent(score.onTimeShare, 6)} on time  ${percent(score.undeliveredShare, 5)} not delivered`
  console.log(`${label.padEnd(9)}  margin €${euros(score.marginCents)}  revenue €${euros(score.revenueCents)}  ${orders}`)
}

async function nextFinal(client: Client): Promise<World> {
  for (let said = false; ; said = true) {
    const set = await client.final().catch((error: unknown) => {
      if (error instanceof SpreadError && error.status === 404) return null
      throw error
    })
    const world = set ? client.world(set.worldId) : null
    if (world) {
      const snapshot = await world.snapshot()
      if (snapshot.now < snapshot.endsAt) return world
    }
    if (!said) {
      console.log(
        "No final is set. Waiting for it: the organisers set a test final 15 minutes before its start, and the final 30 minutes before.",
      )
    }
    await new Promise((done) => setTimeout(done, 10_000))
  }
}

const USAGE =
  "Usage: bun starter.ts [--level 1-8] [--seed <text>] [--board] [--final]. Set SPREAD_URL and SPREAD_KEY first."

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      level: { type: "string", default: "8" },
      seed: { type: "string" },
      board: { type: "boolean" },
      final: { type: "boolean" },
    },
  })
  const level = Number(args.level)
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(level)) throw new SpreadError(0, `--level must be 1 to 8. ${USAGE}`)
  const client = new Client()
  let world: World | undefined
  let score: Score | undefined

  if (args.final) {
    process.once("SIGINT", () =>
      exit("Stopped. The final world keeps running without your system; start it again with --final."),
    )
    while (true) {
      try {
        if (!world) {
          world = await nextFinal(client)
          console.log(`Final world ${world.id}.`)
        }
        await playFinal(world)
        score = await world.score()
        break
      } catch (error) {
        if (error instanceof SpreadError && error.status === 401) throw error
        console.error(`spread: ${(error as Error).message}. Rebuilding and continuing in 3 seconds.`)
        await new Promise((done) => setTimeout(done, 3000))
      }
    }
  } else if (args.board) {
    process.once("SIGINT", () =>
      exit("Stopped. The ranking run stays paused on the server; re-run with --board to resume and finish it."),
    )
    const existingWorlds = await client.worlds()
    const unfinishedBoard = existingWorlds.find((w) => w.boardRun !== null && w.level === level && !w.ended)
    const run = unfinishedBoard
      ? client.world(unfinishedBoard.worldId)
      : await client.create(level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, { board: true })
    world = run
    console.log(
      `Ranking run ${run.id}${unfinishedBoard ? ` (resumed run ${unfinishedBoard.boardRun})` : ""}, level ${level}.`,
    )
    while (true) {
      try {
        await playPractice(run, level)
        break
      } catch (error) {
        if (error instanceof SpreadError && (error.status === 401 || error.status === 400)) throw error
        console.error(`spread: ${(error as Error).message}. Rebuilding ranking desk and continuing in 3 seconds.`)
        await new Promise((done) => setTimeout(done, 3000))
      }
    }
  } else {
    const run = await client.create(level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, { seed: args.seed, board: false })
    world = run
    const name = `Practice world ${run.id}`
    const afterStop = (deleted: boolean) =>
      deleted
        ? `${name} is deleted.`
        : `${name} is not deleted: it holds one of your eight practice slots.`
    console.log(`${name}, level ${level}. Ctrl-C or an error stops the run and deletes the world.`)
    const remove = () => run.delete().then(() => true, () => false)
    process.once("SIGINT", () => void remove().then((deleted) => exit(`Stopped. ${afterStop(deleted)}`)))
    await playPractice(run, level).catch(async (error: unknown) => {
      console.error(`Stopped by the error below. ${afterStop(await remove())}`)
      throw error
    })
  }

  score ??= await world.score()
  report("End", score)
  console.log(
    score.ranked
      ? "Ranked."
      : score.wonOrders === 0
        ? "Not ranked: no order won."
        : "Not ranked: the delivery minimum is 90% of the orders on time.",
  )
}

function exit(message: string): never {
  console.error(message)
  process.exit(1)
}

await main().catch((error: unknown) => {
  if (error instanceof SpreadError) exit(`spread: ${error.message}`)
  if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    exit(`${error.message}. ${USAGE}`)
  }
  throw error
})
