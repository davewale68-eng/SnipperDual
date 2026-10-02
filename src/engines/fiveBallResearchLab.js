/**
 * 5-BALL RESEARCH LAB (Phase 2 of the 5-Ball Research Lab)
 *
 * PHASE 2 ONLY. Per the approved architecture: Harvest -> Research ->
 * Learning -> Validation -> Shadow Prediction -> Live Prediction. This
 * file consumes Phase 1's (fiveBallHarvester.js) captured event log and
 * computes descriptive STATISTICS about it: frequency, gaps,
 * consecutive-event behavior, color rotation, dominance, suppression,
 * and recovery. It makes NO predictions and discovers NO "patterns" with
 * confidence/decay scoring -- that is explicitly Phase 3's job (the
 * Learning Engine's pattern discovery layer, not built yet). Everything
 * here is a plain, auditable statistic computed directly from observed
 * history -- see this phase's own "Separate observation from
 * intelligence" principle: RAW DATA -> OBSERVATIONS -> DISCOVERED
 * PATTERNS. This file only ever produces OBSERVATIONS, the middle layer.
 *
 * PURE RECOMPUTE, NO PERSISTENT STATE (unlike Phase 1): every statistic
 * here is fully re-derivable from fiveBallHarvester.js's own already-
 * persisted eventLog on every call -- there is no additional "calling
 * context" that only exists transiently and needs its own logging.
 * Follows the same no-persistence precedent as tiePrecursorPatternEngine.js
 * and threeBallEventBadge.js.
 *
 * A HONEST LIMITATION, stated up front rather than buried: the
 * suppression/recovery analysis below (computeSuppressionAndRecovery)
 * measures each color's "long drought" threshold using that color's OWN
 * full-history gap percentile, including gaps that happened AFTER the
 * drought being evaluated. That is mild lookahead bias -- a fully
 * causal-safe version would recompute each color's percentile using only
 * gaps known UP TO that point in time. Given how few 5-ball events exist
 * in any real history, splitting the sample further to avoid this would
 * leave too little data to say anything at all. This is called out
 * explicitly in the returned reasoning text and should be revisited once
 * more history accumulates -- it is exactly the kind of thing Phase 4
 * (Validation) exists to eventually test properly out-of-sample.
 *
 * Input is fiveBallHarvest, the FULL evaluateFiveBallHarvester() result
 * (Phase 1's own output) -- this file reads its eventLog/
 * totalDrawsObserved/perColorEventCounts fields only, never touches
 * historicalDraws directly, and never writes back into the Harvester's
 * memory.
 */
'use strict';

const { mean, stddev, median, mode, percentile } = require('../core/statMath');

