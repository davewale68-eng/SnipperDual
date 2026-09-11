/**
 * 5-BALL SEASON DETECTION ENGINE (Phase 2 extension of the 5-Ball
 * Research Lab)
 *
 * Implements the "5-ball seasons" concept the approved architecture
 * flagged as a natural extension of Dominance: "Measure whether one
 * color temporarily becomes disproportionately responsible for 5-ball
 * events. This can eventually reveal 5-ball seasons." fiveBallResearchLab.js
 * (Phase 2) already computes a live dominance READ (is one color >=50%
 * of the last 10 events, right now); this engine builds a proper STATE
 * MACHINE on top of that same signal -- tracking whether dominance is
 * building, holding, weakening, or handing off to a challenger, plus how
 * long it's been running.
 *
 * STATE NAMES reuse the exact vocabulary already established in this
 * codebase's own 3/4-ball color-season machinery (colorEngine.js's
 * SEASON_STATES: OBSERVING, BUILDING, ACTIVE, WEAKENING, TRANSITIONING,
 * ENDED) for consistency, even though the underlying signal here (event-
 * count windows, not draw-count windows -- 5-ball events are captured,
 * not every draw) is different enough that this is its own independent
 * state machine, not a shared one.
 *
 * TWO-WINDOW COMPARISON (how BUILDING/WEAKENING/TRANSITIONING are told
 * apart from a flat ACTIVE read): every color's share is computed over
 * BOTH the most recent DOMINANCE_WINDOW events (recentShare) and the
 * DOMINANCE_WINDOW events before that (priorShare) -- comparing the two
 * is what reveals direction (rising vs falling), not just level.
 *
 * SEASON AGE: for the currently-dominant color, this engine walks
 * backward through the causal event stream counting how many
 * CONSECUTIVE trailing events it has held a >=50% share over ITS OWN
 * preceding DOMINANCE_WINDOW at that moment -- i.e. "how many events ago
 * did this dominance first appear," computed causally (never using
 * information from after the point being checked), not just "how many
 * events total has this color ever produced."
 *
 * PURE RECOMPUTE, NO PERSISTENT STATE: fully re-derivable from
 * fiveBallHarvest.eventLog every cycle, same as Phase 2 itself.
 *
 * HONESTY NOTE: "season" here describes an observed RUN of one color's
 * disproportionate share of captured events -- it is a descriptive label
 * for a pattern in the data, not a claim that the underlying game
 * mechanism actually has "seasons" as a real phenomenon. Treat ENDED /
 * ACTIVE / etc. as what the numbers currently show, not a verified
 * causal state.
 */
'use strict';

const { chronologicalEvents, HIERARCHY, DOMINANCE_WINDOW, DOMINANCE_SHARE_THRESHOLD } = require('./fiveBallResearchLab');

const BUILDING_MIN_SHARE_PCT = 35; // a color approaching (but not yet at) dominance -- reusing the "building" concept from colorEngine.js's own season machinery

/**
 * Share of a given window of events belonging to `color`, as a
 * percentage. Returns null if the window is empty (nothing to measure).
 */
function shareOf(window, color) {
  if (!window || window.length === 0) return null;
  const count = window.filter(e => e.eventColor === color).length;
  return Math.round((count / window.length) * 1000) / 10;
}

/**
 * Causal "season age" for `color`: walking backward from the most recent
 * event, how many consecutive trailing events has this color held a
 * >=DOMINANCE_SHARE_THRESHOLD share over ITS OWN preceding
 * DOMINANCE_WINDOW at that point in time. Stops at the first event where
 * that wasn't true (or when history runs out).
 */
function computeSeasonAge(chronoEvents, color) {
  let age = 0;
  for (let i = chronoEvents.length - 1; i >= DOMINANCE_WINDOW; i--) {
    const window = chronoEvents.slice(i - DOMINANCE_WINDOW, i);
    const share = shareOf(window, color);
    if (share == null || share < DOMINANCE_SHARE_THRESHOLD) break;
    age++;
  }
  return age;
}

