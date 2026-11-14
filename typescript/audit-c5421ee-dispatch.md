# Dispatch, Bundling & Direct-Offer Performance Audit (`c5421ee`)

- **Target Commit:** `c5421ee` (`Unify 8d69968 and engine-69k fixes for 82.4k 5-seed benchmark`)
- **Audited Files:** `typescript/dispatch.ts` (775 lines), `typescript/planner.ts` (585 lines), `typescript/starter.ts` (1,843 lines)
- **Empirical Evidence Base:**
  - Commit `c5421ee` 6-world Level-8 logs (`results/2026-11-14-omni-v4-*.log`): **€95,976.76 total margin** on **€254,700.26 revenue** across **2,461 won orders** (**€39.00 margin/order**, **62.3% total cost share = €158,723.50** in driver fees, refunds, and penalties; **95.6%–98.9% on-time**).
  - Offline replay & structural measurements across the 4 saved Level-8 worlds (`reveal-baseline-spread-1`, `reveal-study-a`, `reveal-study-b`, `reveal-study-c`: **4,142 requests**, **662–930 shortage-world drivers/world**, and **168,016 gig views / 1,312 bookings** in `reveal-baseline-spread-1`).

---

## Executive Summary & Ranked Impact Roadmap

Across the 6 `c5421ee` Level-8 benchmark worlds, RoutePulse retains **37.7% of revenue as margin (€39.00/order)** while leaving **5.6–8.9 percentage points of on-time buffer** above the 90% ranking floor and losing **62.3% of revenue (~€64.50/order)** to driver fees and late-tail costs. Static trace + offline replay against the 4 local Level-8 datasets uncovered **four P0 bugs that directly bleed margin or threaten `--final` liveness**, followed by high-leverage structural optimizations in fee schedules, multi-car bundling, and viewer-targeted direct offers:

| Rank | ID | Proposal | Primary Files : Lines | Est. Weekly Impact (Level 8, ~410 orders) | Target Metric / Budget |
|---:|---|---|---|---|---|
| **1** | **P0-A** | **Fix `--final` stream batching, double offer pass & infinite refused-offer loop** | `starter.ts:1436, 1645-1647, 1707-1721`; `dispatch.ts:568-575` | **Prevents `--final` 4.5s quote timeouts & 20/s action-bucket starvation** (+€1,500–€5,000 preserved in bulk-order/urgent bursts) | `< 1.5s` p99 quote latency; `< 3.5` actions/sec steady-state; `0` refused-offer loops |
| **2** | **P0-B** | **Stop sending `0.95x–1.03x * refSum` direct offers on `0.58x`/`0.52x` multi-order bundles** | `starter.ts:1182, 1259, 1284, 1358-1398`; `dispatch.ts:730-759` | **+€1,400 to +€2,600 / week** (€35–€65 saved per Direct-Offer-booked bundle) | Bundle booked fee `<= 0.72x * refSum` (currently `0.95x–1.03x` on offer accept!) |
| **3** | **P0-C** | **Eliminate dead-night escalations (`23:00–07:00`) in `eveTrainAt`, `morningWaveAt`, and `warnLead`** | `dispatch.ts:122-168`; `starter.ts:1520-1527, 1571-1578` | **+€900 to +€1,700 / week** (`947/947` `eveTrainAt` steps & `13–21` urgent ramps/world currently fire while drivers sleep) | `0` schedule steps between `23:00` and `07:00`; morning urgent fee `1.38x` at `07:00` vs `2.40x–2.55x` |
| **4** | **P0-D** | **Replace `3.00x` post-deadline & `2.40x` post-`lastPickupAt` panic schedules with cliff-value schedules** | `dispatch.ts:101-137`; `starter.ts:1065-1070, 1503-1519` | **+€450 to +€1,200 / week** (eliminates negative Tue–Wed tail margin seen in 3 of 6 `omni-v4` seeds) | Late-tail margin `>= +35%` of tail revenue; `3.00x` gated to final `<= 38h` before `endsAt` |
| **5** | **P1-A** | **Viewer-specific `DirectOfferTracker` (`recordView(driverId, gigId, at)`) + stop `t + 2` cold spray** | `starter.ts:429, 535, 1531-1545`; `dispatch.ts:523-535, 607-774` | **+€1,100 to +€2,100 / week** (targets the 17.1% holdout bookers who added €3,978 / €17.76 per booking in `baseline-spread-1`) | Direct-offer accept rate `> 18%` (from `< 3%`); `expired` offers cut by `> 75%` |
| **6** | **P1-B** | **Fix `minRampStart` step-collapse (`earliestPickupAt` clamp), `D_pool30` suburb mispricing & post-drop reset** | `dispatch.ts:54-95, 170-194`; `starter.ts:815-820` | **+€800 to +€1,500 / week** (`27.7%` of `same_day` opts collapse steps; `181–356` suburb opts/world mispriced by `D_home`) | `0` multi-anchor cliff jumps; `-4%` to `-12%` `m0` on Espoo/Vantaa/Lempäälä/Raisio |
| **7** | **P1-C** | **Multi-day bundle simulation (`07:00` next-day start) + overnight-aware `splitAt` & soft unbundle** | `dispatch.ts:267-336, 371, 425-482`; `starter.ts:1018-1030, 1160-1162` | **+€700 to +€1,400 / week** (`+9%–10.6%` more valid 2-car bundles; stops `now + 120` killing overnight round trips) | Bundle completion share `> 65%` (vs `27.8%` baseline 4-stop); `+25–40` bundled legs/week |
| **8** | **P1-D** | **Fix `activeCommitments()` sliding `estStart` & `nextOfferCheckAt` blocking live `delivered` chains** | `starter.ts:61-79, 271-316, 540-547, 779, 946, 1436` | **+€500 to +€950 / week** (unlocks `0.88x` zero-deadhead chain offers to in-flight and just-delivered drivers) | Chained-driver offer share `> 30%` of all sent offers |
| **9** | **P2-A** | **Fix `planner.ts` Day-0 window pinning on `narrowedDeliv`/`narrowedPick` & `rejoin()` state loss** | `planner.ts:470-502, 532-568`; `starter.ts:413-508` | **+€300 to +€700 / week + `+0.5–1.0%` on-time + full `--final` restart safety** | `0` Day-0 forced `gig_expired` on `next_day`/`within_3_days` orders |

**Combined Realistic Uplift:** **+€6,000 to +€11,500 per Level-8 week** (**+€30k to +€57k across a 5-world ranking round**, lifting the 5-seed benchmark from **€82.4k** into the **€112k–€135k** bracket while improving on-time reliability and making `--final` rock-solid).

---

## 1. Single-Gig Fee Schedules & Stop-Window Planning

### 1.1 Overnight Schedules Escalate in the `23:00–07:00` Dead Zone (`dispatch.ts:122-168`, `starter.ts:1520-1527`)

