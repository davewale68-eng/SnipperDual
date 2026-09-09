/**
 * 5-BALL VALIDATION ENGINE (Phase 4 of the 5-Ball Research Lab)
 *
 * PHASE 4 ONLY. Per the approved architecture: Harvest -> Research ->
 * Learning -> Validation -> Shadow Prediction -> Live Prediction. The
 * approved spec's own words for this phase: "Test discovered patterns
 * against unseen future draws." Phase 3 (fiveBallLearningEngine.js)
 * already does the MECHANICAL half of that continuously (every pattern's
 * status is recomputed every cycle from ONLY its forward, post-discovery
 * occurrences -- see that file's header). What Phase 4 adds is
 * STATISTICAL RIGOR on top of that raw forward evidence, and a
 * system-level "does this discovery process actually work" read that no
 * single pattern's own scorecard can answer by itself.
 *
 * WHAT THIS ADDS, CONCRETELY (two things, not a re-implementation of
 * Phase 3):
 *
 * 1. PER-PATTERN STATISTICAL SIGNIFICANCE. A raw forward rate like
 *    "80% (4/5)" and "80% (40/50)" are NOT equally trustworthy -- the
 *    first could easily be luck, the second much less plausibly so. This
 *    engine computes a Wilson score confidence interval (reusing
 *    tieEngine.js's own wilsonScoreInterval -- the same battle-tested
 *    function this codebase already trusts elsewhere for exactly this
 *    purpose) over each pattern's FORWARD evidence only (never the
 *    in-sample discovery evidence -- staying consistent with Phase 3's
 *    own out-of-sample discipline), then checks whether even the
 *    interval's LOWER bound still beats a chance baseline. Only then is
 *    a pattern labeled SIGNIFICANT rather than NOT_SIGNIFICANT or (below
 *    a minimum sample) INSUFFICIENT_SAMPLE.
 *
 *    CHANCE BASELINE, STATED PLAINLY (a documented simplification, not
 *    hidden): TRANSITION_BEHAVIOR patterns predict a SPECIFIC one of the
 *    2 non-originating colors (pickRotationTarget explicitly excludes
 *    the FROM color), so their naive chance baseline is ~50%. Every
 *    other category predicts a specific one of all 3 colors, so their
 *    naive chance baseline is ~33.3%. A more rigorous baseline would use
 *    each color's own unconditional base rate instead of a flat 1/2 or
 *    1/3 -- that's a reasonable future refinement, not built here, and
 *    is called out explicitly rather than silently assumed away.
 *
 * 2. PATTERN DISCOVERY TRACK RECORD. Across EVERY pattern this lab has
 *    ever discovered (Phase 3 never deletes a discovery anchor once
 *    created, regardless of current status -- so fiveBallLearning.patterns
 *    already IS the complete historical record), what fraction have
 *    actually held up to statistical significance once there was enough
 *    forward sample to judge them at all? This is a meta-validation of
 *    the DISCOVERY PROCESS itself, not any one pattern -- directly
 *    answering "should I trust what this lab finds in general," which is
 *    a different question than "should I trust this one pattern."
 *
 * PURE RECOMPUTE, NO PERSISTENT STATE: fully re-derivable from
 * fiveBallLearning's own already-persisted pattern library every cycle
 * -- nothing here needs its own memory.
 */
'use strict';

const { wilsonScoreInterval } = require('./tieEngine');
const { FORWARD_MIN_OCCURRENCES_TO_JUDGE } = require('./fiveBallLearningEngine');

