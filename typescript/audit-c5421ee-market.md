# Quantitative Pricing, Market-Estimation & Portfolio-Admission Audit (`typescript/market.ts` @ `c5421ee`)

**Target File:** `/home/Corgi/RoutePulse/typescript/market.ts` (910 lines, commit `c5421ee`)  
**Cross-Referenced Code:** `typescript/starter.ts` (`lines 295–411, 588–635, 1495–1580`), `typescript/planner.ts` (`lines 174–354`)  
**Empirical Evidence Base:**
- Benchmark logs: `results/2026-11-14-omni-v4-*.log` (`c5421ee`) vs. `results/2026-11-14-friend-*.log` (`8d69968`, commit `34426ef`), `results/2026-11-14-v4/v5/v6/verified-v6b-*.log` (`4ec0232`), `results/2026-11-14-hybrid-v2/v3-*.log`, and `results/2026-11-14-69k-cfg7-*.log`.
- Local Level-8 reveal datasets (`4,142` requests, `4,222` legs, `20` weekday streams across `reveal-baseline-spread-1` and `reveal-study-a/b/c`).

---

## 0. Executive Summary & Benchmark Attribution (`omni-v4` vs. `friend`)

### 0.1 Side-by-Side Benchmark Decomposition

| Seed | `friend` (`8d69968`) Margin (Ord / OT / Rev/o) | `omni-v4` (`c5421ee`) Margin (Ord / OT / Rev/o) | $\Delta$ Margin (`omni-v4 - friend`) | `cfg7` / `v5` Peak Rev/o Benchmark | Key Regime / Bottleneck Identified from Daily Trajectories |
|---|---:|---:|---:|---:|---|
| `paired-variant-1` | €11,385.78 *(353 / 98.3% / €91.96)* | **€11,609.65** *(360 / 98.3% / €94.68)* | **+€223.87** | `cfg7`: €101.15/o | **Monday Price War** (`cfg7` won 5 on Mon; `omni-v4` won 64). Pre-trigger drift double-discounts Mon PW by `-15%`. |
| `opportunity-compare-1` | **€14,953.94** *(337 / 97.0% / €110.26)* | €14,069.41 *(340 / 95.6% / €111.45)* | **-€884.53** | `friend`: €44.37 mar/o | **Severe shortage (~644 drv) + Tuesday PW** (`[90, 42, 72, 67, 69]`). Over-admits 340 vs 270 target; `equalMargin3d` dumps onto Fri. |
| `quant-compare-1` | €14,437.12 *(423 / 94.3% / €105.94)* | **€17,072.75** *(425 / 97.2% / €107.30)* | **+€2,635.63** | `cfg7`: €113.84/o | High-volume world; `deadline_close` fix slashed late fees (`cost/o`: €71.80 $\to$ €67.13), but `rev/o` still **-€6.54/o** below `cfg7`. |
| `panel-compare-1` | €18,431.72 *(437 / 97.5% / €103.07)* | **€20,894.45** *(460 / 98.9% / €105.75)* | **+€2,462.73** | `cfg7`: €114.99/o | **Surplus roster (~900+ drv)**: wins **460 orders** (`126%` of `365` cap) at `98.9%` OT, yet leaves **€9.24/order (~€4.2k)** top-line margin unharvested. |
| `experiment-route-fee` | €17,722.32 *(446 / 95.3% / €110.09)* | **€18,716.76** *(458 / 96.9% / €111.36)* | **+€994.44** | `hybrid-v3`: €19,042.98 | `hybrid-v3` (`8d69968` market + `deadline_close` guard) beat `omni-v4` by **+€326.22** before `c5421ee`'s `equalMargin3d` / `antiRetalShadow` edits. |
| **5-Seed Total** | **€76,930.88** *(1,996 ord)* | **€82,363.02** *(2,043 ord)* | **+€5,432.14** | — | Dispatch fixes drove `+€6.3k`; `c5421ee` market edits leaked `-€885` on `opportunity-compare-1` and `-€326` vs `hybrid-v3` on `experiment-route-fee`. |
| `spread-1` *(check)* | **€14,861.08** *(424 / 96.9% / €89.81)* | €13,613.74 *(418 / 95.9% / €89.63)* | **-€1,247.34** | `v5`: **€15,664.12** *(€95.66/o)* | `4ec0232`/`v5` per-slot shadow pricing extracted **+€6.03/o (+€2,903 rev)** on the same 422 orders; `c5421ee` reverted it to `refFee * shadowMult`. |

### 0.2 Top 6 Highest-EV Margin Upgrades Identified in `market.ts`

| Priority | Mechanism & File:Line Reference | Root Defect in `c5421ee` | Estimated Weekly EV Impact |
|---|---|---|---:|
| **P1** | **Per-Driver-Slot Shadow Cost + Uncapped `targetWeekly` + Kink-Breaking `surplusFrac`** (`market.ts:59, 671–692, 757–763`) | `winProbability` has a slope kink at $x=0$ ($9.8 \to 13.0$) that traps quotes at $\le 1.00 \times \text{targetScale}$ whenever $E/C_0 \le 0.846$. `surplusFrac` caps at `0.50` and `refShadowCents` scales with `referenceFeeCents` (`€16.68` on $<45\text{km}$!), under-pricing short hops and winning 125% of target in both 644-drv shortages and 930-drv surpluses. | **+€1,100 to +€1,950 / wk** |
| **P2** | **Two-Sample Outside-Anchored 80km Outage Detector + Pre-Detection State Rollback** (`market.ts:272, 390–400, 420–454, 475–488`) | Uusimaa (`52%–58%` of all Finland requests) inflates `dayLogOffset` & `worldLogMean` before `nIn=8`, masking its own `+30%` outage (`14%–18%` miss rate); regional centers (`oulu`, `jyvaskyla`, `vaasa`) have `0%–8%` detection due to `nIn >= 8` & `meanIn >= 0.24`; unconfirmed Day-0 false alarms lock `outageUsedThisWeek = true` (`line 272`) for the whole week. | **+€650 to +€1,400 / wk** |
| **P3** | **Monday Price-War Rollover Fix & Event-Trigger Drift Rollback** (`market.ts:258–272, 407–418, 476–488`) | Pre-trigger losses (`quotes 1..16`) drag `worldLogMean + dayLogOffset` down `-15%`, which is **not** rolled back when `priceWarToday` adds `log(0.80)` (`0.68x` vs `0.80x`!). Then `onNewDay` (`line 258`) lacks `!this.priceWarToday` before `line 271`, adding `+0.223` onto a half-dropped state and overshooting Tuesday `worldLogMean` up to `1.54x`. | **+€450 to +€1,100 / wk** |
| **P4** | **VIP Franchise Protection (`lateCount` + `trust` Halving) & Count-Based Trust Harvesting** (`market.ts:295–302, 614–620, 664–667, 693–711`) | `D01–D04` generate `57.9%` of all weekly requests (`599/wk`). One Wednesday late delivery on `D01` costs **€388.87** (`€103.74` trust halving + `€285.13` permanent `-3.97%` `lateCount` satisfaction hit across 63 remaining wins), yet `trustLossPenaltyCents` is `€0` at `trust < 4` and max `€40`. Meanwhile `trustBonusCents` is clamped to `€0` on cheap Monday metro hops by `0.78 * refFee` (`line 709`). | **+€550 to +€1,050 / wk** |
| **P5** | **Eliminate `equalMargin3d` Cannibalization & Optimize Joint `(same_day, next_day)` Menu Diversion** (`market.ts:364–370, 857–885`) | `equalMargin3d` (`lines 878–880`) contains an algebraic tautology (`-150 >= -200`) that quotes `within_3_days` on ~100% of co-offered requests at `€2–€4.50` below `next_day` on identical `referenceFeeCents`, delaying trust by 48h, dumping `56` orders/wk onto Friday `dlDay=4`, and biasing `onQuoteResolved` upward. | **+€450 to +€850 / wk** |
| **P6** | **`dlDay === 7` Multi-Day Capacity Fix & 2-Leg Trade-In `sameCluster30` / `logLaneFactor` Fix** (`market.ts:50–55, 560–566, 578–599`) | Next Monday (`dlDay = 7`) receives `408` option-offers/wk across 4 execution days (Thu–Mon, with 0 new Mon arrivals) yet gets throttled by a 1-day `dayCap = 0.096 * N`. Also `91.2%` of 2-leg trade-ins are round-trips (`A -> B -> A`), triggering a false `+0.75` `sameCluster30` logit penalty (`line 599`) and hiding `B`'s `PLACE_ALPHA_DELIV`. | **+€350 to +€700 / wk** |

---

## 1. Deep Audit of `CompetitorMarketEstimator` (`market.ts:190–499`)

