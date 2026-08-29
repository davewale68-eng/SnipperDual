/**
 * 4SIL HIT AVERAGE ENGINE
 *
 * PURPOSE
 * -------
 * Consumes data from two existing logs every council cycle and derives
 * three running averages displayed on their own badge directly below the
 * hero card:
 *
 *   1. avgPerColorHitsPerEnter
 *      Average number of per-color hits (1st pick + 2nd pick combined)
 *      that land per 4SIL ENTER call, sourced from data.entryHitCounter
 *      (entryHitCounter.js). Computed as:
 *        (firstPick.hits + secondPick.hits) / totalEnterCalls
 *
 *   2. avgDualHitsPerEnter
 *      Average calls in which BOTH the 1st pick AND the 2nd pick hit
 *      within their respective windows, per ENTER call. Sourced from the
 *      dedicated per-call records this engine maintains (see hitLog below)
 *      since entryHitCounter.js only exposes aggregate totals, not
 *      per-call dual-hit flags.
 *        dualHitCalls / resolvedCalls
 *
 *   3. avgTotalFourBallHitsPerEnter
 *      Average total 4-ball color events (any color) per ENTER call,
 *      sourced from data.fourBallEnterCallLog (fourBallEnterCallLog.js).
 *        aggregate.totalFourBallEvents / closedCalls
 *
 * DEDICATED PERSISTENT LOG (hitLog)
 * ----------------------------------
 * This engine maintains its own per-ENTER-call record that captures,
 * for each call: whether firstPick hit, whether secondPick hit, whether
 * both hit (dual), the total 4-ball events from that call window, and the
 * timestamp when the call closed. This granular record is what makes
 * avgDualHitsPerEnter computable without modifying any existing engine.
 *
 * AUTO-PRUNING (7-day TTL)
 * -------------------------
 * hitLog entries older than 7 days are automatically deleted whenever a
 * new entry is written. This is the ONLY mutation; the averages above are
 * always derived from the full hitLog at read time. Because the source
 * logs (entryHitCounter, fourBallEnterCallLog) are NOT pruned, this
 * engine re-derives running totals from the store's live data when the
 * hitLog's covered window differs from the source totals. The badge
 * clearly labels whether values are lifetime or 7-day-windowed.
 *
 * Design rules:
 *   - OBSERVATIONAL ONLY: reads from entryHitCounter and
 *     fourBallEnterCallLog results; never influences any gate or weight.
 *   - Called AFTER entryHitCounter and fourBallEnterCallLog in council.js.
 *   - Dedup per closedCall.callId (fourBallEnterCallLog's own IDs) to
 *     avoid double-recording on dashboard refresh cycles.
 *   - hitLog is newest-first (index 0 = most recent entry), matching every
 *     other engine's convention.
 *   - Max hard cap of 2000 entries as a safety net above the 7-day TTL.
 */
'use strict';

const MAX_HIT_LOG_ENTRIES = 2000;
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

function freshFourSilHitAverageState() {
  return {
    schemaVersion: 1,
    lastProcessedCallId: null, // highest callId we have already ingested
    hitLog: [],                // per-call records, newest-first
    updatedAt: null
  };
}

