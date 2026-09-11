/**
 * 5-BALL LEARNING ENGINE (Phase 3 of the 5-Ball Research Lab)
 *
 * PHASE 3 ONLY. Per the approved architecture: Harvest -> Research ->
 * Learning -> Validation -> Shadow Prediction -> Live Prediction. This
 * engine's mode is LEARNING MODE, exactly as specified: it consumes
 * Phase 2's (fiveBallResearchLab.js) observations and Phase 1's
 * (fiveBallHarvester.js) raw event log, discovers CANDIDATE PATTERNS,
 * and tracks each one's performance -- but it makes NO predictions and
 * exposes NO prediction mode. predictionMode is hard-locked to 'LOCKED'
 * below and cannot be changed by anything in this file -- there is no
 * code path here that ever writes 'ELIGIBLE' or any other value.
 * Turning prediction on is Phase 5/6 work (Shadow Prediction / Live
 * Prediction), neither of which exists yet, and even once they do, this
 * codebase's own established rule holds: never auto-activate a new
 * capability, require an explicit operator action.
 *
 * SCOPE OF PATTERN CATEGORIES COVERED (being explicit about what's
 * built vs. deferred, rather than implying full coverage of every
 * category the approved spec named): this phase covers SUPPRESSION/
 * DROUGHT behavior, DOMINANCE/continuation behavior, first-order
 * TRANSITION/rotation behavior, and RECOVERY/repeat behavior -- four
 * template families, tracked per color. It does NOT yet build
 * event-neighborhood ("pre-event/post-event pattern") fingerprint
 * matching or a season-detection state machine ("season behavior" /
 * "cluster behavior") -- those are meaningfully separate features
 * deferred to a later pass, not silently skipped.
 *
 * HOW DISCOVERY VS. VALIDATION ACTUALLY WORKS (the part that makes this
 * different from just re-displaying Phase 2's live stats): for each
 * pattern template, this engine walks the FULL causal occurrence history
 * (was the trigger condition true at each historical moment, and if so,
 * did the predicted outcome actually happen) via the occurrences*()
 * helpers below. The FIRST time a template crosses the discovery bar
 * (enough occurrences, high enough in-sample success rate), a permanent
 * "discovery anchor" is persisted -- the occurrence-count boundary at
 * that moment. On every later cycle, this engine re-walks the same
 * occurrence list but only scores occurrences AFTER that anchor as
 * "forward" (out-of-sample) evidence -- successCount/failureCount/
 * currentProbability/status are all computed from ONLY that forward
 * slice. The in-sample evidence that triggered discovery is never reused
 * to inflate the validation numbers. This is the concrete implementation
 * of the approved spec's own principle: "test discovered patterns
 * against unseen future draws," and directly avoids the anti-pattern
 * it warns about ("so the engine doesn't fall in love with one lucky
 * pattern").
 *
 * STATEFUL, BUT MINIMALLY SO: only the discovery anchor (occurrence
 * index + probability + timestamp it was first crossed) is persisted per
 * pattern -- everything else (successCount, status, decayScore, etc.) is
 * recomputed fresh from that anchor plus the current occurrence list
 * every cycle, exactly like Phase 2's own philosophy. This means a
 * pattern's discovery moment is permanent and can't drift, but its
 * ongoing scorecard is always an honest, current recomputation, never
 * incrementally accumulated drift-prone state.
 *
 * historicalDraws/eventLog conventions are unchanged from Phases 1/2
 * (chronological = oldest-first, via fiveBallResearchLab.js's own
 * chronologicalEvents()).
 */
'use strict';

const { chronologicalEvents, DOMINANCE_WINDOW } = require('./fiveBallResearchLab');

const HIERARCHY = ['RED', 'BLUE', 'GREEN'];