const CHANCE_BASELINE_PCT = {
  TRANSITION_BEHAVIOR: 50,
  SUPPRESSION_BEHAVIOR: 33.3,
  DOMINANCE_BEHAVIOR: 33.3,
  RECOVERY_BEHAVIOR: 33.3
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Statistically validates a single pattern from Phase 3's own forward
 * evidence. Returns null if the pattern hasn't even been discovered yet
 * in a meaningful sense (shouldn't happen in practice -- Phase 3 only
 * ever hands this engine patterns that already crossed the discovery
 * bar -- but guarded defensively regardless).
 */
function validatePattern(pattern) {
  const chanceBaselinePct = CHANCE_BASELINE_PCT[pattern.category] != null ? CHANCE_BASELINE_PCT[pattern.category] : 33.3;
  const sufficientSample = pattern.forwardSampleSize >= FORWARD_MIN_OCCURRENCES_TO_JUDGE;

  if (!sufficientSample) {
    return {
      id: pattern.id,
      chanceBaselinePct,
      wilsonInterval: null,
      significance: 'INSUFFICIENT_SAMPLE',
      note: `Only ${pattern.forwardSampleSize} forward occurrence(s) so far -- need at least ${FORWARD_MIN_OCCURRENCES_TO_JUDGE} before a confidence interval means anything.`
    };
  }

  const wilsonInterval = wilsonScoreInterval(pattern.forwardSuccessCount, pattern.forwardSampleSize);
  const significant = wilsonInterval.lowerPct > chanceBaselinePct;

  return {
    id: pattern.id,
    chanceBaselinePct,
    wilsonInterval,
    significance: significant ? 'SIGNIFICANT' : 'NOT_SIGNIFICANT',
    note: significant
      ? `Even the conservative (95% CI) lower bound of ${wilsonInterval.lowerPct}% still clears the ${chanceBaselinePct}% chance baseline for this pattern type.`
      : `The 95% CI lower bound (${wilsonInterval.lowerPct}%) does not clear the ${chanceBaselinePct}% chance baseline -- the observed ${pattern.currentProbabilityPct}% forward rate could plausibly be chance at this sample size (n=${pattern.forwardSampleSize}).`
  };
}

/**
 * Main entry point, called once per council cycle. fiveBallLearning is
 * Phase 3's own full result (read-only).
 */
function evaluateFiveBallValidation(fiveBallLearning) {
  const learning = fiveBallLearning || {};

  if (!learning.ready || !Array.isArray(learning.patterns) || learning.patterns.length === 0) {
    return {
      engine: '5-Ball Validation Engine',
      phase: 4,
      ready: false,
      reasoning: 'No discovered patterns to validate yet -- Phase 3 (Learning Engine) has nothing in its library.'
    };
  }

  const validations = learning.patterns.map(p => ({ pattern: p, validation: validatePattern(p) }));

  const judgeable = validations.filter(v => v.validation.significance !== 'INSUFFICIENT_SAMPLE');
  const significant = judgeable.filter(v => v.validation.significance === 'SIGNIFICANT');

  const trackRecord = {
    totalPatternsDiscovered: learning.patterns.length,
    judgeableCount: judgeable.length, // patterns with enough forward sample to even attempt significance testing
    significantCount: significant.length,
    trackRecordPct: judgeable.length > 0 ? round1((significant.length / judgeable.length) * 100) : null
  };

  const reasoning = trackRecord.judgeableCount > 0
    ? `Of ${trackRecord.totalPatternsDiscovered} pattern(s) ever discovered, ${trackRecord.judgeableCount} have enough forward evidence to test -- ${trackRecord.significantCount} (${trackRecord.trackRecordPct}%) hold up to statistical significance (95% CI lower bound beats chance baseline for their pattern type), the rest do not. This is a read on the DISCOVERY PROCESS as a whole, separate from any single pattern's own status.`
    : `${trackRecord.totalPatternsDiscovered} pattern(s) discovered so far, but none yet have enough forward evidence (${FORWARD_MIN_OCCURRENCES_TO_JUDGE}+ occurrences) to test for statistical significance.`;

  return {
    engine: '5-Ball Validation Engine',
    phase: 4,
    ready: true,
    patternValidations: validations.map(v => ({
      id: v.pattern.id,
      category: v.pattern.category,
      color: v.pattern.color,
      status: v.pattern.status, // Phase 3's own forward-performance status, carried through for context
      forwardSampleSize: v.pattern.forwardSampleSize,
      currentProbabilityPct: v.pattern.currentProbabilityPct,
      ...v.validation
    })),
    trackRecord,
    reasoning
  };
}

module.exports = {
  CHANCE_BASELINE_PCT,
  validatePattern,
  evaluateFiveBallValidation
};
