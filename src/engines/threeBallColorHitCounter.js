/**
 * ============================================================
 *  3-BALL COLOR HIT COUNTER
 * ============================================================
 *
 * Scoring log for threeBallColorEngine.js's "main" 3-Ball Color Hit
 * Intelligence card -- the ORIGINAL/main 3-ball color forecast
 * (trackedColor, the General Parliament's own generalP.winningColor),
 * NOT the 3SIL Next Event Leaderboard.
 *
 * WHY THIS FILE EXISTS: the project has TWO independently-computed
 * 3-ball color forecasts running every cycle, and they do not always
 * agree -- one can say GREEN while the other says RED on the same
 * cycle --
 *   1. 3SIL's Next Event Leaderboard (threeBallSeasonIntelligenceLab.js
 *      badge.topColor) -- scored continuously by
 *      threeBallNextEventHitCounter.js, displayed on the dashboard as
 *      the "🔢 3SIL NEXT EVENT HIT COUNTER" card.
 *   2. threeBallColorEngine.js's own trackedColor forecast (the
 *      original/main 3-Ball Color Hit Intelligence card) -- scored by
 *      THIS file, as a direct structural clone of
 *      threeBallNextEventHitCounter.js.
 * Because the two forecasts can diverge, each needs its OWN
 * independent log -- a shared/blended counter would hide exactly the
 * disagreement an operator most needs visibility into.
 *
 * FIX -- RESOLUTION BENCHMARK (mirrors tieNextEventEngine.js's own
 * "Resolution benchmark" fix exactly): before this fix, a watch could
 * sit open indefinitely -- MISS was only recorded if/when
 * WINDOW_DRAWS elapsed, but there was no log of INDIVIDUAL calls, just
 * a running hits/misses tally, so there was no way to see how any one
 * call actually played out. This version keeps the tally (for
 * backward compatibility) but adds a `predictions` log -- one entry
 * per call, opened and RESOLVED (HIT or expired/MISS) exactly like
 * tieNextEventEngine.js's openForecast/predictions pattern -- so each
 * individual call is inspectable, not just the running total.
 *
 * A call is gradeable as a HIT only between MIN_RESOLUTION_DRAWS and
 * MAX_RESOLUTION_DRAWS (1-7) draws after it opened. If no hit lands
 * within that window it is force-resolved as a MISS (expired) instead
 * of staying open -- same discipline, same numeric range (1-7), as
 * tieNextEventEngine.js's own MIN_RESOLUTION_DRAWS/MAX_RESOLUTION_DRAWS.
 *
 * MECHANICS (continuous, no gate):
 *   - Every cycle, if no watch is currently pending, open a fresh watch
 *     on threeBallColorIntel.trackedColor.
 *   - HIT as soon as a landed draw satisfies isColorHit() -- i.e. the
 *     watched color lands as either the 3-ball or the 4-ball outcome,
 *     the SAME hit rule threeBallColorEngine.js itself uses to grade
 *     its own backward-looking hitRatePct (see that engine's header --
 *     "a hit is the tracked color landing with EITHER exactly 3 balls
 *     ... OR 4 balls"). Reusing that exact rule here means this
 *     counter's hit rate is directly comparable to the engine's own
 *     internal hitRatePct instead of silently measuring something
 *     narrower.
 *   - MISS (expired) if MAX_RESOLUTION_DRAWS draws pass with no match.
 *   - While a watch is open, later cycles do not re-open a new one even
 *     if trackedColor changes mid-watch (e.g. the General Parliament
 *     re-picks) -- same single-slot-per-pick discipline as
 *     threeBallNextEventHitCounter.js / entryHitCounter.js, so
 *     trackedColor re-ranking every cycle doesn't inflate totalCalls by
 *     counting every cycle as a fresh call.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): a draw
 * record only stores its own threeBallColor/fourBallColor outcome, not
 * "what color was threeBallColorEngine tracking N draws ago." That
 * calling context only exists transiently in the live council cycle, so
 * it must be logged as it happens (via store.threeBallColorHitCounter)
 * and resolved against draws as they arrive.
 *
 * CHANCE BASELINE: with 3 roughly-equal colors and a 7-draw window, a
 * watch only needs ONE hit anywhere in 7 tries (not a hit on a
 * specific draw), so an uninformed random pick already clears the
 * window a large fraction of the time. baselineHitRatePct is shown
 * alongside the raw hit rate so it is never read in isolation.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational scoring log.
 * Never votes, never feeds back into threeBallColorEngine or any
 * gate/weight -- same discipline as every other *HitCounter.js in this
 * codebase.
 */
'use strict';

const { isColorHit } = require('./threeBallColorEngine');

