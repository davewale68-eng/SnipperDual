/**
 * 5-BALL NEXT EVENT ENGINE (Phase 7 of the 5-Ball Research Lab)
 *
 * WHY THIS EXISTS: by the time Phase 6 (Live Prediction) shipped, this
 * lab was computing SEVEN upstream signals every cycle (Harvest,
 * Research, Learning, Fingerprint, Season Detection, Validation, Shadow)
 * -- but Shadow Prediction (Phase 5), the only engine that actually
 * calls a color, only ever consumed FOUR of them (Harvest/Research/
 * Learning/Validation). Two fully-computed signal sources sat unused on
 * every council cycle:
 *   - fiveBallFingerprint (event-neighborhood cosine-similarity
 *     matching) -- and even that engine's own header explicitly flagged
 *     that it only ever re-examined the most recent ALREADY-CAPTURED
 *     event retrospectively, deferring a genuinely forward-looking
 *     "does the CURRENT lead-up resemble a past one" read as a "follow-
 *     up." That live-vector match is now built (see
 *     fiveBallEventFingerprintEngine.js's evaluateLiveMatch(), added
 *     alongside this engine) specifically so this file has it to
 *     consume.
 *   - fiveBallSeason (the dominance state machine: is one color's share
 *     of recent 5-ball events currently ACTIVE/BUILDING/WEAKENING).
 * This engine is the first thing in the lab to combine ALL FIVE
 * available signal sources into a single read.
 *
 * WHY THE OUTPUT IS DIFFERENT FROM SHADOW, NOT A REPLACEMENT FOR IT:
 * Shadow Prediction is deliberately binary -- unanimous validated-
 * pattern agreement or NO_CALL, exactly because arbitrarily breaking a
 * tie between conflicting signals would manufacture false confidence
 * (see that file's header). That discipline is correct and is NOT
 * changed here. What this engine adds is a CONTINUOUS, WEIGHTED
 * leaderboard -- every source contributes proportionally to its own
 * live confidence rather than an equal, unweighted vote, and colors are
 * always ranked rather than collapsing to NO_CALL the moment two sources
 * disagree. This mirrors the exact "always produce a ranked leaderboard,
 * never force a false unanimous pick" pattern the codebase already uses
 * for the 3/4-ball markets (see fourBallSeasonIntelligenceLab.js's
 * buildNextEventLeaderboard4B / badge.nextEventLeaderboard,
 * threeBallNextEventHitCounter.js) -- the 5-ball lab simply never had
 * its own equivalent until now. "Sharper" here means more of the
 * genuinely computed evidence is used per cycle, and the output degrades
 * gracefully (lower confidence, explicit evidenceCoverage) instead of
 * degrading to silence the moment sources disagree.
 *
 * ============================================================
 * QUARANTINE -- SAME DISCIPLINE AS PHASE 5, READ BEFORE CHANGING
 * ============================================================
 * This engine's output is SHADOW/AUDIT ONLY, identically to
 * fiveBallShadowPredictionEngine.js. It is never read by 4SIL, never
 * read by Parliament, never votes, never gates anything, and is not
 * wired into fiveBallLivePredictionEngine.js's eligibility in any way --
 * that gate continues to evaluate ONLY fiveBallShadow's own track
 * record, unchanged. Whether this engine's blended approach should ever
 * feed live-eligibility instead of (or alongside) Shadow's strict-
 * consensus approach is an explicit, separate, future operator decision
 * once THIS engine has built its own real out-of-sample track record --
 * exactly the same bar Phase 5 itself had to clear, not assumed away
 * because this file happens to combine more signals.
 *
 * WEIGHTING (documented, not hidden; fixed on purpose for the same
 * reason fiveBallEventFingerprintEngine.js uses fixed divisors -- a
 * comparison whose meaning silently drifted as more history accumulated
 * would defeat the point of an auditable weight). Weights sum to 100
 * when every source has live data:
 *   - VALIDATED_PATTERN   40  -- Phase 3/4's own out-of-sample-validated,
 *                                 statistically-significant pattern
 *                                 votes (reuses Shadow's own
 *                                 evaluatePatternLiveTrigger rather than
 *                                 re-deriving trigger logic), scaled by
 *                                 that pattern's own forward
 *                                 currentProbability. Strongest weight:
 *                                 this is the only source that has
 *                                 already cleared an out-of-sample
 *                                 significance bar.
 *   - LIVE_FINGERPRINT    25  -- the new live-window cosine-similarity
 *                                 match, scaled by its own
 *                                 predictionConfidence.
 *   - SEASON_STATE        15  -- Phase 2-extension's dominance state
 *                                 machine; ACTIVE color scaled by its
 *                                 recentSharePct, a BUILDING challenger
 *                                 counted at half weight.
 *   - SUPPRESSION_GAP     12  -- Research Lab's own current-gap-vs-p75
 *                                 threshold read (same binary trigger
 *                                 Shadow already reuses for its
 *                                 SUPPRESSION_BEHAVIOR category).
 *   - ROTATION_MATRIX      8  -- Research Lab's first-order transition
 *                                 matrix, conditioned on the most recent
 *                                 event's own color.
 * A source that has no live signal this cycle (insufficient sample,
 * nothing triggered, etc.) contributes 0 to every color AND is excluded
 * from the confidence denominator -- see evidenceCoverage below -- so a
 * quiet source lowers reported confidence honestly instead of silently
 * being treated as "voted for nothing, counts as zero out of 100."
 *
 * PERSISTENT STATE, AND WHY: identical reasoning to Shadow Prediction --
 * an open call must be remembered across cycles to grade it against
 * whatever the real next 5-ball event turns out to be. This engine's
 * own callLog is entirely separate from Shadow's, specifically so the
 * two approaches' track records can eventually be compared honestly
 * instead of one overwriting the other.
 */
