/**
 * 5-BALL LIVE PREDICTION ENGINE (Phase 6 of the 5-Ball Research Lab)
 *
 * PHASE 6, LAST PHASE. Per the approved architecture: Harvest -> Research
 * -> Learning -> Validation -> Shadow Prediction -> Live Prediction. The
 * approved spec's own words for this phase: "Only after demonstrating
 * stable out-of-sample performance."
 *
 * ============================================================
 * CRITICAL CONTEXT -- READ BEFORE ASSUMING THIS IS "ON"
 * ============================================================
 * As of this engine's own first deployment, the ONLY shadow track record
 * that exists (fiveBallShadow.auditTrail) was produced by synthetic test
 * data during development, not real production draws. That means
 * eligibility below will correctly report NOT_ELIGIBLE the moment this
 * ships, and SHOULD keep reporting that until enough REAL draws have
 * accumulated a REAL shadow track record. This is not a bug or a
 * placeholder -- it is the correct, intended behavior of a system that
 * takes "demonstrating stable out-of-sample performance" literally
 * rather than as a formality to code around.
 *
 * TWO INDEPENDENT GATES, BOTH REQUIRED (defense in depth):
 *   1. ELIGIBILITY -- computed automatically, every cycle, from the real
 *      shadow track record (see evaluateEligibility below). This can
 *      flip to true on its own once the evidence genuinely supports it.
 *   2. liveModeEnabled -- a persistent flag that can ONLY be set to true
 *      by an explicit, separate, authenticated API call
 *      (POST /api/five-ball/enable-live-prediction, checkAuth-gated,
 *      same as this codebase's existing /api/reset), which ITSELF
 *      re-checks eligibility server-side before honoring the request --
 *      see api.js. There is no automatic path from eligible=true to
 *      liveModeEnabled=true anywhere in this codebase. Meeting the bar
 *      makes activation POSSIBLE, never automatic -- matching this
 *      entire project's non-negotiable rule (see fiveBallLearningEngine.js's
 *      hard-locked predictionMode and fiveBallShadowPredictionEngine.js's
 *      hard-locked mode for the same discipline applied earlier in this
 *      lab).
 *
 * EVEN WHEN BOTH GATES ARE OPEN, THIS NEVER TOUCHES 4SIL: a "live"
 * 5-ball call, if one is ever exposed, only ever changes how a color
 * call is LABELED on the dashboard (SHADOW/audit-only vs. LIVE/surfaced)
 * -- it is not wired into 4SIL, Parliament, arbitration, or
 * metaIntelligence, and never will be without separate, deliberate work.
 * The 5-ball lab remains its own fully independent, parallel prediction
 * stream for the 5-ball market -- it does not "trade" the 3/4-ball
 * markets 4SIL exists for.
 *
 * ELIGIBILITY BAR (documented, not hidden): at least
 * MIN_RESOLVED_CALLS resolved shadow calls, an overall Wilson-score 95%
 * CI lower bound (reusing tieEngine.js's wilsonScoreInterval) at or above
 * MIN_HIT_RATE_PCT, AND the most recent RECENT_WINDOW_SIZE calls
 * specifically holding at or above MIN_RECENT_HIT_RATE_PCT (so a track
 * record that was strong early but has since decayed doesn't still read
 * as eligible). All four constants below are deliberately conservative
 * and can be revisited once real history exists to reason about them
 * properly.
 *
 * PURE RECOMPUTE for eligibility (no new persistent state needed there --
 * it's fully derived from fiveBallShadow's own already-persisted audit
 * trail every cycle). liveModeEnabled itself IS persistent (it must
 * survive restarts once a human has deliberately set it), but this
 * engine only ever READS that flag -- it is written exclusively by the
 * dedicated API endpoint, never by this file or by any council cycle.
 */
'use strict';

const { wilsonScoreInterval } = require('./tieEngine');

const MIN_RESOLVED_CALLS = 30;
const MIN_HIT_RATE_PCT = 55; // required Wilson lower-bound, not just the raw rate -- deliberately more conservative than Phase 4's chance-baseline check, since this gates something that would actually be surfaced
const RECENT_WINDOW_SIZE = 20;
const MIN_RECENT_HIT_RATE_PCT = 50;

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Computes whether the CURRENT real shadow track record clears the bar
 * for live-eligibility. Does not read or write liveModeEnabled -- purely
 * an evidence-based assessment, entirely separate from whether anyone
 * has actually activated anything.
 */
