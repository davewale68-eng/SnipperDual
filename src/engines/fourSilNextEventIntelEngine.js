/**
 * 4SIL NEXT EVENT INTELLIGENCE ENGINE (4SIL-NEI) — v2.0
 *
 * PURPOSE
 * -------
 * Downstream timing analyst, not another 4SIL gate. Its single question:
 *
 *   "Now that 4SIL is active, based on how previous 4SIL ENTER calls and
 *    paper-trader executions behaved, how soon should the next 4-ball
 *    event occur?"
 *
 * It predicts an event of ANY color (color-agnostic, same convention as
 * fourBallEnterCallLog.js / paperTraderEngine.js). It never predicts
 * RED/BLUE/GREEN specifically.
 *
 * THREE INTELLIGENCE INPUTS
 * --------------------------
 * INTEL 1 -- 4SIL operator state (the hard eligibility gate; this engine
 *            never modifies 4SIL and never feeds back into it -- see
 *            ABSOLUTE SEPARATION RULE below).
 * INTEL 2 -- fourBallEnterCallLog.js's closed-call history:
 *            a) ENTER -> first-event latency (per-call, independent)
 *            b) event -> event spacing within the same call
 *            Both latencies and spacings are FIRST-CLASS forecast inputs.
 * INTEL 3 -- paperTraderEngine.js's trade log: per-ENTER-call latency
 *            measured as trades consumed before the first HIT of that call
 *            (each call is measured independently, not as a continuous
 *            sequence -- see collectPaperTraderTiming for detail).
 *
 * FUSED PROBABILITY DISTRIBUTION
 * --------------------------------
 * Rather than deriving confidence from sample-size heuristics, v2.0 builds
 * a true posterior probability distribution over draw buckets by combining
 * the Call History latency distribution, the event-spacing distribution,
 * and the Paper Trader per-call latency distribution.  The fused P(event
 * within range) is what drives confidence, primaryDraw, and expectedRange
 * so all three outputs are internally consistent.
 *
 * CONDITIONAL SIGNATURE PROFILES
 * --------------------------------
 * v2.0 stratifies call history by the 4SIL signal characteristics at call
 * open time (gate combination, confidence tier, TP presence, season stage).
 * When a new call opens with similar characteristics, the matching
 * signature profile's distribution is promoted (higher weight) in the
 * fusion, giving contextually-aware timing intelligence beyond a flat
 * historical average.
 *
 * ABSOLUTE SEPARATION RULE
 * -------------------------
 * "The Next Event Engine has no voice until 4SIL speaks." This engine:
 *   - never votes in arbitration/metaIntelligence,
 *   - never changes any 4SIL gate, threshold, or weight,
 *   - never vetoes or manufactures an ENTER,
 *   - is a pure, read-only, observational consumer of 4SIL +
 *     fourBallEnterCallLog + paperTrader output.
 *
 * GATING
 * ------
 *   4SIL.active === false          -> DORMANT (no forecast at all)
 *   4SIL.active === true, no open
 *     ENTER call right now         -> ARMED_WAITING
 *   4SIL.active === true, ENTER
 *     call currently open          -> ARMED_TRACKING
 *
 * EVALUATION LOOP
 * ----------------
 * When a new ENTER call opens this engine snapshots ONE forecast for that
 * call and holds it fixed (does not keep re-guessing mid-call). When that
 * call closes the frozen forecast is graded against what actually happened
 * and logged to state.evaluations. This log feeds NOTHING back into 4SIL.
 *
 * Must be called AFTER advanceFourBallEnterCallLog() and
 * advancePaperTrader() each council cycle.
 */
'use strict';

const { mean, median, mode, percentile } = require('../core/statMath');

const MAX_EVALUATION_LOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

const DEFAULT_FUSION_WEIGHTS = {
  callHistory:    0.30,   // ENTER->first-event latency distribution
  eventSpacing:   0.20,   // event->event spacing distribution (now first-class)
  paperTrader:    0.25,   // per-call ENTER->HIT latency distribution
  signature:      0.15,   // matching signature profile distribution
  recentMomentum: 0.10    // recency-weighted mean adjustment
};

const RECENCY_BUCKETS = [
  { take: 10, weight: 1.0 },
  { take: 25, weight: 0.7 },
  { take: 50, weight: 0.4 }
];

// Timing state ladder driven by window probability (P(event in range)) rather
// than a heuristic confidence score.  Thresholds are 0-100 probability pcts.
const TIMING_LADDER = [
  { min: 80, state: 'IMMEDIATE'   },
  { min: 65, state: 'NEAR'        },
  { min: 50, state: 'APPROACHING' },
  { min: 35, state: 'DEVELOPING'  },
  { min: 0,  state: 'NO_FORECAST' }
];