'use strict';

const { evaluatePatternLiveTrigger, isSuppressionRecoveryTriggered } = require('./fiveBallShadowPredictionEngine');

const HIERARCHY = ['RED', 'BLUE', 'GREEN'];
const MAX_CALL_LOG_ENTRIES = 500;

const WEIGHTS = {
  VALIDATED_PATTERN: 40,
  LIVE_FINGERPRINT: 25,
  SEASON_STATE: 15,
  SUPPRESSION_GAP: 12,
  ROTATION_MATRIX: 8
};
const TOTAL_POSSIBLE_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0); // 100

// A call only opens when the leaderboard's top color clears BOTH bars --
// avoids logging a call (and diluting this engine's own future audit
// trail with noise) off a single weak source. Deliberately higher than
// Shadow's own implicit bar (unanimous validated-pattern agreement)
// would translate to in this scoring scheme, since this engine is
// designed to still rank colors even on thin evidence -- the CALL-OPEN
// bar, not the leaderboard itself, is where that caution has to live.
const MIN_CONFIDENCE_TO_CALL_PCT = 45;
const MIN_EVIDENCE_COVERAGE_TO_CALL = 2;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function freshNextEventMemory() {
  return {
    schemaVersion: 1,
    pendingCall: null, // { calledAtEventCount, calledColor, confidencePct, contributingSources, calledAt }
    callLog: [],
    updatedAt: null
  };
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (!Array.isArray(m.callLog)) m.callLog = [];
  if (typeof m.pendingCall === 'undefined') m.pendingCall = null;
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  return m;
}

function pushCapped(log, entry) {
  log.unshift(entry);
  if (log.length > MAX_CALL_LOG_ENTRIES) log.length = MAX_CALL_LOG_ENTRIES;
}

/**
 * VALIDATED_PATTERN source -- reuses Shadow's own per-pattern trigger
 * logic so both engines agree on "is this pattern's condition actually
 * true right now" (no second, possibly-diverging implementation of the
 * same check). Unlike Shadow, multiple triggered patterns for the SAME
 * color don't stack -- takes the single highest-confidence one, since
 * these patterns often detect overlapping underlying behavior and
 * summing them would double-count the same evidence.
 */
function scoreValidatedPatterns(fiveBallHarvest, fiveBallResearch, fiveBallLearning, fiveBallValidation) {
  const contributions = { RED: 0, BLUE: 0, GREEN: 0 };
  const detail = { RED: null, BLUE: null, GREEN: null };
  let anyTriggered = false;

  const validationById = {};
  ((fiveBallValidation && fiveBallValidation.patternValidations) || []).forEach(v => { validationById[v.id] = v; });

  const eligiblePatterns = ((fiveBallLearning && fiveBallLearning.patterns) || []).filter(p => {
    const v = validationById[p.id];
    return p.status === 'VALIDATED' && v && v.significance === 'SIGNIFICANT';
  });

  eligiblePatterns.forEach(p => {
    const { triggered, impliedColor } = evaluatePatternLiveTrigger(p, fiveBallHarvest, fiveBallResearch);
    if (!triggered || !impliedColor || !contributions.hasOwnProperty(impliedColor)) return;
    anyTriggered = true;
    const confidence = Number.isFinite(p.currentProbability) ? p.currentProbability : 55;
    if (!detail[impliedColor] || confidence > detail[impliedColor].confidence) {
      detail[impliedColor] = { patternId: p.id, confidence };
    }
  });

  HIERARCHY.forEach(c => {
    contributions[c] = detail[c] ? WEIGHTS.VALIDATED_PATTERN * (detail[c].confidence / 100) : 0;
  });

  return { contributions, detail, active: anyTriggered };
}