// Discovery bar: a template needs at least this many in-sample
// occurrences, at at least this success rate, before it's even proposed
// as a candidate pattern. Modest on purpose -- the approved spec's own
// worked example used a sample of 47, but 5-ball events are rare enough
// that demanding a sample that large would mean this engine almost never
// discovers anything for a very long time. This can be revisited once
// real history accumulates (see Phase 4 -- Validation, not built yet).
const DISCOVERY_MIN_OCCURRENCES = 5;
const DISCOVERY_MIN_RATE_PCT = 55;

// Forward (out-of-sample) validation thresholds.
const FORWARD_MIN_OCCURRENCES_TO_JUDGE = 5;
const VALIDATED_MIN_RATE_PCT = 55;
const DECAYING_MIN_RATE_PCT = 40; // between this and VALIDATED_MIN_RATE_PCT = decaying, not yet retired
const RETIRED_MAX_FORWARD_OCCURRENCES_UNRESOLVED = 20; // if still below DECAYING_MIN_RATE_PCT after this many forward occurrences, retire rather than leave it hanging forever

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function freshLearningMemory() {
  return {
    schemaVersion: 1,
    patterns: {}, // patternId -> { discoveredAtOccurrenceIndex, discoveryProbabilityPct, discoverySampleSize, firstDiscoveredAt }
    updatedAt: null
  };
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (!m.patterns || typeof m.patterns !== 'object') m.patterns = {};
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  return m;
}

/**
 * TEMPLATE A -- SUPPRESSION_RECOVERY_<COLOR>: at each event, was <COLOR>
 * running a drought longer than its OWN historical p75 gap (per Phase
 * 2's gapsByColor), and if so, did <COLOR> itself produce THIS event
 * (success) or did a different color (failure)?
 */
function occurrencesSuppressionRecovery(chronoEvents, color, p75Threshold) {
  if (p75Threshold == null) return [];
  const occurrences = [];
  let lastPos = null;
  for (const event of chronoEvents) {
    if (lastPos != null) {
      const drought = event.position - lastPos;
      if (drought > p75Threshold) {
        occurrences.push({ success: event.eventColor === color, atEventDrawId: event.drawId });
      }
    }
    if (event.eventColor === color) lastPos = event.position;
  }
  return occurrences;
}

/**
 * TEMPLATE B -- DOMINANCE_CONTINUATION_<COLOR>: at each event (once at
 * least DOMINANCE_WINDOW prior events exist), did <COLOR> hold >= 50% of
 * the PRECEDING window of events (causal -- never includes the event
 * being judged itself), and if so did <COLOR> also produce THIS event
 * (continuation, success) or did dominance break (failure)?
 */
function occurrencesDominanceContinuation(chronoEvents, color) {
  const occurrences = [];
  for (let i = DOMINANCE_WINDOW; i < chronoEvents.length; i++) {
    const window = chronoEvents.slice(i - DOMINANCE_WINDOW, i);
    const share = window.filter(e => e.eventColor === color).length / window.length;
    if (share >= 0.5) {
      occurrences.push({ success: chronoEvents[i].eventColor === color, atEventDrawId: chronoEvents[i].drawId });
    }
  }
  return occurrences;
}

/**
 * TEMPLATE C -- ROTATION_<FROM>_TO_<TARGET>: at each event where the
 * PRECEDING event's color was <FROM>, did THIS event turn out to be
 * <TARGET> (the single most likely destination at the time this pattern
 * was first proposed, locked in -- see pickRotationTarget below)?
 */
function occurrencesRotation(chronoEvents, from, target) {
  const occurrences = [];
  for (let i = 1; i < chronoEvents.length; i++) {
    if (chronoEvents[i - 1].eventColor === from) {
      occurrences.push({ success: chronoEvents[i].eventColor === target, atEventDrawId: chronoEvents[i].drawId });
    }
  }
  return occurrences;
}

/**
 * TEMPLATE D -- RECOVERY_REPEAT_<COLOR>: restricted to events that were
 * themselves a SUCCESSFUL Template A occurrence for <COLOR> (i.e. <COLOR>
 * had just resolved its own suppression drought) -- of those, did the
 * VERY NEXT event repeat <COLOR> again (success) or hand off to a
 * different color (failure)?
 */
