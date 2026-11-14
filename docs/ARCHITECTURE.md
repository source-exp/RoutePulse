# RoutePulse Technical Architecture & Decision Reference

This document details how **RoutePulse** (`src/*.ts`) makes pricing, bundling, fee-scheduling, direct-offer, and recovery decisions across a simulated Level-8 dispatch week in Finland. All terminology matches Spread's `RULES.md` and `HANDBOOK.md`.

---

## 1. End-to-End Decision Lifecycle

```text
1. INGEST & PARSE (t = arrivedAt)
   price_request ─► parseDealerNote() [notes.ts]
                 ─► Coalesce same-minute batch & resolve prior order_won/order_lost first [desk.ts]

2. EVALUATE & PRICE (before respondBy = t + 15m)
   For each option in {same_day, next_day, within_3_days}:
     computeOptionPlan() [planner.ts]  ──► Hard feasibility, snow, EV charge, plates, manual, 12h drive cap
     evaluateOption()    [market.ts]   ──► Late risk pLate, true driver cost, return-flow & slot shadow cost,
                                           dealer trust bonus/halving risk
   evaluateMenuChoice()  [market.ts]   ──► Joint Copula menu optimization against CompetitorMarketEstimator
   ActionOutbox.sendQuotesOnly()       ──► Fast-lane quote transmission (<= 20 per batch)

3. BUFFER OR BUNDLE (on order_won)
   Standard weekday D2D order with >= 480m slack (and no summer-tyre snow conflict)?
     ├─► Hold 22–75m (slack-adaptive) in pairingBufferUntil [desk.ts]
     ├─► Pair into 2-car corridor gig (0.58x–0.66x refSum, p2AlignedStart) [bundling.ts]
     └─► Extend open 2-car gig to 3-car corridor gig (0.56x refSum) if dh <= 32m & <= 440m road [bundling.ts]
   Otherwise:
     └─► Post solo gig with waking-hour clamped schedule (0.81x–1.32x typical fee) [dispatch.ts]

4. MATCH & NUDGE (while gig is open)
   gig_viewed / delivered ─► DirectOfferTracker [offers.ts]
     ├─► Chained driver finishing within 35 km: offer >= currentAppFee (0.88x–0.94x base)
     ├─► Active 1st-time viewer (<= 20m): immediate wake on bundles/home-return; nudge +3%..+9%
     └─► Repeat viewer (count >= 2, <= 25m): immediate wake + nudge +4%..+13% above current app fee

5. RECOVER & SETTLE (disruptions & end-of-week)
   ├─► Midnight flu burst (00:00–01:30 drops): tighten same-day intake & hold night-dropped bundles to 09:15
   ├─► forecast & active snow: rebuild open stop windows & advance summerTyres pickups past snow.to
   ├─► order_changed: rescale km fees, release <30% EVs rerouted >200 km OR solo routes shrunk >38% (>= €35 saved)
   ├─► driver_late / visit_failed / gig_expired: release or retry with corrected constraints & Rule-4 tier24PickCap
   └─► Final 42h rescue (Tue 04:00 -> Wed 22:00): guarantee 0.0% undelivered cars
```

---

## 2. Competitor Market Estimation & Surprise Detection (`src/estimator.ts`)

### 2.1 Log-Price Decomposition
In Spread, the competitor starts from the **unrounded** list price before whole-euro rounding:

$$\text{ULP}(\text{legs}, \text{opt}) = \left(\sum_{i} (2000 + 25 \cdot \text{km}_i)\right) \cdot m_{\text{legs}} \cdot m_{\text{opt}}$$

where $m_{\text{legs}} = 0.85$ for 2-leg trade-ins ($1.0$ otherwise), and $m_{\text{opt}} \in \{1.08, 1.00, 0.93\}$ for `same_day`, `next_day`, and `within_3_days`. Checked across 91,015 options in practice reveals, `Math.round(ULP / 100) * 100` matches `listPriceCents` with **0 rounding mismatches**.

RoutePulse models the competitor's latent `next_day` price $C_{\text{nd}}$ in log-space:

