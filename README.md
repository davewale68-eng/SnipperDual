# SNIPER_V4 PRO v6.2 — Autonomous Parliamentary Intelligence Platform

## System Overview & Architecture
**SNIPER_V4 PRO v6.2** is an autonomous parliamentary intelligence platform strictly designed for the 3-color game (**RED**, **BLUE**, **GREEN**).

It features **28 independent, autonomous analytical engines** across three parliamentary chambers governed by an overarching **Meta-Intelligence Layer**:

1. **General Parliament (3Ball - 11 Engines)**: `3B_Momentum`, `3B_Cycle`, `3B_DNA`, `3B_Probability`, `3B_Transition`, `3B_Recovery`, `3B_Pattern`, `3B_Gap`, `3B_Confidence`, `3B_CapitalProtection`, `3B_Dominance`.
2. **4Ball Parliament (11 Engines)**: `4B_SeasonStrength`, `4B_EntryIntel`, `4B_ExitIntel`, `4B_FirstAppearance`, `4B_LastStand`, `4B_TransitionRisk`, `4B_CapitalProtection`, `4B_DNA`, `4B_Lifecycle`, `4B_Recovery`, `4B_Dominance`.
3. **5Ball Intelligence Laboratory (6 Engines)**: `5B_KnowledgeQualification`, `5B_RareEventScanner`, `5B_GapEvolution`, `5B_SignatureMatching`, `5B_BehaviorProfile`, `5B_ComparativeIntel`.
4. **Meta-Intelligence Layer (Supreme Goverance)**:
   - Market Regime-Aware Engine Tracking (`ORDERED`, `TRANSITION`, `CHAOTIC`).
   - Dynamic Coalition Historical Track Record Analysis.
   - Anomaly & Rare Event Overrides.
   - Risk-Averse Decision Synthesis (`ENTER`, `HOLD`, `WAIT`, `DO_NOT_TRADE`).

---

## Repository File Tree Diagram
```
sniper-v4-pro/
├── Dockerfile                  # Production Docker configuration
├── .env.example                # Environment template
├── package.json                # Dependencies and scripts
├── README.md                   # Documentation
├── server.js                   # Express app entry point
├── public/
│   └── index.html              # Dashboard
└── src/
    ├── collector/
    │   ├── adapter.js          # Multi-wire ingestion adapter
    │   └── validator.js        # Bet9ja drawId & 3-color validator
    ├── core/
    │   ├── bus.js              # Active Pub/Sub Intelligence Bus
    │   ├── colorMath.js        # Deterministic 3-color math (RED > BLUE > GREEN)
    │   ├── isotonic.js         # Probability calibration utilities
    │   └── store.js            # State, weights, regime statistics & persistence registry
    ├── engines/
    │   ├── bayesianEngine.js             # Naive Bayes posterior probability classifier
    │   ├── behaviorFingerprintEngine.js # Per-color personality profiles
    │   ├── capitalProtectionEngine.js   # Trade veto & stop-loss rules
    │   ├── comparativeIntelligenceEngine.js # 4B vs 5B indicator transferability
    │   ├── dnaMatchingEngine.js          # Vector cosine similarity matching
    │   ├── entryIntelligenceEngine.js    # Entry quality & trading tiers
    │   ├── firstAppearanceEngine.js      # Dormant color breakthrough math
    │   ├── gapEvolutionEngine.js         # Mean, median, variance & overdue z-score
    │   ├── knowledgeConfidenceEngine.js # 6-criterion qualification gate (70% req.)
    │   ├── lastStandEngine.js            # Dominance decay & terminal burst math
    │   ├── lifecycleEngine.js            # 7-phase season lifecycle model
    │   ├── markovEngine.js               # 2nd-order Markov & Hidden Markov regimes
    │   ├── marketResearchEngine.js       # Leadership tables & research reports
    │   ├── rareEventLabEngine.js         # 5Ball intelligence & window tracker
    │   ├── rareEventSignatureEngine.js   # Pre-event signature library & vector clustering
    │   ├── shannonEntropy.js             # Systemic entropy & regime classifier
    │   └── tacticalEngine.js             # Historical season age reconstruction
    ├── parliaments/
    │   ├── fiveBallLabParliament.js     # 5Ball Research & Forecasting Laboratory
    │   ├── fourBallParliament.js        # Autonomous 4Ball seasonal chamber (11 engines)
    │   └── generalParliament.js         # Always-active 3Ball chamber (11 engines)
    ├── routes/
    │   └── api.js                  # REST API routes
    ├── services/
    │   ├── learning.js             # Direct outcome evaluation & regime-aware learning
    │   └── persistence.js          # Atomic JSON snapshot storage
    └── supreme/
        ├── arbitration.js          # Cross-engine contradiction & coalition analysis
        ├── metaIntelligence.js     # Meta-Intelligence Layer (Regime, Coalition & Anomaly Overrides)
        └── council.js              # Supreme Council decision orchestrator
```

