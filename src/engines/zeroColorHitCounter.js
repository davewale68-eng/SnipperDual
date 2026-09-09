/**
 * Zero Color Engine Overdue/Watch Hit Counter.
 *
 * Direct structural port of tierOverduePrecursorHitCounter.js (the Tier/
 * Tie Engine's own OVERDUE/PRECURSOR call-scoring log) to the Zero Color
 * Engine (zeroColorEngine.js). Before this, the Zero Color Engine's own
 * calls -- flagging a zero event as OVERDUE (drawsUntilNextZero === 0) or
 * flagging elevated live pressure worth watching (operatorAction ===
 * 'WATCH CLOSELY', i.e. zeroPressureScore >= 70) -- were never scored
 * against what actually happened. Both fire every cycle their own gate is
 * open, but nothing logged "on draw #X the Zero Color Engine called
 * OVERDUE/WATCH CLOSELY," and nothing later checked whether a zero event
 * actually landed. This closes that gap exactly the way
 * tierOverduePrecursorHitCounter.js closes it for the Tier Engine.
 *
 * ONE KEY STRUCTURAL DIFFERENCE FROM tierOverduePrecursorHitCounter.js:
 * the Tier Engine's two gates are OVERDUE (tieP.drawsUntilNextTie === 0)
 * and PRECURSOR (a genuinely separate companion engine,
 * tiePrecursorPatternEngine.js's unifiedSignal.active). The Zero Color
 * Engine has no separate precursor engine of its own, so the second gate
 * here is WATCH CLOSELY -- zeroColorEngine.js's own
 * operatorAction === 'WATCH CLOSELY' read (zeroPressureScore >= 70),
 * computed entirely inside analyzeZeroColor() itself. Both gates are
 * still just two readings of the same underlying claim ("expect a zero
 * event soon"), so they are combined into the same single-slot watch,
 * not two independent ones, for the same reason tierOverduePrecursorHitCounter.js
 * combines OVERDUE and PRECURSOR: firing both in the same cycle should
 * not double-count or open two overlapping watches for what is, from the
 * market's perspective, a single outstanding claim. When both fire in the
 * same cycle, the call is logged as a combined 'OVERDUE+WATCHCLOSELY' call.
 *
 * MECHANICS (identical to tierOverduePrecursorHitCounter.js otherwise)
 * -------------------------------------------------------
 * Every cycle where the OVERDUE gate (zeroColorIntel.drawsUntilNextZero
 * === 0) and/or the WATCH gate (zeroColorIntel.operatorAction ===
 * 'WATCH CLOSELY') is open, this counts as one "Zero call" (counted once
 * per fresh call -- while a call is already being watched, further
 * cycles with a gate still open are NOT re-counted, so a multi-draw
 * OVERDUE streak doesn't inflate totalCalls once per cycle).
 *
 * For each call, the next draws are watched for up to WINDOW_DRAWS
 * draws:
 *   - HIT  as soon as a draw lands a zero event (isZeroEvent).
 *   - MISS if WINDOW_DRAWS draws pass with no zero event.
 * Only one watch is ever open at a time -- a fresh call while a watch is
 * still pending is treated as a continuation, not a new call, same rule
 * as tierOverduePrecursorHitCounter.js's single-slot-per-pick behavior.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): same
 * reasoning as tierOverduePrecursorHitCounter.js's own header -- a draw
 * record only stores its own zero-event outcome, not "was the Zero Color
 * Engine calling OVERDUE/WATCH CLOSELY on some earlier draw." That
 * calling context only exists transiently in the live council cycle, so
 * it must be logged as it happens (via store.zeroColorHitCounter) and
 * resolved against draws as they arrive.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational scoring log.
 * Never votes, never feeds back into zeroColorEngine or any gate/weight
 * -- same discipline as every other *HitCounter.js in this codebase.
 */
const { isZeroEvent } = require('./zeroColorEngine');

const WINDOW_DRAWS = 8; // draws given for a HIT before a pending watch is marked a MISS -- matches the Tier Engine's own 8-draw window, per that engine's precedent

function freshPickState() {
  return { hits: 0, misses: 0, pending: null };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit, increments drawsElapsed, and closes the watch out
 * (HIT or MISS) as appropriate. No-op if nothing is pending. Identical
 * to tierOverduePrecursorHitCounter.js's resolvePendingWatch, checking
 * for a landed zero event instead of a landed 3-ball tie.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;

  pick.pending.drawsElapsed++;

  if (isZeroEvent(latestDraw)) {
    pick.hits++;
    pick.pending = null;
    return;
  }

  if (pick.pending.drawsElapsed >= WINDOW_DRAWS) {
    pick.misses++;
    pick.pending = null;
  }
}

/**
 * Opens a new watch for the given pick slot if none is currently open.
 * No-op if a watch is already pending (that call is treated as a
 * continuation of the one already being tracked).
 */
function openWatchIfIdle(pick, callType, openedAfterDrawId) {
  if (pick.pending || !callType) return false;
  pick.pending = { callType, openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle after zeroColorIntel
 * (analyzeZeroColor) has run. Order matters: resolve any existing
 * pending watch against the latest landed draw FIRST (dedup'd per draw
 * via lastProcessedDrawId), then open a fresh watch for this cycle's
 * call -- so a brand-new watch is never immediately graded against the
 * very draw that created it.
 *
 * zeroColorIntel is the full analyzeZeroColor() result:
 * drawsUntilNextZero === 0 is the OVERDUE gate. operatorAction ===
 * 'WATCH CLOSELY' is the WATCH gate.
 */
function evaluateZeroColorHitCounter(historicalDraws, zeroColorIntel, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.zeroCall) counter.zeroCall = freshPickState();
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.zeroCall, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const overdueOpen = Boolean(zeroColorIntel && zeroColorIntel.drawsUntilNextZero === 0);
  const watchOpen = Boolean(zeroColorIntel && zeroColorIntel.operatorAction === 'WATCH CLOSELY');

  const activeTypes = [];
  if (overdueOpen) activeTypes.push('OVERDUE');
  if (watchOpen) activeTypes.push('WATCHCLOSELY');
  const callType = activeTypes.length > 0 ? activeTypes.join('+') : null;

  if (callType) {
    const opened = openWatchIfIdle(counter.zeroCall, callType, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.zeroCall.hits + counter.zeroCall.misses;

  return {
    engine: 'ZeroColorHitCounter',
    windowDraws: WINDOW_DRAWS,
    totalCalls: counter.totalCalls,
    zeroCall: {
      callType: counter.zeroCall.pending ? counter.zeroCall.pending.callType : null,
      hits: counter.zeroCall.hits,
      misses: counter.zeroCall.misses,
      hitRatePct: resolved > 0 ? Math.round((counter.zeroCall.hits / resolved) * 1000) / 10 : null,
      pending: Boolean(counter.zeroCall.pending),
      drawsElapsed: counter.zeroCall.pending ? counter.zeroCall.pending.drawsElapsed : 0
    },
    reasoning: counter.totalCalls === 0
      ? 'No OVERDUE or WATCH CLOSELY call has fired yet -- counter has nothing to report.'
      : `${counter.totalCalls} Zero call(s) so far (OVERDUE and/or WATCH CLOSELY). ${counter.zeroCall.hits} hit / ${counter.zeroCall.misses} missed.`
  };
}

module.exports = {
  WINDOW_DRAWS,
  resolvePendingWatch,
  openWatchIfIdle,
  evaluateZeroColorHitCounter
};