// Signal-tier bucketing for signature profiles.  Matches 4SIL confidence
// ranges common across this codebase (conservative, balanced, aggressive).
const SIGNATURE_CONFIDENCE_TIERS = [
  { label: 'HIGH',   min: 75 },
  { label: 'MEDIUM', min: 50 },
  { label: 'LOW',    min: 0  }
];

function defaultConfig() {
  return {
    fusionWeights: { ...DEFAULT_FUSION_WEIGHTS },
    timingLadder:  TIMING_LADDER.map(t => ({ ...t }))
  };
}

// ---------------------------------------------------------------------------
// Persistent state factory
// ---------------------------------------------------------------------------

function freshFourSilNextEventIntelState(config) {
  return {
    schemaVersion:        2,
    config:               { ...defaultConfig(), ...(config || {}) },
    activePrediction:     null,
    lastSeenOpenCallId:   null,
    lastEvaluatedCallId:  null,
    evaluations:          [],  // newest-first graded predictions
    signatureProfiles:    {},  // keyed by signature label
    updatedAt:            null
  };
}

function ensureStateShape(persistentState) {
  const fresh = freshFourSilNextEventIntelState();
  const s = persistentState && typeof persistentState === 'object' ? persistentState : fresh;
  if (!s.schemaVersion || s.schemaVersion < 2) s.schemaVersion = 2;
  s.config              = { ...fresh.config, ...(s.config || {}) };
  // Merge nested fusionWeights so callers that stored only some keys keep
  // valid defaults for the ones added in v2.
  s.config.fusionWeights = { ...DEFAULT_FUSION_WEIGHTS, ...(s.config.fusionWeights || {}) };
  if (typeof s.activePrediction    === 'undefined') s.activePrediction    = null;
  if (typeof s.lastSeenOpenCallId  === 'undefined') s.lastSeenOpenCallId  = null;
  if (typeof s.lastEvaluatedCallId === 'undefined') s.lastEvaluatedCallId = null;
  if (!Array.isArray(s.evaluations))               s.evaluations          = [];
  if (!s.signatureProfiles || typeof s.signatureProfiles !== 'object') s.signatureProfiles = {};
  if (typeof s.updatedAt === 'undefined')          s.updatedAt            = null;
  return s;
}

// ---------------------------------------------------------------------------
// INTEL 2a -- Call History: ENTER->first-event latency  (independent per call)
// INTEL 2b -- Call History: event->event spacing        (first-class input)
// ---------------------------------------------------------------------------

/**
 * Returns two separate latency arrays, both oldest-first:
 *   latencies : ENTER openDrawId -> first 4-ball event drawId (one per call
 *               that had at least one event).  Each call contributes exactly
 *               one latency -- independent and not contaminated by the next
 *               call's opening (contrast with v1's paper-trader approach).
 *   spacings  : event->event spacing within the same call (only calls with
 *               >=2 events contribute entries).  These are now a first-class
 *               forecast input rather than a collected-but-unused statistic.
 */
function collectCallHistoryTiming(closedCalls) {
  const latencies = [];
  const spacings  = [];

  // closedCalls is newest-first; reverse to oldest-first for correct
  // recency ordering (most-recent latencies at the END of the array).
  const chronological = (closedCalls || []).slice().reverse();

  for (const call of chronological) {
    const events = Array.isArray(call.eventDrawIds) ? call.eventDrawIds : [];
    if (events.length === 0) continue;

    const openId      = Number(call.openDrawId);
    const firstEvId   = Number(events[0].drawId);
    if (Number.isFinite(openId) && Number.isFinite(firstEvId)) {
      latencies.push(Math.max(1, firstEvId - openId));
    }

    // Event-to-event spacing -- first-class input in v2
    for (let i = 1; i < events.length; i++) {
      const prev = Number(events[i - 1].drawId);
      const curr = Number(events[i].drawId);
      if (Number.isFinite(prev) && Number.isFinite(curr)) {
        spacings.push(Math.max(1, curr - prev));
      }
    }
  }

  return {
    latencies,
    spacings,
    callsWithEvents:   latencies.length,
    totalClosedCalls:  (closedCalls || []).length
  };
}

// ---------------------------------------------------------------------------
// INTEL 3 -- Paper Trader: per-ENTER-call latency (truly independent calls)
// ---------------------------------------------------------------------------

