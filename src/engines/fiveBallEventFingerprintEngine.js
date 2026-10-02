/**
 * 5-BALL EVENT FINGERPRINT ENGINE (Phase 2 extension of the 5-Ball
 * Research Lab)
 *
 * Implements the "really interesting part" from the approved architecture
 * that was originally deferred: "For every 5-ball event, analyze perhaps
 * 10 draws before + event + 10 draws after. That creates an event
 * fingerprint... The system can then study what tends to happen before a
 * 5-ball event." fiveBallHarvester.js (Phase 1) now captures that ±10
 * window at capture time (precedingWindow/followingWindow); this engine
 * is the FIRST consumer of it -- it turns each event's precedingWindow
 * into a compact feature vector and finds the most similar PAST events'
 * neighborhoods via cosine similarity, then reports what those past
 * events' colors turned out to be.
 *
 * REUSES, DOESN'T DUPLICATE: signatureVectorEngine.js already built this
 * exact architecture (normalize -> cosine similarity -> rank -> top-K ->
 * historical outcomes -> historicalAnalogueConfidence/clusterConfidence/
 * predictionConfidence) for the 3/4-ball "runway" world. That engine's
 * OWN feature vector (runwayFeatureEngine.js's FEATURE_KEYS: threeBall/
 * fourBallFrequency, gapSince3Ball, dominanceScore, etc.) is genuinely
 * 3/4-ball-specific and doesn't transfer to 5-ball neighborhoods, so this
 * file builds its OWN vector from the ±10-draw window Phase 1 now
 * captures -- but it reuses the exact same MATCHING ALGORITHM (via
 * core/statMath.js's cosineSimilarity, the same generic function
 * signatureVectorEngine.js itself calls) and the same three-figure
 * confidence naming convention, for consistency across this codebase.
 *
 * THE FEATURE VECTOR (6 dimensions, one pair per color): for a given
 * event's precedingWindow, count how many of those draws saw that color
 * reach a real win (3-ball, 4-ball, or 5-ball) -- "tierHits" -- and sum
 * that color's raw ball count across the window -- "ballSum". This
 * captures both HOW OFTEN and HOW STRONGLY each color was active
 * immediately before the event, without assuming any particular
 * relationship matters more than another -- the similarity matching
 * figures out which past neighborhoods actually resemble this one.
 *
 * HONESTY NOTE (same caveat signatureVectorEngine.js states for its own
 * matching, restated here because it applies identically): cosine
 * similarity is real, correctly-computed math, but "this neighborhood
 * resembles a past neighborhood" describes resemblance in engineered
 * features, not a proven causal or predictive relationship -- especially
 * with the small signature library 5-ball events will realistically ever
 * produce. Treat these confidences as "how familiar this setup looks,"
 * not a calibrated probability.
 *
 * PURE RECOMPUTE, NO PERSISTENT STATE: the entire signature library is
 * just every OTHER captured event's precedingWindow, already sitting in
 * fiveBallHarvest.eventLog -- nothing here needs its own memory.
 *
 * Only events with a FULL precedingWindow (exactly NEIGHBORHOOD_SIZE
 * draws) are used, on both sides of the comparison -- a partial window
 * (from very early in the captured history, before enough draws existed)
 * would make the comparison meaningless (a 3-draw window and a 10-draw
 * window are not directionally comparable vectors).
 */
'use strict';

const { HIERARCHY } = require('./fiveBallResearchLab');
const { cosineSimilarity } = require('../core/statMath');
const { NEIGHBORHOOD_SIZE, summarizeDraw } = require('./fiveBallHarvester');

const TOP_K = 5;
const MIN_LIBRARY_SIZE_FOR_MATCHING = 3; // below this, "matching" is just noise -- same bar signatureVectorEngine.js uses

// Fixed, documented divisors (not min/max scaling against the library,
// for the same reason signatureVectorEngine.js gives: every comparison's
// meaning would otherwise drift as the library grows). tierHits maxes
// out at NEIGHBORHOOD_SIZE (one hit per draw in the window); ballSum's
// divisor is a generous "typical max" (a color could in principle claim
// most of the balls across a 10-draw window).
const TIER_HITS_DIVISOR = NEIGHBORHOOD_SIZE;
const BALL_SUM_DIVISOR = NEIGHBORHOOD_SIZE * 6;

function hasRealWin(draw, color) {
  return draw && (draw.threeBallColor === color || draw.fourBallColor === color || draw.fiveBallColor === color);
}

/**
 * Builds the raw (unnormalized) 6-dimension feature vector from a
 * precedingWindow (array of summarized draws, chronological).
 */
