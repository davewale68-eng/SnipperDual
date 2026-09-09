/**
 * 5-BALL DUAL-COLOR NEXT EVENT PREDICTION ENGINE (Phase 8 of the 5-Ball
 * Research Lab)
 *
 * WHAT THIS IS, AND HOW IT DIFFERS FROM PHASE 7: fiveBallNextEventEngine.js
 * (Phase 7) is a continuous, always-on leaderboard blend of five signal
 * sources, re-scored every single cycle, SHADOW-ONLY and never session-
 * based. This engine is deliberately the opposite shape: it is EVENT-
 * TRIGGERED, not continuous. It does nothing at all until a genuine 5-ball
 * event lands, at which point it freezes exactly TWO color calls (a REPEAT
 * candidate and a TRANSITION candidate, each with a distinct behavioral
 * justification) and opens a single 25-DRAW SESSION to watch for the next
 * 5-ball event. It is a sibling of Phase 7, not a replacement -- the two
 * approaches' track records are kept in entirely separate memory so they
 * can eventually be compared honestly.
 *
 * THE TWO SIGNAL ROLES (never just "the two highest raw probabilities"):
 *   - REPEAT CANDIDATE: the color that JUST produced the triggering event.
 *     Its own historical "does it repeat as the very next event" rate,
 *     read from fiveBallResearchLab.js's computeConsecutiveRepeats()
 *     output (research.consecutive.byColor[triggerColor]).
 *   - TRANSITION CANDIDATE: the historically strongest OPPONENT color --
 *     i.e. among the colors OTHER than the trigger color, whichever one
 *     the first-order rotation matrix (research.rotation.matrix
 *     [triggerColor].probabilities) assigns the highest observed
 *     probability to. Restricting the search to "other than the trigger
 *     color" is this engine's collision rule: since the repeat candidate
 *     is ALWAYS the trigger color by definition, the transition candidate
 *     can never collide with it, so the two calls are guaranteed distinct
 *     without needing a second, separate tie-break step.
 *   Fallback: if the rotation matrix has no sample for this trigger color
 *   yet (e.g. very first few events), the transition candidate instead
 *   falls back to whichever non-trigger color has the higher standalone
 *   repeatRatePct from the consecutive-repeat stats -- weaker evidence,
 *   openly labeled EXPLORATORY via evidence tiering below, but still a
 *   principled, non-arbitrary choice rather than a coin flip.
 *
 * SESSION LIFECYCLE (see this file's own state machine, matches the
 * approved blueprint exactly):
 *   WAITING_FOR_EVENT -> EVENT_DETECTED -> PREDICTION_ARMED ->
 *   TRACKING_WINDOW -> HIT | MISS -> SESSION_CLOSED -> WAITING_FOR_EVENT
 * Only ONE session is ever active at a time. While a session is active,
 * further 5-ball events are consumed AS CANDIDATE HITS against that
 * session's own two predicted colors -- they do NOT retroactively rewrite
 * the frozen prediction, and they do NOT spawn a second concurrent
 * session. Once the active session closes (HIT or window expiry -> MISS),
 * the most recent captured event (which may already be newer than the one
 * that triggered the session that just closed) immediately arms the next
 * session. This is exactly the "the old session resolves on its own
 * rules, then the new event starts a new session" rule from the approved
 * spec, without ever needing two sessions open simultaneously.
 *
 * WINDOW UNIT IS DRAWS, NOT EVENTS: the 25-draw horizon is measured
 * against fiveBallHarvester.js's own totalDrawsObserved running counter
 * (incremented once per real draw, event or not) and each captured
 * event's own `position` field (that counter's value at the moment the
 * event was captured) -- NOT a count of intervening 5-ball events. This
 * is what lets a session correctly expire to MISS after 25 real draws
 * even if zero further 5-ball events land in that span.
 *
 * FROZEN PREDICTION vs EVOLVING INTELLIGENCE: a session's repeatColor,
 * transitionColor, confidences, and sample sizes are captured ONCE, at
 * arm time, and never recalculated against the Research Lab's later
 * (possibly different) numbers -- exactly the "prediction snapshot is
 * frozen, research intelligence keeps evolving" separation the approved
 * spec calls out as essential for a clean audit trail. This engine
 * computes no base statistics of its own; it only reads fiveBallHarvest
 * and fiveBallResearch's already-final output.
 *
 * ============================================================
 * QUARANTINE -- SAME DISCIPLINE AS PHASES 5/7, READ BEFORE CHANGING
 * ============================================================
 * SHADOW/AUDIT ONLY. Never read by 4SIL, never read by Parliament, never
 * votes, never gates anything, and is not wired into
 * fiveBallLivePredictionEngine.js's eligibility in any way. Whether this
 * engine's dual-color/session approach should ever feed live-eligibility
 * is an explicit, separate, future operator decision once it has built
 * its own real out-of-sample track record -- the same bar every other
 * 5-ball engine already had to clear.
 *
 * EVIDENCE TIERING (sample-size honesty, per the approved spec's
 * "don't let small samples dominate" section): each side's own sample
 * size (repeat: opportunities; transition: rotation row's sampleSize, or
 * the fallback's own opportunities count) maps to a tier so a 66.7%
 * transition read off 3 observations is never presented with the same
 * weight as the same percentage off 60 observations:
 *   < 8            EXPLORATORY
 *   8  - 24        EMERGING
 *   25 - 74        ESTABLISHED
 *   75+            STRONG
 * These thresholds are fixed/documented on purpose, same reasoning as
 * Phase 7's fixed WEIGHTS -- a tier boundary that silently drifted as
 * history accumulated would defeat the point of an auditable label.
 */
