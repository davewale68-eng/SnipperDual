/**
 * Zero Color Event Hit Counter — v3 (MISS-LOCK fix).
 *
 * WHAT CHANGED FROM v2
 * --------------------
 * v2 fixed draw-accurate miss detection and gated the watch on
 * nextEventPrediction.active. One bug remained:
 *
 *   MISS-REOPEN BUG: once a watch closed as MISS (WINDOW_DRAWS draws
 *   with no zero event), nextEventPrediction.active stayed true
 *   indefinitely — isOverdue never clears until the event actually lands.
 *   So on the very next council cycle, Step 3 saw no pending watch,
 *   callType was non-null, and immediately opened a brand-new watch.
 *   When the event eventually landed — possibly OVERDUE+21 draws later —
 *   it scored that new watch as HIT, even though the original prediction
 *   had already been correctly logged as MISS. This inflated HIT counts
 *   and suppressed MISS counts.
 *
 * v3 FIX — MISS-LOCK:
 *   When a watch closes as MISS the counter records the engine's current
 *   lastZeroEvent.drawId as `missLockEventDrawId`. While that value
 *   matches the engine's live lastZeroEvent.drawId, no new watch may
 *   open — the overdue cycle for that prediction has already been fully
 *   scored as MISS. The lock releases only when the engine's
 *   lastZeroEvent.drawId changes (a genuinely new zero event has landed).
 *   That new event does NOT log a HIT for the expired prediction; it
 *   simply unlocks the counter so the next fresh prediction cycle can
 *   begin cleanly.
 *
 *   Concretely: if a zero event arrives at OVERDUE+21, the MISS already
 *   logged at OVERDUE+4 is the correct and final score for that cycle.
 *   The landing at +21 only resets the engine's lastZeroEvent.drawId,
 *   which releases the lock and allows the next DUE_IN countdown to open
 *   a new watch.
 *
 * WINDOW_DRAWS = 8 encodes the full valid scoring window:
 *   ALERT_WITHIN (4 draws pre-overdue) + OVERDUE_CAP (4 draws) = 8 total.
 *   Any event landing after draw 8 of a given watch is a MISS, period.
 *
 * All other mechanics (single-slot, draw-accurate walk, DUE_IN_N /
 * OVERDUE (+N) callType labels) are unchanged from v2.
 *
 * ABSOLUTE SEPARATION RULE (unchanged): pure, read-only, observational.
 * Never votes, never feeds back into zeroColorEngine or any gate/weight.
 */
const { isZeroEvent } = require('./zeroColorEngine');

// WINDOW_DRAWS = ALERT_WITHIN (4) + OVERDUE cap (4) = 8 draws total.
// Any event landing after this many draws from watch-open is a MISS.
const WINDOW_DRAWS = 8;
const MAX_LOG_SIZE = 20;

function freshCounter() {
  return {
    schemaVersion: 3,
    lastProcessedDrawId: null,
    totalCalls: 0,
    zeroCall: { hits: 0, misses: 0, pending: null },
    // MISS-LOCK: set to the engine's lastZeroEvent.drawId when a watch
    // closes as MISS. Blocks new watches from opening until the engine
    // reports a different lastZeroEvent.drawId (a new zero event landed).
    missLockEventDrawId: null,
    predictions: [],
    updatedAt: null
  };
}

function getUnprocessedDraws(historicalDraws, lastProcessedDrawId) {
  if (!Array.isArray(historicalDraws) || historicalDraws.length === 0) return [];
  const unprocessed = [];
  for (const draw of historicalDraws) {
    if (draw == null || draw.drawId == null) continue;
    if (String(draw.drawId) === String(lastProcessedDrawId)) break;
    unprocessed.push(draw);
  }
  return unprocessed.reverse(); // oldest-first for chronological walk
}

/**
 * Advance the pending watch against one draw (chronological order).
 * Mutates counter in place. Returns 'hit', 'miss', or 'pending'.
 */