function buildRawVector(window) {
  const vec = {};
  HIERARCHY.forEach(color => {
    vec[`${color}_tierHits`] = window.filter(d => hasRealWin(d, color)).length;
    vec[`${color}_ballSum`] = window.reduce((s, d) => s + ((d.colorCounts && d.colorCounts[color]) || 0), 0);
  });
  return vec;
}

function normalizeVector(rawVec) {
  const normalized = {};
  HIERARCHY.forEach(color => {
    normalized[`${color}_tierHits`] = (rawVec[`${color}_tierHits`] || 0) / TIER_HITS_DIVISOR;
    normalized[`${color}_ballSum`] = (rawVec[`${color}_ballSum`] || 0) / BALL_SUM_DIVISOR;
  });
  return normalized;
}

/**
 * Ranks one event's normalized vector against every OTHER qualifying
 * event's vector (full-window events only, excluding the event itself),
 * returning the top-K most similar past events and their actual outcome
 * colors.
 */
function rankMatches(queryVector, library, excludeDrawId) {
  const matches = [];
  for (const entry of library) {
    if (entry.drawId === excludeDrawId) continue;
    const similarity = cosineSimilarity(queryVector, entry.vector);
    matches.push({ drawId: entry.drawId, similarity, outcomeColor: entry.eventColor });
  }
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, TOP_K);
}

/**
 * Same three-figure confidence convention as signatureVectorEngine.js:
 *   - historicalAnalogueConfidence: the #1 match's similarity.
 *   - clusterConfidence: how much the top-K matches' actual outcomes
 *     AGREE with each other (not how similar they are).
 *   - predictionConfidence: a blend of the two.
 */
function scoreMatchSet(matches) {
  if (matches.length === 0) {
    return { historicalAnalogueConfidence: 0, clusterConfidence: 0, predictionConfidence: 0, majorityOutcome: null, topMatches: [] };
  }
  const historicalAnalogueConfidence = matches[0].similarity;
  const outcomeCounts = {};
  matches.forEach(m => { outcomeCounts[m.outcomeColor] = (outcomeCounts[m.outcomeColor] || 0) + 1; });
  const majority = Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1])[0];
  const clusterConfidence = Math.round((majority[1] / matches.length) * 100);
  const predictionConfidence = Math.round(historicalAnalogueConfidence * 0.6 + clusterConfidence * 0.4);
  return {
    historicalAnalogueConfidence,
    clusterConfidence,
    majorityOutcome: majority[0],
    predictionConfidence,
    topMatches: matches
  };
}

/**
 * Builds the CURRENT, still-forming trailing window's feature vector --
 * the live counterpart to buildRawVector(event.precedingWindow) above.
 * historicalDraws is newest-first (this codebase's standard convention);
 * summarizeDraw() expects the same draw shape captured events use, so
 * this reuses fiveBallHarvester.js's own summarizer for consistency
 * rather than re-deriving field access here.
 */
function buildLiveRawVector(historicalDraws) {
  // Oldest-first, to match precedingWindow's own chronological convention.
  const window = (historicalDraws || []).slice(0, NEIGHBORHOOD_SIZE).map(summarizeDraw).reverse();
  return { window, vector: window.length > 0 ? buildRawVector(window) : null };
}

/**
 * LIVE MATCH -- the follow-up explicitly deferred in this file's header:
 * "Matching the current LIVE, still-forming window... needs a live
 * vector built from historicalDraws directly rather than from a captured
 * event." Answers a genuinely forward-looking question -- "does the
 * market's current lead-up resemble the lead-up to past 5-ball events,
 * and if so, which color did those turn out to be" -- as opposed to
 * queryEvent above, which only ever re-examines the most recent ALREADY-
 * CAPTURED event's own lead-up after the fact.
 *
 * Requires a FULL NEIGHBORHOOD_SIZE-draw window (same qualifying rule as
 * the historical library) -- an early-history partial window is excluded
 * for the same not-directionally-comparable reason queryEvent's own
 * events are filtered.
 */
