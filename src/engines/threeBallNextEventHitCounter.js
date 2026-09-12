/**
 * 3-Ball Next Event Hit Counter.
 *
 * Scoring log for threeBallSeasonIntelligenceLab.js's Next Event
 * Leaderboard (badge.nextEventLeaderboard / badge.topColor), replacing
 * threeBallEntryHitCounter.js as 3SIL's scoring mechanism -- see the
 * Next Event Leaderboard's header comment in
 * threeBallSeasonIntelligenceLab.js for why the binary ENTER gate it
 * used to score was replaced.
 *
 * TWO INDEPENDENT 3-BALL FORECASTS: this engine's topColor and
 * threeBallColorHitCounter.js's trackedColor are computed
 * independently and do not always agree -- one can say GREEN while the
 * other says RED on the same cycle. Each gets its OWN log for exactly
 * that reason; blending them would hide the disagreement.
 *
 * STRUCTURAL DIFFERENCE FROM threeBallEntryHitCounter.js: the old
 * counter only opened a watch when badge.enterNow was true, which is
 * exactly the "silent for hours" problem the leaderboard was built to
 * fix -- a scoring log gated on a rarely-true condition can't measure
 * much either. The leaderboard has a topColor every single cycle, so
 * this counter watches every cycle too: it is never idle waiting for a
 * gate to open. This is what makes accuracy "measurable from day one"
 * (per the operator's own framing) instead of only after the gate has
 * fired enough times to build a sample.
 *
 * FIX -- RESOLUTION BENCHMARK (mirrors tieNextEventEngine.js's own
 * "Resolution benchmark" fix exactly): before this fix there was only a
 * running hits/misses tally with no way to inspect how any INDIVIDUAL
 * call actually played out. This version keeps the tally (backward
 * compatible) but adds a `predictions` log -- one entry per call,
 * opened and RESOLVED (HIT or expired/MISS) exactly like
 * tieNextEventEngine.js's openForecast/predictions pattern.
 *
 * A call is gradeable as a HIT only between MIN_RESOLUTION_DRAWS and
 * MAX_RESOLUTION_DRAWS (1-7) draws after it opened. If no hit lands
 * within that window it is force-resolved as a MISS (expired) instead
 * of staying open -- same discipline, same numeric range (1-7), as
 * tieNextEventEngine.js's own MIN_RESOLUTION_DRAWS/MAX_RESOLUTION_DRAWS.
 *
 * MECHANICS (same watch/resolve shape as threeBallEntryHitCounter.js,
 * continuous instead of gated):
 *   - Every cycle, if no watch is currently pending, open a fresh watch
 *     on badge.topColor.
 *   - HIT as soon as a landed draw's threeBallColor matches the watched
 *     color.
 *   - MISS (expired) if MAX_RESOLUTION_DRAWS draws pass with no match.
 *   - While a watch is open, later cycles do not re-open a new one even
 *     if topColor changes mid-watch -- same single-slot-per-pick
 *     discipline as threeBallEntryHitCounter.js/entryHitCounter.js, so a
 *     leaderboard that keeps re-ranking every cycle doesn't inflate
 *     totalCalls by counting every cycle as a fresh call.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): a draw
 * record only stores its own threeBallColor outcome, not "what did the
 * leaderboard say the top color was going to be N draws ago." That
 * calling context only exists transiently in the live council cycle, so
 * it must be logged as it happens (via store.threeBallNextEventHitCounter)
 * and resolved against draws as they arrive.
 *
 * FULL-RANK SCORING (not just topColor): the leaderboard makes a claim
 * about all three colors' order, not just which one is #1. This
 * snapshots the FULL ranked order (all 3 colors, in rank order) when a
 * watch opens, and on resolution records which rank position the color
 * that actually hit held in that snapshot -- so it's possible to
 * report, e.g., "the actual next color was leaderboard rank #1 62% of
 * the time, rank #2 the rest" -- validating the ranking itself, not
 * just its top slot. Unlike topColorPick, the rank watch resolves on
 * whatever draw a match happens or MAX_RESOLUTION_DRAWS elapses --
 * same window, same discipline.
 *
 * CHANCE BASELINE: with 3 colors (HIERARCHY.length === 3), a strategy
 * that watched a color at random would land a hit within a
 * MAX_RESOLUTION_DRAWS-draw window much more often than intuition
 * suggests -- verified by closed-form math: at 7 draws and 3
 * roughly-equal colors, an uninformed random pick clears the window
 * (lands at least once) a large majority of the time, not "1 in 3."
 * This is because the watch only needs ONE hit anywhere in the window,
 * not a hit on a specific draw -- so a raw topColorPick.hitRatePct
 * close to what pure chance already produces in this window size is
 * NOT on its own evidence the leaderboard has skill.
 * baselineHitRatePct computes this exact figure via
 * 1 - (1 - 1/N)^MAX_RESOLUTION_DRAWS (N = color count), so the
 * dashboard can show the real hit rate next to what an uninformed guess
 * achieves in the same window, instead of presenting the raw number
 * alone and letting it look far more impressive than it is.
 */

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
 * Advances a pending watch (if any) against the latest landed draw,
 * and -- once the call is actually decided (HIT, or
 * MAX_RESOLUTION_DRAWS elapsed with no match) -- resolves it: updates
 * the hits/misses tally AND appends a RESOLVED entry to the
 * predictions log. No-op if nothing is pending, or if the call is
 * still genuinely undecided.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;
  if (!Array.isArray(pick.predictions)) pick.predictions = [];

  pick.pending.drawsElapsed++;
  const actualColor = latestDraw.threeBallColor || null;
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
 * No-op if a watch is already pending (that call is treated as a
 * continuation of the one already being tracked) or if there's no
 * color to watch.
 */
