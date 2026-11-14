# RoutePulse

Autonomous pricing and dispatch system for **Spread** (Bahn Express vehicle transport challenge, Level 8).

RoutePulse quotes car dealers across multi-option delivery menus (`same_day`, `next_day`, `within_3_days`), selects profitable orders under regional driver shortages, combines cars into 2- and 3-car corridor gigs, adapts fee schedules and direct offers to live driver views, and replans dispatches through snowstorms, competitor outages, price wars, midnight flu waves, and mid-run restarts.

Zero runtime dependencies — runs directly on Node 22.18+ or Bun from [`src/starter.ts`](src/starter.ts). For full mathematical formulas, state-machine rules, and disruption tables, see **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

---

## 1. Results at Level 8

Every score below is verified in [`results/`](results/) with full console logs. Across **25 official ranking weeks** and **60 unseen random practice weeks** (**85 Level-8 weeks**, ~35,000 cars), RoutePulse achieved a **100% ranked rate (`85 / 85`)** and **`0.0%` undelivered cars on every single week**.

### Official Ranking Rounds (`--board`, 5 secret weeks per round)

| Ranking Round | 5-Week Gross Margin | Won Orders | On-Time Share | Not Delivered | Ranked | Leaderboard Standing |
|---|---:|---:|---:|---:|---|---|
| **Saturday `12:00`** (Season 6) | **€95,671.45** | 2,267 | **97.9%** | **0.0%** | **5 / 5** | **`#4` final** (`#1` live at finish) |
| **Saturday `15:00`** (Season 7) | **€92,830.32** | 2,123 | **97.6%** | **0.0%** | **5 / 5** | **`#1` live** (`+€3,382` vs `#2`) |
| **Saturday `18:00`** (Season 8, `v19`) | **€79,828.80** | 2,107 | **98.0%** | **0.0%** | **5 / 5** | **`#2` live** of 238 teams (highest Top-12 OT) |
| **Saturday `00:00`** (Season 4, earlier `v9`) | **€75,474.57** | 1,953 | **96.4%** | **0.0%** | **5 / 5** | `#10` of 151 teams |
| **Saturday `09:00`** (Season 5, earlier `v14`) | **€73,949.86** | 1,935 | **97.8%** | **0.0%** | **5 / 5** | **`#4` final** |

### Benchmarks & Unseen Out-of-Sample Generalization (Level 8)

| Evaluation Set | RoutePulse Margin | Baseline Comparison | On-Time Share | Not Delivered | Ranked |
|---|---:|---|---:|---:|---|
| **`spread-1` single week** | **+€17,069.05** | **−€72,612.51** for kit starter (**`+€89,681.56`** on same seed) | **98.5%** | **0.0%** | **1 / 1** |
| **Best single week (`ab19-09`)** | **+€30,056.61** | `+€28,755.90` `v16` (`+€1,300.71` on same seed; `ab16-09`: `+€26,060.73`) | **98.9%** | **0.0%** | **1 / 1** |
| **5-seed development suite** | **€86,529.95** | `€76,930.88` early `main` (`+€9,599.07` on same 5 seeds) | **97.7%** | **0.0%** | **5 / 5** |
| **`ab19c` unseen random weeks (10, `v19`)** | **€178,581.62** *(€89.3k / 5 wk)* | `€174,890.32` `v18` (**`+€3,691.30`**, `8W–2L` on same 10 seeds) | **97.4%** | **0.0%** | **10 / 10** |
| **`ab16` unseen random weeks (10)** | **€176,558.53** *(€88.3k / 5 wk)* | `€167,269.11` pre-`v16` (`+€9,289.42` on same 10 seeds) | **97.8%** | **0.0%** | **10 / 10** |
| **`ab19` unseen random weeks (10, `v18`)** | **€165,607.38** *(€82.8k / 5 wk)* | `€162,257.08` `v17` (`+€3,350.30`, `9W–1L`) & `€160,353.77` `v16` (`+€5,253.61`) | **97.7%** | **0.0%** | **10 / 10** |
| **`oos2` unseen random weeks (10)** | **€159,316.04** *(€79.7k / 5 wk)* | `€156,495.45` pre-`v16` (`+€2,820.59` on same 10 seeds) | **97.3%** | **0.0%** | **10 / 10** |
| **`ab18r` unseen random weeks (10)** | **€159,072.97** *(€79.5k / 5 wk)* | `€158,337.11` `v16` (`+€735.86` on same 10 seeds) | **97.1%** | **0.0%** | **10 / 10** |
| **`ab18` unseen random weeks (10)** | **€140,001.58** *(€70.0k / 5 wk)* | `€138,637.58` `v16` (`+€1,364.00` on same 10 seeds) | **97.8%** | **0.0%** | **10 / 10** |