const HIERARCHY = ['RED', 'BLUE', 'GREEN'];
const MIN_GAP_SAMPLE = 3; // fewer gaps than this and a percentile/stddev read is too thin to report -- matches the bar used elsewhere in this codebase (e.g. fourBallTieBirthEngine.js's own MIN_GAP_SAMPLE)
const MIN_EVENTS_FOR_ROTATION = 2; // need at least 2 events to have even one transition
const DOMINANCE_WINDOW = 10; // most recent N captured events examined for "is one color currently overrepresented"
const DOMINANCE_SHARE_THRESHOLD = 50; // % share of the dominance window a color needs to count as "dominant" right now
const SUPPRESSION_PERCENTILE = 75; // a color's current drought must exceed its OWN p75 historical gap to count as "suppressed"

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * fiveBallHarvest.eventLog is most-recent-first (matches every other
 * engine's log convention) -- this returns the same events in
 * chronological (oldest-first) order, which every stat below actually
 * needs to walk forward through time correctly.
 */
function chronologicalEvents(eventLog) {
  return (eventLog || []).slice().reverse();
}

/**
 * Section "Frequency" -- per color, how often 5-ball events happen,
 * expressed several ways. "Average events per session" from the
 * approved spec is deliberately NOT computed: this draw stream has no
 * concept of a "session" boundary anywhere in the data (no start/end
 * markers), so fabricating session buckets would mean inventing a
 * concept the raw data doesn't actually contain -- exactly what the
 * "don't allow the engine to modify raw historical data" principle
 * warns against, one level up (inventing structure, not just values).
 */
function computeFrequency(perColorEventCounts, totalDrawsObserved) {
  const totalEvents = HIERARCHY.reduce((s, c) => s + (perColorEventCounts[c] || 0), 0);
  const result = {};
  HIERARCHY.forEach(color => {
    const n = perColorEventCounts[color] || 0;
    result[color] = {
      totalEvents: n,
      pctOfAllEvents: totalEvents > 0 ? round1((n / totalEvents) * 100) : null,
      eventsPer100Draws: totalDrawsObserved > 0 ? round1((n / totalDrawsObserved) * 100) : null,
      eventsPer500Draws: totalDrawsObserved > 0 ? round1((n / totalDrawsObserved) * 500) : null,
      eventsPer1000Draws: totalDrawsObserved > 0 ? round1((n / totalDrawsObserved) * 1000) : null
    };
  });
  return { totalEvents, byColor: result };
}

/**
 * Section "Gap Analysis" -- per color, the distribution of draws-between-
 * events. gaps[] are consecutive differences between that color's own
 * chronological event positions (position = fiveBallHarvester.js's
 * running "draws observed so far" counter at capture time, so a gap here
 * is genuinely "draws elapsed," not just log-index distance).
 */
function computeGapStats(chronoEvents, color, totalDrawsObserved) {
  const positions = chronoEvents.filter(e => e.eventColor === color).map(e => e.position);
  const gaps = [];
  for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);

  const currentGap = positions.length > 0 ? totalDrawsObserved - positions[positions.length - 1] : null;

  if (gaps.length < MIN_GAP_SAMPLE) {
    return {
      eventSampleSize: positions.length,
      gapSampleSize: gaps.length,
      currentGap,
      averageGap: null, medianGap: null, minGap: null, maxGap: null,
      stdDevGap: null, mostCommonGap: null, percentiles: null, gapDistribution: null,
      note: `Fewer than ${MIN_GAP_SAMPLE} gaps observed -- too thin to report distribution statistics yet.`
    };
  }

  return {
    eventSampleSize: positions.length,
    gapSampleSize: gaps.length,
    currentGap,
    averageGap: round1(mean(gaps)),
    medianGap: median(gaps),
    minGap: Math.min(...gaps),
    maxGap: Math.max(...gaps),
    stdDevGap: round1(stddev(gaps)),
    mostCommonGap: mode(gaps),
    percentiles: {
      p25: round1(percentile(gaps, 25)),
      p50: round1(percentile(gaps, 50)),
      p75: round1(percentile(gaps, 75)),
      p90: round1(percentile(gaps, 90))
    },
    gapDistribution: buildGapHistogram(gaps)
  };
}

/**
 * Simple fixed-width histogram of gap lengths, for a quick shape-of-
 * distribution read on the dashboard without shipping the raw gap array.
 * Buckets: 1-5, 6-10, 11-20, 21-35, 36-60, 61+.
 */
function buildGapHistogram(gaps) {
  const buckets = { '1-5': 0, '6-10': 0, '11-20': 0, '21-35': 0, '36-60': 0, '61+': 0 };
  gaps.forEach(g => {
    if (g <= 5) buckets['1-5']++;
    else if (g <= 10) buckets['6-10']++;
    else if (g <= 20) buckets['11-20']++;
    else if (g <= 35) buckets['21-35']++;
    else if (g <= 60) buckets['36-60']++;
    else buckets['61+']++;
  });
  return buckets;
}

/**
 * Section "Consecutive events" -- how often the SAME color repeats as
 * the very next event in the overall (any-color) chronological stream,
 * per color and overall.
 */