### 1.1 `worldLogMean` Prior (`log(1.42)`), Precision Lock-In, and Plug-In Uncertainty Bias (`market.ts:219–224, 481–487`)

- **Current Code (`market.ts:219–224, 481–487`):**
  ```ts
  this.worldLogMean = Math.log(1.42)
  this.minWorldLog = Math.log(1.24)
  this.maxWorldLog = Math.log(1.58)
  this.worldPrecision = 1 / (0.065 ** 2) // 236.69
  ...
  this.worldPrecision += 0.45 * info
  ```
- **Quantitative Critique:**
  1. **Upward Prior Bias vs. Asymmetric Sigmoid Cliff:** Per `HANDBOOK.md` and `RULES.md`, the Level-8 world price multiplier is drawn on $[1.26, 1.54]$, whose log-uniform expectation is $\frac{1}{0.28}\int_{1.26}^{1.54}\ln(u)\,du = 0.3340 = \ln(1.3965)$ with standard deviation $\sigma_W = 0.0578$ ($\text{precision} \approx 299$). Starting at $\ln(1.42) = 0.3507$ ($+1.7\%$ above the prior mean) pushes early Monday quotes onto the **steep upper branch** of `winProbability(x)` ($s_1 = 13.0$ for $x \ge 0$ vs. $9.8$ for $x < 0$, `market.ts:59`). In a `1.30x–1.35x` world (like `spread-1` or `paired-variant-1`), over-quoting by $+0.07$ slashes Monday morning conversion by $\sim 45\%$, sacrificing early `same_day` deliveries that would have compounded $+1\%$ Dealer Trust across Tuesday–Friday.
  2. **Premature `worldPrecision` Cementing:** Near optimal quotes ($E/C_0 \in [0.75, 0.92]$), Fisher information per resolved quote (`market.ts:473`) is $\text{info} \in [23.7, 42.2]$ (mean $\approx 26$). Accumulating `worldPrecision += 0.45 * info` raises `worldPrecision` from $237$ to $\approx \mathbf{2,100}$ by Monday 18:00 (~160 quotes), while `dayPrecision` resets every morning (`line 276`) to $1/0.055^2 = 330.6$. By Tuesday, `shareW = vW / (vW + vD)` (`line 479`) collapses to $\mathbf{13.6\%}$, and by Wednesday to $\mathbf{7.8\%}$. Any Monday estimation bias (from an unrolled-back Price War, Uusimaa Outage, or `zKm` drift) becomes permanently locked in for the rest of the week.
  3. **Certainty-Equivalence Overconfidence on Monday Morning:** On quotes `1..25`, predictive log-price variance $V_{\text{pred}} = \text{worldPrecision}^{-1} + \text{dayPrecision}^{-1} = 0.060^2 + 0.055^2 = 0.00663$ ($\sigma_{\text{pred}} = 0.0814$). Convolving `winProbability(x - \epsilon)` over $\epsilon \sim \mathcal{N}(0, \sigma_{\text{pred}}^2)$ flattens the effective slope by $\sqrt{1 + (11\sigma_{\text{pred}})^2} = \mathbf{1.34}$. Plugging in $\sigma_{\text{pred}} = 0$ biases both Monday `optimizeOptionPrice` and early LLR residuals.

- **Formula-Level Fix:**
  - Initialize Level-8 prior at the exact Bayes-optimal point (`market.ts:220–223`):
    ```ts
    this.worldLogMean = Math.log(1.395) // 0.3329: log-uniform mean 1.3965 minus asymmetric cliff nudge
    this.minWorldLog = Math.log(1.25)
    this.maxWorldLog = Math.log(1.56)
    this.worldPrecision = 1 / (0.058 ** 2) // 297.3
    ```
  - Cap `worldPrecision` (or apply overnight process noise in `onNewDay` at `market.ts:276`) so `worldLogMean` retains adaptability on Tue–Fri:
    ```ts
    // In onNewDay (market.ts:276): cap effective precision at 1100 (sigma >= 0.030) so shareW >= 23%
    this.worldPrecision = Math.min(1100, this.worldPrecision * 0.92)
    ```
  - In `predictOption` (`market.ts:350–352`), integrate predictive uncertainty via 3-point Gauss-Hermite quadrature ($\pm\sqrt{3}\sigma_{\text{pred}}$ with weights $\frac{1}{6}, \frac{2}{3}, \frac{1}{6}$):
    ```ts
    const varPred = 1 / this.worldPrecision + 1 / this.dayPrecision + (zKm * zKm) / this.distanceSlopeInfo + 1 / d.obsInfo
    const step = Math.sqrt(3 * Math.min(0.012, varPred))
    const p0 = winProbability(x, params.fasterOptionUnquoted).p
    const pLo = winProbability(x - step, params.fasterOptionUnquoted).p
    const pHi = winProbability(x + step, params.fasterOptionUnquoted).p
    const p = (4 * p0 + pLo + pHi) / 6
    ```

---

### 1.2 `dayLogOffset`, Non-Zero-Mean `distanceSlope`, and 2-Leg Trade-In `logLaneFactor` (`market.ts:38–56, 198–202, 277–278, 477–494`)

- **Quantitative Critique:**
  1. **`centeredLogKm` Is Off-Center by $+0.388$ Log-Units (`market.ts:38–41`):** Across all `4,142` requests in the 4 reveal worlds, `zKm = Math.log(totalKm / 105)` has **$\mathbb{E}[z_{\text{km}}] = +0.388$** ($\text{Var}(z_{\text{km}}) = 0.957$, geometric mean distance $= \mathbf{154.8\text{ km}}$, not `105 km`). Because `market.ts:481–494` performs diagonal gradient updates without subtracting $\text{Cov}(1, z_{\text{km}}) = +0.388$, every global residual (`grad`) induces a spurious drift $\mathbb{E}[\text{grad} \cdot z_{\text{km}}] = +0.388\,\mathbb{E}[\text{grad}]$ in `distanceSlope`, and mid-week competitor slope tilts (`HANDBOOK.md`: *"These moves do not change its prices on average"*) pivot around `~155 km`, shifting `dayLogOffset` when centered at `105 km`.
  2. **`distanceSlopeInfo` Is 3x Too Stiff for Mid-Week Regime Shifts (`market.ts:201–202, 278, 490–493`):** Starting at `distanceSlopeInfo = 90` and accumulating $\sum \text{info}\cdot z_{\text{km}}^2 \approx 160 \times 26 \times 0.96 \approx 4,000/\text{day}$, `Math.max(70, this.distanceSlopeInfo * 0.55)` (`line 278`) enters Wednesday/Thursday with `distanceSlopeInfo` $\approx \mathbf{2,500–3,500}$! When the competitor flips its distance tilt once per week (e.g., $-0.05 \to +0.05$), a whole day of quotes shifts `distanceSlope` by less than $0.03$, mispricing both $<45\text{km}$ and $>250\text{km}$ lanes all day.
  3. **2-Leg Trade-In Round-Trip Bug in `logLaneFactor` (`market.ts:50–51, 375–376`):** Across all 80 trade-in requests in the 4 reveal datasets (`20.0/week`), **73/80 (91.2%) are round-trips** (`Dealer A -> Customer B -> Dealer A`, e.g., `R00053`: `oulu -> tampere -> oulu`, `971 km`). `market.ts:375–376` sets `deliveryId = req.legs[req.legs.length - 1]!.delivery.placeId` (`A`), ignoring turnaround place `B` completely (`helsinki -> rovaniemi -> helsinki` gets `PLACE_ALPHA_DELIV["helsinki"] = -0.072` instead of reflecting `rovaniemi = +0.118`!).

- **Formula-Level Fix:**
  1. Center `centeredLogKm` (`market.ts:40`) at the empirical geometric mean `155 km`:
     ```ts
     export function centeredLogKm(legRoadKms: readonly number[]): number {
       const totalKm = Math.max(12, legRoadKms.reduce((a, b) => a + b, 0))
       return Math.log(totalKm / 155)
     }
     ```
  2. Cap overnight `distanceSlopeInfo` retention (`market.ts:202, 278`) so a mid-week tilt adapts within ~25 morning quotes:
     ```ts
     // Constructor (line 202):
     distanceSlope = -0.035
     distanceSlopeInfo = 35
     // onNewDay (line 278):
     this.distanceSlopeInfo = Math.max(30, Math.min(180, this.distanceSlopeInfo * 0.25))
     ```
  3. Fix `logLaneFactor` (`market.ts:43–56`) to pass `turnaroundPlaceId?: string` when `legs.length === 2` (`0.5 * PLACE_ALPHA_DELIV[leg0.delivery] + 0.5 * PLACE_ALPHA_DELIV[leg1.delivery]`).

---