---

## 2. What Makes RoutePulse Unique (Jury Criteria Alignment)

### Elegant — Few core mechanisms doing most of the work
Instead of hundreds of lane-specific heuristics, one unified economic equation governs every decision:
1. **Quote side (`estimator.ts`, `market.ts`):** Infer the competitor's current price distribution online from our own win/loss outcomes, compute our true dispatch cost (driver fee + return-flow imbalance + expected late-refund and dealer-trust risk + capacity shadow price), and maximize expected gross margin jointly across all delivery options.
2. **Dispatch side (`bundling.ts`, `dispatch.ts`, `offers.ts`):** Pay less than the typical fee (`referenceFeeCents`) where drivers want to go (dense hubs, arriving-driver chains, 2–3 car corridor gigs), and escalate fees only during waking hours (`07:05–22:45`) when drivers actually read notifications.

### Clear — Direct mapping from domain concepts to modular TypeScript
Every subsystem lives in its own single-purpose file in [`src/`](src/) using Spread's exact vocabulary (`request`, `dealer`, `order`, `gig`, `fee`, `typical fee`, `list price`, `deadline`, `lastPickupAt`, `direct offer`):

```text
price_request ─► notes.ts (FI/SV/EN truth) ─► planner.ts (feasibility & 5 car rules)
                                                    │
order_won/lost ◄─ outbox.ts ◄─ market.ts (Copula menu) ◄─ estimator.ts (Bayesian market + surprises)
      │
      ▼
   desk.ts (pairing buffer & state) ─┬─► bundling.ts (2-car & 3-car corridor gigs)
                                     ├─► dispatch.ts (waking-hour fee schedules)
                                     └─► offers.ts   (chain & live-viewer direct offers)
```

### Creative — Three non-obvious insights about dealers, drivers, and the week
1. **Common-Provider-Shock Copula for Multi-Option Menus (`market.ts`):** A dealer does not roll three independent competitors for `same_day`, `next_day`, and `within_3_days` — **one competitor** prices all options from a shared hidden world/lane/day factor. Integrating over that single shared shock $U \in [0, 1]$ stops our own options from cannibalizing each other and steers Friday-deadline cars onto Monday (`within_3_days`) where 3.5 execution days exist with zero new requests.
2. **Midnight Flu Fingerprinting & Night-Bundle Hold (`desk.ts`, `bundling.ts`):** Drivers stay home for the flu at the start of the day (`00:00–01:30` `gig_dropped` bursts without snow), while no driver reads app notifications between `23:00` and `07:00`. Detecting midnight drop bursts immediately shifts same-day pricing and holds night-dropped multi-car gigs intact until `09:15` instead of shattering them into expensive solo gigs at `02:00` while drivers sleep.
3. **Treating Live `gig_viewed` Events as a Reveal of Who Works Today (`offers.ts`):** The driver list never shows which drivers decided to work today, and sending blind direct offers burns the 3-offers-per-driver daily limit on drivers who stayed home. RoutePulse treats recent `gig_viewed` events (`<= 20–25` minutes) as live proof that a driver has the app open right now — waking immediately on 1st-view bundle or home-return viewers (`<= 30 km` from delivery), reserving each driver's 3rd daily offer slot for high-value matches, and nudging active viewers `+3%..+13%` over the live app fee instead of raising the public board fee for everyone (which would teach all viewing drivers to wait for raises).