/**
 * v1 maintained a single running `sinceLastHit` counter across ALL ENTER
 * trades, which measured event-arrival spacing during an ENTER trading
 * regime (valuable, but different from ENTER-call latency).
 *
 * v2 measures the latency of EACH ENTER call independently:
 *   - Walk the trade log chronologically.
 *   - Track the current call boundary using drawId discontinuities or
 *     a MONITOR/PREPARE/PAUSE break between ENTER trades (a new ENTER
 *     run after a non-ENTER signal is a new call).
 *   - Record trades-to-first-HIT for each call separately.
 *
 * This aligns Paper Trader latency with Call History latency so the two
 * distributions are statistically comparable and can be fused correctly.
 */
function collectPaperTraderTiming(trades) {
  const latencies = [];

  // trades is newest-first; reverse to oldest-first.
  const chronological = (trades || []).slice().reverse();

  let inEnterRun       = false;
  let callTradeCount   = 0;
  let callHitFound     = false;

  for (const t of chronological) {
    if (t.signal !== 'ENTER') {
      // Non-ENTER signal = call boundary.  If we were in an ENTER run that
      // ended without a hit, we do NOT record a latency (no event = no data
      // point for latency, matching Call History's convention of only logging
      // calls that contained an event).
      if (inEnterRun && callHitFound) {
        // already recorded at HIT time below
      }
      inEnterRun    = false;
      callTradeCount = 0;
      callHitFound   = false;
      continue;
    }

    // ENTER trade
    if (!inEnterRun) {
      // New call starts
      inEnterRun     = true;
      callTradeCount = 0;
      callHitFound   = false;
    }

    callTradeCount++;

    if (t.result === 'HIT' && !callHitFound) {
      // First HIT of this call -- record the latency and close this call's
      // measurement (the same ENTER call may continue trading after a HIT
      // for ladder/window reasons, but the TIMING question is answered).
      latencies.push(callTradeCount);
      callHitFound = true;
      // Do NOT reset inEnterRun -- we stay in the run until a non-ENTER
      // signal appears, but further HITs in this call are not re-counted.
    }
  }

  return {
    latencies,
    totalTrades: (trades || []).length
  };
}

// ---------------------------------------------------------------------------
// Distribution + statistics helpers
// ---------------------------------------------------------------------------

function weightedRecentMean(latencies) {
  if (!latencies || latencies.length === 0) return null;
  // latencies is oldest-first; most-recent = end of array = heaviest bucket.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const bucket of RECENCY_BUCKETS) {
    const slice = latencies.slice(Math.max(0, latencies.length - bucket.take));
    for (const v of slice) {
      weightedSum += v * bucket.weight;
      weightTotal += bucket.weight;
    }
  }
  return weightTotal === 0 ? mean(latencies) : weightedSum / weightTotal;
}

/**
 * Build a probability mass function (PMF) over draw buckets 1,2,3,4,5+.
 * Returns both absolute counts and probability estimates (P(X=k)) so the
 * fusion step can compute P(event within range) directly.
 */
function buildPMF(latencies) {
  if (!latencies || latencies.length === 0) return null;
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
  for (const v of latencies) {
    if      (v <= 1) counts[1]++;
    else if (v === 2) counts[2]++;
    else if (v === 3) counts[3]++;
    else if (v === 4) counts[4]++;
    else              counts['5+']++;
  }
  const n = latencies.length;
  const p = k => Math.round((counts[k] / n) * 1000) / 10;
  return {
    sampleSize: n,
    draw1Pct:   p(1),
    draw2Pct:   p(2),
    draw3Pct:   p(3),
    draw4Pct:   p(4),
    draw5PlusPct: p('5+'),
    // Cumulative probabilities for window calculations
    cdf: {
      byDraw1: p(1),
      byDraw2: p(1) + p(2),
      byDraw3: p(1) + p(2) + p(3),
      byDraw4: p(1) + p(2) + p(3) + p(4)
    }
  };
}

// `raw` retained on the stat object so fuseForecast can work with percentile
// spread and the API can expose the underlying sample for audit.
function timingStat(latencies) {
  const raw = latencies || [];
  if (raw.length === 0) {
    return { sampleSize: 0, mean: null, median: null, mode: null,
             recentMean: null, pmf: null, raw: [] };
  }
  const rm = weightedRecentMean(raw);
  return {
    sampleSize:  raw.length,
    mean:        Math.round(mean(raw) * 100) / 100,
    median:      median(raw),
    mode:        mode(raw),
    recentMean:  rm != null ? Math.round(rm * 100) / 100 : null,
    pmf:         buildPMF(raw),
    raw
  };
}

