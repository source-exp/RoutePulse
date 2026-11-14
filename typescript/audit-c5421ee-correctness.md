# Spread Level-8 Correctness & Live `--final` Safety Audit (`main` @ `c5421ee`)

**Scope:** Static correctness, state-machine, rate-limit, and live-stream audit of `/home/Corgi/RoutePulse/typescript/` (`starter.ts`, `market.ts`, `dispatch.ts`, `planner.ts`, `notes.ts`, `spread.ts`) at commit `c5421ee`, cross-referenced against `RULES.md`, `HANDBOOK.md`, `API.md`, and local reveal traces (`reveal-baseline-spread-1`). No production files were modified and no worlds/rankings were executed.

---

## Executive Summary & Priority Matrix

Practice runs (`playPractice`) process all events at a world minute as a synchronous batch (`step.events`) and execute actions atomically inside `world.advance()`. **Live `--final` and Saturday Test Finals (`playFinal`) do neither**: `world.stream()` yields one `DeskEvent` at a time while the server clock advances at **300 ms per world minute** on weekdays (**4.5 real seconds** for `respondBy`) and **50 ms per world minute** at night/Sunday/Tue–Wed, under strict per-action (`final-actions`: 20/s, burst 50) and per-read (`final-reads`: 50/s, burst 50) token buckets.

This audit uncovered **8 P0/Critical bugs** (4 of which are **`--final`-only timebombs** invisible in practice benchmarks, plus 4 logic bugs affecting both practice and final), **6 P1/High-Priority bugs**, and **4 P2/Medium edge cases**:

| ID | Severity | File : Lines | Summary |
|---|---|---|---|
| **C1** | 🚨 CRITICAL | `starter.ts:1459, 1707-1715` | **`--final` misclassifies 100% of late deliveries as on-time:** `tickTimers()` calls `finalizePendingRevenue(this.now)` after `revenue` (`seq k`) before `late_refund` (`seq k+1`, same `at`) is read from `world.stream()`, blinding the 90% ranking safety gate and inflating `dealer.trust` instead of halving it. |
| **C2** | 🚨 CRITICAL | `starter.ts:1707-1720`, `spread.ts:78-85, 204-211` | **`--final` 4.5s `respondBy` starvation on 30–40 car bulk orders:** per-event `await desk.send()` + duplicate `queueDirectOffersForOpenGigs(2)` + no quote fast-lane stalls 40 bulk quotes behind HTTP RTTs and `final-actions` (20/s) offer/post bursts (`105 actions = 5.25s > 4.5s`). |
| **C3** | 🚨 CRITICAL | `starter.ts:1585-1657, 1716` | **`--final` duplicate-gig race on `[withdraw/release, post]` batches & missing `release` refusal rollback:** in live clock mode, `withdraw`/`release` can be refused because a driver just booked/started, while the companion `post` in the same batch still executes (or `legGigs` stays unlinked when `res.reason` says `"started"` instead of `"book"`). |
| **C4** | 🚨 CRITICAL | `starter.ts:413-508, 1687-1712, 1794-1798`, `dispatch.ts:568-575` | **`rejoin()` & `--final` recovery hazards:** (a) `snapshot()` before `events()` drops `order_won`/`price_request` in the gap; (b) `rollbackOfferRefused` + `rejoin` causes an **infinite `offer` refusal spin-loop** draining `final-actions` at 20/s; (c) transient `Unreachable` on idle `client.final()` wipes `CompetitorMarketEstimator` & `fluActiveToday`; (d) Saturday Test-Final (`Thu 00:00` start) collapses `paceRatio` to `0.068`. |
| **C5** | 🚨 CRITICAL | `planner.ts:188-194, 422` | **Double-shifted deadline (`+24h` to `+96h`) on won orders with next-day+ `note.readyAt`:** `order_won` already carries the shifted `order.deadline` while `order.legs[0].pickup.window.from` keeps the unshifted stated ready time (proven on `R00049`, `R00389`, `R00538`). `buildStopsForOrder` shifts `order.deadline` a **second** time, delaying fee ramps and urgent rescues until 24h after the real deadline. |
| **C6** | 🚨 CRITICAL | `starter.ts:900-920` | **`handleReleaseEvent` posts duplicate gigs & corrupts `pairingBufferUntil` / 2-leg trade-ins:** when `release` fires at `respondBy` (`order_won` same step) or while an order is in `pairingBufferUntil` / `outbox`, `!gid` triggers an unconditional second `post` without clearing `outbox` or `pairingBufferUntil`. |
| **C7** | 🚨 CRITICAL | `starter.ts:87, 1331, 1627-1643` | **Infinite `post`-refusal loop (`meta.strippedFallback` never checked):** `PendingPostMeta.strippedFallback` is populated at line 1331 and ignored at line 1633; any refused stripped post re-enqueues itself forever, burning `final-actions` tokens. |
| **C8** | 🚨 CRITICAL | `starter.ts:588-614`, `market.ts:566, 580-588, 676-680` | **Bulk-order intra-batch blindness (30–40 cars, `batchId != null`):** all 40 requests arriving at minute `T` see `0` pending wins from `[0..39]`, underpricing local `Q30` cluster saturation (`open30`) and `dayLoad`, risking catastrophic single-yard over-winning. |
| **H1** | ⚠️ HIGH | `starter.ts:1143-1185, 1363`, `dispatch.ts:393-492, 580, 752` | **3-car & 2-car bundle audit (`tryExtendTwoToThreeOrderBundle`):** direct offers immediately bid `0.93x–1.05x * refSum` on bundles posted at `0.52x–0.58x * refSum` (wiping out €50–€100+ savings); 3-car extender skips `urgent`/`doNotBundle` on `o1,o2` and ignores snow in deadhead links & `mktMult`; `shortened` bundles keep `isBundledTwoOrder = true`; `recordOfferAnswered` clears `globalOpenOfferDrivers` across gigs. |
| **H2** | ⚠️ HIGH | `starter.ts:566, 922-940, 951-958, 273-315` | **`handleVisitFailed` leaves failed gigs in `status = "working"` forever:** driver stays permanently blocked (`overlaps = true`) in `DirectOfferTracker` for the rest of the week and creates phantom `hasArrivingDriverSynergy` (`-14%` quote underpricing). |
| **H3** | ⚠️ HIGH | `starter.ts:1307-1314, 1499-1515`, `planner.ts:530-573` | **`zombieCleared` & `stripWindowsOrders` defects:** withdraws 1-minute-old past-deadline gigs at `lastPickupAt + 1` (killing open offers/notifications when `lastPickupAt` is already "first collectible minute"); misses earlier zombie cutoffs from `withPlates` / `noteDeadline`; and strips non-private **pickup** windows (`readyAt`, `releasedAt`, `retry.pickupFrom`, `pickupHours`, `summerTyres`), causing `visit_failed` fines. |
| **H4** | ⚠️ HIGH | `starter.ts:823-867` | **`handleDriverLate` defects:** mixes Leg 0 drive with Leg 1 hours/deadline on 2-leg trade-ins, and adds `+10m` post-arrival service to `visitAt` (falsely releasing scarce booked drivers arriving 1–9m before close/deadline). |
| **H5** | ⚠️ HIGH | `starter.ts:637-700, 1055-1057` | **`handleOrderChanged` defects:** keeps stale `noteDeadline` after snow deadline extensions or destination reroutes; skips updating `effectiveLastPickupByOrder` on booked gigs; misses EV `<30%` reroutes crossing `>200km` (`€100` fine + `90m` late); never scales `changedKmScale` down on shortened routes. |
| **H6** | ⚠️ HIGH | `planner.ts:251-260, 455-459` | **`summerTyres` snow check runs before `visitAt` opening-hours jump:** an evening/weekend `pickEarliest` checks clear night sky while `visitAt` places pickup right into next-morning/Monday active snow (`visit_failed: "not_ready"`). |
| **M1** | 💡 MEDIUM | `planner.ts:539-548` | **`narrowedDeliv` sets `deliveryStop.window.from` to next day** when `firstWin.to - minReachableDeliv < 150`, outlawing valid same-day afternoon deliveries. |
| **M2** | 💡 MEDIUM | `notes.ts:76-86, 218-224, 296-305`, `planner.ts:435, 455` | **`notes.ts` & multi-leg note edge cases:** negated contrast (`"ei klo 12 vaan klo 15"` / `"not 3pm but 5pm"`) extracts the denied time; `"half past two"` extracts `14:00` instead of `14:30`; `withPlates`/`summerTyres` skip Leg 1 when split. |
| **M3** | 💡 MEDIUM | `starter.ts:299-303, 1069, 1318, 1523`, `dispatch.ts:122` | **Urgent threshold drift (`245/205` vs `205` vs `210` vs `240/195`) & `activeCommitments` ignoring `gig_started`/`picked_up` progress.** |
| **M4** | 💡 MEDIUM | `spread.ts:69-73, 166-170`, `market.ts:241, 349` | **Defensive guards on `RateLimit` headers / `429 Retry-After` and tracking `dealer.unquotedCount` on missed/refused quotes.** |