'use strict';

const HIERARCHY = ['RED', 'BLUE', 'GREEN'];
const WINDOW_SIZE_DRAWS = 25;
const MAX_SESSION_LOG_ENTRIES = 500;

const EVIDENCE_TIERS = [
  { max: 7, label: 'EXPLORATORY' },
  { max: 24, label: 'EMERGING' },
  { max: 74, label: 'ESTABLISHED' },
  { max: Infinity, label: 'STRONG' }
];

function round1(n) {
  return Math.round(n * 10) / 10;
}

function evidenceTier(sampleSize) {
  const n = sampleSize || 0;
  return (EVIDENCE_TIERS.find(t => n <= t.max) || EVIDENCE_TIERS[EVIDENCE_TIERS.length - 1]).label;
}

function freshDualColorMemory() {
  return {
    schemaVersion: 1,
    activeSession: null,
    lastArmedTriggerPosition: null,
    sessionLog: [],
    updatedAt: null
  };
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (typeof m.activeSession === 'undefined') m.activeSession = null;
  if (typeof m.lastArmedTriggerPosition === 'undefined') m.lastArmedTriggerPosition = null;
  if (!Array.isArray(m.sessionLog)) m.sessionLog = [];
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  return m;
}

function pushCapped(log, entry) {
  log.unshift(entry);
  if (log.length > MAX_SESSION_LOG_ENTRIES) log.length = MAX_SESSION_LOG_ENTRIES;
}

/**
 * Selects the REPEAT and TRANSITION candidates for a newly-captured
 * trigger event, per this file's header. Returns null if the Research
 * Lab genuinely has nothing to go on yet (should not happen once
 * research.ready is true, since consecutive stats need only 1 prior
 * opportunity, but guarded defensively).
 */
