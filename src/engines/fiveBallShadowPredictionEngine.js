/**
 * 5-BALL SHADOW PREDICTION ENGINE (Phase 5 of the 5-Ball Research Lab)
 *
 * PHASE 5 ONLY. Per the approved architecture: Harvest -> Research ->
 * Learning -> Validation -> Shadow Prediction -> Live Prediction. The
 * approved spec's own words: "The engine starts predicting internally
 * but doesn't expose or trade the predictions. Audit it." This is the
 * FIRST phase in the whole 5-ball lab that computes anything resembling
 * an actual prediction -- everything before this (Phases 1-4) was
 * strictly observational.
 *
 * ============================================================
 * QUARANTINE -- READ THIS BEFORE CHANGING ANYTHING IN THIS FILE
 * ============================================================
 * This engine's output is SHADOW ONLY. It is never read by 4SIL, never
 * read by Parliament, never votes, never gates anything, and there is no
 * code path anywhere in this codebase that surfaces its calls as
 * something to act on. `mode` below is hard-locked to 'SHADOW_ONLY' the
 * same way fiveBallLearningEngine.js hard-locks predictionMode to
 * 'LOCKED' -- there is no code path here that ever writes anything else.
 * Its entire purpose is to log calls and audit them against real
 * outcomes so a FUTURE, EXPLICIT decision (Phase 6 -- Live Prediction,
 * not built) can be made from real track-record evidence instead of
 * assumption. Turning any of this into something that actually
 * influences a live decision is Phase 6 work, requires an explicit
 * operator decision when that phase is built, and is out of scope here.
 *
 * HOW A SHADOW CALL IS FORMED: only patterns that are CURRENTLY
 * VALIDATED (Phase 3's live status) AND CURRENTLY SIGNIFICANT (Phase 4's
 * live Wilson-bound check) are eligible at all -- an unvalidated or
 * statistically insignificant pattern never contributes to a call, no
 * matter how good its raw discovery number looked. Of those eligible
 * patterns, only ones whose TRIGGER CONDITION IS TRUE RIGHT NOW (e.g.
 * for SUPPRESSION_RECOVERY_RED, is RED's current drought actually past
 * its own p75 threshold at this exact moment) actually vote. If every
 * voting pattern agrees on one color, that's the shadow call. If two or
 * more DIFFERENT colors get votes, this engine deliberately calls
 * NO_CALL rather than picking a winner -- arbitrarily breaking a tie
 * would manufacture false confidence the evidence doesn't support. If no
 * eligible pattern is currently triggered, that's also NO_CALL --
 * "NO RELIABLE PATTERN" (the approved spec's own principle, carried all
 * the way through the lab) applies here too.
 *
 * PERSISTENT STATE, AND WHY: unlike Phases 2-4 (pure recomputes), this
 * engine has to remember an OPEN call across cycles so it can be graded
 * against whatever the actual next 5-ball event turns out to be -- a
 * "calling context" that only exists transiently and must be logged as
 * it happens, same reasoning as e.g. fourBallTieClusterEngine.js's own
 * persistent memory. Only ONE call is ever open at a time (a fresh call
 * cannot be logged while one is still pending resolution), mirroring the
 * single-slot watch-and-resolve pattern used throughout this codebase
 * (see threeBallEntryHitCounter.js).
 */
'use strict';

const HIERARCHY = ['RED', 'BLUE', 'GREEN'];
const MAX_CALL_LOG_ENTRIES = 500;