### Robust — Proven on unseen weeks, network drops, and mid-run restarts
- **Unseen-week stability:** `85 / 85` Ranked (`0.0%` not delivered) across 60 unseen random Level-8 weeks and 5 official ranking rounds, spanning severe driver shortages (`< 700` drivers) to dense rosters (`930+` drivers).
- **Tear-free restart & live-clock resilience (`starter.ts`, `rejoin.ts`, `outbox.ts`):**
  - Brackets `world.snapshot()` between `history0` and `tail` `world.events()` by sequence number (`seq`) so zero events are dropped or double-counted on a `--final` restart.
  - Reconstructs competitor beliefs, snow forecasts, dealer trust, `order_changed` shifts, and midnight-flu state via `rejoinDeskState()`.
  - Drains the WebSocket stream in 6 ms micro-batches and flushes urgent `quote` actions through a dedicated fast-lane (`<= 20` per batch) ahead of `post`/`offer` chunks (`<= 15`), keeping `respondBy` latency well inside the 4.5-second live-clock window without exhausting the 20 actions/sec `final-actions` token bucket.
  - Never calls `world.delete()` on `--board` ranking runs on `SIGINT` or transient `502/503/504` errors, automatically resuming unfinished ranking runs instead of forfeiting them.

---

## 3. Core Ideas: What, Why, and Measured Effect

### Idea 1 — Online Bayesian Competitor Estimator & Common-Provider-Shock Menu Pricing
- **The idea (`src/estimator.ts`, `src/market.ts`):** Decompose the competitor's log-price relative to the **unrounded** list price (`(2000 + 25 * km) * legMult * optMult`) into fixed pickup/delivery town factors (`PLACE_ALPHA`), an online world-level mean, a daily offset, a distance-slope tilt, per-dealer retaliation/satisfaction, and outside-anchored log-likelihood ratio (LLR) detectors for **80 km regional outages (`+30%`, with superset parsimony penalty and `effDayOffset >= -0.03` outage-zone floor)** and **morning-gated level-8 price wars (`−20%`, with `0.65 / 0.35` Monday shrinkage & Tuesday quote-16 verification)** — replaying non-event quotes cleanly once an outage or price war is detected so our world baseline is never poisoned. Then optimize the full `(same_day, next_day, within_3_days)` price menu jointly under a shared competitor shock.
- **Why:** Fixed markups over list price lose high-margin cars during regional outages, win unprofitable cars when a dealer retaliates, and mislearn the week's price level after a Monday price war. Independent per-option pricing also underprices `same_day` relative to `next_day`, crowding single-day driver pools.
- **The effect (same seeds, Level 8):** Adding the Copula menu optimizer and non-event LLR replay lifted the 5-seed benchmark from **€83,723.14 (`97.4%` on time)** to **€86,529.95 (`97.7%` on time, `0.0%` not delivered)** (**`+€2,806.81`**). In `v19`, adding the outage-zone daily-offset floor, Monday-PW shrinkage blend, and balanced 2-leg trade-in pricing gained a further **`+€3,691.30` (`8W–2L`, `€174,890.32 -> €178,581.62`, on-time `96.95% -> 97.41%`)** across 10 unseen random weeks (`ab19c`).

