/**
 * ============================================================
 *  4-BALL → ZERO-COLOR CORRELATION ENGINE
 * ============================================================
 *
 * PURPOSE:
 * This engine does NOT replace zeroColorEngine.js. It is a dedicated
 * intelligence layer that studies the RELATIONSHIP between 4-ball events
 * and zero-color events, and uses that relationship to refine the
 * prediction of when a zero-color event is imminent.
 *
 * CORE INSIGHT:
 * When one color reaches 4+ balls, the remaining 2 colors are fighting
 * over at most 2 balls. That structural squeeze means at least one of
 * those remaining colors is statistically likely to appear 0 or 1 times.
 * This engine tracks whether that squeeze actually materialises into a
 * true zero event -- and exactly when within the following 10-draw window.
 *
 * EVENT DEFINITIONS (read-only, never recomputed):
 *   - 4-ball event:   draw.fourBallColor !== null
 *   - zero event:     any color in draw.colorCounts has value 0
 *
 * WHAT THIS ENGINE TRACKS:
 *   1. BASE RATE: How often a zero event appears within a 10-draw window
 *      following a 4-ball event (vs. the unconditional zero base rate).
 *
 *   2. FINGERPRINTS: The exact color-count shape of a 4-ball draw (e.g.
 *      RED:4-BLUE:1-GREEN:1, RED:5-BLUE:1-GREEN:0, etc.) and which
 *      shape fingerprints most reliably precede a zero event, and how
 *      soon.
 *
 *   3. WHICH COLOR GOES MISSING: After a 4-ball event on color X, is the
 *      next zero event most often the SAME color X (consolidation), or
 *      one of the SQUEEZED colors (pressure transfer), or either?
 *
 *   4. REPEAT PATTERNS: How often zero events cluster (2+ within 10
 *      draws of a single 4-ball trigger), and whether the 4-ball color
 *      itself predicts the repeat rate.
 *
 *   5. WINDOW DENSITY: Within the 10-draw post-4-ball window, at what
 *      draw position does the first zero event most commonly land
 *      (positions 1–10), and whether position 1 (the very next draw)
 *      is elevated.
 *
 *   6. CURRENT ALERT: Given the most recent 4-ball event, where are we
 *      in the post-4-ball window right now, what is the estimated
 *      probability that a zero event arrives in the next N draws, and
 *      which color is the most likely candidate.
 *
 * ABSOLUTE SEPARATION RULE (matching every other engine in this codebase):
 * Pure, read-only, observational engine. Never votes. Never feeds back
 * into zeroColorEngine.js or any gate/weight. It emits advisory
 * intelligence only -- the existing engines are unchanged.
 *
 * INTEGRATION (council.js):
 *   const { analyzeFourBallZeroCorrelation } = require('../engines/fourBallZeroCorrelationEngine');
 *   // After analyzeFourBallColorNextEvent and analyzeZeroColor have run:
 *   const fourBallZeroCorrelation = analyzeFourBallZeroCorrelation(historicalDraws);
 *   // Add to snapshot: fourBallZeroCorrelation
 *
 * INTEGRATION (store.js): No persistent state required -- this engine
 * derives everything from historicalDraws in a single pass. If the
 * hit-counter log needs to be added later, the same pending/resolve
 * pattern as zeroColorHitCounter.js applies cleanly.
 *
 * historicalDraws convention: newest-first (index 0 = most recent),
 * matching every other engine in this codebase.
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');
const { clamp } = require('../core/isotonic');

// ── Constants ────────────────────────────────────────────────────────────────

/** How many draws after a 4-ball event to watch for a zero event. */
const POST_WINDOW = 10;

/**
 * Minimum number of historical 4-ball events required before any
 * correlation claims are made. Below this, every signal degrades
 * gracefully to null / low-confidence defaults.
 */
const MIN_SAMPLE = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

function missingColorsOf(draw) {
  if (!draw || !draw.colorCounts) return [];
  return HIERARCHY.filter(c => (draw.colorCounts[c] || 0) === 0);
}

function isZeroEvent(draw) {
  return missingColorsOf(draw).length > 0;
}

function isFourBallEvent(draw) {
  return !!(draw && draw.fourBallColor);
}

