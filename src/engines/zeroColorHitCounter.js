/**
 * Zero Color Event Hit Counter — v2 (Event-Level Prediction Rewire).
 *
 * WHAT CHANGED FROM v1
 * --------------------
 * v1 watched two narrow gates: OVERDUE (drawsUntilNextZero === 0) and
 * WATCH CLOSELY (operatorAction === 'WATCH CLOSELY'). Both fired only
 * when the engine had ALREADY passed its avg interval — so by the time
 * a watch opened, the event was already late. That caused two problems:
 *
 *   1. MISS under-counting: the single-slot "pending" design closed only
 *      via an explicit hit or after WINDOW_DRAWS cycles. If draws arrived
 *      faster than council cycled (or council skipped a cycle), drawsElapsed
 *      was incremented only once per council run — so a MISS could take far
 *      longer than WINDOW_DRAWS actual draws to register, and in practice
 *      often never did before the next OVERDUE gate re-opened and "continued"
 *      the same slot, suppressing the miss entirely.
 *
 *   2. HIT bias: a hit landed while a watch was pending closed the slot
 *      immediately (correctly). But if the next cycle re-opened OVERDUE
 *      again, it opened a brand-new slot immediately — inflating hit count
 *      relative to the true miss count.
 *
 * v2 FIXES
 * --------
 * a) NEW GATE: the watch now opens when zeroColorIntel.nextEventPrediction
 *    .active is true — i.e. the engine says "a zero event is due within
 *    the next ALERT_WITHIN (4) draws." This fires earlier and tracks the
 *    full prediction window, not just the overdue tail.
 *
 * b) DRAW-ACCURATE MISS LOGGING: instead of relying on a single drawsElapsed
 *    counter incremented once per council cycle, each pending watch stores
 *    the drawId it opened after. On every cycle, ALL draws in historicalDraws
 *    that are newer than lastProcessedDrawId are walked in order (oldest to
 *    newest). For each draw, the pending watch is checked:
 *      - If that draw is a zero event → HIT, close watch.
 *      - If draws walked since watch opened >= WINDOW_DRAWS → MISS, close.
 *    This ensures every draw is accounted for regardless of how many draws
 *    arrived between council cycles.
 *
 * c) PREDICTIONS LOG: a rolling log of the last MAX_LOG_SIZE predictions
 *    (same pattern as fourBallColorNextEventHitCounter.js) is maintained
 *    so the UI can show recent HIT/MISS/PENDING history with draw IDs.
 *
 * MECHANICS
 * ---------
 * - One watch slot open at a time (single-slot discipline, same as v1).
 * - A fresh nextEventPrediction.active=true while a watch is already
 *   pending is treated as a continuation — does NOT open a second slot.
 * - HIT  : a zero event lands within WINDOW_DRAWS draws of the watch open.
 * - MISS : WINDOW_DRAWS draws pass with no zero event.
 * - The watch tracks openedAfterDrawIndex (index in historicalDraws at
 *   open time, used to count draws elapsed accurately).
 *
 * ABSOLUTE SEPARATION RULE (unchanged from v1): pure, read-only,
 * observational scoring log. Never votes, never feeds back into
 * zeroColorEngine or any gate/weight.
 */
const { isZeroEvent } = require('./zeroColorEngine');

const WINDOW_DRAWS = 8;   // draws given for a HIT before watch is MISS
const MAX_LOG_SIZE = 20;  // keep last N resolved predictions in the log

function freshCounter() {
  return {
    schemaVersion: 2,
    lastProcessedDrawId: null,
    totalCalls: 0,
    zeroCall: { hits: 0, misses: 0, pending: null },
    predictions: [],   // newest-first resolved log
    updatedAt: null
  };
}

/**
 * Walk every draw in historicalDraws (newest-first) that is newer than
 * lastProcessedDrawId and return them oldest-first (so we can advance
 * the watch in chronological order). historicalDraws is newest-first
 * per the codebase convention.
 */
function getUnprocessedDraws(historicalDraws, lastProcessedDrawId) {
  if (!Array.isArray(historicalDraws) || historicalDraws.length === 0) return [];
  const unprocessed = [];
  for (const draw of historicalDraws) {
    if (draw == null || draw.drawId == null) continue;
    if (String(draw.drawId) === String(lastProcessedDrawId)) break;
    unprocessed.push(draw);
  }
  // unprocessed is newest-first; reverse to oldest-first for chronological walk
  return unprocessed.reverse();
}

/**
 * Advance the pending watch against a single draw (chronological order).
 * Mutates counter in place. Returns 'hit', 'miss', or 'pending'.
 */
