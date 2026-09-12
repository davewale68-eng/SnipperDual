/**
 * Zero Color Ball Intelligence Engine -- structural/mathematical mirror of
 * tieEngine.js's analyzeTies() and threeBallColorEngine.js's
 * analyzeThreeBallColor(), re-keyed from "tie detection" / "predicted-color
 * hit detection" to "zero-color detection" for the full 6-ball draw.
 *
 * EVENT DEFINITION (fixed):
 * A "zero event" is any draw in which at least one of the three colors
 * (RED, BLUE, GREEN) is COMPLETELY ABSENT -- colorCounts[color] === 0.
 * This is independent of how the remaining balls split, and independent
 * of the special #49 "yellow" ball (validator.js's parseItem() already
 * drops any non RED/BLUE/GREEN entry from colorsList/colorCounts, so a
 * draw can legitimately have fewer than 6 colored balls -- see
 * tieEngine.js's own header for that same fact). Examples the spec calls
 * out explicitly:
 *   - 3 RED, 3 BLUE, 0 GREEN         -> zero event, GREEN missing
 *   - 2 RED, 3 BLUE, 1 ball is #49   -> colorCounts = {RED:2,BLUE:3,GREEN:0}
 *                                       -> zero event, GREEN missing
 *   - any other shape where any one (or more) of the three colors never
 *     appears is a zero event, regardless of how the other color(s) split.
 *
 * A draw can (rarely) have TWO colors missing at once -- e.g. all 6 balls
 * (or all colored balls) land on a single color, RED:6, BLUE:0, GREEN:0.
 * That is still one zero EVENT (a draw either has >=1 missing color or it
 * doesn't), but missingColors carries every color that was absent so the
 * per-color breakdown below stays accurate.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention in this codebase.
 */
const { HIERARCHY } = require('../core/colorMath');
const { clamp } = require('../core/isotonic');

const SEASON_WINDOW_MIN = 10;
const SEASON_WINDOW_MAX = 15;
const SEASON_MAX_GAP = 2;
const SEASON_MIN_ZEROS = 3; // minimum zero-event count within the window to call it a genuine recurring season

function median(sortedArr) {
  const n = sortedArr.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedArr[mid - 1] + sortedArr[mid]) / 2 : sortedArr[mid];
}