---

## 🚨 CRITICAL (Must Fix Before Test Finals / Deployment)

### C1. `--final` Misclassifies 100% of Late Deliveries as On-Time (`starter.ts:1459`, `1707-1715`)

#### Evidence & Mechanism
When an order is delivered late at minute `T`, the server emits `revenue` **before** `late_refund` at the same timestamp `at = T` (verified in `reveal-baseline-spread-1/events.csv:7974-7976`):
```text
seq 8190, at 1201, delivered, g72, R00074, 0, hyvinkaa
seq 8191, at 1201, ledger, revenue, 3500, R00074
seq 8192, at 1201, ledger, late_refund, -875, R00074
```
In `playPractice` (`starter.ts:1677-1678`), all events in `step.events` are processed by `desk.handle(event)` **before** `desk.tickTimers()` runs, so both `seq 8191` and `seq 8192` are recorded before `finalizePendingRevenue(this.now)` executes.

In `playFinal` (`starter.ts:1707-1715`), `world.stream()` yields one event per loop iteration:
1. On `seq 8191` (`revenue` at `at = 1201`), `desk.handle()` inserts `pendingRevenueOrders.set("R00074", { dealerId, at: 1201 })` (`starter.ts:581`).
2. Immediately on line `1715` — **before `seq 8192` (`late_refund`) is yielded by `world.stream()`** — `playFinal` calls `desk.tickTimers()`, whose second line (`starter.ts:1459`) executes:
   ```ts
   this.finalizePendingRevenue(this.now) // upToMinute = 1201 -> info.at > 1201 is FALSE!
   ```
3. `finalizePendingRevenue` immediately pops `"R00074"`, sees `!this.lateOrPenalizedOrders.has("R00074") === true`, increments `deliveredOnTimeTotal++`, and calls `onOrderDelivered(dealerId, true)` (`trust + 1` instead of `Math.floor(trust / 2)`, `lateCount` unchanged).
4. Next iteration (`seq 8192`), `late_refund` adds `"R00074"` to `lateOrPenalizedOrders`, which is never consulted again.

**Impact:** In live `--final` and Saturday Test Finals, `deliveredOnTimeTotal / deliveredOrdersTotal` permanently reads `1.000` (disabling the `maxAllowedPLate` ranking clamp in `market.ts:615-620` even if actual on-time share drops below 90%), while late deliveries to VIP dealers increase modeled trust instead of halving it (>20% pricing delusion).

#### Concrete Fix
1. In `tickTimers()` (`starter.ts:1459`), only finalize strictly older minutes:
   ```ts
   this.finalizePendingRevenue(this.now - 1)
   ```
2. Track `finalizedOnTimeOrders = new Map<string, string>()` (`orderId -> dealerId`) so if a `late_refund` or `undelivered_penalty` ever arrives at the same minute *after* finalization (e.g., idle poll race), it retroactively corrects `deliveredOnTimeTotal--` and reconciles dealer trust/lateCount, and flush `finalizePendingRevenue(this.now)` only when `this.now >= this.endsAt`.
3. Coalesce queued WebSocket events in `playFinal` before calling `tickTimers()` (see **C2**).

---

### C2. `--final` 4.5-Second `respondBy` Starvation Under Bulk Orders & `final-actions` 20/s Bucket (`starter.ts:1707-1720`, `spread.ts:78-85, 204-211`)

#### Evidence & Rate-Limit Math
- **Wall-clock quote deadline:** Weekday daytime runs at `18 real seconds / 60 world minutes = 300 ms / world minute` (`HANDBOOK.md`). Every `price_request` has `respondBy = arrivedAt + 15` = **4,500 ms (4.5 real seconds)**.
- **Bulk order guaranteed at Level 8:** Every Level 7/8 week includes a bulk order of **30–40 cars** arriving in a single minute (`HANDBOOK.md`).
- **Three compounding bottlenecks in `playFinal` (`starter.ts:1707-1720`):**
  1. **Per-event HTTP serialization:** `for await (const event of world.stream(...))` runs `desk.handle(event)` -> `desk.tickTimers()` -> `await desk.send()` **per single event**. When 40 bulk `price_request`s arrive behind 20 `gig_viewed` / `order_won` events, `playFinal` executes 40–60 sequential `POST /actions` round-trips (`40 * 100ms RTT = 4.0s` of pure network wait alone).
  2. **Priority inversion across events & `final-actions` (20/s, max 50) exhaustion:** `ACTION_PRIORITY` (`starter.ts:90-97`) only sorts actions *already in `this.outbox`*. When 30 bulk orders resolve as `order_won` at minute `T`, each `order_won` + `tickTimers` + duplicate `queueDirectOffersForOpenGigs(2)` (`starter.ts:1718`) queues `1 post + 2 offers = 3 actions` (`90 actions` total). At 20 actions/sec (`50 ms/token`), `await desk.send()` blocks the loop for `(90 - 50) * 50ms = 2,000 ms` to `4,500 ms` (if bucket was already low) **while new `price_request` events sit unread in `world.stream`'s `queue`**.
  3. **Duplicate offer pass on every event (`starter.ts:1436, 1717-1720`):** After `await desk.send()` drains `outbox`, `if (desk.outbox.length === 0)` is almost always `true`, invoking `desk.queueDirectOffersForOpenGigs(2)` a second time on every event; and for any gig with `urgentEscalated || pastDeadlineEscalated`, line `1436` bypasses `this.now < g.nextOfferCheckAt`, scanning the entire driver roster twice per `gig_viewed` event.

#### Concrete Fix
1. **Event micro-batching pump in `playFinal`:** Wrap `world.stream({ after, idleMs: 600 })` in a background reader pushing into a local `pending: (DeskEvent | null)[]` array. On wake, wait `5 ms` (`await sleep(5)`) to coalesce same-minute WebSocket bursts (e.g., all 40 bulk `price_request`s or `delivered + revenue + late_refund`), then drain **all** queued items through `desk.handle(ev)` before running `desk.tickTimers()` once.
2. **Urgent `quote` fast-lane in `Desk.send()`:**
   - Immediately after draining `pending` events and **before** `tickTimers()` queues low-priority `offer`s, extract all `action.type === "quote"` actions from `this.outbox` and send them **first** in chunks of `<= 20` (so if the 20/s bucket is partially depleted, the first 20 quotes transmit immediately rather than waiting for all 40–50 tokens).
