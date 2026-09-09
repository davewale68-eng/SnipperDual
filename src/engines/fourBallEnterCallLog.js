/**
 * 4SIL ENTER Call — 4-Ball Event Density Log.
 *
 * PURPOSE
 * -------
 * Every time 4SIL fires ENTER (badge.enterNow === true) this engine opens
 * a call record and watches real draw history for 4-ball events of ANY
 * color until the call closes. The final record captures:
 *
 *   openDrawId     — the draw ID when ENTER first fired for this call
 *   closeDrawId    — the draw ID when the call was closed
 *   closeReason    — why the call closed (EXPIRED | SEASON_INACTIVE |
 *                    ENTER_REOPENED)
 *   draws          — total draws elapsed inside the call window
 *   fourBallEvents — count of draws where fourBallColor was non-null
 *                    (color-agnostic: RED, BLUE, GREEN all count equally)
 *   eventDrawIds   — the exact draw IDs where a 4-ball event landed
 *
 * DESIGN RULES
 * ------------
 * 1. One open call at a time.  While a call is open, further cycles where
 *    ENTER is still live are treated as continuation, not a new call.
 *    A new call only opens after the previous one has been closed.
 *
 * 2. Close triggers:
 *      EXPIRED         — ENTER gate closes (badge.enterNow becomes false)
 *                        while the season is still active.
 *      SEASON_INACTIVE — the season itself goes inactive (4SIL.active
 *                        becomes false) regardless of gate state.
 *      ENTER_REOPENED  — internal guard only; should not occur under
 *                        normal operation (one-call-at-a-time rule above).
 *
 * 3. Resolution is draw-by-draw — identical to entryHitCounter.js's
 *    lastProcessedDrawId guard so each draw is counted exactly once
 *    regardless of how many council cycles run before the next ingest.
 *
 * 4. Persistent log — the call history cannot be recomputed from draw
 *    history alone because a draw record stores only its own fourBallColor,
 *    not "was 4SIL calling ENTER when this draw landed." The calling context
 *    only exists transiently in the live council cycle and must be logged as
 *    it happens. This follows exactly the same reasoning as entryHitCounter.js.
 *
 * 5. Color-agnostic — the log records WHICH color hit (for reference) but
 *    counts any non-null fourBallColor as an event. The trader's question
 *    is "how many 4-ball events occurred inside my ENTER window" not "did
 *    the right color win."
 *
 * 6. This engine is OBSERVATIONAL ONLY — it never votes, never feeds 4SIL,
 *    and never alters any gate threshold or weight.
 */
'use strict';

const MAX_LOG_ENTRIES = 500; // cap stored history

// ---------------------------------------------------------------------------
// Persistent state factory
// ---------------------------------------------------------------------------

/**
 * Returns a fresh (empty) state object. Used by store.js to initialise
 * the field and by persistence.js as the restoration default.
 */
