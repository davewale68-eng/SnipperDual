/**
 * Tier Engine Overdue/Precursor Hit Counter — v2 (MISS-LOCK + batch-walk fix).
 *
 * WHAT CHANGED FROM v1
 * ---------------------
 * v1 was a direct structural port of threeBallEntryHitCounter.js. Two bugs
 * carried over from that port, both now fixed to match the pattern already
 * applied to fourBallColorNextEventHitCounter.js and zeroColorHitCounter.js:
 *
 *   BUG 1 — MISS-REOPEN (same bug as 4-ball/zero-color v2 -> v3):
 *     Once a watch closed as MISS (WINDOW_DRAWS draws with no tie),
 *     tieP.drawsUntilNextTie stayed 0 indefinitely -- OVERDUE never clears
 *     until a tie actually lands. So the very next cycle saw no pending
 *     watch, callType was still non-null, and immediately opened a brand
 *     new watch. When a tie eventually landed -- possibly OVERDUE+21 draws
 *     later -- it scored that new watch as HIT, even though the original
 *     call had already been correctly logged as MISS. This inflated HIT
 *     counts and suppressed MISS counts exactly like the 4-ball/zero-color
 *     bug did.
 *
 *   BUG 2 — SINGLE-DRAW RESOLUTION (batch-ingest miss):
 *     resolvePendingWatch() only ever checked the single latest draw each
 *     cycle, then jumped lastProcessedDrawId straight to it. This collector
 *     (see ingest-cursor comments in api.js) posts its whole local batch
 *     every cycle, so more than one new draw can land between two council
 *     cycles. Any tie buried in the middle of a batch was silently skipped
 *     -- never scored as a HIT -- and drawsElapsed only advanced once per
 *     cycle instead of once per real draw, so the 8-draw window drifted
 *     out of sync with actual draws. Fixed by walking every unprocessed
 *     draw chronologically (oldest-first), same as
 *     fourBallColorNextEventHitCounter.js's getUnprocessedDraws().
 *
 * v2 FIX — MISS-LOCK:
 *   When a watch closes as MISS the counter records the current value of
 *   tieP.lastTie.drawId (the Tie Engine's own "most recent tie" anchor,
 *   analogous to lastEvent.drawId in the 4-ball/zero-color engines) as
 *   `missLockTieDrawId`. While that value matches tieP's live
 *   lastTie.drawId, no new watch may open -- the overdue cycle for that
 *   call has already been fully scored as MISS. The lock releases only
 *   when tieP.lastTie.drawId changes (a genuinely new tie has landed and
 *   resolved the overdue state). That new tie does NOT log a HIT for the
 *   expired call; it simply unlocks the counter so the next fresh call can
 *   open cleanly.
 *
 * v2 FIX — BATCH WALK:
 *   getUnprocessedDraws() collects every draw newer than
 *   lastProcessedDrawId and resolvePendingWatch() is applied to each one
 *   in chronological order, so a tie buried mid-batch is always caught and
 *   drawsElapsed always tracks real draws, not council cycles.
 *
 * WINDOW_DRAWS = 8, unchanged -- per operator direction, same as
 * threeBallEntryHitCounter.js's window.
 *
 * ONE KEY STRUCTURAL DIFFERENCE FROM threeBallEntryHitCounter.js (unchanged
 * from v1): 3SIL's ENTER call watches a specific CHALLENGER COLOR (a
 * match/no-match check). The Tier Engine's calls have no color to watch --
 * OVERDUE and PRECURSOR are both just "a tie is imminent" calls, so the hit
 * condition is simply "did any of the next WINDOW_DRAWS draws land a
 * 3-ball tie" (isThreeBallTie(draw)). Otherwise this is a single-slot watch
 * exactly like 3SIL's challengerPick -- one call counted at a time, not two
 * independent ones for OVERDUE vs PRECURSOR -- because both calls are the
 * same underlying claim ("expect a tie soon") and firing both in the same
 * cycle should not double-count or open two overlapping watches. When both
 * fire in the same cycle, the call is logged as a combined
 * 'OVERDUE+PRECURSOR' call.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): a draw record
 * only stores its own tie outcome, not "was the Tier Engine calling
 * OVERDUE/PRECURSOR on some earlier draw." That calling context only
 * exists transiently in the live council cycle, so it must be logged as it
 * happens (via store.tierOverduePrecursorHitCounter) and resolved against
 * draws as they arrive.
 */