function occurrencesRecoveryRepeat(chronoEvents, color, p75Threshold) {
  if (p75Threshold == null) return [];
  const occurrences = [];
  let lastPos = null;
  for (let i = 0; i < chronoEvents.length; i++) {
    const event = chronoEvents[i];
    if (lastPos != null) {
      const drought = event.position - lastPos;
      const wasSuppressedRecovery = drought > p75Threshold && event.eventColor === color;
      if (wasSuppressedRecovery && chronoEvents[i + 1]) {
        occurrences.push({ success: chronoEvents[i + 1].eventColor === color, atEventDrawId: chronoEvents[i + 1].drawId });
      }
    }
    if (event.eventColor === color) lastPos = event.position;
  }
  return occurrences;
}

/**
 * Given a template's full occurrence list (chronological), split at the
 * persisted discovery anchor (if any) and compute the standard pattern
 * readout: in-sample discovery stats (frozen, historical) plus current
 * forward (out-of-sample) stats, plus a status derived ONLY from the
 * forward slice. If no anchor exists yet, checks whether the discovery
 * bar is now met and returns a signal to create one this cycle.
 */
function evaluatePatternFromOccurrences(occurrences, existingAnchor) {
  const totalOccurrences = occurrences.length;

  if (!existingAnchor) {
    if (totalOccurrences < DISCOVERY_MIN_OCCURRENCES) {
      return { discovered: false };
    }
    const successCount = occurrences.filter(o => o.success).length;
    const ratePct = round1((successCount / totalOccurrences) * 100);
    if (ratePct < DISCOVERY_MIN_RATE_PCT) {
      return { discovered: false };
    }
    // Discovery bar met -- signal the caller to persist a fresh anchor
    // at the CURRENT occurrence count, using all of it as this pattern's
    // frozen discovery evidence.
    return {
      discovered: true,
      newAnchor: {
        discoveredAtOccurrenceIndex: totalOccurrences,
        discoveryProbabilityPct: ratePct,
        discoverySampleSize: totalOccurrences,
        firstDiscoveredAt: new Date().toISOString()
      }
    };
  }

  // Anchor already exists -- score ONLY what's happened since.
  const forwardOccurrences = occurrences.slice(existingAnchor.discoveredAtOccurrenceIndex);
  const forwardSuccess = forwardOccurrences.filter(o => o.success).length;
  const forwardTotal = forwardOccurrences.length;
  const forwardRatePct = forwardTotal > 0 ? round1((forwardSuccess / forwardTotal) * 100) : null;

  let status = 'UNVALIDATED';
  if (forwardTotal >= FORWARD_MIN_OCCURRENCES_TO_JUDGE) {
    if (forwardRatePct >= VALIDATED_MIN_RATE_PCT) {
      status = 'VALIDATED';
    } else if (forwardRatePct >= DECAYING_MIN_RATE_PCT) {
      status = 'DECAYING';
    } else if (forwardTotal >= RETIRED_MAX_FORWARD_OCCURRENCES_UNRESOLVED || forwardRatePct < 25) {
      status = 'RETIRED';
    } else {
      status = 'DECAYING';
    }
  }

  const decayScore = forwardRatePct != null
    ? clamp(round1(existingAnchor.discoveryProbabilityPct - forwardRatePct), 0, 100)
    : 0;

  return {
    discovered: true,
    anchorExists: true,
    discoveryProbabilityPct: existingAnchor.discoveryProbabilityPct,
    discoverySampleSize: existingAnchor.discoverySampleSize,
    firstDiscoveredAt: existingAnchor.firstDiscoveredAt,
    forwardSampleSize: forwardTotal,
    forwardSuccessCount: forwardSuccess,
    forwardFailureCount: forwardTotal - forwardSuccess,
    currentProbabilityPct: forwardRatePct,
    status,
    decayScore,
    confidence: (existingAnchor.discoverySampleSize + forwardTotal) >= 25 ? 'HIGH' : (existingAnchor.discoverySampleSize + forwardTotal) >= 10 ? 'MEDIUM' : 'LOW'
  };
}

