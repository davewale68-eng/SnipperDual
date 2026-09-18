/**
 * 4-Ball Color Next Event Engine -- structural/mathematical mirror of
 * zeroColorEngine.js's analyzeZeroColor(), re-keyed from "a color is
 * completely absent this draw" to "a color reaches the 4-ball threshold
 * this draw", tracked per color instead of as a single fixed-color read.
 *
 * EVENT DEFINITION (fixed):
 * A "4-ball event" is any draw in which validator.js's parseItem() has
 * already resolved a fourBallColor (draw.fourBallColor !== null) -- i.e.
 * one of the three colors (RED, BLUE, GREEN) reached a count of 4 or
 * more balls in that draw. See validator.js's own header for why
 * fourBallColor is allowed to overlap with fiveBallColor on purpose
 * (a 5-ball event is also, by definition, a 4-ball event for that same
 * color) -- that overlap is preserved here without alteration; this
 * engine only ever READS draw.fourBallColor, it never recomputes it.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention in this codebase.
 *
 * WHAT THIS ADDS ON TOP OF zeroColorEngine's SHAPE:
 * Zero events are keyed to "which color(s) were missing" (0-2 colors per
 * event). 4-ball events are keyed to exactly ONE color per event (the
 * color that reached >=4 is always a single, well-defined winner --
 * colorMath.js's HIERARCHY tie-break never needs to run here because
 * only one color's count can be >=4 in a 6-ball draw split three ways,
 * except in the rare case two colors both clear 4, which cannot happen
 * with 6 total balls -- so fourBallColor is always unambiguous). That
 * means the per-color breakdown below tracks "played" (was the
 * fourBallColor) rather than "missing", and lastPlayedDrawsAgo is walked
 * independently per color (not just the first event's own missing list),
 * since three different colors can each have wildly different last-
 * played gaps at any given moment.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational engine, same
 * discipline as zeroColorEngine.js and every *NextEvent* engine in this
 * codebase -- never votes, never feeds back into any gate/weight.
 *
 * FIX -- ENTRY HIT COUNTER CONSUMPTION, GATING, METRICS GUIDE:
 * Previously this engine only ever read historicalDraws and emitted a
 * predictedNextColor unconditionally, with no cross-check against any
 * other logged source and no documented explanation of what its own
 * signals mean -- an operator had no way to tell "is this call actually
 * trustworthy right now" from the payload alone.
 *
 *   1. ENTRY HIT COUNTER CONSUMPTION -- this engine now optionally
 *      accepts entryHitCounterState (store.entryHitCounter, the 4-Ball
 *      Parliament's own live hit/miss log -- see entryHitCounter.js's
 *      header). That log is the ONLY place in this codebase that
 *      persistently records, per ENTER call, all three colors at once:
 *      the RULING color (firstPick, fourBallP.winningColor -- the
 *      Parliament's top pick) and the SECOND color (secondPick,
 *      fourBallP.secondColor -- whichever of the two remaining colors
 *      is currently contesting the ruling color for the runner-up
 *      slot), each independently scored against what actually landed.
 *      computeEntrySignal() below reads that log's firstPick/secondPick
 *      hit-rate history and folds it in as a FIFTH intelligence signal
 *      (20% weight, alongside frequency/interval/pattern/transition at
 *      20% each -- rebalanced down from 25% apiece) so a color the live
 *      hit counter has actually been landing on gets real weight here,
 *      not just this engine's own historicalDraws-derived read.
 *      entryHitCounterAlignment surfaces the comparison directly (does
 *      dueColor match the ruling or second color currently being
 *      watched, and at what hit rate) so the cross-check is visible,
 *      not just baked silently into the blended score. Passing no
 *      second argument (or an empty/malformed one) degrades gracefully
 *      -- computeEntrySignal returns its own low-confidence default and
 *      every other signal/score computes exactly as before.
 *   2. GATING -- gate.open is now false unless there is BOTH enough
 *      historicalDraws sample (sufficientSample) AND at least one
 *      logged ENTER call in the entry hit counter to cross-check
 *      against (entrySignal.sampleSize > 0) AND confidenceLabel is not
 *      LOW. operatorAction is forced to 'NO ACTION' whenever the gate
 *      is closed, regardless of what the raw pressure score alone would
 *      have suggested -- so a caller can act on operatorAction without
 *      separately re-deriving the same gating logic itself.
 *   3. METRICS GUIDE -- metricsGuide is a static, always-present
 *      reference block (see buildMetricsGuide() below) documenting what
 *      each of the five signals measures, how fourBallPressureScore is
 *      blended from them, and what the gate requires -- shipped
 *      alongside the data itself rather than left as tribal knowledge
 *      the operator has to remember or re-derive from this file's
 *      source.
 */