/**
 * Returns a canonical shape fingerprint string for a 4-ball draw:
 * "R-B-G" where R/B/G are the sorted descending ball counts.
 * The dominant color is always first (highest count), so:
 *   RED:4, BLUE:1, GREEN:1 → "4-1-1"
 *   RED:5, BLUE:0, GREEN:1 → "5-1-0"   ← already a zero-overlap event
 * Includes which color was the 4-ball winner so operators can see e.g.
 * "RED:4-1-1" separately from "BLUE:4-1-1".
 */
function fourBallFingerprint(draw) {
  if (!draw || !draw.fourBallColor || !draw.colorCounts) return null;
  const dominant = draw.fourBallColor;
  const others = HIERARCHY.filter(c => c !== dominant);
  const domCount = draw.colorCounts[dominant] || 0;
  // Sort the two non-dominant counts descending for a canonical shape.
  const otherCounts = others.map(c => draw.colorCounts[c] || 0).sort((a, b) => b - a);
  return `${dominant}:${domCount}-${otherCounts[0]}-${otherCounts[1]}`;
}

/** Simplified numeric shape "N-N-N" without the color prefix, for grouping. */
function numericShape(draw) {
  if (!draw || !draw.fourBallColor || !draw.colorCounts) return null;
  const dominant = draw.fourBallColor;
  const others = HIERARCHY.filter(c => c !== dominant);
  const domCount = draw.colorCounts[dominant] || 0;
  const otherCounts = others.map(c => draw.colorCounts[c] || 0).sort((a, b) => b - a);
  return `${domCount}-${otherCounts[0]}-${otherCounts[1]}`;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[m - 1] + sorted[m]) / 2
    : sorted[m];
}

function average(arr) {
  if (!arr || arr.length === 0) return null;
  return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
}

function pct(num, denom) {
  if (!denom) return 0;
  return Math.round((num / denom) * 1000) / 10;
}

// ── Core scan: build a list of all 4-ball events with their post-window outcomes ──

/**
 * Walks historicalDraws (newest-first) and, for every 4-ball event found,
 * scans the PRECEDING draws (older indices in the array) for zero events
 * within POST_WINDOW steps.
 *
 * Returns an array of event records, each describing one 4-ball event
 * and what happened in the next POST_WINDOW draws.
 *
 * Note on direction: draws[0] is newest. A draw at index i happened
 * AFTER a draw at index i+1. So "what comes after draw[i]" means
 * draws[i-1], draws[i-2], ..., draws[i-POST_WINDOW].
 */
function buildEventRecords(draws) {
  const records = [];

  for (let i = 0; i < draws.length; i++) {
    const draw = draws[i];
    if (!isFourBallEvent(draw)) continue;

    const fp = fourBallFingerprint(draw);
    const shape = numericShape(draw);
    const fourBallColor = draw.fourBallColor;

    // Scan the POST_WINDOW draws that come AFTER this 4-ball draw
    // (lower indices = more recent = future from this draw's perspective)
    const windowDraws = draws.slice(Math.max(0, i - POST_WINDOW), i);
    // Reverse so index 0 in windowDraws = 1 draw after the 4-ball event
    const orderedWindow = [...windowDraws].reverse();

    const zeroPositions = []; // 1-based positions within window where zeros landed
    const missingColorsList = []; // which color was missing at each zero
    let firstZeroAt = null;

    for (let w = 0; w < orderedWindow.length; w++) {
      const wd = orderedWindow[w];
      if (isZeroEvent(wd)) {
        const pos = w + 1;
        const missing = missingColorsOf(wd);
        zeroPositions.push(pos);
        missingColorsList.push(...missing);
        if (firstZeroAt === null) firstZeroAt = pos;
      }
    }

    // Also flag if this 4-ball draw ITSELF is simultaneously a zero event
    // (e.g. RED:5-BLUE:1-GREEN:0 — dominant color took 5, left green with 0).
    // These are the sharpest squeeze fingerprints.
    const selfIsZero = isZeroEvent(draw);
    const selfMissingColors = selfIsZero ? missingColorsOf(draw) : [];

    // Was the missing color the SAME as the 4-ball winner (consolidation)?
    // Or a SQUEEZED (non-dominant) color (pressure transfer)?
    const missingSameAsFourBall = missingColorsList.filter(c => c === fourBallColor).length;
    const missingSqueezed = missingColorsList.filter(c => c !== fourBallColor).length;

    records.push({
      drawId: draw.drawId,
      drawIndex: i,
      fourBallColor,
      fingerprint: fp,
      shape,
      colorCounts: { ...draw.colorCounts },
      selfIsZero,
      selfMissingColors,
      windowSize: orderedWindow.length,
      zeroCount: zeroPositions.length,
      zeroPositions,
      missingColorsList,
      missingSameAsFourBall,
      missingSqueezed,
      firstZeroAt,
      hadZeroInWindow: zeroPositions.length > 0
    });
  }

  return records;
}

