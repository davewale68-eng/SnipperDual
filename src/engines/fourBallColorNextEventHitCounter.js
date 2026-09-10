/**
 * ============================================================
 *  4-BALL COLOR NEXT EVENT HIT COUNTER
 * ============================================================
 *
 * Scoring log for fourBallColorNextEventEngine.js's predictedNextColor
 * (the "which color is overdue to play 4-ball next" call) -- direct
 * structural clone of threeBallNextEventHitCounter.js / 
 * threeBallColorHitCounter.js, re-keyed to the 4-ball color next-event
 * forecast instead of a 3-ball one.
 *
 * WHY THIS EXISTS: fourBallColorNextEventEngine.js previously had no
 * hit-counter performance log of its own -- there was no way to see,
 * over time, whether predictedNextColor was actually landing more
 * often than chance. This gives it one, same evaluation discipline as
 * every other next-event/color-forecast engine in this codebase.
 *
 * MECHANICS (continuous, no gate -- same reasoning as
 * threeBallNextEventHitCounter.js's header: the engine has a
 * predictedNextColor every single cycle once it has any sample at all,
 * so this counter is never idle waiting on a gate):
 *   - Every cycle, if no watch is currently pending, open a fresh watch
 *     on fourBallColorNextEvent.predictedNextColor.
 *   - HIT as soon as a landed draw's fourBallColor matches the watched
 *     color -- this engine's own event definition IS "reached 4-ball",
 *     so unlike threeBallColorHitCounter.js's isColorHit() (which
 *     accepts either a 3-ball or 4-ball match), a hit here is a direct,
 *     single-field comparison against draw.fourBallColor.
 *   - MISS (expired) if MAX_RESOLUTION_DRAWS draws pass with no match.
 *   - While a watch is open, later cycles do not re-open a new one even
 *     if predictedNextColor changes mid-watch -- same single-slot-per-
 *     pick discipline as every other *HitCounter.js in this codebase.
 *
 * FIX -- RESOLUTION BENCHMARK: same 1-7 draw resolution window,
 * predictions log (one entry per opened-then-resolved call), and
 * chance baseline as threeBallNextEventHitCounter.js/
 * threeBallColorHitCounter.js -- see those files' headers for the full
 * reasoning.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): a draw
 * record only stores its own fourBallColor outcome, not "what did the
 * 4-Ball Color Next Event Engine predict N draws ago." That calling
 * context only exists transiently in the live council cycle, so it
 * must be logged as it happens (via
 * store.fourBallColorNextEventHitCounter) and resolved against draws
 * as they arrive.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational scoring log.
 * Never votes, never feeds back into fourBallColorNextEventEngine or
 * any gate/weight -- same discipline as every other *HitCounter.js in
 * this codebase.
 */
'use strict';

// FIX -- same numeric range and reasoning as
// threeBallNextEventHitCounter.js's MIN_RESOLUTION_DRAWS/
// MAX_RESOLUTION_DRAWS: a call is only ever gradeable within 1-7 draws
// of opening; past that it is force-resolved as a MISS instead of
// sitting open indefinitely.
const MIN_RESOLUTION_DRAWS = 1;
const MAX_RESOLUTION_DRAWS = 7;
const MAX_PREDICTION_LOG = 300;

const COLOR_COUNT = 3; // RED/BLUE/GREEN -- see src/core/colorMath.js's HIERARCHY

// See threeBallNextEventHitCounter.js's header "CHANCE BASELINE" for
// the full reasoning -- same closed-form math, same window size.
const BASELINE_HIT_RATE_PCT = Math.round((1 - Math.pow(1 - 1 / COLOR_COUNT, MAX_RESOLUTION_DRAWS)) * 1000) / 10;

function freshPickState() {
  return { hits: 0, misses: 0, pending: null, predictions: [] };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit (latestDraw.fourBallColor === pick.pending.color),
 * increments drawsElapsed, and -- once the call is actually decided
 * (HIT, or MAX_RESOLUTION_DRAWS elapsed with no match) -- resolves it:
 * updates the hits/misses tally AND appends a RESOLVED entry to the
 * predictions log. No-op if nothing is pending, or if the call is
 * still genuinely undecided.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;
  if (!Array.isArray(pick.predictions)) pick.predictions = [];

  pick.pending.drawsElapsed++;

  const actualColor = latestDraw.fourBallColor || null;
  const isHit = actualColor != null && actualColor === pick.pending.color;
  const expired = !isHit && pick.pending.drawsElapsed >= MAX_RESOLUTION_DRAWS;

  if (!isHit && !expired) return; // still genuinely pending

  const resolvedEntry = {
    status: 'RESOLVED',
    openedDrawId: pick.pending.openedAfterDrawId,
    color: pick.pending.color,
    resolvedDrawId: latestDraw.drawId,
    drawsSinceOpen: pick.pending.drawsElapsed,
    result: isHit ? 'HIT' : 'MISS',
    accurate: isHit,
    expired,
    resolvedAt: new Date().toISOString()
  };

  if (isHit) pick.hits++; else pick.misses++;
  pick.predictions = [resolvedEntry, ...pick.predictions].slice(0, MAX_PREDICTION_LOG);
  pick.pending = null;
}