const { HIERARCHY } = require('../core/colorMath');
const { clamp } = require('../core/isotonic');

const SEASON_WINDOW_MIN = 10;
const SEASON_WINDOW_MAX = 15;
const SEASON_MAX_GAP = 2;
const SEASON_MIN_EVENTS = 3; // minimum 4-ball event count within the window to call it a genuine recurring season

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

// --- 4-ball event detection -----------------------------------------------

function isFourBallEvent(draw) {
  return !!(draw && draw.fourBallColor);
}

/**
 * Shape at the moment of the 4-ball event -- same leader/margin
 * vocabulary as zeroColorEngine.js's zeroShape() / threeBallColorEngine
 * .js's hitShape(), so it reads consistently with the rest of the
 * operator-facing intelligence.
 */
function fourBallShape(draw) {
  if (!draw || !draw.colorCounts || !draw.fourBallColor) return null;
  const counts = HIERARCHY.map(c => draw.colorCounts[c] || 0);
  const countStr = counts.join('-');
  return `${countStr} (${draw.fourBallColor} reached 4-ball)`;
}

// --- Signal engines (identical math to zeroColorEngine.js) --------------

function computeFrequencyScore(eventRatePct, recentRatePct, recentWindowSize) {
  if (recentWindowSize < 3) return { score: 30, note: 'Insufficient recent-window sample.' };
  const delta = recentRatePct - eventRatePct;
  const score = clamp(Math.round(50 + delta * 3), 0, 100);
  return { score, eventRatePct, recentRatePct, deltaPct: Math.round(delta * 10) / 10 };
}

function computeIntervalScore(avgIntervalDraws, lastEventDrawsAgo) {
  if (avgIntervalDraws === null || avgIntervalDraws <= 0 || lastEventDrawsAgo === null) {
    return { score: 25, ratio: null, note: 'Not enough interval history yet.' };
  }
  const ratio = lastEventDrawsAgo / avgIntervalDraws;
  const score = ratio >= 1
    ? clamp(Math.round(70 + (ratio - 1) * 60), 0, 100)
    : clamp(Math.round(ratio * 70), 0, 100);
  return { score, ratio: Math.round(ratio * 100) / 100 };
}

/**
 * Precursor signature: how close the CLOSEST color was to reaching 4
 * (i.e. the largest color count) in the draw immediately before a
 * 4-ball event -- mirrors zeroColorEngine.js's classifyPrecursorSignature,
 * just measuring "distance to 4" instead of "distance from empty".
 */
function classifyPrecursorSignature(draw) {
  if (!draw || !draw.colorCounts) return null;
  const counts = HIERARCHY.map(c => draw.colorCounts[c] || 0);
  const maxCount = Math.max(...counts);
  if (maxCount >= 4) return 'ALREADY_FOUR';
  if (maxCount === 3) return 'NARROW';
  if (maxCount === 2) return 'MODERATE';
  return 'WIDE';
}