// ── Signal 1: Base rate comparison ──────────────────────────────────────────

/**
 * Computes:
 *  - unconditionalZeroRatePct: overall zero event rate across all draws
 *  - conditionalZeroRatePct: rate of zero events within POST_WINDOW draws
 *    after any 4-ball event (% of 4-ball events where at least one zero
 *    landed in the next 10 draws)
 *  - upliftFactor: conditional / unconditional — how much higher the zero
 *    chance is after a 4-ball event
 */
function computeBaseRateSignal(draws, records) {
  const total = draws.length;
  const totalZeros = draws.filter(isZeroEvent).length;
  const unconditional = pct(totalZeros, total);

  if (records.length < MIN_SAMPLE) {
    return {
      score: 30,
      unconditionalZeroRatePct: unconditional,
      conditionalZeroRatePct: null,
      upliftFactor: null,
      note: `Insufficient 4-ball event sample (${records.length}/${MIN_SAMPLE} required).`
    };
  }

  const withZero = records.filter(r => r.hadZeroInWindow).length;
  const conditional = pct(withZero, records.length);
  const uplift = unconditional > 0 ? Math.round((conditional / unconditional) * 10) / 10 : null;

  // Score: 50 baseline, boosted by how much the uplift exceeds 1.0
  const score = uplift !== null
    ? clamp(Math.round(50 + (uplift - 1) * 25), 0, 100)
    : 30;

  return {
    score,
    unconditionalZeroRatePct: unconditional,
    conditionalZeroRatePct: conditional,
    upliftFactor: uplift,
    totalFourBallEvents: records.length,
    fourBallEventsWithZeroFollow: withZero
  };
}

// ── Signal 2: Window density & position distribution ────────────────────────

/**
 * Across all 4-ball events, for each position 1–10, what fraction of
 * events produced a zero event at exactly that draw position?
 * Also computes the modal (most common) position and whether position 1
 * (very next draw) is elevated.
 */
function computeWindowDensitySignal(records) {
  if (records.length < MIN_SAMPLE) {
    return {
      score: 30,
      positionFrequencies: null,
      peakPosition: null,
      immediateNextRatePct: null,
      avgFirstZeroPosition: null,
      medianFirstZeroPosition: null,
      note: 'Insufficient sample.'
    };
  }

  const posFreq = {};
  for (let p = 1; p <= POST_WINDOW; p++) posFreq[p] = 0;

  const firstZeroPositions = [];

  for (const r of records) {
    for (const pos of r.zeroPositions) {
      if (pos >= 1 && pos <= POST_WINDOW) posFreq[pos]++;
    }
    if (r.firstZeroAt !== null) firstZeroPositions.push(r.firstZeroAt);
  }

  // Normalize to percentage of 4-ball events
  const posFreqPct = {};
  for (let p = 1; p <= POST_WINDOW; p++) {
    posFreqPct[p] = pct(posFreq[p], records.length);
  }

  // Peak position
  let peakPos = 1;
  let peakVal = 0;
  for (let p = 1; p <= POST_WINDOW; p++) {
    if (posFreqPct[p] > peakVal) {
      peakVal = posFreqPct[p];
      peakPos = p;
    }
  }

  const immediateNextRatePct = posFreqPct[1] || 0;
  const avgFirstZero = average(firstZeroPositions);
  const medFirstZero = median(firstZeroPositions);

  // Score: higher when zero events cluster in the early window (positions 1-3)
  const earlyWeight = (posFreqPct[1] + posFreqPct[2] + posFreqPct[3]) / 3;
  const score = clamp(Math.round(30 + earlyWeight * 1.5), 0, 100);

  return {
    score,
    positionFrequencies: posFreqPct,
    peakPosition: peakPos,
    peakPositionRatePct: peakVal,
    immediateNextRatePct,
    avgFirstZeroPosition: avgFirstZero,
    medianFirstZeroPosition: medFirstZero,
    sampleSize: firstZeroPositions.length
  };
}