const { isThreeBallTie } = require('./tieEngine');

const WINDOW_DRAWS = 8; // draws given for a HIT before a pending watch is marked a MISS -- matches 3SIL's own 8-draw window, per operator direction

function freshCounter() {
  return {
    schemaVersion: 2,
    lastProcessedDrawId: null,
    totalCalls: 0,
    tierCall: { hits: 0, misses: 0, pending: null },
    // MISS-LOCK: set to tieP's lastTie.drawId when a watch closes as MISS.
    // Blocks new watches from opening until tieP reports a different
    // lastTie.drawId (a new tie has actually landed).
    missLockTieDrawId: null,
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
 * Advances a pending watch (if any) against one draw (chronological
 * order): checks for a hit, increments drawsElapsed, and closes the watch
 * out (HIT or MISS) as appropriate. No-op if nothing is pending.
 * On MISS, sets the MISS-LOCK to the tieP.lastTie.drawId snapshot taken
 * when the watch was opened, so a new watch cannot reopen until a real tie
 * lands. On HIT, clears any stale lock.
 */
function resolvePendingWatch(counter, draw) {
  const pending = counter.tierCall.pending;
  if (!pending || !draw) return;

  pending.drawsElapsed++;

  if (isThreeBallTie(draw)) {
    counter.tierCall.hits++;
    counter.tierCall.pending = null;
    // A real tie resolved the overdue period -- clear any stale lock so
    // the next call can open immediately.
    counter.missLockTieDrawId = null;
    return;
  }

  if (pending.drawsElapsed >= WINDOW_DRAWS) {
    counter.tierCall.misses++;
    // Lock onto the lastTie.drawId snapshot taken when this watch opened,
    // blocking new watches until tieP reports a genuinely new tie.
    counter.missLockTieDrawId = pending.lastTieDrawIdAtOpen;
    counter.tierCall.pending = null;
  }
}

/**
 * Opens a new watch for the given pick slot if none is currently open.
 * No-op if a watch is already pending (that call is treated as a
 * continuation of the one already being tracked).
 */
function openWatchIfIdle(pick, callType, openedAfterDrawId, lastTieDrawIdAtOpen) {
  if (pick.pending || !callType) return false;
  pick.pending = { callType, openedAfterDrawId, lastTieDrawIdAtOpen, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle after tieP (analyzeTies)
 * and tiePrecursor (evaluateTiePrecursorPatterns) have both run.
 *
 * Order of operations:
 *   1. Walk all unprocessed draws chronologically, resolving the pending
 *      watch against each one in turn (catches every draw in a batch, not
 *      just the latest).
 *   2. Mark the latest draw as processed.
 *   3. Release the miss-lock if tieP now reports a different
 *      lastTie.drawId (a new tie actually landed).
 *   4. Open a new watch only if: a gate is active AND no pending watch
 *      AND the miss-lock is not set.
 *
 * tieP is the full analyzeTies() result: drawsUntilNextTie === 0 is the
 * OVERDUE gate, lastTie.drawId is the miss-lock anchor. tiePrecursor is the
 * full evaluateTiePrecursorPatterns() result: prediction.unifiedSignal.
 * active is the PRECURSOR gate.
 */
function evaluateTierOverduePrecursorHitCounter(historicalDraws, tieP, tiePrecursor, persistentCounter) {
  const counter = (persistentCounter && typeof persistentCounter === 'object')
    ? persistentCounter
    : freshCounter();

  // Schema migration
  if (!counter.tierCall) counter.tierCall = { hits: 0, misses: 0, pending: null };
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;
  if (counter.missLockTieDrawId === undefined) counter.missLockTieDrawId = null;
  if (!counter.schemaVersion || counter.schemaVersion < 2) counter.schemaVersion = 2;

  const latestDraw   = Array.isArray(historicalDraws) && historicalDraws.length > 0
    ? historicalDraws[0] : null;
  const latestDrawId = latestDraw && latestDraw.drawId != null
    ? String(latestDraw.drawId) : null;

  // Step 1: walk unprocessed draws chronologically (catches batch ingests)
  const unprocessed = getUnprocessedDraws(historicalDraws, counter.lastProcessedDrawId);
  for (const draw of unprocessed) {
    resolvePendingWatch(counter, draw);
  }

  // Step 2: mark latest draw processed
  if (latestDrawId != null) counter.lastProcessedDrawId = latestDrawId;

  // tieP's own "most recent tie" anchor -- the anchor for miss-lock logic
  const currentLastTieDrawId =
    tieP && tieP.lastTie && tieP.lastTie.drawId != null
      ? String(tieP.lastTie.drawId)
      : null;

  // Step 3: release miss-lock if a NEW tie has landed
  // (tieP's lastTie.drawId changed since the MISS was recorded)
  if (counter.missLockTieDrawId != null &&
      currentLastTieDrawId != null &&
      currentLastTieDrawId !== String(counter.missLockTieDrawId)) {
    counter.missLockTieDrawId = null;
  }

  // Step 4: gate -- build callType and decide whether to open a watch
  const overdueOpen   = Boolean(tieP && tieP.drawsUntilNextTie === 0);
  const precursorOpen = Boolean(tiePrecursor && tiePrecursor.prediction && tiePrecursor.prediction.unifiedSignal && tiePrecursor.prediction.unifiedSignal.active);

  const activeTypes = [];
  if (overdueOpen) activeTypes.push('OVERDUE');
  if (precursorOpen) activeTypes.push('PRECURSOR');
  const callType = activeTypes.length > 0 ? activeTypes.join('+') : null;

  const missLocked = counter.missLockTieDrawId != null;

  if (callType && !counter.tierCall.pending && !missLocked) {
    const opened = openWatchIfIdle(
      counter.tierCall,
      callType,
      latestDraw ? latestDraw.drawId : null,
      currentLastTieDrawId
    );
    if (opened) counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.tierCall.hits + counter.tierCall.misses;

  return {
    engine: 'TierOverduePrecursorHitCounter',
    schemaVersion: 2,
    windowDraws: WINDOW_DRAWS,
    totalCalls: counter.totalCalls,
    missLocked,
    tierCall: {
      callType: counter.tierCall.pending ? counter.tierCall.pending.callType : null,
      hits: counter.tierCall.hits,
      misses: counter.tierCall.misses,
      hitRatePct: resolved > 0 ? Math.round((counter.tierCall.hits / resolved) * 1000) / 10 : null,
      pending: Boolean(counter.tierCall.pending),
      drawsElapsed: counter.tierCall.pending ? counter.tierCall.pending.drawsElapsed : 0
    },
    reasoning: counter.totalCalls === 0
      ? 'No OVERDUE or PRECURSOR call has fired yet -- counter has nothing to report.'
      : `${counter.totalCalls} Tier call(s) so far (OVERDUE and/or PRECURSOR). ${counter.tierCall.hits} hit / ${counter.tierCall.misses} missed.`
      + (missLocked
          ? ' MISS-LOCK active -- overdue period already scored; next watch opens after a new tie lands.'
          : '')
  };
}

module.exports = {
  WINDOW_DRAWS,
  resolvePendingWatch,
  openWatchIfIdle,
  evaluateTierOverduePrecursorHitCounter
};