---

## Running Locally
```bash
npm install
npm start
```

Then open `http://localhost:3000` in a browser to view the Trading Terminal Dashboard.

---

## Dashboard Frontend (`public/index.html`)

The dashboard is a single-file HTML/CSS/JS trading terminal served statically by
`server.js` via `express.static`. It polls `GET /api/snapshot` every 4 seconds and
renders:

- **Ingest Data Feed** — last draw time, total ingest count, last processed draw ID, API health
- **4Ball Season Intel** — season status, reconstructed age, dominant color, transition risk
- **Meta Intelligence** — market regime, disagreement index, consensus type, anomaly override
- **Coalition Groups** — live engine counts by category (Momentum / Recovery / DNA), computed from real vote data across all three parliaments
- **Hero Prediction Card** — recommended color, action, confidence gauge; glows purple on anomaly override, green otherwise
- **Event Bus Pipeline** — visual flow indicator that pulses on every successful data refresh
- **Decision Reasoning Trace** — a genuine step-by-step trace (Ingest → Parliaments → Arbitration → Meta-Intelligence → Supreme Council) built from real computed values at each pipeline stage
- **Engine Parliament Grid** — all 34 engines with real per-engine weight, risk, status LED, and last-activation time
- **5Ball Research Lab** — knowledge confidence, historical register, signature profiles, active prediction window
- **Learning & Brier Stats** — real average engine precision and Brier calibration computed from `store.engineStats`

### Integration fixes made when wiring this frontend to the backend

The dashboard HTML was originally authored against an assumed backend shape that
didn't fully match this codebase. The following were fixed so every dashboard
panel reflects real data rather than static placeholders:

1. **`decisionTrace` was never produced by the backend.** `src/supreme/council.js`
   now builds a genuine trace array from the actual values computed at each
   pipeline stage (parliament votes, arbitration consensus, meta-intelligence
   reasoning, final calibrated confidence).
2. **Coalition Groups panel was static placeholder text** ("3 Engines", "2 Engines",
   "4 Engines", never updated). Now computed client-side from real vote data,
   grouping engines by category keyword in their name across all three parliaments.
3. **4Ball Transition Risk was computed internally but never exposed.**
   `src/parliaments/fourBallParliament.js` now returns a top-level `transitionRisk`
   field; the dashboard wires it to the season panel.
4. **Engine vote objects never carried `weight`, `risk`, `status`, or `lastHit`.**
   Every engine card would have silently shown identical fallback values
   regardless of real performance. `src/supreme/council.js` now enriches every
   vote from all three parliaments with real data from `store.engineWeights`
   and `store.engineStats` before the snapshot is built.
5. **`engineStats` / `engineWeights` were never included in the snapshot**, so the
   Learning & Brier Stats panel had nothing to compute from. Both are now
   exposed at the top level of the snapshot returned by `runSupremeCouncil()`.
6. **Hero card glow and Event Bus pipeline nodes were static**, never reacting
   to real state. The hero card now glows purple on a confirmed anomaly
   override (green otherwise); the pipeline nodes briefly pulse on every
   successful refresh.

None of these were crashes — the frontend degraded gracefully to fallback
values in every case — but several dashboard panels would have silently shown
fabricated-looking placeholder data indefinitely without these fixes.

---

## Audit Notes (this pass)

- Removed `src/engines/rareEventSignatureEngine.js`: never `require()`'d by
  any parliament, supreme, or route file (superseded by
  `signatureVectorEngine.js`'s `matchSignatures`, which the 5-ball lab
  actually uses). The previous audit pass's "no dead code" note above
  missed this one file — traced the full require graph this pass to confirm
  it's the only orphan.