function advanceWatch(counter, draw) {
  const pending = counter.zeroCall.pending;
  if (!pending) return 'none';

  pending.drawsElapsed++;

  if (isZeroEvent(draw)) {
    // HIT — event landed within the WINDOW_DRAWS scoring window
    counter.zeroCall.hits++;
    counter.predictions.unshift({
      result: 'HIT',
      openedAfterDrawId: pending.openedAfterDrawId,
      resolvedOnDrawId:  draw.drawId,
      drawsElapsed:      pending.drawsElapsed,
      callType:          pending.callType,
      timestamp:         new Date().toISOString()
    });
    if (counter.predictions.length > MAX_LOG_SIZE) counter.predictions.length = MAX_LOG_SIZE;
    counter.zeroCall.pending   = null;
    // A real event resolved the overdue period — clear any stale lock so
    // the next prediction cycle can begin immediately.
    counter.missLockEventDrawId = null;
    return 'hit';
  }

  if (pending.drawsElapsed >= WINDOW_DRAWS) {
    // MISS — WINDOW_DRAWS draws passed with no zero event.
    // Set the MISS-LOCK so no new watch opens while this same overdue
    // period is still in progress (engine's lastZeroEvent.drawId unchanged).
    counter.zeroCall.misses++;
    counter.predictions.unshift({
      result:            'MISS',
      openedAfterDrawId: pending.openedAfterDrawId,
      resolvedOnDrawId:  draw.drawId,
      drawsElapsed:      pending.drawsElapsed,
      callType:          pending.callType,
      timestamp:         new Date().toISOString()
    });
    if (counter.predictions.length > MAX_LOG_SIZE) counter.predictions.length = MAX_LOG_SIZE;
    // Lock onto the last-zero-event drawId that was current when this
    // watch opened. The lock uses the snapshot stored in pending.
    counter.missLockEventDrawId = pending.lastEventDrawIdAtOpen;
    counter.zeroCall.pending    = null;
    return 'miss';
  }

  return 'pending';
}

/**
 * Main entry point. Called once per council cycle after zeroColorIntel
 * (analyzeZeroColor) has run.
 *
 * Order of operations:
 *   1. Walk all unprocessed draws chronologically, advancing the watch.
 *   2. Mark the latest draw as processed.
 *   3. Release miss-lock if the engine now reports a different
 *      lastZeroEvent.drawId (a new zero event actually landed).
 *   4. Open a new watch only if: gate is active AND no pending watch
 *      AND miss-lock is not set.
 */