/**
 * LIVE_FINGERPRINT source -- straight read of the new evaluateLiveMatch()
 * result on fiveBallFingerprint (see that engine's own header).
 */
function scoreLiveFingerprint(fiveBallFingerprint) {
  const lm = fiveBallFingerprint && fiveBallFingerprint.liveMatch;
  const contributions = { RED: 0, BLUE: 0, GREEN: 0 };
  if (!lm || !lm.ready || !lm.majorityOutcome) {
    return { contributions, active: false, detail: null };
  }
  contributions[lm.majorityOutcome] = WEIGHTS.LIVE_FINGERPRINT * (lm.predictionConfidence / 100);
  return { contributions, active: true, detail: { color: lm.majorityOutcome, confidence: lm.predictionConfidence, bestMatchDrawId: lm.topMatches[0] ? lm.topMatches[0].drawId : null } };
}

/**
 * SEASON_STATE source -- ACTIVE color at full weight scaled by its own
 * recent share, a BUILDING challenger (if any) at half weight.
 */
function scoreSeasonState(fiveBallSeason) {
  const contributions = { RED: 0, BLUE: 0, GREEN: 0 };
  if (!fiveBallSeason || !fiveBallSeason.ready) {
    return { contributions, active: false, detail: null };
  }
  const detail = {};
  if (fiveBallSeason.activeColor && fiveBallSeason.byColor[fiveBallSeason.activeColor]) {
    const share = fiveBallSeason.byColor[fiveBallSeason.activeColor].recentSharePct || 0;
    contributions[fiveBallSeason.activeColor] = WEIGHTS.SEASON_STATE * (share / 100);
    detail.active = { color: fiveBallSeason.activeColor, state: fiveBallSeason.byColor[fiveBallSeason.activeColor].state, sharePct: share };
  }
  if (fiveBallSeason.challengerColor && fiveBallSeason.byColor[fiveBallSeason.challengerColor]) {
    const share = fiveBallSeason.byColor[fiveBallSeason.challengerColor].recentSharePct || 0;
    contributions[fiveBallSeason.challengerColor] += WEIGHTS.SEASON_STATE * 0.5 * (share / 100);
    detail.challenger = { color: fiveBallSeason.challengerColor, sharePct: share };
  }
  const active = !!(fiveBallSeason.activeColor || fiveBallSeason.challengerColor);
  return { contributions, active, detail: active ? detail : null };
}

/**
 * SUPPRESSION_GAP source -- reuses Shadow's own binary trigger
 * (currentGap > that color's own p75 historical gap) rather than
 * re-deriving it, same "one implementation of a shared check" principle
 * as scoreValidatedPatterns above. Binary by design (matches the
 * existing trigger's own semantics) -- not scaled by how far past p75
 * the gap runs, to stay consistent with what Shadow already means by
 * "triggered."
 */
function scoreSuppressionGap(fiveBallResearch) {
  const contributions = { RED: 0, BLUE: 0, GREEN: 0 };
  const triggeredColors = [];
  HIERARCHY.forEach(c => {
    if (isSuppressionRecoveryTriggered(c, fiveBallResearch || {})) {
      contributions[c] = WEIGHTS.SUPPRESSION_GAP;
      triggeredColors.push(c);
    }
  });
  return { contributions, active: triggeredColors.length > 0, detail: triggeredColors.length > 0 ? triggeredColors : null };
}

/**
 * ROTATION_MATRIX source -- Research Lab's first-order transition
 * matrix, conditioned on the most recent captured event's own color.
 */