// ── Signal 3: Fingerprint reliability ───────────────────────────────────────

/**
 * Groups 4-ball events by their numeric shape fingerprint (e.g. "4-1-1",
 * "5-1-0", "6-0-0") and computes per-fingerprint:
 *   - how often a zero event followed within POST_WINDOW draws
 *   - the average first-zero position
 *   - whether the shape is "auto-zero" (the 4-ball draw itself has a
 *     missing color -- e.g. 5-1-0 or 6-0-0)
 */
function computeFingerprintSignal(records) {
  if (records.length < MIN_SAMPLE) {
    return {
      score: 30,
      fingerprintBreakdown: null,
      highestRiskShape: null,
      currentFingerprintRisk: null,
      note: 'Insufficient sample.'
    };
  }

  const byShape = {};
  for (const r of records) {
    const key = r.shape;
    if (!byShape[key]) {
      byShape[key] = {
        shape: key,
        count: 0,
        withZero: 0,
        autoZero: 0,
        firstZeroPositions: []
      };
    }
    byShape[key].count++;
    if (r.hadZeroInWindow) byShape[key].withZero++;
    if (r.selfIsZero) byShape[key].autoZero++;
    if (r.firstZeroAt !== null) byShape[key].firstZeroPositions.push(r.firstZeroAt);
  }

  const breakdown = Object.values(byShape).map(s => ({
    shape: s.shape,
    occurrences: s.count,
    autoZeroCount: s.autoZero,
    zeroFollowCount: s.withZero,
    zeroFollowRatePct: pct(s.withZero, s.count),
    avgFirstZeroPosition: average(s.firstZeroPositions),
    isHighRisk: pct(s.withZero, s.count) >= 70
  })).sort((a, b) => b.zeroFollowRatePct - a.zeroFollowRatePct);

  const highestRisk = breakdown[0] || null;

  // Score: weighted average of zeroFollowRatePct across all shapes seen
  const weightedRate = records.length > 0
    ? records.filter(r => r.hadZeroInWindow).length / records.length * 100
    : 0;
  const score = clamp(Math.round(weightedRate), 0, 100);

  return {
    score,
    fingerprintBreakdown: breakdown,
    highestRiskShape: highestRisk ? highestRisk.shape : null,
    highestRiskRatePct: highestRisk ? highestRisk.zeroFollowRatePct : null
  };
}

// ── Signal 4: Missing color direction (consolidation vs. pressure transfer) ──

/**
 * After a 4-ball event on color X:
 *   CONSOLIDATION: the SAME color X goes missing in the next zero event
 *     (extreme dominance -- color squeezed others out entirely)
 *   PRESSURE_TRANSFER: one of the non-dominant colors goes missing
 *     (the 4-ball winner "stole" from them and they hit empty)
 *   EITHER: both patterns occur with roughly equal frequency
 *
 * Also tracks per-color: which color most commonly follows each 4-ball winner.
 */