Per `HANDBOOK.md` and `RULES.md`: *"No driver reads a notification from 23:00 to 07:00"*, *"No driver reads an offer from 23:00 to 07:00"*, and *"A raise sends no notification: a driver sees the new fee when they next open the app."* Three separate code paths in `c5421ee` violate this rule and burn fee steps while 100% of drivers are asleep:

1. **`eveTrainAt` fires between `00:00` and `04:30 AM` in 100.0% of cases (`dispatch.ts:148-156`)**:
   ```ts
   // dispatch.ts:148-155
   if (crossesNight && ctx.routeKm > 400) {
     const eveTrainAt = Math.max(ctx.now + 75, ctx.earliestPickupAt - 360, lpa - 540)
     if (eveTrainAt < lpaDayStart + 6 * HOUR + 20) {
       rampOffsets.push({ at: eveTrainAt, mult: Math.max(m0 + 0.08, 1.04) })
     }
   }
   ```
   - **Root cause:** On >400 km `next_day` hauls (e.g., Helsinki -> Oulu 608 km / 405 min, Helsinki -> Rovaniemi 580 min), `lpa` on `lpaDay` sits between `09:30` (`lpaDayStart + 570`) and `13:00` (`lpaDayStart + 780`). Subtracting `540` minutes (9 hours) places `lpa - 540` between **`00:30 AM` and `04:00 AM`**.
   - **Measured frequency:** Across all 4 local Level-8 datasets (`249 + 248 + 245 + 205 = 947` >400 km overnight options), **`947 / 947` (`100.0%`)** placed `eveTrainAt` inside `23:00–07:00`, and **`0 / 947` (`0.0%`)** landed in the evening (`18:00–22:00`) when evening-train drivers actually book!