### Idea 2 — Corridor Bundling (2–3 Cars), Arriving-Driver Chaining & Night-Clamped Schedules
- **The idea (`src/bundling.ts`, `src/dispatch.ts`, `src/offers.ts`):** Hold non-urgent weekday dealer-to-dealer orders in a slack-adaptive `22–75` minute pairing buffer to form 2-car (`dh <= 50` road min, `p2AlignedStart` simulation) and 3-car (`dh <= 32` min, `<= 440` total road min) gigs starting at **`0.56x–0.66x`** of combined typical fees, while propagating Car 2's latest pickup backward onto Car 1's pickup stop window so a driver can never collect Car 1 late and miss Car 2's closing hour. For solo gigs, open hub-to-hub lanes at **`0.81x`** typical fee, release and repost booked solo gigs when `order_changed` shrinks route distance by `> 38%` (`>= €35` savings), and clamp all fee-schedule raises out of `22:45–07:05`.
- **Why:** At Level 8, a driver's biggest cost is unpaid public-transport deadhead to the pickup and back home. Combining two or three corridor cars eliminates mid-route public transport, while raising fees between `23:00` and `07:00` receives zero notifications and merely teaches drivers at `07:00` to wait for higher fees.
- **The effect (same seeds, Level 8):** Upgrading from naive schedule steps and solo dispatch to waking-hour clamped schedules, Viewer-capped offers (`+3%..+13%`), and dropped-bundle retention lifted `spread-1` from **€13,613.74 (`95.9%` on time)** to **€17,069.05 (`98.5%` on time)** (**`+€3,455.31`** on the same week).

### Idea 3 — Midnight Flu Detection, Dealer Trust Shield & Bulk-Order (`batchId`) Ranking
- **The idea (`src/desk.ts`, `src/market.ts`):**
  1. **Midnight flu detector:** Flag a flu day when `>= 6` (`< 740` drivers) or `>= 8` (`>= 740` drivers) non-snow bookings drop between `00:00` and `01:30`, applying scarcity pricing only to same-day deadlines rather than over-penalizing multi-day deliveries.
  2. **Dealer trust shield:** Value each early-week on-time delivery's `+1%` future price tolerance across expected remaining dealer requests (capped at `trust + inFlight <= 25`), while charging `pLate` for the catastrophic cost of halving accumulated trust.
  3. **Same-minute `batchId` ranker:** Coalesce simultaneous requests, rank a 30–40 car bulk yard burst by expected margin plus return-flow synergy before quoting, and cap wins to `0.25 * Q30` local drivers plus return-hub capacity.
- **Why:** Audit of ranking event logs showed `main` missed 4 out of 5 flu waves when checking morning hours (`05:00–09:30`), while unranked bulk orders depleted single-town driver pools on the first arbitrary request IDs.
- **The effect (same seeds, Level 8):** Across 20 unseen random Level-8 weeks (`ab16` + `oos2`), adding midnight-flu detection, night-bundle holding, and multi-day capacity separation raised total margin from **€323,764.56** to **€335,874.57** (**`+€12,110.01`**, or **`+€3,027.50` per 5-week round**, `20 / 20` Ranked, `0.0%` not delivered).

### Idea 4 — 100% Verified Trilingual (FI / SV / EN) Dealer Note Reader
- **The idea (`src/notes.ts`):** Deterministic clause-by-clause parser handling Finnish, Swedish, and English notes with fuzzy typo stems, mid-note self-corrections (`ei kun`, `tai siis`, `sorry, I mean`, `rättelse`), contrast negations (`ei klo 12 vaan klo 15`), inflected word-hours (`puoli yhdestä` = `12:30` vs `yhdeksästä` = `09:00`), Swedish `först` vs `torstai`, payment holds (`releasedAt`), narrowed site hours, trade plates (`withPlates`), manual gearboxes, and summer tyres in snow (`experienced` audience + non-snow pickup windows).
- **Why:** At Level 5+, a single misread note triggers a `visit_failed` fee (`>= €25`), wastes half a day of lead time, or causes a late refund + halved dealer trust.
- **The effect:** Validated against `reveal` ground truth across **18,031 car legs** (`14,487` development legs + `3,544` out-of-sample legs) with **18,031 / 18,031 (`100.000%`) exact field match** (`0` mismatches across `readyAt`, `releasedAt`, `pickupHours`, `deliveryHours`, `manualGearbox`, `needsPlates`, and `summerTyres`).

