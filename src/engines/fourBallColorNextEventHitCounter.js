/**
 * ============================================================
 *  4-BALL COLOR NEXT EVENT HIT COUNTER  (v2 — Event-Level Rewire)
 * ============================================================
 *
 * WHAT CHANGED FROM v1
 * --------------------
 * v1 tracked two pick slots (pick1 = overdue color, pick2 = leading color
 * from the 4-Ball Parliament) and gated on 4SIL's ENTER_NOW signal. That
 * design predicted a specific COLOR for each slot, not the event itself.
 *
 * v2 REWIRE (per operator direction): mirrors zeroColorHitCounter.js v2
 * exactly — predicts the 4-BALL EVENT generally (will ANY color reach
 * 4-ball in the resolution window?), not a specific color. The watch gate
 * is fourBallColorNextEvent.nextEventPrediction.active (same logic as
 * zeroColorHitCounter's nextEventPrediction.active gate). A HIT is any draw
 * where draw.fourBallColor is non-null (any color reached 4-ball). All three
 * colors (RED/BLUE/GREEN) are candidates, consistent with the event
 * definition in fourBallColorNextEventEngine.js. The 4SIL gate is removed —
 * this counter now tracks the engine's own prediction window, not an
 * external gate, exactly as zeroColorHitCounter does.
 *
 * MECHANICS (per zeroColorHitCounter.js v2)
 * ---------
 * - One watch slot open at a time (single-slot discipline).
 * - Gate: fourBallColorNextEvent.nextEventPrediction.active === true.
 * - A fresh nextEventPrediction.active=true while a watch is already
 *   pending is treated as a continuation — does NOT open a second slot.
 * - DRAW-ACCURATE MISS LOGGING: pending watch stores openedAfterDrawId;
 *   every draw in historicalDraws newer than lastProcessedDrawId is walked
 *   chronologically so each draw is checked regardless of cycle frequency.
 * - HIT  : draw.fourBallColor is non-null within WINDOW_DRAWS of open.
 * - MISS : WINDOW_DRAWS draws pass with no 4-ball event.
 * - callType label mirrors zeroColorHitCounter: DUE_IN_N / OVERDUE (+N).
 * - Predictions log: rolling MAX_LOG_SIZE newest-first resolved entries.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational scoring log.
 * Never votes, never feeds back into fourBallColorNextEventEngine or any
 * gate/weight — same discipline as every other *HitCounter.js.
 */
'use strict';

const WINDOW_DRAWS = 8;      // draws given for a HIT before watch is MISS
const MAX_LOG_SIZE = 20;     // keep last N resolved predictions in the log

function freshCounter() {
  return {
    schemaVersion: 2,
    lastProcessedDrawId: null,
    totalCalls: 0,
    eventCall: { hits: 0, misses: 0, pending: null },
    predictions: [],   // newest-first resolved log
    updatedAt: null
  };
}

/**
 * Walk every draw in historicalDraws (newest-first) that is newer than
 * lastProcessedDrawId and return them oldest-first (chronological walk).
 */
function getUnprocessedDraws(historicalDraws, lastProcessedDrawId) {
  if (!Array.isArray(historicalDraws) || historicalDraws.length === 0) return [];
  const unprocessed = [];
  for (const draw of historicalDraws) {
    if (draw == null || draw.drawId == null) continue;
    if (String(draw.drawId) === String(lastProcessedDrawId)) break;
    unprocessed.push(draw);
  }
  return unprocessed.reverse(); // oldest-first
}

/**
 * Advance the pending watch against a single draw (chronological order).
 * A HIT is any draw where fourBallColor is non-null (any color reached 4-ball).
 * Mutates counter in place. Returns 'hit', 'miss', or 'pending'.
 */
function advanceWatch(counter, draw) {
  const pending = counter.eventCall.pending;
  if (!pending) return 'none';

  pending.drawsElapsed++;

  const isFourBallEvent = !!(draw && draw.fourBallColor);

  if (isFourBallEvent) {
    // HIT
    counter.eventCall.hits++;
    const logEntry = {
      result: 'HIT',
      openedAfterDrawId: pending.openedAfterDrawId,
      resolvedOnDrawId: draw.drawId,
      resolvedColor: draw.fourBallColor || null,
      drawsElapsed: pending.drawsElapsed,
      callType: pending.callType,
      timestamp: new Date().toISOString()
    };
    counter.predictions.unshift(logEntry);
    if (counter.predictions.length > MAX_LOG_SIZE) counter.predictions.length = MAX_LOG_SIZE;
    counter.eventCall.pending = null;
    return 'hit';
  }

  if (pending.drawsElapsed >= WINDOW_DRAWS) {
    // MISS
    counter.eventCall.misses++;
    const logEntry = {
      result: 'MISS',
      openedAfterDrawId: pending.openedAfterDrawId,
      resolvedOnDrawId: draw.drawId,
      resolvedColor: null,
      drawsElapsed: pending.drawsElapsed,
      callType: pending.callType,
      timestamp: new Date().toISOString()
    };
    counter.predictions.unshift(logEntry);
    if (counter.predictions.length > MAX_LOG_SIZE) counter.predictions.length = MAX_LOG_SIZE;
    counter.eventCall.pending = null;
    return 'miss';
  }

  return 'pending';
}

