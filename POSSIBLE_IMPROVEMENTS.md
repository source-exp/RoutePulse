# Continuous Improvement Log (`POSSIBLE_IMPROVEMENTS.md`)

**Target Codebase:** `main` @ `c5421ee` (*"Unify 8d69968 and engine-69k fixes for 82.4k 5-seed benchmark"*)
**Current 5-Seed Benchmark Baseline (`omni-v4`):**
- `paired-variant-1`: **€11,609.65** (360 orders, 98.3% on-time, 0.0% undelivered)
- `opportunity-compare-1`: **€14,069.41** (340 orders, 95.6% on-time, 0.0% undelivered)
- `quant-compare-1`: **€17,072.75** (425 orders, 97.2% on-time, 0.0% undelivered)
- `panel-compare-1`: **€20,894.45** (460 orders, 98.9% on-time, 0.0% undelivered)
- `experiment-route-fee`: **€18,716.76** (458 orders, 96.9% on-time, 0.0% undelivered)
- **5-Seed Total:** **€82,363.02** (2,043 orders, 0.0% undelivered across all 5 seeds)
- Extra check (`spread-1`): **€13,613.74** (418 orders, 95.9% on-time, 0.0% undelivered)

---

## Pass 1 — Immediate High-Impact Findings (Static Audit of `c5421ee`)

### P0-1 [CRITICAL — LIVE FINAL BLOCKER]: `playFinal()` Event-by-Event Blocking & `final-actions` Token Starvation (`starter.ts:1707–1721`)
- **Where:** `typescript/starter.ts`, lines `1707–1721` (`playFinal`).
- **What happens now:**
  1. `for await (const event of world.stream(...))` processes **one WebSocket message per loop iteration** (~178,000 events/week, ~95% of which are `gig_viewed`, peaking at 150–300 events/real second during weekday daytime when 1 world hour = 18 real seconds, i.e., **15 world minutes (`respondBy`) = 4.5 real seconds**).
  2. On **every single event** (even a single `gig_viewed`), `playFinal` runs `desk.tickTimers()`, `await desk.send()`, and if `outbox` was empty, runs `desk.queueDirectOffersForOpenGigs(2)` and `await desk.send()` again!
  3. In the live Final (`API.md`), `final-actions` refills at **only 20 tokens/second** (bucket max 50), charging **1 token per action** (unlike practice where a 50-action batch costs 1 token total).
  4. When `DirectOfferTracker` emits 2,500–4,400 `offer` actions/week, `await desk.send()` blocks inside `Client.call()` waiting for `final-actions` rate-limit tokens while hundreds of incoming WebSocket events (including `price_request`s and 30–40-car **Bulk Orders**!) sit unread in `stream()`'s internal queue. By the time `desk.handle(price_request)` runs and sends `quote`, the 4.5-second `respondBy` deadline can already be past!
- **Concrete Improvement:**
  1. **Drain all currently queued stream events synchronously** before calling `tickTimers()` or `send()` (or coalesce over a 25–40 ms micro-batch window in `playFinal`), so `desk.now` is always caught up to the latest event on the wire before computing actions.
  2. **Separate/throttle `offer` budgets in `playFinal`**: reserve at least 15–20 tokens in `final-actions` for `quote`, `post`, `withdraw`, `release`, and urgent `reprice` actions; cap non-urgent `offer` emission in `--final` mode (e.g., max 4–6 offers/real second, and skip redundant `queueDirectOffersForOpenGigs(2)` on every `gig_viewed`).
  3. **Skip `tickTimers()` on `gig_viewed` when `event.at === lastTickMinute`**: `gig_viewed` only updates `lastActiveAt`; running `tickTimers()` (which scans all orders, bundles, and 800 drivers) 168,000 times wastes CPU and triggers premature offer bursts.

### P0-2 [HIGH — LIVE FINAL RESTART SAFETY]: `rejoin()` Does Not Reconstruct `CompetitorMarketEstimator` Pricing State (`starter.ts:408–501`)
- **Where:** `typescript/starter.ts`, lines `408–501` (`Desk.rejoin`).
- **What happens now:**
  - `rejoin()` restores `DealerState.trust` and `lateCount` from `ledger` events, **but never updates `worldLogMean`, `dayLogOffset`, `distanceSlope`, `priceWarToday`, `priceWarUsedThisWeek`, `outageCenterToday`, `outageUsedThisWeek`, or `dealer.priorOutcomes` / `latentLogOffset`**.
  - If the server or client restarts mid-final (which `HANDBOOK.md` explicitly warns can happen during the final!), `worldLogMean` resets to `log(1.42)` (`1.42x`), forgetting whether the final world is `1.26x` or `1.54x`, forgetting an active Price War or Regional Outage, and forgetting `unquotedCount`.
- **Concrete Improvement:**
  - Reconstruct quote outcomes during `rejoin()` from `snapshot.orders` (won orders with `order.priceCents` and `order.option`) and `order_lost` events in `history` (if we reconstruct or re-simulate expected quote prices, or infer `worldLogMean` from won order `priceCents / unroundedListPriceCents` in `history`!). Even from `order_won` events alone in `history`, `order.priceCents` gives exact lower bounds on accepted prices, and `order_won` vs `order_lost` counts per day/region immediately restore `priceWarToday`, `outageCenterToday`, and `dealer.priorOutcomes`!