// ---------------------------------------------------------------------------
// Signature profiles
// ---------------------------------------------------------------------------

/**
 * Derive a compact signature label from the 4SIL state at call open time.
 * Label encodes: confidence tier + TP presence + season-stage bucket.
 * This is the key used to store/retrieve conditional timing profiles.
 *
 * fourSIL may be null/undefined for legacy evaluations; returns 'UNKNOWN'
 * so those records still update the aggregate profile gracefully.
 */
function deriveSignatureLabel(fourSIL) {
  if (!fourSIL) return 'UNKNOWN';

  // Confidence tier
  const conf        = typeof fourSIL.confidence === 'number' ? fourSIL.confidence : -1;
  const confTier    = SIGNATURE_CONFIDENCE_TIERS.find(t => conf >= t.min);
  const tierLabel   = confTier ? confTier.label : 'LOW';

  // TP presence (does the badge show a Take-Profit gate active?)
  const hasTP       = Boolean(
    fourSIL.badge && (fourSIL.badge.tpActive || fourSIL.badge.takeProfitActive)
  );
  const tpLabel     = hasTP ? 'TP' : 'NOTP';

  // Season stage bucket derived from draw count within active season.
  // If not available fall back to UNKNOWN_STAGE.
  const seasonDraws = (fourSIL.seasonDraws != null)
    ? Number(fourSIL.seasonDraws)
    : (fourSIL.badge && fourSIL.badge.seasonDraws != null
        ? Number(fourSIL.badge.seasonDraws)
        : NaN);
  let stageLabel;
  if (!Number.isFinite(seasonDraws)) stageLabel = 'STAGE_X';
  else if (seasonDraws <= 20)        stageLabel = 'STAGE_EARLY';
  else if (seasonDraws <= 60)        stageLabel = 'STAGE_MID';
  else                               stageLabel = 'STAGE_LATE';

  return `${tierLabel}_${tpLabel}_${stageLabel}`;
}

/**
 * After a call closes and is graded, update (or create) the signature
 * profile for the signal that was active when the call opened.  This
 * accumulates per-signature timing distributions for future forecasts.
 *
 * signatureLabel  -- from deriveSignatureLabel at call-open time
 * actualLatency   -- draws from ENTER to first event (null if no event)
 * profiles        -- state.signatureProfiles (mutated)
 */
function updateSignatureProfile(signatureLabel, actualLatency, profiles) {
  if (!signatureLabel || actualLatency == null) return;
  if (!profiles[signatureLabel]) {
    profiles[signatureLabel] = { latencies: [], updatedAt: null };
  }
  const p = profiles[signatureLabel];
  p.latencies.push(actualLatency);
  // Cap each profile at 200 observations (more than enough for a PMF).
  if (p.latencies.length > 200) p.latencies.shift();
  p.updatedAt = new Date().toISOString();
}

/**
 * Return a timingStat for the best-matching signature profile, or null if
 * the profile has fewer than MIN_SIGNATURE_SAMPLES data points.
 */
const MIN_SIGNATURE_SAMPLES = 5;

function matchingSignatureStat(signatureLabel, profiles) {
  if (!signatureLabel || !profiles) return null;
  const p = profiles[signatureLabel];
  if (!p || !Array.isArray(p.latencies) || p.latencies.length < MIN_SIGNATURE_SAMPLES) {
    return null;
  }
  return timingStat(p.latencies);
}

// ---------------------------------------------------------------------------
// Fused probability distribution builder
// ---------------------------------------------------------------------------

/**
 * Combine multiple PMFs into a single fused probability distribution.
 * Each source contributes according to its weight; sources with no data
 * (null pmf) are skipped and the remaining weights are re-normalized.
 *
 * Returns a fused PMF object with the same shape as buildPMF(), plus
 * `windowProbability(low, high)` -- the true P(event lands in [low,high]).
 */