function scoreRotationMatrix(fiveBallHarvest, fiveBallResearch) {
  const contributions = { RED: 0, BLUE: 0, GREEN: 0 };
  const mostRecent = fiveBallHarvest && fiveBallHarvest.mostRecentEvent;
  const rotation = fiveBallResearch && fiveBallResearch.rotation;
  if (!mostRecent || !rotation || !rotation.ready || !rotation.matrix[mostRecent.eventColor]) {
    return { contributions, active: false, detail: null };
  }
  const row = rotation.matrix[mostRecent.eventColor];
  if (!row.sampleSize) return { contributions, active: false, detail: null };
  HIERARCHY.forEach(c => {
    const p = row.probabilities[c];
    if (Number.isFinite(p)) contributions[c] = WEIGHTS.ROTATION_MATRIX * (p / 100);
  });
  return { contributions, active: true, detail: { fromColor: mostRecent.eventColor, sampleSize: row.sampleSize, probabilities: row.probabilities } };
}

/**
 * Resolves a pending call (if any) against a newly-landed 5-ball event.
 * Identical shape/logic to Shadow's own resolvePendingCall, kept as a
 * separate function (not a shared import) since the two engines'
 * pendingCall/callLog schemas carry different fields (confidencePct,
 * contributingSources here vs contributingPatternIds there).
 */
function resolvePendingCall(memory, newestEvent) {
  if (!memory.pendingCall || !newestEvent) return;
  const hit = newestEvent.eventColor === memory.pendingCall.calledColor;
  pushCapped(memory.callLog, {
    calledAtEventCount: memory.pendingCall.calledAtEventCount,
    calledColor: memory.pendingCall.calledColor,
    confidencePct: memory.pendingCall.confidencePct,
    contributingSources: memory.pendingCall.contributingSources,
    calledAt: memory.pendingCall.calledAt,
    resolvedDrawId: newestEvent.drawId,
    resolvedColor: newestEvent.eventColor,
    hit
  });
  memory.pendingCall = null;
}

/**
 * Main entry point, called once per council cycle. All five inputs are
 * upstream phases' own full results (read-only) -- this engine computes
 * no new base statistics of its own, only combines already-final ones.
 */