function computeConsecutiveRepeats(chronoEvents) {
  const perColor = {};
  HIERARCHY.forEach(c => { perColor[c] = { opportunities: 0, repeats: 0 }; });
  let totalOpportunities = 0;
  let totalRepeats = 0;

  for (let i = 1; i < chronoEvents.length; i++) {
    const prevColor = chronoEvents[i - 1].eventColor;
    if (!perColor[prevColor]) continue;
    perColor[prevColor].opportunities++;
    totalOpportunities++;
    if (chronoEvents[i].eventColor === prevColor) {
      perColor[prevColor].repeats++;
      totalRepeats++;
    }
  }

  const byColor = {};
  HIERARCHY.forEach(c => {
    const { opportunities, repeats } = perColor[c];
    byColor[c] = {
      opportunities,
      repeats,
      repeatRatePct: opportunities > 0 ? round1((repeats / opportunities) * 100) : null
    };
  });

  return {
    overallRepeatRatePct: totalOpportunities > 0 ? round1((totalRepeats / totalOpportunities) * 100) : null,
    totalOpportunities,
    byColor
  };
}

/**
 * Section "Color rotation" -- a simple first-order transition matrix:
 * given the current event's color, what color has the NEXT event
 * historically been, and with what probability.
 */
function computeColorRotation(chronoEvents) {
  if (chronoEvents.length < MIN_EVENTS_FOR_ROTATION) {
    return { ready: false, matrix: null, note: `Need at least ${MIN_EVENTS_FOR_ROTATION} events to observe a single transition (have ${chronoEvents.length}).` };
  }

  const counts = {};
  HIERARCHY.forEach(from => {
    counts[from] = {};
    HIERARCHY.forEach(to => { counts[from][to] = 0; });
  });

  for (let i = 1; i < chronoEvents.length; i++) {
    const from = chronoEvents[i - 1].eventColor;
    const to = chronoEvents[i].eventColor;
    if (counts[from] && counts[from][to] !== undefined) counts[from][to]++;
  }

  const matrix = {};
  HIERARCHY.forEach(from => {
    const rowTotal = HIERARCHY.reduce((s, to) => s + counts[from][to], 0);
    matrix[from] = { sampleSize: rowTotal, probabilities: {} };
    HIERARCHY.forEach(to => {
      matrix[from].probabilities[to] = rowTotal > 0 ? round1((counts[from][to] / rowTotal) * 100) : null;
    });
  });

  return { ready: true, matrix };
}

/**
 * Section "Dominance" -- within the most recent DOMINANCE_WINDOW captured
 * events, is one color currently producing a disproportionate share.
 * Purely descriptive (a live snapshot), NOT a season-detection state
 * machine -- the approved spec notes this "can eventually reveal 5-ball
 * seasons," which is deliberately left as future work (likely Phase 3),
 * not built here.
 */
function computeDominance(chronoEvents) {
  const window = chronoEvents.slice(-DOMINANCE_WINDOW);
  if (window.length === 0) {
    return { ready: false, windowSize: 0, shareByColor: null, dominantColor: null, note: 'No events observed yet.' };
  }

  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  window.forEach(e => { if (counts[e.eventColor] !== undefined) counts[e.eventColor]++; });

  const shareByColor = {};
  HIERARCHY.forEach(c => { shareByColor[c] = round1((counts[c] / window.length) * 100); });

  const dominantColor = HIERARCHY.reduce((best, c) => (shareByColor[c] > (shareByColor[best] || -1) ? c : best), null);
  const isDominant = shareByColor[dominantColor] >= DOMINANCE_SHARE_THRESHOLD;

  return {
    ready: true,
    windowSize: window.length,
    shareByColor,
    dominantColor: isDominant ? dominantColor : null,
    note: isDominant
      ? `${dominantColor} produced ${shareByColor[dominantColor]}% of the last ${window.length} captured events.`
      : `No color currently exceeds the ${DOMINANCE_SHARE_THRESHOLD}% dominance threshold over the last ${window.length} captured events.`
  };
}