function freshFourBallEnterCallLogState() {
  return {
    schemaVersion: 1,
    lastProcessedDrawId: null,
    openCall: null,        // current in-flight call, or null
    closedCalls: [],       // immutable historical records, newest first
    totalCalls: 0,
    updatedAt: null
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function openCall(drawId, timestamp) {
  return {
    callId: null,          // assigned from totalCalls at open time
    openDrawId: drawId,
    openAt: timestamp,
    closeDrawId: null,
    closeAt: null,
    closeReason: null,
    draws: 0,
    fourBallEvents: 0,
    eventDrawIds: []       // exact draw IDs where a 4-ball event landed
  };
}

function closeOpenCall(state, closeDrawId, closeReason, timestamp) {
  if (!state.openCall) return;
  state.openCall.closeDrawId = closeDrawId;
  state.openCall.closeAt = timestamp;
  state.openCall.closeReason = closeReason;
  state.closedCalls.unshift({ ...state.openCall });
  if (state.closedCalls.length > MAX_LOG_ENTRIES) {
    state.closedCalls.length = MAX_LOG_ENTRIES;
  }
  state.openCall = null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the log for the current council cycle. Must be called after
 * 4SIL has run for this cycle, with the same latest-draw semantics as
 * entryHitCounter.js (resolve first, then open new).
 *
 * @param {Array}  historicalDraws  newest-first draw history (from store)
 * @param {object} fourSIL          the 4SIL result for this cycle
 * @param {object} state            the persistent log state (mutated)
 * @returns {object}                read-only summary for the snapshot payload
 */
function advanceFourBallEnterCallLog(historicalDraws, fourSIL, state) {
  const now = new Date().toISOString();
  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null
    ? String(latestDraw.drawId)
    : null;

  const seasonActive = Boolean(fourSIL && fourSIL.active);
  const enterOpen    = Boolean(fourSIL && fourSIL.badge && fourSIL.badge.enterNow);

  // -------------------------------------------------------------------------
  // Step 1 — Advance the open call against the newly landed draw.
  // Dedup: process each draw exactly once regardless of council-cycle count.
  // -------------------------------------------------------------------------
  if (drawId != null && state.lastProcessedDrawId !== drawId && state.openCall) {
    state.openCall.draws++;

    const fourBallColor = latestDraw.fourBallColor || null;
    if (fourBallColor != null) {
      state.openCall.fourBallEvents++;
      state.openCall.eventDrawIds.push({
        drawId: latestDraw.drawId,
        color: fourBallColor
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — Close the open call if conditions have changed.
  // -------------------------------------------------------------------------
  if (state.openCall) {
    if (!seasonActive) {
      // Season went inactive — close regardless of gate state.
      closeOpenCall(state, drawId, 'SEASON_INACTIVE', now);
    } else if (!enterOpen) {
      // ENTER gate closed while season still active.
      closeOpenCall(state, drawId, 'EXPIRED', now);
    }
    // Otherwise: ENTER is still open and season still active → continue.
  }

  // -------------------------------------------------------------------------
  // Step 3 — Mark this draw processed AFTER advancing and closing.
  // (Mirrors entryHitCounter.js: resolve old watches before opening new.)
  // -------------------------------------------------------------------------
  if (drawId != null) {
    state.lastProcessedDrawId = drawId;
  }

  // -------------------------------------------------------------------------
  // Step 4 — Open a new call if ENTER just fired and no call is open.
  // -------------------------------------------------------------------------
  if (seasonActive && enterOpen && !state.openCall) {
    state.totalCalls++;
    const call = openCall(drawId, now);
    call.callId = state.totalCalls;
    state.openCall = call;
  }

  state.updatedAt = now;

  // -------------------------------------------------------------------------
  // Return — read-only summary for council snapshot and API endpoint.
  // -------------------------------------------------------------------------
  return buildSummary(state);
}

// ---------------------------------------------------------------------------
// Summary builder (also used by the read-only API route)
// ---------------------------------------------------------------------------

function buildSummary(state) {
  const closed = state.closedCalls;
  const totalFourBallEvents = closed.reduce((s, c) => s + c.fourBallEvents, 0);
  const totalDrawsWatched   = closed.reduce((s, c) => s + c.draws, 0);

  const avgEventsPerCall = closed.length > 0
    ? Math.round((totalFourBallEvents / closed.length) * 100) / 100
    : null;

  const avgDrawsPerCall = closed.length > 0
    ? Math.round((totalDrawsWatched / closed.length) * 100) / 100
    : null;

  // Density: 4-ball events per draw watched across all closed calls.
  const overallDensity = totalDrawsWatched > 0
    ? Math.round((totalFourBallEvents / totalDrawsWatched) * 1000) / 10  // pct
    : null;

  return {
    engine: 'FourBallEnterCallLog',
    totalCalls: state.totalCalls,
    closedCalls: closed.length,
    openCall: state.openCall
      ? {
          callId: state.openCall.callId,
          openDrawId: state.openCall.openDrawId,
          draws: state.openCall.draws,
          fourBallEvents: state.openCall.fourBallEvents,
          eventDrawIds: state.openCall.eventDrawIds
        }
      : null,
    aggregate: {
      totalFourBallEvents,
      totalDrawsWatched,
      avgEventsPerCall,
      avgDrawsPerCall,
      overallDensityPct: overallDensity
    },
    // Most recent 50 closed calls for the dashboard log table.
    log: closed.slice(0, 50)
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  freshFourBallEnterCallLogState,
  advanceFourBallEnterCallLog,
  buildSummary
};