function computeDirectionSignal(records) {
  if (records.length < MIN_SAMPLE) {
    return {
      score: 30,
      dominantDirection: null,
      consolidationRatePct: null,
      pressureTransferRatePct: null,
      perColorDirections: null,
      note: 'Insufficient sample.'
    };
  }

  let totalZeroEvents = 0;
  let consolidation = 0;
  let pressureTransfer = 0;

  // Per 4-ball winner color: which colors go missing next
  const perWinnerMissing = { RED: {}, BLUE: {}, GREEN: {} };
  for (const c of HIERARCHY) {
    perWinnerMissing[c] = { RED: 0, BLUE: 0, GREEN: 0 };
  }

  for (const r of records) {
    for (const mc of r.missingColorsList) {
      totalZeroEvents++;
      if (mc === r.fourBallColor) consolidation++;
      else pressureTransfer++;
      if (perWinnerMissing[r.fourBallColor]) {
        perWinnerMissing[r.fourBallColor][mc] = (perWinnerMissing[r.fourBallColor][mc] || 0) + 1;
      }
    }
  }

  if (totalZeroEvents === 0) {
    return {
      score: 30,
      dominantDirection: null,
      consolidationRatePct: 0,
      pressureTransferRatePct: 0,
      perColorDirections: perWinnerMissing,
      note: 'No zero events found in post-4-ball windows yet.'
    };
  }

  const consolidationPct = pct(consolidation, totalZeroEvents);
  const transferPct = pct(pressureTransfer, totalZeroEvents);
  const dominantDirection = consolidationPct > transferPct + 10
    ? 'CONSOLIDATION'
    : transferPct > consolidationPct + 10
      ? 'PRESSURE_TRANSFER'
      : 'MIXED';

  // Per winner: which color is the most likely missing candidate
  const perColorDirections = {};
  for (const winner of HIERARCHY) {
    const counts = perWinnerMissing[winner];
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    if (total === 0) {
      perColorDirections[winner] = { total: 0, likelyMissing: null, breakdown: counts };
    } else {
      const likelyMissing = HIERARCHY.reduce((best, c) =>
        (counts[c] || 0) > (counts[best] || 0) ? c : best, HIERARCHY[0]);
      const breakdown = {};
      for (const c of HIERARCHY) breakdown[c] = { count: counts[c] || 0, pct: pct(counts[c] || 0, total) };
      perColorDirections[winner] = { total, likelyMissing, breakdown };
    }
  }

  const score = clamp(
    Math.round(dominantDirection === 'CONSOLIDATION' ? consolidationPct * 0.8
      : dominantDirection === 'PRESSURE_TRANSFER' ? transferPct * 0.8
      : 50), 0, 100
  );

  return {
    score,
    dominantDirection,
    consolidationRatePct: consolidationPct,
    pressureTransferRatePct: transferPct,
    totalZeroObservations: totalZeroEvents,
    perColorDirections
  };
}

// ── Signal 5: Repeat / cluster pattern within a single post-4-ball window ───

/**
 * How often do TWO OR MORE zero events land within a single POST_WINDOW
 * window after one 4-ball event? This is the "cluster" phenomenon the
 * brief describes.
 */
function computeClusterSignal(records) {
  if (records.length < MIN_SAMPLE) {
    return {
      score: 30,
      clusterRatePct: null,
      avgZerosPerWindow: null,
      maxZerosInWindow: null,
      singleZeroRatePct: null,
      note: 'Insufficient sample.'
    };
  }

  const clusterCount = records.filter(r => r.zeroCount >= 2).length;
  const singleCount = records.filter(r => r.zeroCount === 1).length;
  const zeroCountsAll = records.map(r => r.zeroCount);

  const clusterRatePct = pct(clusterCount, records.length);
  const singleRatePct = pct(singleCount, records.length);
  const avgZeros = average(zeroCountsAll);
  const maxZeros = Math.max(...zeroCountsAll, 0);

  const score = clamp(Math.round(clusterRatePct), 0, 100);

  return {
    score,
    clusterRatePct,
    singleZeroRatePct: singleRatePct,
    avgZerosPerWindow: avgZeros,
    maxZerosInWindow: maxZeros,
    clusterCount,
    singleCount,
    noZeroCount: records.filter(r => r.zeroCount === 0).length
  };
}

// ── Current Alert: where are we RIGHT NOW in a post-4-ball window? ───────────

/**
 * Finds the most recent 4-ball event in historicalDraws and reports:
 *   - How many draws ago it happened (drawsAgo)
 *   - Whether we are still inside the POST_WINDOW (active: true/false)
 *   - If active: how many draws remain in the window
 *   - The fingerprint / shape of that 4-ball draw
 *   - Whether a zero event has already landed in the current window
 *     (consumed = true: the expected zero may have already happened)
 *   - The estimated probability that a zero still lands in the
 *     remaining window, conditioned on the observed historical rate
 *     for the same remaining-window length
 *   - Which color is the most likely missing candidate
 */