---

## 4. What Did Not Work (Negative Same-Seed Experiments)

Every change was gated on matched multi-seed A/B tests; ideas that hurt margin or reliability were reverted:

1. **Penalizing small (`< 12`-car) `batchId` groups (`-€1,796` on 5-seed benchmark):** Dealers frequently send 2–5 car mini-batches across different towns. Applying yard-depletion surcharges below 12 cars rejected profitable multi-car opportunities; restricting the yard cap to true bulk orders (`seenCount >= 12`) recovered the full margin.
2. **Flat `€11.50` fixed per-slot shadow cost (`-€2,780` on 5-seed benchmark):** Charging every car a flat slot fee over-priced short urban hops (`85%` of €25 typical fee) while under-pricing 500 km northern trips. Replacing it with a hybrid shadow unit (`€5.20 + €1.35 * roadHours + 0.24 * referenceFee`) matched driver time consumption.
3. **Aggressive `64h` end-of-world rescue starting Last Monday morning (`-€828` on `quant-compare-1`):** Escalating past-deadline gigs to `1.45x–2.95x` fees on Last Monday morning overpaid on cars that still had 2.5 full business days before Wednesday `22:00`. Delaying maximum rescue escalation to the final **42 hours** (Tuesday `04:00` onward) kept **`0.0%` not delivered** across all 85 weeks while saving ~€600–€900/week in late driver fees.
4. **Naive 3-car bundling without hub/deadhead gates (`-€5,237` on 5-seed benchmark in `4ec0232`):** Greedily chaining a 3rd car onto open 2-car bundles caused `gig_expired` and late cascading failures when the 3rd leg landed in a low-driver town. Restricting 3-car extensions to `<= 32 min` link deadhead, `<= 440 min` total road time, and `>= 300 min` slack made 3-car bundling strictly net-positive.
5. **Over-tightening bundle post-delivery slack (`175m -> 205m`) & cutting 2-leg Step-0 `m0` (`0.21 -> 0.15`) (`-€2,910.53` on `ab19` 10-seed benchmark):** Tightening clear-weather bundle slack and shortening pairing holds destroyed `104` 2-car bundles (`895 -> 791`, forcing `208` extra solo gigs onto the driver pool), while cutting Step-0 `m0` on 2-leg trade-ins raised late 2-leg orders from `3` to `14`. Keeping `v18`'s bundling slack and `m0 += 0.21` while moderating only quote-side 2-leg risk turned `-€2,911` into **`+€3,691.30` (`8W–2L`)** on `ab19c`.

---

## 5. What Would Break Our System (Known Limits)

1. **Unseen idioms or fourth-language notes:** `src/notes.ts` is a deterministic lexical/clause parser, not a general language model. A note written in German/Estonian or expressing readiness via pure world-knowledge metaphor without time/ready stems would fall back to the request's stated windows and rely on `visit_failed` retry recovery.
2. **Simultaneous multi-day nationwide snow + extreme `< 550`-driver roster:** If snow covered every major hub continuously for 72+ hours in a deep shortage, `pLate` admission gates (`pLate <= 0.135`) would intentionally decline most quotes by pricing high — preserving the `>= 90%` on-time ranking floor, but winning very few cars.
3. **Client machine losing connectivity for `> 10` real minutes during `--final`:** While `rejoinDeskState()` recovers seamlessly upon reconnection and open gigs continue executing their posted fee schedules on the server, every `price_request` whose 4.5-second `respondBy` window expires while our process is offline goes unquoted to the competitor.

---

## 6. Quickstart & Commands

Set the server URL and team key in your shell environment (**never** commit `SPREAD_KEY` to files or logs):

```bash
export SPREAD_URL=https://spread.bahnexpress.com
export SPREAD_KEY=<your-team-key>
```

