/**
 * ============================================================
 *  4-BALL COLOR NEXT EVENT HIT COUNTER
 * ============================================================
 *
 * Scoring log for the 4-Ball Color Next Event hero card's DUAL pick
 * (see index.html's #tb3SILHeroStrip / renderThreeBallHeroCard) --
 * direct structural clone of threeBallNextEventHitCounter.js /
 * threeBallColorHitCounter.js, re-keyed to the 4-ball color next-event
 * forecast instead of a 3-ball one, and extended to TWO independently
 * watched pick slots instead of one (see "DUAL-PICK REWIRE" below).
 *
 * WHY THIS EXISTS: fourBallColorNextEventEngine.js previously had no
 * hit-counter performance log of its own -- there was no way to see,
 * over time, whether predictedNextColor was actually landing more
 * often than chance. This gives it one, same evaluation discipline as
 * every other next-event/color-forecast engine in this codebase.
 *
 * DUAL-PICK REWIRE (per operator direction): the hero card no longer
 * shows a single predicted color -- it shows a 1st Pick (this event's
 * own overdue color, fourBallColorNextEvent.predictedNextColor) and a
 * 2nd Pick (the 4-Ball section's current leading color, fourBallP's
 * winningColor). If those two collide, the hero card mirrors the
 * 4-Ball section's own dual pick instead (fourBallP.winningColor /
 * .secondColor) for the rest of that 4-ball-color-event cycle -- see
 * index.html's fbnCollision/heroFbnMirrorLockDrawId comment for the
 * full client-side description of that behavior. This engine now
 * tracks that EXACT same pair of picks server-side (independent
 * pick1Slot/pick2Slot watches, same mirror-lock keyed off
 * fourBallColorNextEvent.drawId) so the hit-counter never watches a
 * different color than what the hero card actually displayed that
 * cycle. Each resolved entry records WHICH pick slot it came from
 * (pickNumber/pickLabel) so the combined log can read e.g. "BLUE from
 * 1st pick @draw12345" / "RED from 2nd pick @draw12346".
 *
 * MECHANICS (continuous, no gate -- same reasoning as
 * threeBallNextEventHitCounter.js's header: the engine has a due color
 * every single cycle once it has any sample at all, so this counter is
 * never idle waiting on a gate), per pick slot:
 *   - Every cycle, if no watch is currently pending on that slot, open
 *     a fresh watch on that slot's current color (see resolvePickColors()
 *     below for how each slot's color is derived, including the
 *     collision/mirror rule).
 *   - HIT as soon as a landed draw's fourBallColor matches the watched
 *     color -- this engine's own event definition IS "reached 4-ball",
 *     so unlike threeBallColorHitCounter.js's isColorHit() (which
 *     accepts either a 3-ball or 4-ball match), a hit here is a direct,
 *     single-field comparison against draw.fourBallColor.
 *   - MISS (expired) if MAX_RESOLUTION_DRAWS draws pass with no match.
 *   - While a watch is open on a slot, later cycles do not re-open a
 *     new one on that slot even if its color changes mid-watch -- same
 *     single-slot-per-pick discipline as every other *HitCounter.js in
 *     this codebase. The two slots are otherwise fully independent --
 *     one can be pending while the other resolves.
 *
 * FIX -- RESOLUTION BENCHMARK: same 1-7 draw resolution window and
 * chance baseline as threeBallNextEventHitCounter.js/
 * threeBallColorHitCounter.js -- see those files' headers for the full
 * reasoning. Baseline is per-slot (each slot is its own single-color
 * watch), so it's unchanged by the dual-pick rewire.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): a draw
 * record only stores its own fourBallColor outcome, not "what did each
 * pick slot watch N draws ago." That calling context only exists
 * transiently in the live council cycle, so it must be logged as it
 * happens (via store.fourBallColorNextEventHitCounter) and resolved
 * against draws as they arrive. The mirror-lock state (mirrorLockDrawId)
 * is persisted for the same reason -- it must survive across cycles
 * within a single 4-ball-color-event cycle, same as the front-end's own
 * heroFbnMirrorLockDrawId variable does client-side.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational scoring log.
 * Never votes, never feeds back into fourBallColorNextEventEngine,
 * runFourBallParliament, or any gate/weight -- same discipline as every
 * other *HitCounter.js in this codebase.
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
 * predictions log, tagged with which pick slot (pickNumber/pickLabel)
 * it belongs to so the combined log can identify it (e.g. "BLUE from
 * 1st pick @draw12345"). No-op if nothing is pending, or if the call is
 * still genuinely undecided.
 */