function buildCurrentAlert(draws, records, directionSignal) {
  // Find the most recent 4-ball event
  let mostRecentFourBallIdx = null;
  for (let i = 0; i < draws.length; i++) {
    if (isFourBallEvent(draws[i])) {
      mostRecentFourBallIdx = i;
      break;
    }
  }

  if (mostRecentFourBallIdx === null) {
    return {
      active: false,
      reason: 'No 4-ball event found in draw history.',
      drawsAgo: null,
      windowRemaining: null,
      fingerprint: null,
      shape: null,
      fourBallColor: null,
      zeroAlreadyLanded: null,
      zeroesLandedInWindow: 0,
      estimatedZeroRemainingPct: null,
      likelyMissingColor: null,
      alertLevel: 'NONE'
    };
  }

  // drawsAgo: index in the array = draws since that draw (index 0 = just happened)
  const drawsAgo = mostRecentFourBallIdx;
  const active = drawsAgo < POST_WINDOW;
  const draw4b = draws[mostRecentFourBallIdx];
  const fp = fourBallFingerprint(draw4b);
  const shape = numericShape(draw4b);
  const fourBallColor = draw4b.fourBallColor;

  // Count zero events that have already landed in this window
  // (draws more recent than the 4-ball draw = lower indices)
  const windowSoFar = draws.slice(0, mostRecentFourBallIdx).slice(0, POST_WINDOW);
  const zeroesLanded = windowSoFar.filter(isZeroEvent).length;
  const zeroAlreadyLanded = zeroesLanded > 0;

  const windowRemaining = active ? POST_WINDOW - drawsAgo : 0;

  // Estimate remaining probability:
  // Use historical rate for "zero event appearing in (windowRemaining) draws"
  // from all records where the same shape was observed (fallback to all records)
  let estimatedRemainingPct = null;
  if (active && records.length >= MIN_SAMPLE) {
    const shapeRecords = records.filter(r => r.shape === shape);
    const baseRecords = shapeRecords.length >= 3 ? shapeRecords : records;

    // Historical rate: among events where firstZeroAt > (drawsAgo), i.e.
    // the zero had not yet appeared by this point in the window, how many
    // eventually had a zero in the remaining draws?
    const notYetTriggered = baseRecords.filter(r =>
      r.firstZeroAt === null || r.firstZeroAt > drawsAgo
    );
    const stillHitInRemaining = notYetTriggered.filter(r =>
      r.firstZeroAt !== null && r.firstZeroAt <= POST_WINDOW
    );
    estimatedRemainingPct = notYetTriggered.length >= 3
      ? pct(stillHitInRemaining.length, notYetTriggered.length)
      : null;
  }

  // Most likely missing color given the 4-ball winner
  let likelyMissingColor = null;
  if (directionSignal && directionSignal.perColorDirections && fourBallColor) {
    const dir = directionSignal.perColorDirections[fourBallColor];
    if (dir && dir.likelyMissing) likelyMissingColor = dir.likelyMissing;
  }

  // Alert level
  const alertLevel = !active ? 'EXPIRED'
    : zeroAlreadyLanded && windowRemaining > 0 ? 'POSSIBLE_REPEAT'
    : estimatedRemainingPct !== null && estimatedRemainingPct >= 60 ? 'HIGH'
    : estimatedRemainingPct !== null && estimatedRemainingPct >= 35 ? 'MODERATE'
    : active ? 'LOW'
    : 'NONE';

  return {
    active,
    drawsAgo,
    windowRemaining,
    fingerprint: fp,
    shape,
    fourBallColor,
    zeroAlreadyLanded,
    zeroesLandedInWindow: zeroesLanded,
    estimatedZeroRemainingPct: estimatedRemainingPct,
    likelyMissingColor,
    alertLevel,
    reason: active
      ? `Last 4-ball event (${fourBallColor}) was ${drawsAgo} draw(s) ago. ${windowRemaining} draw(s) remain in the observation window.`
      : `Last 4-ball event (${fourBallColor}) was ${drawsAgo} draw(s) ago -- outside the ${POST_WINDOW}-draw window.`
  };
}

// ── Composite confidence score ────────────────────────────────────────────────