/**
 * Picks the single most likely destination color for a given FROM color,
 * per Phase 2's CURRENT rotation matrix -- used only at the moment a
 * rotation pattern is first proposed, then locked in as that pattern's
 * permanent target (see occurrencesRotation's header).
 */
function pickRotationTarget(rotationMatrix, from) {
  if (!rotationMatrix || !rotationMatrix[from]) return null;
  const probs = rotationMatrix[from].probabilities;
  let best = null, bestPct = -1;
  HIERARCHY.forEach(to => {
    if (to === from) return; // a color "rotating to itself" is just a repeat, already covered by RECOVERY_REPEAT -- rotation patterns are specifically about handoff to a DIFFERENT color
    if (probs[to] != null && probs[to] > bestPct) { bestPct = probs[to]; best = to; }
  });
  return best;
}

/**
 * Main entry point, called once per council cycle. fiveBallHarvest and
 * fiveBallResearch are Phase 1/2's own full results (read-only -- this
 * engine never writes back into either).
 */
function evaluateFiveBallLearningEngine(fiveBallHarvest, fiveBallResearch, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const harvest = fiveBallHarvest || {};
  const research = fiveBallResearch || {};

  if (!research.ready) {
    return {
      engine: '5-Ball Learning Engine',
      phase: 3,
      ready: false,
      predictionMode: 'LOCKED',
      reasoning: 'Research Lab (Phase 2) is not ready yet -- nothing to learn from.'
    };
  }

  const chronoEvents = chronologicalEvents(harvest.eventLog);
  const patterns = [];

  function considerPattern(id, category, color, description, occurrences) {
    const existing = memory.patterns[id] || null;
    const result = evaluatePatternFromOccurrences(occurrences, existing);
    if (!result.discovered) return; // below the discovery bar -- correctly produces nothing rather than forcing a pattern into existence

    if (result.newAnchor) {
      memory.patterns[id] = result.newAnchor;
      // Freshly discovered THIS cycle -- report it as UNVALIDATED with
      // zero forward evidence yet (honest: discovery evidence alone
      // never counts as validation).
      patterns.push({
        id, category, color, description,
        status: 'UNVALIDATED',
        discoveryProbabilityPct: result.newAnchor.discoveryProbabilityPct,
        discoverySampleSize: result.newAnchor.discoverySampleSize,
        firstDiscoveredAt: result.newAnchor.firstDiscoveredAt,
        forwardSampleSize: 0, forwardSuccessCount: 0, forwardFailureCount: 0,
        currentProbabilityPct: null, decayScore: 0, confidence: 'LOW'
      });
      return;
    }

    patterns.push({
      id, category, color, description,
      status: result.status,
      discoveryProbabilityPct: result.discoveryProbabilityPct,
      discoverySampleSize: result.discoverySampleSize,
      firstDiscoveredAt: result.firstDiscoveredAt,
      forwardSampleSize: result.forwardSampleSize,
      forwardSuccessCount: result.forwardSuccessCount,
      forwardFailureCount: result.forwardFailureCount,
      currentProbabilityPct: result.currentProbabilityPct,
      decayScore: result.decayScore,
      confidence: result.confidence
    });
  }

  HIERARCHY.forEach(color => {
    const gapStats = research.gapsByColor && research.gapsByColor[color];
    const p75 = gapStats && gapStats.percentiles ? gapStats.percentiles.p75 : null;

    considerPattern(
      `SUPPRESSION_RECOVERY_${color}`, 'SUPPRESSION_BEHAVIOR', color,
      `When ${color}'s current drought exceeds its own historical 75th-percentile gap, ${color} itself produces the next 5-ball event.`,
      occurrencesSuppressionRecovery(chronoEvents, color, p75)
    );

    considerPattern(
      `DOMINANCE_CONTINUATION_${color}`, 'DOMINANCE_BEHAVIOR', color,
      `When ${color} holds >= 50% of the last ${DOMINANCE_WINDOW} events, ${color} also produces the next event (dominance continues).`,
      occurrencesDominanceContinuation(chronoEvents, color)
    );

    considerPattern(
      `RECOVERY_REPEAT_${color}`, 'RECOVERY_BEHAVIOR', color,
      `After ${color} resolves its own suppression drought, ${color} repeats again as the very next event.`,
      occurrencesRecoveryRepeat(chronoEvents, color, p75)
    );
  });

  HIERARCHY.forEach(from => {
    const target = pickRotationTarget(research.rotation && research.rotation.matrix, from);
    if (!target) return;
    considerPattern(
      `ROTATION_${from}_TO_${target}`, 'TRANSITION_BEHAVIOR', from,
      `When the most recent event was ${from}, the next event tends to be ${target}.`,
      occurrencesRotation(chronoEvents, from, target)
    );
  });

  memory.updatedAt = new Date().toISOString();

  const validatedPatterns = patterns.filter(p => p.status === 'VALIDATED');
  const decayingPatterns = patterns.filter(p => p.status === 'DECAYING');
  const retiredPatterns = patterns.filter(p => p.status === 'RETIRED');
  const unvalidatedPatterns = patterns.filter(p => p.status === 'UNVALIDATED');

  // Learning maturity -- a simple, transparent, documented composite (not
  // a machine-learned score): half from how much RAW event evidence
  // exists overall (capped at a 100-event target), half from how much of
  // the discovered pattern library has actually earned VALIDATED status
  // rather than just existing. Deliberately conservative -- this number
  // is informational only; see predictionMode below for why it can never
  // auto-activate anything regardless of how high it climbs.
  const totalEvents = harvest.totalEventsCaptured || 0;
  const evidenceMaturity = clamp((totalEvents / 100) * 100, 0, 100);
  const patternMaturity = patterns.length > 0 ? clamp((validatedPatterns.length / patterns.length) * 100, 0, 100) : 0;
  const learningMaturityPct = round1(evidenceMaturity * 0.5 + patternMaturity * 0.5);

  const reasoning = `Learning Engine (Phase 3, LEARNING MODE): ${patterns.length} candidate pattern(s) tracked `
    + `(${validatedPatterns.length} validated, ${decayingPatterns.length} decaying, ${retiredPatterns.length} retired, ${unvalidatedPatterns.length} still unvalidated). `
    + `Learning maturity ${learningMaturityPct}% -- prediction mode remains LOCKED regardless (Phase 5/6 -- Shadow/Live Prediction -- not built; this engine never auto-activates a prediction capability).`;

  return {
    engine: '5-Ball Learning Engine',
    phase: 3,
    ready: true,
    patterns,
    patternCounts: {
      total: patterns.length,
      validated: validatedPatterns.length,
      decaying: decayingPatterns.length,
      retired: retiredPatterns.length,
      unvalidated: unvalidatedPatterns.length
    },
    learningStatus: {
      totalDrawsObserved: harvest.totalDrawsObserved || 0,
      totalEventsCaptured: totalEvents,
      perColorEventCounts: harvest.perColorEventCounts || { RED: 0, BLUE: 0, GREEN: 0 },
      patternLibrarySize: patterns.length,
      validatedPatternCount: validatedPatterns.length,
      learningMaturityPct
    },
    predictionMode: 'LOCKED', // hard-locked -- see this file's header
    reasoning
  };
}

module.exports = {
  DISCOVERY_MIN_OCCURRENCES,
  DISCOVERY_MIN_RATE_PCT,
  FORWARD_MIN_OCCURRENCES_TO_JUDGE,
  VALIDATED_MIN_RATE_PCT,
  DECAYING_MIN_RATE_PCT,
  freshLearningMemory,
  ensureMemoryShape,
  occurrencesSuppressionRecovery,
  occurrencesDominanceContinuation,
  occurrencesRotation,
  occurrencesRecoveryRepeat,
  evaluatePatternFromOccurrences,
  pickRotationTarget,
  evaluateFiveBallLearningEngine
};
