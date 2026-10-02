/**
 * 5-BALL HARVESTER (Phase 1 of the 5-Ball Research Lab)
 *
 * PHASE 1 ONLY. Per the operator-approved architecture: Harvest -> Research
 * -> Learning -> Validation -> Shadow Prediction -> Live Prediction. This
 * file is ONLY Phase 1 -- pure event detection and capture. It computes NO
 * frequency rates, NO gap statistics, NO distributions, and makes NO
 * predictions. Those are Phase 2 (Research Lab) and later.
 *
 * WHY THIS EXISTS / WHAT CHANGED IN validator.js: a genuine 5-ball event
 * (a color reaching 5+ balls in one draw) was previously invisible as its
 * own event -- validator.js's fourBallColor field fires on "count >= 4",
 * which silently absorbed every 5-ball draw into the 4-ball tier with no
 * way to tell them apart. validator.js now ALSO sets a new, purely
 * additive fiveBallColor field (count >= 5) alongside the unchanged
 * fourBallColor.
 *
 * WHAT GETS CAPTURED, per the approved Phase 1 spec, for EVERY 5-ball
 * event: draw ID, timestamp, event color, that draw's own colorCounts,
 * the preceding draw, the following draw, and the event's position in
 * the observed history.
 *
 * EVENT-NEIGHBORHOOD FINGERPRINTING (added on operator request, per the
 * approved spec's "really interesting part" -- ±10 draws around each
 * event as a fingerprint): every captured event now ALSO carries
 * precedingWindow (up to 10 draws immediately before the event,
 * chronological oldest-first, captured in full immediately since that
 * history already exists at capture time) and followingWindow (up to 10
 * draws immediately after, filled in progressively, ONE per cycle, as
 * they actually land -- see backfillFollowingWindows() below). This raw
 * captured window is what fiveBallEventFingerprintEngine.js (Phase 2)
 * builds feature vectors and similarity matches from; this file only
 * ever captures the raw draws, never interprets them -- same RAW DATA ->
 * OBSERVATIONS separation as everywhere else in this lab.
 *
 * STATEFUL BY NECESSITY (unlike e.g. tiePrecursorPatternEngine.js's pure
 * recompute): an event's position, preceding/following draws, and full
 * neighborhoods all depend on state that cannot be re-derived from
 * historicalDraws alone on every call once the underlying draw ages out
 * of the store's rolling history window. Follows this codebase's
 * established append-only-log-plus-lastProcessedDrawId-dedup pattern.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention.
 */
'use strict';

const MAX_LOG_ENTRIES = 2000; // generous cap -- 5-ball events are rare by definition, this should hold years of real history before ever truncating
const NEIGHBORHOOD_SIZE = 10; // draws captured on each side of an event, per the approved "event fingerprint" spec
const MAX_PENDING_WINDOW_SCAN = 2 * NEIGHBORHOOD_SIZE; // how many of the most-recent log entries to check for an incomplete followingWindow each cycle -- generous margin, a window can only ever still be filling for its own first NEIGHBORHOOD_SIZE draws

function freshHarvestMemory() {
  return {
    schemaVersion: 2, // bumped: eventLog entries now carry precedingWindow/followingWindow
    lastProcessedDrawId: null,
    totalDrawsObserved: 0, // running counter, incremented on every NEW draw seen (event or not) -- this IS the "position in observed history" counter
    eventLog: [], // most-recent-first, capped at MAX_LOG_ENTRIES
    updatedAt: null
  };
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (!Array.isArray(m.eventLog)) m.eventLog = [];
  if (typeof m.lastProcessedDrawId === 'undefined') m.lastProcessedDrawId = null;
  if (typeof m.totalDrawsObserved !== 'number') m.totalDrawsObserved = 0;
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  // Older (schemaVersion 1) entries simply won't have precedingWindow/
  // followingWindow -- readers fall back to [] wherever those are used,
  // no migration needed (they just never get a fingerprint, which is
  // honest: that data genuinely wasn't captured for them).
  return m;
}

/**
 * A compact, honest summary of a single draw -- used for precedingDraw,
 * followingDraw, and every entry in precedingWindow/followingWindow.
 * Deliberately minimal (no derived commentary) so later phases have raw
 * facts to compute from, not someone else's interpretation of them.
 */
function summarizeDraw(draw) {
  if (!draw) return null;
  return {
    drawId: draw.drawId != null ? String(draw.drawId) : null,
    timestamp: draw.timestamp || null,
    colorCounts: draw.colorCounts ? { ...draw.colorCounts } : null,
    threeBallColor: draw.threeBallColor || null,
    fourBallColor: draw.fourBallColor || null,
    fiveBallColor: draw.fiveBallColor || null
  };
}

function pushCapped(log, entry) {
  log.unshift(entry);
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
}

/**
 * If the most recently logged event's followingDraw is still unknown,
 * and the draw immediately preceding the CURRENT new draw (i.e.
 * historicalDraws[1] from this cycle's perspective) is that same event's
 * own draw, then the current new draw IS its following draw -- fill it
 * in now. No-op otherwise (including the common case where there simply
 * isn't a pending event waiting on this).
 */
function backfillFollowingDraw(memory, newDraw, drawImmediatelyBefore) {
  const mostRecentEvent = memory.eventLog[0];
  if (!mostRecentEvent) return;
  if (mostRecentEvent.followingDraw !== null) return; // already filled -- nothing pending
  if (!drawImmediatelyBefore) return;
  if (String(drawImmediatelyBefore.drawId) !== mostRecentEvent.drawId) return; // the pending event isn't the draw right before this new one -- something else (or nothing) happened in between, so we genuinely don't know its following draw from this data alone; leave it null rather than guessing

  mostRecentEvent.followingDraw = summarizeDraw(newDraw);
}