- Fixed two stale "28 engines" comments (`store.js`, `council.js`) and one
  in this README — the real count is 34 (11 General/3-Ball + 14 Four-Ball +
  9 Five-Ball Lab) since the 4-Ball roadmap and Phase 6-8 additions.
- Re-added the `GET /api/history` route (recommendationLog joined against
  historicalDraws by drawId, plus 10/30/100-draw accuracy windows) — it
  existed in an earlier working copy of this project but wasn't present in
  this export; the dashboard's Draw History / Performance panels depend on
  `recommendationLog`, which no other route exposes.
- Fixed the dashboard's engine tab bar: "3BALL (11)" and "4BALL (14)" were
  hardcoded text, unlike the "ALL ENGINES" and "5BALL LAB" tabs next to them
  which already read live vote counts. Both now read
  `parliaments.general.votes.length` / `parliaments.fourBall.votes.length`
  the same way, so the tab bar can't go stale again if the engine roster
  changes.
- Full syntax check across all 44 backend files (34 engine/core/parliament/
  supreme/route files + server/config) and the dashboard's embedded script:
  clean.
- End-to-end pipeline test with live-ingested data (150 synthetic draws):
  verified every new 5-ball lab field (`gapDistribution`,
  `crossTierProgression`, `suppressionIntelligence`, `rivalPressure`,
  `temporalIntelligence`, `eventClusters`, `unifiedPrediction`) renders
  correctly on the dashboard with real per-color values, zero runtime
  console errors, and all 34 engine cards present and correctly filterable
  by council.

---

## Audit Notes (previous pass)

- Full syntax check across all 34 backend files and the frontend's embedded
  script: clean.
- End-to-end pipeline test (ingest → validation → dedup → parliaments →
  arbitration → meta-intelligence → Supreme Council → persistence → restart
  reload): verified working, including duplicate `drawId` rejection and
  correct state recovery after a simulated process restart.
- No dead code, TODOs, or unresolved stubs found in the backend.

---

## Blueprint Phases 9-10 (this pass)

Two new engines added, following the same pure-function,
full-recomputation-every-call convention as every other 5-ball lab engine
(see rareEventLabEngine.js's header comment for why these aren't made
incremental):

- **`src/engines/temporalIntelligenceEngine.js`** (Phase 9 — Temporal
  Intelligence): reads each draw's real `timestamp` field (already
  present via validator.js, previously stored but never analyzed) to
  detect hour-of-day/session clustering, day-of-week and weekend-vs-
  weekday skew, overall draw velocity, and per-color burst detection —
  all against each color's own historical distribution, with sample
  sizes reported alongside every figure. During testing, found and fixed
  a real bug in the first draft: `detectRecentBurst`'s z-score path
  silently reported "no burst" whenever a color's prior inter-arrival
  gaps had zero variance (a leftover expression in the return statement
  ignored the ratio-based fallback meant to handle that case) — fixed
  and verified against both the zero-variance and normal-variance paths.
- **`src/engines/eventClusterEngine.js`** (Phase 10 — Knowledge
  Clustering): scores each color's current moment against the seven
  named archetypes from the blueprint (Momentum Explosion, Compression
  Release, Late Cycle Return, Short Gap Repeat, Long Gap Recovery, Tier
  Escalation, Pressure Release), reusing the already-computed outputs of
  the Phase 3/5/6/7/8 engines rather than deriving any new statistics of
  its own. Returns every archetype's fit score ranked, not a forced
  single label, since a moment can genuinely match more than one pattern
  at once.

Both are wired into `rareEventLabEngine.js`'s per-cycle update sequence
and surfaced as informational fields (`temporalIntelligence`,
`eventClusters`) on `fiveBallLabParliament.js`'s return value — on both
the OBSERVING and ACTIVATED status paths, not gated behind qualification,
since they're observations about the raw draw history rather than part
of the qualification-gated forecast itself. `store.js` carries their
state in `fiveBallLab` alongside the Phase 6-8 fields, with matching
reset behavior in `resetStore()`.

**Not yet voting engines.** Unlike the Phase 6-8 additions
(`5B_Progression`/`5B_Suppression`/`5B_RivalPressure`), Phase 9 and 10 do
not currently cast votes in `fiveBallLabParliament.js`'s consensus
mechanism — they're intended as direct inputs to the Blueprint's Phase 11
unified prediction engine (not yet built), which will read them alongside
every other engine's output to produce one explainable confidence score
per color, rather than each becoming an independent vote with its own
weight/precision tracking in `store.js`.