function fusePMFs(sources) {
  // sources: Array of { pmf, weight }
  const keys    = ['draw1Pct', 'draw2Pct', 'draw3Pct', 'draw4Pct', 'draw5PlusPct'];
  const eligible = sources.filter(s => s.pmf != null && s.weight > 0);
  if (eligible.length === 0) return null;

  const totalW = eligible.reduce((sum, s) => sum + s.weight, 0);
  const fused  = {};
  for (const k of keys) {
    fused[k] = Math.round(
      eligible.reduce((sum, s) => sum + (s.pmf[k] || 0) * (s.weight / totalW), 0)
      * 10
    ) / 10;
  }

  // Recompute CDF from fused PMF for internal consistency
  fused.sampleSize = eligible.reduce((sum, s) => sum + (s.pmf.sampleSize || 0), 0);
  fused.cdf = {
    byDraw1: fused.draw1Pct,
    byDraw2: fused.draw1Pct + fused.draw2Pct,
    byDraw3: fused.draw1Pct + fused.draw2Pct + fused.draw3Pct,
    byDraw4: fused.draw1Pct + fused.draw2Pct + fused.draw3Pct + fused.draw4Pct
  };

  // Attach a helper so callers can query window probability directly.
  // low and high are 1-based draw numbers; 5+ is treated as draw 5.
  fused.windowProbability = function(low, high) {
    const clamp  = v => Math.max(1, Math.min(5, Math.round(v)));
    const lo     = clamp(low);
    const hi     = clamp(high);
    const drawPcts = {
      1: fused.draw1Pct,
      2: fused.draw2Pct,
      3: fused.draw3Pct,
      4: fused.draw4Pct,
      5: fused.draw5PlusPct
    };
    let total = 0;
    for (let d = lo; d <= hi; d++) {
      total += drawPcts[d] || 0;
    }
    return Math.round(total * 10) / 10; // percentage
  };

  return fused;
}

// ---------------------------------------------------------------------------
// Fusion + forecast  (v2: distribution-driven)
// ---------------------------------------------------------------------------

/**
 * Build a full forecast from available timing intelligence.
 *
 * Algorithm:
 * 1. Build individual PMFs from each intel stream.
 * 2. Fuse into a single probability distribution using configured weights.
 * 3. Derive primaryDraw as the modal bucket (highest probability) broken
 *    by ties toward the earlier draw (conservative).
 * 4. Derive expectedRange from the 50% credible interval (smallest window
 *    that captures >= 50% of the fused distribution).
 * 5. Derive windowProbability = P(event within expectedRange) from the
 *    fused PMF -- this IS the confidence metric.
 * 6. Map windowProbability to timingState via TIMING_LADDER.
 */