function computePatternScore(historicalDraws, eventDrawsAgoList) {
  const precursors = [];
  for (const eventIdx of eventDrawsAgoList) {
    const precursorDraw = historicalDraws[eventIdx + 1];
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
      note: 'Insufficient 4-ball event history to detect a precursor pattern.'
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
 * Transition pressure: is the field converging toward a 4-ball event
 * (the largest color count growing over the last 6 draws) or diverging
 * away from one? Same newest-3-vs-older-3 momentum read as
 * zeroColorEngine.js's computeTransitionPressure, just measured on the
 * maximum color count instead of the minimum.
 */
function computeTransitionPressure(historicalDraws) {
  const maxOf = (d) => {
    if (!d || !d.colorCounts) return null;
    return Math.max(...HIERARCHY.map(c => d.colorCounts[c] || 0));
  };
  const recent = historicalDraws.slice(0, 6).map(maxOf).filter(v => v !== null);
  if (recent.length < 6) {
    return { score: 30, trend: 'INSUFFICIENT_DATA', newestAvgMax: null, olderAvgMax: null };
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const newestAvg = avg(recent.slice(0, 3));
  const olderAvg = avg(recent.slice(3, 6));
  const delta = newestAvg - olderAvg; // positive = maximum count growing = converging toward a 4-ball event
  const score = clamp(Math.round(50 + delta * 25), 0, 100);
  const trend = delta > 0.3 ? 'STRENGTHENING' : (delta < -0.3 ? 'WEAKENING' : 'STABLE');
  return {
    score,
    trend,
    newestAvgMax: Math.round(newestAvg * 10) / 10,
    olderAvgMax: Math.round(olderAvg * 10) / 10
  };
}

/**
 * FIX -- Entry signal: cross-checks this engine's own dueColor read
 * against the 4-Ball Parliament's live ENTER-call hit/miss log
 * (entryHitCounter.js, store.entryHitCounter -- "the 4ball hit
 * counter"). That log independently watches two picks per call --
 * firstPick (the RULING color, fourBallP.winningColor) and secondPick
 * (the SECOND color, fourBallP.secondColor -- whichever of the two
 * non-ruling colors is currently contesting the runner-up slot) --
 * each graded against what actually landed. dueColor is only otherwise
 * checked against ITS OWN score of this engine's historicalDraws
 * before pressure ever gets blended (agreementCount above), it is
 * used here only to give this signal a real number.
 *
 * If dueColor matches whichever pick is currently pending, this signal
 * scores off THAT pick's own lifetime hitRatePct (a color the live
 * counter has actually been landing on gets real credit). If dueColor
 * matches neither current pending pick, the signal falls back to a
 * neutral-low score -- the entry log simply isn't corroborating this
 * engine's own read right now, not that it's wrong.
 */
function computeEntrySignal(entryHitCounterState, dueColor) {
  const ehc = entryHitCounterState && typeof entryHitCounterState === 'object' ? entryHitCounterState : null;
  const firstPick = ehc && ehc.firstPick && typeof ehc.firstPick === 'object' ? ehc.firstPick : null;
  const secondPick = ehc && ehc.secondPick && typeof ehc.secondPick === 'object' ? ehc.secondPick : null;

  const pickRate = (pick) => {
    if (!pick) return null;
    const resolved = (pick.hits || 0) + (pick.misses || 0);
    return resolved > 0 ? Math.round((pick.hits / resolved) * 1000) / 10 : null;
  };

  const rulingColor = firstPick && firstPick.pending ? firstPick.pending.color : null;
  const secondColor = secondPick && secondPick.pending ? secondPick.pending.color : null;
  const rulingHitRatePct = pickRate(firstPick);
  const secondHitRatePct = pickRate(secondPick);

  const sampleSize = (firstPick ? (firstPick.hits || 0) + (firstPick.misses || 0) : 0)
    + (secondPick ? (secondPick.hits || 0) + (secondPick.misses || 0) : 0);

  const alignment = {
    rulingColor,
    rulingHitRatePct,
    secondColor,
    secondHitRatePct,
    predictedMatchesRuling: !!(dueColor && rulingColor && dueColor === rulingColor),
    predictedMatchesSecond: !!(dueColor && secondColor && dueColor === secondColor)
  };

  if (sampleSize === 0) {
    return {
      score: 30,
      note: 'No ENTER calls logged yet in the entry hit counter -- nothing to cross-check against.',
      sampleSize: 0,
      alignment
    };
  }

  if (alignment.predictedMatchesRuling && rulingHitRatePct != null) {
    return { score: clamp(Math.round(rulingHitRatePct), 5, 95), note: `dueColor matches the ruling (1st-pick) color, which is hitting ${rulingHitRatePct}% lifetime.`, sampleSize, alignment };
  }
  if (alignment.predictedMatchesSecond && secondHitRatePct != null) {
    return { score: clamp(Math.round(secondHitRatePct), 5, 95), note: `dueColor matches the second (contested) color, which is hitting ${secondHitRatePct}% lifetime.`, sampleSize, alignment };
  }
  return {
    score: 25,
    note: 'dueColor is not currently being watched by either entry hit counter pick.',
    sampleSize,
    alignment
  };
}

/**
 * FIX -- static reference block shipped alongside the live data so an
 * operator (or another engine reading this payload) never has to
 * re-derive what each signal means or how the blend/gate work from
 * this file's source. Purely descriptive -- computes nothing, reads no
 * state, never affects scoring.
 */
function buildMetricsGuide() {
  return {
    signals: {
      frequency: 'Overall 4-ball event rate over the full sample vs. the rate in the most recent window (SEASON_WINDOW_MAX draws). Score rises when the recent rate is running hotter than the lifetime rate.',
      interval: 'Draws since the last 4-ball event vs. the average interval between events. Score rises as the current gap approaches or exceeds the average spacing (i.e. an event looks "due").',
      pattern: 'Whether the draw immediately before the current one matches the precursor signature (how close the leading color was to 4) that most often preceded a 4-ball event historically.',
      transition: 'Momentum of the leading color\'s ball count over the last 6 draws -- rising toward 4 (STRENGTHENING) vs. falling away from it (WEAKENING).',
      entry: 'Cross-check against the live 4-Ball Parliament entry hit counter (store.entryHitCounter): does the predicted dueColor match the ruling (1st-pick) or second (contested) color currently being watched, and at what real hit rate.'
    },
    blend: 'fourBallPressureScore = 20% frequency + 20% interval + 20% pattern + 20% transition + 20% entry, each 0-100.',
    gate: {
      requires: [
        'sufficientSample: at least SEASON_WINDOW_MIN draws of historicalDraws',
        'entry.sampleSize > 0: at least one resolved ENTER call logged in the entry hit counter',
        "confidenceLabel !== 'LOW'"
      ],
      whenClosed: 'operatorAction is forced to NO ACTION regardless of fourBallPressureScore.'
    },
    confidenceLabel: 'HIGH requires >=3 of the 5 signals scoring >=60 AND sufficientSample AND sampleSize>=10; MEDIUM requires >=2; otherwise LOW.'
  };
}

function computeExpectedWindow(intervalScore, patternScore, transitionScore, drawsUntilNextEvent) {
  const allAgree = intervalScore >= 60 && patternScore >= 60 && transitionScore >= 60;
  if (!allAgree) {
    return { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false };
  }
  if (drawsUntilNextEvent !== null && drawsUntilNextEvent <= 1) {
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

// --- Season detection (identical walk to zeroColorEngine.js's findZeroSeasons) --

function findEventSeasons(eventFlags, maxGap = SEASON_MAX_GAP, minEvents = SEASON_MIN_EVENTS) {
  const eventIndices = [];
  for (let i = eventFlags.length - 1; i >= 0; i--) {
    if (eventFlags[i]) eventIndices.push(i);
  }
  const seasons = [];
  let runIndices = [];
  for (let k = 0; k < eventIndices.length; k++) {
    const idx = eventIndices[k];
    if (runIndices.length === 0) {
      runIndices = [idx];
      continue;
    }
    const prevIdx = runIndices[runIndices.length - 1];
    const gap = prevIdx - idx - 1;
    if (gap <= maxGap) {
      runIndices.push(idx);
    } else {
      if (runIndices.length >= minEvents) {
        seasons.push(finalizeSeason(runIndices, maxGap));
      }
      runIndices = [idx];
    }
  }
  if (runIndices.length >= minEvents) {
    seasons.push(finalizeSeason(runIndices, maxGap));
  }
  return seasons
    .filter(s => s.spanDraws >= 1 && s.mostRecentEventDrawsAgo <= SEASON_WINDOW_MAX)
    .reverse();
}

function finalizeSeason(runIndices, maxGap = SEASON_MAX_GAP) {
  const oldestIdx = runIndices[0];
  const newestIdx = runIndices[runIndices.length - 1];
  const spanDraws = oldestIdx - newestIdx + 1;
  return {
    eventCount: runIndices.length,
    spanDraws,
    startedDrawsAgo: oldestIdx,
    mostRecentEventDrawsAgo: newestIdx,
    stillActive: newestIdx <= maxGap
  };
}

/**
 * Per-color breakdown: of all 4-ball events observed, how often was each
 * specific color the one that played (reached 4-ball)? Each color's
 * lastPlayedDrawsAgo is walked independently (unlike a zero event's
 * missing-color list, a 4-ball event only ever has ONE color, so a
 * color's own last-played gap can differ wildly from the overall last-
 * event gap).
 */
function computePerColorPlayedBreakdown(draws) {
  const playedCounts = { RED: 0, BLUE: 0, GREEN: 0 };
  const lastPlayedDrawsAgo = { RED: null, BLUE: null, GREEN: null };
  let totalEvents = 0;
  for (let i = 0; i < draws.length; i++) {
    const color = draws[i] && draws[i].fourBallColor;
    if (!color || !HIERARCHY.includes(color)) continue;
    totalEvents++;
    playedCounts[color]++;
    if (lastPlayedDrawsAgo[color] === null) lastPlayedDrawsAgo[color] = i;
  }
  const breakdown = {};
  for (const c of HIERARCHY) {
    breakdown[c] = {
      playedCount: playedCounts[c],
      sharePctOfEvents: totalEvents > 0
        ? Math.round((playedCounts[c] / totalEvents) * 1000) / 10
        : 0,
      lastPlayedDrawsAgo: lastPlayedDrawsAgo[c]
    };
  }
  // "Due" color: among the three, whichever has gone longest without
  // playing 4-ball (or has never played at all -- treated as maximally
  // overdue, sorted ahead of any observed value).
  const dueColor = [...HIERARCHY].sort((a, b) => {
    const av = breakdown[a].lastPlayedDrawsAgo;
    const bv = breakdown[b].lastPlayedDrawsAgo;
    if (av === null && bv === null) return 0;
    if (av === null) return -1;
    if (bv === null) return 1;
    return bv - av;
  })[0];
  return { breakdown, dueColor };
}

/**
 * Full 4-ball color next-event analysis. Mirrors zeroColorEngine.js's
 * analyzeZeroColor() structure and math exactly -- see that function's
 * header for what each block does; only the tracked event (a color
 * reaching 4-ball vs. a color going completely missing) differs.
 *
 * entryHitCounterState (optional) -- store.entryHitCounter, "the 4ball
 * hit counter"'s persisted log (see FIX header above and
 * computeEntrySignal()). Omitting it degrades gracefully: the entry
 * signal falls back to its own low-confidence default and everything
 * else computes unchanged.
 */
function analyzeFourBallColorNextEvent(historicalDraws, entryHitCounterState) {
  const draws = historicalDraws || [];
  const total = draws.length;

  const eventFlags = draws.map(d => isFourBallEvent(d));
  const totalEvents = eventFlags.filter(Boolean).length;

  let lastEventDrawsAgo = null;
  let lastEventDrawId = null;
  let lastEventShapeStr = null;
  let lastEventColor = null;
  for (let i = 0; i < draws.length; i++) {
    if (eventFlags[i]) {
      lastEventDrawsAgo = i;
      lastEventDrawId = draws[i].drawId;
      lastEventShapeStr = fourBallShape(draws[i]);
      lastEventColor = draws[i].fourBallColor;
      break;
    }
  }

  const eventDrawsAgoList = [];
  for (let i = 0; i < draws.length; i++) {
    if (eventFlags[i]) eventDrawsAgoList.push(i);
  }
  const intervals = [];
  for (let i = 0; i < eventDrawsAgoList.length - 1; i++) {
    intervals.push(eventDrawsAgoList[i + 1] - eventDrawsAgoList[i]);
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

  const eventRatePct = total > 0 ? Math.round((totalEvents / total) * 1000) / 10 : 0;

  const recentWindow = draws.slice(0, SEASON_WINDOW_MAX);
  const recentEvents = recentWindow.filter(d => isFourBallEvent(d)).length;
  const recentRatePct = recentWindow.length > 0
    ? Math.round((recentEvents / recentWindow.length) * 1000) / 10
    : 0;

  const seasons = findEventSeasons(eventFlags);
  const activeSeason = seasons.find(s => s.stillActive) || null;

  let currentEventStreak = 0;
  for (let i = 0; i < eventFlags.length; i++) {
    if (eventFlags[i]) currentEventStreak++;
    else break;
  }
  const detectedCycle = mostCommonInterval && intervals.filter(iv => iv === mostCommonInterval).length >= 2
    ? `4-ball events occur approximately every ${mostCommonInterval} draw(s)`
    : null;

  const { breakdown: colorBreakdown, dueColor } = computePerColorPlayedBreakdown(draws);

  // --- Five Intelligence Layers, blended 20/20/20/20/20 into 4-Ball Pressure --
  // FIX -- rebalanced from 25/25/25/25 to fold in the entry signal (see
  // computeEntrySignal() / buildMetricsGuide() above for what changed
  // and why).
  const frequencySignal = computeFrequencyScore(eventRatePct, recentRatePct, recentWindow.length);
  const intervalSignal = computeIntervalScore(avgIntervalDraws, lastEventDrawsAgo);
  const patternSignal = computePatternScore(draws, eventDrawsAgoList);
  const transitionSignal = computeTransitionPressure(draws);
  const entrySignal = computeEntrySignal(entryHitCounterState, dueColor);

  const fourBallPressureScore = clamp(Math.round(
    (frequencySignal.score * 0.2) +
    (intervalSignal.score * 0.2) +
    (patternSignal.score * 0.2) +
    (transitionSignal.score * 0.2) +
    (entrySignal.score * 0.2)
  ), 0, 100);

  const sufficientSample = total >= SEASON_WINDOW_MIN;
  const agreementCount = [frequencySignal.score, intervalSignal.score, patternSignal.score, transitionSignal.score, entrySignal.score]
    .filter(s => s >= 60).length;
  const confidenceLabel = computeConfidenceLabel(agreementCount, sufficientSample, total);

  // FIX -- gating: previously this engine surfaced a call unconditionally.
  // Now it only reports itself "open" once there's both enough draw
  // history AND at least one real, resolved ENTER call in the entry hit
  // counter to have cross-checked dueColor against -- see FIX header and
  // buildMetricsGuide()'s gate block above.
  const gateOpen = sufficientSample && entrySignal.sampleSize > 0 && confidenceLabel !== 'LOW';
  const gate = {
    open: gateOpen,
    reason: gateOpen
      ? 'Sufficient sample, entry hit counter has logged history, and confidence is not LOW.'
      : !sufficientSample
        ? 'Insufficient draw history.'
        : entrySignal.sampleSize === 0
          ? 'No resolved ENTER calls logged yet in the entry hit counter to cross-check against.'
          : 'Confidence label is LOW.'
  };

  // Draws until next 4-ball event -- direct read off avg spacing vs.
  // current gap, same "due/overdue" framing as the Zero Color Engine.
  const drawsUntilNextEvent = (avgIntervalDraws !== null && lastEventDrawsAgo !== null)
    ? Math.max(0, Math.round(avgIntervalDraws - lastEventDrawsAgo))
    : null;

  // EVENT-LEVEL NEXT EVENT PREDICTION -- predicts the 4-ball event itself
  // (not which color will reach 4-ball). Mirrors zeroColorEngine.js's
  // nextEventPrediction block exactly: once lastEventDrawsAgo reaches within
  // NEXT_EVENT_ALERT_WITHIN draws of avgIntervalDraws, countdown begins.
  // When lastEventDrawsAgo >= avgIntervalDraws the event is OVERDUE.
  // The prediction does NOT name a color -- it flags that *some* color will
  // reach 4-ball, consistent with the event definition. All three colors
  // (RED/BLUE/GREEN) are candidates; colorBreakdown's lastPlayedDrawsAgo
  // carries per-color recency for the full picture.
  const NEXT_EVENT_ALERT_WITHIN = 4; // start countdown when <= this many draws remain
  let nextEventPrediction = null;
  if (avgIntervalDraws !== null && lastEventDrawsAgo !== null) {
    const drawsRemaining = Math.round(avgIntervalDraws - lastEventDrawsAgo);
    const overdueByDraws = drawsRemaining < 0 ? Math.abs(drawsRemaining) : 0;
    const isOverdue = drawsRemaining <= 0;
    const inWindow = drawsRemaining <= NEXT_EVENT_ALERT_WITHIN;
    nextEventPrediction = {
      active: inWindow || isOverdue,
      isOverdue,
      drawsRemaining: Math.max(0, drawsRemaining),
      overdueByDraws,
      alertWithin: NEXT_EVENT_ALERT_WITHIN,
      statusLabel: isOverdue
        ? `OVERDUE — ${overdueByDraws} draw(s) past due`
        : drawsRemaining === 0
          ? 'IMMINENT'
          : `Due in ~${drawsRemaining} draw(s)`,
      countdownLabel: isOverdue
        ? `OVERDUE (+${overdueByDraws})`
        : `~${drawsRemaining} draws`,
    };
  }

  const eventProbabilityPct = clamp(Math.round(
    (fourBallPressureScore * 0.6) + (recentRatePct * 0.4)
  ), 5, 95);

  const riskLevel = confidenceLabel === 'HIGH' && eventProbabilityPct >= 55 ? 'LOW'
    : confidenceLabel === 'LOW' ? 'HIGH'
    : 'MODERATE';

  const warningScore = eventProbabilityPct;
  const warningLevel = warningScore >= 60 ? 'ELEVATED' : warningScore >= 35 ? 'MODERATE' : 'LOW';

  const expectedWindow = computeExpectedWindow(
    intervalSignal.score, patternSignal.score, transitionSignal.score, drawsUntilNextEvent
  );

  const marketStateLabel = activeSeason ? 'ACTIVE 4-BALL SEASON'
    : fourBallPressureScore >= 60 ? 'BUILDING PRESSURE'
    : 'NO EDGE';

  // FIX -- gate override: whatever the raw pressure score alone would
  // suggest, operatorAction can never read as actionable while the gate
  // is closed (see gate above) -- so a caller can act on operatorAction
  // directly without separately re-deriving the same gating check.
  const operatorAction = !gateOpen ? 'NO ACTION'
    : fourBallPressureScore >= 70 ? 'WATCH CLOSELY'
    : fourBallPressureScore >= 45 ? 'MONITOR'
    : 'NO ACTION';

  const reasoning = activeSeason
    ? `4-ball events are in an active season: ${activeSeason.eventCount} events across the last ${activeSeason.spanDraws} draws, most recent ${activeSeason.mostRecentEventDrawsAgo} draw(s) ago.${nextEventPrediction && nextEventPrediction.active ? ` A 4-ball event (any color reaching 4 balls) is ${nextEventPrediction.isOverdue ? `overdue by ${nextEventPrediction.overdueByDraws} draw(s)` : `expected within the next ${nextEventPrediction.drawsRemaining} draw(s)`}.` : ''}`
    : lastEventDrawsAgo !== null
      ? `Last 4-ball event was ${lastEventDrawsAgo} draw(s) ago (${lastEventColor} played) against an average spacing of ${avgIntervalDraws != null ? avgIntervalDraws + ' draws' : 'an undetermined interval'}.${nextEventPrediction && nextEventPrediction.active ? ` Based on historical patterns, a 4-ball event is ${nextEventPrediction.isOverdue ? `overdue by ${nextEventPrediction.overdueByDraws} draw(s)` : `expected in the next ~${nextEventPrediction.drawsRemaining} draw(s)`} — all 3 colors are candidates (most recently played: ${lastEventColor}).` : ` No 4-ball event imminent (${drawsUntilNextEvent != null ? `~${drawsUntilNextEvent} draws remaining` : 'spacing undetermined'}).`}`
      : `No 4-ball events observed yet in the tracked window.`;
  const gatedReasoning = gateOpen ? reasoning : `${reasoning} (Gate CLOSED: ${gate.reason})`;

  return {
    available: total > 0,
    currentEventStreak,
    eventRatePct,
    recentRatePct,
    sampleSize: total,
    sufficientSample,
    detectedCycle,

    lastEvent: lastEventDrawId !== null ? {
      drawId: lastEventDrawId,
      drawsAgo: lastEventDrawsAgo,
      color: lastEventColor,
      shape: lastEventShapeStr
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
    // predictedNextColor is retained for the per-color breakdown panel
    // (which color has gone longest without playing 4-ball), but the
    // primary next-event prediction is nextEventPrediction (event-level:
    // a 4-ball event is due, not which specific color will play).
    // All three colors are candidates; colorBreakdown's lastPlayedDrawsAgo
    // carries per-color recency for the full picture.
    predictedNextColor: dueColor,
    nextEventPrediction,

    // FIX -- see FIX header above.
    gate,
    metricsGuide: buildMetricsGuide(),
    entryHitCounterAlignment: entrySignal.alignment,

    fourBallPressureScore,
    eventProbabilityPct,
    confidenceLabel,
    riskLevel,
    warningLevel,
    warningScore,
    drawsUntilNextEvent,
    expectedWindow,
    marketStateLabel,
    operatorAction,
    reasoning: gatedReasoning,

    signals: {
      frequency: frequencySignal,
      interval: intervalSignal,
      pattern: patternSignal,
      transition: transitionSignal,
      entry: entrySignal
    }
  };
}

module.exports = {
  analyzeFourBallColorNextEvent,
  isFourBallEvent,
  fourBallShape,
  computeEntrySignal,
  buildMetricsGuide
};