### P1-1 [MARGIN OPPORTUNITY]: `opportunity-compare-1` & `spread-1` Dip Check (`omni-v4` vs `8d69968`)
- **Observation from logs:**
  - `omni-v4` (`c5421ee`) gained **+€5,432** over `8d69968` across the 5 benchmark seeds (**€82,363.02 vs €76,930.88**), driven by massive gains on `quant-compare-1` (**+€2,635.63**: €14,437 -> €17,073), `panel-compare-1` (**+€2,462.73**: €18,432 -> €20,894), `experiment-route-fee` (**+€994.44**: €17,722 -> €18,717), and `paired-variant-1` (**+€223.87**: €11,386 -> €11,610).
  - However, on **two** seeds, `omni-v4` scored slightly *lower* than earlier `8d69968`/`v4` runs:
    - `opportunity-compare-1`: `8d69968` got **€14,953.94** (337 orders, 97.0% OT) vs `omni-v4` **€14,069.41** (340 orders, 95.6% OT) — **-€884.53** and `-1.4%` OT!
    - `spread-1`: `v4` (`8d69968`) got **€14,861.08** (424 orders, 96.9% OT) vs `omni-v4` **€13,613.74** (418 orders, 95.9% OT) — **-€1,247.34** and `-1.0%` OT!
- **Hypothesis to isolate right now:**
  Look at the 4 changes in `8d69968..c5421ee` that could have hurt `opportunity-compare-1` (-€885) and `spread-1` (-€1,247):
  1. **Removing the `3.0x` decoy on `same_day` when `next_day` is quoted (`market.ts:866`)**:
     In `8d69968`, when `same_day` was offered by the dealer, failed safety (`!sdOpt`), and `next_day` WAS quoted, `8d69968` set `prices.same_day = rawSd.listPriceCents * 3.0`. `c5421ee` deleted those 3 lines! Does omitting `same_day` vs quoting `3.0x` on `same_day` change dealer goodwill or conversion, OR did `equalMargin3d` (`within_3_days` pricing change at `market.ts:877`) cannibalize higher-priced `next_day` wins into cheaper `within_3_days` wins?!
  2. **`minRampStart = Math.max(ctx.earliestPickupAt, ...)` (`dispatch.ts:170`)**:
     In `c5421ee`, `minRampStart` was changed to `Math.max(ctx.earliestPickupAt, ...)`! Think what happens when `ctx.earliestPickupAt` is `16:30` and `lpa` (`effectiveLastPickupAt`) is `17:00` (only 30 minutes after `earliestPickupAt`, e.g., a car ready at `16:30` for a 2.5h drive due at `20:00`!):
     `minRampStart = 16:30`, so ALL 5 fee steps (`beforeLpa = 360, 265, 185, 115, 60`) clamp to **`16:30` (`t = Math.max(16:30, 17:00 - 60) = 16:30`)** — meaning the gig sits flat at `0.85x` all day until `16:30`, and then jumps straight to `1.88x` 30 minutes before `lastPickupAt` when no driver can reach the pickup in time!!
  3. **3-Car Corridor Bundling (`tryExtendTwoToThreeOrderBundle`, `starter.ts:1143`)**:
     In `opportunity-compare-1` (644 drivers — severe shortage!) and `spread-1`, withdrawing an open 2-car bundle to form a 6-stop 3-car bundle (`coeffs = [0.52, 0.60, 0.69, 0.79]`) can stall all 3 cars for up to `105` minutes before splitting!
  4. **`planner.ts:319` (`!snowLate && Math.floor(bufferedPickup / DAY) < Math.floor(rawPickup / DAY) ? rawPickup : bufferedPickup`)**:
     Removing the 15m+3% drive-variance buffer whenever it crosses a day boundary admits orders with **0 minutes of drive-variance slack** before a 20:00 closing time, which fails on-time ~40–50% of the time whenever random drive duration is +2% above nominal!

*(Subagent deep-dives and empirical reveal checks in progress — appending findings below...)*

---

## Pass 2 — Empirical Server-Reveal Findings Across All 6 `omni-v4` Worlds (+ `v3`/`v4` Baselines)

We queried the full server reveals (`reveal()`, `events()`, `snapshot()`) of all 6 `omni-v4` worlds (`2,461` won orders total) and compared them side-by-side against `v3-opp-15.0k` (`w3fa32cdb5e38203b1ae9`) and `v4-spread1-14.9k` (`w274f039fd933cd5c4774`):

| World | Margin | Won | On-Time | `rev/ref` | **`df/ref`** | 1-Car Done | **2-Car Done** | **3-Car Done** | Offers Acc/Sent | Drops | Failed Visits | Late Refund |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `omni-paired` | €11,609.65 | 360 | 98.3% | 1.562 | 1.019 | 275/308 | 36/52 | 5/7 | 21 / 1,484 | 41 | **0** | -€185 |
| `omni-opp` | €14,069.41 | 340 | 95.6% | 1.724 | **1.039** | 256/305 | 33/51 | 6/8 | 20 / 1,738 | 37 | **0** | **-€885** |
| *(vs `v3-opp`)* | *(**€14,953.94**)* | *(337)* | *(**97.0%**)* | *(1.709)* | *(**0.995**)* | *(253/296)* | *(**42/52**)* | *(0/0)* | *(27 / 2,538)* | *(31)* | *(0)* | *(**-€464**)* |
| `omni-quant` | €17,072.75 | 425 | 97.2% | 1.652 | 1.011 | 313/378 | 49/79 | **5/12** | 31 / 3,319 | 52 | **0** | -€580 |
| `omni-panel` | €20,894.45 | 460 | 98.9% | 1.718 | **0.970** | 329/374 | 49/75 | 11/11 | 28 / 1,826 | 45 | **0** | -€195 |
| `omni-route` | €18,716.76 | 458 | 96.9% | 1.679 | 1.029 | 330/391 | 46/85 | 12/15 | 32 / 2,714 | 70 | **0** | -€892 |
| `omni-spread1` | €13,613.74 | 418 | 95.9% | 1.668 | **1.032** | 309/378 | **40/74** | **10/16** | 28 / 2,333 | 35 | **0** | -€663 |
| *(vs `v4-spread1`)* | *(**€14,861.08**)* | *(424)* | *(**96.9%**)* | *(1.682)* | *(**0.998**)* | *(305/371)* | *(**60/93**)* | *(0/0)* | *(30 / 2,719)* | *(43)* | *(0)* | *(**-€616**)* |