3. **Token headroom reservation for `final-actions`:** Remove the redundant second `desk.queueDirectOffersForOpenGigs(2)` block at `starter.ts:1717-1720`, enforce `this.now < g.nextOfferCheckAt` (`Math.min(g.nextOfferCheckAt, this.now + 10)` for urgent gigs instead of `0` cooldown at `starter.ts:1436`), and in `--final` throttle non-urgent `offer` actions (e.g., at most 6 non-urgent offers per real second) so the 50-token `final-actions` bucket always retains `>= 30` tokens of instant burst capacity for bulk quotes.

---

### C3. `--final` Duplicate-Gig Race on `[withdraw/release, post]` Batches & Missing `release` Refusal Handling (`starter.ts:1585-1657`)

#### Evidence & Mechanism
In six places (`handleOrderChanged:685-698`, `handleDriverLate:859-865`, `splitOpenBundle:1021-1028`, `3-car extend:1164-1181`, `2-car bundle:1265-1284`, `zombieCleared:1504-1512`), `Desk` marks an existing gig `"withdrawn"`, unlinks it, pushes `withdraw` or `release`, and immediately pushes a replacement `post` into `this.outbox`. `drainOutboxSorted()` sends `[withdraw/release, post]` in a **single** `world.act()` call.

In live `--final`:
1. **Booked/started race on `withdraw`:** Between the last WebSocket event and our HTTP `POST /actions` reaching the server, a driver books (and if already in town, immediately starts!) `g_old`.
   - If `withdraw` returns `{ ok: false, reason: "Gig g12 has started..." }` (which does **not** contain `"book"`), `starter.ts:1651` (`res.reason.toLowerCase().includes("book")`) evaluates to `false`! `g_old` remains unlinked locally while Driver 1 works it, and the companion `post` (or `tickTimers` orphan guard at line `1476`) posts a **second live gig** for the same car (`visit_failed` + double driver fee).
   - Even when `res.reason` *does* contain `"book"`, `withdraw` (`i = 0`) re-links `g_old`, and if the server accepted `post` (`i = 1`, e.g., stripped post without conflicting window), `readResults` (`starter.ts:1626`) overwrites `legGigs` with `g_new` and leaves **both** `g_old` (booked) and `g_new` (open) active on the server!
2. **Zero refusal handling for `release` (`starter.ts:1601-1656`):** When `handleDriverLate` sends `{ type: "release", gigId }` + `{ type: "post", ... }` and the driver leaves right before `release` arrives (`{ ok: false, reason: "Gig g12 has started: a driver can be released only before they leave" }` per `API.md`), `readResults` completely ignores `action.type === "release"`! `g_old` stays `"withdrawn"` locally while moving on the server, and `g_new` is posted in parallel.

#### Concrete Fix
Because `final-actions` charges **1 token per action** regardless of HTTP batch count (`API.md`), split `Desk.send()` into safe phases whenever `withdraw` or `release` is present alongside `post`:
1. Phase 1: Send `quote` actions.
2. Phase 2: Send `withdraw` and `release` actions, and run `readResults`:
   - For `action.type === "withdraw"` with `!res.ok`: unless `reason` indicates already withdrawn/expired (`!/withdrawn|expired|not open/i.test(res.reason)` or specifically `/book|start|work/i.test(res.reason)`), restore `g.status = /start|work/i.test(res.reason) ? "working" : "booked"`, call `this.linkGig(g)`, and **cancel/reconcile any pending `post` in `this.outbox` that touches `g`'s orders** (just like `handleGigBooked` lines `758-775`!).
   - For `action.type === "release"` with `!res.ok`: if `/start|work/i.test(res.reason)`, restore `g.status = "working"`, call `this.linkGig(g)`, and remove any pending `post` in `this.outbox` for `g`'s legs!
3. Phase 3: Send remaining `post`, `reprice`, and `offer` actions.

---

### C4. `rejoin()` & `--final` Recovery Hazards (`starter.ts:413-508, 1687-1712, 1794-1798`, `dispatch.ts:568-575`, `market.ts:524-532`)

Four distinct bugs affect client startup in Test Finals and recovery after a network blip or server restart (`502/503/504`):

1. **Startup tear between `snapshot()` and `events()` (`starter.ts:1687-1707`):**
   `snapshot` is fetched at line `1687` *before* `history = await world.events()` at line `1690`, and `world.stream` opens at `after: history.at(-1)?.seq ?? -1` (`line 1707`). Any `order_won` or `price_request` emitted in the 50–150 ms between `snapshot()` and `events()` is absent from `snapshot.orders` / `snapshot.openRequests` (which `rejoin` lines `461-466, 503-507` rely on!) **and** skipped by `world.stream`, permanently orphaning won orders (`-200%` penalty) or leaving requests unquoted.
2. **Infinite `offer`-refusal spin-loop after `rejoin` (`starter.ts:417-458`, `dispatch.ts:568-575`):**
   - `rejoin()` never replays `offer_answered` events from `history` into `offersSentByDay`, `attemptedGigDrivers`, or `declinedMaxFee`.
   - When `selectOffersForGig` offers to a top-scored driver who already received 3 offers earlier that day, the server returns `{ ok: false, reason: "... 3 ..." }`.
   - `rollbackOfferRefused` (`dispatch.ts:568-575`) **decrements `offersSentByDay` back to `0` and deletes `${gigId}:${driverId}` from `attemptedGigDrivers`!**
   - On the very next event (50–300 ms later), `selectOffersForGig` picks the **exact same driver** again in an infinite loop for the rest of the day, burning the 20/s `final-actions` bucket and starving valid drivers of offers.
3. **Transient `Unreachable` wipes `CompetitorMarketEstimator`, `fluActiveToday`, `recentDeliveries`, and `order_changed` hours (`starter.ts:417-466, 1710, 1794-1798`):**
   - `world.stream` (`spread.ts:240-245`) tolerates up to 60s of `Unreachable` (`status === 0`) without dropping `Desk`, **but** `await world.client.final()` (`starter.ts:1710`, called every 800 ms on idle!) is unguarded: a single 502/timeout throws out of `playFinal` and `main()` constructs a brand-new `Desk`, wiping `worldLogMean`, `dayLogOffset`, `distanceSlope`, `priceWarToday`, `outageCenterToday`, `priceWarUsedThisWeek`, `outageUsedThisWeek`.
   - Furthermore, `rejoin()` ignores `order_lost`, `order_changed` (leaving stale pre-reroute `deliveryHours`), `delivered` (leaving `offers.recentDeliveries` empty), `gig_dropped` (resetting `fluActiveToday`), and drops any `snapshot.orders` entry if `!this.requests.has(order.id)` (`starter.ts:462`).
4. **Saturday Test-Final (`Thursday 00:00` start) `paceRatio` collapse (`market.ts:524-532, 675-676`):**
   `HANDBOOK.md` specifies that both Saturday Test Finals start at **Thursday 00:00 (`now = 4320`)**. If the world starts at `4320` with `wonOrdersTotal = 0`, `requestProgressFraction(4320) = 0.60` yields `expectedWonNow = ~192` and `paceRatio = 14 / 206 = 0.068`, zeroing out `paceRatio - 0.58` and `surplusFrac` (`paceRatio - 0.64`) all Thursday and causing dangerous over-winning!