$$\ln C_{\text{nd}} = \ln \text{ULP}_{\text{nd}} + \alpha_{\text{pick}} + \alpha_{\text{deliv}} + \mu_{\text{world}} + \delta_{\text{day}} + \beta_{\text{km}} \ln\!\left(\frac{\text{km}}{105}\right) + \rho_{\text{dealer}} + \Delta_{\text{event}}$$

- **Town scarcity priors ($\alpha_{\text{pick}}, \alpha_{\text{deliv}}$):** Offline-fitted pickup and delivery town factors capturing structural return-trip difficulty (negative in Helsinki/Espoo/Vantaa `-0.058..-0.072`; strongly positive in northern sinks such as Rovaniemi `+0.118`, Kemi `+0.112`, and Kajaani `+0.106`).
- **Online world & day filtering ($\mu_{\text{world}}, \delta_{\text{day}}, \beta_{\text{km}}$):** Updated after every `order_won` ($y=1$) and `order_lost` ($y=0$) via Fisher-scoring natural-gradient steps, splitting precision updates between persistent world level (`45%`) and transient daily busyness (`55%`).
- **Dealer multiplier & retaliation ($\rho_{\text{dealer}}$):** Combines morning competitor retaliation (when we won most of a dealer's recent requests), dealer satisfaction recovery/decay (`-0.0405 * min(lateCount, 6)` with `-0.125` recovery per on-time delivery, `-0.0016 * min(unquotedCount, 20)`), and **Level-8 Dealer Trust** (`1 + 0.01 * trust`, up to `+25%`).

### 2.2 Unannounced Surprise Detectors & Non-Event Replay
At Levels 6–8, two unannounced competitor shocks occur during business hours (`08:00–18:00`):

| Hidden Event | Ground-Truth Mechanism | RoutePulse Online Detector (`estimator.ts`) | Estimator Action |
|---|---|---|---|
| **Regional Outage** (`08:00–18:00`, 80 km disc) | Dealers in one town + 80 km radius use a backup costing **~`+30%`** above normal | Outside-anchored per-town 80 km disc `llr` (`outDayOff` learned strictly outside the disc) with superset parsimony penalty (`llr - 0.55 * setSize`) | Activates `+\ln(1.30)` inside the 80 km disc, floors `effDayOffset = max(-0.03, dayLogOffset)` inside the disc so outside drift never erodes the windfall, and calls `replayNonEventQuotes()` excluding that disc |
| **Price War** (`08:00–18:00`, Level 8) | Competitor cuts prices **−20%** nationwide on one non-outage weekday | Morning-gated (`todayQuotes <= 65`) anchored full-day `todayFullPwLLR` testing $\Delta = \ln(0.80)$ + Monday midnight 6-step Newton-Raphson `estimateDayImpliedLog()` | Rolls back pre-trigger losses via `replayNonEventQuotes()`, applies $\ln(0.80)$ for `08:00–18:00`, blends Monday recovery (`0.65` prior / `0.35` implied), and verifies ambiguous Mondays at Tuesday quote 16 (`precision = 350`) |

---

## 3. Option Risk, Costing & Copula Menu Optimization (`src/market.ts`)

### 3.1 Feasibility & Late-Delivery Risk (`pLate`)
Before pricing an option, `computeOptionPlan()` (`src/planner.ts`) enforces all five car-handling rules:
1. **Manual gearbox (`notes.manualGearbox`):** Requires `audience.manualLicence = true`.
2. **Trade plates (`notes.needsPlates`):** Sets `withPlates = true` (`+30` min at pickup).
3. **EV range (`electric && chargePercent < 30 && km > 200`):** Sets `withCharging = true` (`+40` min).
4. **Premium car (`car.premium`):** Requires `audience.experienced = true` (modeled in `supply.ts` as `completedGigs >= 50 && rating >= 4.8`).
5. **Summer tyres in snow (`notes.summerTyres` + `forecast`):** Shifts pickup strictly outside snow windows (both at post time and dynamically in `tickTimers()` / `handleForecast()` if snow starts while unbooked).

For each feasible option, `evaluateOption()` computes a calibrated late-delivery probability $p_{\text{late}} = \sigma(\eta_{\text{late}})$ from:
- Local 30 km qualified driver pool $\ln(Q_{30} + 1)$ and destination 30 km return pool $\ln(D_{30} + 1)$ (using turnaround town `legs[0].delivery` on 2-leg `A -> B -> A` trade-ins),
- Lead hours $\ln(\text{leadHours})$, road hours above 4h, 2-leg trade-in complexity (`+0.60`, `+1.00` if `>= 220 km`), snow overlap, and same-day midnight flu,
- Open cluster backlog $\ln(\text{open}_{30} + 1)$, deadline-day utilization `dayLoad`, and northern/Arctic sink risk.

Hard safety gates decline zero-driver traps (e.g., `Q65 <= 3` on `> 450 km` trips with `< 36h` lead, or `pLate > maxAllowedPLate`, which tightens automatically from `0.135` down to `0.018` if on-time share ever approaches `91.2%`).

### 3.2 True Economic Cost & Dealer Trust Valuation
An order's effective cost combines four real dispatch effects:

$$\text{EffCost} = \underbrace{\text{ExpectedFee} + \text{SinkReturnCost} - \text{SynergyCredit}}_{\text{Direct & network driver cost}} + \underbrace{p_{\text{late}} \cdot \text{LateLoss}}_{\text{Refund + trust halving}} - \underbrace{(1 - p_{\text{late}}) \cdot \text{TrustGain}}_{\text{Compounding +1% tolerance}} + \underbrace{\text{ShadowCost}}_{\text{Driver capacity}}$$

- **Synergy credits:** Deducts `14%` of typical fee when one of our active drivers finishes within `35 km` of the pickup in time, and up to `12%` when an open, buffered, or same-minute partner order forms a round-trip corridor.
- **Dealer trust asymmetry (Level 8):** Delivering on time when `projTrust = trust + inFlight < 25` unlocks `+1%` higher prices on the dealer's remaining weekly requests (`TrustGain`), whereas a late delivery forfeits late refund **plus** telescoping $\lfloor \text{trust}/2 \rfloor$ percent across remaining wins (`LateLoss`). On VIP dealers (`estWeeklyReqs >= 55` or `trust >= 8`), RoutePulse also tightens `same_day` `maxAllowedPLate` so risky same-day options never halve high trust when `next_day` is available.
- **Hybrid slot shadow price & bundle-aware `paceRatio`:** Credits `0.55` saved driver-slots per active multi-car bundle in `desk.ts` before computing `paceRatio` against `baseTargetWeekly` (`0.44 * totalDrivers`, up to `475` driver-slots/week), preventing bundled volume from triggering phantom mid-week capacity throttling. Scales shadow cost by `(€5.20 + €1.35 * roadHours + 0.24 * typicalFee) * shadowMult`, with a higher capacity pool (`0.165 * totalDrivers`) on Next-Monday deadlines (`dlDay >= 7`).

### 3.3 Common-Provider-Shock Copula Menu Optimizer (`evaluateMenuChoice`)
When a request offers multiple speeds (`same_day`, `next_day`, `within_3_days`), the competitor's prices across options share the same latent draw $U \in [0, 1]$ (`tildeCNd * 1.08`, `tildeCNd * 1.00`, `tildeCNd * 0.93`).

`evaluateMenuChoice()` partitions $U \in [0, 1]$ into exact sub-intervals bounded by the marginal win thresholds $(p_{\text{sd}}, p_{\text{nd}}, p_{\text{3d}})$ and integrates the dealer's speed-vs-price logistic choice inside each interval. Coordinate ascent over the joint menu:
- Enforces a `1.12x` speed spread (`pSd >= 1.12 * pNd`) on Monday–Wednesday so `same_day` never cannibalizes higher-margin `next_day` quotes,
- Relaxes that spread on **Thursday requests** (`dlWd = 3` vs `4`) when Friday deadlines are congested, and
- Quotes attractive `within_3_days` prices on Thursday/Friday requests to shift volume onto Next Monday (`dlDay = 7`).

---

## 4. Corridor Bundling, Fee Schedules & Direct Offers

### 4.1 2-Car and 3-Car Corridor Bundler (`src/bundling.ts`)
- **Pairing buffer:** Weekday dealer-to-dealer orders (including `premium` cars in hubs with `>= 24` experienced drivers) with `>= 8h` slack and no summer-tyre snow conflict wait `22–75` minutes in `pairingBufferUntil` so arriving reverse-leg or corridor cars can pair before hitting the app board.
- **2-car bundles (`evaluateOrderedBundle`):** Pairs two 1-leg orders (including dense-hub `premium` cars and qualified `leg2` private deliveries) with inter-order deadhead `dh <= 50` road min, `p2AlignedStart` timing alignment, and total driving `<= 675` min. High-slack (`>= 8h`) standard Tier-1 closed loops open at **`0.53x`** combined typical fee (`0.58x` under tighter slack); Tier-2 corridors open at **`0.61x`** (`0.66x` under tighter slack).
- **Backward pickup-window cap (`maxP1ForP2`):** Propagates Order 2's latest pickup time backward onto Stop 0's `window.to`:
  $$\text{maxP1ForP2} = \text{effectiveLastPickup}_2 - \text{drive}_{\text{dh}} - 15 - \text{drive}_1 - \text{extra}_1 - 15$$
  This guarantees a driver cannot collect Order 1 late in the afternoon and arrive at Order 2's yard after `18:00` closing.
- **3-car corridor extension (`tryExtendTwoToThreeOrderBundle`):** Extends an open 2-car bundle to 3 cars (`0.56x` combined typical fee) when `totalDrivers >= 760` (no flu), link deadheads are `<= 32` min, total road time is `<= 440` min, and `>= 300` min slack remains. If a 3-car bundle reaches `splitAt` unbooked, `splitOpenBundle()` steps down cleanly to the 2-car pair rather than shattering all 3 cars into solo gigs.

### 4.2 Waking-Hour Monotonic Fee Schedules & Early Discovery (`src/dispatch.ts`, `src/time.ts`)
- **High-slack Step-0 price discovery:** When a solo gig has `>= 7h` slack in a liquid town (`Q30 >= 15`, no snow or same-day flu), `buildSingleGigSchedule()` prepends a 2-step 88-minute discovery prefix starting `0.045x–0.08x` below `m0` (down to **`0.72x`** typical fee), capturing willing local/home-return drivers cheaply before seamlessly rejoining `m0`.
- **Notification blackout clamp (`clampOutOfNight`):** Because no driver reads notifications between `23:00` and `07:00`, `buildMonotonicClampedSteps()` shifts nighttime escalation steps to `07:05+` with `>= 20` min spacing. Drivers waking at `07:00` see our disciplined opening fee rather than a pre-escalated `1.30x` fee, keeping long-run driver fee expectations low.
- **Rule-4 `< 24h` (`25%`) vs `> 24h` (`50%`) late-refund cliff & 42h rescue:** If a non-private order passes `lastPickupAt` mid-week (`> 42h` before `endsAt`), on-time delivery is already impossible and next-day daytime delivery pays the same `25%` (`< 24h`) refund tier as an overnight gate drop; RoutePulse withdraws the stale gig, caps pickup by `tier24PickCap` (`order.deadline + 24h`), and paces calm daytime steps (`1.05x..1.85x`) instead of burning `2.42x` overnight fees. Only in the final **42 hours** before `endsAt` (Tuesday `04:00` to Wednesday `22:00`) does `endWorldRescue` escalate up to `2.95x` (capped below the economic ceiling), guaranteeing **`0.0%` undelivered**.

### 4.3 Live-Session Direct Offers (`src/offers.ts`)
`DirectOfferTracker` respects Spread's `<= 3` offers/driver/day and `<= 3` simultaneous open offers/gig limits:
1. **Zero-deadhead chain offers (`>= currentAppFee`, `0.88x–0.94x` base):** Immediately upon `delivered`, wakes open gigs within `35 km` and sends an offer (never below visible board fee) to the arriving driver before they buy a train/bus ticket home.
2. **Active viewer conversion (`+3%..+13%`) & quota discipline:** Enforces a strict live-session horizon (`<= 20` min for viewers, `<= 35` min cold, `<= 90` min urgent/scarce), skips cold offers on high-slack dense-hub solos (`pool30 >= 45`), and reserves each driver's 3rd daily slot for urgent gigs, bundles, repeat viewers, or home-return viewers. First-time viewers (`<= 20` min) receive `+3%..+9%` above `currentAppFeeCents` (with immediate wake on bundles and home-return matches); repeat viewers (`count >= 2`, `<= 25` min) trigger an immediate offer pass at `+4%..+13%`.

---

## 5. Trilingual Dealer Note Reader (`src/notes.ts`)

`parseDealerNote()` processes Finnish, Swedish, and English notes in four deterministic stages:
1. **Clause splitting & correction merging:** Splits sentences while binding trailing correction clauses (`Korjaus: ...`, `Correction: ...`, `Rättelse: ...`) to the preceding clause via `__CORR__`.
2. **Protected negation & contrast stripping:** Strips negated times (`ei klo 12, vaan klo 15` -> `klo 15`; `(not Tuesday)`) while preserving `"not before"` / `"ei ennen"` / `"inte förrän"` readiness floors, even with typos (`"not befoer"`).
3. **Boolean equipment & tyre detection:** Detects `manualGearbox`, `needsPlates`, and `summerTyres` (including rubber colloquialisms `kesäkumit` / `sommargummi` and negated winter swaps `talvirenkaita ei vielä vaihdettu`), while ignoring spare tyres in the boot (`kontissa`, `mukaan`, `i bilen`).
4. **Inflected day & clock resolution:** Resolves 2-to-6-day weekday rules, `ylihuomenna` / `övermorgon`, exact-before-fuzzy Finnish word-hour stems (`yhdestä` = `13:00` vs `yhdeksästä` = `09:00`, `kahdeltatoista` = `12:00`), half-hours (`puoli kolmeen` = `14:30`, `halv tre` = `14:30`), payment releases (`releasedAt`), tighter deadlines (`noteDeadline`), and narrowed pickup/delivery opening hours.

---

## 6. Live `--final` & Disruption Engineering (`src/starter.ts`, `src/rejoin.ts`, `src/outbox.ts`)

| Failure / Live-Clock Risk | Mitigation Implemented |
|---|---|
| **4.5-second `respondBy` deadline during 40-car bulk bursts** | Background WebSocket reader pushes into an in-memory queue; `playFinal()` coalesces 6 ms micro-batches and flushes `quote` actions first via `sendQuotesOnly()` (`<= 20` per call) before running timer/offer passes |
| **`20 actions/sec` (`50` burst) `final-actions` token limit** | `Bucket` (`spread.ts`) caps tracked burst tokens at `50`; non-urgent direct offers throttle to `<= 4` per cycle (`>= 220 ms` spacing) in `--final`, preserving `>= 30` burst tokens for instant bulk quotes |
| **Same-minute `[revenue, late_refund]` ledger ordering** | `finalizePendingRevenue(now - 1)` waits one world minute before crediting +1 dealer trust, and `markLateOrPenalized()` rolls back trust if a retroactive `late_refund` arrives |
| **`order_changed` EV charging flip or `> 38%` route shrink** | Checks booked gigs before `gig_started`: releases & reposts if `needsCharging` flips to `true` (avoiding the `€100` EV fine) OR if a solo route shrinks `< 0.62x` with `>= 8h` slack and `>= €35` net savings |
| **Multi-day `forecast` & `summerTyres` snow rollover** | Rebuilds open solo stop windows immediately on `forecast`, and withdraws/reposts open `summerTyres` gigs in `tickTimers()` if active snow begins so `window.from` advances past `snow.to` (preventing `visit_failed: not_ready`) |
| **Process restart or `502/503/504` server restart** | `playFinal()` brackets `snapshot()` with `events()` + `events(seq0)`, rebuilds full state via `rejoinDeskState()`, deduplicates stream events by `lastSeq`, and backfills gaps via `GET /events?after=lastSeq` if idle clock advances |
| **Accidental `Ctrl-C` during `--board` ranking run** | Never calls `world.delete()` on ranking runs (which would run the week unattended to the end); pauses cleanly and auto-resumes unfinished `boardRun` worlds on the next `--board` invocation |