**Verified this pass:** full syntax sweep (clean), unit tests against
each new engine in isolation (empty history, null-input safety,
zero-variance edge cases, single-dominant-color scenarios, genuine
positive-signal scenarios for every archetype including the
release-probability path), and a full end-to-end smoke test — booted the
real server, ingested 700+ synthetic draws with real timestamps through
the actual HTTP `/api/draws` endpoint, confirmed both new fields appear
correctly on `/api/snapshot` in both OBSERVING and ACTIVATED lab states,
confirmed state survives a simulated process restart, and confirmed
`/api/reset` correctly clears both new fields back to their empty state.

---

## Blueprint Phase 11 — Unified Prediction Engine (this pass)

**`src/engines/unifiedPredictionEngine.js`**: implements the blueprint's
exact composition formula —

```
Gap Score + Runway Score + Progression Score + Pressure Score +
Suppression Score + Similarity Score + Cluster Score + Season Score +
Session Score  ->  Confidence
```

— producing one explainable confidence per color plus an overall top
pick. Every component is read from a Phase 1-10 engine that already
computes it; this module derives no new statistics of its own:

| Component | Source |
|---|---|
| Gap Score | `gapDistribution[color].forecast.gapRiskScore` (Phase 5), direct |
| Runway Score | Composite of `runwayFeatureEngine`'s (Phase 3) `momentumSlope`, `compressionScore`, `rollingDensity`, `tierLadderScore` — no single scalar existed, so this blends the four dimensions that most directly answer "is this color's runway building right now" |
| Progression Score | `crossTierProgression.perColor[color].ladderScore` (Phase 6), direct |
| Pressure Score | `rivalPressure.rivalOutlook[color].releaseProbability` (Phase 8), direct — neutral when no dominance is active or for the dominant color itself (the concept doesn't apply) |
| Suppression Score | Derived from `suppressionIntelligence[color]`'s (Phase 7) classification + recovery velocity/momentum, same formula `fiveBallLabParliament.js`'s own `suppressionPick()` already uses, for consistency |
| Similarity Score | `matchSignatures(...).perColor[color].predictionConfidence` (Phase 4's real cosine-similarity engine, NOT the older binary-comparison wrapper) |
| Cluster Score | `eventClusters.perColor[color].primaryScore` (Phase 10), direct |
| Season Score | The 4-ball parliament's `seasonIntelligence.heat` (roadmap item), only for whichever color currently holds the active 4-ball season — genuinely not applicable to the other two colors |
| Session Score | Derived from Phase 9's `temporalIntelligence.perColor[color].clustering.peakSession`, comparing the CURRENT session (via the engine's own `sessionForHour`) against this color's own historical peak session, scaled by that skew's z-score |

**Weighting:** all nine components are weighted equally (1/9). The
blueprint doesn't specify differential weights, and choosing unequal
weights without supporting evidence would be exactly the kind of
fabricated-looking number this codebase's other engines have
deliberately avoided (see `knowledgeConfidenceEngine.js`'s header
comment). `store.engineWeights` already exists for calibrating specific
weights later from real outcome data, without needing to change this
module's shape.

**Neutral fallback, not zero:** a component with no real signal yet for
a given color (e.g. gap distribution with zero historical gaps, season
score for a color that doesn't hold the 4-ball season) contributes a
neutral 50, not 0 or 100 — "no evidence" isn't the same claim as "strong
negative/positive evidence," and scoring it as an extreme would silently
bias the blend. Each color's result reports `neutralFallbackCount` (how
many of the 9 components fell back) so a 50 from genuine absence of data
is never silently indistinguishable from an actual mid-range reading.

**Wiring:** computed unconditionally every update cycle in
`rareEventLabEngine.js` (same "always surfaced, not gated behind
qualification" treatment as Phases 9-10), stored on
`store.fiveBallLab.unifiedPrediction`, and surfaced on
`fiveBallLabParliament.js`'s return value on both the OBSERVING and
ACTIVATED paths. Needed the 4-ball parliament's result for the Season
Score component, so `runFiveBallLabParliament()` now accepts
`fourBallParliament` as a second argument — `council.js` already computed
`fourBallP` before `fiveBallP` in its existing call order, so this
required no reordering, just threading the value through.

**Bug fixed while wiring this in:** `rareEventLabEngine.js` was calling
the legacy `captureAndMatchSignatures` wrapper (a thin pass-through to
`signatureVectorEngine.matchSignatures`) only inside the
qualified-and-window-expired branch, meaning per-color similarity data
was only ever computed on the (comparatively rare) draws that opened a
new prediction window. Phase 11 needs a fresh per-color similarity
breakdown every single cycle, so signature matching is now computed
once per cycle unconditionally and the existing window-opening logic
reuses that same result instead of recomputing it a second time.

**Not yet voting.** Like Phase 9-10, `unifiedPrediction` is an
explanatory composite surfaced as data, not an additional vote in
`fiveBallLabParliament.js`'s consensus mechanism — it reads the votes'
underlying signals rather than sitting alongside them as a tenth
opinion.

**Verified this pass:** full syntax sweep (clean, including the
frontend's embedded script); unit-tested `computeUnifiedPrediction` in
isolation against a completely empty/null lab (confirmed all 9
components correctly report neutral fallback, confidence lands at
exactly 50, explanation correctly states "9/9 components used a neutral
fallback"); full end-to-end smoke test — booted the real server,
ingested 300 then 900 synthetic draws with realistic tier distributions
through the actual `/api/v1/collector` endpoint, confirmed
`unifiedPrediction` populates with genuinely differentiated per-color
component values (not identical/fabricated-looking numbers) in both the
OBSERVING and ACTIVATED lab states, confirmed the field is reachable via
both `fiveBallLaboratory.unifiedPrediction` and
`parliaments.fiveBallLab.unifiedPrediction` on `/api/snapshot`, confirmed
state survives a simulated process restart, confirmed `/api/reset`
correctly clears history and the next snapshot recomputes a fresh
mostly-neutral state, and confirmed duplicate-`drawId` rejection and
every previously-audited pipeline stage (decision trace, enriched engine
votes, engineStats/engineWeights exposure) still function correctly
alongside the new engine.

---

## Color Parliament Port — 3-Ball Last Stand, 4-Ball Last Stand, Alam System

Ported from a separate project ("Color Parliament") at the user's request,
with an explicit requirement to maintain exact logic and performance
behavior. Three files are byte-for-byte copies (verified via `diff`,
zero differences):

- `src/engines/threeBallLastStandCP.js` — 3-color battle-status detector
  (LEADER_DEFENDING / LEADER_WEAKENING / LAST_STAND / TRANSITION_BATTLE /
  LEADER_COLLAPSING) over the continuous 3-ball draw stream. Fully
  self-contained, no external dependencies, no season concept.
- `src/engines/fourBallLastStandCP.js` — the 4-ball counterpart. Same
  battle-status vocabulary, but blends live momentum with an accumulated
  season leaderboard (`archiveState`) and gates on an active 4-ball
  season, exactly mirroring the 3-ball engine's approach per its own
  header comment.
- `src/engines/alamSystemCP.js` — the Alert / Last-stand Alert Monitor
  that watches both engines above and turns a LAST_STAND detection on
  either into one aggregated warning. Pure formatting/aggregation, no
  prediction math of its own.

The `CP` suffix distinguishes these from Sniper V4's own, unrelated,
much simpler `lastStandEngine.js` (a single-function 4-ball season-decay
heuristic used by `fourBallParliament.js`) — the two are intentionally
kept completely separate; nothing about the existing engine was touched.

### The archive dependency problem

`fourBallLastStandCP.js` needs an `archiveState` — a persistent season
leaderboard built by `strategicEngine.js`'s `wake()`/`recordHit()`/
`closeSeason()` — that only exists in Color Parliament's architecture.
Sniper V4 has no equivalent: its own 4-ball season view
(`tacticalEngine.js`'s `reconstructedSeasonAge`) recomputes a season-age
estimate fresh from scratch on every call, with no persistent hit-weighted
leaderboard, no dominant-color stickiness logic, and no season-close
archival. The two models are genuinely different, not just
differently-shaped views of the same data.

Given the "maintain exact logic and performance behavior" requirement,
adapting `fourBallLastStandCP.js` to Sniper V4's simpler model would have
changed its actual output — so instead:

- `src/engines/strategicEngineCP.js` — byte-for-byte copy of Color
  Parliament's `strategicEngine.js` (the archive/leaderboard engine
  itself: hit-weighting by real match strength, dominant-color
  stickiness on ties, leader stability, challenger pressure, leadership
  decay, season archival).
- `src/engines/colorParliamentSeasonAdapter.js` — new adapter. Replays
  Sniper V4's own `store.historicalDraws` through Color Parliament's
  **exact original** season activation (rolling 10-draw window) and
  termination (15-consecutive-no-hit) rules — copied verbatim from
  `tacticalEngine.js`'s "HARDCODED, do not modify" functions — calling
  `strategicEngineCP.js`'s `wake()`/`recordHit()`/`closeSeason()` in the
  exact same per-draw sequence Color Parliament's own `engine.js` runs on
  real-time ingest. The result is an `archiveState` that behaves
  identically to what the original project would have produced given the
  same draw sequence, without touching Sniper V4's own season/prediction
  pipeline at all.
- `src/engines/colorParliamentLastStand.js` — wires all three ported
  engines together against `store.historicalDraws`, handling the
  draw-shape and ordering translation (Sniper V4 stores newest-first with
  `.threeBallColor`/`.fourBallColor`/`.colorCounts`; every Color
  Parliament engine assumes oldest-first `{drawId, color, timestamp,
  matchCount}` — reversed and mapped once per call, real `colorCounts`
  data feeding `matchCount` rather than a fabricated default).
- New route: `GET /api/color-parliament/last-stand` → `{ threeBall,
  fourBall, alam }`.

This is recomputed fresh on every call (same O(n)-per-call tradeoff this
codebase already accepts elsewhere, e.g. `rareEventLabEngine.js`) rather
than hooked into the ingest pipeline incrementally, since Sniper V4 has
no existing per-ingest hook for this without touching its core pipeline —
out of scope for a port whose whole point was to leave everything else
untouched.

**Verified — logic fidelity:** ran the identical synthetic draw sequence
through (a) the adapter + ported engines inside Sniper V4, and (b) the
original, completely unmodified Color Parliament engines directly (same
sequence, translated by hand into Color Parliament's own draw shape).
Compared full `archiveState` (leaderboard, hit weighting including a
6-of-6 super-hit, dominant-color tracking) and the final
`fourBallLastStand` result field-by-field — **byte-for-byte identical
output** in both cases. Also verified the full close-season → archive →
new-season-activate lifecycle (forced a 15-draw no-hit termination
mid-test) produces a correctly archived `history[]` entry with the full
final leaderboard preserved, and a fresh archive for the new season.

**Verified — integration:** full end-to-end HTTP test against the real
server — 200 real draws through `/api/v1/collector`, zero ingest errors,
`/api/color-parliament/last-stand` returning 200 with genuinely
differentiated, correctly-reasoned output for both engines and correct
Alam aggregation (confirmed `LEADER_COLLAPSING` on the 4-ball side
correctly does NOT trigger an Alam alert, since Alam specifically watches
for `LAST_STAND`, not every non-defending status — matching the original
`alamSystem.js` logic exactly). Pushed to 1500 draws in history: route
still responds in ~12ms, no performance regression. Full regression
check: every pre-existing route (`/`, `/api/snapshot`,
`/api/meta-intelligence`, `/api/5ball-lab`) still returns 200 alongside
the new route. Full project syntax sweep: clean.


## First Appearance Engine — timing upgrade

The 4-Ball First Appearance Engine now produces an explicit empirical timing forecast instead of only a breakout score. For the leading dormant color it reports:

- `approximatelyDraws` — point estimate: approximately how many draws until the next 4-ball appearance.
- `forecastWindow` — lower/upper draw window around the point estimate.
- `timingConfidence` — confidence in the timing estimate based on historical gap samples and consistency.
- `probabilityNext5Draws`, `probabilityNext10Draws`, `probabilityNext20Draws` — empirical horizon probabilities when enough conditional samples exist.
- `historicalGap` — average, median, recent average, sample count and conditional sample count.

The timing model uses conditional residual-life analysis: it asks how long a color historically took to return after surviving to the same dormancy age, then blends that with median and recent-gap behaviour. 3-ball precursor activity and transition pressure can pull the forecast earlier, but cannot override the empirical gap model.

The dashboard now surfaces **Next Appearance ~N draws**, **Forecast Window**, and **Timing Confidence** directly in the First Appearance panel.