function evaluateEligibility(fiveBallShadow) {
  const shadow = fiveBallShadow || {};
  const audit = shadow.auditTrail || { totalCallsResolved: 0, hits: 0 };
  const totalResolved = audit.totalCallsResolved || 0;
  const reasons = [];

  if (totalResolved < MIN_RESOLVED_CALLS) {
    reasons.push(`Only ${totalResolved} shadow call(s) resolved so far -- need at least ${MIN_RESOLVED_CALLS}.`);
    return { eligible: false, totalResolved, hitRatePct: audit.hitRatePct ?? null, wilsonInterval: null, recentHitRatePct: null, reasons };
  }

  const wilsonInterval = wilsonScoreInterval(audit.hits, totalResolved);
  if (wilsonInterval.lowerPct < MIN_HIT_RATE_PCT) {
    reasons.push(`Overall 95% CI lower bound is ${wilsonInterval.lowerPct}%, below the required ${MIN_HIT_RATE_PCT}%.`);
  }

  const recentCalls = (shadow.recentCalls || []).slice(0, RECENT_WINDOW_SIZE);
  let recentHitRatePct = null;
  if (recentCalls.length < RECENT_WINDOW_SIZE) {
    reasons.push(`Only ${recentCalls.length} of the most recent ${RECENT_WINDOW_SIZE} calls are available yet.`);
  } else {
    const recentHits = recentCalls.filter(c => c.hit).length;
    recentHitRatePct = round1((recentHits / recentCalls.length) * 100);
    if (recentHitRatePct < MIN_RECENT_HIT_RATE_PCT) {
      reasons.push(`Recent-${RECENT_WINDOW_SIZE} hit rate is ${recentHitRatePct}%, below the required ${MIN_RECENT_HIT_RATE_PCT}% -- performance may be decaying.`);
    }
  }

  return {
    eligible: reasons.length === 0,
    totalResolved,
    hitRatePct: audit.hitRatePct,
    wilsonInterval,
    recentHitRatePct,
    reasons
  };
}

function freshLiveMemory() {
  return {
    schemaVersion: 1,
    liveModeEnabled: false, // NEVER set true by this file -- see this file's header
    enabledAt: null,
    updatedAt: null
  };
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (typeof m.liveModeEnabled !== 'boolean') m.liveModeEnabled = false;
  if (typeof m.enabledAt === 'undefined') m.enabledAt = null;
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  return m;
}

/**
 * Main entry point, called once per council cycle. fiveBallShadow is
 * Phase 5's own full result (read-only). persistentMemory is
 * store.fiveBallLiveMemory -- read-only from THIS file's perspective
 * (liveModeEnabled is only ever written by the dedicated API endpoint).
 */
function evaluateFiveBallLivePrediction(fiveBallShadow, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const shadow = fiveBallShadow || {};

  const eligibility = evaluateEligibility(shadow);

  const livePrediction = (memory.liveModeEnabled && shadow.pendingCall)
    ? {
        color: shadow.pendingCall.calledColor,
        calledAtEventCount: shadow.pendingCall.calledAtEventCount,
        contributingPatternIds: shadow.pendingCall.contributingPatternIds
      }
    : null;

  const reasoning = memory.liveModeEnabled
    ? (livePrediction
        ? `LIVE MODE ENABLED. Current call: ${livePrediction.color}. This is still a 5-ball-market-only signal -- it does not gate or feed 4SIL, Parliament, or any 3/4-ball decision.`
        : 'LIVE MODE ENABLED, but no call is currently open (same NO_CALL discipline as Phase 5 -- no eligible pattern triggered, or signals conflict).')
    : (eligibility.eligible
        ? 'Eligibility bar is MET, but live mode remains DISABLED -- activation requires an explicit, separate, authenticated action (POST /api/five-ball/enable-live-prediction). Meeting the bar never auto-activates anything.'
        : `Live mode DISABLED (not eligible yet): ${eligibility.reasons.join(' ')}`);

  return {
    engine: '5-Ball Live Prediction Engine',
    phase: 6,
    ready: true,
    eligibility,
    liveModeEnabled: memory.liveModeEnabled,
    enabledAt: memory.enabledAt,
    livePrediction,
    reasoning
  };
}

module.exports = {
  MIN_RESOLVED_CALLS,
  MIN_HIT_RATE_PCT,
  RECENT_WINDOW_SIZE,
  MIN_RECENT_HIT_RATE_PCT,
  evaluateEligibility,
  freshLiveMemory,
  ensureMemoryShape,
  evaluateFiveBallLivePrediction
};