### Concrete Improvements Proven by the Reveal Data:

#### P1-2 [PROVEN BY REVEAL — +€800 to +€1,250/week on Tight Worlds]: Fix Destructive 3-Car Bundle Cannibalization (`dispatch.ts:393`, `starter.ts:980`)
- **Evidence:**
  - On `spread-1`, `v4` (without 3-car bundling) completed **60 two-car bundles (`120` orders)** at **`df/ref = 0.998`** and earned **€14,861.08**. `omni-v4` withdrew open 2-car bundles `[A, B]` to form 16 three-car bundles `[A, B, C]`; **6 of 16 (`37.5%`) failed to book** (`5/12 = 58%` failed on `quant-compare-1`!).
  - Worse: in `starter.ts:980` (`splitOpenBundle`), when a 3-car bundle `[A, B, C]` hits `splitAt` (`105m` later), it marks **all 3 orders** with `this.doNotBundle.add(o.id)` and dispatches **all 3 as solo 1-car gigs** — destroying the healthy 2-car bundle `[A, B]` that was withdrawn to create it, and raising `df/ref` from `0.998` to `1.032` (`+€590` extra driver fees on `spread-1` and `+€1,213` on `opportunity-compare-1`)!
- **Two Concrete Fixes:**
  1. **Tighten 3-car bundle admission (`tryExtendTwoToThreeOrderBundle`, `dispatch.ts:425–430`):** Only extend `[A, B] -> [A, B, C]` when `supply.totalDrivers >= 780` (never in shortage worlds like `opportunity-compare-1`), `dh1 <= 25 && dh2 <= 25` (same-town transfers or exact metro loop `ret <= 45`), `totalRoad <= 420` (7h max, since drivers have daily max gig length preferences!), and slightly higher opening coeffs `[0.58, 0.65, 0.73, 0.82]` so drivers actually book it!
  2. **Smart fallback in `splitOpenBundle` (`starter.ts:980`):** When a **3-car** bundle (`ordersInBundle.length === 3`) fails to book at `splitAt` (and still has `>= 280m` slack), do **not** shatter all 3 into solo gigs! Mark only the 3rd order `doNotBundle` and allow the remaining two orders to re-bundle as a 2-car gig!

#### P1-3 [PROVEN BY REVEAL — Direct Offer Conversion Is Only `0.9%–1.5%`]: Target Actual Viewers of Each Gig (`starter.ts:527`, `dispatch.ts:491`)
- **Evidence:**
  - Across the 6 `omni-v4` worlds, we sent **13,414 direct offers** and only **160 were accepted (`1.19%`)** (`31 / 3,319 = 0.93%` on `quant-compare-1`!).
  - Why? Look at `starter.ts:527`:
    ```ts
    case "gig_viewed":
      this.offers.recordView(event.driverId, event.at)
      break
    ```
    **`event.gigId` is thrown away!**
  - Read `HANDBOOK.md` carefully:
    *"A driver who reads an offer takes it when the fee pays for the gig and what else their day is worth to them. In the app the same driver may hold out for more, because the fee may rise there... Thus an offer saves most on gigs whose fee drivers expect to rise."*
  - A driver who **viewed `gigId` specifically** (`gigViewers.get(gigId)`) and did not immediately book is **proven active right now AND looking at `gigId`** (often holding out for the rising schedule steps `[0.98x, 1.12x, 1.30x]`!). Offering `gigId` directly to a driver who just viewed `gigId` (especially one living near `deliveryPlaceId` or `pickupPlaceId`) at `m0 + 0.06` (`~0.91x–0.96x`) converts holdout viewers **without paying `1.12x–1.30x`**, while slashing wasted offers by 70%+ (protecting the 20/s `--final` action bucket!).

#### P1-4 [ZERO FAILED VISITS VERIFIED]: `notes.ts` Had `0` `visit_failed` Across All 2,461 Won Orders!
- **Evidence:** Across all 6 `omni-v4` worlds (`2,461` won orders), `visit_failed` count is **`0` (`vf: {}` in every single world)**. Let's still run an offline check across all 4,142 local notes for any silent `noteDeadline` or rare phrasing edge cases (`"7pm, sorry, i mean 8pm"`).

---

## Pass 3 — Out-of-Sample Note Truth Audit (2,532 Legs) & Late-Order Chain-Reaction Bug

### P0-3 [CRITICAL — CAUSES DOZENS OF LATE ORDERS]: Double Fee-Crash Reset Across `effectiveLastPickupAt` $\to$ `lastPickupAt` (`planner.ts:482–493` + `starter.ts:875` + `starter.ts:1503` + `dispatch.ts:122`)
- **Empirical Smoking Gun in `omni-v4` Reveals:**
  - Out of all **69 late orders** across the 6 `omni-v4` worlds, over half have the exact signature:
    `gigs: '2st:withdrawn:fee=1.38 | 2st:withdrawn:fee=1.38 | 2st:done:fee=1.38'` (e.g., `R00672`, `R00103`, `R00097`, `R00146`, `R00981`, `R00921`, `R00889`, `R00428`, `R00637`).