Run from the repository root using Node (`>= 22.18`) or Bun:

```bash
# Practice week at Level 8 (random seed, auto-deleted on Ctrl-C)
node --no-warnings src/starter.ts

# Deterministic practice week on a specific seed (for A/B comparison)
node --no-warnings src/starter.ts --level 8 --seed spread-1

# Official ranking run (plays next world 1..5 of the active ranking round)
node --no-warnings src/starter.ts --level 8 --board | tee results/$(date +%F)-ranking-run.log

# Live Test Final / Sunday Final (waits if scheduled, streams via WebSocket, auto-rejoins)
node --no-warnings src/starter.ts --final | tee results/$(date +%F)-final.log

# Export an ended practice world's reveal + events + map to CSVs
node --no-warnings src/reveal-csv.ts <worldId>
```

---

## 7. Repository Structure

| Path | Lines | Responsibility |
|---|---:|---|
| [`src/starter.ts`](src/starter.ts) | 304 | CLI entrypoint, `playPractice` step loop, `playFinal` 6 ms WebSocket micro-batch loop & crash recovery |
| [`src/desk.ts`](src/desk.ts) | 2,319 | Core dispatcher state machine, `batchId` ranker, pairing buffer, snow/summer-tyre guards, urgent/rescue escalations |
| [`src/market.ts`](src/market.ts) | 895 | Option risk & cost model (`etaLate`), dealer trust valuation, shadow pricing, Copula menu optimizer |
| [`src/planner.ts`](src/planner.ts) | 750 | Road graph & 30 km / 80 km spatial indices, `SnowTracker`, 5 car-handling rules, stop window builder |
| [`src/notes.ts`](src/notes.ts) | 653 | Validated FI / SV / EN dealer note parser (`18,031 / 18,031` ground-truth leg accuracy) |
| [`src/estimator.ts`](src/estimator.ts) | 600 | Online Bayesian + Newton-Raphson competitor estimator, outside-anchored 80 km outage & price-war LLR detectors |
| [`src/offers.ts`](src/offers.ts) | 435 | `DirectOfferTracker` — arriving-driver chaining, live-viewer nudges (`+3%..+13%`), quota management |
| [`src/bundling.ts`](src/bundling.ts) | 385 | 2-car & 3-car corridor gig bundler with backward pickup-window propagation and cross-night split timers |
| [`src/spread.ts`](src/spread.ts) | 316 | Zero-dependency HTTP + WebSocket API client with `RateLimit` token buckets (`50`-token final burst cap) |
| [`src/dispatch.ts`](src/dispatch.ts) | 288 | Monotonic waking-hour (`07:05–22:45`) fee schedules, hub-flow discounts, Rule-4 pickup-cliff schedules |
| [`src/rejoin.ts`](src/rejoin.ts) | 206 | Tear-free state reconstruction (`rejoinDeskState`) from `snapshot` + `events` for `--final` and `--board` |
| [`src/outbox.ts`](src/outbox.ts) | 205 | Priority-ordered `ActionOutbox` (`quote` fast-lane, cancel-before-post safety, `--final` chunking) |
| [`src/supply.ts`](src/supply.ts) | 105 | `RosterSupplyModel` (`30 km` notification & `65 km` commuter driver pools by licence and experience) |
| [`src/time.ts`](src/time.ts) | 83 | World-minute arithmetic and `clampOutOfNight` (`22:45–07:05` notification blackout clamp) |
| [`src/reveal-csv.ts`](src/reveal-csv.ts) | 60 | Utility exporting an ended practice world's `reveal`, `events`, `roster`, and `map` to CSV files |
| [`src/types.ts`](src/types.ts) | 550 | Strict TypeScript contracts matching Spread OpenAPI 3.1 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | — | Detailed formulas, state transitions, rate-limit budgets, and disruption recovery reference |
| [`results/`](results/) | — | Complete console logs for ranking rounds, benchmark sweeps, and same-seed A/B experiments |