// FIX -- resolution benchmark, same numeric range and reasoning as
// tieNextEventEngine.js's MIN_RESOLUTION_DRAWS/MAX_RESOLUTION_DRAWS: a
// call is only ever gradeable within 1-7 draws of opening; past that it
// is force-resolved as a MISS instead of sitting open indefinitely.
const MIN_RESOLUTION_DRAWS = 1;
const MAX_RESOLUTION_DRAWS = 7;
const MAX_PREDICTION_LOG = 300;

const COLOR_COUNT = 3; // RED/BLUE/GREEN -- see src/core/colorMath.js's HIERARCHY

// See header "CHANCE BASELINE" above. Rounded to 1 decimal for display
// consistency with every other *Pct field this engine reports.
const BASELINE_HIT_RATE_PCT = Math.round((1 - Math.pow(1 - 1 / COLOR_COUNT, MAX_RESOLUTION_DRAWS)) * 1000) / 10;

function freshPickState() {
  return { hits: 0, misses: 0, pending: null, predictions: [] };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit via isColorHit() (3-ball OR 4-ball match, same rule
 * threeBallColorEngine.js itself uses), increments drawsElapsed, and --
 * once the call is actually decided (HIT, or MAX_RESOLUTION_DRAWS
 * elapsed with no match) -- resolves it: updates the hits/misses tally
 * AND appends a RESOLVED entry to the predictions log. No-op if
 * nothing is pending, or if the call is still genuinely undecided.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;
  if (!Array.isArray(pick.predictions)) pick.predictions = [];

  pick.pending.drawsElapsed++;

  const isHit = isColorHit(latestDraw, pick.pending.color);
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
 * Main entry point, called once per council cycle after
 * threeBallColorEngine.js (analyzeThreeBallColor) has run. Order
 * matters: resolve any existing pending watch against the latest landed
 * draw FIRST (dedup'd per draw via lastProcessedDrawId), then open a
 * fresh watch for this cycle's trackedColor -- so a brand-new watch is
 * never immediately graded against the very draw that created it.
 *
 * threeBallColorIntel is the full analyzeThreeBallColor() result:
 * trackedColor supplies the color being watched, unconditionally (no
 * gate) every cycle the General Parliament has a winningColor at all.
 */
function evaluateThreeBallColorHitCounter(historicalDraws, threeBallColorIntel, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.trackedColorPick) counter.trackedColorPick = freshPickState();
  if (!Array.isArray(counter.trackedColorPick.predictions)) counter.trackedColorPick.predictions = [];
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.trackedColorPick, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const trackedColor = threeBallColorIntel && threeBallColorIntel.available
    ? threeBallColorIntel.trackedColor
    : null;

  if (trackedColor) {
    const opened = openWatchIfIdle(counter.trackedColorPick, trackedColor, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.trackedColorPick.hits + counter.trackedColorPick.misses;
  const hitRatePct = resolved > 0 ? Math.round((counter.trackedColorPick.hits / resolved) * 1000) / 10 : null;

  const predictions = counter.trackedColorPick.predictions;
  const hitLatencies = predictions.filter(p => p.result === 'HIT').map(p => p.drawsSinceOpen);
  const avgDrawsToHit = hitLatencies.length > 0
    ? Math.round((hitLatencies.reduce((s, v) => s + v, 0) / hitLatencies.length) * 10) / 10
    : null;

  return {
    engine: 'ThreeBallColorHitCounter',
    resolutionWindow: [MIN_RESOLUTION_DRAWS, MAX_RESOLUTION_DRAWS],
    totalCalls: counter.totalCalls,
    // Chance baseline for interpreting hitRatePct against -- see header
    // "CHANCE BASELINE" above.
    baselineHitRatePct: BASELINE_HIT_RATE_PCT,
    trackedColorPick: {
      color: counter.trackedColorPick.pending ? counter.trackedColorPick.pending.color : null,
      hits: counter.trackedColorPick.hits,
      misses: counter.trackedColorPick.misses,
      hitRatePct,
      avgDrawsToHit,
      pending: Boolean(counter.trackedColorPick.pending),
      drawsElapsed: counter.trackedColorPick.pending ? counter.trackedColorPick.pending.drawsElapsed : 0
    },
    // FIX -- the per-call log itself: each entry is one opened-then-
    // resolved (HIT or expired/MISS) call, newest first.
    predictions: predictions.slice(0, 100),
    reasoning: counter.totalCalls === 0
      ? 'No 3-Ball Color Hit Intelligence call has been logged yet -- counter has nothing to report.'
      : `${counter.totalCalls} tracked-color call(s) so far. ${counter.trackedColorPick.hits} hit / ${counter.trackedColorPick.misses} missed` +
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
  evaluateThreeBallColorHitCounter
};