### 1.3 `onNewDay` Monday Price-War Recovery Bug & Pre-Trigger Drift Double-Counting (`market.ts:258–272, 336–344, 413–417, 476–488`)

- **Current Code (`market.ts:258–272`):**
  ```ts
  if (
    this.level === 8 &&
    this.currentDay === 0 &&
    !this.priceWarUsedThisWeek &&
    this.todayQuotes >= 15 &&
    (Math.exp(this.worldLogMean + this.dayLogOffset) < 1.24 || this.dayLogOffset <= -0.095)
  ) {
    this.priceWarUsedThisWeek = true
    this.worldLogMean = Math.min(
      this.maxWorldLog,
      Math.max(this.minWorldLog, this.worldLogMean + this.dayLogOffset - Math.log(0.80)),
    )
  }
  if (this.priceWarToday) this.priceWarUsedThisWeek = true
  ```
- **Exact Defect Proof & Monte Carlo Verification:**
  There are **two severe compounding bugs** whenever a Price War occurs (especially on Monday, as in `paired-variant-1`):
  1. **Intraday Double-Counting (`-15.0%` Error After Detection on Any Day Mon–Fri):** During quotes `1..16` *before* `this.priceWarToday` flips `true` at `line 414`, `if (!this.priceWarToday)` (`line 476`) is `true`! Those 16–20 consecutive losses drag `worldLogMean` down by $\approx -0.07$ (`shareW = 0.583` on Mon!) and `dayLogOffset` down by $\approx -0.095$. When `this.priceWarToday = true` triggers at `line 414`, **neither `dayLogOffset` nor today's drift in `worldLogMean` is rolled back**! For the entire rest of the day (`10:15–18:00`), `predictOption` (`line 336`) computes `worldLogMean + dayLogOffset + Math.log(0.80)` — **stacking `-0.223` on top of the `-0.163` pre-trigger drift**. Across 50 Monte Carlo trials on `study-b` (`true_world = 1.360`, true Monday PW multiplier $= 1.088$), `c5421ee` predicts a mean Monday PW multiplier of **`0.924` (`-15.0%` too low!)**.
  2. **Tuesday Morning Over-Recovery Bug (`line 271` Ordered After `line 261`):** Notice that `if (this.priceWarToday) this.priceWarUsedThisWeek = true` (`line 271`) executes **after** `line 261`, and `line 261` omits `!this.priceWarToday`! When `priceWarToday` *did* trigger at quote 18 on Monday, `if (!this.priceWarToday)` froze `worldLogMean + dayLogOffset` mid-fall (at e.g. $0.285 - 0.098 = 0.187$, where `dayLogOffset <= -0.095` is `true`!). On Tuesday morning, `line 268` adds the **full** $-\ln(0.80) = +0.2231$ onto that half-dropped state, catapulting Tuesday's `worldLogMean` up to $\exp(0.410) = \mathbf{1.507\times}$ in a `1.360x` world (Monte Carlo max: **`1.542x`**!). Conversely, if `dayLogOffset` froze at `-0.088` and $\exp(\text{worldLogMean} + \text{dayLogOffset}) = 1.25$, `line 258` does **not** fire and `worldLogMean` remains permanently poisoned `-7%` too low (`1.303x`) for the rest of the week!