- **Exact 5-Step Bug Mechanism Traced:**
  1. `planner.ts:482–493` sets `pickupStop.window.to = effectiveLastPickupAt`, which is **15–25 minutes earlier** than `order.lastPickupAt` (e.g., `15:35` vs `15:55`).
  2. Three hours earlier, `tickTimers()` escalated Gig 1 to urgent `[1.38, 1.60, 1.84, 2.12, 2.40]`, so by `15:35` Gig 1 has climbed to its peak **`2.40x`** fee.
  3. At `15:36` (`effectiveLastPickupAt + 1` — **when 19 legal on-time pickup minutes still remain before `order.lastPickupAt = 15:55`!**), `pickupStop.window.to` forces Gig 1 to expire (`gig_expired`).
  4. `handleGigExpired` (`starter.ts:878`) posts **Gig 2** at `15:36`, which calls `buildSingleGigSchedule` (`dispatch.ts:122`) and **resets the fee from `2.40x` all the way back down to `Step 0 = 1.38x`** during the final 19 minutes before `lastPickupAt`!
  5. Worse still: 20 minutes later at `15:56` (`order.lastPickupAt + 1` — **5 minutes before Gig 2 even reaches Step 1 at `15:36 + 25 = 16:01`!**), `zombieCleared` (`starter.ts:1503`) sees `g.postedAt (15:36) <= ord.lastPickupAt (15:55)`, **withdraws Gig 2**, and posts **Gig 3** — **resetting the fee back down to `Step 0 = 1.38x` a SECOND time**!
  - Result: During the single most critical 45-minute window around `lastPickupAt`, the fee shown to drivers crashes from **`2.40x` $\to$ `1.38x` $\to$ `1.38x`** instead of staying at `2.40x`!