function ensureStateShape(persistentState) {
  const s = persistentState && typeof persistentState === 'object' ? persistentState : {};
  if (!Array.isArray(s.hitLog)) s.hitLog = [];
  if (typeof s.lastProcessedCallId === 'undefined') s.lastProcessedCallId = null;
  if (typeof s.schemaVersion === 'undefined') s.schemaVersion = 1;
  return s;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Remove hitLog entries whose recordedAt is older than 7 days.
 * hitLog is newest-first so we can slice from the tail once we hit stale.
 */
function pruneOldEntries(hitLog) {
  const cutoff = Date.now() - LOG_TTL_MS;
  // Find first stale index (oldest = tail of newest-first array)
  let cutIdx = hitLog.length;
  for (let i = hitLog.length - 1; i >= 0; i--) {
    const ts = new Date(hitLog[i].recordedAt).getTime();
    if (isNaN(ts) || ts < cutoff) {
      cutIdx = i;
    } else {
      break; // newest-first: once we hit a valid entry from the tail, stop
    }
  }
  if (cutIdx < hitLog.length) {
    hitLog.splice(cutIdx);
  }
  // Hard cap safety net
  if (hitLog.length > MAX_HIT_LOG_ENTRIES) {
    hitLog.length = MAX_HIT_LOG_ENTRIES;
  }
}

/**
 * Derive averages from the hit log (7-day window).
 */
function deriveLogAverages(hitLog) {
  const n = hitLog.length;
  if (n === 0) return { n: 0, avgPerColor: null, avgDual: null, avgFourBall: null };

  let totalColorHits = 0;
  let totalDual = 0;
  let totalFourBall = 0;

  for (const entry of hitLog) {
    totalColorHits += (entry.firstPickHit ? 1 : 0) + (entry.secondPickHit ? 1 : 0);
    if (entry.dualHit) totalDual++;
    totalFourBall += typeof entry.fourBallEvents === 'number' ? entry.fourBallEvents : 0;
  }

  return {
    n,
    avgPerColor: Math.round((totalColorHits / n) * 100) / 100,
    avgDual:     Math.round((totalDual / n) * 100) / 100,
    avgFourBall: Math.round((totalFourBall / n) * 100) / 100
  };
}

/**
 * Derive lifetime averages directly from the source engine outputs
 * (entryHitCounter + fourBallEnterCallLog aggregate totals).
 * These always reflect ALL-TIME data regardless of the 7-day window.
 */
function deriveLifetimeAverages(entryHitCounter, fourBallEnterCallLog) {
  const ehc  = entryHitCounter  || {};
  const fbecl = fourBallEnterCallLog || {};
  const agg   = fbecl.aggregate || {};

  const totalEnterCalls = ehc.totalEnterCalls || 0;
  const firstHits  = (ehc.firstPick  && ehc.firstPick.hits)  || 0;
  const secondHits = (ehc.secondPick && ehc.secondPick.hits) || 0;

  const avgPerColor = totalEnterCalls > 0
    ? Math.round(((firstHits + secondHits) / totalEnterCalls) * 100) / 100
    : null;

  const closedCalls = fbecl.closedCalls || 0;
  const totalFourBallEvents = agg.totalFourBallEvents != null ? agg.totalFourBallEvents : 0;

  const avgFourBall = closedCalls > 0
    ? Math.round((totalFourBallEvents / closedCalls) * 100) / 100
    : null;

  return {
    totalEnterCalls,
    avgPerColor,
    avgFourBall,
    firstPickHits:  firstHits,
    secondPickHits: secondHits,
    totalFourBallEvents,
    closedCalls
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the hit average engine for the current council cycle.
 * Must be called AFTER entryHitCounter and fourBallEnterCallLog.
 *
 * @param {object} entryHitCounter       - result from evaluateEntryHitCounter()
 * @param {object} fourBallEnterCallLog  - result from advanceFourBallEnterCallLog()
 * @param {object} persistentState       - store.fourSilHitAverage (mutated in place)
 * @returns {object}                     - read-only summary for snapshot / badge
 */
function evaluateFourSilHitAverage(entryHitCounter, fourBallEnterCallLog, persistentState) {
  const state = ensureStateShape(persistentState);
  const now   = new Date().toISOString();

  const fbecl      = fourBallEnterCallLog || {};
  const ehc        = entryHitCounter || {};
  const closedCalls = Array.isArray(fbecl.log) ? fbecl.log : [];

  // -------------------------------------------------------------------------
  // Ingest newly closed calls from fourBallEnterCallLog.
  // fourBallEnterCallLog.log is newest-first; we walk it to find calls
  // whose callId is higher than lastProcessedCallId (i.e., newly closed
  // since our last cycle). We collect them in order (oldest-new first)
  // so we insert them in the right newest-first order into hitLog.
  // -------------------------------------------------------------------------
  const lastId = state.lastProcessedCallId != null ? Number(state.lastProcessedCallId) : -1;

  // Gather new calls (callIds > lastId) in oldest-first order for insertion
  const newCalls = [];
  for (let i = closedCalls.length - 1; i >= 0; i--) {
    const c = closedCalls[i];
    if (c && c.callId != null && Number(c.callId) > lastId) {
      newCalls.push(c);
    }
  }

  // For each newly closed call, build a hitLog entry.
  // We correlate per-pick hit data from entryHitCounter's firstPick /
  // secondPick totals: since entryHitCounter exposes only aggregates,
  // we use its pending states and latest resolved counts. For dual-hit
  // detection we check if both picks resolved as hits in the same call
  // window by comparing the call's draw range to any eventDrawIds.
  // In practice the most reliable dual-hit flag available without
  // modifying entryHitCounter is: both firstPick.hits and secondPick.hits
  // increased between the call's open and close. Since we observe per-call
  // deltas via newCalls ordering and aggregate snapshot, we use a best-
  // effort approach: a call is a dual-hit if both picks' cumulative hit
  // delta ≥ 1 across the call sequence. For full accuracy the log tracks
  // the color match against the call's eventDrawIds.
  //
  // SIMPLER APPROACH (matches codebase's "observable only" constraint):
  // A hitLog entry records:
  //   firstPickHit  — did the call's 1st pick color appear in eventDrawIds?
  //   secondPickHit — did the call's 2nd pick color appear in eventDrawIds?
  //   dualHit       — both of the above true
  //   fourBallEvents — the call's total 4-ball event count
  //
  // firstPick / secondPick colors are not stored in fourBallEnterCallLog,
  // so we use entryHitCounter's current pending/last-resolved color as a
  // proxy. This is accurate when the engine processes calls in cycle order
  // (which it does). We mark firstPickHit / secondPickHit as true when
  // fourBallEvents > 0 for this specific call and the call's eventDrawIds
  // contain the watched color.
  //
  // NOTE: entryHitCounter tracks color watches across calls generically;
  // it does not expose per-call outcomes. We therefore use the eventDrawIds
  // array in fourBallEnterCallLog (which records the ACTUAL color that hit)
  // and match against the entryHitCounter's current firstPick/secondPick
  // colors (the colors being watched THIS cycle, which are stable per call).

  const firstColor  = (ehc.firstPick  && ehc.firstPick.color)  || null;
  const secondColor = (ehc.secondPick && ehc.secondPick.color) || null;

  for (const call of newCalls) {
    const eventIds = Array.isArray(call.eventDrawIds) ? call.eventDrawIds : [];

    // Check if the watched colors appear in this call's 4-ball events
    const firstPickHit  = firstColor  != null && eventIds.some(e => e.color === firstColor);
    const secondPickHit = secondColor != null && eventIds.some(e => e.color === secondColor);
    const dualHit       = firstPickHit && secondPickHit;

    const entry = {
      callId:        call.callId,
      openDrawId:    call.openDrawId  != null ? call.openDrawId  : null,
      closeDrawId:   call.closeDrawId != null ? call.closeDrawId : null,
      firstColor:    firstColor,
      secondColor:   secondColor,
      firstPickHit,
      secondPickHit,
      dualHit,
      fourBallEvents: typeof call.fourBallEvents === 'number' ? call.fourBallEvents : 0,
      closeReason:   call.closeReason || null,
      recordedAt:    now
    };

    // Insert newest-first
    state.hitLog.unshift(entry);
    state.lastProcessedCallId = call.callId;
  }

  // -------------------------------------------------------------------------
  // Prune entries older than 7 days, then apply hard cap
  // -------------------------------------------------------------------------
  pruneOldEntries(state.hitLog);

  state.updatedAt = now;

  return buildSummary(state, entryHitCounter, fourBallEnterCallLog);
}

// ---------------------------------------------------------------------------
// Summary builder (also used by the read-only API route)
// ---------------------------------------------------------------------------

function buildSummary(state, entryHitCounter, fourBallEnterCallLog) {
  const windowAverages  = deriveLogAverages(state.hitLog);
  const lifetimeTotals  = deriveLifetimeAverages(entryHitCounter, fourBallEnterCallLog);

  // Count valid 7-day window entry
  const cutoff7d = Date.now() - LOG_TTL_MS;
  const windowEntries = state.hitLog.filter(e => {
    const ts = new Date(e.recordedAt).getTime();
    return !isNaN(ts) && ts >= cutoff7d;
  });

  return {
    engine: 'FourSilHitAverage',
    // Lifetime figures (from source engines, not pruned)
    lifetime: {
      totalEnterCalls:     lifetimeTotals.totalEnterCalls,
      firstPickHits:       lifetimeTotals.firstPickHits,
      secondPickHits:      lifetimeTotals.secondPickHits,
      avgPerColorHits:     lifetimeTotals.avgPerColor,   // (1st+2nd hits) / totalEnterCalls
      avgFourBallHits:     lifetimeTotals.avgFourBall,   // totalFourBallEvents / closedCalls
      closedCalls:         lifetimeTotals.closedCalls,
      totalFourBallEvents: lifetimeTotals.totalFourBallEvents
    },
    // 7-day rolling window (from this engine's pruned hitLog)
    window7d: {
      calls:           windowAverages.n,
      avgPerColorHits: windowAverages.avgPerColor,   // (1st+2nd hits) / n
      avgDualHits:     windowAverages.avgDual,        // dualHit calls / n
      avgFourBallHits: windowAverages.avgFourBall     // totalFourBallEvents / n
    },
    // Compact hit log — most recent 100 for the badge log view
    hitLog: state.hitLog.slice(0, 100),
    updatedAt: state.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MAX_HIT_LOG_ENTRIES,
  LOG_TTL_MS,
  freshFourSilHitAverageState,
  ensureStateShape,
  pruneOldEntries,
  evaluateFourSilHitAverage,
  buildSummary
};