function evaluateFiveBallNextEvent(fiveBallHarvest, fiveBallResearch, fiveBallLearning, fiveBallValidation, fiveBallFingerprint, fiveBallSeason, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const harvest = fiveBallHarvest || {};
  const research = fiveBallResearch || {};

  if (!research.ready) {
    return {
      engine: '5-Ball Next Event Engine',
      phase: 7,
      mode: 'SHADOW_ONLY',
      ready: false,
      reasoning: 'Research Lab is not ready yet (fewer than 2 captured events) -- nothing to blend a leaderboard from.'
    };
  }

  // Resolve any pending call FIRST, same anchor-based dedup as Shadow.
  const totalEvents = harvest.totalEventsCaptured || 0;
  if (memory.pendingCall && totalEvents > memory.pendingCall.calledAtEventCount) {
    resolvePendingCall(memory, harvest.mostRecentEvent);
  }

  const sources = {
    VALIDATED_PATTERN: scoreValidatedPatterns(harvest, research, fiveBallLearning, fiveBallValidation),
    LIVE_FINGERPRINT: scoreLiveFingerprint(fiveBallFingerprint),
    SEASON_STATE: scoreSeasonState(fiveBallSeason),
    SUPPRESSION_GAP: scoreSuppressionGap(research),
    ROTATION_MATRIX: scoreRotationMatrix(harvest, research)
  };

  const evidenceCoverage = Object.values(sources).filter(s => s.active).length;
  const activeWeightTotal = Object.entries(sources).reduce((sum, [key, s]) => sum + (s.active ? WEIGHTS[key] : 0), 0);

  const rawScore = { RED: 0, BLUE: 0, GREEN: 0 };
  const contributingSourcesByColor = { RED: [], BLUE: [], GREEN: [] };
  Object.entries(sources).forEach(([key, s]) => {
    HIERARCHY.forEach(c => {
      if (s.contributions[c] > 0) {
        rawScore[c] += s.contributions[c];
        contributingSourcesByColor[c].push(key);
      }
    });
  });

  const leaderboard = HIERARCHY
    .map(c => ({
      color: c,
      score: round1(rawScore[c]),
      confidencePct: activeWeightTotal > 0 ? round1((rawScore[c] / activeWeightTotal) * 100) : 0,
      contributingSources: contributingSourcesByColor[c]
    }))
    .sort((a, b) => b.score - a.score);

  const top = leaderboard[0];
  const topColor = top && top.score > 0 ? top.color : null;
  const topConfidencePct = topColor ? top.confidencePct : 0;

  // Only consider opening a NEW call if none is currently pending, and
  // only if the top color clears both the confidence and evidence-
  // coverage bars -- see MIN_CONFIDENCE_TO_CALL_PCT/MIN_EVIDENCE_
  // COVERAGE_TO_CALL's own comments above.
  if (!memory.pendingCall && topColor && topConfidencePct >= MIN_CONFIDENCE_TO_CALL_PCT && evidenceCoverage >= MIN_EVIDENCE_COVERAGE_TO_CALL) {
    memory.pendingCall = {
      calledAtEventCount: totalEvents,
      calledColor: topColor,
      confidencePct: topConfidencePct,
      contributingSources: top.contributingSources,
      calledAt: new Date().toISOString()
    };
  }

  memory.updatedAt = new Date().toISOString();

  const resolvedCalls = memory.callLog;
  const hits = resolvedCalls.filter(c => c.hit).length;
  const auditTrail = {
    totalCallsResolved: resolvedCalls.length,
    hits,
    misses: resolvedCalls.length - hits,
    hitRatePct: resolvedCalls.length > 0 ? Math.round((hits / resolvedCalls.length) * 1000) / 10 : null
  };

  const reasoning = memory.pendingCall
    ? `SHADOW CALL OPEN (audit only, never acted on): ${memory.pendingCall.calledColor} at ${memory.pendingCall.confidencePct}% blended confidence (sources: ${memory.pendingCall.contributingSources.join(', ') || 'none'}), called at event #${memory.pendingCall.calledAtEventCount}. Evidence coverage this cycle: ${evidenceCoverage}/5 sources active. Track record so far: ${auditTrail.hits}/${resolvedCalls.length} (${auditTrail.hitRatePct != null ? auditTrail.hitRatePct + '%' : 'n/a'}).`
    : (topColor
        ? `Leaderboard leader is ${topColor} at ${topConfidencePct}% blended confidence, but below the ${MIN_CONFIDENCE_TO_CALL_PCT}% / ${MIN_EVIDENCE_COVERAGE_TO_CALL}-source bar to open a graded call (evidence coverage: ${evidenceCoverage}/5). Track record so far: ${auditTrail.hits}/${resolvedCalls.length} (${auditTrail.hitRatePct != null ? auditTrail.hitRatePct + '%' : 'n/a'}).`
        : `No source currently favors any color (evidence coverage: ${evidenceCoverage}/5). Track record so far: ${auditTrail.hits}/${resolvedCalls.length} (${auditTrail.hitRatePct != null ? auditTrail.hitRatePct + '%' : 'n/a'}).`);

  return {
    engine: '5-Ball Next Event Engine',
    phase: 7,
    mode: 'SHADOW_ONLY', // same quarantine as Phase 5 -- see this file's header
    ready: true,
    weights: WEIGHTS,
    totalPossibleWeight: TOTAL_POSSIBLE_WEIGHT,
    evidenceCoverage,
    activeWeightTotal: round1(activeWeightTotal),
    sourceDetail: {
      VALIDATED_PATTERN: sources.VALIDATED_PATTERN.detail,
      LIVE_FINGERPRINT: sources.LIVE_FINGERPRINT.detail,
      SEASON_STATE: sources.SEASON_STATE.detail,
      SUPPRESSION_GAP: sources.SUPPRESSION_GAP.detail,
      ROTATION_MATRIX: sources.ROTATION_MATRIX.detail
    },
    leaderboard,
    topColor,
    topConfidencePct,
    minConfidenceToCallPct: MIN_CONFIDENCE_TO_CALL_PCT,
    minEvidenceCoverageToCall: MIN_EVIDENCE_COVERAGE_TO_CALL,
    pendingCall: memory.pendingCall,
    recentCalls: resolvedCalls.slice(0, 20),
    auditTrail,
    reasoning
  };
}

module.exports = {
  WEIGHTS,
  TOTAL_POSSIBLE_WEIGHT,
  MIN_CONFIDENCE_TO_CALL_PCT,
  MIN_EVIDENCE_COVERAGE_TO_CALL,
  freshNextEventMemory,
  ensureMemoryShape,
  scoreValidatedPatterns,
  scoreLiveFingerprint,
  scoreSeasonState,
  scoreSuppressionGap,
  scoreRotationMatrix,
  evaluateFiveBallNextEvent
};