#### Concrete Fix
- **Tear-free startup (`playFinal`):** Fetch `history0 = await world.events()` (`seq0 = history0.at(-1)?.seq ?? -1`), then `snapshot = await world.snapshot()`, run `desk.rejoin(snapshot, history0)`, then fetch `tail = await world.events(seq0)` and apply `tail` idempotently (`skip` already-quoted `openRequests` and already-present `orders`), starting `world.stream` at `after: (tail.at(-1) ?? history0.at(-1))?.seq ?? -1`.
- **Fix `rollbackOfferRefused(gigId, driverId, now, reason)` (`dispatch.ts:568`):**
  ```ts
  rollbackOfferRefused(gigId: string, driverId: string, now: number, reason = ""): void {
    const dayKey = `${Math.floor(now / DAY)}:${driverId}`
    this.openOffersByGig.get(gigId)?.delete(driverId)
    const stillOpenElsewhere = [...this.openOffersByGig.values()].some((m) => m.has(driverId))
    if (!stillOpenElsewhere) this.globalOpenOfferDrivers.delete(driverId)
    if (/per day|three|3|limit/i.test(reason) && /driver/i.test(reason)) {
      this.offersSentByDay.set(dayKey, 3)
    } else {
      const cur = this.offersSentByDay.get(dayKey) ?? 0
      if (cur > 0) this.offersSentByDay.set(dayKey, cur - 1)
    }
    // Keep attemptedGigDrivers so a permanently refused (gigId, driverId) pair is never retried in a tight loop!
  }
  ```
- **Complete `rejoin()` replay (`starter.ts:417-466`):** Replay `offer_answered` (incrementing `offersSentByDay` on `Math.floor((ev.at - 1) / DAY)` and recording `declined` / `attemptedGigDrivers`), `delivered` (`offers.recordDelivered`), `order_changed` (syncing `deliveryHours` and `noteDeadline`), `order_cancelled` (decrementing `wonOrdersTotal`), `order_lost` + `order_won` (`dealer.totalRequestsSeen`, `dealer.priorOutcomes`, `morningRetalLog`), and `gig_dropped` (restoring `fluActiveToday`). Guard `await world.client.final().catch(() => null)` at `starter.ts:1710`, and preserve `desk.pricing` / `desk.quoteMetaByReq` across `playFinal` retries in `main()`.
- **Test-Final-safe `paceRatio` (`market.ts:524-532, 670-677`):** Record `desk.startMinute = history[0]?.at ?? snapshot.now` and compute progress relative to `startProgress = requestProgressFraction(ctx.startMinute)`:
  ```ts
  const startProg = requestProgressFraction(ctx.startMinute)
  const remSpan = Math.max(0.15, 1 - startProg)
  const relProgress = Math.max(0, requestProgressFraction(ctx.now) - startProg)
  const expectedWonNow = targetWeekly * relProgress // Identical when startMinute === 0; neutral 1.00 at Thu 00:00 Test Final!
  ```

---

### C5. Double-Shifted Deadline (`+24h` to `+96h`) on Won Orders With Next-Day+ `note.readyAt` (`planner.ts:188-194, 422`)

#### Empirical Proof & Mechanism
Per `RULES.md`: *"When a car is ready a day or more later than the request says, the order's deadline moves by the same days. The order in `order_won` already has the moved deadline."*
Verified directly in `reveal-baseline-spread-1` (`R00049`, `R00389`, `R00538`):
- `R00049`: `request` `same_day.deadline = 1200` (Mon 20:00), `pickup.window.from = 652` (Mon 10:52), `truth.readyAt = 2040` (Tue 10:00).
- In `order_won`, **`order.deadline` is ALREADY `2640` (Tue 20:00)**, while **`order.legs[0].pickup.window.from` is STILL `652` (Mon 10:52)**!

In `buildStopsForOrder` (`planner.ts:422`), `Desk` calls:
```ts
const plan = computeOptionPlan(map, snow, subLegs, subNotes, order.deadline, now)
```
Inside `computeOptionPlan` (`planner.ts:188-193`):
```ts
const readyShiftDays = note0
  ? Math.max(0, Math.floor(note0.readyAt / DAY) - Math.floor(leg0.pickup.window.from / DAY))
  : 0
const promisedDeadline = lastLeg.delivery.privateAddress
  ? rawOptionDeadline
  : shiftDeadlineBusinessDays(rawOptionDeadline, readyShiftDays)
```
Because `rawOptionDeadline` is `order.deadline` (`2640`, Tue 20:00) and `Math.floor(2040/1440) - Math.floor(652/1440) = 1`, **`computeOptionPlan` shifts `order.deadline` a SECOND time to `4080` (Wed 20:00)!**

**Impact:** Every won order whose note delayed `readyAt` to a later day gets an `effectiveLastPickupAt` **1 to 4 business days AFTER its actual deadline** (`starter.ts:1043, 1119`):
- `buildSingleGigSchedule` (`dispatch.ts:139-194`) schedules all fee-ramp steps on Wednesday instead of Tuesday — leaving the gig flat at `0.81x–0.85x` past its real deadline!
- `tickTimers` (`starter.ts:1521`), `pairingBufferUntil` (`starter.ts:1300`), `evaluateOrderedBundle` (`dispatch.ts:272`), `handleDriverLate` (`starter.ts:855`), and `DirectOfferTracker` (`dispatch.ts:624`) all hallucinate 24+ hours of non-existent slack.

#### Concrete Fix
Add `deadlineAlreadyShifted = false` to `computeOptionPlan` (`planner.ts:174-194`):
```ts
export function computeOptionPlan(
  map: MapGraph,
  snow: SnowTracker,
  legs: readonly Leg[],
  notes: readonly ParsedLegNote[],
  rawOptionDeadline: number,
  now: number,
  deadlineAlreadyShifted = false,
): OptionPlan | undefined {
  ...
  const readyShiftDays =
    !deadlineAlreadyShifted && note0
      ? Math.max(0, Math.floor(note0.readyAt / DAY) - Math.floor(leg0.pickup.window.from / DAY))
      : 0
```
Pass `true` in `buildStopsForOrder` (`planner.ts:422`):
```ts
const plan = computeOptionPlan(map, snow, subLegs, subNotes, order.deadline, now, true)
```

---

### C6. `handleReleaseEvent` Posts Duplicate Gigs & Corrupts `pairingBufferUntil` / 2-Leg Trade-Ins (`starter.ts:900-920`)

#### Evidence & Mechanism
Look at `starter.ts:906-913`:
```ts
const order = this.orders.get(orderId)
if (!order || order.deliveredAt[leg] !== null) return
const gid = this.legGigs.get(orderId)?.get(leg)
if (!gid) {
  this.dispatchOrderLegs(order, [leg], false)
  return
}
```
`this.legGigs` is **only** populated after `world.act()` returns in `readResults` (`starter.ts:1626`). When `!gid` is true:
1. **Same-minute `order_won` + `release` (`at === respondBy === releasedAt`):** e.g., request arrives at `09:45` (`respondBy = 600`) with note `"Maksu klo 10"` (`releasedAt = 600`). At `at = 600`, `order_won` pushes a `post` into `this.outbox` (or buffers `orderId` in `pairingBufferUntil`). Immediately in the same step, `release` sees `gid === undefined` and calls `dispatchOrderLegs(order, [leg], false)` — pushing a **second** `post` into `this.outbox`!
2. **Order sitting in `pairingBufferUntil`:** If `orderId` is in `pairingBufferUntil` when `release` fires, `handleReleaseEvent` does **not** delete `orderId` from `pairingBufferUntil`, posts a solo gig, and leaves `orderId` in `pairingBufferUntil` where a subsequent `order_won` (`starter.ts:1241`) bundles `orderId` without withdrawing the solo gig — creating two live gigs!
3. **2-leg `<12h` trade-in:** Passing `[leg]` instead of `missing` splits a combined trade-in into solo Leg 0 and leaves Leg 1 unposted until `tickTimers`.