function fuseForecast(callStat, spacingStat, paperStat, sigStat, config) {
  const weights = (config && config.fusionWeights) || DEFAULT_FUSION_WEIGHTS;

  // -- Step 1: assemble PMF sources --
  const sources = [
    { pmf: callStat    && callStat.pmf,    weight: weights.callHistory    || 0 },
    { pmf: spacingStat && spacingStat.pmf, weight: weights.eventSpacing   || 0 },
    { pmf: paperStat   && paperStat.pmf,   weight: weights.paperTrader    || 0 },
    { pmf: sigStat     && sigStat.pmf,     weight: weights.signature      || 0 }
  ];

  const fusedPMF = fusePMFs(sources);

  if (!fusedPMF) {
    return {
      fusedLatency:       null,
      primaryDraw:        null,
      expectedRangeLow:   null,
      expectedRangeHigh:  null,
      windowProbability:  null,
      confidence:         0,
      timingState:        'NO_FORECAST',
      fusedPMF:           null
    };
  }

  // -- Step 2: primaryDraw = modal bucket --
  const bucketValues = [
    { draw: 1, pct: fusedPMF.draw1Pct    },
    { draw: 2, pct: fusedPMF.draw2Pct    },
    { draw: 3, pct: fusedPMF.draw3Pct    },
    { draw: 4, pct: fusedPMF.draw4Pct    },
    { draw: 5, pct: fusedPMF.draw5PlusPct}
  ];
  const primary = bucketValues.reduce(
    (best, b) => (b.pct > best.pct ? b : best), bucketValues[0]
  );
  const primaryDraw = primary.draw;

  // -- Step 3: expectedRange = 50% credible interval --
  // Find the smallest contiguous window of draw buckets that sums to >= 50%.
  // Try all windows of width 1, 2, 3, ... and take the first that qualifies,
  // preferring windows centered on primaryDraw.
  const drawOrder = [1, 2, 3, 4, 5];
  let expectedRangeLow  = primaryDraw;
  let expectedRangeHigh = primaryDraw;
  const pcts = { 1: fusedPMF.draw1Pct, 2: fusedPMF.draw2Pct, 3: fusedPMF.draw3Pct,
                 4: fusedPMF.draw4Pct,  5: fusedPMF.draw5PlusPct };
  let found = false;
  for (let width = 1; width <= 5 && !found; width++) {
    for (let start = 1; start <= 5 - width + 1 && !found; start++) {
      const end  = start + width - 1;
      let sum = 0;
      for (let d = start; d <= end; d++) sum += pcts[d] || 0;
      if (sum >= 50) {
        expectedRangeLow  = start;
        expectedRangeHigh = end;
        found = true;
      }
    }
  }
  if (!found) {
    // Fallback: full range
    expectedRangeLow  = 1;
    expectedRangeHigh = 5;
  }

  // -- Step 4: recency adjustment to fusedLatency (scalar summary) --
  // Compute a recency-weighted scalar estimate by blending recentMeans.
  const recentParts = [];
  const rw = weights.recentMomentum || 0;
  if (callStat  && callStat.recentMean  != null) recentParts.push({ v: callStat.recentMean,  w: rw * 0.4 });
  if (spacingStat && spacingStat.recentMean != null) recentParts.push({ v: spacingStat.recentMean, w: rw * 0.3 });
  if (paperStat && paperStat.recentMean  != null) recentParts.push({ v: paperStat.recentMean, w: rw * 0.3 });

  const allMeans = [
    callStat   && callStat.mean   != null ? callStat.mean   : null,
    spacingStat && spacingStat.mean != null ? spacingStat.mean : null,
    paperStat  && paperStat.mean  != null ? paperStat.mean  : null,
    sigStat    && sigStat.mean    != null ? sigStat.mean    : null
  ].filter(v => v != null);

  const baseMean = allMeans.length ? mean(allMeans) : primaryDraw;
  const recentW  = recentParts.reduce((s, p) => s + p.w, 0);
  const recentV  = recentW > 0
    ? recentParts.reduce((s, p) => s + p.v * p.w, 0) / recentW
    : baseMean;
  const fusedLatency = Math.round(
    (baseMean * (1 - (recentW || 0)) + recentV * (recentW || 0)) * 100
  ) / 100;

  // -- Step 5: windowProbability = P(event in expectedRange) --
  const windowProbability = fusedPMF.windowProbability(expectedRangeLow, expectedRangeHigh);

  // -- Step 6: timingState from windowProbability --
  const ladder = (config && config.timingLadder) || TIMING_LADDER;
  let timingState = 'NO_FORECAST';
  for (const rung of ladder) {
    if (windowProbability >= rung.min) { timingState = rung.state; break; }
  }

  return {
    fusedLatency,
    primaryDraw,
    expectedRangeLow,
    expectedRangeHigh,
    windowProbability,           // NEW in v2: true P(event in window)
    confidence: windowProbability, // alias kept for backward compat
    timingState,
    fusedPMF: {                  // expose the fused distribution for the API
      draw1Pct:     fusedPMF.draw1Pct,
      draw2Pct:     fusedPMF.draw2Pct,
      draw3Pct:     fusedPMF.draw3Pct,
      draw4Pct:     fusedPMF.draw4Pct,
      draw5PlusPct: fusedPMF.draw5PlusPct,
      sampleSize:   fusedPMF.sampleSize,
      cdf:          fusedPMF.cdf
    }
  };
}

// ---------------------------------------------------------------------------
// Grading (runs before season gate so calls closed via SEASON_INACTIVE
// are always evaluated)
// ---------------------------------------------------------------------------

function withAbsoluteDrawIds(openDrawId, forecastLike) {
  const anchor = Number(openDrawId);
  if (!Number.isFinite(anchor) || !forecastLike) return {};
  const toAbs = (offset) => (offset == null || !Number.isFinite(Number(offset))) ? null : anchor + Number(offset);
  return {
    primaryDrawId:       toAbs(forecastLike.primaryDraw),
    expectedDrawIdLow:   toAbs(forecastLike.expectedRangeLow),
    expectedDrawIdHigh:  toAbs(forecastLike.expectedRangeHigh)
  };
}