function selectDualColors(triggerColor, research) {
  const consecutive = research.consecutive || { byColor: {} };
  const rotation = research.rotation || { ready: false, matrix: null };

  const repeatStats = consecutive.byColor ? consecutive.byColor[triggerColor] : null;
  const repeatColor = triggerColor;
  const repeatConfidencePct = repeatStats && Number.isFinite(repeatStats.repeatRatePct) ? repeatStats.repeatRatePct : 0;
  const repeatSampleSize = repeatStats ? repeatStats.opportunities : 0;

  const otherColors = HIERARCHY.filter(c => c !== triggerColor);

  let transitionColor = null;
  let transitionConfidencePct = 0;
  let transitionSampleSize = 0;
  let transitionSource = 'NONE';

  const row = rotation.ready && rotation.matrix ? rotation.matrix[triggerColor] : null;
  if (row && row.sampleSize > 0) {
    let best = null;
    otherColors.forEach(c => {
      const p = row.probabilities[c];
      if (Number.isFinite(p) && (best === null || p > best.p)) best = { color: c, p };
    });
    if (best) {
      transitionColor = best.color;
      transitionConfidencePct = best.p;
      transitionSampleSize = row.sampleSize;
      transitionSource = 'ROTATION_MATRIX';
    }
  }

  if (!transitionColor) {
    // Fallback: no rotation sample yet for this trigger color -- fall
    // back to the standalone repeat-rate of the OTHER two colors (still
    // from computeConsecutiveRepeats(), just not conditioned on the
    // trigger color), and pick whichever is higher. Openly weaker
    // evidence, always tiered EXPLORATORY-or-lower via its own low
    // sample size.
    let best = null;
    otherColors.forEach(c => {
      const stats = consecutive.byColor ? consecutive.byColor[c] : null;
      const p = stats && Number.isFinite(stats.repeatRatePct) ? stats.repeatRatePct : 0;
      const n = stats ? stats.opportunities : 0;
      if (best === null || p > best.p) best = { color: c, p, n };
    });
    if (best) {
      transitionColor = best.color;
      transitionConfidencePct = best.p;
      transitionSampleSize = best.n;
      transitionSource = 'FALLBACK_STANDALONE_REPEAT_RATE';
    } else {
      // Genuinely nothing to go on -- pick the first other color so the
      // session can still arm, at EXPLORATORY/0% confidence.
      transitionColor = otherColors[0];
      transitionConfidencePct = 0;
      transitionSampleSize = 0;
      transitionSource = 'NO_EVIDENCE';
    }
  }

  return {
    repeatColor,
    repeatConfidencePct: round1(repeatConfidencePct),
    repeatSampleSize,
    repeatTier: evidenceTier(repeatSampleSize),
    transitionColor,
    transitionConfidencePct: round1(transitionConfidencePct),
    transitionSampleSize,
    transitionTier: evidenceTier(transitionSampleSize),
    transitionSource
  };
}

/**
 * Derives the engine's current "predictive character" label from the two
 * armed sides' confidence, per the approved spec's "adaptive predictive
 * character" section. Purely descriptive/reasoning output -- never
 * changes which colors were called.
 */
function deriveCharacter(repeatConfidencePct, transitionConfidencePct, repeatTier, transitionTier) {
  const repeatWeak = repeatTier === 'EXPLORATORY';
  const transitionWeak = transitionTier === 'EXPLORATORY';
  if (repeatWeak && transitionWeak) return 'EXPLORATORY';
  if (repeatConfidencePct >= 50 && transitionConfidencePct >= 50) return 'DUAL-CONFIRMATION';
  if (transitionConfidencePct > repeatConfidencePct) return 'TRANSITION-LED';
  if (repeatConfidencePct > transitionConfidencePct) return 'REPEAT-LED';
  return 'BALANCED';
}

/**
 * Arms a brand-new session off the given trigger event. Caller is
 * responsible for having already confirmed this trigger event hasn't
 * been armed off before (memory.lastArmedTriggerPosition dedup).
 */