/**
 * Sections "Suppression" and "Recovery" -- computed together in one pass
 * since Recovery is defined in terms of Suppression's own resolutions
 * (see this file's header for the stated lookahead-bias caveat on the
 * percentile thresholds used here).
 *
 * At each event in the chronological stream (from the 2nd event onward),
 * determine which color (if any) was most "suppressed" going into it --
 * the color with the largest current drought AT THAT MOMENT, but only if
 * that drought exceeds SUPPRESSION_PERCENTILE of that color's own
 * (full-history) gap distribution. Then classify this event as:
 *   - suppressedColorRecurred: the event's color WAS the suppressed one
 *     (the drought resolved with its own color reappearing)
 *   - differentColorInstead: a suppressed color existed, but a DIFFERENT
 *     color produced this event instead
 *   - noSuppressionInPlay: no color's drought exceeded its own threshold
 *     at this moment
 * Recovery then looks specifically at the "suppressedColorRecurred" cases
 * and asks: what did the NEXT event's color turn out to be (repeat, or a
 * different color)?
 */
function computeSuppressionAndRecovery(chronoEvents, gapStatsByColor) {
  const suppressionThresholdByColor = {};
  HIERARCHY.forEach(c => {
    const p75 = gapStatsByColor[c] && gapStatsByColor[c].percentiles ? gapStatsByColor[c].percentiles.p75 : null;
    suppressionThresholdByColor[c] = p75;
  });

  const lastPositionByColor = {};
  let suppressedRecurredCount = 0;
  let differentColorInsteadCount = 0;
  let noSuppressionCount = 0;
  const recoveryFollowUps = []; // color of the event immediately following a suppressedColorRecurred resolution

  for (let i = 0; i < chronoEvents.length; i++) {
    const event = chronoEvents[i];

    // Determine the most-suppressed color AS OF just before this event
    // (using only what's already been observed in lastPositionByColor).
    let mostSuppressedColor = null;
    let mostSuppressedDrought = -1;
    HIERARCHY.forEach(c => {
      const threshold = suppressionThresholdByColor[c];
      if (threshold == null) return; // insufficient sample for this color -- can't say it's "suppressed" by a threshold that doesn't exist yet
      const lastPos = lastPositionByColor[c];
      if (lastPos == null) return; // color hasn't appeared yet at all -- no drought to measure
      const drought = event.position - lastPos;
      if (drought > threshold && drought > mostSuppressedDrought) {
        mostSuppressedDrought = drought;
        mostSuppressedColor = c;
      }
    });

    if (mostSuppressedColor == null) {
      noSuppressionCount++;
    } else if (event.eventColor === mostSuppressedColor) {
      suppressedRecurredCount++;
      const next = chronoEvents[i + 1];
      if (next) recoveryFollowUps.push(next.eventColor === event.eventColor ? 'REPEAT' : 'DIFFERENT_COLOR');
    } else {
      differentColorInsteadCount++;
    }

    lastPositionByColor[event.eventColor] = event.position;
  }

  const suppressionEligible = suppressedRecurredCount + differentColorInsteadCount;
  const recoveryRepeats = recoveryFollowUps.filter(r => r === 'REPEAT').length;

  return {
    suppression: {
      sampleSize: suppressionEligible,
      suppressedColorRecurredCount: suppressedRecurredCount,
      differentColorInsteadCount: differentColorInsteadCount,
      noSuppressionCount,
      suppressedColorRecurredRatePct: suppressionEligible > 0 ? round1((suppressedRecurredCount / suppressionEligible) * 100) : null,
      note: suppressionEligible > 0
        ? `Of ${suppressionEligible} moment(s) where one color was running an unusually long drought (beyond its own historical ${SUPPRESSION_PERCENTILE}th percentile gap), that color's own event followed ${suppressedRecurredCount} time(s) and a different color's event happened instead ${differentColorInsteadCount} time(s).`
        : 'Not enough per-color gap history yet to evaluate suppression.'
    },
    recovery: {
      sampleSize: recoveryFollowUps.length,
      repeatCount: recoveryRepeats,
      differentColorCount: recoveryFollowUps.length - recoveryRepeats,
      repeatRatePct: recoveryFollowUps.length > 0 ? round1((recoveryRepeats / recoveryFollowUps.length) * 100) : null,
      note: recoveryFollowUps.length > 0
        ? `Of ${recoveryFollowUps.length} drought-resolution event(s), the SAME color repeated immediately afterward ${recoveryRepeats} time(s), and a different color took the next event ${recoveryFollowUps.length - recoveryRepeats} time(s).`
        : 'No drought-resolution events observed yet to evaluate recovery behavior.'
    }
  };
}

