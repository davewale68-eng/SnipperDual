/**
 * 4SIL HIT AVERAGE ENGINE
 *
 * PURPOSE
 * -------
 * Consumes data from entryHitCounter.js every council cycle and derives
 * one running average displayed on its own badge directly below the
 * hero card:
 *
 *   avgPerColorHitsPerEnter
 *      Average number of per-color hits (1st pick + 2nd pick combined)
 *      that land per 4SIL ENTER call, sourced from data.entryHitCounter
 *      (entryHitCounter.js). Computed as:
 *        (firstPick.hits + secondPick.hits) / totalEnterCalls
 *
 * REMOVED STATS (operator direction)
 * -----------------------------------
 * This engine used to also derive avgDualHitsPerEnter (both 1st AND 2nd
 * pick hitting within the same ENTER call) and avgTotalFourBallHitsPerEnter
 * (total 4-ball color events of any color per ENTER call), plus a
 * per-call hitLog with a 7-day auto-pruning TTL. Both of those stats --
 * and the hitLog that backed them -- were sourced from
 * fourBallEnterCallLog.js's per-call event-density records. That engine
 * was removed per operator direction (along with the 4SIL Paper Trader
 * and 4SIL Next Event Intelligence engines that also consumed it), so
 * there is no longer any source for a per-call dual-hit flag or a
 * per-call 4-ball-event count. Rather than leave those two stats
 * permanently null/blank on the badge, they -- and the hitLog/7-day-TTL
 * machinery that only existed to compute them -- have been removed
 * entirely. This engine is now a thin, stateless pass-through over
 * entryHitCounter's own lifetime totals; it keeps NO persistent state of
 * its own.
 *
 * Design rules (unchanged):
 *   - OBSERVATIONAL ONLY: reads from entryHitCounter's result; never
 *     influences any gate or weight.
 *   - Called AFTER entryHitCounter in council.js.
 */
'use strict';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the hit average engine for the current council cycle.
 * Must be called AFTER entryHitCounter.
 *
 * @param {object} entryHitCounter - result from evaluateEntryHitCounter()
 * @returns {object}               - read-only summary for snapshot / badge
 */
function evaluateFourSilHitAverage(entryHitCounter) {
  const ehc = entryHitCounter || {};

  const totalEnterCalls = ehc.totalEnterCalls || 0;
  const firstHits  = (ehc.firstPick  && ehc.firstPick.hits)  || 0;
  const secondHits = (ehc.secondPick && ehc.secondPick.hits) || 0;

  const avgPerColorHits = totalEnterCalls > 0
    ? Math.round(((firstHits + secondHits) / totalEnterCalls) * 100) / 100
    : null;

  return {
    engine: 'FourSilHitAverage',
    lifetime: {
      totalEnterCalls,
      firstPickHits:   firstHits,
      secondPickHits:  secondHits,
      avgPerColorHits  // (1st+2nd hits) / totalEnterCalls
    },
    updatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  evaluateFourSilHitAverage
};