function gradeClosedCallIfAny(state, closedCalls, now) {
  const newestClosed = closedCalls[0];
  if (
    !newestClosed || newestClosed.callId == null ||
    newestClosed.callId === state.lastEvaluatedCallId ||
    !state.activePrediction || state.activePrediction.callId !== newestClosed.callId
  ) {
    return;
  }

  const events        = Array.isArray(newestClosed.eventDrawIds) ? newestClosed.eventDrawIds : [];
  const actualDrawId  = events.length > 0 ? Number(events[0].drawId) : null;
  const actualLatency = actualDrawId != null
    ? Math.max(1, actualDrawId - Number(newestClosed.openDrawId))
    : null;
  const pred          = state.activePrediction;
  const hitWithinWindow = actualLatency != null &&
    actualLatency >= pred.expectedRangeLow && actualLatency <= pred.expectedRangeHigh;

  // Update the signature profile for this call's signal characteristics.
  updateSignatureProfile(pred.signatureLabel, actualLatency, state.signatureProfiles);

  state.evaluations.unshift({
    callId:   newestClosed.callId,
    resolvedAt: now,
    signatureLabel: pred.signatureLabel || null,
    predicted: {
      primaryDraw:        pred.primaryDraw,
      expectedRangeLow:   pred.expectedRangeLow,
      expectedRangeHigh:  pred.expectedRangeHigh,
      windowProbability:  pred.windowProbability,
      confidence:         pred.confidence,
      timingState:        pred.timingState,
      // Absolute draw IDs, derived from this call's own openDrawId anchor
      // (offsets are frozen at forecast time; the anchor never changes,
      // so these are computed once here rather than re-derived later).
      openDrawId:         pred.openDrawId,
      primaryDrawId:      pred.primaryDrawId,
      expectedDrawIdLow:  pred.expectedDrawIdLow,
      expectedDrawIdHigh: pred.expectedDrawIdHigh
    },
    actual: {
      eventOccurred: events.length > 0,
      latency:       actualLatency,
      drawId:        actualDrawId,  // absolute draw ID the event actually landed on
      color:         events.length > 0 ? events[0].color : null  // stored for reference, not used in forecast
    },
    result: actualLatency == null ? 'NO_EVENT' : (hitWithinWindow ? 'HIT' : 'MISS')
  });

  if (state.evaluations.length > MAX_EVALUATION_LOG_ENTRIES) {
    state.evaluations.length = MAX_EVALUATION_LOG_ENTRIES;
  }
  state.lastEvaluatedCallId = newestClosed.callId;
  state.activePrediction    = null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {Object} fourSIL               this cycle's 4SIL result
 * @param {Object} fourBallEnterCallLog  store.fourBallEnterCallLog (advanced)
 * @param {Object} paperTrader           store.paperTrader (advanced)
 * @param {Object} persistentState       store.fourSilNextEventIntel (mutated)
 * @returns {Object} read-only summary for snapshot / dashboard / API
 */
function evaluateFourSilNextEventIntel(fourSIL, fourBallEnterCallLog, paperTrader, persistentState) {
  const state = ensureStateShape(persistentState);
  const now   = new Date().toISOString();

  const seasonActive = Boolean(fourSIL && fourSIL.active);

  const closedCalls = (fourBallEnterCallLog && fourBallEnterCallLog.log)
    || (fourBallEnterCallLog && Array.isArray(fourBallEnterCallLog.closedCalls)
        ? fourBallEnterCallLog.closedCalls : null)
    || [];

  // Grade before season gate (handles SEASON_INACTIVE close correctly).
  gradeClosedCallIfAny(state, closedCalls, now);

  if (!seasonActive) {
    state.activePrediction  = null;
    state.lastSeenOpenCallId = null;
    state.updatedAt          = now;
    return buildSummary(state, 'DORMANT', null, null, null);
  }

  const openCall = fourBallEnterCallLog && fourBallEnterCallLog.openCall;
  const trades   = (paperTrader && paperTrader.trades) || [];

  // INTEL 2a: ENTER->first-event latency
  const callTiming   = collectCallHistoryTiming(closedCalls);
  // INTEL 2b: event->event spacing (now a first-class input)
  const spacingStat  = timingStat(callTiming.spacings);
  const callStat     = timingStat(callTiming.latencies);
  // INTEL 3: per-call paper trader latency (independent per call in v2)
  const paperTiming  = collectPaperTraderTiming(trades);
  const paperStat    = timingStat(paperTiming.latencies);

  // Signature profile for current 4SIL signal characteristics
  const currentSigLabel = deriveSignatureLabel(fourSIL);
  const sigStat         = matchingSignatureStat(currentSigLabel, state.signatureProfiles);

  const forecast = fuseForecast(callStat, spacingStat, paperStat, sigStat, state.config);

  // Freeze-on-open: one forecast per open call, held fixed.
  if (openCall && openCall.callId != null) {
    if (state.lastSeenOpenCallId !== openCall.callId) {
      state.activePrediction = {
        callId:           openCall.callId,
        openDrawId:       openCall.openDrawId,
        generatedAt:      now,
        signatureLabel:   currentSigLabel,  // stored so grading can update the profile
        ...forecast,
        // Absolute draw IDs (openDrawId + each relative offset), frozen
        // alongside the rest of this prediction at open time -- see
        // withAbsoluteDrawIds()'s header for why offsets are the
        // canonical form and these are just a derived convenience.
        ...withAbsoluteDrawIds(openCall.openDrawId, forecast),
        callIntel:    { sampleSize: callStat.sampleSize,    recentMean: callStat.recentMean    },
        spacingIntel: { sampleSize: spacingStat.sampleSize, recentMean: spacingStat.recentMean },
        paperIntel:   { sampleSize: paperStat.sampleSize,   recentMean: paperStat.recentMean   },
        sigIntel:     sigStat ? { sampleSize: sigStat.sampleSize, label: currentSigLabel } : null
      };
      state.lastSeenOpenCallId = openCall.callId;
    }
  } else {
    state.lastSeenOpenCallId = null;
  }

  state.updatedAt = now;

  const status  = openCall ? 'ARMED_TRACKING' : 'ARMED_WAITING';
  const liveAge = openCall ? openCall.draws    : null;
  return buildSummary(state, status, forecast, { callStat, spacingStat, paperStat, sigStat, currentSigLabel }, liveAge);
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function publicStat(stat) {
  if (!stat) return null;
  const { raw, ...rest } = stat;
  return rest;
}

function buildSummary(state, status, forecast, intel, liveAge) {
  const evaluations = state.evaluations || [];
  const graded      = evaluations.filter(e => e.result === 'HIT' || e.result === 'MISS');
  const hits        = graded.filter(e => e.result === 'HIT').length;

  // Average predicted windowProbability for graded predictions vs. actual hit rate --
  // a well-calibrated engine should have hitRatePct ≈ meanPredictedWindowPct.
  const meanPredictedWindowPct = graded.length > 0
    ? Math.round(graded.reduce((s, e) => s + (e.predicted.windowProbability || 0), 0) / graded.length * 10) / 10
    : null;
  const hitRatePct = graded.length > 0
    ? Math.round((hits / graded.length) * 1000) / 10
    : null;

  // Per-signature calibration stats (useful for diagnosing which signal
  // contexts the engine is most/least accurate in).
  const signatureCalibration = {};
  for (const [label, profile] of Object.entries(state.signatureProfiles || {})) {
    const profEvals = graded.filter(e => e.signatureLabel === label);
    if (profEvals.length === 0) continue;
    const profHits = profEvals.filter(e => e.result === 'HIT').length;
    signatureCalibration[label] = {
      sampleSize:    profile.latencies.length,
      gradedCalls:   profEvals.length,
      hitRatePct:    Math.round((profHits / profEvals.length) * 1000) / 10
    };
  }

  return {
    engine:        'FourSilNextEventIntelEngine',
    version:       '2.0',
    status,                      // DORMANT | ARMED_WAITING | ARMED_TRACKING
    colorAgnostic: true,
    liveAge,
    forecast: forecast ? {
      primaryDraw:        forecast.primaryDraw,
      expectedRangeLow:   forecast.expectedRangeLow,
      expectedRangeHigh:  forecast.expectedRangeHigh,
      fusedLatency:       forecast.fusedLatency,
      windowProbability:  forecast.windowProbability,  // true P(event in window)
      confidence:         forecast.confidence,          // alias = windowProbability
      timingState:        forecast.timingState,
      fusedPMF:           forecast.fusedPMF             // full distribution for dashboard
    } : null,
    intel: intel ? {
      callHistory:    publicStat(intel.callStat),
      eventSpacing:   publicStat(intel.spacingStat),   // now exposed as first-class
      paperTrader:    publicStat(intel.paperStat),
      signature:      intel.sigStat ? {
        label:        intel.currentSigLabel,
        ...publicStat(intel.sigStat)
      } : { label: intel.currentSigLabel, sampleSize: 0, note: 'insufficient_data' }
    } : null,
    activePrediction: state.activePrediction,
    calibration: {
      gradedPredictions:        graded.length,
      hits,
      hitRatePct,
      meanPredictedWindowPct,   // for calibration check: should ≈ hitRatePct
      signatureCalibration      // per-signature breakdown
    },
    evaluations: evaluations.slice(0, 50),
    updatedAt:   state.updatedAt
  };
}

module.exports = {
  defaultConfig,
  freshFourSilNextEventIntelState,
  ensureStateShape,
  evaluateFourSilNextEventIntel,
  // exported for tests / API convenience reads
  collectCallHistoryTiming,
  collectPaperTraderTiming,
  buildSummary,
  // v2 additions -- exported for unit testing
  fusePMFs,
  buildPMF,
  fuseForecast,
  deriveSignatureLabel,
  updateSignatureProfile,
  matchingSignatureStat
};