function freshShadowMemory() {
  return {
    schemaVersion: 1,
    pendingCall: null, // { calledAtEventCount, calledColor, contributingPatternIds, calledAt }
    callLog: [], // resolved calls, most-recent-first, capped
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
 * Live trigger checks -- is this pattern's underlying condition true
 * RIGHT NOW (looking forward from the current moment, not "was it true
 * at some past event"). Reuses already-computed Phase 2 reference stats
 * (gapsByColor, dominance) wherever possible rather than re-deriving
 * anything from scratch.
 */
function isSuppressionRecoveryTriggered(color, fiveBallResearch) {
  const g = fiveBallResearch.gapsByColor && fiveBallResearch.gapsByColor[color];
  if (!g || g.currentGap == null || !g.percentiles) return false;
  return g.currentGap > g.percentiles.p75;
}

function isDominanceContinuationTriggered(color, fiveBallResearch) {
  const dom = fiveBallResearch.dominance;
  if (!dom || !dom.ready || !dom.shareByColor) return false;
  return dom.shareByColor[color] >= 50; // matches fiveBallResearchLab.js's DOMINANCE_SHARE_THRESHOLD
}

function isRotationTriggered(from, fiveBallHarvest) {
  const mostRecent = fiveBallHarvest.mostRecentEvent;
  return !!(mostRecent && mostRecent.eventColor === from);
}

function isRecoveryRepeatTriggered(color, fiveBallHarvest, fiveBallResearch) {
  const mostRecent = fiveBallHarvest.mostRecentEvent;
  if (!mostRecent || mostRecent.eventColor !== color) return false;
  const eventsOfColor = (fiveBallHarvest.eventLog || []).filter(e => e.eventColor === color);
  if (eventsOfColor.length < 2) return false;
  const [latest, previous] = eventsOfColor; // eventLog is most-recent-first
  const droughtAtThatTime = latest.position - previous.position;
  const g = fiveBallResearch.gapsByColor && fiveBallResearch.gapsByColor[color];
  if (!g || !g.percentiles) return false;
  return droughtAtThatTime > g.percentiles.p75;
}

/**
 * For a given eligible pattern (already validated + significant), parses
 * its id/category to determine (a) whether its trigger is currently
 * true, and (b) which color it would be calling if so.
 */
function evaluatePatternLiveTrigger(pattern, fiveBallHarvest, fiveBallResearch) {
  switch (pattern.category) {
    case 'SUPPRESSION_BEHAVIOR':
      return { triggered: isSuppressionRecoveryTriggered(pattern.color, fiveBallResearch), impliedColor: pattern.color };
    case 'DOMINANCE_BEHAVIOR':
      return { triggered: isDominanceContinuationTriggered(pattern.color, fiveBallResearch), impliedColor: pattern.color };
    case 'RECOVERY_BEHAVIOR':
      return { triggered: isRecoveryRepeatTriggered(pattern.color, fiveBallHarvest, fiveBallResearch), impliedColor: pattern.color };
    case 'TRANSITION_BEHAVIOR': {
      const targetMatch = pattern.id.match(/^ROTATION_(RED|BLUE|GREEN)_TO_(RED|BLUE|GREEN)$/);
      if (!targetMatch) return { triggered: false, impliedColor: null };
      return { triggered: isRotationTriggered(targetMatch[1], fiveBallHarvest), impliedColor: targetMatch[2] };
    }
    default:
      return { triggered: false, impliedColor: null };
  }
}

/**
 * Resolves a pending call (if any) against a newly-landed 5-ball event.
 */
function resolvePendingCall(memory, newestEvent) {
  if (!memory.pendingCall || !newestEvent) return;
  const hit = newestEvent.eventColor === memory.pendingCall.calledColor;
  pushCapped(memory.callLog, {
    calledAtEventCount: memory.pendingCall.calledAtEventCount,
    calledColor: memory.pendingCall.calledColor,
    contributingPatternIds: memory.pendingCall.contributingPatternIds,
    calledAt: memory.pendingCall.calledAt,
    resolvedDrawId: newestEvent.drawId,
    resolvedColor: newestEvent.eventColor,
    hit
  });
  memory.pendingCall = null;
}

/**
 * Main entry point, called once per council cycle. fiveBallHarvest,
 * fiveBallLearning, fiveBallValidation are Phases 1/3/4's own full
 * results (read-only -- this engine never writes back into any of
 * them).
 */
function evaluateFiveBallShadowPrediction(fiveBallHarvest, fiveBallResearch, fiveBallLearning, fiveBallValidation, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const harvest = fiveBallHarvest || {};
  const research = fiveBallResearch || {};
  const learning = fiveBallLearning || {};
  const validation = fiveBallValidation || {};

  if (!research.ready || !learning.ready || !validation.ready) {
    return {
      engine: '5-Ball Shadow Prediction Engine',
      phase: 5,
      mode: 'SHADOW_ONLY',
      ready: false,
      reasoning: 'Upstream phases (Research/Learning/Validation) are not all ready yet -- nothing to predict from.'
    };
  }

  // Resolve any pending call FIRST, if a new event has landed since it
  // was made (i.e. totalEventsCaptured has grown past the call's own
  // anchor). Dedup via the call's own anchor -- a call opened at
  // eventCount N resolves against the very next event to land, whichever
  // draw that turns out to be.
  const totalEvents = harvest.totalEventsCaptured || 0;
  if (memory.pendingCall && totalEvents > memory.pendingCall.calledAtEventCount) {
    resolvePendingCall(memory, harvest.mostRecentEvent);
  }

  // Only consider opening a NEW call if none is currently pending.
  if (!memory.pendingCall) {
    const validationById = {};
    (validation.patternValidations || []).forEach(v => { validationById[v.id] = v; });

    const eligiblePatterns = (learning.patterns || []).filter(p => {
      const v = validationById[p.id];
      return p.status === 'VALIDATED' && v && v.significance === 'SIGNIFICANT';
    });

    const votesByColor = { RED: [], BLUE: [], GREEN: [] };
    eligiblePatterns.forEach(p => {
      const { triggered, impliedColor } = evaluatePatternLiveTrigger(p, harvest, research);
      if (triggered && impliedColor && votesByColor[impliedColor]) {
        votesByColor[impliedColor].push(p.id);
      }
    });

    const colorsWithVotes = HIERARCHY.filter(c => votesByColor[c].length > 0);

    if (colorsWithVotes.length === 1) {
      const calledColor = colorsWithVotes[0];
      memory.pendingCall = {
        calledAtEventCount: totalEvents,
        calledColor,
        contributingPatternIds: votesByColor[calledColor],
        calledAt: new Date().toISOString()
      };
    }
    // colorsWithVotes.length === 0 -> no eligible pattern is currently
    // triggered -> correctly no call.
    // colorsWithVotes.length > 1 -> conflicting signals -> correctly no
    // call (see this file's header for why arbitrary tie-breaking is
    // deliberately avoided).
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
    ? `SHADOW CALL OPEN (audit only, never acted on): ${memory.pendingCall.calledColor}, called at event #${memory.pendingCall.calledAtEventCount} from pattern(s) ${memory.pendingCall.contributingPatternIds.join(', ')}. Awaiting the next 5-ball event to resolve. Track record so far: ${auditTrail.hits}/${resolvedCalls.length} (${auditTrail.hitRatePct != null ? auditTrail.hitRatePct + '%' : 'n/a'}).`
    : `NO CALL currently open. Track record so far: ${auditTrail.hits}/${resolvedCalls.length} resolved call(s) (${auditTrail.hitRatePct != null ? auditTrail.hitRatePct + '%' : 'n/a'}). This is SHADOW-ONLY audit data -- never exposed as a live prediction.`;

  return {
    engine: '5-Ball Shadow Prediction Engine',
    phase: 5,
    mode: 'SHADOW_ONLY', // hard-locked -- see this file's header
    ready: true,
    pendingCall: memory.pendingCall,
    recentCalls: resolvedCalls.slice(0, 20),
    auditTrail,
    reasoning
  };
}

module.exports = {
  MAX_CALL_LOG_ENTRIES,
  freshShadowMemory,
  ensureMemoryShape,
  isSuppressionRecoveryTriggered,
  isDominanceContinuationTriggered,
  isRotationTriggered,
  isRecoveryRepeatTriggered,
  evaluatePatternLiveTrigger,
  evaluateFiveBallShadowPrediction
};