function advanceWatch(counter, draw) {
  const pending = counter.zeroCall.pending;
  if (!pending) return 'none';

  pending.drawsElapsed++;

  if (isZeroEvent(draw)) {
    // HIT
    counter.zeroCall.hits++;
    const logEntry = {
      result: 'HIT',
      openedAfterDrawId: pending.openedAfterDrawId,
      resolvedOnDrawId: draw.drawId,
      drawsElapsed: pending.drawsElapsed,
      callType: pending.callType,
      timestamp: new Date().toISOString()
    };
    counter.predictions.unshift(logEntry);
    if (counter.predictions.length > MAX_LOG_SIZE) counter.predictions.length = MAX_LOG_SIZE;
    counter.zeroCall.pending = null;
    return 'hit';
  }

  if (pending.drawsElapsed >= WINDOW_DRAWS) {
    // MISS
    counter.zeroCall.misses++;
    const logEntry = {
      result: 'MISS',
      openedAfterDrawId: pending.openedAfterDrawId,
      resolvedOnDrawId: draw.drawId,
      drawsElapsed: pending.drawsElapsed,
      callType: pending.callType,
      timestamp: new Date().toISOString()
    };
    counter.predictions.unshift(logEntry);
    if (counter.predictions.length > MAX_LOG_SIZE) counter.predictions.length = MAX_LOG_SIZE;
    counter.zeroCall.pending = null;
    return 'miss';
  }

  return 'pending';
}

/**
 * Main entry point. Called once per council cycle after zeroColorIntel
 * (analyzeZeroColor) has run.
 *
 * Order of operations:
 *   1. Walk all unprocessed draws chronologically, advancing the pending
 *      watch against each one (draw-accurate miss detection).
 *   2. Mark the latest draw as processed.
 *   3. If nextEventPrediction.active and no watch is pending, open a new
 *      watch (new totalCalls entry).
 */
function evaluateZeroColorHitCounter(historicalDraws, zeroColorIntel, persistentCounter) {
  // Migrate or initialise counter
  const counter = (persistentCounter && typeof persistentCounter === 'object')
    ? persistentCounter
    : freshCounter();

  if (!counter.zeroCall) counter.zeroCall = { hits: 0, misses: 0, pending: null };
  if (!Array.isArray(counter.predictions)) counter.predictions = [];
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;
  // v1 → v2 migration: ensure schemaVersion is set
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

  // Step 3: determine if the new prediction gate is open
  const nep = zeroColorIntel && zeroColorIntel.nextEventPrediction;
  const predActive = Boolean(nep && nep.active);

  // Also honour the legacy OVERDUE gate as a fallback if nextEventPrediction
  // isn't available (backward compat with old zeroColorEngine snapshots)
  const overdueOpen = Boolean(zeroColorIntel && zeroColorIntel.drawsUntilNextZero === 0);
  const watchOpen = Boolean(zeroColorIntel && zeroColorIntel.operatorAction === 'WATCH CLOSELY');

  let callType = null;
  if (predActive) {
    callType = nep.isOverdue
      ? `OVERDUE (+${nep.overdueByDraws})`
      : `DUE_IN_${nep.drawsRemaining}`;
  } else if (overdueOpen || watchOpen) {
    // legacy path
    const parts = [];
    if (overdueOpen) parts.push('OVERDUE');
    if (watchOpen) parts.push('WATCHCLOSELY');
    callType = parts.join('+');
  }

  if (callType && !counter.zeroCall.pending) {
    // Open a fresh watch
    counter.zeroCall.pending = {
      callType,
      openedAfterDrawId: latestDraw ? latestDraw.drawId : null,
      drawsElapsed: 0
    };
    counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.zeroCall.hits + counter.zeroCall.misses;
  const hitRatePct = resolved > 0
    ? Math.round((counter.zeroCall.hits / resolved) * 1000) / 10
    : null;

  const reasoningText = counter.totalCalls === 0
    ? 'No zero event prediction has fired yet — counter has nothing to report.'
    : `${counter.totalCalls} prediction(s) logged. ${counter.zeroCall.hits} HIT / ${counter.zeroCall.misses} MISS${hitRatePct != null ? ` (${hitRatePct}% hit rate)` : ''}.${counter.zeroCall.pending ? ` Watch open after draw #${counter.zeroCall.pending.openedAfterDrawId} (${counter.zeroCall.pending.drawsElapsed}/${WINDOW_DRAWS} draws elapsed).` : ''}`;

  return {
    engine: 'ZeroColorHitCounter',
    schemaVersion: 2,
    windowDraws: WINDOW_DRAWS,
    totalCalls: counter.totalCalls,
    zeroCall: {
      callType: counter.zeroCall.pending ? counter.zeroCall.pending.callType : null,
      hits: counter.zeroCall.hits,
      misses: counter.zeroCall.misses,
      hitRatePct,
      pending: Boolean(counter.zeroCall.pending),
      drawsElapsed: counter.zeroCall.pending ? counter.zeroCall.pending.drawsElapsed : 0,
      openedAfterDrawId: counter.zeroCall.pending ? counter.zeroCall.pending.openedAfterDrawId : null
    },
    predictions: counter.predictions,
    reasoning: reasoningText
  };
}

module.exports = {
  WINDOW_DRAWS,
  MAX_LOG_SIZE,
  evaluateZeroColorHitCounter
};