#### Concrete Fix
Replace `starter.ts:906-920` with:
```ts
const order = this.orders.get(orderId)
if (!order || order.deliveredAt[leg] !== null) return
if (this.pairingBufferUntil.has(orderId)) return // Already buffered and eligible once releasedAt <= now

const gid = this.legGigs.get(orderId)?.get(leg)
if (!gid) {
  if (this.hasPendingPostInOutbox(orderId, leg)) {
    // Rebuild cleanly via handleOrderChanged if pending post had a future pickup window > now + 15
    const stalePending = this.outbox.some(
      (a) =>
        a.type === "post" &&
        a.stops.some((s) => s.orderId === orderId && s.leg === leg && s.kind === "pickup" && (s.window?.from ?? 0) > this.now + 15),
    )
    if (stalePending) this.handleOrderChanged(order)
    return
  }
  const missing = undeliveredLegs(order).filter(
    (l) => !this.legGigs.get(orderId)?.has(l) && !this.hasPendingPostInOutbox(orderId, l),
  )
  if (missing.length > 0) this.dispatchOrderLegs(order, missing, false)
  return
}
```

---

### C7. Infinite `post`-Refusal Spin Loop Because `meta.strippedFallback` Is Never Checked (`starter.ts:87, 1331, 1627-1643`)

#### Evidence & Mechanism
`PendingPostMeta` defines `strippedFallback: boolean` (`starter.ts:87`) and sets `strippedFallback: useStripped` (`starter.ts:1331`), **but `readResults` (`starter.ts:1627-1643`) never reads `meta.strippedFallback`:**
```ts
const failedOrders = this.distinctLiveOrdersOfStops(action.stops)
for (const ord of failedOrders) {
  this.doNotBundle.add(ord.id)
  if (!meta?.isBundledTwoOrder) {
    this.stripWindowsOrders.add(ord.id)
  }
  const missing = undeliveredLegs(ord).filter(...)
  if (missing.length > 0) {
    this.dispatchOrderLegs(ord, missing, false)
  }
}
```
If a stripped post is ever refused (e.g., private seller pickup window ended 1 minute before `order_changed` arrives in `--final`, because line `1311` preserves private pickup windows even when `useStripped === true`; or an order was just cancelled on the server in `--final`), `readResults` re-queues the **exact same refused `post`**, and `tickTimers` (`line 1476`) also retries it every tick — creating an infinite refusal loop that drains `final-actions` tokens.

#### Concrete Fix
1. Track `postBackoffUntil = new Map<string, number>()` per order.
2. In `readResults` (`starter.ts:1630`), if `meta?.strippedFallback` is already `true`, set `this.postBackoffUntil.set(ord.id, this.now + 5)` instead of immediately re-dispatching in the same minute, and clear `postBackoffUntil` on `order_changed` / `release`. Check `(this.postBackoffUntil.get(order.id) ?? 0) > this.now` in `tickTimers` orphan guard (`starter.ts:1477`).

---

### C8. Bulk-Order Intra-Batch Blindness on 30–40 Simultaneous Requests (`starter.ts:588-614`, `market.ts:566, 580-588, 676-680`)

#### Evidence & Mechanism
At Level 7 and Level 8, every week features a **30–40 car bulk order** from a single pickup yard arriving at the same minute `T` (`batchId !== null`, `respondBy = T + 15`). Because `order_won` does not fire until `T + 15`:
- While quoting requests `#1 .. #40` at minute `T`, `this.wonOrdersTotal`, `this.countUnbookedOrders()`, `this.countOpenPickupsInCluster30(pickupId)`, and `this.countActiveOrdersOnDeadlineDay(dlDay)` remain frozen at their pre-batch values.
- Every one of the 40 cars sees zero congestion from the other 39 cars in the batch! If a yard with `Q30 = 12` local drivers happens to be priced favorably (e.g., regional outage or high-trust dealer), `PricingEngine` can win 25–35 cars from that single yard simultaneously, overwhelming local driver supply, driving fees to `2.4x`, and causing a cascade of late deliveries.

#### Concrete Fix
Store `expectedWinProb: number` and `expectedDeadlineDay: number` on `RecordedQuoteMeta` (`market.ts:182-188`), and maintain `unresolvedQuotes = new Map<string, RecordedQuoteMeta>()` in `Desk` (added in `handlePriceRequest`, deleted in `handleOrderWon` / `handleOrderLost` / when `req.respondBy <= this.now`):
- Add `sum(q.expectedWinProb)` of unresolved quotes in `within30km(placeId)` to `countOpenPickupsInCluster30(placeId)`.
- Add `sum(q.expectedWinProb)` of unresolved quotes matching `deadlineDay` to `countActiveOrdersOnDeadlineDay(deadlineDay)`.
- Add `sum(q.expectedWinProb)` of all unresolved quotes to `wonOrdersTotal` and `unbookedOrdersCount` passed into `QuotePortfolioContext`.

---

## ⚠️ HIGH PRIORITY (Significant Margin Leaks & State-Machine Bugs)

### H1. 3-Order (`tryExtendTwoToThreeOrderBundle`) & 2-Order Bundle Audit (`starter.ts:1143-1185, 1363`, `dispatch.ts:393-492, 580, 752`)

**Direct answer on `BundledGigPlan.firstOrderId` / `secondOrderId`:**
`starter.ts:1163-1184` does **not** read `ext.firstOrderId` or `ext.secondOrderId` (only `starter.ts:1240` on 2-order bundles reads them); `linkGig`, `unlinkGig`, `distinctLiveOrdersOfStops`, `splitOpenBundle`, `handleOrderChanged`, `handleOrderCancelled`, and `handleGigBooked` all iterate `g.stops`, so the 3rd order **is** properly linked and unlinked.