function modeOf(arr) {
  const freq = new Map();
  let best = arr[0];
  let bestCount = 0;
  for (const v of arr) {
    const c = (freq.get(v) || 0) + 1;
    freq.set(v, c);
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

// --- Zero-event detection ------------------------------------------------

/**
 * Returns the list of colors (subset of HIERARCHY) that are completely
 * absent from this draw's colorCounts. Empty array = not a zero event.
 */
function missingColorsOf(draw) {
  if (!draw || !draw.colorCounts) return [];
  return HIERARCHY.filter(c => (draw.colorCounts[c] || 0) === 0);
}

function isZeroEvent(draw) {
  return missingColorsOf(draw).length > 0;
}

/**
 * Shape at the moment of the zero event -- same leader/margin vocabulary
 * as threeBallColorEngine.js's hitShape() / tieEngine.js's tieShape(), so
 * it reads consistently with the rest of the operator-facing intelligence.
 */
function zeroShape(draw) {
  if (!draw || !draw.colorCounts) return null;
  const missing = missingColorsOf(draw);
  if (missing.length === 0) return null;
  const present = HIERARCHY.filter(c => !missing.includes(c));
  const counts = HIERARCHY.map(c => draw.colorCounts[c] || 0);
  const countStr = counts.join('-');
  if (missing.length >= 2) {
    return `${countStr} (${present.join('/') || 'none'} only, ${missing.join('/')} missing)`;
  }
  return `${countStr} (${present.join('/')} split, ${missing[0]} missing)`;
}

// --- Signal engines (identical math to tieEngine.js / threeBallColorEngine.js) --

function computeFrequencyScore(zeroRatePct, recentRatePct, recentWindowSize) {
  if (recentWindowSize < 3) return { score: 30, note: 'Insufficient recent-window sample.' };
  const delta = recentRatePct - zeroRatePct;
  const score = clamp(Math.round(50 + delta * 3), 0, 100);
  return { score, zeroRatePct, recentRatePct, deltaPct: Math.round(delta * 10) / 10 };
}

function computeIntervalScore(avgIntervalDraws, lastZeroDrawsAgo) {
  if (avgIntervalDraws === null || avgIntervalDraws <= 0 || lastZeroDrawsAgo === null) {
    return { score: 25, ratio: null, note: 'Not enough interval history yet.' };
  }
  const ratio = lastZeroDrawsAgo / avgIntervalDraws;
  const score = ratio >= 1
    ? clamp(Math.round(70 + (ratio - 1) * 60), 0, 100)
    : clamp(Math.round(ratio * 70), 0, 100);
  return { score, ratio: Math.round(ratio * 100) / 100 };
}

/**
 * Precursor signature: how close the CLOSEST color was to going to zero
 * (i.e. the smallest color count) in the draw immediately before a zero
 * event -- mirrors classifyPrecursorSignature()'s margin read in
 * threeBallColorEngine.js, just measuring "distance from empty" instead of
 * "distance from the tracked-color win threshold".
 */
function classifyPrecursorSignature(draw) {
  if (!draw || !draw.colorCounts) return null;
  const counts = HIERARCHY.map(c => draw.colorCounts[c] || 0);
  const minCount = Math.min(...counts);
  if (minCount === 0) return 'ALREADY_ZERO';
  if (minCount === 1) return 'NARROW';
  if (minCount === 2) return 'MODERATE';
  return 'WIDE';
}

function computePatternScore(historicalDraws, zeroDrawsAgoList) {
  const precursors = [];
  for (const zeroIdx of zeroDrawsAgoList) {
    const precursorDraw = historicalDraws[zeroIdx + 1];
    const sig = classifyPrecursorSignature(precursorDraw);
    if (sig) precursors.push(sig);
  }
  if (precursors.length < 3) {
    return {
      score: 30,
      dominantSignature: null,
      dominantSharePct: null,
      currentSignature: classifyPrecursorSignature(historicalDraws[0]),
      matches: false,
      sampleSize: precursors.length,
      note: 'Insufficient zero-event history to detect a precursor pattern.'
    };
  }
  const counts = new Map();
  for (const sig of precursors) counts.set(sig, (counts.get(sig) || 0) + 1);
  const [dominantSignature, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominantSharePct = Math.round((dominantCount / precursors.length) * 1000) / 10;
  const currentSignature = classifyPrecursorSignature(historicalDraws[0]);
  const matches = currentSignature !== null && currentSignature === dominantSignature;
  const score = matches
    ? clamp(Math.round(40 + dominantSharePct * 0.6), 40, 95)
    : clamp(Math.round(15 + dominantSharePct * 0.2), 10, 40);
  return { score, dominantSignature, dominantSharePct, currentSignature, matches, sampleSize: precursors.length };
}

/**
 * Transition pressure: is the field converging toward a zero (the
 * smallest color count shrinking over the last 6 draws) or diverging away
 * from one (colors spreading back out)? Same newest-3-vs-older-3 momentum
 * read as threeBallColorEngine.js's computeTransitionPressure(), just
 * measured on the minimum color count instead of the tracked color's
 * margin.
 */
function computeTransitionPressure(historicalDraws) {
  const minOf = (d) => {
    if (!d || !d.colorCounts) return null;
    return Math.min(...HIERARCHY.map(c => d.colorCounts[c] || 0));
  };
  const recent = historicalDraws.slice(0, 6).map(minOf).filter(v => v !== null);
  if (recent.length < 6) {
    return { score: 30, trend: 'INSUFFICIENT_DATA', newestAvgMin: null, olderAvgMin: null };
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const newestAvg = avg(recent.slice(0, 3));
  const olderAvg = avg(recent.slice(3, 6));
  const delta = newestAvg - olderAvg; // negative = minimum count shrinking = converging toward a zero event
  const score = clamp(Math.round(50 - delta * 25), 0, 100);
  const trend = delta < -0.3 ? 'STRENGTHENING' : (delta > 0.3 ? 'WEAKENING' : 'STABLE');
  return {
    score,
    trend,
    newestAvgMin: Math.round(newestAvg * 10) / 10,
    olderAvgMin: Math.round(olderAvg * 10) / 10
  };
}

function computeExpectedWindow(intervalScore, patternScore, transitionScore, drawsUntilNextZero) {
  const allAgree = intervalScore >= 60 && patternScore >= 60 && transitionScore >= 60;
  if (!allAgree) {
    return { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false };
  }
  if (drawsUntilNextZero !== null && drawsUntilNextZero <= 1) {
    return { label: 'NEXT 1-2 DRAWS', fromDraws: 1, toDraws: 2, tightened: true };
  }
  return { label: 'NEXT 1-3 DRAWS', fromDraws: 1, toDraws: 3, tightened: true };
}

function computeConfidenceLabel(agreementCount, sufficientSample, effectiveSampleSize) {
  if (!sufficientSample || effectiveSampleSize < 10) return 'LOW';
  if (agreementCount >= 3) return 'HIGH';
  if (agreementCount >= 2) return 'MEDIUM';
  return 'LOW';
}

// --- Season detection (identical walk to tieEngine.js's findTieSeasons) --

function findZeroSeasons(zeroFlags, maxGap = SEASON_MAX_GAP, minZeros = SEASON_MIN_ZEROS) {
  const zeroIndices = [];
  for (let i = zeroFlags.length - 1; i >= 0; i--) {
    if (zeroFlags[i]) zeroIndices.push(i);
  }
  const seasons = [];
  let runIndices = [];
  for (let k = 0; k < zeroIndices.length; k++) {
    const idx = zeroIndices[k];
    if (runIndices.length === 0) {
      runIndices = [idx];
      continue;
    }
    const prevIdx = runIndices[runIndices.length - 1];
    const gap = prevIdx - idx - 1;
    if (gap <= maxGap) {
      runIndices.push(idx);
    } else {
      if (runIndices.length >= minZeros) {
        seasons.push(finalizeSeason(runIndices, maxGap));
      }
      runIndices = [idx];
    }
  }
  if (runIndices.length >= minZeros) {
    seasons.push(finalizeSeason(runIndices, maxGap));
  }
  return seasons
    .filter(s => s.spanDraws >= 1 && s.mostRecentZeroDrawsAgo <= SEASON_WINDOW_MAX)
    .reverse();
}

function finalizeSeason(runIndices, maxGap = SEASON_MAX_GAP) {
  const oldestIdx = runIndices[0];
  const newestIdx = runIndices[runIndices.length - 1];
  const spanDraws = oldestIdx - newestIdx + 1;
  return {
    zeroCount: runIndices.length,
    spanDraws,
    startedDrawsAgo: oldestIdx,
    mostRecentZeroDrawsAgo: newestIdx,
    stillActive: newestIdx <= maxGap
  };
}

/**
 * Per-color breakdown: of all zero events observed, how often was each
 * specific color the one missing? Lets an operator see e.g. "GREEN goes
 * missing far more often than RED" the same way the 3-Ball engine
 * surfaces a single tracked color's own stats.
 */
function computePerColorBreakdown(draws, zeroFlags) {
  const missingCounts = { RED: 0, BLUE: 0, GREEN: 0 };
  const lastMissingDrawsAgo = { RED: null, BLUE: null, GREEN: null };
  let totalZeroEvents = 0;
  for (let i = 0; i < draws.length; i++) {
    if (!zeroFlags[i]) continue;
    totalZeroEvents++;
    const missing = missingColorsOf(draws[i]);
    for (const c of missing) {
      missingCounts[c]++;
      if (lastMissingDrawsAgo[c] === null) lastMissingDrawsAgo[c] = i;
    }
  }
  const breakdown = {};
  for (const c of HIERARCHY) {
    breakdown[c] = {
      missingCount: missingCounts[c],
      sharePctOfZeroEvents: totalZeroEvents > 0
        ? Math.round((missingCounts[c] / totalZeroEvents) * 1000) / 10
        : 0,
      lastMissingDrawsAgo: lastMissingDrawsAgo[c]
    };
  }
  // "Due" color: among the three, whichever has gone longest without
  // being the missing color (or has never been missing at all -- treated
  // as maximally overdue, sorted after any observed value).
  const dueColor = [...HIERARCHY].sort((a, b) => {
    const av = breakdown[a].lastMissingDrawsAgo;
    const bv = breakdown[b].lastMissingDrawsAgo;
    if (av === null && bv === null) return 0;
    if (av === null) return -1;
    if (bv === null) return 1;
    return bv - av;
  })[0];
  return { breakdown, dueColor };
}

/**
 * Full zero-color-ball intelligence analysis. Mirrors analyzeTies() /
 * analyzeThreeBallColor()'s structure and math exactly -- see those
 * functions' own headers for what each block does; only the tracked
 * event (a missing color vs. a tie vs. a tracked-color hit) differs.
 */
function analyzeZeroColor(historicalDraws) {
  const draws = historicalDraws || [];
  const total = draws.length;

  const zeroFlags = draws.map(d => isZeroEvent(d));
  const totalZeros = zeroFlags.filter(Boolean).length;

  let lastZeroDrawsAgo = null;
  let lastZeroDrawId = null;
  let lastZeroShapeStr = null;
  let lastZeroMissingColors = null;
  for (let i = 0; i < draws.length; i++) {
    if (zeroFlags[i]) {
      lastZeroDrawsAgo = i;
      lastZeroDrawId = draws[i].drawId;
      lastZeroShapeStr = zeroShape(draws[i]);
      lastZeroMissingColors = missingColorsOf(draws[i]);
      break;
    }
  }

  const zeroDrawsAgoList = [];
  for (let i = 0; i < draws.length; i++) {
    if (zeroFlags[i]) zeroDrawsAgoList.push(i);
  }
  const intervals = [];
  for (let i = 0; i < zeroDrawsAgoList.length - 1; i++) {
    intervals.push(zeroDrawsAgoList[i + 1] - zeroDrawsAgoList[i]);
  }
  const avgIntervalDraws = intervals.length > 0
    ? Math.round((intervals.reduce((a, b) => a + b, 0) / intervals.length) * 10) / 10
    : null;
  const medianIntervalDraws = intervals.length > 0
    ? median([...intervals].sort((a, b) => a - b))
    : null;
  const longestGapDraws = intervals.length > 0 ? Math.max(...intervals) : null;
  const shortestGapDraws = intervals.length > 0 ? Math.min(...intervals) : null;
  const mostCommonInterval = intervals.length > 0 ? modeOf(intervals) : null;

  const zeroRatePct = total > 0 ? Math.round((totalZeros / total) * 1000) / 10 : 0;

  const recentWindow = draws.slice(0, SEASON_WINDOW_MAX);
  const recentZeros = recentWindow.filter(d => isZeroEvent(d)).length;
  const recentRatePct = recentWindow.length > 0
    ? Math.round((recentZeros / recentWindow.length) * 1000) / 10
    : 0;

  const seasons = findZeroSeasons(zeroFlags);
  const activeSeason = seasons.find(s => s.stillActive) || null;

  let currentZeroStreak = 0;
  for (let i = 0; i < zeroFlags.length; i++) {
    if (zeroFlags[i]) currentZeroStreak++;
    else break;
  }
  const detectedCycle = mostCommonInterval && intervals.filter(iv => iv === mostCommonInterval).length >= 2
    ? `Zero events occur approximately every ${mostCommonInterval} draw(s)`
    : null;

  const { breakdown: colorBreakdown, dueColor } = computePerColorBreakdown(draws, zeroFlags);

  // --- Four Intelligence Layers, blended 25/25/25/25 into Zero Pressure --
  const frequencySignal = computeFrequencyScore(zeroRatePct, recentRatePct, recentWindow.length);
  const intervalSignal = computeIntervalScore(avgIntervalDraws, lastZeroDrawsAgo);
  const patternSignal = computePatternScore(draws, zeroDrawsAgoList);
  const transitionSignal = computeTransitionPressure(draws);

  const zeroPressureScore = clamp(Math.round(
    (frequencySignal.score * 0.25) +
    (intervalSignal.score * 0.25) +
    (patternSignal.score * 0.25) +
    (transitionSignal.score * 0.25)
  ), 0, 100);

  const sufficientSample = total >= SEASON_WINDOW_MIN;
  const agreementCount = [frequencySignal.score, intervalSignal.score, patternSignal.score, transitionSignal.score]
    .filter(s => s >= 60).length;
  const confidenceLabel = computeConfidenceLabel(agreementCount, sufficientSample, total);

  // Draws until next zero event -- direct read off avg spacing vs. current
  // gap, same "due/overdue" framing as the Tie Engine / 3-Ball Color Engine.
  const drawsUntilNextZero = (avgIntervalDraws !== null && lastZeroDrawsAgo !== null)
    ? Math.max(0, Math.round(avgIntervalDraws - lastZeroDrawsAgo))
    : null;

  // EVENT-LEVEL NEXT EVENT PREDICTION -- predicts the zero event itself
  // (not which color will go missing). The prediction window is computed
  // from avg interval spacing: once lastZeroDrawsAgo reaches within
  // NEXT_EVENT_ALERT_WITHIN draws of avgIntervalDraws, we say "due in N
  // draws" and begin a countdown. When lastZeroDrawsAgo >= avgIntervalDraws
  // the event is OVERDUE. The prediction does NOT name a color -- it flags
  // that *some* color will be absent, consistent with the event definition.
  const NEXT_EVENT_ALERT_WITHIN = 4; // start countdown when ≤ this many draws remain
  let nextEventPrediction = null;
  if (avgIntervalDraws !== null && lastZeroDrawsAgo !== null) {
    const drawsRemaining = Math.round(avgIntervalDraws - lastZeroDrawsAgo);
    const overdueByDraws = drawsRemaining < 0 ? Math.abs(drawsRemaining) : 0;
    const isOverdue = drawsRemaining <= 0;
    const inWindow = drawsRemaining <= NEXT_EVENT_ALERT_WITHIN;
    nextEventPrediction = {
      active: inWindow || isOverdue,
      isOverdue,
      drawsRemaining: Math.max(0, drawsRemaining),
      overdueByDraws,
      alertWithin: NEXT_EVENT_ALERT_WITHIN,
      // Human-readable status label:
      // "Due in ~N draws" -> "IMMINENT" -> "OVERDUE (N draws past due)"
      statusLabel: isOverdue
        ? `OVERDUE — ${overdueByDraws} draw(s) past due`
        : drawsRemaining === 0
          ? 'IMMINENT'
          : `Due in ~${drawsRemaining} draw(s)`,
      // Short label for badges/pills
      countdownLabel: isOverdue
        ? `OVERDUE (+${overdueByDraws})`
        : `~${drawsRemaining} draws`,
    };
  }

  const zeroProbabilityPct = clamp(Math.round(
    (zeroPressureScore * 0.6) + (recentRatePct * 0.4)
  ), 5, 95);

  const riskLevel = confidenceLabel === 'HIGH' && zeroProbabilityPct >= 55 ? 'LOW'
    : confidenceLabel === 'LOW' ? 'HIGH'
    : 'MODERATE';

  const warningScore = zeroProbabilityPct;
  const warningLevel = warningScore >= 60 ? 'ELEVATED' : warningScore >= 35 ? 'MODERATE' : 'LOW';

  const expectedWindow = computeExpectedWindow(
    intervalSignal.score, patternSignal.score, transitionSignal.score, drawsUntilNextZero
  );

  const marketStateLabel = activeSeason ? 'ACTIVE ZERO SEASON'
    : zeroPressureScore >= 60 ? 'BUILDING PRESSURE'
    : 'NO EDGE';

  const operatorAction = zeroPressureScore >= 70 ? 'WATCH CLOSELY'
    : zeroPressureScore >= 45 ? 'MONITOR'
    : 'NO ACTION';

  const reasoning = activeSeason
    ? `Zero events are in an active season: ${activeSeason.zeroCount} zero draws across the last ${activeSeason.spanDraws} draws, most recent ${activeSeason.mostRecentZeroDrawsAgo} draw(s) ago.${nextEventPrediction && nextEventPrediction.active ? ` A zero event (any color absent) is ${nextEventPrediction.isOverdue ? `overdue by ${nextEventPrediction.overdueByDraws} draw(s)` : `expected within the next ${nextEventPrediction.drawsRemaining} draw(s)`}.` : ''}`
    : lastZeroDrawsAgo !== null
      ? `Last zero event was ${lastZeroDrawsAgo} draw(s) ago (${lastZeroMissingColors.join('/')} missing) against an average spacing of ${avgIntervalDraws != null ? avgIntervalDraws + ' draws' : 'an undetermined interval'}.${nextEventPrediction && nextEventPrediction.active ? ` Based on historical patterns, a zero event is ${nextEventPrediction.isOverdue ? `overdue by ${nextEventPrediction.overdueByDraws} draw(s)` : `expected in the next ~${nextEventPrediction.drawsRemaining} draw(s)`} — all 3 colors are candidates (most recently absent: ${dueColor}).` : ` No zero event imminent (${drawsUntilNextZero != null ? `~${drawsUntilNextZero} draws remaining` : 'spacing undetermined'}).`}`
      : `No zero events observed yet in the tracked window.`;

  return {
    available: total > 0,
    currentZeroStreak,
    zeroRatePct,
    recentRatePct,
    sampleSize: total,
    sufficientSample,
    detectedCycle,

    lastZeroEvent: lastZeroDrawId !== null ? {
      drawId: lastZeroDrawId,
      drawsAgo: lastZeroDrawsAgo,
      missingColors: lastZeroMissingColors,
      shape: lastZeroShapeStr
    } : null,

    intervalStats: {
      avgIntervalDraws,
      medianIntervalDraws,
      shortestGapDraws,
      longestGapDraws,
      sampleSize: intervals.length
    },

    activeSeason,

    colorBreakdown,
    // predictedMissingColor is retained for the per-color breakdown panel
    // (which color has gone longest without being absent), but the primary
    // next-event prediction is nextEventPrediction (event-level: a zero event
    // is due, not which specific color). See nextEventPrediction below.
    predictedMissingColor: dueColor,
    nextEventPrediction,

    zeroPressureScore,
    zeroProbabilityPct,
    confidenceLabel,
    riskLevel,
    warningLevel,
    warningScore,
    drawsUntilNextZero,
    expectedWindow,
    marketStateLabel,
    operatorAction,
    reasoning,

    signals: {
      frequency: frequencySignal,
      interval: intervalSignal,
      pattern: patternSignal,
      transition: transitionSignal
    }
  };
}

module.exports = {
  analyzeZeroColor,
  isZeroEvent,
  missingColorsOf,
  zeroShape
};