/**
 * Main entry point, called once per council cycle. Pure function of
 * fiveBallHarvest (Phase 1's own output) -- no persistent state, no
 * historicalDraws access, no writes anywhere.
 */
function evaluateFiveBallResearchLab(fiveBallHarvest) {
  const harvest = fiveBallHarvest || {};
  const eventLog = harvest.eventLog || [];
  const totalDrawsObserved = harvest.totalDrawsObserved || 0;
  const perColorEventCounts = harvest.perColorEventCounts || { RED: 0, BLUE: 0, GREEN: 0 };

  if (eventLog.length < 2) {
    return {
      engine: '5-Ball Research Lab',
      phase: 2,
      ready: false,
      reasoning: `Only ${eventLog.length} 5-ball event(s) captured so far -- need at least 2 to compute any gap/rotation statistics. Still in Phase 1 (Harvest) territory in practice.`
    };
  }

  const chronoEvents = chronologicalEvents(eventLog);

  const frequency = computeFrequency(perColorEventCounts, totalDrawsObserved);

  const gapsByColor = {};
  HIERARCHY.forEach(color => {
    gapsByColor[color] = computeGapStats(chronoEvents, color, totalDrawsObserved);
  });

  const consecutive = computeConsecutiveRepeats(chronoEvents);
  const rotation = computeColorRotation(chronoEvents);
  const dominance = computeDominance(chronoEvents);
  const { suppression, recovery } = computeSuppressionAndRecovery(chronoEvents, gapsByColor);

  const reasoning = `Research Lab computed from ${eventLog.length} captured 5-ball event(s) across ${totalDrawsObserved} observed draws. `
    + `Frequency split: RED ${frequency.byColor.RED.totalEvents} / BLUE ${frequency.byColor.BLUE.totalEvents} / GREEN ${frequency.byColor.GREEN.totalEvents}. `
    + `${dominance.note} `
    + `${suppression.note} ${recovery.note} `
    + `NOTE: suppression/recovery thresholds use each color's full-history gap percentile (mild lookahead bias -- see this engine's header); treat these as descriptive observations, not validated predictive signals -- that validation is Phase 4's job, not built yet.`;

  return {
    engine: '5-Ball Research Lab',
    phase: 2,
    ready: true,
    frequency,
    gapsByColor,
    consecutive,
    rotation,
    dominance,
    suppression,
    recovery,
    reasoning
  };
}

module.exports = {
  HIERARCHY,
  MIN_GAP_SAMPLE,
  DOMINANCE_WINDOW,
  DOMINANCE_SHARE_THRESHOLD,
  SUPPRESSION_PERCENTILE,
  chronologicalEvents,
  computeFrequency,
  computeGapStats,
  computeConsecutiveRepeats,
  computeColorRotation,
  computeDominance,
  computeSuppressionAndRecovery,
  evaluateFiveBallResearchLab
};