**However, five real bugs hit 3-order and 2-order bundles:**
1. **€50–€100+ direct-offer overpayment on every bundle (`starter.ts:1363`, `dispatch.ts:730-759`):**
   - A 2-order bundle posts at `0.58x * (ref1 + ref2)` and a 3-order bundle posts at `0.52x * (ref1 + ref2 + ref3)`, **and immediately sets `this.needsImmediateOfferPass = true`** (`starter.ts:1182, 1259, 1284`).
   - Within 0–2 world minutes, `buildOfferTarget` (`starter.ts:1363`) sets `refFeeCents = refSum` (`100%` of solo sum!), and `selectOffersForGig` (`dispatch.ts:752`) sends direct offers at `0.88x–1.05x * refSum` — paying full unbundled solo fees (higher than Step 3's max schedule fee!) to drivers who would have booked the bundle on the board at `0.52x–0.66x`!
   - **Fix:** Add `isBundled: boolean` to `OfferGigTarget`; when `gig.isBundled` is true, base non-urgent direct-offer fees on `Math.round(gig.currentAppFeeCents * (1.02 + gig.offerWave * 0.05))` (capped by `0.78 * gig.refFeeCents`) instead of `mult * gig.refFeeCents`!
2. **`tryExtendTwoToThreeOrderBundle` skips `urgent`/`doNotBundle` and snow (`starter.ts:1143-1163`, `dispatch.ts:445, 471`):**
   - `starter.ts:1146-1152` never checks `this.urgent.has(o1.id) || this.urgent.has(o2.id) || this.doNotBundle.has(o1.id) || this.doNotBundle.has(o2.id)` and omits `this.pairingBufferUntil.delete(order.id)`.
   - `dispatch.ts:445` uses hardcoded `* 1.03` on deadhead links (`dh1`, `dh2`) ignoring active snow (2-car uses `1.25`), and `dispatch.ts:471` sets `mktMult = 1.0 + (fluActive ? 0.08 : 0)` completely omitting `+ 0.10` snow adjustment!
3. **`escalateOrderUrgent`, `tickTimers`, and `rejoin` mishandle urgent open/pending bundles (`starter.ts:481, 975-981, 1490-1528`):**
   - `escalateOrderUrgent` ignores pending bundle posts in `this.outbox` (`meta.isBundledTwoOrder === true` at line `976`).
   - `tickTimers` (`line 1495`) skips `warnLead` (`240m` VIP) on open bundles until `splitAt`.
   - `rejoin` (`line 481`) sets `splitAt: gig.postedAt + 120` instead of `Math.min(gig.postedAt + 120, minEffLpa - 210)`.
4. **`order_cancelled` with `outcome: "shortened"` leaves `isBundledTwoOrder = true` (`starter.ts:724`):**
   When 1 order of a booked 2-order bundle is cancelled (`"shortened"`), `g.stops` shrinks to 1 order, yet `g.isBundledTwoOrder` stays `true` — causing `handleDriverLate` (`line 825`) to ignore `g` and `gig_dropped` (`line 807`) to withdraw instead of repricing!
   - **Fix:** After filtering `g.stops` at line `724`, set `g.isBundledTwoOrder = new Set(g.stops.map((s) => s.orderId)).size > 1`.
5. **`DirectOfferTracker.recordOfferAnswered` cross-gig collision (`dispatch.ts:580`):**
   When an offer on a withdrawn gig expires 10 minutes later, `this.globalOpenOfferDrivers.delete(driverId)` unconditionally clears `driverId` even if `driverId` currently holds a live open offer on the replacement bundle gig!
   - **Fix:** Only delete from `globalOpenOfferDrivers` when `![...this.openOffersByGig.values()].some((m) => m.has(driverId))`.

---

### H2. `handleVisitFailed` Leaves Failed Gigs Stuck in `status = "working"` Forever (`starter.ts:566, 922-940, 951-958, 273-315`)

#### Evidence & Mechanism
`VisitFailedEvent` carries `event.gigId` (`types.ts:281`), which `starter.ts:566` discards (`this.handleVisitFailed(event.orderId, event.leg, event.reason)`). Inside `handleVisitFailed`:
- `this.legGigs.get(orderId)?.delete(leg)` unlinks the order leg, **but the failed `GigState` `g` is never updated**.
- For a 1-car gig (or when the last car in a multi-car gig fails its visit), no further `delivered`, `gig_dropped`, or `gig_expired` event ever arrives for `g`. **`g.status` remains `"working"` with `g.driverId` set until Wednesday 22:00!**
- For a multi-car gig where Car 1 fails and Car 2 succeeds, `g.stops` still contains Car 1 (`o1.deliveredAt[0] === null`), so `handleDelivered` (`starter.ts:951-957`) sees `anyRemaining === true` and leaves `g.status = "working"` until some other driver delivers Car 1!
- Consequently, `activeCommitments()` (`starter.ts:273-315`) treats `g.driverId` as perpetually driving `g` (`estStart = Math.max(this.now, ...)`), **blocking that driver from all direct offers for the rest of the week** (`dispatch.ts:680`) and feeding a phantom arriving driver into `hasArrivingDriverSynergy` (`starter.ts:360`, `-0.14` `feeMult` underpricing in `market.ts:649`).

#### Concrete Fix
Pass `event.gigId` into `handleVisitFailed(event.gigId, event.orderId, event.leg, event.reason)`:
```ts
const g = this.gigs.get(gigId)
if (g) {
  g.stops = g.stops.filter((s) => !(s.orderId === orderId && s.leg === leg))
  const anyRemaining = g.stops.some((s) => {
    if (s.kind !== "pickup") return false
    const o = this.orders.get(s.orderId)
    return o && o.deliveredAt[s.leg] === null
  })
  if (!anyRemaining) g.status = "done"
}
```

---

### H3. `zombieCleared` at `lastPickupAt + 1` & `stripWindowsOrders` Defects (`starter.ts:1307-1314, 1499-1515`, `planner.ts:530-573`)

Four bugs interact in `zombieCleared` and `stripWindowsOrders`:
1. **False zombie withdrawal 1 minute after posting an already-late order (`starter.ts:1503`):**
   Per `RULES.md`: *"When no pickup can be on time ... `lastPickupAt` is the first minute the car can be collected"*, and stops without custom windows **already** run to `endsAt`. If `Desk` posts a gig at `this.now === ord.lastPickupAt` when `ord` can no longer be on time (`ord.lastPickupAt + roadMinutes > ord.deadline`), `readResults` sets `g.postedAt = ord.lastPickupAt` and `g.zombieCleared = false`. One minute later (`ord.lastPickupAt + 1`), `g.postedAt <= ord.lastPickupAt && this.now > ord.lastPickupAt` fires — needlessly withdrawing a valid gig, destroying its open direct offers, and forfeiting its one-time 30 km push notification!
2. **Missed early zombie state on `withPlates` (`-30m`) and custom `deliveryStop.window.to` (`noteDeadline` / `narrowedDeliv`):**
   `ord.lastPickupAt` uses stated `order.deadline` and omits `withPlates` (`30m`). When `buildStopsForOrder` sets `deliveryStop.window.to = effDl` (e.g. `17:00` vs stated `20:00`) or `withPlates: true`, drivers can no longer book `g` up to **3 hours before `ord.lastPickupAt + 1`**, leaving `g` dead on the board until `ord.lastPickupAt + 1` or `gig_expired`.
3. **`stripWindowsOrders` erases non-private PICKUP windows (`starter.ts:1308-1314`), causing `visit_failed` penalties:**
   ```ts
   const finalStops = useStripped
     ? built.stops.map((s) => {
         const leg = order.legs[s.leg]
         if (s.kind === "pickup" && leg?.pickup.privateAddress) return s
         return { ...s, window: undefined }
       })
     : built.stops
   ```
   Setting `window: undefined` on a dealer pickup erases `retry.pickupFrom` (`not_ready`/`closed` backoff!), `note.readyAt`, `note.releasedAt`, `summerTyres` snow avoidance, and narrowed `note.pickupHours`! Per `RULES.md`, non-private stop windows *may end after `order.deadline`*, so pickup constraints (`{ from: minStart, to: dayWin?.to ?? endsAt - 30 }`) remain 100% legal past `lastPickupAt` and **must** be preserved unless a `post` action was actually refused by the server!
4. **Over-broad `hasPrivPick` check (`starter.ts:1502`):**
   `ord.legs.some((l) => l.pickup.privateAddress)` blocks zombie cleanup on combined 2-leg trade-ins (where Leg 1's private pickup right after Leg 0's delivery *never* restricts booking per `RULES.md`!) and on 2-leg orders whose private-pickup leg was already delivered.

#### Concrete Fix
- Compute `g`'s exact `lastBookablePickupAt(g)` from `g.stops`:
  - Check only `g.stops[0]` for private pickup (`firstLeg.pickup.privateAddress`).
  - For each stop `s_k` with explicit `s_k.window?.to`, require `now + cumulativeRoadAndExtras(0..k) <= s_k.window.to`.
  - For stops with `window === undefined`, apply `ord.lastPickupAt - platesMinutes` **only if** `g` was on-time bookable when posted (`g.postedAt + totalRoadAndExtras <= ord.deadline && g.postedAt <= ord.lastPickupAt`).
- When `this.now > lastBookablePickupAt(g)` (and if `this.offers.openCount(g.id) > 0`, note that once `this.now > lastBookablePickupAt(g)`, no driver can accept the offer anyway because `RULES.md` states *"a yes for a gig that ... no longer fits ... come after the 10 minutes as expired"*!), withdraw `g` and strip **only** `deliveryStop.window` and any `cappedTo` (`effectiveLastPickupAt`) cap on `pickupStop.window`, **preserving** `minStart` (`readyAt`/`releasedAt`/`retry.pickupFrom`/`summerTyres`) and `narrowedPick` windows! Reserve full `window: undefined` stripping strictly for server-refused `post` fallback (`readResults`).

---

### H4. `handleDriverLate` Multi-Leg Mismatch & Over-Eager Driver Release (`starter.ts:823-867`)

#### Evidence & Mechanism
1. **2-leg trade-in corruption (`starter.ts:831-854`):** A combined 2-leg trade-in has `g.isBundledTwoOrder === false` and 4 stops. `handleDriverLate` computes `drive` for `order.legs[0]` only (Dealer -> Private Customer), then compares `predArrival` against `order.deadline` (Leg 1's dealer deadline) and `notes[notes.length - 1]?.deliveryHours ?? leg.delivery.hours` (mixing Leg 1's `notes[1].deliveryHours` with Leg 0's `null` private hours!).
2. **False release from `+10m` service in `visitAt(predArrival, effDl, realDelivHours, 10)` (`starter.ts:854`):**
   Per `RULES.md` and `API.md`, delivery counts at the **minute of arrival** (`predArrival <= effDl && predArrival < slot.closes`). `predArrival` already includes `+15m` pickup buffer and `1.08x` clear-weather road inflation; passing `service = 10` into `visitAt` adds *another* 10 minutes, releasing scarce booked drivers who would arrive 1–9 minutes before closing/deadline!

#### Concrete Fix
- Simulate forward across **all** pickup/delivery stops in `g.stops` starting from `pickupAt` at `g.stops[0]`.
- At the final delivery stop, check `visitAt(predArrival, effDl, realDelivHours, 1)` (`service = 1` for `< slot.closes` and `predArrival <= effDl` when `!realDelivHours`).

---

### H5. `handleOrderChanged` Stale `noteDeadline`, EV Charging Fine Risk, & One-Way Km Scaling (`starter.ts:637-700, 1055-1057`)

#### Evidence & Mechanism
1. **Stale `noteDeadline` (`starter.ts:644-663`):**
   - When snow is forecast for a `summerTyres` car, `order_changed` moves `order.deadline` forward by +1 business day (`HANDBOOK.md`), **but `notes[l].noteDeadline` keeps the old day's timestamp**, causing `Math.min(order.deadline, noteDeadline)` (`planner.ts:196, 531`) to ignore the snow extension!
   - When `order_changed` reroutes `delivery.placeId` to another city, `notes[l].noteDeadline` also retains the old city's deadline.
2. **Booked `<30%` EV rerouted across `200 km` (`starter.ts:668-672`):**
   `handleOrderChanged` only withdraws `g.status === "open"`. If `g.status === "booked"` (driver hasn't left yet) and `order_changed` reroutes an electric car (`chargePercent < 30`) from `<= 200 km` (`withCharging: false`) to `> 200 km`, keeping `g` incurs a guaranteed **€100 fine + 90 minutes late** (Rule 3), whereas releasing (`25%–50%` fee) and reposting with `withCharging: true` avoids both.
3. **Stale `effectiveLastPickupByOrder` on booked gigs (`starter.ts:688-691`):** If `missingSelf.length === 0` (`booked`/`working`), `effectiveLastPickupByOrder` is never updated to reflect the new deadline/route.
4. **One-way `changedKmScale` (`starter.ts:1056`):** `routeKm > origKm + 5` scales fees up when lengthened, but if rerouted from `400 km` down to `50 km`, `changedKmScale` stays `1.0`, overpaying €70+ for a short hop.

#### Concrete Fix
- In `handleOrderChanged` (`starter.ts:645-663`):
  - If `order.legs[l]!.delivery.placeId !== prev.legs[l]?.delivery.placeId`, set `notes[l]!.noteDeadline = null`.
  - Else if `order.deadline > prev.deadline && notes[l]?.noteDeadline !== null`, shift `notes[l]!.noteDeadline! += (order.deadline - prev.deadline)`.
  - Always recompute `buildStopsForOrder` to refresh `this.effectiveLastPickupByOrder.set(order.id, built.effectiveLastPickupAt)`.
  - If a `booked` single-order gig now requires `withCharging` (`!pStop.withCharging && this.map.needsCharging(...)`) and `order.priceCents * 0.25 + 10000 > g.feeCents * 0.5`, release and repost with `withCharging: true`.
- In `computeSingleSchedule` (`starter.ts:1056`), use `Math.abs(routeKm - origKm) > 5 ? Math.max(0.45, (1500 + 26 * routeKm) / Math.max(1500, 1500 + 26 * origKm)) : 1.0`.

---

### H6. `summerTyres` Snow Avoidance Checked Before `visitAt` Opening-Hours Jump (`planner.ts:251-260, 455-459`)

#### Evidence & Mechanism
In both `computeOptionPlan` (`planner.ts:251-260`) and `buildStopsForOrder` (`planner.ts:455-459`):
```ts
const snowWin = snow.overlaps(leg.pickup.placeId, leg.delivery.placeId, pickEarliest, pickEarliest + driveRoad + 60)
if (snowWin) {
  snowOverlap = true
  if (summerTyres) pickEarliest = Math.max(pickEarliest, snowWin.to)
}
const pickStart = visitAt(pickEarliest, pickLatest, pickHours, pickService)
```
If `pickEarliest` falls outside opening hours (e.g., Friday 19:00 or weekday 06:30) and a snowstorm is forecast for `[Mon 08:00, Mon 14:00]` (or `[09:00, 13:00]`), `snow.overlaps` checks `[Fri 19:00, Fri 21:30]` -> `null` (no snow), and then `visitAt` jumps `pickStart` to **`Mon 08:00` right into the snowstorm**! Similarly, if two consecutive snow forecasts overlap pickup and delivery (`[08:00, 11:00]` then `[10:30, 14:00]`), a single `overlaps` call only advances past the first window.

#### Concrete Fix
Advance `pickStart` in a bounded loop until `visitAt` lands in a snow-free pickup & drive window:
```ts
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
```
Apply the same loop to `minStart` (using `visitAt(Math.max(now, minStart), endsAt, realPickHours, 10)`) in `buildStopsForOrder` (`planner.ts:455-459`).

---

## 💡 MEDIUM / SUGGESTIONS (`notes.ts`, `planner.ts`, & Consistency Hardening)

### M1. `narrowedDeliv` Outlaws Valid Same-Day Afternoon Deliveries (`planner.ts:539-548`)
When `narrowedDeliv && realDelivHours` is true and `firstWin.to - minReachableDeliv < 150` (e.g., driver can reach receiver by `12:40` and receiver closes at `15:00` — `140 minutes` of slack!), `planner.ts:539-546` overwrites `deliveryStop.window` with `{ from: laterWin.from, to: laterWin.to }` (`[Tue 08:00, Tue 15:00]`).
- Setting `from = Tue 08:00` **bans** any Monday driver from delivering the car on Monday between `12:40` and `15:00` (and conflicts directly with a Monday `pickupStop.window = [Mon 10:00, Mon 15:00]` on short hops, forcing an impossible 17-hour overnight hold!).
- **Fix:** Keep `from: leg.delivery.window.from` when extending `to: laterWin.to`, or only advance to `laterWin` when `firstWin.to - minReachableDeliv < 45` (matching `nextRealDayWindow`'s 30–45m buffer).

### M2. `notes.ts` & Multi-Leg Note Edge Cases (`notes.ts:76-86, 218-224, 296-305`, `planner.ts:435, 455`)
`notes.ts` achieved 100% on the 14,487 revealed legs, so **do not blindly split clauses on commas** (which would break `, sorry 15:00` and `, ei kun` in `splitCorrection`). Targeted surgical fixes that preserve 100% backward compatibility while closing out-of-sample phrasings:
1. **Negation with contrast (`notes.ts:81-84, 298-300`):**
   Line `82` explicitly preserves `, ei X vaan Y` / `, not X but Y` / `, inte X utan Y` in `stripNegations`, **but `splitCorrection` (`line 299`) never splits on `vaan|utan|but`**, so `extractClockMinutes` matches the first (denied!) time `X` instead of `Y` (e.g. `"Valmis, ei klo 12 vaan klo 15"` -> `12:00` instead of `15:00`!).
   - **Fix:** In `stripNegations`, strip negated contrast prefixes before `vaan|utan|but`:
     ```ts
     s = s.replace(/(?:^|[,\s])\b(?:not|ei|inte)\b[^,.;!?]*?\b(?:vaan|utan|but)\b/gi, " ")
     ```
2. **`"half past <hour>"` and `"puoli <digit>"` / `"halv <digit>"` (`notes.ts:218-224`):**
   - `"half past two"` fails `matchWordHourToken("past")` at line `221` and falls through to line `262`, matching `"two"` = **`14:00` instead of `14:30`** (30m early -> `visit_failed: "not_ready"`!).
   - `"puoli 3"` / `"halv 3"` fails because `matchWordHourToken("3")` only matches words, not digits `1..12`.
   - **Fix:** Handle `toks[i] === "half" && toks[i + 1] === "past"` as `+ 30` (`wh * 60 + 30`), and allow `1..12` working-hour digits (`1..5 -> 13..17`, `6..12 -> 6..12`) right after `puoli` / `halv` / `half`.
3. **Multi-leg `needsPlates` & `summerTyres` on split Leg 1 (`planner.ts:435, 455`):**
   When a `>12h` 2-leg trade-in is split into two solo gigs (`[0]` and `[1]`), `planner.ts:455` checks `if (idx === 0 && notes[0]?.summerTyres)` (ignoring `notes[0]?.summerTyres` on `idx === 1`, whereas `computeOptionPlan:206` applies `summerTyres` to all legs). Use `notes[0]?.summerTyres` for any leg if snow overlaps.

### M3. Urgent Threshold Drift & `activeCommitments` Progress Tracking (`starter.ts:299-303, 1069, 1318, 1523`, `dispatch.ts:122`)
1. **Urgent schedule reset bug:** `computeSingleSchedule` (`starter.ts:1069`) escalates at `highTrust ? 245 : 205`, `buildSingleGigSchedule` (`dispatch.ts:122`) escalates at `<= 210`, `dispatchOrderLegs` (`starter.ts:1318`) sets `urgentEscalated` only at `<= 205` (ignoring `highTrust`!), and `tickTimers` (`starter.ts:1523`) triggers `escalateOrderUrgent` at `highTrust ? 240 : 195`. An order posted at `slack = 208` (or `235` for VIP) already gets a 5-step urgent schedule, has `urgentEscalated = false`, and gets **reset back down to Step 0** 10–13 minutes later!
   - **Fix:** Extract a single helper `isOrderUrgentBySlack(order, effLpa)` (`highTrust ? 245 : 210`) and use it consistently across `starter.ts:1069`, `1318`, `1523`, and `dispatch.ts:122`.
2. **`activeCommitments()` (`starter.ts:299-303`) ignores `gig_started` / `picked_up` progress:**
   For `"working"` gigs, `estStart = Math.max(this.now, ...)` assumes the entire route restarts from `this.now`. Recording `startedAt` on `gig_started` (`g.startedAt = event.at`) and skipping already-delivered legs in `roadSum` gives accurate `estFinishAt` for driver chaining and `hasArrivingDriverSynergy`.

### M4. Defensive `spread.ts` Rate-Limit Guards & `unquotedCount` Tracking (`spread.ts:69-73, 166-170`, `market.ts:241, 349`)
1. **`Bucket` NaN/zero guard (`spread.ts:69-73, 166`):** Only update `this.#buckets` when `Number(headers.get("ratelimit-limit")) > 0`, and use `Math.max(25, Number(response.headers.get("retry-after")) || 100)` on `429` (`spread.ts:169`) so a missing/empty `Retry-After` header never busy-spins or sleeps `NaN`/`Infinity`.
2. **`dealer.unquotedCount` (`market.ts:241, 349`):** `d.unquotedCount` is modeled in `effMult` (`-0.0016 * min(unquotedCount, 20)`) but never incremented anywhere. Increment `d.unquotedCount++` if `request.respondBy <= this.now` in `handlePriceRequest` (`starter.ts:592`) or if a `quote` action returns `!res.ok` in `readResults`.
3. **Operational `AGENTS.md` reminder for Test Finals & Final:** Always pipe `--final` console output to an append-only dated file under `results/` (e.g., `bun typescript/starter.ts --final 2>&1 | tee -a results/2026-11-14-test-final-1.log`) so a reconnect or terminal scrollback limit never loses run telemetry, and never log `SPREAD_KEY`.

---

## Verification Checklist Against Prompt Focus Areas

| Prompt Focus Area | Verdict on `c5421ee` | Report Sections |
|---|---|---|
| `playFinal` & `world.stream` | **4 Critical issues:** per-event `finalizePendingRevenue(this.now)` breaks late tracking (`C1`); per-event `send()` without event coalescing (`C2`); duplicate `queueDirectOffersForOpenGigs(2)` (`C2`); unguarded `client.final()` on `idleMs: 800` (`C4`). | **C1, C2, C4** |
| `final-actions` (20/s) & `final-reads` (50/s) | `final-reads` is safe (~1.3 reads/s idle), **but `final-actions` (20/s, cap 50) can stall >4.5s** during bulk `order_won` post+offer bursts and infinite offer/post refusal loops. | **C2, C4, C7, M4** |
| Bulk orders (30–40 cars, 4.5s `respondBy`) | **Unsafe in `--final` without C2 + C8:** 40 sequential HTTP `POST /actions` calls + offer bursts risk missing 4.5s `respondBy` (`C2`); intra-batch pricing ignores pending batch wins (`C8`). | **C2, C8** |
| `rejoin` after server/client restart | **Unsafe without C4:** `snapshot()`-before-`events()` tear drops live orders/requests; `rollbackOfferRefused` spins infinitely on 3/day drivers; market estimator & flu state reset; Test-Final `Thu 00:00` breaks `paceRatio`. | **C4** |
| `tryExtendTwoToThreeOrderBundle` (`BundledGigPlan` 3rd order) | 3rd order links/splits via `g.stops`, **but** direct offers overpay `~1.0x refSum` on `0.52x` bundles, 3-car extender skips `urgent`/`doNotBundle` & snow `mktMult`, `shortened` keeps `isBundledTwoOrder`, and `recordOfferAnswered` drops `globalOpenOfferDrivers`. | **H1, C3** |
| `zombieCleared` at `lastPickupAt + 1` | Withdraws valid 1m-old past-deadline gigs (killing open offers/notifications), misses earlier `withPlates`/`noteDeadline` zombie cutoffs, races with booking in `--final`, and skips combined trade-ins. | **H3, C3** |
| `driver_late` | Mixes Leg 0 drive with Leg 1 hours/deadline on 2-leg trade-ins; `+10m` `visitAt` service falsely releases on-time drivers; missing `release` refusal rollback in `readResults`. | **H4, C3** |
| `order_changed` | Retains stale `noteDeadline` after snow extensions/reroutes; misses `<30%` EV `>200km` booked reroute fine; stale `effectiveLastPickupByOrder` on booked gigs; one-way `changedKmScale`. | **H5** |
| `release` | Same-minute `order_won + release` or buffered order queues **duplicate gigs** and leaves `orderId` in `pairingBufferUntil`; splits `<12h` 2-leg trade-ins. | **C6** |
| `pairingBufferUntil` | Corrupted by `handleReleaseEvent` (`C6`) and not deleted in 3-car extend / partner-gig bundle branches (`H1`). | **C6, H1** |
| `stripWindowsOrders` | Strips non-private **pickup** windows (`readyAt`, `releasedAt`, `retry.pickupFrom`, `pickupHours`, `summerTyres` -> `visit_failed`); `strippedFallback` never checked -> infinite refusal loop (`C7`). | **C7, H3** |
| `notes.ts` & `planner.ts` edge cases | **Critical** double-shifted deadline in `buildStopsForOrder` (`C5`); `summerTyres` checked before `visitAt` jump (`H6`); `narrowedDeliv` bans same-day delivery (`M1`); negated contrast & `"half past"` (`M2`). | **C5, H6, M1, M2** |