function evaluateLiveMatch(historicalDraws, library) {
  const { window, vector: rawVector } = buildLiveRawVector(historicalDraws);
  if (!rawVector || window.length < NEIGHBORHOOD_SIZE) {
    return {
      ready: false,
      windowSize: window.length,
      reasoning: `Only ${window.length} of ${NEIGHBORHOOD_SIZE} draws are available for the current live window -- too early in observed history to compare.`
    };
  }
  const liveVector = normalizeVector(rawVector);
  // excludeDrawId: null -- the live window isn't itself a captured event,
  // so nothing in the library needs excluding on that basis.
  const matches = rankMatches(liveVector, library, null);
  const scored = scoreMatchSet(matches);
  const reasoning = matches.length > 0
    ? `Current market lead-up most resembles the run-up to the ${matches[0].outcomeColor} event at draw ${matches[0].drawId} (${matches[0].similarity}% similar). Top-${matches.length} match agreement: ${scored.clusterConfidence}% favor ${scored.majorityOutcome}. This is a forward-looking read of the CURRENT window, not a re-examination of a past event.`
    : 'No comparable historical neighborhoods found yet.';
  return {
    ready: true,
    windowSize: window.length,
    historicalAnalogueConfidence: scored.historicalAnalogueConfidence,
    clusterConfidence: scored.clusterConfidence,
    predictionConfidence: scored.predictionConfidence,
    majorityOutcome: scored.majorityOutcome,
    topMatches: scored.topMatches,
    reasoning
  };
}

/**
 * Main entry point, called once per council cycle. fiveBallHarvest is
 * Phase 1's own full result (read-only). historicalDraws (optional, for
 * backward compatibility with any other caller) enables the live-window
 * match above -- omit it and liveMatch is simply not computed.
 */
function evaluateFiveBallEventFingerprint(fiveBallHarvest, historicalDraws) {
  const eventLog = (fiveBallHarvest && fiveBallHarvest.eventLog) || [];

  const qualifyingEvents = eventLog.filter(e => Array.isArray(e.precedingWindow) && e.precedingWindow.length === NEIGHBORHOOD_SIZE);

  if (qualifyingEvents.length < MIN_LIBRARY_SIZE_FOR_MATCHING + 1) {
    return {
      engine: '5-Ball Event Fingerprint Engine',
      ready: false,
      neighborhoodSize: NEIGHBORHOOD_SIZE,
      qualifyingEventCount: qualifyingEvents.length,
      reasoning: `Only ${qualifyingEvents.length} event(s) have a full ${NEIGHBORHOOD_SIZE}-draw preceding window so far -- need at least ${MIN_LIBRARY_SIZE_FOR_MATCHING + 1} (one to query, ${MIN_LIBRARY_SIZE_FOR_MATCHING} to match against) before fingerprint matching means anything.`
    };
  }

  // Build the library once: every qualifying event's normalized vector.
  const library = qualifyingEvents.map(e => ({
    drawId: e.drawId,
    eventColor: e.eventColor,
    vector: normalizeVector(buildRawVector(e.precedingWindow))
  }));

  // Query using the MOST RECENT qualifying event -- "does this event's
  // own lead-up resemble past events, and if so what did they turn out
  // to be" (a retrospective read of an already-captured event).
  const queryEvent = library[0];
  const matches = rankMatches(queryEvent.vector, library, queryEvent.drawId);
  const scored = scoreMatchSet(matches);

  const reasoning = matches.length > 0
    ? `Most recent event (${queryEvent.eventColor} at draw ${queryEvent.drawId}): best historical analogue is draw ${matches[0].drawId} (${matches[0].similarity}% similar, outcome ${matches[0].outcomeColor}). Top-${matches.length} match agreement: ${scored.clusterConfidence}% favor ${scored.majorityOutcome}. Treat this as "how familiar this lead-up looks," not a calibrated prediction -- see this engine's header.`
    : 'No comparable historical neighborhoods found yet.';

  // liveMatch -- the forward-looking counterpart (see evaluateLiveMatch's
  // own header just above). Only computed if historicalDraws was passed;
  // omitted (not a hard error) if the caller didn't provide it, so this
  // stays backward-compatible with any existing call site.
  const liveMatch = historicalDraws ? evaluateLiveMatch(historicalDraws, library) : null;

  return {
    engine: '5-Ball Event Fingerprint Engine',
    ready: true,
    neighborhoodSize: NEIGHBORHOOD_SIZE,
    qualifyingEventCount: qualifyingEvents.length,
    queryEvent: { drawId: queryEvent.drawId, eventColor: queryEvent.eventColor },
    historicalAnalogueConfidence: scored.historicalAnalogueConfidence,
    clusterConfidence: scored.clusterConfidence,
    predictionConfidence: scored.predictionConfidence,
    majorityOutcome: scored.majorityOutcome,
    topMatches: scored.topMatches,
    liveMatch,
    reasoning
  };
}

module.exports = {
  TOP_K,
  MIN_LIBRARY_SIZE_FOR_MATCHING,
  buildRawVector,
  buildLiveRawVector,
  evaluateLiveMatch,
  normalizeVector,
  rankMatches,
  scoreMatchSet,
  evaluateFiveBallEventFingerprint
};