/**
 * Opens a new watch for the given pick slot if none is currently open.
 * No-op if a watch is already pending (continuation of the one already
 * being tracked) or if there's no color to watch.
 */
function openWatchIfIdle(pick, color, openedAfterDrawId) {
  if (pick.pending || !color) return false;
  pick.pending = { color, openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle immediately after
 * fourBallColorNextEventEngine.js (analyzeFourBallColorNextEvent) has
 * run. Order matters: resolve any existing pending watch against the
 * latest landed draw FIRST (dedup'd per draw via lastProcessedDrawId),
 * then open a fresh watch for this cycle's predictedNextColor -- so a
 * brand-new watch is never immediately graded against the very draw
 * that created it.
 *
 * fourBallColorNextEvent is the full analyzeFourBallColorNextEvent()
 * result: predictedNextColor supplies the color being watched,
 * unconditionally (no gate) every cycle the engine has a dueColor at
 * all -- same "measurable from day one" discipline as
 * threeBallNextEventHitCounter.js.
 */
function evaluateFourBallColorNextEventHitCounter(historicalDraws, fourBallColorNextEvent, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.predictedColorPick) counter.predictedColorPick = freshPickState();
  if (!Array.isArray(counter.predictedColorPick.predictions)) counter.predictedColorPick.predictions = [];
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.predictedColorPick, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const predictedColor = fourBallColorNextEvent && fourBallColorNextEvent.available
    ? fourBallColorNextEvent.predictedNextColor
    : null;

  if (predictedColor) {
    const opened = openWatchIfIdle(counter.predictedColorPick, predictedColor, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.predictedColorPick.hits + counter.predictedColorPick.misses;
  const hitRatePct = resolved > 0 ? Math.round((counter.predictedColorPick.hits / resolved) * 1000) / 10 : null;

  const predictions = counter.predictedColorPick.predictions;
  const hitLatencies = predictions.filter(p => p.result === 'HIT').map(p => p.drawsSinceOpen);
  const avgDrawsToHit = hitLatencies.length > 0
    ? Math.round((hitLatencies.reduce((s, v) => s + v, 0) / hitLatencies.length) * 10) / 10
    : null;

  return {
    engine: 'FourBallColorNextEventHitCounter',
    resolutionWindow: [MIN_RESOLUTION_DRAWS, MAX_RESOLUTION_DRAWS],
    totalCalls: counter.totalCalls,
    // Chance baseline for interpreting hitRatePct against -- see header
    // "CHANCE BASELINE" (threeBallNextEventHitCounter.js's, reused here
    // verbatim) above.
    baselineHitRatePct: BASELINE_HIT_RATE_PCT,
    predictedColorPick: {
      color: counter.predictedColorPick.pending ? counter.predictedColorPick.pending.color : null,
      hits: counter.predictedColorPick.hits,
      misses: counter.predictedColorPick.misses,
      hitRatePct,
      avgDrawsToHit,
      pending: Boolean(counter.predictedColorPick.pending),
      drawsElapsed: counter.predictedColorPick.pending ? counter.predictedColorPick.pending.drawsElapsed : 0
    },
    // The per-call log itself: each entry is one opened-then-resolved
    // (HIT or expired/MISS) call, newest first.
    predictions: predictions.slice(0, 100),
    reasoning: counter.totalCalls === 0
      ? 'No 4-Ball Color Next Event call has been logged yet -- counter has nothing to report.'
      : `${counter.totalCalls} predicted-color call(s) so far. ${counter.predictedColorPick.hits} hit / ${counter.predictedColorPick.misses} missed` +
        (hitRatePct != null ? ` (${hitRatePct}% vs. ~${BASELINE_HIT_RATE_PCT}% expected by chance alone in a ${MAX_RESOLUTION_DRAWS}-draw window).` : '.')
  };
}

module.exports = {
  MIN_RESOLUTION_DRAWS,
  MAX_RESOLUTION_DRAWS,
  COLOR_COUNT,
  BASELINE_HIT_RATE_PCT,
  resolvePendingWatch,
  openWatchIfIdle,
  evaluateFourBallColorNextEventHitCounter
};