/**
 * Classifies a single color's state from its recent/prior share pair.
 */
function classifyState(recentShare, priorShare) {
  if (recentShare == null) return 'OBSERVING';

  if (recentShare >= DOMINANCE_SHARE_THRESHOLD) {
    if (priorShare == null || recentShare >= priorShare) return 'ACTIVE';
    return 'WEAKENING';
  }
  if (recentShare >= BUILDING_MIN_SHARE_PCT) {
    if (priorShare != null && recentShare > priorShare) return 'BUILDING';
    return 'OBSERVING';
  }
  if (priorShare != null && priorShare >= DOMINANCE_SHARE_THRESHOLD) return 'ENDED'; // was dominant last window, isn't anymore
  return 'OBSERVING';
}

/**
 * Main entry point, called once per council cycle. fiveBallHarvest is
 * Phase 1's own full result (read-only).
 */
function evaluateFiveBallSeasonDetection(fiveBallHarvest) {
  const eventLog = (fiveBallHarvest && fiveBallHarvest.eventLog) || [];
  const chronoEvents = chronologicalEvents(eventLog);

  if (chronoEvents.length < DOMINANCE_WINDOW * 2) {
    return {
      engine: '5-Ball Season Detection Engine',
      ready: false,
      reasoning: `Need at least ${DOMINANCE_WINDOW * 2} captured events to compare a recent window against a prior one (have ${chronoEvents.length}).`
    };
  }

  const recentWindow = chronoEvents.slice(-DOMINANCE_WINDOW);
  const priorWindow = chronoEvents.slice(-DOMINANCE_WINDOW * 2, -DOMINANCE_WINDOW);

  const byColor = {};
  HIERARCHY.forEach(color => {
    const recentShare = shareOf(recentWindow, color);
    const priorShare = shareOf(priorWindow, color);
    const state = classifyState(recentShare, priorShare);
    byColor[color] = {
      state,
      recentSharePct: recentShare,
      priorSharePct: priorShare,
      seasonAgeEvents: (state === 'ACTIVE' || state === 'WEAKENING') ? computeSeasonAge(chronoEvents, color) : 0
    };
  });

  const activeColor = HIERARCHY.find(c => byColor[c].state === 'ACTIVE' || byColor[c].state === 'WEAKENING') || null;
  const challengerColor = HIERARCHY
    .filter(c => c !== activeColor && byColor[c].state === 'BUILDING')
    .sort((a, b) => (byColor[b].recentSharePct || 0) - (byColor[a].recentSharePct || 0))[0] || null;

  const overallState = activeColor
    ? (challengerColor ? 'TRANSITIONING' : byColor[activeColor].state)
    : (HIERARCHY.some(c => byColor[c].state === 'BUILDING') ? 'BUILDING' : 'OBSERVING');

  const reasoning = activeColor
    ? `${activeColor} season: ${byColor[activeColor].state} (${byColor[activeColor].recentSharePct}% of last ${DOMINANCE_WINDOW} events, running ${byColor[activeColor].seasonAgeEvents} event(s)).`
      + (challengerColor ? ` ${challengerColor} is BUILDING (${byColor[challengerColor].recentSharePct}%) -- overall read: TRANSITIONING.` : '')
    : 'No color currently holds a dominant season; ' + (overallState === 'BUILDING' ? 'one or more colors are building toward it.' : 'market looks evenly distributed.');

  return {
    engine: '5-Ball Season Detection Engine',
    ready: true,
    dominanceWindow: DOMINANCE_WINDOW,
    overallState,
    activeColor,
    challengerColor,
    byColor,
    reasoning
  };
}

module.exports = {
  BUILDING_MIN_SHARE_PCT,
  shareOf,
  computeSeasonAge,
  classifyState,
  evaluateFiveBallSeasonDetection
};