function resolvePendingWatch(pick, latestDraw, pickNumber) {
  if (!pick.pending || !latestDraw) return null;
  if (!Array.isArray(pick.predictions)) pick.predictions = [];

  pick.pending.drawsElapsed++;

  const actualColor = latestDraw.fourBallColor || null;
  const isHit = actualColor != null && actualColor === pick.pending.color;
  const expired = !isHit && pick.pending.drawsElapsed >= MAX_RESOLUTION_DRAWS;

  if (!isHit && !expired) return null; // still genuinely pending

  const pickLabel = pickNumber === 1 ? '1st pick' : '2nd pick';
  const resolvedEntry = {
    status: 'RESOLVED',
    pickNumber,
    pickLabel,
    openedDrawId: pick.pending.openedAfterDrawId,
    color: pick.pending.color,
    resolvedDrawId: latestDraw.drawId,
    drawsSinceOpen: pick.pending.drawsElapsed,
    result: isHit ? 'HIT' : 'MISS',
    accurate: isHit,
    expired,
    resolvedAt: new Date().toISOString(),
    // Ready-to-display label per operator direction, e.g.
    // "BLUE from 1st pick @draw12345" / "RED from 2nd pick @draw12346".
    label: `${pick.pending.color} from ${pickLabel} @draw${latestDraw.drawId}`
  };

  if (isHit) pick.hits++; else pick.misses++;
  pick.predictions = [resolvedEntry, ...pick.predictions].slice(0, MAX_PREDICTION_LOG);
  pick.pending = null;
  return resolvedEntry;
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
 * Derives this cycle's 1st/2nd pick colors -- EXACT server-side mirror
 * of index.html's fbnCollision/heroFbnMirrorLockDrawId client-side
 * logic, so the hit counter always watches what the hero card actually
 * displayed:
 *   - 1st Pick defaults to fourBallColorNextEvent.predictedNextColor
 *     (the overdue color), 2nd Pick defaults to fourBallP.winningColor
 *     (the 4-Ball section's current leading color).
 *   - If those collide (same color), both flip to mirror the 4-Ball
 *     section's own dual pick (fourBallP.winningColor / .secondColor)
 *     instead -- and that mirrored state LATCHES, via
 *     counter.mirrorLockDrawId, for the rest of the current 4-ball-
 *     color-event cycle (identified by fourBallColorNextEvent.drawId),
 *     only releasing once a new 4-ball color event actually resolves
 *     (drawId moves on).
 */
function resolvePickColors(counter, fourBallColorNextEvent, fourBallP) {
  const fbnActive = !!(fourBallColorNextEvent && fourBallColorNextEvent.available);
  const primaryColor = fbnActive ? fourBallColorNextEvent.predictedNextColor : null;
  const leadingColor = (fourBallP && fourBallP.winningColor) || null;
  const eventDrawId = fbnActive ? fourBallColorNextEvent.drawId : null;

  const collision = !!(primaryColor && leadingColor && primaryColor === leadingColor);

  if (collision) {
    counter.mirrorLockDrawId = eventDrawId != null ? eventDrawId : counter.mirrorLockDrawId;
  } else if (counter.mirrorLockDrawId != null && eventDrawId !== counter.mirrorLockDrawId) {
    counter.mirrorLockDrawId = null; // this cycle resolved -- drop back to the default view
  }
  const mirrored = counter.mirrorLockDrawId != null && eventDrawId === counter.mirrorLockDrawId;

  return {
    pick1Color: mirrored ? ((fourBallP && fourBallP.winningColor) || null) : primaryColor,
    pick2Color: mirrored ? ((fourBallP && fourBallP.secondColor) || null) : leadingColor
  };
}

/**
 * Main entry point, called once per council cycle immediately after
 * fourBallColorNextEventEngine.js (analyzeFourBallColorNextEvent) and
 * runFourBallParliament have both run. Order matters: resolve any
 * existing pending watches against the latest landed draw FIRST
 * (dedup'd per draw via lastProcessedDrawId), then open fresh watches
 * for this cycle's 1st/2nd pick colors -- so a brand-new watch is never
 * immediately graded against the very draw that created it.
 *
 * fourBallColorNextEvent is the full analyzeFourBallColorNextEvent()
 * result (supplies the 1st Pick / overdue color and drawId). fourBallP
 * is runFourBallParliament's full result (supplies the 2nd Pick /
 * leading color via winningColor, and the mirror colors via
 * winningColor+secondColor) -- same object officialPredictions.next4Ball
 * is built from in council.js, read here directly rather than waiting
 * for officialPredictions to be assembled.
 */
function evaluateFourBallColorNextEventHitCounter(historicalDraws, fourBallColorNextEvent, fourBallP, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.pick1Slot) counter.pick1Slot = freshPickState();
  if (!counter.pick2Slot) counter.pick2Slot = freshPickState();
  if (!Array.isArray(counter.pick1Slot.predictions)) counter.pick1Slot.predictions = [];
  if (!Array.isArray(counter.pick2Slot.predictions)) counter.pick2Slot.predictions = [];
  if (!Array.isArray(counter.predictions)) counter.predictions = []; // combined, labeled log
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;
  if (counter.mirrorLockDrawId === undefined) counter.mirrorLockDrawId = null;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    const resolved1 = resolvePendingWatch(counter.pick1Slot, latestDraw, 1);
    const resolved2 = resolvePendingWatch(counter.pick2Slot, latestDraw, 2);
    // Combined, labeled log -- newest first, whichever slot(s) resolved
    // this cycle (both can resolve on the same draw independently).
    const newlyResolved = [resolved1, resolved2].filter(Boolean);
    if (newlyResolved.length > 0) {
      counter.predictions = [...newlyResolved, ...counter.predictions].slice(0, MAX_PREDICTION_LOG);
    }
    counter.lastProcessedDrawId = drawId;
  }

  const { pick1Color, pick2Color } = resolvePickColors(counter, fourBallColorNextEvent, fourBallP);

  if (pick1Color) {
    const opened = openWatchIfIdle(counter.pick1Slot, pick1Color, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }
  if (pick2Color) {
    const opened = openWatchIfIdle(counter.pick2Slot, pick2Color, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  function summarizeSlot(slot) {
    const resolved = slot.hits + slot.misses;
    const hitRatePct = resolved > 0 ? Math.round((slot.hits / resolved) * 1000) / 10 : null;
    const hitLatencies = slot.predictions.filter(p => p.result === 'HIT').map(p => p.drawsSinceOpen);
    const avgDrawsToHit = hitLatencies.length > 0
      ? Math.round((hitLatencies.reduce((s, v) => s + v, 0) / hitLatencies.length) * 10) / 10
      : null;
    return {
      color: slot.pending ? slot.pending.color : null,
      hits: slot.hits,
      misses: slot.misses,
      hitRatePct,
      avgDrawsToHit,
      pending: Boolean(slot.pending),
      drawsElapsed: slot.pending ? slot.pending.drawsElapsed : 0
    };
  }

  const pick1Summary = summarizeSlot(counter.pick1Slot);
  const pick2Summary = summarizeSlot(counter.pick2Slot);
  const combinedHits = counter.pick1Slot.hits + counter.pick2Slot.hits;
  const combinedMisses = counter.pick1Slot.misses + counter.pick2Slot.misses;
  const combinedResolved = combinedHits + combinedMisses;
  const combinedHitRatePct = combinedResolved > 0 ? Math.round((combinedHits / combinedResolved) * 1000) / 10 : null;

  return {
    engine: 'FourBallColorNextEventHitCounter',
    resolutionWindow: [MIN_RESOLUTION_DRAWS, MAX_RESOLUTION_DRAWS],
    totalCalls: counter.totalCalls,
    // Chance baseline for interpreting hitRatePct against -- see header
    // "CHANCE BASELINE" (threeBallNextEventHitCounter.js's, reused here
    // verbatim) above. Same baseline applies to each slot individually
    // (each is its own single-color watch) and to the combined figure.
    baselineHitRatePct: BASELINE_HIT_RATE_PCT,
    mirrored: counter.mirrorLockDrawId != null,
    // Per-slot breakdown, same field shape as the pre-rewire single
    // predictedColorPick so existing consumers keyed on hits/misses/
    // hitRatePct/pending/drawsElapsed per slot keep working.
    pick1: pick1Summary,
    pick2: pick2Summary,
    // Combined figures across both slots, for the card's headline
    // totals.
    combined: {
      hits: combinedHits,
      misses: combinedMisses,
      hitRatePct: combinedHitRatePct
    },
    // The per-call combined log itself: each entry is one opened-then-
    // resolved (HIT or expired/MISS) call from EITHER pick slot, newest
    // first, tagged with pickNumber/pickLabel/label so the UI can show
    // e.g. "BLUE from 1st pick @draw12345".
    predictions: counter.predictions.slice(0, 100),
    reasoning: counter.totalCalls === 0
      ? 'No 4-Ball Color Next Event call has been logged yet -- counter has nothing to report.'
      : `${counter.totalCalls} dual-pick call(s) so far (1st pick: ${pick1Summary.hits} hit / ${pick1Summary.misses} missed` +
        (pick1Summary.hitRatePct != null ? ` @ ${pick1Summary.hitRatePct}%` : '') +
        `; 2nd pick: ${pick2Summary.hits} hit / ${pick2Summary.misses} missed` +
        (pick2Summary.hitRatePct != null ? ` @ ${pick2Summary.hitRatePct}%` : '') +
        `). Combined ${combinedHits} hit / ${combinedMisses} missed` +
        (combinedHitRatePct != null ? ` (${combinedHitRatePct}% vs. ~${BASELINE_HIT_RATE_PCT}% expected by chance alone in a ${MAX_RESOLUTION_DRAWS}-draw window).` : '.')
  };
}

module.exports = {
  MIN_RESOLUTION_DRAWS,
  MAX_RESOLUTION_DRAWS,
  COLOR_COUNT,
  BASELINE_HIT_RATE_PCT,
  resolvePendingWatch,
  openWatchIfIdle,
  resolvePickColors,
  evaluateFourBallColorNextEventHitCounter
};