- **Formula-Level Fix (`market.ts:204, 255–285, 413–418`):**
  Snapshot `dayStartWorldLogMean`, `dayStartWorldPrecision`, and `dayStartDistanceSlope` at the start of each day in `onNewDay`:
  1. **When `this.priceWarToday = true` triggers (`market.ts:414`):** Immediately roll back pre-detection contamination so `Math.log(0.80)` applies to the clean baseline:
     ```ts
     this.priceWarToday = true
     this.worldLogMean = this.dayStartWorldLogMean
     this.worldPrecision = this.dayStartWorldPrecision
     this.distanceSlope = this.dayStartDistanceSlope
     this.distanceSlopeInfo = this.dayStartDistanceSlopeInfo
     this.dayLogOffset = 0
     this.dayPrecision = 1 / (0.055 ** 2)
     ```
  2. **In `onNewDay` (`market.ts:258–272`):** Update `priceWarUsedThisWeek` from `this.priceWarToday` **first**, and run the fallback recovery **only** when `!this.priceWarToday` (`unflagged` Monday Price War where `worldLogMean + dayLogOffset` absorbed the full day's `-0.223` shift):
     ```ts
     if (this.priceWarToday) {
       this.priceWarUsedThisWeek = true
     } else if (
       this.level === 8 &&
       this.currentDay === 0 &&
       !this.priceWarUsedThisWeek &&
       this.todayQuotes >= 15 &&
       this.dayLogOffset <= -0.105 &&
       Math.exp(this.worldLogMean + this.dayLogOffset) < 1.22
     ) {
       this.priceWarUsedThisWeek = true
       this.worldLogMean = Math.min(
         this.maxWorldLog,
         Math.max(this.minWorldLog, this.worldLogMean + this.dayLogOffset - Math.log(0.80)),
       )
     }
     ```

---

### 1.4 `priceWarToday` LLR Threshold & Multi-Option Evaluation Bias in `onQuoteResolved` (`market.ts:364–370, 407–418`)

- **Quantitative Critique:**
  1. **Self-Weakening `todayPwLLR` Before Quote 16 (`market.ts:390–414`):** Because `xBase` uses the drifting `this.worldLogMean + this.dayLogOffset`, by quote 12 of a Price War `baseLogC` has already fallen by `-0.12`, so `xBase - Math.log(0.80)` tests a `-32%` drop instead of `-20%`, attenuating `llPw - llBase` and delaying trigger until quote `16–22` (`~10:00–10:30`). Evaluating `pw` against anchored `dayStartWorldLogMean` allows lowering the gate safely from `todayQuotes >= 16, todayPwLLR >= 3.8, meanRes <= -0.24` to **`todayQuotes >= 13, todayPwLLR >= 3.5, meanRes <= -0.21`**, saving 4–7 wasted morning quotes.
  2. **Systematic Upward Bias from `evalOpt = wonOption ?? ...` (`market.ts:364–370, 397–399`):**
     Look at how `onQuoteResolved` selects `evalOpt`:
     - On a **loss** (`wonOption === null`), `evalOpt` selects the option with the **lowest** `price / ulp` (always `next_day`, ratio $r_{\text{nd}}$).
     - On a **win** (`wonOption !== null`), `y = 1` represents winning *any* option on our menu, yet when `wonOption === "same_day"`, `evalOpt` uses `sdPrice` ($\ge 1.13 \cdot P_{\text{nd}}$, so $r_{\text{sd}} = \frac{1.13}{1.08}r_{\text{nd}} = \mathbf{1.0463\,r_{\text{nd}}}$!), and when `wonOption === "within_3_days"` under `equalMargin3d`, `evalOpt` uses `capped3d` ($\approx \frac{0.97}{0.93}r_{\text{nd}} = \mathbf{1.043\,r_{\text{nd}}}$!).
     - Evaluating $y=1$ against the higher ratio $r_{\text{sd}}$ or $r_{\text{3d}}$ understates `base.p` (e.g., `0.24` instead of menu win probability `0.46`), injecting a fake $+0.22$ positive residual into `worldLogMean`, `dayLogOffset`, **and** `distanceSlope` (since `same_day` only exists on shorter routes where $z_{\text{km}} < 0$, systematically dragging `distanceSlope` negative!).

- **Formula-Level Fix (`market.ts:364–374`):**
  Always evaluate `onQuoteResolved` at the **menu's primary reference option** (the minimum-ratio competitive option $o^* = \arg\min_{o \in \text{competitiveOptions}} \text{prices}[o] / \text{ulp}(o)$, with `fasterOptionUnquoted` reflecting whether a faster offered option was omitted or priced above $+10\%$ relative to `ulp`):
  ```ts
  // Evaluate menu win/loss (y in {0,1}) against a consistent option-invariant log-ratio xMenu:
  const minRatioOpt = meta.competitiveOptions.reduce((best, cur) => {
    const rBest = (meta.prices[best] ?? Infinity) / unroundedListPriceCents(meta.legRoadKms, best)
    const rCur = (meta.prices[cur] ?? Infinity) / unroundedListPriceCents(meta.legRoadKms, cur)
    return rCur < rBest ? cur : best
  }, meta.competitiveOptions[0]!)
  const evalOpt = minRatioOpt // Do NOT switch to wonOption when wonOption had an intentional menu surcharge!
  ```

---

### 1.5 `outageCenterToday` 80km LLR Detector: Why `+30%` Outages Are Delayed or Missed (`market.ts:272, 420–454, 475–488`)

Empirical simulation of `c5421ee` across the 4 reveal worlds (`20` world-days) exposes **four compounding failure modes**:

1. **Uusimaa Self-Masking (`51.8%–57.6%` of All Finland Requests!):**
   Across all 20 world-days, the 80km disks around `porvoo` (`115.5` in-hours reqs/day, `57.6%`), `hyvinkaa` (`114.8`/day, `57.2%`), and `helsinki`/`espoo`/`vantaa` (`103.6`/day, `51.8%`) generate **over half of all national traffic** (`HANDBOOK.md`: *"busy regions go down more often"*). Before `outageCenterToday` triggers (`nIn < 8`), `inOutageRegion` (`line 475`) is `false`, so Uusimaa wins push `dayLogOffset` up to $+0.09..+0.14$ and `worldLogMean` up by $+0.04..+0.07$. Because `c5421ee` (`line 422`) evaluates `outP` and `resBase` from `xBase` (**including** `dayLogOffset`, reverting `4ec0232`'s `noDayLogC` fix!), Uusimaa's own wins inflate `base.p`, compressing `meanIn` below `0.24` and **missing `14%–18%` of Helsinki/Hyvinkää outages outright**! Even when detected, the pre-trigger `+0.12` drift in `dayLogOffset` is **never rolled back**, over-pricing the rest of Finland by `+12%` all day and double-counting `+12%` on top of `log(1.30)` inside Uusimaa!
2. **Sample-Size Starvation (`st.nIn >= 8`, `line 448`) on Medium & Regional Centers:**
   Across the 20 reveal days, median in-hours total requests within 80km are:
   - `tampere` / `lempaala`: median **`18`/day** (~14 competitively quoted $\implies$ `nIn = 8` is not reached until **`12:56–13:15`**, losing half the outage day!).
   - `turku` / `salo` / `raisio`: median **`16–17`/day** (`nIn = 8` reached at **`13:50–16:15`**, losing 60–80% of the outage day!).
   - `oulu` (med **`8`/day**), `jyvaskyla` (med **`6`/day**), `vaasa`/`seinajoki` (med **`6`/day**), `pori` (med **`5`/day**), `kuopio` (med **`4`/day**): after ~20% safety rejections (`line 362`), `st.nIn` **almost never reaches `8` (`0%–8%` detection rate in `c5421ee`)**!
3. **High-Shadow-Price Residual Veto (`meanIn >= 0.24`, `line 448`):**
   When `refShadowCents` + `surplusShadow` push a quote to `base.p = 0.02` (e.g., `hyvinkaa` deficit pickup or afternoon `paceRatio > 1.0`), a `+30%` outage lifts `outP.p` to `0.28`. Winning `2` of `8` quotes produces an overwhelming `LLR = +4.11 > 3.6`, yet `meanIn = (2 - 0.16)/8 = 0.230 < 0.24` **vetoes detection**.
4. **Irreversible False-Alarm Lockout (`line 272`):**
   In a high world (`1.48x–1.54x`), if a transient cluster of Day-0/Day-1 wins sets `outageCenterToday` (`14%–32%` false-alarm rate before `worldLogMean` finishes climbing from `1.40` to `1.48`), `onNewDay` (`line 272`: `if (this.outageCenterToday) this.outageUsedThisWeek = true`) **permanently disables outage detection for the rest of the week**, missing the real outage on Day 2–4!

- **Formula-Level Fix (Simulation-Verified: `82% -> 98%` Helsinki, `78% -> 96%` Tampere, `0% -> 86%+` Oulu):**
  1. Track per-center **outside-only day offset** `outDayOffset` (`{ nIn, llr, sumResIn, nOut, sumResOut, outDayOff, outDayPrec }`) so Uusimaa never masks itself and `1.48x–1.54x` worlds never false-trigger once `nOut >= 10`:
     ```ts
     // For each [center, set] in within80Map:
     const thetaOutC = this.worldLogMean + cur.outDayOff // outside-only day baseline for `center`
     const xC = xRaw - thetaOutC // where xRaw = Math.log(quoteCents / (effMult * ulp)) - fixedPredictors
     const baseC = winProbability(xC, meta.fasterOptionUnquoted)
     if (set.has(pickupId)) {
       const outC = winProbability(xC - Math.log(1.30), meta.fasterOptionUnquoted)
       const dLL = (y ? Math.log(outC.p + 1e-9) : Math.log(1 - outC.p + 1e-9))
                 - (y ? Math.log(baseC.p + 1e-9) : Math.log(1 - baseC.p + 1e-9))
       cur.nIn++
       cur.llr = Math.max(0, cur.llr + dLL)
       cur.sumResIn += y - baseC.p
     } else {
       cur.nOut++
       cur.sumResOut += y - baseC.p
       const dpTheta = -baseC.dp_dx
       const denomC = Math.max(1e-4, baseC.p * (1 - baseC.p))
       const gradC = ((y - baseC.p) * dpTheta) / denomC
       const infoC = (dpTheta * dpTheta) / denomC
       cur.outDayOff = Math.max(-0.16, Math.min(0.16, cur.outDayOff + gradC / (cur.outDayPrec + infoC)))
       cur.outDayPrec += 0.55 * infoC
     }
     ```
  2. Use a **sample-adaptive `nIn >= 5` LLR gate** with contrast `meanIn - meanOut >= 0.19` (dropping the brittle `meanIn >= 0.24` cliff when `llr >= 4.4`):
     ```ts
     // Require nOut >= (this.currentDay === 0 ? 14 : 9) so Day-0 worldLogMean settles first
     const minNOut = this.currentDay === 0 ? 14 : 9
     const reqLLR = st.nIn < 6 ? 4.35 : st.nIn < 8 ? 3.85 : 3.50
     if (
       st.nIn >= 5 &&
       st.nOut >= minNOut &&
       st.llr >= reqLLR &&
       (meanIn - meanOut >= 0.19 || st.llr >= 4.6) &&
       meanOut < 0.11
     ) { ... }
     ```
  3. **Upon first `outageCenterToday` trigger**, roll back `worldLogMean`, `worldPrecision`, and `dayLogOffset` to `dayStart*` and replay `todayHistory` **excluding** quotes with `pickupId` inside `within80Map.get(bestCenter)`, plus allow de-triggering (`if (cur.llr < 1.2) this.outageCenterToday = null`) and lock `this.outageUsedThisWeek = true` in `onNewDay` (`line 272`) **only if end-of-day `st.llr >= 4.6 && st.nIn >= 6`**.

---

### 1.6 `morningRetalLog` (`wr - 0.35`) & `antiRetalShadow` (`recentDealerWinRate > 0.65`) (`market.ts:286–292, 751–755`)

- **Current Code:**
  - `market.ts:286–292`:
    ```ts
    const last10 = d.priorOutcomes.slice(-10)
    if (last10.length >= 4) {
      const wr = last10.reduce((a, b) => a + b, 0) / last10.length
      d.morningRetalLog = Math.max(-0.030, Math.min(0.025, -0.045 * (wr - 0.35)))
    }
    ```
  - `market.ts:751–755`:
    ```ts
    const last12 = d.priorOutcomes.slice(-12)
    const recentDealerWinRate = last12.length >= 8 ? last12.reduce((a, b) => a + b, 0) / last12.length : 0.40
    const antiRetalShadow = recentDealerWinRate > 0.65 ? Math.round(normalScale * 0.032) : 0
    ```
- **Quantitative Critique:**
  1. **Window Horizon Mismatch Across Dealer Sizes:** `D01` sends **`50–68` requests/day** (`300/wk`), so `slice(-10)` only sees **15:30–18:00 yesterday afternoon** (when `dayLoad` / `surplusFrac` throttled our late-afternoon quotes to `wr = 0.10`, even if we won `35/58 = 60%` of `D01` overall yesterday — causing `morningRetalLog` to predict a competitor price *increase* when the competitor actually *cut* its price!). Conversely, for a 5-req/wk dealer, `slice(-10)` spans the whole week.
  2. **Unquoted Requests Ignored in Competitor Win Rate:** `HANDBOOK.md` states: *"Each morning it looks at each dealer's recent requests... and it learns only whether it won each request."* A `5.0x` decline quote (`competitiveOptions = []`) pushes `0` into `d.priorOutcomes` (`line 360`), which is accurate, **except** during a **Regional Outage** (`comp` was down — the dealer used the `+30%` backup, so the competitor won `0` too!).
  3. **`antiRetalShadow` Fires on Friday & During Active Outages (Pure Margin Destruction!):**
     - On **Friday (`day === 4`)**, there **is no Saturday/Monday request stream** (`HANDBOOK.md`: *"The next Monday is a business day without new requests"*), so overnight competitor retaliation has **zero future cost**! Adding `+3.2%` shadow cost on Friday throws away profitable Friday conversions for nothing.
     - During an **active Regional Outage**, our win rate on `D01–D04` in Uusimaa naturally climbs to `75%–90%`. Triggering `antiRetalShadow` (`+3.2%` cost) throttles high-margin `+30%` outage harvesting!
     - Even Mon–Thu, `recentDealerWinRate > 0.65` has a discontinuous jump between `7/12` (`0`) and `8/12` (`+3.2%` of `normalScale` $\approx €3.60$), and ignores remaining dealer requests (`(1 - progress) * dealerWeeklyRate`).

- **Formula-Level Fix:**
  - Track `d.yesterdayOutcomes` (or `slice(-Math.max(10, d.yesterdayCount))`) for `morningRetalLog`, centered at `0.38` with wider `[-0.045, +0.035]` range (`-0.065 * (wr - 0.38)`).
  - Replace `antiRetalShadow` (`market.ts:751–755`) with a smooth, remaining-week-weighted, non-Friday / non-outage shadow cost:
    ```ts
    const dayIdx = Math.floor(request.arrivedAt / DAY)
    const inOutage = Boolean(
      inHours && this.estimator.outageCenterToday &&
      this.map.within80kmSet.get(this.estimator.outageCenterToday)?.has(pickupId)
    )
    const windowN = Math.min(24, Math.max(10, Math.round(d.totalRequestsSeen / Math.max(1, dayIdx + 1))))
    const recent = d.priorOutcomes.slice(-windowN)
    const recentWr = recent.length >= 6 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0.40
    const remFutureFrac = dayIdx >= 4 ? 0 : Math.max(0, 0.85 - requestProgressFraction(request.arrivedAt))
    const antiRetalShadow =
      !inOutage && dayIdx < 4 && recentWr > 0.55
        ? Math.round(normalScale * Math.min(0.038, 0.14 * (recentWr - 0.55) * remFutureFrac))
        : 0
    ```

---

## 2. Deep Audit of `PricingEngine` (`evaluateOption`, `optimizeOptionPrice`, `quoteRequest`)

### 2.1 `targetWeekly` Cap (`365`), `paceRatio`, `surplusFrac`, and the `s1` Kink Trap (`market.ts:59, 670–692, 757–763`)

- **Why `omni-v4` Wins `460` Orders When `targetWeekly = 365` (AND Wins `340` in a `644`-Driver Shortage!):**
  Inspect the exact left and right derivatives of the objective $f(x) = p(x)\,(C_0 e^x - E)$ (`market.ts:790`, where $C_0 = \text{targetScale}$ and $x = \ln(\text{cand}/C_0)$) at the slope kink $x = 0$ (`market.ts:59`: $s_1 = 9.8$ for $x < 0$, $s_1 = 13.0$ for $x \ge 0$):
  - For `fasterOptionUnquoted = false`, $p(0) = 0.50$, $p'(0^-) = -2.45$, and $p'(0^+) = -3.25$:
    $$f'(0^-) \ge 0 \iff \frac{E}{C_0} \ge 1 - \frac{0.50}{2.45} = \mathbf{0.7959}, \qquad f'(0^+) > 0 \iff \frac{E}{C_0} > 1 - \frac{0.50}{3.25} = \mathbf{0.8462}$$
  - **The Kink Trap:** On a typical Level-8 request, $E_{\text{true}} / C_0 \approx (0.90 \times 0.93) / (1.10 \times 1.42) = \mathbf{0.536}$. Even when `paceRatio = 1.26` (`460` won vs `365` target!), `surplusFrac` (`line 759`: `Math.min(0.50, 0.35 * (1.26 - 0.64))` $= 0.217$, capped at `0.50`!) plus `refShadowCents` (`line 691`: `0.18 * (1.26 - 0.58) * refFee` $\approx 0.073\,C_0$) only raises $E / C_0$ to $0.536 + 0.073 + 0.217(1 - 0.536) = \mathbf{0.710 < 0.796}$!
  - At $E / C_0 = 0.710$, `optimizeOptionPrice` **still quotes `-4.2%` BELOW the competitor (`winProb = 60%`)**! Even if `surplusFrac` hits its hard `0.50` cap, $E / C_0 \approx 0.82 < 0.846$, **pinning quotes at $x = 0$ (`1.00 * targetScale`, `50%` win rate) and never harvesting `+5%..+12%` scarcity premiums above `targetScale`**!
  - Simultaneously, `refShadowCents = request.referenceFeeCents * shadowMult` (`line 691`) scales opportunity cost purely by `referenceFeeCents`. Across the 4,142 reveal requests:
    - `<45 km` hops (`9.5%` of requests): mean `referenceFeeCents` is **`€16.68`** (`ref/ULP = 0.648`), so `shadowMult = 0.20` adds only **`€3.34`**, even though a short hop consumes **1 driver gig-quota slot** and **1 `dayCap` slot**!
    - `>240 km` hauls (`36.4%` of requests): mean `referenceFeeCents` is **`€126.99`**, so the same `shadowMult = 0.20` adds **`€25.40`** on top of `surplusShadow`, pricing out €80-margin long hauls while admitting cheap local hops! (This is why `4ec0232`/`v5-spread-1` earned **`€40,370` revenue (`€95.66/o`)** vs `omni-v4-spread-1`'s **`€37,467` (`€89.63/o`)**!)

- **Formula-Level Fix (`market.ts:671–692, 757–763`):**
  1. **Uncap `targetWeekly` to scale smoothly with `totalDrivers` (accounting for 2-order bundling capacity in large rosters and tightening in $<680$-driver shortages):**
     ```ts
     // 650 drv -> 286 target; 780 drv -> 359 target; 930 drv -> 446 target
     const targetWeekly =
       this.level >= 7
         ? Math.max(265, Math.min(465, Math.round(this.supply.totalDrivers * (0.42 + 0.00018 * Math.max(0, this.supply.totalDrivers - 650)))))
         : Math.max(450, Math.min(640, Math.round(this.supply.totalDrivers * 0.26)))
     ```
  2. **Replace proportional `refShadowCents` (`line 691`) with Per-Driver-Slot + Road-Hour Shadow Pricing:**
     ```ts
     const slotShadowMult =
       0.42 * Math.max(0, paceRatio - 0.65) +
       0.55 * Math.max(0, paceRatio - 0.98) +
       0.40 * backlogExcess * backlogExcess +
       0.42 * localSat * localSat +
       0.85 * daySat * daySat +
       (ctx.fluActiveToday ? 0.20 : 0)
     const slotUnitCents = 1200 + 170 * roadHours + 0.16 * request.referenceFeeCents
     const refShadowCents =
       this.level >= 7
         ? slotUnitCents * Math.min(1.85, slotShadowMult * (leadHours < 5 ? 1.18 : 1.0))
         : request.referenceFeeCents * Math.min(0.50, 0.25 * slotShadowMult)
     ```
  3. **Raise `surplusFrac` cap from `0.50` to `0.74` (`line 759`) so $E/C_0$ cleanly crosses the `0.846` kink when `paceRatio > 0.95` or on high-trust / outage lanes:**
     ```ts
     const surplusFrac =
       this.level >= 7
         ? Math.min(
             0.74,
             Math.max(0, 0.28 * (ev.paceRatio - 0.72) + 0.38 * Math.max(0, ev.paceRatio - 1.00) + (ev.dayLoad > 0.72 ? 0.30 * (ev.dayLoad - 0.72) : 0)),
           )
         : 0
     ```

---

### 2.2 `dlDay === 7` (Next Monday) Multi-Day Pileup & 2-Leg `sameCluster30` Bug (`market.ts:560–566, 576–610`)

- **Quantitative Critique:**
  1. **`dlDay === 7` Chokes Profitable Thu/Fri Quotes (`market.ts:577–587, 610, 681`):** Across the 4 reveal worlds, **`408.0` option-offers/week** land on `dlDay = 7` (`Monday Week 2 20:00`: `38.2` Wed `within_3_days` + `123.8` Thu `next_day`/`within_3_days` + `169.5` Fri `next_day` + `55.4` delayed-ready Mon/Tue cars). Unlike Mon–Fri (`dlDay 0..4`), cars due on `dlDay = 7` execute across **3.5 working days (Thu + Fri + Sat + Next Mon)**, and Next Monday has **zero new incoming requests** (`HANDBOOK.md`). Applying a single-day `dayCap = Math.round(totalDrivers * 0.096)` (`64..89`) to `dlDay = 7` drives `dayLoad(7)` past `0.90..1.20` by Friday noon, adding up to `+0.56` to `etaLate` (`line 610`), inflating `daySat` (`line 681`), and rejecting safe Friday `next_day` orders (`line 587`).
  2. **Intra-Day Delivered Quota Leak (`starter.ts:337` -> `market.ts:583`):** `countActiveOrdersOnDeadlineDay` skips already-delivered orders (`if (undeliveredLegs(o).length === 0) continue`), so `dayOrders` for *today* (`same_day`) **falls** at 14:00 as morning deliveries finish, even though those drivers already spent their daily gig quota!
  3. **2-Leg Round-Trip Trade-Ins Falsely Trigger `+0.75 * sameCluster30` (`market.ts:561, 565, 599`):** As verified on `legs.csv`, **91.2% (`73/80`)** of 2-leg trade-ins are round-trips (`oulu -> tampere -> oulu`), so `pickupId === deliveryId`, setting `sameCluster30 = 1` (`line 565`) and adding **`+0.75` logit to `etaLate` (`line 599`)**! `+0.75 * sameCluster30` was calibrated for tiny `<30km` single-leg hops where low `referenceFeeCents` (`€16`) fails to attract drivers, **not** a `€240`-fee round-trip that returns the driver right back to their home town with zero return bus ticket!

- **Formula-Level Fix (`market.ts:561–587`):**
  ```ts
  const farPlaceId =
    request.legs.length === 2 && this.map.isSameCluster30(pickupId, deliveryId)
      ? request.legs[0]!.delivery.placeId
      : deliveryId
  const D_home = this.supply.homeDrivers(farPlaceId)
  const sameCluster30 = request.legs.length === 1 && this.map.isSameCluster30(pickupId, deliveryId) ? 1 : 0
  ...
  // Multi-day execution window on Next Monday (dlDay >= 7, 0 new requests + Fri/Sat/Mon execution):
  const dayCapMult = dlDay >= 7 ? 0.165 : dlWd === 4 ? 0.064 : 0.096
  const dayCap = Math.max(40, Math.round(this.supply.totalDrivers * dayCapMult))
  ```

---

### 2.3 `etaLate` & `maxAllowedPLate` Risk Budgeting (`market.ts:594–621`)

- **Quantitative Critique:**
  1. **Step-Function Cliffs & Lagging Ledger Denominator (`market.ts:615–620`):** `currentOnTime = (ctx.deliveredOnTimeTotal + 38) / (ctx.deliveredOrdersTotal + 40)` only counts **completed** deliveries (`finalizePendingRevenue`), ignoring open orders that have **already missed their deadline** (`now > order.deadline`, guaranteed late upon eventual delivery!). On Friday afternoon (`quant-compare-1`, `opportunity-compare-1`), 4–8 overdue Thursday/Friday cars can be sitting undelivered while `currentOnTime` still reads `0.955`, keeping `maxAllowedPLate = 0.135` wide open!
  2. **No Multi-Option or VIP Differentiation in `maxAllowedPLate`:** Admitting `same_day` at `pLate = 0.134` when `next_day` (`pLate = 0.012`) is **co-offered on the exact same request** for `D01` (`trust = 25`) risks a **€389 franchise hit** for €5 of speed spread.

- **Formula-Level Fix (`market.ts:615–621`):**
  Pass `overdueUndeliveredCount` in `QuotePortfolioContext` (`count of undelivered won orders with now > effectiveDeadline`) and replace the step table with a continuous, VIP-aware gate:
  ```ts
  const effDelivTotal = ctx.deliveredOrdersTotal + ctx.overdueUndeliveredCount
  const currentOnTime = (ctx.deliveredOnTimeTotal + 38) / (effDelivTotal + 40)
  // Smooth ramp from 0.015 at 90.8% OT to 0.135 at 96.5% OT:
  let maxAllowedPLate = Math.max(0.015, Math.min(0.135, 0.015 + 2.10 * Math.max(0, currentOnTime - 0.908)))
  const isHighValueDealer = this.level === 8 && (dealer.trust >= 5 || dealer.totalRequestsSeen >= 8)
  if (isHighValueDealer && progress < 0.90) {
    if (option.kind === "same_day" && request.options.length > 1) {
      maxAllowedPLate = Math.min(maxAllowedPLate, 0.065)
    } else if (dealer.trust >= 12) {
      maxAllowedPLate = Math.min(maxAllowedPLate, 0.090)
    }
  }
  if (pLate > maxAllowedPLate) return undefined
  ```

---

### 2.4 `same_day` `+13%` Spread Over `next_day` (`market.ts:846–871`)

- **Current Code (`market.ts:846, 859–868`):**
  `sdOpt` is optimized first with `effectiveCost = E_sd` (assuming losing `same_day` earns `€0`), and then `sdPrice` is overwritten post-hoc by `Math.max(sdOpt.priceCents * 1.04, prices.next_day * 1.13, prices.next_day + minSpread)`.
- **Quantitative Critique:**
  1. **Post-Hoc `+13%` Over-Prices Long Hauls & Uncongested Thursdays:** Because `ulp(same_day) = 1.08 * ulp(next_day)`, competitor `comp(same_day)` is only `+8.0%` above `comp(next_day)`. On a €160 haul (`ndPrice = 16000`), `1.13 * ndPrice` forces a **+€20.80** surcharge (vs. competitor's +€12.80), even if `sdEv.trueCostCents - ndEv.trueCostCents` is only €3! Worse, on **Thursday morning (`pickWd = 3`)**, `same_day` lands on uncongested Thursday (`dayCap = 0.096 * N`) whereas `next_day` lands on congested **Friday (`dlWd = 4`, `dayCap = 0.064 * N`)**! When Friday congestion inflates `prices.next_day` to `1.08 * comp_nd`, multiplying by `1.13` pushes Thursday `same_day` to `1.132 * comp_sd`, pricing us out of an easy Thursday `same_day` win!
  2. **Exact Multi-Option Diversion Optimality:** When `next_day` is co-quoted with expected margin $M_{\text{nd}} = \text{ndOpt.expectedMargin} = p_{\text{nd}}(P_{\text{nd}} - E_{\text{nd}}) > 0$, a flexible fraction $\gamma \approx 0.55$ of dealers who reject `same_day` divert to our `next_day` quote rather than leaving us empty-handed. By Bellman optimality, `same_day` should be optimized **after** `ndOpt` using the menu-adjusted opportunity cost:
     $$E_{\text{sd}}^{\text{menu}} = E_{\text{sd}} + 0.55 \cdot \text{ndOpt.expectedMargin}$$
     subject only to the incentive-compatibility floor $P_{\text{sd}} \ge P_{\text{nd}} + \max\!\big(400,\; \text{round}(E_{\text{sd}}^{\text{true}} - E_{\text{nd}}^{\text{true}} + 200)\big)$. When Thursday `same_day` is cheaper for our fleet than Friday `next_day`, $E_{\text{sd}}^{\text{true}} < E_{\text{nd}}^{\text{true}}$ keeps the spread tight (`+€4.00..+8%`) and steers volume onto Thursday; when `same_day` is tighter than `next_day`, `optimizeOptionPrice` naturally places $P_{\text{sd}}$ at the elasticity-optimal `+11%..+18%` premium!

---

### 2.5 Omitting `same_day` (`fasterOptionUnquoted`) vs. `3.0x` / `5.0x` Decoy (`market.ts:847, 868, 887–901`)

- **Why `c5421ee` Was Right to Delete `8d69968`'s `3.0x` `same_day` Decoy — And What Still Needs Fixing:**
  1. **`3.0x` Was NOT a Safe Decline in Level 8:** In a `1.52x` world during a `+30%` outage on a `trust = 25` VIP short hop (`shortHopLift = 1.13`), $\text{effMult} \times \text{compCents} = 1.25 \times 1.52 \times 1.30 \times 1.13\,\text{ulp} = \mathbf{2.791\,\text{ulp}}$! Quoting `3.0x` list price (`x = ln(3.0 / 2.791) = +0.072`) had a **`28.1%` win probability** on `same_day` options that had **already failed `evaluateOption` safety** (`pLate > maxAllowedPLate` or Friday `dayLoad >= 0.92`)!
  2. **Omitting `same_day` Costs Zero Goodwill When `next_day` Is Quoted:** Per `RULES.md` (*"You answer with one price for each option you offer, which can be fewer than the dealer accepts... A request that you do not quote costs a little goodwill"*), goodwill loss occurs **only** when a request receives **no quote action at all** (`outcome = "unquoted"`). Omitting `same_day` while quoting `next_day` incurs **zero** goodwill loss and matches `winProbability(x, fasterOptionUnquoted = true)` (`p2(x) = sigmoid(-0.080 - 4.50 * x)`, `market.ts:64`).
  3. **Two Remaining Bugs in `market.ts:849, 889, 900`:**
     - **3-Option `fasterOptionUnquoted` Mismatch (`line 849` vs `line 900`):** On `[same_day, next_day, within_3_days]` requests (`90.5/wk`), if `same_day` is quoted (`sdOpt` ok), `next_day` fails (`!ndOpt`), and `within_3_days` is quoted, `fasterUnquotedFor3d` (`line 849`) is `true` while `meta.fasterOptionUnquoted` (`line 900`, checking only `request.options[0]`) is `false`! Both should check per-option whether **any faster offered option was omitted**: `fasterUnquoted(opt) = request.options.some(o => o.deadline < opt.deadline && !prices[o.kind])`.
     - **Full-Request Decline Multiplier (`line 889`):** At `2.791 * ulp`, `5.0x` list price (`x = +0.583`) still has `sigmoid(-13 * 0.583) = 0.051%` accidental win probability (~`0.1` unsafe accidental wins/week across 200 declined requests). Raise `5.0` at `line 889` to **`7.0`** (`winProb = 8e-6`, strictly integer cents, zero goodwill loss).

---

### 2.6 `within_3_days` Cannibalization (`equalMargin3d`, `market.ts:873–885`)

- **Current Code (`market.ts:877–884`):**
  ```ts
  } else if (ndEv) {
    const equalMargin3d = Math.round(prices.next_day - Math.max(150, ndEv.trueCostCents - d3Ev.trueCostCents + 150))
    const capped3d = Math.min(Math.max(d3Opt.priceCents, equalMargin3d), prices.next_day - 200)
    if (capped3d - d3Ev.trueCostCents >= prices.next_day - ndEv.trueCostCents - 200 && capped3d - d3Ev.trueCostCents >= 500) {
      prices.within_3_days = capped3d
      competitiveOptions.push("within_3_days")
    }
  }
  ```
- **Exact Algebraic Proof of Cannibalization (`opportunity-compare-1` & `spread-1` Regression):**
  Let $\Delta C = \text{ndEv.trueCostCents} - \text{d3Ev.trueCostCents}$ (typically `€0.50–€3.00`, solely from slightly lower modeled `pLate`/`pEscalate`; `referenceFeeCents` is **identical**!).
  1. **Algebraic Tautology:** Because `ulp(within_3_days) = 0.93 * ulp(next_day)` (`-7.1%` across all `668` co-offered requests: mean `€68.25` vs `€73.42`), `d3Opt.priceCents < equalMargin3d` almost always holds, so `capped3d = ndPrice - max(200, ΔC + 150)`. Substituting into `line 880` yields:
     $$(P_{\text{nd}} - \Delta C - 150) - C_{\text{3d}} = P_{\text{nd}} - C_{\text{nd}} - 150 \ge P_{\text{nd}} - C_{\text{nd}} - 200 \iff -150 \ge -200 \quad (\mathbf{100\%\text{ TRUE!}})$$
     Whereas `8d69968` checked `d3Opt.priceCents` *without* forcing `Math.max(..., equalMargin3d)` (omitting `within_3_days` ~90% of the time), `c5421ee` quotes `within_3_days` on **nearly every co-offered request (`~167/wk`) at `€2.00–€4.50` below `prices.next_day`**!
  2. **Triple Margin Damage:**
     - **Realized Margin Giveback:** Price-sensitive dealers who would have paid `prices.next_day` (`€108.66`) switch to `within_3_days` (`€104.66`). When both book at `0.85x * referenceFeeCents`, realized driver cost is identical, sacrificing **`€2.00–€4.50`/order** of pure revenue.
     - **48-Hour Dealer Trust Delay & Friday Congestion Dump:** `within_3_days` on Mon/Tue dumps `56.3` option-offers/week straight onto **Friday (`dlDay = 4`)** (`36.5` from Mon + `19.8` from Tue!) and delays delivery by 24–48 hours, forfeiting `+1%` Dealer Trust across mid-week quotes.
     - **Estimator Upward Bias:** Because `capped3d / ulp_3d ≈ 1.05 * (ndPrice / ulp_nd)`, every `within_3_days` win inflates `onQuoteResolved` residuals (Section 1.4).

- **Formula-Level Fix (`market.ts:873–885`):**
  Only co-quote `within_3_days` alongside `next_day` when `next_day` carries a **genuine congestion or lateness surcharge** ($\text{ndEv.baseEffectiveCostCents} - \text{d3Ev.baseEffectiveCostCents} \ge 450$, e.g., `next_day` falls on congested Friday `dlDay = 4` while `within_3_days` falls on uncongested Next Monday `dlDay = 7`!), **and** require `within_3_days` to preserve full net margin plus trust-delay cost (`trustDelayCost = level === 8 && dealer.trust < 25 ? 180 : 0`):
  ```ts
  if (d3Opt && d3Ev) {
    if (prices.next_day === undefined) {
      prices.within_3_days = d3Opt.priceCents
      competitiveOptions.push("within_3_days")
    } else if (
      ndEv &&
      ndEv.baseEffectiveCostCents - d3Ev.baseEffectiveCostCents >= 450 &&
      Math.floor(d3Ev.plan.effectiveDeadline / DAY) % 7 !== 4 // never cannibalize into congested Friday!
    ) {
      const trustDelayCents = this.level === 8 && d.trust < 25 ? 180 : 0
      const min3dMarginFloor = Math.round(
        prices.next_day - (ndEv.trueCostCents - d3Ev.trueCostCents) + trustDelayCents,
      )
      const cand3d = Math.max(d3Opt.priceCents, min3dMarginFloor)
      if (cand3d <= prices.next_day - 250 && cand3d - d3Ev.trueCostCents >= 600) {
        prices.within_3_days = cand3d
        competitiveOptions.push("within_3_days")
      }
    }
  }
  ```

---

## 3. Level-8 Dealer Trust Harvesting & VIP Franchise Protection (`market.ts:295–302, 346–350, 664–667, 693–711`)

### 3.1 Exact Franchise-Loss Valuation (`trustLossPenaltyCents`, `market.ts:664–667`)

- **Current Code (`market.ts:664–666`):**
  ```ts
  const dealer = this.estimator.getDealer(request.dealerId)
  const trustLossPenaltyCents = this.level === 8 && dealer.trust >= 4 ? dealer.trust * 160 : 0
  const expectedRiskCost = pLate * (0.35 * option.listPriceCents * 1.45 + trustLossPenaltyCents)
  ```
- **Exact Franchise Valuation Across the 4 Reveal Worlds (`D01–D04 = 57.9%` of Market):**
  Across the 4 reveal worlds, request volume is extreme Pareto: **`D01` averages `300.2` reqs/wk (`29.0%`)**, **`D02` `137.8`/wk (`13.3%`)**, **`D03` `90.0`/wk (`8.7%`)**, **`D04` `71.2`/wk (`6.9%`)** — just 4 dealers send **`599.2` requests/week (`57.9%`)**!
  When one order for dealer $d$ with current trust $T$ and $W_{\text{rem}}$ remaining future wins this week arrives late, **two separate penalties** hit future revenue (mean $\overline{C}_{\text{comp}} \approx €114 = 11,400\text{c}$):
  1. **Trust Halving (`d.trust = Math.floor(T / 2)`, `line 299`):** Even when $W_{\text{rem}}$ is large enough to rebuild back to `25`, the exact lost trust-percent-orders over the remaining $W_{\text{rem}}$ wins is:
     $$\Delta U_{\text{halve}}(T, W_{\text{rem}}) = \sum_{k=0}^{W_{\text{rem}}-1} \Big[\min(25,\, T + k) - \min\!\big(25,\, \lfloor T/2\rfloor + k\big)\Big]$$
     At Wednesday noon ($progress = 0.50$), this sum alone equals **`91` units (`€103.74`)** on `D01` ($T=25, W_{\text{rem}}=63$) and **`115` units (`€131.10`)** on `D03` ($T=19, W_{\text{rem}}=19$)!
  2. **Permanent `lateCount` Satisfaction Hit (`effMult *= exp(-0.0405)`, `line 301, 349` — 100% Omitted in `c5421ee`!):** At **all** levels $\ge 4$ (including Level 8, per `HANDBOOK.md`), `lateCount++` slashes `effMult` by $1 - e^{-0.0405} = \mathbf{3.97\%}$ (`€4.53/win`) across **all** $W_{\text{rem}}$ future wins (`min(lateCount, 6)`): **`€285.13`** on `D01` (`63` wins), **`€131.25`** on `D02` (`29` wins), **`€85.99`** on `D03` (`19` wins)!

  | Dealer | Mean Reqs/Wk | Wed Noon $T$ / $W_{\text{rem}}$ | Trust-Halving Loss | Permanent `lateCount` Loss (`-3.97%`) | **True Franchise Loss** | `c5421ee` `trustLossPenaltyCents` | Error Factor |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | `D01` | 300.2 | 25 / 63 | €103.74 | €285.13 | **€388.87** | €40.00 *(€0 if $T<4$!)* | **9.7x too low** |
  | `D02` | 137.8 | 25 / 29 | €103.74 | €131.25 | **€234.99** | €40.00 *(€0 if $T<4$!)* | **5.9x too low** |
  | `D03` | 90.0 | 19 / 19 | €131.10 | €85.99 | **€217.09** | €30.40 *(€0 if $T<4$!)* | **7.1x too low** |
  | `D04` | 71.2 | 15 / 15 | €125.40 | €67.89 | **€193.29** | €24.00 *(€0 if $T<4$!)* | **8.1x too low** |
  | *Any dealer, Fri 17:45* | — | 25 / **0** | **€0.00** | **€0.00** | **€0.00** | **€40.00** | **Over-penalizes Fri!** |

  In addition, per `HANDBOOK.md` (*"Late and undelivered orders lower the satisfaction of the dealer, and each order delivered on time raises it a little"*), `onOrderDelivered` (`market.ts:295–302`) increments `d.lateCount++` on `!onTime` but **never decays `d.lateCount` on `onTime`** (`if (onTime) d.lateCount = Math.max(0, d.lateCount - 0.12)`).

---

### 3.2 Count-Based Acquisition vs. Value-Based Harvesting (`trustBonusCents`, `market.ts:693–711`)

- **Current Code (`market.ts:703–711`):**
  ```ts
  const obsRate = progress > 0.04 ? dealer.totalRequestsSeen / progress : 20
  const remDealerWins = Math.max(0, (1 - progress) * obsRate * 0.34)
  trustBonusCents = Math.min(260, request.referenceFeeCents * 0.04, Math.round(remDealerWins * 18))
  const baseEffectiveCostCents = Math.max(
    request.referenceFeeCents * 0.78,
    trueCostCents + refShadowCents - trustBonusCents,
  )
  ```
- **Four Structural Flaws:**
  1. **Telescoping Cap Identity Ignored (In-Flight Saturation on `D01`):** Adding +1 on-time delivery at projected post-delivery trust $T_{\text{proj}} = d.\text{trust} + W_{\text{inFlight}}(d)$ yields an exact future gain over $W_{\text{after}}$ subsequent wins of:
     $$\Delta U_{\text{gain}}(T_{\text{proj}}, W_{\text{after}}) = \sum_{k=0}^{W_{\text{after}}-1}\Big[\min(25, T_{\text{proj}} + 1 + k) - \min(25, T_{\text{proj}} + k)\Big] = \min\!\big(\max(0, 25 - T_{\text{proj}}),\; W_{\text{after}}\big)$$
     By Tuesday morning, `D01` often has `d.trust = 3` delivered **plus `24` `next_day` orders already won and in-flight** ($T_{\text{proj}} = 27 \ge 25 \implies \Delta U_{\text{gain}} = \mathbf{0}$!). Ignoring `inFlightDealerOrders(dealerId)` wastes `trustBonusCents` discounts on `D01` orders that hit the `25` cap anyway!
  2. **Count-vs-Size Arbitrage Blocked by `referenceFeeCents * 0.04` & `0.78 * referenceFeeCents` Floor (`lines 705, 709`):** Dealer Trust is **count-based** (`1` order $= +1\%$ regardless of size!), while future trust revenue scales with **average future order size (`~€114`)**! A €25 metro `same_day` hop (`referenceFeeCents = €17`, 25 min road time, `pLate = 0.005`) on Monday morning for `D02`/`D03`/`D04` delivers **Monday afternoon**, unlocking $+1\% \times 25 \times €114 = \mathbf{+€28.50}$ of future pricing power — yet `request.referenceFeeCents * 0.04` caps `trustBonusCents` at **`€0.68`**, and `Math.max(request.referenceFeeCents * 0.78, ...)` (`line 709`) clamps it to **`€0.00`** whenever hub/synergy `trueCostCents` is `0.75–0.80x`!
  3. **Monday 08:00–10:00 Prior Blindness (`progress <= 0.04`, `line 703`):** During Monday 08:00–10:00 (the **highest-EV trust-seeding window of the entire week**), `obsRate` is hardcoded to `20` for all dealers (`remDealerWins = 6.8`), treating `D01` (`300/wk`) and `D02` (`138/wk`) like tiny 20-req/wk dealers! Bayesian shrinkage `(dealer.totalRequestsSeen + priorRate * 0.08) / (progress + 0.08)` (with empirical `D01..D04` prior or fast count adaptation) fixes Monday morning immediately.

- **Unified Formula-Level Fix for Both `trustLossPenaltyCents` and `trustBonusCents` (`market.ts:664–711`):**
  Pass `inFlightDealerOrders: (dealerId: string) => number` in `QuotePortfolioContext`:
  ```ts
  const progress = requestProgressFraction(ctx.now)
  const dealer = this.estimator.getDealer(request.dealerId)
  // Empirical shrinkage rate: adapts within 2-3 requests while respecting early Monday bursts
  const priorWeeklyReqs = dealer.totalRequestsSeen >= 3 ? 60 : 25
  const estWeeklyReqs = (dealer.totalRequestsSeen + priorWeeklyReqs * 0.06) / (progress + 0.06)
  const remWinsNow = Math.max(0, (1 - progress) * estWeeklyReqs * 0.38)

  // 1. Exact Franchise Loss Penalty (Trust Halving + Permanent lateCount Satisfaction Drop):
  let halveUnits = 0
  if (this.level === 8 && dealer.trust >= 2) {
    const tHalf = Math.floor(dealer.trust / 2)
    const steps = Math.min(40, Math.round(remWinsNow))
    for (let k = 0; k < steps; k++) {
      halveUnits += Math.min(25, dealer.trust + k) - Math.min(25, tHalf + k)
    }
  }
  const satLossUnits = dealer.lateCount < 6 ? remWinsNow * 3.97 : 0 // each unit = 1% of future compCents (~114 cents)
  const franchiseLossCents = Math.min(22000, Math.round((halveUnits + (this.level >= 4 ? satLossUnits : 0)) * 105))
  const expectedRiskCost = pLate * (0.35 * option.listPriceCents * 1.45 + franchiseLossCents)
  const trueCostCents = expectedDriverFee + expectedRiskCost
  ...
  // 2. Count-Based Trust Acquisition Bonus (accounting for in-flight cap saturation & delivery timing):
  let trustBonusCents = 0
  const inFlightSameDealer = ctx.inFlightDealerOrders(request.dealerId)
  const projTrust = dealer.trust + Math.round(0.95 * inFlightSameDealer)
  const delivProgress = Math.min(1.0, requestProgressFraction(plan.effectiveDeadline - 4 * HOUR))
  const remWinsAfterDeliv = Math.max(0, (1 - delivProgress) * estWeeklyReqs * 0.38)
  if (
    this.level === 8 &&
    !this.estimator.priceWarToday &&
    projTrust < 25 &&
    pLate <= 0.032 &&
    delivProgress < 0.78 &&
    paceRatio < 1.06
  ) {
    const gainUnits = Math.min(25 - projTrust, remWinsAfterDeliv) // exact telescoping sum!
    // Discount future trust value by 0.45 certainty factor; allow up to €4.80 on fast same_day hops!
    const capByOpt = option.kind === "same_day" ? 480 : 320
    trustBonusCents = Math.min(capByOpt, Math.round(request.referenceFeeCents * 0.22), Math.round(gainUnits * 42))
  }

  // Apply trustBonusCents AFTER the 0.78x floor (bounded by 0.62x) so metro short-hop trust builders aren't clamped out!
  const baseEffectiveCostCents = Math.max(
    request.referenceFeeCents * 0.62,
    Math.max(request.referenceFeeCents * 0.78, trueCostCents + refShadowCents) - trustBonusCents,
  )
  ```

---

## 4. Micro-Optimization in `optimizeOptionPrice` (`market.ts:732–796`)

- **Redundant Hot-Path Recomputation (`market.ts:775–796`):** `probe = this.estimator.predictOption(...)` at `line 732` already computes `targetScale = probe.effMult * probe.compCents`, which is **strictly invariant** to `cand` (`quoteCents`)! Yet the `for (let s = 0; s <= 48; s++)` loop calls `this.estimator.predictOption(...)` **49 times per option** (`up to 147 calls/request`), repeating map/dealer lookups, `logLaneFactor`, and `onNewDay` checks inside the live-final event loop.
- **Fix:** Precompute `targetScale` and `step = Math.sqrt(3 * Math.min(0.012, varPred))` **once** before the loop, and evaluate `winProbability(Math.log(cand / targetScale) ± step, fasterOptionUnquoted)` directly over `64` grid steps (plus local 1-cent refinement around `bestPrice`), cutting `quoteRequest` CPU time by **~85%** while increasing price resolution.