function evaluateZeroColorHitCounter(historicalDraws, zeroColorIntel, persistentCounter) {
  const counter = (persistentCounter && typeof persistentCounter === 'object')
    ? persistentCounter
    : freshCounter();

  // Schema migration
  if (!counter.zeroCall)  counter.zeroCall  = { hits: 0, misses: 0, pending: null };
  if (!Array.isArray(counter.predictions)) counter.predictions = [];
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;
  if (counter.missLockEventDrawId === undefined) counter.missLockEventDrawId = null;
  if (!counter.schemaVersion || counter.schemaVersion < 3) counter.schemaVersion = 3;

  const latestDraw   = Array.isArray(historicalDraws) && historicalDraws.length > 0
    ? historicalDraws[0] : null;
  const latestDrawId = latestDraw && latestDraw.drawId != null
    ? String(latestDraw.drawId) : null;

  // Step 1: walk unprocessed draws chronologically
  const unprocessed = getUnprocessedDraws(historicalDraws, counter.lastProcessedDrawId);
  for (const draw of unprocessed) {
    advanceWatch(counter, draw);
  }

  // Step 2: mark latest draw processed
  if (latestDrawId != null) counter.lastProcessedDrawId = latestDrawId;

  // Current engine's last-zero-event drawId (the anchor for miss-lock logic)
  const currentLastEventDrawId =
    zeroColorIntel && zeroColorIntel.lastZeroEvent && zeroColorIntel.lastZeroEvent.drawId != null
      ? String(zeroColorIntel.lastZeroEvent.drawId)
      : null;

  // Step 3: release miss-lock if a NEW zero event has landed
  // (engine's lastZeroEvent.drawId changed since the MISS was recorded)
  if (counter.missLockEventDrawId != null &&
      currentLastEventDrawId != null &&
      currentLastEventDrawId !== String(counter.missLockEventDrawId)) {
    counter.missLockEventDrawId = null;
  }

  // Step 4: gate — build callType and decide whether to open a watch
  const nep       = zeroColorIntel && zeroColorIntel.nextEventPrediction;
  const predActive = Boolean(nep && nep.active);
  const overdueOpen = Boolean(zeroColorIntel && zeroColorIntel.drawsUntilNextZero === 0);
  const watchOpen   = Boolean(zeroColorIntel && zeroColorIntel.operatorAction === 'WATCH CLOSELY');

  let callType = null;
  if (predActive) {
    callType = nep.isOverdue
      ? `OVERDUE (+${nep.overdueByDraws})`
      : `DUE_IN_${nep.drawsRemaining}`;
  } else if (overdueOpen || watchOpen) {
    // Legacy path for old engine snapshots without nextEventPrediction
    const parts = [];
    if (overdueOpen) parts.push('OVERDUE');
    if (watchOpen)   parts.push('WATCHCLOSELY');
    callType = parts.join('+');
  }

  const missLocked = counter.missLockEventDrawId != null;

  if (callType && !counter.zeroCall.pending && !missLocked) {
    // Open a fresh watch, snapshotting the current last-event drawId so
    // advanceWatch() can set the miss-lock to the right value on MISS.
    counter.zeroCall.pending = {
      callType,
      openedAfterDrawId:   latestDraw ? latestDraw.drawId : null,
      lastEventDrawIdAtOpen: currentLastEventDrawId,
      drawsElapsed: 0
    };
    counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved    = counter.zeroCall.hits + counter.zeroCall.misses;
  const hitRatePct  = resolved > 0
    ? Math.round((counter.zeroCall.hits / resolved) * 1000) / 10 : null;

  const reasoningText = counter.totalCalls === 0
    ? 'No zero event prediction has fired yet — counter has nothing to report.'
    : `${counter.totalCalls} prediction(s) logged. `
      + `${counter.zeroCall.hits} HIT / ${counter.zeroCall.misses} MISS`
      + (hitRatePct != null ? ` (${hitRatePct}% hit rate)` : '') + '.'
      + (counter.zeroCall.pending
          ? ` Watch open after draw #${counter.zeroCall.pending.openedAfterDrawId}`
            + ` (${counter.zeroCall.pending.drawsElapsed}/${WINDOW_DRAWS} draws elapsed).`
          : '')
      + (missLocked
          ? ` MISS-LOCK active — overdue period already scored; next watch opens after a new zero event.`
          : '');

  return {
    engine:       'ZeroColorHitCounter',
    schemaVersion: 3,
    windowDraws:  WINDOW_DRAWS,
    totalCalls:   counter.totalCalls,
    missLocked,
    zeroCall: {
      callType:         counter.zeroCall.pending ? counter.zeroCall.pending.callType : null,
      hits:             counter.zeroCall.hits,
      misses:           counter.zeroCall.misses,
      hitRatePct,
      pending:          Boolean(counter.zeroCall.pending),
      drawsElapsed:     counter.zeroCall.pending ? counter.zeroCall.pending.drawsElapsed : 0,
      openedAfterDrawId: counter.zeroCall.pending ? counter.zeroCall.pending.openedAfterDrawId : null
    },
    predictions: counter.predictions,
    reasoning:   reasoningText
  };
}

module.exports = {
  WINDOW_DRAWS,
  MAX_LOG_SIZE,
  evaluateZeroColorHitCounter
};
