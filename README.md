# SNIPER_V4 PRO v6.2 — Autonomous Parliamentary Intelligence Platform

> **5-Ball side removed.** The whole 5-Ball Research Lab (harvester, research, learning, validation, shadow/live prediction, next-event, dual-color engines and paper traders), its `/api/five-ball*` routes, its store/persistence state, the dashboard's 5-Ball tab, the `fiveBallColor` draw field and the Phase 9-11 intelligence-lab files that only fed it are gone. 4-Ball logic is unchanged: a 5- or 6-ball draw still counts as a 4-ball event (`fourBallColor` = any colour with 4 or more balls). Old saved snapshots that contain 5-ball keys load fine; those keys are ignored.

## System Overview & Architecture
**SNIPER_V4 PRO v6.2** is an autonomous parliamentary intelligence platform strictly designed for the 3-color game (**RED**, **BLUE**, **GREEN**).

It features **22 independent, autonomous analytical engines** across two parliamentary chambers governed by an overarching **Meta-Intelligence Layer**:

1. **General Parliament (3Ball - 11 Engines)**: `3B_Momentum`, `3B_Cycle`, `3B_DNA`, `3B_Probability`, `3B_Transition`, `3B_Recovery`, `3B_Pattern`, `3B_Gap`, `3B_Confidence`, `3B_CapitalProtection`, `3B_Dominance`.
2. **4Ball Parliament (11 Engines)**: `4B_SeasonStrength`, `4B_EntryIntel`, `4B_ExitIntel`, `4B_FirstAppearance`, `4B_LastStand`, `4B_TransitionRisk`, `4B_CapitalProtection`, `4B_DNA`, `4B_Lifecycle`, `4B_Recovery`, `4B_Dominance`.
3. **Meta-Intelligence Layer (Supreme Goverance)**:
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
    │   ├── dnaMatchingEngine.js          # Vector cosine similarity matching
    │   ├── entryIntelligenceEngine.js    # Entry quality & trading tiers
    │   ├── firstAppearanceEngine.js      # Dormant color breakthrough math
    │   ├── gapEvolutionEngine.js         # Mean, median, variance & overdue z-score
    │   ├── knowledgeConfidenceEngine.js # 6-criterion qualification gate (70% req.)
    │   ├── lastStandEngine.js            # Dominance decay & terminal burst math
    │   ├── lifecycleEngine.js            # 7-phase season lifecycle model
    │   ├── markovEngine.js               # 2nd-order Markov & Hidden Markov regimes
    │   ├── marketResearchEngine.js       # Leadership tables & research reports
    │   ├── shannonEntropy.js             # Systemic entropy & regime classifier
    │   └── tacticalEngine.js             # Historical season age reconstruction
    ├── parliaments/
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
- **Coalition Groups** — live engine counts by category (Momentum / Recovery / DNA), computed from real vote data across both parliaments
- **Hero Prediction Card** — recommended color, action, confidence gauge; glows purple on anomaly override, green otherwise
- **Event Bus Pipeline** — visual flow indicator that pulses on every successful data refresh
- **Decision Reasoning Trace** — a genuine step-by-step trace (Ingest → Parliaments → Arbitration → Meta-Intelligence → Supreme Council) built from real computed values at each pipeline stage
- **Engine Parliament Grid** — all engines with real per-engine weight, risk, status LED, and last-activation time
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
   grouping engines by category keyword in their name across both parliaments.
3. **4Ball Transition Risk was computed internally but never exposed.**
   `src/parliaments/fourBallParliament.js` now returns a top-level `transitionRisk`
   field; the dashboard wires it to the season panel.
4. **Engine vote objects never carried `weight`, `risk`, `status`, or `lastHit`.**
   Every engine card would have silently shown identical fallback values
   regardless of real performance. `src/supreme/council.js` now enriches every
   vote from both parliaments with real data from `store.engineWeights`
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

## Audit Notes (previous pass)

- Full syntax check across all 34 backend files and the frontend's embedded
  script: clean.
- End-to-end pipeline test (ingest → validation → dedup → parliaments →
  arbitration → meta-intelligence → Supreme Council → persistence → restart
  reload): verified working, including duplicate `drawId` rejection and
  correct state recovery after a simulated process restart.
- No dead code, TODOs, or unresolved stubs found in the backend.

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
`/api/meta-intelligence`) still returns 200 alongside
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