function computeCompositeScore(baseRate, windowDensity, fingerprint, direction, cluster) {
  return clamp(Math.round(
    baseRate.score * 0.30 +
    fingerprint.score * 0.25 +
    windowDensity.score * 0.20 +
    direction.score * 0.15 +
    cluster.score * 0.10
  ), 0, 100);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Full analysis. Returns a self-contained intelligence package that can
 * be emitted as `fourBallZeroCorrelation` in the council snapshot.
 *
 * @param {Array} historicalDraws - newest-first draw array from store.js
 * @returns {Object} correlation intelligence package
 */
function analyzeFourBallZeroCorrelation(historicalDraws) {
  const draws = historicalDraws || [];
  const total = draws.length;

  if (total === 0) {
    return {
      engine: 'FourBallZeroCorrelationEngine',
      available: false,
      sampleSize: 0,
      sufficientSample: false,
      reason: 'No draw history available.',
      currentAlert: { active: false, alertLevel: 'NONE', reason: 'No draws.' }
    };
  }

  // Build the core event records (one per 4-ball event)
  const records = buildEventRecords(draws);
  const sufficientSample = records.length >= MIN_SAMPLE;

  // ── Five intelligence signals ──────────────────────────────────────────
  const baseRateSignal = computeBaseRateSignal(draws, records);
  const windowDensitySignal = computeWindowDensitySignal(records);
  const fingerprintSignal = computeFingerprintSignal(records);
  const directionSignal = computeDirectionSignal(records);
  const clusterSignal = computeClusterSignal(records);

  // ── Current window alert ───────────────────────────────────────────────
  const currentAlert = buildCurrentAlert(draws, records, directionSignal);

  // ── Overall composite score ────────────────────────────────────────────
  const compositeScore = computeCompositeScore(
    baseRateSignal, windowDensitySignal, fingerprintSignal,
    directionSignal, clusterSignal
  );

  const confidenceLabel = !sufficientSample ? 'LOW'
    : compositeScore >= 65 ? 'HIGH'
    : compositeScore >= 40 ? 'MEDIUM'
    : 'LOW';

  // ── Operator-facing reasoning ──────────────────────────────────────────
  let reasoning;
  if (!sufficientSample) {
    reasoning = `Insufficient 4-ball event sample (${records.length} observed; ${MIN_SAMPLE} required). Accumulate more data before trusting correlation signals.`;
  } else {
    const uplift = baseRateSignal.upliftFactor;
    const direction = directionSignal.dominantDirection;
    const alert = currentAlert;
    reasoning =
      `Over ${records.length} 4-ball events, a zero event followed within ${POST_WINDOW} draws ` +
      `${baseRateSignal.conditionalZeroRatePct}% of the time ` +
      `(vs. ${baseRateSignal.unconditionalZeroRatePct}% unconditional baseline, ` +
      `${uplift !== null ? uplift + 'x uplift' : 'uplift undetermined'}). ` +
      `The dominant direction is ${direction || 'UNKNOWN'}: ` +
      `${directionSignal.pressureTransferRatePct}% of zero events hit a squeezed color, ` +
      `${directionSignal.consolidationRatePct}% hit the 4-ball winner itself. ` +
      (alert.active
        ? `CURRENT WINDOW: ${alert.drawsAgo} draw(s) into a ${POST_WINDOW}-draw post-4-ball window ` +
          `(${alert.fourBallColor} was dominant, shape ${alert.shape}). ` +
          (alert.zeroAlreadyLanded
            ? `${alert.zeroesLandedInWindow} zero event(s) have already landed this window. `
            : `No zero event has landed yet this window. `) +
          `Alert level: ${alert.alertLevel}. ` +
          (alert.likelyMissingColor
            ? `Most likely missing color if a zero arrives: ${alert.likelyMissingColor}.`
            : '')
        : `No active 4-ball window (last 4-ball event was ${currentAlert.drawsAgo !== null ? currentAlert.drawsAgo + ' draws ago' : 'unknown'}).`);
  }

  return {
    engine: 'FourBallZeroCorrelationEngine',
    available: true,
    sampleSize: total,
    fourBallEventCount: records.length,
    sufficientSample,
    postWindowSize: POST_WINDOW,

    compositeScore,
    confidenceLabel,

    currentAlert,

    signals: {
      baseRate: baseRateSignal,
      windowDensity: windowDensitySignal,
      fingerprint: fingerprintSignal,
      direction: directionSignal,
      cluster: clusterSignal
    },

    reasoning
  };
}

module.exports = {
  analyzeFourBallZeroCorrelation,
  // Exported helpers for unit testing / reuse in hit-counter if added later
  buildEventRecords,
  fourBallFingerprint,
  isZeroEvent,
  isFourBallEvent,
  POST_WINDOW,
  MIN_SAMPLE
};