function openWatchIfIdle(pick, color, openedAfterDrawId) {
  if (pick.pending || !color) return false;
  pick.pending = { color, openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * FIX support -- advances the full-rank watch (if any) against the
 * latest landed draw. Unlike resolvePendingWatch (which only cares
 * whether ITS ONE watched color hit), this checks the actual color
 * against every rank position in the snapshot taken when the watch
 * opened, and -- as soon as ANY color in the snapshot hits, OR
 * MAX_RESOLUTION_DRAWS elapses -- records which rank that color held
 * (or scores every rank a miss on expiry) and closes the watch.
 *
 * rankState.byRank is keyed by 1-based rank position (as a string, for
 * clean JSON round-tripping): { "1": {hits, misses}, "2": {...}, "3": {...} }.
 * A resolution increments hits at whichever rank the landed color held
 * in the snapshot, and increments misses at every OTHER rank in that
 * same snapshot (each rank position is its own independent claim --
 * "the 2nd-ranked color will hit within the window" is a miss for rank
 * 2 specifically if a different ranked color hits instead, exactly the
 * same hit/miss discipline topColorPick already applies to rank 1
 * alone). If MAX_RESOLUTION_DRAWS elapses with no match at all, every
 * rank in the snapshot is scored a miss.
 */
function resolveRankWatch(rankState, latestDraw) {
  if (!rankState.pending || !latestDraw) return;

  rankState.pending.drawsElapsed++;
  const actualColor = latestDraw.threeBallColor || null;
  const snapshot = rankState.pending.rankedColors; // e.g. ['RED','BLUE','GREEN'], index 0 = rank 1

  const hitIndex = actualColor != null ? snapshot.indexOf(actualColor) : -1;
  const timedOut = rankState.pending.drawsElapsed >= MAX_RESOLUTION_DRAWS;

  if (hitIndex === -1 && !timedOut) return; // still pending, nothing to score yet

  snapshot.forEach((color, i) => {
    const rank = String(i + 1);
    if (!rankState.byRank[rank]) rankState.byRank[rank] = { hits: 0, misses: 0 };
    if (i === hitIndex) {
      rankState.byRank[rank].hits++;
    } else {
      rankState.byRank[rank].misses++;
    }
  });

  rankState.pending = null;
}

/**
 * Opens a new full-rank watch if none is currently open. No-op if a
 * watch is already pending or if there's no ranked list to snapshot.
 * rankedColors is captured once, at open time, and never re-read while
 * the watch is pending -- same "one watch, resolved against what was
 * true when it opened" discipline as openWatchIfIdle.
 */
function openRankWatchIfIdle(rankState, rankedColors, openedAfterDrawId) {
  if (rankState.pending || !Array.isArray(rankedColors) || rankedColors.length === 0) return false;
  rankState.pending = { rankedColors: rankedColors.slice(), openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle after 3SIL has run.
 * Order matters: resolve any existing pending watch against the latest
 * landed draw FIRST (dedup'd per draw via lastProcessedDrawId), then
 * open a fresh watch for this cycle's topColor -- so a brand-new watch
 * is never immediately graded against the very draw that created it.
 *
 * threeSIL is the full evaluateThreeBallSeasonIntelligenceLab() result:
 * badge.topColor supplies the color being watched, unconditionally
 * (no gate) every cycle 3SIL has produced a badge at all.
 * badge.nextEventLeaderboard (the full ranked array) supplies the
 * snapshot for the new full-rank watch.
 */
function evaluateThreeBallNextEventHitCounter(historicalDraws, threeSIL, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.topColorPick) counter.topColorPick = freshPickState();
  if (!Array.isArray(counter.topColorPick.predictions)) counter.topColorPick.predictions = [];
  if (!counter.rankWatch || typeof counter.rankWatch !== 'object') {
    counter.rankWatch = { pending: null, byRank: {} };
  }
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.topColorPick, latestDraw);
    resolveRankWatch(counter.rankWatch, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const badge = threeSIL && threeSIL.badge ? threeSIL.badge : null;
  const topColor = badge ? badge.topColor : null;
  const rankedColors = badge && Array.isArray(badge.nextEventLeaderboard)
    ? badge.nextEventLeaderboard.map(r => r.color)
    : null;

  if (topColor) {
    const opened = openWatchIfIdle(counter.topColorPick, topColor, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }
  // Opened independently of topColorPick's own totalCalls counter --
  // both watches open/close on the same cadence in practice (both keyed
  // off the same badge each cycle), but keeping them structurally
  // separate means a future change to one watch's opening condition
  // can't silently desync the other's counted total.
  if (rankedColors) {
    openRankWatchIfIdle(counter.rankWatch, rankedColors, latestDraw ? latestDraw.drawId : null);
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.topColorPick.hits + counter.topColorPick.misses;
  const hitRatePct = resolved > 0 ? Math.round((counter.topColorPick.hits / resolved) * 1000) / 10 : null;

  const predictions = counter.topColorPick.predictions;
  const hitLatencies = predictions.filter(p => p.result === 'HIT').map(p => p.drawsSinceOpen);
  const avgDrawsToHit = hitLatencies.length > 0
    ? Math.round((hitLatencies.reduce((s, v) => s + v, 0) / hitLatencies.length) * 10) / 10
    : null;

  // Per-rank breakdown for the dashboard/API. rankAccuracy[i]
  // corresponds to rank i+1 (1-indexed to match how the leaderboard
  // itself is displayed, "#1"/"#2"/"#3").
  const rankAccuracy = [1, 2, 3].map(rank => {
    const cell = counter.rankWatch.byRank[String(rank)] || { hits: 0, misses: 0 };
    const cellResolved = cell.hits + cell.misses;
    return {
      rank,
      hits: cell.hits,
      misses: cell.misses,
      hitRatePct: cellResolved > 0 ? Math.round((cell.hits / cellResolved) * 1000) / 10 : null
    };
  });

  return {
    engine: 'ThreeBallNextEventHitCounter',
    resolutionWindow: [MIN_RESOLUTION_DRAWS, MAX_RESOLUTION_DRAWS],
    totalCalls: counter.totalCalls,
    // Chance baseline for interpreting hitRatePct against -- see header
    // "CHANCE BASELINE" above.
    baselineHitRatePct: BASELINE_HIT_RATE_PCT,
    topColorPick: {
      color: counter.topColorPick.pending ? counter.topColorPick.pending.color : null,
      hits: counter.topColorPick.hits,
      misses: counter.topColorPick.misses,
      hitRatePct,
      avgDrawsToHit,
      pending: Boolean(counter.topColorPick.pending),
      drawsElapsed: counter.topColorPick.pending ? counter.topColorPick.pending.drawsElapsed : 0
    },
    // FIX -- the per-call log itself: each entry is one opened-then-
    // resolved (HIT or expired/MISS) call, newest first.
    predictions: predictions.slice(0, 100),
    // Full-ranking accuracy, additive to topColorPick above.
    rankAccuracy,
    reasoning: counter.totalCalls === 0
      ? 'No leaderboard call has been logged yet -- counter has nothing to report.'
      : `${counter.totalCalls} leaderboard call(s) so far. Top-ranked color: ${counter.topColorPick.hits} hit / ${counter.topColorPick.misses} missed` +
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
  resolveRankWatch,
  openRankWatchIfIdle,
  evaluateThreeBallNextEventHitCounter
};