2. **`morningWaveAt` steps to `>= 1.08x` at `06:40 AM` before any driver wakes (`dispatch.ts:160-168`)**:
   - `morningWaveAt = Math.max(ctx.now + 90, ctx.earliestPickupAt - 60, lpaDayStart + 6 * HOUR + 40)` fires at **`06:40 AM`** across **603–765 options/world** (`2,679` total across the 4 datasets).
   - Because no driver reads the app before `07:00` (and `starter.ts:1552` doesn't even run `morningFlush` offers until `07:05`), stepping up at `06:40` forfeits all `07:00–07:40` bookings at `m0` (`0.85x–0.98x`) and teaches every driver who viewed the gig the previous afternoon that waiting overnight yields an automatic `+0.12x` raise.
3. **Proactive `warnLead` urgent escalation runs its entire 5-step ladder up to `2.40x–2.55x` while drivers sleep (`starter.ts:1520-1527`, `dispatch.ts:122-137`)**:
   - In `starter.ts:1521-1525`, `warnLead` is `240` min (VIP `dealer.trust >= 6`) or `195` min. For any overnight haul whose `effLpa` falls between `07:30` and `10:30 AM` (measured on **`13–21` orders/world**, e.g. 6–10h northern routes or `noteDeadline` morning deliveries), `trig = effLpa - warnLead` fires between **`03:30 AM` and `06:30 AM`**.
   - `escalateOrderUrgent` immediately posts `[1.38, 1.60, 1.84, 2.12, 2.40/2.55]` at **25-minute intervals** (`+0, +25, +50, +75, +100` min). By `07:00 AM` when drivers wake up, all intermediate steps have already elapsed in the dark and the first driver opening the app at `07:01` takes **`2.40x–2.55x`** (`~€320` on a `€130` northern refFee) instead of `1.38x–1.55x`, wasting **€100–€140 per affected haul**. Furthermore, `g.offerWave++` (`starter.ts:1011`) increments at `05:00 AM` even though `selectOffersForGig` (`dispatch.ts:618`) returns `[]` before `07:00`.

**Actionable Fix (`dispatch.ts:122-168`, `starter.ts:1520-1527, 1571-1578`):**
- Add a helper `clampOutOfNight(t: number): number` that maps any step timestamp `t` with `(t % DAY) >= 22 * HOUR + 45` or `(t % DAY) < 7 * HOUR + 5` forward to `nextMorning0705 + staggerOffset` (preserving 25–35m step spacing starting from `07:05`, not collapsing to `07:05`).
- Anchor `eveTrainAt` to the **previous evening's actual booking window**: `const postDayStart = Math.floor(ctx.now / DAY) * DAY; const eveTrainAt = Math.max(ctx.now + 60, postDayStart + 19 * HOUR + 15)` gated on `eveTrainAt <= postDayStart + 21 * HOUR + 30`.
- Shift `morningWaveAt` from `06:40` (`6 * HOUR + 40`) to **`07:40` (`7 * HOUR + 40`)**, giving the `07:00–07:40` morning wave and `07:05` direct offers 35–40 minutes to clear at `m0`.
- In `starter.ts:1524` and `1576`, clamp urgent trigger time `trig`: if `(trig % DAY) < 7 * HOUR`, defer `trig` to `Math.floor(trig / DAY) * DAY + 7 * HOUR` (and if `(trig % DAY) >= 22 * HOUR + 45`, either fire at `22:15` or defer to `07:00`).

---

### 1.2 `minRampStart` Step-Collapse, `within_3_days` 72h Freeze & Post-Drop Reset (`dispatch.ts:30-46, 170-194`, `starter.ts:815-820`)

In `dispatch.ts:170-193`:
```ts
const minRampStart = Math.max(
  ctx.earliestPickupAt,
  crossesNight
    ? Math.max(ctx.now + 120, lpaDayStart + (isLongOrDeadEnd ? 7 * HOUR + 45 : 8 * HOUR + 45))
    : ctx.now + 80,
)
...
for (const a of anchors) { // beforeLpa: 360, 265, 185, 115, 60
  const t = Math.max(minRampStart, lpa - a.beforeLpa)
  if (t < lpa - 15) {
    rampOffsets.push({ at: t, mult: Math.min(maxUrgentMult, Math.max(m0 + a.add, a.floor)) })
  }
}
```
When `minRampStart > lpa - 360`, multiple anchors clamp to the exact same minute `t = minRampStart`. `normalizeSteps` (`dispatch.ts:38-40`) deduplicates equal timestamps via `prev.feeCents = Math.max(prev.feeCents, step.feeCents)`, **erasing the gentle intermediate steps (`0.98x`, `1.12x`, `1.30x`) and creating a single cliff jump straight to `1.30x`, `1.56x`, or `1.88x` at `minRampStart`**.

- **Measured severity across the 4 Level-8 datasets (`7,247` non-urgent feasible options):**
  - **`1,228 / 7,247` (`16.9%`)** of all non-urgent options — including **`768 / 2,770` (`27.7%`) of `same_day` options** and **`415 / 3,809` (`10.9%`) of `next_day` options** — collapse at least 2 steps into one timestamp.
  - **`853` options (`11.8%`)** collapse **3 or more anchors into a single massive fee spike** (e.g., `0.85x -> 1.56x` in 1 minute!).
- **Why clamping `minRampStart >= ctx.earliestPickupAt` is wrong:** Drivers do **not** wait until `earliestPickupAt` to book; they book **before** `earliestPickupAt` so they can travel to the pickup and collect the car *at* `earliestPickupAt`. When a note sets `readyAt = 14:30` (or a private pickup slot is `14:30–15:30`) with `lpa = 15:40` and `now = 09:30`, clamping `minRampStart = 14:30` freezes the gig at `0.85x` for 5 hours (`09:30–14:30`) when pre-positioning drivers could book at `0.98x–1.12x`, and then jumps straight to `1.56x` at `14:30` when drivers >35 km away can no longer arrive before `15:40`.
- **`within_3_days` 72-hour dead freeze (`dispatch.ts:140, 173`):** `lpaDayStart` is anchored to `Math.floor(lpa / DAY) * DAY` (`155–214` options/world have `lpa - now >= 24h`). On a Monday `within_3_days` order due Thursday, the gig stays frozen at `m0` (`0.81x–0.85x`) for **72 hours**, aging on the board (`RULES.md`: *"A gig that stays on the board for a while did not pay the drivers who saw it ... so they wait more for a raise"*).
- **Post-drop fee reset bug (`starter.ts:815-820`):** When a driver drops a gig at `t = 13:00` (`slackMin = 240 > 210`) after booking it at `1.12x`, `handleGigDroppedOrNoShow` calls `computeSingleSchedule(order, legIndices)` at `now = 13:00`, which **resets Step 0 back down to `m0 = 0.85x` for 80 minutes (`now + 80`)**! That wastes the fresh 30 km push notification triggered by `gig_dropped` (`HANDBOOK.md`: *"A gig that comes back in the app after a drop or a no-show notifies again"*) on a `0.85x` fee already proven below clearing cost.

**Actionable Fix (`dispatch.ts:170-194`, `starter.ts:815-820`):**
1. Replace `ctx.earliestPickupAt` in `minRampStart` with `Math.max(ctx.now + 65, ctx.earliestPickupAt - 180)` (3 hours before `earliestPickupAt`, when drivers plan transit to pickup), and distribute ramp steps proportionally across `[rampStart, lpa - 45]` (`t_k = rampStart + (k / 5) * (lpa - 45 - rampStart)`) whenever `(lpa - 45) - rampStart < 315` so **steps never collide at the same timestamp**.
2. On multi-day orders (`Math.floor(lpa / DAY) - Math.floor(ctx.now / DAY) >= 2`), add one modest mid-horizon discovery step (`m0 + 0.06`, capped at `0.96x`) at `day1Start + 10 * HOUR` so returning drivers on intermediate days can clear the order cheaply without waiting until Day 3.
3. In `handleGigDroppedOrNoShow` (`starter.ts:816`), floor `newSchedule` at `Math.round(Math.max(prevAppFeeCents * 1.04, g.feeCents * 1.03))` so the drop's fresh 30 km notification immediately advertises a clearing raise rather than resetting to `m0`.

---

### 1.3 `m0` Cluster Blindness (`D_home` vs `D_pool30`), Shortage Scaling & Driver-Learning Calibration (`dispatch.ts:53-95`, `market.ts:564, 624-628`)

In `dispatch.ts:54-76`:
```ts
const D_home = supply.homeDrivers(ctx.deliveryPlaceId)
const sameCluster30 = map.isSameCluster30(ctx.pickupPlaceId, ctx.deliveryPlaceId)
const isLongOrDeadEnd = ctx.routeKm > 250 || (D_home <= 12 && !sameCluster30)
...
if (D_home >= 80 && Q30 >= 40 && !hasExtras && !ctx.snowOverlap && !ctx.fluActive && ctx.routeKm <= 220) {
  m0 -= 0.04 // 0.81x
}
if (D_home <= 5 && !sameCluster30) m0 += 0.08
else if (D_home <= 12 && !sameCluster30) m0 += 0.05
```
- **Empirical town vs 30 km cluster mismatch across all 4 Level-8 reveals:**
  - **`lempaala`** (16 km from Tampere): `homeDrivers = 2, 0, 1, 1` (`<= 5` in **4/4 worlds**), yet `pool30("lempaala") = 111, 49, 129, 130`! Every intercity delivery into Lempäälä gets slapped with **`+0.08` dead-end surcharge (`m0 = 0.93` instead of `0.81`, +14.8% fee waste)** AND `isLongOrDeadEnd = true` (`06:40` `1.08x` jump)!
  - **`raisio`** (7 km from Turku): `homeDrivers = 5, 1, 1, 0` (`<= 5` in **4/4 worlds**), yet `pool30("raisio") = 29, 17, 87, 61`!
  - **`espoo`** (`homeDrivers = 76, 62, 43, 26` — **`< 80` in 4/4 worlds!**) and **`vantaa`** (`homeDrivers = 47, 128, 47, 28` — **`< 80` in 3/4 worlds!**) sit inside Greater Helsinki (`pool30 = 418, 345, 383, 461`), yet fail `D_home >= 80` across **58–195 options/world**, forfeiting the `-0.04` hub discount (and inflating `trueCostCents` in `market.ts:624-628`).
- **Driver-learning expectation trap (`HANDBOOK.md` "Drivers learn your fees"):** Drivers who view an order and could do it learn `bookedFee / firstViewedFee`. In Level-8 shortage towns (`16 <= Q30 <= 30`, e.g., Tampere `49` or Turku `17` in `study-a`), opening at `m0 = 0.85` (`+0.00` shortage adder for `Q30 > 15`!) when gigs systematically clear at `1.08x–1.20x` teaches local drivers `bookedFee / firstViewedFee ≈ 1.32x`, causing drivers who would have accepted `0.98x` to hold out for `1.20x+`.
- **Hard cap `Math.min(1.32, m0)` (`dispatch.ts:94`):** Compound-hard orders (e.g., `experienced` `+0.18` + `privateDelivery` `+0.16` + `snow` `+0.12` + `Q30 <= 5` `+0.07` -> `1.38`) get clamped down to `1.32`, stalling unbooked until urgent escalation.

**Actionable Fix (`dispatch.ts:54-95`, `market.ts:564, 624-628`):**
1. Replace `D_home = supply.homeDrivers(deliveryPlaceId)` with **`D_pool30 = supply.pool30(deliveryPlaceId, false, false)`** in both `dispatch.ts:54` and `market.ts:564` (adjusting hub discount threshold to `D_pool30 >= 95 && Q30 >= 45`).
2. Add continuous town shortage scaling for `15 < Q30 < 35`: `if (Q30 < 35) m0 += 0.03 * ((35 - Q30) / 20)` and raise the `m0` ceiling from `1.32` to `1.48` when `hasExtras || ctx.snowOverlap`.
3. Track a shrunk per-cluster clearing-multiplier EWMA `learnedClearMult[clusterId]` from non-urgent `gig_booked` events (`feeCents / baseRefFeeCents`), and set `m0 = Math.max(m0, 0.92 * learnedClearMult - 0.03)` after `>= 5` observations so shortage-hit towns open near clearing price instead of teaching drivers to wait for raises.

---

### 1.4 Rescue (`isPastDeadline`) vs Past-`lastPickupAt` (`zombieCleared`) Cliff Economics (`dispatch.ts:101-137`, `starter.ts:1065-1070, 1503-1519`)

In `c5421ee`, two late-stage transitions ignore `RULES.md`'s discrete refund step function (`<= 2h`: 10%, `2–24h`: 25%, `24h–2 bus. days`: 50%, `> 2 bus. days`: 100%, `undelivered at Wed 22:00`: -200% penalty) and Rule 4 (*"A driver who reaches a site that its stated hours show closed leaves the car at once: the delivery counts when the site next opens"*):

1. **At `now = ord.lastPickupAt + 1` (`starter.ts:1503-1514`):** `zombieCleared` withdraws the expired-in-practice gig, strips windows, marks `this.urgent.add(ord.id)`, and reposts with the **full `1.38x -> 2.40x/2.55x` urgent schedule**.
   - **Why this wastes €60–€120/order:** Standard dealer sites close at `18:00` or `20:00` (`== ord.deadline`). Once `now > ord.lastPickupAt`, a driver CANNOT reach the dealer before `20:00` closing. Under Rule 4, arriving at `20:10` tonight at a closed dealer gate counts as delivered at **tomorrow `08:00` (`12h late` = 25% refund, late count + trust loss ALREADY incurred)** — the **exact same refund and score outcome** as delivering calmly tomorrow at `15:00` (`19h late` = still 25% refund)! Paying `2.40x` tonight vs `1.05x–1.25x` tomorrow morning burns `~1.25x * refFee` (`€75–€130`) for **€0.00 refund savings**. (Exception: `delivery.privateAddress` or sites open past deadline where `< 2h` 10% refund vs 25% refund saves `0.15 * orderPriceCents`.)
2. **At `now = ord.deadline + 31` (`starter.ts:1516-1519`, `dispatch.ts:102-117`):** `isPastDeadline` triggers `[1.58, 1.88, 2.22, 2.60, 3.00]` every 35 minutes (`20:31 -> 22:51`!).
   - On Monday–Friday at `20:31`, the `-200%` undelivered cliff (`endsAt = Day 9, 22:00`) is still **118 to 214 hours away**! Yet by `22:51` that same evening, the gig sits at **`3.00x * refFee`**, gifting `3.00x` to the first driver waking up at `07:00` next morning to save at most `0%` (within the 24h 25%-refund band until next evening `20:00`!).
   - **Direct proof in `c5421ee` benchmark logs (`results/2026-11-14-omni-v4-*.log`):**
     - `experiment-route-fee.log`: Tue–Wed late tail added `+€387.81` revenue but **`-€289.88` net margin** (`€677.69` in fees/refunds = **174.7% cost/revenue**).
     - `opportunity-compare-1.log`: Tue–Wed late tail added `+€1,041.51` revenue but **`-€106.20` net margin** (`€1,147.71` in fees/refunds = **110.2% cost/revenue**).

**Actionable Fix (`dispatch.ts:101-137`, `starter.ts:1065-1070, 1503-1519`):**
- Split post-`lastPickupAt` into **three distinct regimes**:
  1. **Sub-2h salvageable (`now > effLpa && canDeliverBefore(deadline + 120)` — e.g., private delivery or open hours after deadline):** Cap max multiplier at `Math.min(2.10, (expectedNormalFee + 0.15 * orderPriceCents) / baseRefFeeCents)`.
  2. **Already-in-25%-or-50%-band (`now > effLpa`, `endsAt - now > 38 * HOUR`):** Do **not** run `2.40x` or `3.00x`! Run a **recovery schedule** `[max(m0 + 0.08, 1.02), 1.14, 1.28, 1.45, 1.68]` paced across daytime hours (`07:15–17:00`) toward the *next* business-day `20:00` refund cliff (`25% -> 50%` or `50% -> 100%`, worth `0.25–0.50 * orderPriceCents`).
  3. **True End-of-World Undelivered Rescue (`endsAt - now <= 38 * HOUR`, i.e., final Tuesday `08:00` to Wednesday `22:00`):** Activate the `[1.58, 1.88, 2.22, 2.60, 3.00]` ladder to guarantee `0.0%` undelivered before `endsAt`.

---

### 1.5 `planner.ts` Multi-Day Window Pinning & Premature `gig_expired` (`planner.ts:470-502, 532-568`)

1. **`narrowedDeliv` (`planner.ts:536-558`) and `narrowedPick` (`planner.ts:471-481`) pin multi-day orders to Day 0:**
   - `nextRealDayWindow(minReachableDeliv, effDl, realDelivHours, 30)` (`planner.ts:538`) returns the **first matching day** (`startDay`). When an order is won on Monday morning (`minReachableDeliv = Mon 11:00`, `firstWin.to = Mon 16:00`, `firstWin.to - minReachableDeliv = 300 >= 150`) for `next_day` (Tue 20:00) or `within_3_days` (Thu 20:00) with a note narrowing delivery close from `18:00` to `16:00`, `planner.ts:552-556` sets **`deliveryStop.window = { from: Mon 11:00, to: Mon 16:00 }`**.
   - **Consequence:** A 2-day or 4-day order is artificially forced to deliver by **Monday 16:00**! All Tuesday–Thursday drivers are blocked from booking it, and at Monday `16:01` the server fires `gig_expired`, **burning the order's one-shot 30 km push notification** (`HANDBOOK.md`: *"A driver hears of each order once, however often you post it again"*).
   - **Fix:** For `narrowedDeliv`, if `Math.floor(effDl / DAY) > Math.floor(minReachableDeliv / DAY)`, set `deliveryStop.window.to` to the **deadline day's** real close (`effDlDay * DAY + realClose`) rather than Day 0's close (under Rule 4, an early-day arrival between real close and stated close waits at most 2h for max €30 and counts next morning — still 100% on-time!). For `narrowedPick` (`planner.ts:475`), raise `minRemainingMinutes` from `45` to `165` whenever a later open day exists before `effectiveLastPickupAt` so a 45-minute afternoon sliver never wastes the order's notification.
2. **Dealer `pickupStop.window.to = effectiveLastPickupAt` (`planner.ts:490-502`):**
   - Because `effectiveLastPickupAt` is 18–35 minutes earlier than `order.lastPickupAt` (from the 15m + 3% clear-weather safety buffer at `planner.ts:302-308`), capping `pickupStop.window.to = effectiveLastPickupAt` causes the server to expire the gig (`gig_expired`) 20–35 minutes *before* `order.lastPickupAt`, forcing an unnotified repost during the most critical final half-hour. Keep `effectiveLastPickupAt` for internal schedule/urgency timing, and cap `pickupStop.window.to` only when `noteDeadline` or `realDelivHours` genuinely lowers the hard pickup limit below `order.lastPickupAt - 5`.

---

## 2. 2-Order & 3-Order Bundling Efficiency

### 2.1 P0 Bug: Direct Offers Pay Full Unbundled `0.95x–1.03x * refSum` on Every Bundle (`starter.ts:1358-1398`, `dispatch.ts:730-759`)

Whenever a 2-order or 3-order bundle is posted (`starter.ts:1182, 1259, 1284`), `this.needsImmediateOfferPass = true` schedules a direct-offer pass **2 minutes later (`now + 2`)**.
- In `buildOfferTarget` (`starter.ts:1358-1364, 1396`), `refSum` sums `r.referenceFeeCents / o.legs.length` across **all 2 or 3 bundled orders**, and passes `refFeeCents: refSum` to `selectOffersForGig`.
- `selectOffersForGig` (`dispatch.ts:730-759`) never inspects `gig.orderIds.length`! On a Helsinki -> Tampere -> Helsinki round-trip bundle (`distP = 0 <= 30`, `distD = 0 <= 30`), line 734 sets `mult = 0.95` (`1.00–1.03` on evening/next-day), and line 752 computes:
  $$\text{rawFee} = \text{round}(\text{refSum} \times 0.95)$$
- **Quantified damage:** Two minutes after posting a 2-car bundle at **`0.58 * refSum`** (or a 3-car bundle at **`0.52 * refSum`**), RoutePulse sends 2 direct offers to top Helsinki drivers at **`0.95x–1.03x * refSum`** — **17% to 27% MORE expensive than posting two solo gigs at `0.81x` (`0.81 * refSum`)**! Every accepted bundle offer converts a €45 bundle saving into a €20 overpayment (**€40–€65 swing per bundle**).

**Actionable Fix (`starter.ts:1388-1403`, `dispatch.ts:730-760`):**
- Add `isBundled: boolean` (or read `gig.orderIds.length > 1`) in `selectOffersForGig`. For multi-order bundles, anchor offer fees to **`gig.currentAppFeeCents`** (e.g., `Math.round(gig.currentAppFeeCents * (1.00 + 0.03 * gig.offerWave))`, capped at `0.76 * gig.refFeeCents` for 2-order and `0.70 * gig.refFeeCents` for 3-order), and wait **12–15 minutes** after bundle post before sending non-viewer bundle offers so organic `0.58x` app bookings settle first.

---

### 2.2 Afternoon `next_day` / `within_3_days` Bundles Falsely Rejected by `now + 60` Start (`dispatch.ts:302-320, 434-466`)

In `evaluateOrderedBundle` (`dispatch.ts:302-320`):
```ts
const tP1 = visitAt(Math.max(now + 60, p1From), p1To, hP1, 15)
...
if (tP2 - tArrP2 > 90) return undefined
...
if (Math.floor(tP1 / DAY) !== Math.floor(tFin2 / DAY)) return undefined
```
- **Root cause:** When two `next_day` orders (e.g., `Helsinki -> Tampere` and `Tampere -> Helsinki`, both due Tuesday `20:00`) are present on **Monday afternoon at `14:30`**, `visitAt(Mon 15:30, Tue 20:00, hP1, 15)` greedily starts Car 1 at **Monday `15:30`** because Dealer 1 is still open until `18:00`. Car 1 finishes at `17:45`, Dealer 2 closes at `18:00`, so `tP2` rolls to **Tuesday `08:00`** — triggering `tP2 - tArrP2 = 855 > 90` (`line 313`) and `Math.floor(tP1 / DAY) !== Math.floor(tFin2 / DAY)` (`line 319`), **rejecting the bundle**! The exact same bug occurs in `tryExtendTwoToThreeOrderBundle` (`dispatch.ts:434`: `let curAt = now + 60`, `line 465`: `Math.floor(tFin / DAY) !== firstDay`), rejecting virtually 100% of 3-car bundles after `12:00` noon.
- **Measured impact across all 4 Level-8 datasets:** Testing candidate start times `[now + 60, nextDay0700, dayAfter0700]` rescues **366–462 rejected ordered pairs per world**, increasing total bundleable D2D orders by **+8.9% to +10.6%** (`+21 to +43` orders/world).

**Actionable Fix (`dispatch.ts:302-321, 434-467`):**
- Wrap lines `302–321` (and `434–467` for 3-car bundles) in a loop over candidate start anchors:
  `const startCandidates = [now + 60, (Math.floor(now / DAY) + 1) * DAY + 7 * HOUR, (Math.floor(now / DAY) + 2) * DAY + 7 * HOUR]`, accepting the first anchor that satisfies `tP2 - tArrP2 <= 90`, same-day execution `Math.floor(tP1 / DAY) === Math.floor(tFin2 / DAY)`, and `effDl - tFin >= 240`. When the winning anchor is on a future day `execDay > Math.floor(now / DAY)`, set `stops[0].window = { from: Math.max(p1From, execDay * DAY + 7 * HOUR), to: p1To }` or ensure slack covers next-day execution cleanly.

---

### 2.3 Premature `splitAt` (`now + 120` / `now + 105`) & Permanent `doNotBundle` Ban (`dispatch.ts:335, 480`, `starter.ts:1018-1030`)

- In `dispatch.ts:335`, `splitAt = Math.min(now + 120, minLastPickup - 210)` (and `now + 105` for 3-car bundles at `dispatch.ts:480`, giving Step 3 at `now + 90` only **15 minutes** on the board!).
- When a `next_day` bundle is posted at Monday `16:15` (due Tuesday `20:00`, `minLastPickup = Tuesday 15:30`), `splitAt` fires at **Monday `18:15`** — **21 hours before `minLastPickup`**, and **before Tuesday's drivers even decide whether they work Tuesday morning** (`RULES.md`: *"A driver books a gig for a later day only when they know they will work that day: some know their week, most only the next day"*).
- Worse, `splitOpenBundle` (`starter.ts:1026`) adds all constituent orders to `this.doNotBundle` permanently and reposts them solo without notifications (since their 1-per-order notification was already spent).

**Actionable Fix (`dispatch.ts:335, 480`, `starter.ts:1018-1030`):**
- Make `splitAt` **daylight- and slack-aware**:
  - Do not count dead-night minutes (`22:30–07:00`) toward bundle patience.
  - If `Math.floor(minLastPickup / DAY) > Math.floor(now / DAY)` and `minLastPickup - now >= 600`, extend `splitAt` to `Math.min(minLastPickup - 240, Math.max(now + 180, lpaDayStart + 9 * HOUR + 30))` so next-morning `07:00–09:30` full-day drivers see the round trip before splitting.
  - On 3-car bundles (`dispatch.ts:480`), increase minimum daytime dwell from `105m` to `150m` (giving Step 3 at `+90m` a full 60 minutes), or step down from 3-car to the best **2-car sub-bundle + 1 solo gig** before exploding all 3 orders into `doNotBundle`.

---

### 2.4 Open-Jaw Stranding, 3-Order Bugs, `pairingBufferUntil` & Shortage Gating (`dispatch.ts:264-270, 324-331, 371, 380, 425-479`, `starter.ts:1160-1162, 1293-1304, 1462-1472`)

1. **Tier-2 (`poolD2 >= 18`, `dispatch.ts:269`) and 3-Order (`poolD3 >= 35`, `dispatch.ts:429`) Open-Jaw Stranding:**
   - Line 269 allows `else if (dh <= 50 && (ret <= 125 || poolD2 >= 18)) tier = 2`. This permits chaining `Helsinki -> Tampere` + `Tampere -> Oulu` (`dh = 0`, `poolD2("oulu") = 39 >= 18`), stranding a Helsinki driver **608 km (`ret = 405` min!)** from home at `0.66 * refSum`! High driver density in Oulu (`poolD2`) does **not** pay a Helsinki driver's 608 km same-day return train ticket (`HANDBOOK.md`: *"they buy the ticket home on the day ... so it costs more"*).
   - **Fix:** Cap open-jaw `ret` strictly at `ret <= 135` for 2-order Tier 2 (and `ret <= 110` for 3-order at `dispatch.ts:429`) regardless of `poolD2`/`poolD3`.
2. **Three bugs in `tryExtendTwoToThreeOrderBundle` (`dispatch.ts:445, 471`, `starter.ts:1160-1162`):**
   - **Missing snow pricing & link slow-down:** `dispatch.ts:471` sets `const mktMult = 1.0 + (fluActive ? 0.08 : 0)` — completely omitting the `+0.10` snow multiplier present in 2-order bundles (`dispatch.ts:324`) and using `1.03` instead of snow-adjusted `1.25` on inter-car `link` road minutes (`dispatch.ts:445`).
   - **Missing middle & reverse permutations (`starter.ts:1160-1162`):** Only `[e1, e2, target]` and `[target, e1, e2]` are tested, missing `[e1, target, e2]` (e.g., inserting a local Tampere hop inside a `Helsinki -> Tampere -> Helsinki` pair) and the 3 swapped `[e2, ...]` orderings (`6` total permutations take `< 0.05 ms`).
   - **Shortage/flu gating:** During `fluActiveToday` (30% fewer working drivers) or when `poolP1 < 35`, 6-stop 3-car bundles (`coeffs = [0.52, 0.60, 0.69, 0.79]`) require scarce full-day capacity; disable 3-car extensions when `fluActiveToday || poolP1 < 35` and raise 3-car `coeffs` to `[0.56, 0.64, 0.72, 0.81]`.
3. **Arbitrary `now - cand.wonAt > 180` open-gig block (`dispatch.ts:371`) & lexicographic `poolB > poolA` override (`dispatch.ts:380`):**
   - Across the 4 datasets, `now - cand.wonAt > 180` blocks **`36–57` valid pairs/world** where an older `next_day`/`within_3_days` order is *still sitting open and unbooked* on the board with `minLastPickup - now >= 260`. Remove `now - cand.wonAt > 180` (slack is already guarded by `minLastPickup - now < 260` at line 273).
   - At `dispatch.ts:380`, `poolB > poolA ? ba : ...` forces `Helsinki (418)` over `Tampere (109)` even if `ab` is Tier 1 (`dh = 0`) and `ba` is Tier 2 (`dh = 49`) with €25 worse score! Only prefer higher pool lexicographically when `Math.min(poolA, poolB) < 25`; otherwise use `score` (which already includes `Math.min(600, poolP1 * 2)` at `line 339`).
4. **Adaptive `pairingBufferUntil` (`starter.ts:1293-1304, 1462-1472`):**
   - Across `study-a/b/c`, a 22-minute hold captures **53.2%–57.3%** of daily pairs, whereas a **40-minute hold on high-slack (`effLpa - now >= 900m`, `next_day`/`within_3_days`) orders** captures **70.6%–72.9% (+17 percentage points)** — avoiding a solo `post` + `withdraw` and preserving the order's one-time 30 km push notification!
   - Also gate `pairingBufferUntil` on `curTod >= 8 * HOUR` (no requests arrive before `08:00`, `starter.ts:1295`), and in `tickTimers()` (`starter.ts:1470`) pass `allowBundle = true` when flushing expired buffer entries so two orders buffered within minutes of each other (or alongside a newly dropped open gig) still pair on flush.

---

## 3. `DirectOfferTracker` Conversion & `--final` Action Budget

### 3.1 `recordView` Throws Away `event.gigId` — Missing the Highest-Margin Offer Target in Spread (`starter.ts:429, 535`, `dispatch.ts:523-535`)

In `types.ts:202-208`, `GigViewedEvent` carries **both** `gigId` and `driverId`:
```ts
export type GigViewedEvent = { seq: number; at: number; kind: "gig_viewed"; gigId: string; driverId: string }
```
Yet `starter.ts:429` & `535` call `this.offers.recordView(event.driverId, event.at)`, throwing away `event.gigId`!

- **Why `event.gigId` is the single highest-value signal in the game (`HANDBOOK.md` + `RULES.md` + `reveal-baseline-spread-1` proof):**
  1. `RULES.md`: *"A driver who reads an offer takes it when the fee pays for the gig and what else their day is worth to them. In the app the same driver may hold out for more, because the fee may rise there, though another driver may take the gig first. **Thus an offer saves most on gigs whose fee drivers expect to rise.**"*
  2. **Exact measurement in `reveal-baseline-spread-1` (`168,016` views, `1,312` bookings):**
     - **224 bookings (`17.1%` of all bookings)** were made by drivers who **viewed that exact `gigId` earlier, held out for a raise, and later booked that same `gigId`** (116 of them viewed it `>= 2` times!), costing **€3,978.31 in fee escalation between their first view and eventual booking (€17.76 extra per delayed booking)**!
     - In the first 20 minutes after posting, each gig has a **median of only `2.0` (mean `4.9`) geo-matched viewers** (`distP <= 65 || distD <= 30`), and **154** of those early viewers were the exact drivers who came back to book later at higher fees!
     - Furthermore, **435 of 1,312 bookings (`33.2%`)** came from drivers with **`distP > 65 km AND distD > 30 km`** — e.g., drivers positioned near `pickupPlaceId` after finishing a **competitor's** gig (invisible to `commitments` and `recentDeliveries`) or taking long hauls! Currently `dispatch.ts:700` (`if (!chained && distP > 65 && distD > 30) continue`) **hard-blocks 100% of these drivers**, whereas a driver with `distP > 65` who **viewed `gig.gigId` twice** (planned re-check look!) is actively working and tracking that exact gig!

**Actionable Fix (`dispatch.ts:523-536, 698-737`, `starter.ts:429, 535`):**
- Change signature to `recordView(driverId: string, gigId: string, at: number): void` and maintain `gigViewers = new Map<string, Map<string, { firstAt: number; lastAt: number; count: number }>>()` (cleaned up in `clearGig(gigId)`).
- Score viewers of `gig.gigId` who have **not** booked after `8–15` minutes:
  - **Repeat viewer of `gig.gigId` (`count >= 2`)**: `+55` score bonus AND bypass the `distP > 65 && distD > 30` filter (`dispatch.ts:700`), because `HANDBOOK.md` confirms *"A driver who works that day and waits for a raise plans one more look at the gig, at the time they expect it to pay them enough"* — a repeat viewer is **guaranteed to be working today and able to do the gig**!
  - **Single viewer of `gig.gigId` (`count === 1`, `now - firstAt <= 90`) with geo-match (`distP <= 65 || distD <= 30`)**: `+34` score bonus (separating genuine local candidates from curiosity browsers >65 km away, whose conversion in `baseline-spread-1` was only `0.65%` vs `2.05%` for destination-home viewers and `4.29%` for `< 15m` viewers).

---

### 3.2 Why Thousands of Offers Expire & Decline (`starter.ts:271-316, 1436, 1531-1545`, `dispatch.ts:537-553, 647, 695-760`)

Tracing `DirectOfferTracker` and `starter.ts` reveals **five compounding defects** causing mass `expired` and `declined` answers while wasting the `3 offers/driver/day` quota:

1. **The `t + 2` Cold-Offer Spray (`starter.ts:1334, 1531-1545`):**
   - Every newly posted gig triggers `nextTimerAt() -> this.now + 2` (`starter.ts:1542`) and blasts 2 offers at `t + 2`.
   - In `reveal-baseline-spread-1`, **82.9% of bookings (`1,088 / 1,312`) book organically on first view**, mostly in the first `1–12` minutes after posting! Blasting 2 offers at `t + 2` on easy gigs means when the gig books organically in the app at `t + 4`, both open offers **automatically resolve as `expired` at `t + 12`** (`RULES.md`: *"a yes for a gig that is no longer open ... come after the 10 minutes as `expired`"*), burning 2 of our best hub drivers' 3 daily offer slots for zero benefit!
   - **Fix:** Defer non-urgent, non-chained initial offers from `t + 2` to **`t + 12`–`t + 15`** (after the initial organic notification wave settles and `gigViewers` has collected the gig's real holdout viewers!). Only send immediate `t + 2` offers for **urgent gigs** or **chained drivers (`chained === true`)** whom app notifications never reach (`HANDBOOK.md`: *"The app does not notify a driver where your gigs have taken them"*).
2. **`maxInactiveMins = 540` (9 hours!) + `bookedOrDeliveredDay` Bugs (`dispatch.ts:537-553, 695-696, 718`):**
   - `maxInactiveMins = 540` treats a driver who opened one curiosity view at `08:10` on their day off (or finished a morning-only shift at `11:00`) as "active" until **`17:10`**, sending offers they never read (`expired`). Tighten `maxInactiveMins` to **`75` minutes** for non-viewers of `gig.gigId` (`150` min for urgent/scarce gigs).
   - `recordBooked` (`dispatch.ts:539`) keys `bookedOrDeliveredDay` by `Math.floor(at / DAY)` (when the driver tapped Book, even if the gig is for *tomorrow*!), whereas `recordDelivered` (`dispatch.ts:549-553`) **never adds `driverId` to `bookedOrDeliveredDay` at all**! And `workedToday` (`dispatch.ts:718`) grants `+26` bonus even at `21:30` after the driver already finished a 400-minute day!
3. **`activeCommitments()` Sliding `estStart` Breaks In-Flight Chaining (`starter.ts:299-303`) + `nextOfferCheckAt` Blocks `delivered` Chains (`starter.ts:779, 946, 1436`):**
   - In `starter.ts:299-303`:
     ```ts
     const estStart = Math.max(this.now, pickups[0]!.window?.from ?? firstOrd.legs[pickups[0]!.leg]!.pickup.window.from)
     const estFinish = estStart + roadSum + pickups.length * 25
     ```
     Because `GigState` never records `startedAt` on `gig_started` (`starter.ts:540-547`), a `working` driver who started a 3-hour gig 2 hours ago at `10:00` has `estStart = this.now` (`12:00`) and `estFinish = 15:25` instead of `13:05`! Their finish time slides forward every minute until `delivered`, hiding nearly all in-flight `chained` matches (`dispatch.ts:668`)!
   - Then, the instant `delivered` finally fires (`starter.ts:942-946`), `queueDirectOffersForOpenGigs` (`starter.ts:1436`) skips every open gig in that town with `this.now < g.nextOfferCheckAt` (up to **45 minutes**)!
   - **Fix:** Record `startedAt: number | null` on `gig_started` (and `picked_up` timestamps) so `estFinish` is anchored to real start time; and on `handleDelivered` / `handleGigBooked`, run a targeted **driver-centric chain pass** offering that specific arriving driver the best open gig within 35 km of `placeId`, bypassing `g.nextOfferCheckAt`.
4. **Premature Lockout via `attemptedGigDrivers` (`dispatch.ts:647`) + Fee Miscalibration (`starter.ts:1363`, `dispatch.ts:738-760`):**
   - `buildOfferTarget` (`starter.ts:1363`) omits `changedKmScale` (`starter.ts:1055-1057`), severely underbidding rerouted `order_changed` orders.
   - `selectOffersForGig` (`dispatch.ts:738-742`) omits **snow (`+0.12`), flu (`+0.10`), EV charging (`+0.08`), plates/manual (`+0.04`), dead-end `D_pool30 <= 12` (`+0.05–0.08`), and >260 km hauls (`+0.07–0.13`)**.
   - At `dispatch.ts:753-759`, when `distP > 30` and `slackMin > 190`, `feeCents` is **not** floored against `gig.currentAppFeeCents`, sending `0.93x` offers while the public app already shows `1.12x–1.30x`! Conversely, for `distP <= 30`, offering `1.00x * currentAppFeeCents` (`0.81x–0.85x`) at `t + 2` gets `declined` and permanently blacklists `${gigId}:${driverId}` in `attemptedGigDrivers` (`line 647`) for the entire non-urgent window!
   - **Fix:** Align non-chained offer base cost with `buildSingleGigSchedule`'s `m0` extras; never offer below `currentAppFeeCents` unless `chained` (`>= 0.90 * currentAppFeeCents`) or pre-escalation viewer holdout capture (`currentAppFeeCents + 0.35 * (nextStepFeeCents - currentAppFeeCents)` — splitting the upcoming raise 35/65 with the viewer so they accept now instead of waiting for the full step!).

---

### 3.3 P0 Crisis in `--final`: Action-Bucket Starvation, 4.5s Quote Timeouts, Infinite Refused-Offer Loop & `rejoin()` State Loss (`starter.ts:413-508, 1436, 1644-1647, 1707-1726`)

In `--final`, weekday time moves at **3.33 world minutes/sec (`15 world min = 4.5 real seconds` to answer `price_request`)**, and `final-actions` refills at **20 tokens/sec** (`1 token per individual action`, `spread.ts:78`). Look at `playFinal` (`starter.ts:1707-1720`):

```ts
for await (const event of world.stream({ after: history.at(-1)?.seq ?? -1, idleMs: 800 })) {
  const day = Math.floor(desk.now / DAY)
  if (event === null) {
    const f = await world.client.final()
    desk.now = Math.max(desk.now, f.now)
  } else {
    desk.handle(event)
  }
  desk.tickTimers()
  await desk.send()
  if (desk.outbox.length === 0) {
    desk.queueDirectOffersForOpenGigs(2)
    if (desk.outbox.length > 0) await desk.send()
  }
```

Four severe failure modes interact here:
1. **Per-event serial `await desk.send()` across 100,000+ `gig_viewed` events:** `world.stream()` yields one event per loop turn — including every `gig_viewed` (~100k–168k/week). Instead of draining all ready events in the WebSocket buffer before sending one batched `POST /actions`, `playFinal` runs `tickTimers()` + `await desk.send()` on every single event. During the Level-8 **Bulk Order** (`30–40 price_request` events arriving in the same minute alongside `order_won` + `gig_viewed` bursts), 30 `order_won` events queue `30 posts + 60 offers = 90 actions` (`4.5 seconds` of `final-actions` wait at 20/sec!). Processing events one-by-one stalls subsequent `price_request` events in the stream buffer past their **4.5-second `respondBy` deadline**!
2. **Unconditional double offer sweep (`lines 1717-1720`):** Because `await desk.send()` on line 1716 empties `desk.outbox`, `if (desk.outbox.length === 0)` on line 1717 is **`true` on 100% of stream events**, running `queueDirectOffersForOpenGigs(2)` a second time on every `gig_viewed`!
3. **Infinite Refused-Offer Spin Loop when `urgentEscalated === true` (`starter.ts:1436` + `1644-1647` + `dispatch.ts:568-575`):**
   - Line 1436: `if (this.now < g.nextOfferCheckAt && !g.urgentEscalated && !g.pastDeadlineEscalated) continue` **bypasses `nextOfferCheckAt` whenever `g.urgentEscalated` is true**!
   - If the server returns `{ ok: false }` on an offer (e.g., driver hit 3 daily offers on a race or gig state changed), `rollbackOfferRefused` (`dispatch.ts:568-575`) deletes `${gigId}:${driverId}` from `attemptedGigDrivers` and decrements `offersSentByDay`.
   - On the very next `gig_viewed` event milliseconds later, `queueDirectOffersForOpenGigs` bypasses `nextOfferCheckAt`, **picks the exact same driver again**, sends the refused offer again (`line 1716`), rolls back again, **sends it AGAIN on `line 1719`**, and **burns 100% of the 20 tokens/sec `final-actions` budget in an infinite loop**!
4. **`rejoin()` Amnesia on Server Restart (`starter.ts:413-508`):**
   - `rejoin()` ignores `order_lost`, never calls `this.pricing.estimator.onQuoteResolved` (wiping out learned `worldLogMean`, `dayLogOffset`, `distanceSlope`, `priceWarToday`, `outageCenterToday`, and `dealer.morningRetalLog`), ignores `delivered` events for `offers.recordDelivered`, ignores `offer_answered` (`declinedMaxFee`), and ignores `snapshot.driverPositions` (`types.ts:388`)!

**Actionable Fix (`starter.ts:413-508, 1436, 1644-1647, 1707-1726`):**
1. **Never bypass `g.nextOfferCheckAt` unconditionally (`starter.ts:1436`):** Even for urgent gigs, set `g.nextOfferCheckAt = this.now + 10` (world minutes) after checking, and in `rollbackOfferRefused` (`dispatch.ts:568`), **keep `${gigId}:${driverId}` in `attemptedGigDrivers`** (or block that pair for `+30` world minutes) unless refusal reason is transient rate-limit (which returns HTTP 429, not `{ ok: false }`).
2. **Delete lines `1717-1720`** (the redundant second `queueDirectOffersForOpenGigs(2)` call).
3. **Coalesce stream events & enforce a `--final` action reserve in `playFinal`:**
   - Drain all immediately available WebSocket messages (or coalesce over a `25 ms` micro-window while events are streaming, flushing immediately if any `price_request` has `respondBy - desk.now <= 4`) before running `desk.tickTimers()` once and calling `desk.send()` once.
   - Reserve token headroom for `quote`/`post`/`withdraw`: in `--final`, cap `offer` actions per `send()` batch to `Math.min(8, remainingFinalActionTokens - 15)` whenever `openRequests` or `Monday–Friday 08:00–18:00` request traffic is active so `quote` actions **always** fire with zero `Bucket.take()` delay.
4. **Complete `rejoin()` (`starter.ts:417-495`):** Replay `quote` outcomes (`order_won` + `order_lost`) chronologically into `pricing.estimator`, replay `delivered` and `offer_answered` into `offers`, and seed `activeCommitments` / `recentDeliveries` from `snapshot.driverPositions`.

---

## 4. Performance Budgets, Monitoring & Paired Validation Protocol

Before deploying to ranking rounds or the Sunday 08:00 Final, validate changes sequentially on the **6 fixed Level-8 seeds** (`spread-1`, `experiment-route-fee`, `opportunity-compare-1`, `paired-variant-1`, `panel-compare-1`, `quant-compare-1`) plus **both Saturday Test Finals (`--final`)**:

### Telemetry Counters to Emit at End-of-Run (saved to `results/YYYY-MM-DD-*.log`)
1. **Fee Efficiency:** `ledgerDriverFeeCents / sum(wonRefFeeCents)` overall, split by `{solo_normal, solo_urgent, solo_late_tail, bundle_2car, bundle_3car}`, plus count of collapsed ramps (`stepsMerged > 0`) and night steps (`23:00–07:00`).
2. **Bundling Funnel:** `bufferedOrders`, `pairedInBuffer`, `pairedFromBoard`, `3carExtended`, `bundlesCompleted`, `bundlesSplit`, and `bundleBookedFee / bundleRefSum`.
3. **Direct-Offer Funnel:** `offersSent`, `offersAccepted`, `offersDeclined`, `offersExpired`, `offersRefused`, stratified by `{chained, repeat_viewer, single_viewer, cold}` — plus `--final` max `send()` queue wait (ms) and p99 `price_request -> quote` latency (ms).

### Hard Acceptance Gates (Per-Seed & 6-Seed Aggregate)
- **On-Time Reliability:** Every seed `>= 93.5%` on-time (`0.0%` undelivered on all 6 seeds; hard platform floor is `90.0%`).
- **Late-Tail Profitability:** Post-Monday-20:00 tail (`End.margin - Mon2.margin`) `>= €0` on every seed unless unavoidable 25%/50% refund exceeds price.
- **Bundle Economics:** Mean completed 2-car bundle fee `<= 0.72 * refSum`; bundle completion rate `>= 60%`.
- **Offer Conversion & `--final` Safety:** Direct-offer acceptance rate `>= 15%`; total offers sent `< 600 / week` (vs multi-thousand cold spray); `--final` p99 quote latency `< 1,500 ms` (well inside the `4,500 ms` `respondBy` window) and `0` refused-offer retries.