function armSession(memory, triggerEvent, research, sessionSeq) {
  const dual = selectDualColors(triggerEvent.eventColor, research);
  const character = deriveCharacter(dual.repeatConfidencePct, dual.transitionConfidencePct, dual.repeatTier, dual.transitionTier);

  memory.activeSession = {
    sessionId: `5BDC-${sessionSeq}`,
    triggerDrawId: triggerEvent.drawId,
    triggerEventColor: triggerEvent.eventColor,
    triggerPosition: triggerEvent.position,
    triggerTimestamp: triggerEvent.timestamp || null,
    armedAt: new Date().toISOString(),

    repeatColor: dual.repeatColor,
    repeatConfidencePct: dual.repeatConfidencePct,
    repeatSampleSize: dual.repeatSampleSize,
    repeatTier: dual.repeatTier,

    transitionColor: dual.transitionColor,
    transitionConfidencePct: dual.transitionConfidencePct,
    transitionSampleSize: dual.transitionSampleSize,
    transitionTier: dual.transitionTier,
    transitionSource: dual.transitionSource,

    predictedColors: [dual.repeatColor, dual.transitionColor],
    character,

    windowSizeDraws: WINDOW_SIZE_DRAWS,
    status: 'ACTIVE',

    repeatHit: false,
    transitionHit: false,
    firstHitColor: null,
    firstHitDrawId: null,
    firstHitDrawsElapsed: null
  };
  memory.lastArmedTriggerPosition = triggerEvent.position;
}

/**
 * Advances the active session against whatever new events/draws have
 * landed since it was armed. Closes it (HIT or MISS) when appropriate;
 * otherwise just updates its live "draws elapsed" reading.
 */
function advanceActiveSession(memory, harvest) {
  const session = memory.activeSession;
  if (!session) return;

  const eventLog = harvest.eventLog || []; // newest-first
  // Qualifying events: strictly after the trigger, in chronological
  // (oldest-first) order, so the FIRST hit found is genuinely the first
  // in time.
  const qualifying = eventLog
    .filter(e => e.position > session.triggerPosition)
    .slice()
    .sort((a, b) => a.position - b.position);

  qualifying.forEach(e => {
    const drawsElapsed = e.position - session.triggerPosition;
    if (drawsElapsed > session.windowSizeDraws) return; // outside the window, ignore
    if (e.eventColor === session.repeatColor) session.repeatHit = true;
    if (e.eventColor === session.transitionColor) session.transitionHit = true;
    if (!session.firstHitColor && (e.eventColor === session.repeatColor || e.eventColor === session.transitionColor)) {
      session.firstHitColor = e.eventColor;
      session.firstHitDrawId = e.drawId;
      session.firstHitDrawsElapsed = drawsElapsed;
    }
  });

  const currentDrawsElapsed = Math.max(0, (harvest.totalDrawsObserved || 0) - session.triggerPosition);
  session.currentDrawsElapsed = Math.min(currentDrawsElapsed, session.windowSizeDraws);

  if (session.firstHitColor) {
    closeSession(memory, 'HIT');
  } else if (currentDrawsElapsed >= session.windowSizeDraws) {
    closeSession(memory, 'MISS');
  }
  // else stays ACTIVE, tracked via currentDrawsElapsed above
}

function closeSession(memory, outcome) {
  const session = memory.activeSession;
  if (!session) return;
  session.status = outcome;
  session.closedAt = new Date().toISOString();
  session.bothColorsHit = !!(session.repeatHit && session.transitionHit);
  pushCapped(memory.sessionLog, { ...session });
  memory.activeSession = null;
}

/**
 * Main entry point, called once per council cycle. fiveBallHarvest and
 * fiveBallResearch are upstream phases' own full read-only results.
 */