/**
 * Progressively fills followingWindow (up to NEIGHBORHOOD_SIZE draws)
 * for any recently-logged event still short of a complete window. Only
 * ever appends the CURRENT new draw once, to whichever event(s) are
 * exactly at the right position to receive it next -- an event N draws
 * old needs the current draw appended only if its followingWindow
 * already has exactly N-1 entries (i.e. draws are appended strictly in
 * order, one per cycle, never skipped or duplicated).
 */
function backfillFollowingWindows(memory, newDraw) {
  const scanLimit = Math.min(memory.eventLog.length, MAX_PENDING_WINDOW_SCAN);
  for (let i = 0; i < scanLimit; i++) {
    const event = memory.eventLog[i];
    if (!Array.isArray(event.followingWindow)) event.followingWindow = [];
    if (event.followingWindow.length >= NEIGHBORHOOD_SIZE) continue;
    // This event is `i` log-slots newer... no -- log order and draw
    // order aren't the same thing once multiple events exist close
    // together. The correct check is purely arithmetic: how many draws
    // have landed since this event, vs how many window entries it
    // already has. Since we only ever call this once per genuinely new
    // draw (dedup'd by the caller), and entries are appended in strict
    // arrival order, "already has K entries" always means "the next
    // draw to arrive is exactly entry K+1" -- so it's always correct to
    // append the current new draw, for every event still short of
    // NEIGHBORHOOD_SIZE, every single cycle a new draw lands.
    event.followingWindow.push(summarizeDraw(newDraw));
  }
}

/**
 * Main entry point, called once per council cycle. Pure capture -- no
 * scoring, no rates, no predictions. Dedup'd per real draw ID so the
 * dashboard's periodic auto-refresh can never double-count the same
 * draw or manufacture a phantom event.
 */
function evaluateFiveBallHarvester(historicalDraws, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const draws = historicalDraws || [];
  const latestDraw = draws[0] || null;

  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;
  if (drawId != null && memory.lastProcessedDrawId !== drawId) {
    const drawImmediatelyBefore = draws[1] || null;

    // Backfill FIRST, using this cycle's OWN "immediately before" draw --
    // i.e. what was the most recent draw one cycle ago, before this new
    // one arrived. This must happen before we log a brand-new event
    // below, or a fresh event would immediately (and wrongly) appear to
    // be its own following draw/window entry.
    backfillFollowingDraw(memory, latestDraw, drawImmediatelyBefore);
    backfillFollowingWindows(memory, latestDraw);

    memory.totalDrawsObserved++;

    if (latestDraw.fiveBallColor) {
      // precedingWindow: up to NEIGHBORHOOD_SIZE draws immediately
      // before this event, chronological (oldest-first) -- available in
      // full right now, no backfill needed, since that history already
      // exists in historicalDraws.
      const precedingWindow = draws.slice(1, 1 + NEIGHBORHOOD_SIZE).map(summarizeDraw).reverse();

      pushCapped(memory.eventLog, {
        drawId,
        timestamp: latestDraw.timestamp || null,
        eventColor: latestDraw.fiveBallColor,
        colorCounts: latestDraw.colorCounts ? { ...latestDraw.colorCounts } : null,
        precedingDraw: summarizeDraw(drawImmediatelyBefore),
        followingDraw: null, // unknown until backfilled on a future cycle, see above
        precedingWindow,
        followingWindow: [], // filled in progressively, one draw per cycle, see backfillFollowingWindows()
        position: memory.totalDrawsObserved,
        capturedAt: new Date().toISOString()
      });
    }

    memory.lastProcessedDrawId = drawId;
    memory.updatedAt = new Date().toISOString();
  }

  const perColorCounts = { RED: 0, BLUE: 0, GREEN: 0 };
  memory.eventLog.forEach(e => { if (perColorCounts[e.eventColor] !== undefined) perColorCounts[e.eventColor]++; });

  const pendingFollowUp = memory.eventLog.length > 0 && memory.eventLog[0].followingDraw === null;

  return {
    engine: '5-Ball Harvester',
    phase: 1,
    neighborhoodSize: NEIGHBORHOOD_SIZE,
    totalDrawsObserved: memory.totalDrawsObserved,
    totalEventsCaptured: memory.eventLog.length,
    perColorEventCounts: perColorCounts,
    mostRecentEvent: memory.eventLog[0] || null,
    pendingFollowUp, // true if the most recent event is still waiting on its following draw
    eventLog: memory.eventLog,
    reasoning: memory.eventLog.length === 0
      ? `No 5-ball events captured yet (${memory.totalDrawsObserved} draw(s) observed). Phase 1 (Harvest) only -- no statistics or predictions are computed here; see the Research Lab (Phase 2) for that.`
      : `${memory.eventLog.length} 5-ball event(s) captured across ${memory.totalDrawsObserved} observed draws (RED ${perColorCounts.RED} / BLUE ${perColorCounts.BLUE} / GREEN ${perColorCounts.GREEN}). Most recent: ${memory.eventLog[0].eventColor} at draw ${memory.eventLog[0].drawId}${pendingFollowUp ? ' (following draw not yet known)' : ''}. Phase 1 (Harvest) only -- no statistics or predictions are computed here.`
  };
}

module.exports = {
  MAX_LOG_ENTRIES,
  NEIGHBORHOOD_SIZE,
  freshHarvestMemory,
  ensureMemoryShape,
  summarizeDraw,
  evaluateFiveBallHarvester
};