/**
 * Main entry point. Called once per council cycle after
 * fourBallColorNextEvent (analyzeFourBallColorNextEvent) has run.
 *
 * fourBallColorNextEvent is the full analyzeFourBallColorNextEvent() result.
 * persistentCounter is store.fourBallColorNextEventHitCounter.
 *
 * Order of operations:
 *   1. Walk all unprocessed draws chronologically, advancing the pending
 *      watch against each one (draw-accurate miss detection).
 *   2. Mark the latest draw as processed.
 *   3. If nextEventPrediction.active and no watch is pending, open a new
 *      watch (new totalCalls entry).
 */
function evaluateFourBallColorNextEventHitCounter(historicalDraws, fourBallColorNextEvent, persistentCounter) {
  // Migrate or initialise counter
  const counter = (persistentCounter && typeof persistentCounter === 'object')
    ? persistentCounter
    : freshCounter();

  // v1 → v2 migration: drop old pick1Slot/pick2Slot structure if present
  if (!counter.eventCall) counter.eventCall = { hits: 0, misses: 0, pending: null };
  if (!Array.isArray(counter.predictions)) counter.predictions = [];
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;
  if (!counter.schemaVersion || counter.schemaVersion < 2) counter.schemaVersion = 2;

  const latestDraw = Array.isArray(historicalDraws) && historicalDraws.length > 0
    ? historicalDraws[0]
    : null;
  const latestDrawId = latestDraw && latestDraw.drawId != null
    ? String(latestDraw.drawId)
    : null;

  // Step 1: walk unprocessed draws in chronological order, advance watch
  const unprocessed = getUnprocessedDraws(historicalDraws, counter.lastProcessedDrawId);
  for (const draw of unprocessed) {
    advanceWatch(counter, draw);
  }

  // Step 2: mark latest draw processed
  if (latestDrawId != null) {
    counter.lastProcessedDrawId = latestDrawId;
  }

  // Step 3: determine if the prediction gate is open
  const nep = fourBallColorNextEvent && fourBallColorNextEvent.nextEventPrediction;
  const predActive = Boolean(nep && nep.active);

  // Also honour legacy drawsUntilNextEvent === 0 as a fallback if
  // nextEventPrediction isn't available (backward compat with old engine snapshots)
  const overdueOpen = Boolean(fourBallColorNextEvent && fourBallColorNextEvent.drawsUntilNextEvent === 0);

  let callType = null;
  if (predActive) {
    callType = nep.isOverdue
      ? `OVERDUE (+${nep.overdueByDraws})`
      : `DUE_IN_${nep.drawsRemaining}`;
  } else if (overdueOpen) {
    callType = 'OVERDUE';
  }

  if (callType && !counter.eventCall.pending) {
    // Open a fresh watch
    counter.eventCall.pending = {
      callType,
      openedAfterDrawId: latestDraw ? latestDraw.drawId : null,
      drawsElapsed: 0
    };
    counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.eventCall.hits + counter.eventCall.misses;
  const hitRatePct = resolved > 0
    ? Math.round((counter.eventCall.hits / resolved) * 1000) / 10
    : null;

  const reasoningText = counter.totalCalls === 0
    ? 'No 4-ball event prediction has fired yet — counter has nothing to report.'
    : `${counter.totalCalls} prediction(s) logged. ${counter.eventCall.hits} HIT / ${counter.eventCall.misses} MISS${hitRatePct != null ? ` (${hitRatePct}% hit rate)` : ''}.${counter.eventCall.pending ? ` Watch open after draw #${counter.eventCall.pending.openedAfterDrawId} (${counter.eventCall.pending.drawsElapsed}/${WINDOW_DRAWS} draws elapsed).` : ''}`;

  return {
    engine: 'FourBallColorNextEventHitCounter',
    schemaVersion: 2,
    windowDraws: WINDOW_DRAWS,
    totalCalls: counter.totalCalls,
    eventCall: {
      callType: counter.eventCall.pending ? counter.eventCall.pending.callType : null,
      hits: counter.eventCall.hits,
      misses: counter.eventCall.misses,
      hitRatePct,
      pending: Boolean(counter.eventCall.pending),
      drawsElapsed: counter.eventCall.pending ? counter.eventCall.pending.drawsElapsed : 0,
      openedAfterDrawId: counter.eventCall.pending ? counter.eventCall.pending.openedAfterDrawId : null
    },
    predictions: counter.predictions,
    reasoning: reasoningText
  };
}

module.exports = {
  WINDOW_DRAWS,
  MAX_LOG_SIZE,
  evaluateFourBallColorNextEventHitCounter
};