function evaluateFiveBallDualColorNextEvent(fiveBallHarvest, fiveBallResearch, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const harvest = fiveBallHarvest || {};
  const research = fiveBallResearch || {};

  if (!research.ready || !harvest.mostRecentEvent) {
    return {
      engine: '5-Ball Dual-Color Next Event Engine',
      phase: 8,
      mode: 'SHADOW_ONLY',
      ready: false,
      windowSizeDraws: WINDOW_SIZE_DRAWS,
      activeSession: memory.activeSession,
      recentSessions: memory.sessionLog.slice(0, 20),
      reasoning: 'Research Lab is not ready yet (fewer than 2 captured events) -- nothing to arm a repeat/transition prediction from.'
    };
  }

  if (memory.activeSession) {
    advanceActiveSession(memory, harvest);
  }

  if (!memory.activeSession) {
    const trigger = harvest.mostRecentEvent;
    if (trigger.position !== memory.lastArmedTriggerPosition) {
      const sessionSeq = memory.sessionLog.length + 1;
      armSession(memory, trigger, research, sessionSeq);
    }
  }

  memory.updatedAt = new Date().toISOString();

  const resolved = memory.sessionLog;
  const hits = resolved.filter(s => s.status === 'HIT').length;
  const misses = resolved.filter(s => s.status === 'MISS').length;
  const bothColorHits = resolved.filter(s => s.bothColorsHit).length;
  const repeatHits = resolved.filter(s => s.repeatHit).length;
  const transitionHits = resolved.filter(s => s.transitionHit).length;
  const hitDraws = resolved.filter(s => s.status === 'HIT' && Number.isFinite(s.firstHitDrawsElapsed)).map(s => s.firstHitDrawsElapsed);
  const avgHitDraw = hitDraws.length ? round1(hitDraws.reduce((a, b) => a + b, 0) / hitDraws.length) : null;
  const sortedHitDraws = hitDraws.slice().sort((a, b) => a - b);
  const medianHitDraw = sortedHitDraws.length
    ? (sortedHitDraws.length % 2 === 1
        ? sortedHitDraws[(sortedHitDraws.length - 1) / 2]
        : round1((sortedHitDraws[sortedHitDraws.length / 2 - 1] + sortedHitDraws[sortedHitDraws.length / 2]) / 2))
    : null;

  const evaluation = {
    totalSessions: resolved.length,
    hits,
    misses,
    hitRatePct: resolved.length > 0 ? round1((hits / resolved.length) * 100) : null,
    avgHitDraw,
    medianHitDraw,
    repeatHits,
    transitionHits,
    bothColorHits
  };

  const session = memory.activeSession;
  const reasoning = session
    ? `ACTIVE SESSION ${session.sessionId} (audit only, never acted on): armed off a ${session.triggerEventColor} 5-ball event at draw ${session.triggerDrawId}. Predicting ${session.repeatColor} (REPEAT, ${session.repeatConfidencePct}% / ${session.repeatTier}) and ${session.transitionColor} (TRANSITION, ${session.transitionConfidencePct}% / ${session.transitionTier}) to produce the next 5-ball event within ${session.windowSizeDraws} draws. Character: ${session.character}. Currently ${session.currentDrawsElapsed}/${session.windowSizeDraws} draws in, searching. Track record so far: ${evaluation.hits}/${evaluation.totalSessions} (${evaluation.hitRatePct != null ? evaluation.hitRatePct + '%' : 'n/a'}).`
    : `No active session (awaiting the next 5-ball event to arm one). Track record so far: ${evaluation.hits}/${evaluation.totalSessions} (${evaluation.hitRatePct != null ? evaluation.hitRatePct + '%' : 'n/a'}).`;

  return {
    engine: '5-Ball Dual-Color Next Event Engine',
    phase: 8,
    mode: 'SHADOW_ONLY', // same quarantine as Phases 5/7 -- see this file's header
    ready: true,
    windowSizeDraws: WINDOW_SIZE_DRAWS,
    evidenceTiers: EVIDENCE_TIERS.map(t => t.label),
    activeSession: memory.activeSession,
    recentSessions: resolved.slice(0, 20),
    evaluation,
    reasoning
  };
}

module.exports = {
  WINDOW_SIZE_DRAWS,
  EVIDENCE_TIERS,
  freshDualColorMemory,
  ensureMemoryShape,
  selectDualColors,
  deriveCharacter,
  armSession,
  advanceActiveSession,
  closeSession,
  evaluateFiveBallDualColorNextEvent
};