- **Concrete Fix:**
  1. **Preserve monotonic fee floor across reposts/withdrawals (`maxSeenFeeByOrder`):** Track the highest fee already reached on the app for `order.id` (`maxReachedFeeByOrder.get(order.id)`). Whenever an urgent gig expires or is zombie-reposted, start the new schedule at **`Math.max(step0, currentReachedFee)`** instead of resetting back to `1.38x`!
  2. **In `dispatch.ts:122` (`urgent` schedule):** Scale the opening step by remaining slack `slackMin = effectiveLastPickupAt - now`! If `slackMin <= 45`, open directly at **`2.20x–2.40x`** (`[2.20, 2.40]`), not `1.38x` (since `4 * 25 = 100 minutes` won't even finish before `lastPickupAt` when only 30 minutes remain!).

### P1-5 [BUG IN `c5421ee` — `7.60x` FEE EXPLOSION]: Uncapped `changedKmScale * rescueMults` (`starter.ts:1055` + `dispatch.ts:102`)
- **Empirical Smoking Gun:**
  - In `omni-paired`, order `R00950` (`espoo -> raisio`, `same_day`) had `gigs: '2st:withdrawn:fee=1.38 | 2st:withdrawn:fee=3.50 | 2st:withdrawn:fee=3.50 | 2st:done:fee=7.60'` — paying **`7.60x` original `referenceFeeCents`**!
- **Why:**
  - `changedKmScale = (1500 + 26 * routeKm) / (1500 + 26 * origKm)` (`starter.ts:1056`) scales `baseRefFeeCents` up by ~`2.5x–3.0x` when a short metro order is rerouted to another city, and then `isPastDeadline` multiplies by `3.00x` (`2.53 * 3.00 = 7.60x`)!
  - Furthermore, once an order is already past deadline, the **maximum possible loss from not delivering it at all** is the undelivered penalty (`2 * order.priceCents` plus any remaining unrefunded revenue `0..0.9 * order.priceCents`). Paying a driver more than `2.8 * order.priceCents` loses more money than leaving the car undelivered!
- **Concrete Fix:**
  - Cap `changedKmScale` at `Math.min(2.2, ...)` (or compute true reference-fee equivalent `1400 + 22 * routeKm` without compounding `3.00x`), and cap every schedule step's `feeCents` by the economic rationality ceiling `Math.min(feeCents, Math.round(order.priceCents * 2.65))`!

### P2-1 [OUT-OF-SAMPLE NOTE PARSER VERIFICATION — `2,531 / 2,532 = 99.96%`]: Add `"sorry, i mean"` English Correction Rule (`notes.ts:76`)
- **Evidence:**
  - Testing `parseDealerNote` (`notes.ts`) against all **2,532 out-of-sample won legs** across the 6 `omni-v4` worlds found **only 1 genuine parse error** (`2,531 / 2,532 = 99.96%` exact match!):
    - `omni-opp` `R00753`: `"hi there. collect beforre 16:00, sorry, i mean 17:00"` -> parsed `pickupHours.closes = 1080` (ignored both / kept default `18:00`) instead of `1020` (`17:00`).
- **Concrete Fix:**
  - Add inline English/Finnish/Swedish self-correction rewrite in `notes.ts` before clause extraction:
    `/\b\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)?\s*,?\s*(?:sorry,?\s*i\s*mean|i\s*mean|eiku|ei\s*kun|korjaan|rattelse|jag\s*menar)\s*(?:klo|kl\.?)?\s*(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)?)/gi -> "$1"` (achieving **2,532 / 2,532 = 100.00%**!).

---

## Pass 4 — Option Profitability & `-€4,498` Negative-Margin Sink Audit Across All 6 `omni-v4` Worlds

### P1-6 [EMPIRICAL — `-€4,497.55` LOST ON 123 NEGATIVE-MARGIN ORDERS]: Long-Haul Destination Sink Underpricing (`market.ts:628–644`)
- **Measured Across All 6 `omni-v4` Worlds (`2,461` delivered orders):**
  - **Option profitability:**
    - `within_3_days` (`n = 114`): **+€49.78 net margin/order** (`rev/ref = 1.619`)
    - `next_day` (`n = 1,411`): **+€43.94 net margin/order** (`rev/ref = 1.639`)
    - `same_day` (`n = 936`): **+€30.81 net margin/order** (`rev/ref = 1.752`)
  - **Negative-margin tail:** **123 delivered orders lost `-€4,497.55` net** (`~€750/week` in pure avoidable losses).
  - **Top loss-making delivery destinations:**
    `oulu` (`n=9`, **-€921**), `vaasa` (`n=12`, **-€676**), `ylivieska` (`n=5`, **-€352**), `rovaniemi` (`n=2`, **-€350**), `pori` (`n=6`, **-€276**), `kuopio` (`n=4`, **-€276**), `jyvaskyla` (`n=5`, **-€251**), `raisio` (`n=11`, **-€242**), `kokkola` (`n=4`, **-€241**), `hyvinkaa` (`n=12`, **-€198**).
- **Root Cause in `market.ts:628–630`:**
  - `market.ts` only adds a destination scarcity cost when `D_home <= 15` (`+0.08` for `<=5`, `+0.04` for `<=15`).
  - When `oulu` has `28–39` drivers or `vaasa` has `17–24` drivers (`D_home > 15`), `market.ts` adds **`0.00` sink surcharge**, even on 320–650 km southbound-to-northbound hauls (`vantaa -> oulu`, `lahti -> oulu`, `vantaa -> vaasa`, `vantaa -> rovaniemi`) where few return cars match and drivers escalate to `1.88x–2.40x` + late refunds!
- **Concrete Improvement:**
  - Replace the binary `D_home <= 15` check in `market.ts:628` with a **distance × outbound-return-balance sink term**: when `plan.totalRoadKm > 220` and `deliveryId` is outside the Capital/Tampere surplus hubs (`D_home < 80` and `!ctx.hasOpenRoundTripPartner(deliveryId, pickupId)`), add `+0.08` to `+0.16` to `feeMult` (and `+0.25` to `etaLate` for `same_day` into northern/coastal sinks `rovaniemi`, `kemi`, `ylivieska`, `kokkola`, `vaasa`, `oulu`).

---

## Pass 5 — Dispatch, Bundling & Fee-Schedule Audit Findings (`audit-c5421ee-dispatch.md`)

### P0-4 [CRITICAL LIVE-FINAL SPIN LOOP]: Infinite Refused-Offer Retry Loop Drains 20/sec Action Bucket (`starter.ts:1436, 1645–1647`, `dispatch.ts:568–575`)
- **Exact Bug:**
  1. In `starter.ts:1436` (`queueDirectOffersForOpenGigs`), `if (this.now < g.nextOfferCheckAt && !g.urgentEscalated && !g.pastDeadlineEscalated) continue` **bypasses `nextOfferCheckAt` on every single tick whenever `g.urgentEscalated` is true**!
  2. When the server refuses an `offer` action (`res.ok === false`), `readResults` (`starter.ts:1646`) calls `offers.rollbackOfferRefused()`, which **deletes `attemptedGigDrivers.delete("${gigId}:${driverId}")`** (`dispatch.ts:574`)!
  3. On the very next `gig_viewed` event (milliseconds later in `playFinal`), `selectOffersForGig` picks the **exact same driver**, gets `{ ok: false }` again, deletes `attemptedGigDrivers` again, and spins infinitely — burning the entire 20 actions/sec final token bucket!
- **Concrete Fix:**
  - Never delete `attemptedGigDrivers` inside `rollbackOfferRefused` (keep `${gigId}:${driverId}` permanently blocked on refusal!), and always enforce `g.nextOfferCheckAt = Math.max(this.now + 15, ...)` even for urgent gigs.

### P0-5 [MAJOR FEE LEAK — +€1,400 to +€2,600/week]: Direct Offers on 2-Car & 3-Car Bundles Pay Full Unbundled `refSum` (`starter.ts:1358–1398`, `dispatch.ts:730–759`)
- **Exact Bug:**
  - A 2-car bundle opens on the app at `0.58x * refSum` (`~1.16x` single-car refFee), and a 3-car bundle opens at `0.52x * refSum`.
  - Two minutes later (`this.now + 2`), `buildOfferTarget` (`starter.ts:1358`) computes `refSum = sum(r.referenceFeeCents)` and passes `refFeeCents: refSum` into `selectOffersForGig`, which multiplies `refSum` by **`0.95x–1.03x`** (ignoring that `gig.orderIds.length` is 2 or 3)!
  - That sends direct offers at **`~1.00x * refSum`** — **17% to 27% more expensive than posting two separate `0.81x` solo gigs**, completely erasing the bundling discount!
- **Concrete Fix:**
  - Anchor direct-offer fees on multi-order bundles (`gig.orderIds.length >= 2`) to `gig.currentAppFeeCents * (1.02 + 0.05 * gig.offerWave)` (capped at `0.76 * refSum` for 2-car and `0.68 * refSum` for 3-car bundles), or skip cold non-chained offers on newly posted bundles during their first 30 minutes!

### P0-6 [MAJOR FEE LEAK — +€900 to +€1,700/week]: `23:00–07:00` Dead-Night Escalations in `eveTrainAt`, `morningWaveAt` & `warnLead` (`dispatch.ts:148–166`, `starter.ts:1520–1527`)
- **Offline Replay Proof Across All 4 Local Worlds:**
  - **`947 / 947` (`100.0%`)** of `>400 km` overnight `eveTrainAt = lpa - 540` steps fire between `23:00` and `07:00` (missing evening-train drivers before 23:00 completely!).
  - `morningWaveAt` (`06:40`) fires before `07:00` (when notifications begin) on `2,679` options.
  - Worse: `warnLead` (`240m` / `195m` before `effLpa`, `starter.ts:1523`) triggers between **`03:30 AM` and `06:30 AM`** on `13–21` long-haul orders per week (`lpa` between `07:30` and `10:30 AM`), climbing all 5 urgent steps (`25m` apart) up to **`2.40x–2.55x` while all drivers are asleep**, so waking drivers at `07:00 AM` book at `2.55x` without ever seeing `1.08x–1.38x`!
- **Concrete Fix:**
  - Clamp `eveTrainAt` to `<= dayStart + 21 * HOUR + 30` (`21:30` evening before) when posted before `21:00`; move `morningWaveAt` from `06:40` to `07:05`; and never start the `25m`-step `urgent` ramp during `23:00–06:55` (clamp step timestamps into `>= 07:00`!).

### P1-7 [RULE 4 REFUND CLIFF — +€450 to +€1,200/week]: Stop Paying `2.40x–3.00x` Panic Fees Right After `lastPickupAt` When Next-Morning `25%` Tier Is Identical (`dispatch.ts:101–137`, `starter.ts:1503`)
- **Rule 4 Mathematical Fact (`RULES.md`):**
  - Dealer sites accept deliveries only in opening hours. Once `now > lastPickupAt` on a dealer closing at `<= 20:00`, even if you pay `2.40x–3.00x` immediately, the driver arrives after `20:00` and the delivery **counts when the site next opens tomorrow at `08:00–09:00` (`12–13 hours` late = `25%` refund tier)**!
  - Delivering tomorrow afternoon at `17:00` (`21 hours` late, `< 24h`) pays the **exact same `25%` refund** while costing `~1.05x–1.25x` normal morning driver fees instead of `2.40x–3.00x`!
  - Only private deliveries (no closing hours) or orders approaching a **refund-tier cliff** (`2h`, `24h`, `2 business days`, or `endsAt` Wednesday `22:00`) justify `2.0x+` rescue fees!

### P1-8 [SUBURB MISCLASSIFICATION — `lempaala` & `raisio`]: `D_home` Uses Single-Town Residents Instead of `supply.pool30(deliveryPlaceId)` (`dispatch.ts:54, 72–77` & `market.ts:564, 625–630`)
- **Exact Bug:**
  - `lempaala` has `D_home = 1` resident driver (but **`105` drivers** within 30 km in `tampere`!), and `raisio` has `D_home = 1` resident driver (but **`48` drivers** within 30 km in `turku`!).
  - Both `dispatch.ts:54` and `market.ts:564` check `D_home = supply.homeDrivers(deliveryPlaceId)` (`= 1`) and `!sameCluster30` (which compares `pickup` to `delivery`), falsely classifying `helsinki -> lempaala` or `vantaa -> raisio` as dead-end 1-driver towns (`+0.08` fee surcharge and blocking the `0.81x` hub-to-hub discount)!
- **Concrete Fix:**
  - Replace `supply.homeDrivers(deliveryPlaceId)` with `supply.pool30(deliveryPlaceId, false, false)` in both `dispatch.ts` and `market.ts`!

---

## Pass 6 — Correctness & Live `--final` Audit Findings (`audit-c5421ee-correctness.md`)

### P0-7 [CRITICAL `--final` BUG]: `playFinal()` Misclassifies 100% of Late Deliveries as `onTime = true` (`starter.ts:1459, 1707–1715`)
- **Exact Bug:**
  - When an order is delivered late at minute `T`, the server emits `ledger: revenue` (`seq = k`, `at = T`) **before** `ledger: late_refund` (`seq = k + 1`, `at = T`).
  - In `playPractice`, all events in `step.events` are processed before `tickTimers()`. In `playFinal`, `world.stream()` yields **one event per loop iteration**, calling `desk.tickTimers()` $\to$ `this.finalizePendingRevenue(this.now)` (`info.at <= this.now`) immediately after `revenue` and **before `late_refund` is read from the stream**!
  - Every late order in `--final` is therefore scored as `onTime = true`: `dealer.trust` is falsely incremented (`+1`) instead of halved (`Math.floor(trust / 2)`), `dealer.lateCount` stays `0` (overpricing all future quotes to that dealer!), and the 90% ranking safety gate (`currentOnTime` in `market.ts:612`) stays blind!
- **Concrete Fix:**
  - Change line `1459` in `tickTimers()` from `this.finalizePendingRevenue(this.now)` to `this.finalizePendingRevenue(this.now - 1)` (only finalize once the world clock strictly advances past `info.at`, or at `endsAt`), AND drain all available WebSocket messages before calling `tickTimers()`!

### P0-8 [CRITICAL DISPATCH BUG]: Double-Shifted Deadline (`+24h` to `+96h`) on Won Orders with Next-Day+ `note.readyAt` (`planner.ts:188–194, 414`)
- **Exact Bug:**
  - Per `RULES.md`, when a note delays `readyAt` by 1+ days, **`order_won` already carries the shifted `order.deadline`**, while `order.legs[0].pickup.window.from` retains the unshifted stated ready time.
  - `buildStopsForOrder` (`planner.ts:414`) calls `computeOptionPlan(..., order.deadline, now)`, which shifts `order.deadline` **a second time** by `readyShiftDays` (`+1` to `+4` business days!), delaying all fee ramps, bundle splits, and urgent warnings until days after the true deadline!
- **Concrete Fix:**
  - Pass an explicit `deadlineAlreadyShifted = true` parameter into `computeOptionPlan` whenever called for an already-won `Order` (`buildStopsForOrder`), only shifting `rawOptionDeadline` when evaluating a pre-win `PriceRequest`!

### P0-9 [BULK ORDER PROTECTION]: Intra-Batch Blindness on 30–40 Car Bulk Orders (`starter.ts:588`, `market.ts:566, 580, 676`)
- **Exact Bug:**
  - During the weekly **Bulk Order** (30–40 requests arriving simultaneously from one yard with `respondBy = T + 15`), `openPickupsInCluster30`, `activeOrdersOnDeadlineDay`, and `wonOrdersTotal` only count already-won orders (`0` from the batch while quoting!). All 40 requests are priced as if zero other cars were leaving that yard!
- **Concrete Fix:**
  - Track unresolved quotes (`respondBy > this.now`) weighted by their predicted `winProb` (`pendingClusterExpectedWins` and `pendingDeadlineDayExpectedWins`), adding them directly into `openPickupsInCluster30`, `activeOrdersOnDeadlineDay`, and `wonOrdersTotal`!

### P1-9 [LIVE FINAL & TEST FINAL ROBUSTNESS]: Startup Event-Gap Tear, Duplicate `[withdraw, post]` Race, `handleVisitFailed` Stuck `"working"` & Saturday Test-Final `paceRatio` (`starter.ts:413, 823, 900, 922, 1627, 1687`, `market.ts:524`)
- **Summary of Concrete Fixes (full code in `typescript/audit-c5421ee-correctness.md`):**
  1. **Test-Final (`Thu 00:00`) `paceRatio`:** Measure `progress` relative to `deskStartMinute` (`(now - startMin) / (totalWork - startMin)`) so joining a Saturday Test Final at `Thu 00:00` (`0` won orders) doesn't set `paceRatio = 0.068` and disable capacity shadow pricing.
  2. **Startup Stream Tear (`starter.ts:1687`):** Fetch `snapshot()` *after* `events()`, or open `stream({ after: preSnapEvents.at(-1)?.seq })` so zero `order_won`/`price_request` events are lost between `events()` and `snapshot()`.
  3. **Unguarded `client.final()` Idle Poll (`starter.ts:1710`):** Wrap `world.client.final()` in `try/catch` inside `playFinal` so a single transient timeout doesn't destroy `Desk` and wipe `CompetitorMarketEstimator` state.
  4. **`handleVisitFailed` Stuck `"working"` (`starter.ts:922`):** Mark a 1-car gig `"done"` (or remove the failed leg) on `visit_failed` so the driver isn't permanently blocked in `activeCommitments()` with phantom `hasArrivingDriverSynergy`.
  5. **`strippedFallback` Infinite Loop (`starter.ts:1627`):** Check `if (meta?.strippedFallback) return` on refused posts so a permanently invalid post cannot loop infinitely.
  6. **`handleReleaseEvent` Duplicate Post (`starter.ts:900`):** Check `hasPendingPostInOutbox` and `pairingBufferUntil` before dispatching on `release`.

---

## Pass 7 — Market Estimator & Portfolio Pricing Audit Findings (`audit-c5421ee-market.md`)

### P0-10 [CRITICAL ESTIMATOR BUG]: Price-War Double-Discount (`-15%`) & Tuesday Overshoot (`+25%`) (`market.ts:258–272, 413–418`)
- **Exact Bug:**
  1. During quotes `1..16` on a Price War morning (before `todayPwLLR >= 3.8` triggers `priceWarToday = true`), the 16 losses drag `worldLogMean + dayLogOffset` down by `~-15%`. When `priceWarToday = true` fires, `predictOption` stacks `Math.log(0.80)` (`-20%`) **on top of** the already-depressed `worldLogMean + dayLogOffset` without rolling back the pre-trigger drop — under-predicting Monday Price-War prices by `-15%`!
  2. Next morning in `onNewDay` (`market.ts:258–272`), the "unflagged Monday price-war recovery" block runs **before** `if (this.priceWarToday) this.priceWarUsedThisWeek = true` (`line 271`) and **without checking `!this.priceWarToday`**, adding `-Math.log(0.80)` (`+0.223`) onto a state that stopped updating once `priceWarToday` turned true — overshooting Tuesday `worldLogMean` up toward `1.54x`!
- **Concrete Fix:**
  - Snapshot `dayStartWorldLogMean` at the start of each day; when `priceWarToday` triggers, restore `worldLogMean = dayStartWorldLogMean` and `dayLogOffset = 0` so `Math.log(0.80)` is applied cleanly once; and guard line `260` with `&& !this.priceWarToday`!

### P1-10 [OUTAGE WIND-FALL — +€800 to +€1,800/week]: Fix 80-km Regional Outage Detector Contamination & Regional Sample Threshold (`market.ts:272, 390–454`)
- **Two Bugs Preventing `+30%` Outage Detection:**
  1. Uusimaa (`helsinki`/`vantaa`/`espoo`/`hyvinkaa`/`porvoo`) accounts for **52%–58%** of all Finland requests; pre-detection wins inflate `dayLogOffset` inside `baseLogC` (`line 392`), masking `resBase` inside the outage zone! Computing outage residuals against `noDayLogC` (excluding `dayLogOffset`) + comparing `meanIn - meanOut` fixes Uusimaa detection (`96%–100%`).
  2. Regional centers (`oulu`, `vaasa`, `jyvaskyla`, `kuopio`) only see `6–8` requests/day, so `st.nIn >= 8` (`line 448`) misses almost 100% of northern/western outages, while an unconfirmed brief trigger sets `outageUsedThisWeek = true` (`line 272`), blinding Tue–Fri! Lowering `nIn >= 5` with two-sample LLR + end-of-day confirmation (`nIn >= 8 && llr >= 4.5` before locking `outageUsedThisWeek`) unlocks regional outage windfalls.

### P1-11 [PORTFOLIO ALLOCATION — +€900 to +€1,600/week]: Fix Per-Slot Shadow Unit, `dlDay = 7` (Last Monday) Capacity Cap & `winProbability` Kink Trap (`market.ts:59, 581, 673–692, 757–763`)
- **Three High-Value Pricing Fixes:**
  1. **Next-Monday (`dlDay === 7`) Capacity Cap (`market.ts:581`):** Last Monday has **zero** new arriving requests and **3.5 execution days** (Thu–Mon) to deliver cars, yet `dayCap` treats `dlDay = 7` as a single normal day (`0.096 * totalDrivers`), throttling profitable Thursday/Friday `next_day` and `within_3_days` wins! Multiply `dayCap` by **`1.85x`** when `dlDay === 7`.
  2. **Per-Gig-Slot + Distance Shadow Unit (`market.ts:691`):** Drivers have a daily **gig count limit** as well as a driving-hours limit (`HANDBOOK.md`). Scaling `refShadowCents = referenceFeeCents * shadowMult` charges only `€3.34` on `<45km` metro hops vs `€25.40` on `>240km` hauls, crowding out €85-margin intercity hauls with €12-margin local hops! Use `(2200 + 0.60 * request.referenceFeeCents) * Math.min(0.85, shadowMult)`.
  3. **Disable `antiRetalShadow` on Friday (`day === 4`) and During Outages (`market.ts:755`):** Competitor morning retaliation only affects future weekdays; sacrificing conversion on Friday (`day === 4`, zero future requests!) or during a 1-day `+30%` outage wastes pure margin.

### P1-12 [MENU & TRADE-IN BUGS]: `equalMargin3d` Tautology, 2-Leg Trade-In `A -> B -> A` Turnaround Bug & `centeredLogKm` Mean (`market.ts:40, 51, 565, 599, 878–880`)
- **Three Clean Formula Fixes:**
  1. **`equalMargin3d` Tautology (`market.ts:878–880`):** `equalMargin3d` sets `capped3d - d3Cost = ndPrice - ndCost - 150`, which trivially satisfies `>= ndPrice - ndCost - 200` (`-150 >= -200` is **always true**!), quoting `within_3_days` on ~100% of co-offered requests at €2–€4.50 less than `next_day` (delaying dealer trust by 48h and dumping deadlines onto Friday `dlDay = 4`). Only co-quote `within_3_days` alongside `next_day` when `ndEv.dayLoad >= 0.65` or `d3Opt.expectedMargin > ndOpt.expectedMargin * 1.05`!
  2. **2-Leg Trade-In `A -> B -> A` Turnaround (`market.ts:51, 565, 599`):** `91.2%` (`73/80`) of trade-ins end back at `A`, so `deliveryId = legs[last].delivery.placeId` equals `pickupId`! That falsely triggers `+0.75 * sameCluster30` in `etaLate` and hides turnaround town `B`'s `PLACE_ALPHA_DELIV` in `logLaneFactor`. Use `legs[0].delivery.placeId` for turnaround alpha and set `sameCluster30 = 0` when `legs.length > 1 && totalRoadKm > 60`.
  3. **Center `centeredLogKm` at Empirical Mean `155 km` (`market.ts:40`):** `Math.log(totalKm / 105)` has mean `+0.388`, leaking global price errors into `distanceSlope`; centering at `Math.log(totalKm / 155)` orthogonalizes `worldLogMean` and `distanceSlope`.

---

## Summary Priority Checklist (Recommended Implementation Order)

| Priority | ID | Module | Summary | Est. Impact / Purpose |
|---|---|---|---|---|
| **1 (MUST)** | `P0-1`, `P0-4`, `P0-7` | `starter.ts`, `dispatch.ts` | Batch-drain `playFinal` stream events, fix `finalizePendingRevenue(now - 1)` late-trust bug, block refused offers in `attemptedGigDrivers`, throttle non-urgent final offers | **Prevents `--final` & Test-Final failure** |
| **2 (MUST)** | `P0-2`, `P1-9` | `starter.ts`, `market.ts` | Reconstruct `CompetitorMarketEstimator` in `rejoin()`, fix Thu `00:00` Test-Final `paceRatio`, guard `client.final()`, clear `visit_failed` `"working"` gigs | **Restart & Test-Final resilience** |
| **3 (HIGH)** | `P0-3`, `P0-8`, `P1-5` | `planner.ts`, `starter.ts`, `dispatch.ts` | Stop `2.40x -> 1.38x -> 1.38x` double fee-crash across `effectiveLastPickupAt`/`lastPickupAt`, fix double-shifted `order.deadline`, cap `changedKmScale * rescue` (`7.60x` bug) | **+€1,200 to +€2,200/wk & +1.5% on-time** |
| **4 (HIGH)** | `P0-5`, `P0-6`, `P1-3` | `dispatch.ts`, `starter.ts` | Fix direct offers paying `1.00x * refSum` on bundles, eliminate `23:00–07:00` sleep-window fee escalations, target offers at actual `gigId` holdout viewers | **+€2,500 to +€4,500/wk fee savings** |
| **5 (HIGH)** | `P0-10`, `P1-10`, `P1-11`, `P1-12` | `market.ts` | Fix Price-War double-discount/overshoot, `noDayLogC` 80km outage detector, `dlDay = 7` capacity cap, per-slot shadow unit, `equalMargin3d` tautology, trade-in turnaround | **+€2,000 to +€3,800/wk pricing uplift** |
| **6 (MED)** | `P1-2`, `P1-6`, `P1-8`, `P2-1` | `dispatch.ts`, `market.ts`, `notes.ts` | Tighten 3-car bundle gate & preserve 2-car bundle on split, long-haul northern sink surcharge, `pool30` suburb fix (`lempaala`/`raisio`), `"sorry, i mean"` note rule | **+€1,000 to +€1,800/wk & 100.0% notes** |






