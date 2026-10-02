/**
 * TIE NEXT EVENT / ENTRY TIMING ENGINE (Tie-NEI) — v1.0
 *
 * PURPOSE
 * -------
 * Downstream timing analyst layered ON TOP of tieEngine.js's analyzeTies()
 * output -- not a replacement for it and not another tie-detection gate.
 * Its single question:
 *
 *   "Given how tie-to-tie spacing has actually behaved -- sometimes 4, 5,
 *    7, even 22 draws apart, sometimes repeating back-to-back every 2-3
 *    draws for a whole season -- is THIS gap, right now, a good moment to
 *    enter a tie trade, or not?"
 *
 * tieEngine.js already answers "how likely is a tie soon" (tiePressure,
 * tieProbabilityPct, marketStateLabel). This engine answers a narrower,
 * more actionable question: WHEN in the gap cycle entries have actually
 * paid off historically, and -- equally important -- when they have
 * historically been a trap. Two answers, always both present:
 *
 *   1. ENTRY WINDOW  -- the gap range where ties have historically landed
 *                        most often (the "hot zone").
 *   2. AVOID WINDOW   -- the gap range where ties have historically landed
 *                        least often (the "cold zone" / trap zone).
 *
 * WHY A SEPARATE ENGINE, NOT JUST tieEngine.js's expectedWindow
 * ----------------------------------------------------------------
 * tieEngine.js's expectedWindow/drawsUntilNextTie project a SINGLE
 * expected gap from an average. Averages hide exactly the behavior the
 * user is trying to trade around: a history that mixes short (2-3 draw)
 * clustering seasons with long (8-22 draw) droughts does not have one
 * "typical" spacing -- it has (at least) two regimes, and blending them
 * into one mean produces a number that describes neither regime well.
 * This engine instead:
 *   (a) classifies which regime the tie history is CURRENTLY in
 *       (CLUSTER / NORMAL / DROUGHT) from the most recent intervals,
 *   (b) builds a discrete hazard curve -- P(tie lands at gap g | no tie
 *       yet through g-1) -- from whichever regime's own interval history
 *       currently applies, and
 *   (c) reads the entry/avoid recommendation directly off that curve at
 *       the CURRENT live gap, instead of off a single blended average.
 *
 * HAZARD CURVE, NOT A RAW HISTOGRAM
 * ------------------------------------
 * A raw "how often is the gap N draws" histogram over-penalizes long
 * gaps just because fewer intervals ever survive that long to be counted
 * at all. The hazard curve instead asks, at each gap g, "of the
 * intervals that made it this far without a tie, what fraction ended
 * exactly here" -- the correct conditional question for "given we've
 * already waited this long, is NOW a good moment," which is exactly the
 * entry-timing question this engine exists to answer.
 *
 * ABSOLUTE SEPARATION RULE
 * -------------------------
 * Pure, read-only, observational consumer of tieEngine.js's output plus
 * historicalDraws. Never votes in arbitration/metaIntelligence, never
 * changes any tieEngine threshold/weight, never feeds back into
 * analyzeTies(). "The Next Event Engine has no voice until the Tier
 * Engine speaks" -- same convention as fourSilNextEventIntelEngine.js.
 *
 * EVALUATION LOOP
 * ----------------
 * Whenever a fresh tie lands (currentGap resets to 0), this engine grades
 * the previously-open forecast against the interval that just actually
 * completed, logs it to state.predictions, then opens a new forecast for
 * the next cycle. This log feeds NOTHING back into tieEngine or any gate.
 *
 * TIE TRADE PENETRATION (borrowed convention: MEDIUM_GATE_PRO's 4SIL
 * Trade Penetration / timingEngine.js)
 * ---------------------------------------------------------------------
 * The forecast/hazard machinery above answers "is this gap statistically
 * good or bad right now" as a per-cycle READ. That sibling project's
 * Trade Penetration layer showed a cleaner way to turn a per-cycle read
 * into an actual tradeable lifecycle: a small state machine that opens a
 * call the moment conditions qualify, freezes that call's target/window
 * so it doesn't get renegotiated mid-trade, and gives it exactly one of a
 * few unambiguous exits -- never leaving the operator to guess whether a
 * live call is still live. computeTiePenetration() below ports that same
 * shape onto tie entries:
 *
 *   WAIT           -- no call open; current gap is not in the hot zone.
 *   AVOID          -- no call open; current gap is in the historically
 *                      cold zone -- an explicit "do not enter" read, not
 *                      just an absence of ENTER.
 *   ENTER          -- gap just entered the hot zone this cycle; a call
 *                      opens now, target = this regime's peak-hazard gap,
 *                      validity bounded by the regime's max observed gap
 *                      (past that, the pattern has broken from its own
 *                      history -- same non-negotiable as the 4SIL
 *                      Penetration engine's 11-draw hard stop).
 *   HOLD           -- call already open, still inside its validity
 *                      window, tie hasn't landed yet.
 *   TAKE PROFIT    -- call open, and a tie landed this cycle (currentGap
 *                      just reset to 0) -- the call's win condition.
 *   WINDOW CLOSED  -- call open, gap outran the regime's own max observed
 *                      interval without a tie landing -- stop-loss exit;
 *                      do not re-enter until a fresh qualifying gap.
 *
 * Same separation rule as the rest of this file: penetration state is
 * pure bookkeeping over the forecast already computed above, never a
 * second opinion that overrides it.
 */
'use strict';

const { mean } = require('../core/statMath');
const { detectTie } = require('./tieEngine');

const CLUSTER_MAX_GAP = 3;     // intervals <=3 draws apart = "cluster" repeats
const DROUGHT_MIN_GAP = 8;     // intervals >=8 draws apart = "drought" stretches
const REGIME_LOOKBACK = 6;     // how many of the most recent intervals decide the live regime
const MIN_INTERVALS_TO_MODEL = 3;
const HOT_ZONE_MULTIPLIER = 1.15;  // hazard >= avg * this = "hot" (entry) zone
const COLD_ZONE_MULTIPLIER = 0.6;  // hazard <= avg * this = "cold" (avoid) zone
const WINDOW_PROBABILITY_SPAN = 3; // "P(tie lands within next N draws from here)"
const MAX_PREDICTION_LOG = 300;
const MAX_PENETRATION_LOG = 300;

// Resolution benchmark -- BEFORE this fix, an openForecast just sat OPEN
// indefinitely until currentGap happened to hit 0 again, however many
// draws that took (2 or 25 -- didn't matter), and was then graded
// "accurate" purely off whether that eventual gap fell inside
// entryWindow. That let a call sit open for dozens of draws and still
// count toward the hit rate. A prediction has to actually resolve within
// a bounded number of draws of being made, or it isn't a real call.
// Range: a forecast is only ever gradeable as a HIT between 1 and 7
// draws after it opened; if no tie lands within MAX_RESOLUTION_DRAWS it
// is force-resolved as a MISS (expired) instead of staying open.
const MIN_RESOLUTION_DRAWS = 1;
const MAX_RESOLUTION_DRAWS = 7;

function freshTieNextEventState() {
  return {
    schemaVersion: 1,
    openForecast: null, // frozen forecast awaiting the next tie to grade against
    predictions: [],    // newest-first graded/pending forecast log
    penetration: null,  // live Trade Penetration call state (see computeTiePenetration)
    penetrationLog: [], // newest-first closed penetration calls (TAKE PROFIT / WINDOW CLOSED)
    updatedAt: null
  };
}

// ---------------------------------------------------------------------------
// Interval / regime primitives
// ---------------------------------------------------------------------------

/**
 * Rebuilds the raw tie-to-tie interval list and the live "draws since the
 * last tie" gap directly from historicalDraws (newest-first), independent
 * of tieEngine.js's summarized intervalStats -- this engine needs the full
 * ordered interval array (for the hazard curve and regime split), not just
 * avg/median/mode.
 */
function buildTieIntervalHistory(historicalDraws) {
  const draws = historicalDraws || [];
  const flags = draws.map(detectTie);
  const tieIdx = [];
  flags.forEach((f, i) => { if (f) tieIdx.push(i); });

  const intervals = [];
  for (let i = 0; i < tieIdx.length - 1; i++) {
    // tieIdx is newest-first; the gap between two consecutive ties is the
    // difference between their newest-first indices -- same convention as
    // tieEngine.js's own interval computation.
    intervals.push(tieIdx[i + 1] - tieIdx[i]);
  }
  const currentGap = tieIdx.length > 0 ? tieIdx[0] : null; // 0 = a tie just landed this draw
  return { intervals, currentGap, totalTies: tieIdx.length };
}

/**
 * Classifies the CURRENT regime from the most recent REGIME_LOOKBACK
 * intervals only (not full history) -- a season that started clustering
 * 40 draws ago and has since gone quiet should read as NORMAL/DROUGHT now,
 * not CLUSTER, which is exactly why this looks at recent intervals rather
 * than a lifetime share.
 */
function classifyRegime(intervals) {
  if (!intervals.length) return 'UNKNOWN';
  const recent = intervals.slice(0, REGIME_LOOKBACK);
  const clusterShare = recent.filter(g => g <= CLUSTER_MAX_GAP).length / recent.length;
  const droughtShare = recent.filter(g => g >= DROUGHT_MIN_GAP).length / recent.length;
  if (clusterShare >= 0.5) return 'CLUSTER';
  if (droughtShare >= 0.5) return 'DROUGHT';
  return 'NORMAL';
}

/**
 * Discrete hazard curve: hazard[g] = P(tie lands exactly at gap g | the
 * gap has already survived to g without a tie), estimated empirically as
 * (# intervals == g) / (# intervals >= g). This is the standard
 * actuarial/survival-analysis hazard estimator, chosen specifically
 * because it does NOT under-count long gaps the way a raw histogram
 * would -- every interval that ever reached gap g contributes to the
 * denominator at g, whether or not it ended there.
 */
function buildHazardCurve(intervals) {
  if (!intervals.length) return [];
  const maxG = Math.max(...intervals);
  const curve = [];
  for (let g = 1; g <= maxG; g++) {
    const atRisk = intervals.filter(iv => iv >= g).length;
    const events = intervals.filter(iv => iv === g).length;
    curve.push({
      gap: g,
      hazardPct: atRisk > 0 ? Math.round((events / atRisk) * 1000) / 10 : 0,
      atRisk,
      events
    });
  }
  return curve;
}

/**
 * P(tie lands within [fromGap+1, fromGap+windowSize] | survived to
 * fromGap), computed by multiplying survival probability across the
 * window using the hazard curve -- the standard discrete survival-model
 * formula: P(within window) = 1 - product(1 - hazard(g)) over the window.
 * Falls back to the curve's last known hazard for any gap beyond the
 * curve's observed range (thin-sample extrapolation, deliberately flat
 * rather than assuming it rises or falls further).
 */
function windowProbabilityFromHazard(curve, fromGap, windowSize) {
  if (!curve.length) return 0;
  let survival = 1;
  let pWithin = 0;
  for (let g = fromGap + 1; g <= fromGap + windowSize; g++) {
    const row = curve.find(r => r.gap === g);
    const h = row ? row.hazardPct / 100 : curve[curve.length - 1].hazardPct / 100;
    pWithin += survival * h;
    survival *= (1 - h);
  }
  return Math.round(pWithin * 1000) / 10;
}

/**
 * Derives the entry (hot) and avoid (cold) gap zones directly from the
 * hazard curve, relative to that curve's own average hazard -- so "hot"
 * and "cold" are always regime-relative, never absolute thresholds that
 * would misfire when compared across a cluster-regime curve (where even
 * the "cold" gaps still fire often in absolute terms) vs a drought-regime
 * curve (where even the "hot" gaps are rare in absolute terms).
 */
function computeEntryZones(curve) {
  if (!curve.length) return null;
  const avgHazard = mean(curve.map(r => r.hazardPct));
  const peakHazard = Math.max(...curve.map(r => r.hazardPct));
  const peakRow = curve.find(r => r.hazardPct === peakHazard);

  const hotGaps = curve.filter(r => r.hazardPct >= avgHazard * HOT_ZONE_MULTIPLIER).map(r => r.gap);
  const coldGaps = curve.filter(r => r.hazardPct <= avgHazard * COLD_ZONE_MULTIPLIER).map(r => r.gap);

  return {
    peakGap: peakRow.gap,
    peakHazardPct: peakRow.hazardPct,
    avgHazardPct: Math.round(avgHazard * 10) / 10,
    entryWindow: hotGaps.length ? [Math.min(...hotGaps), Math.max(...hotGaps)] : null,
    avoidWindow: coldGaps.length ? [Math.min(...coldGaps), Math.max(...coldGaps)] : null,
    maxObservedGap: curve[curve.length - 1].gap
  };
}

/**
 * The two-answer verdict this whole engine exists to produce: ENTER,
 * AVOID, MONITOR (neutral), or CAUTION_OVERDUE (gap has moved past every
 * gap this regime has ever actually produced -- the pattern has broken
 * from its own history, so treat it as high uncertainty rather than
 * "even more overdue therefore even more likely").
 *
 * IMPORTANT GAP-INDEXING NOTE: currentGap is "draws since the last tie,
 * observed after each draw lands" -- it counts 0, 1, 2, ... and then
 * jumps straight back to 0 the instant a tie occurs. It therefore never
 * actually equals the length of the interval that is about to complete;
 * an interval of length g is only ever OBSERVED as currentGap=g-1 on the
 * draw immediately before it completes. All zone/curve lookups below use
 * `projectedGap = currentGap + 1` -- "the interval length that would
 * result if the very next draw is the tie" -- since that is the value
 * the hazard curve and entry/avoid windows are actually indexed by.
 */
function recommendEntry(currentGap, zones, regime) {
  if (currentGap == null || !zones) {
    return {
      action: 'INSUFFICIENT_DATA',
      tone: 'dim',
      reason: 'Not enough tie-to-tie history yet to model entry timing.'
    };
  }

  const { entryWindow, avoidWindow, maxObservedGap, peakGap } = zones;
  const projectedGap = currentGap + 1;
  const pastMax = projectedGap > maxObservedGap;
  const inAvoid = avoidWindow && projectedGap >= avoidWindow[0] && projectedGap <= avoidWindow[1];
  const inEntry = entryWindow && projectedGap >= entryWindow[0] && projectedGap <= entryWindow[1];

  if (pastMax) {
    return {
      action: 'CAUTION_OVERDUE',
      tone: 'amber',
      reason: `${currentGap} draw(s) have passed since the last tie -- even the next draw would set a new gap (${projectedGap}) beyond every interval this ${regime.toLowerCase()} regime has ever actually produced (max ${maxObservedGap}). The pattern has broken from its own history here -- treat this as high uncertainty, not a guaranteed imminent tie.`
    };
  }
  if (inEntry) {
    return {
      action: 'ENTER',
      tone: 'emerald',
      reason: `${currentGap} draw(s) since the last tie -- the next draw would land at gap ${projectedGap}, inside the ${regime.toLowerCase()} regime's hot zone (${entryWindow[0]}-${entryWindow[1]}) where ties have historically landed most often. Peak historical hit gap: ${peakGap}.`
    };
  }
  if (inAvoid) {
    return {
      action: 'AVOID',
      tone: 'red',
      reason: `${currentGap} draw(s) since the last tie -- the next draw would land at gap ${projectedGap}, inside a historically cold zone (${avoidWindow[0]}-${avoidWindow[1]}) where ties have rarely landed. Entering here has historically meant a longer wait, not a shorter one.`
    };
  }
  return {
    action: 'MONITOR',
    tone: 'cyan',
    reason: `${currentGap} draw(s) since the last tie -- the next draw would land at gap ${projectedGap}, a neutral zone: neither this regime's historical hot zone nor its cold zone. Keep watching.`
  };
}

/**
 * Trade Penetration lifecycle for tie entries -- ports the MEDIUM_GATE_PRO
 * 4SIL Trade Penetration convention (timingEngine.js's buildHeroData):
 * a small state machine that opens a call the moment conditions qualify,
 * FREEZES that call's target/window at open time (so it can't get
 * renegotiated draw-by-draw mid-trade the way the raw `recommendation`
 * read above legitimately can), and resolves to exactly one of two
 * unambiguous exits. See this file's header for the full state list.
 *
 * priorPenetration: state.penetration from the previous cycle (or null).
 * Returns { penetration, closedCall } -- closedCall is non-null only on
 * the exact cycle a call resolves (TAKE PROFIT or WINDOW CLOSED), for the
 * caller to append to the penetration log.
 */
function computeTiePenetration(forecast, currentGap, priorPenetration, latestDrawId, nowIso) {
  const zones = forecast && forecast.zones;
  const regime = forecast ? forecast.regime : 'UNKNOWN';

  if (!zones || currentGap == null) {
    return { penetration: null, closedCall: null };
  }

  const { entryWindow, avoidWindow, maxObservedGap, peakGap } = zones;
  // Same projectedGap convention as recommendEntry(): currentGap is
  // "draws since last tie, observed after the draw lands," so the gap
  // length the NEXT draw would complete is currentGap+1 -- that's the
  // value zone membership is actually checked against.
  const projectedGap = currentGap + 1;
  const inEntryZone = entryWindow && projectedGap >= entryWindow[0] && projectedGap <= entryWindow[1];
  const inAvoidZone = avoidWindow && projectedGap >= avoidWindow[0] && projectedGap <= avoidWindow[1];

  // ---- No call currently open -------------------------------------------
  if (!priorPenetration || priorPenetration.status !== 'OPEN') {
    // A tie just landed with no open call -- nothing to report either way
    // this cycle; the fresh forecast/regime for the NEW gap-0 cycle will
    // decide whether to open on a later cycle once the gap has actually
    // moved into a zone.
    if (currentGap === 0) {
      return {
        penetration: {
          status: 'WAIT',
          displayState: 'WAIT',
          regime,
          currentGap,
          reasoning: 'A tie just landed. Waiting for the gap to develop before evaluating entry timing again.'
        },
        closedCall: null
      };
    }

    if (inEntryZone) {
      // OPEN a new call, frozen target + validity window. `status` stays
      // 'OPEN' for as long as the call is live -- it is the only field
      // used to detect "is a call currently open" on the next cycle.
      // `phase` is the display-facing state (ENTER on the opening cycle,
      // HOLD on every cycle after) and never gates that check.
      const opened = {
        status: 'OPEN',
        phase: 'ENTER',
        openedDrawId: latestDrawId,
        openedAt: nowIso,
        openedAtGap: currentGap,
        regime,
        tp: peakGap,                                   // frozen target gap
        tpWindow: [...entryWindow],                     // frozen executable window
        tradeWindow: [entryWindow[0], maxObservedGap],   // frozen hard validity bound
        avoidWindowAtOpen: avoidWindow ? [...avoidWindow] : null
      };
      return {
        penetration: {
          ...opened,
          displayState: 'ENTER',
          action: 'ENTER',
          reasoning: `${currentGap} draw(s) since the last tie -- the next draw would land at gap ${projectedGap}, inside the ${regime.toLowerCase()} regime's hot zone (${entryWindow[0]}-${entryWindow[1]}). Opening a call targeting gap ${peakGap}, valid through gap ${maxObservedGap}.`
        },
        closedCall: null
      };
    }

    if (inAvoidZone) {
      return {
        penetration: {
          status: 'AVOID',
          displayState: 'AVOID',
          regime,
          currentGap,
          action: 'DO NOT ENTER',
          reasoning: `${currentGap} draw(s) since the last tie -- the next draw would land at gap ${projectedGap}, inside the historically cold zone (${avoidWindow[0]}-${avoidWindow[1]}). No call opened -- entries here have historically meant a longer wait, not a shorter one.`
        },
        closedCall: null
      };
    }

    return {
      penetration: {
        status: 'WAIT',
        displayState: 'WAIT',
        regime,
        currentGap,
        action: 'WAIT',
        reasoning: `${currentGap} draw(s) since the last tie -- the next draw would land at gap ${projectedGap}, a neutral zone. No call opened yet -- waiting for the gap to reach the ${regime.toLowerCase()} regime's hot zone (${entryWindow ? entryWindow[0] : '?'}-${entryWindow ? entryWindow[1] : '?'}).`
      },
      closedCall: null
    };
  }

  // ---- A call is currently open ------------------------------------------
  const open = priorPenetration;
  const position = currentGap; // gap is already "draws since last tie", i.e. position in the trade window by construction

  if (currentGap === 0) {
    // A tie just landed while a call was open -- win condition, regardless
    // of exactly which gap it landed at (the call already required the
    // ENTRY into the hot zone; any tie after that while still open is the
    // payoff this call was opened for).
    const closed = {
      ...open,
      status: 'RESOLVED_WIN',
      exitState: 'TAKE PROFIT',
      closedDrawId: latestDrawId,
      closedAt: nowIso,
      actualDrawsHeld: null // interval length is logged separately by the forecast evaluation loop
    };
    return {
      penetration: {
        status: 'TAKE PROFIT',
        displayState: 'TAKE PROFIT',
        regime,
        currentGap,
        tp: open.tp,
        tpWindow: open.tpWindow,
        tradeWindow: open.tradeWindow,
        entryDrawId: open.openedDrawId,
        action: 'TAKE PROFIT -- EXIT NOW',
        reasoning: `Tie landed while the call opened at gap ${open.openedAtGap} was still live. Exit now -- do not re-enter until the gap develops into a fresh qualifying zone.`
      },
      closedCall: closed
    };
  }

  if (projectedGap > open.tradeWindow[1]) {
    // Stop-loss: even the next draw would set a gap past this regime's
    // own max observed interval -- same non-negotiable as the 4SIL
    // Penetration engine's hard window-close.
    const closed = {
      ...open,
      status: 'RESOLVED_LOSS',
      exitState: 'WINDOW CLOSED',
      closedDrawId: latestDrawId,
      closedAt: nowIso
    };
    return {
      penetration: {
        status: 'WINDOW CLOSED',
        displayState: 'WINDOW CLOSED',
        regime,
        currentGap,
        tp: open.tp,
        tpWindow: open.tpWindow,
        tradeWindow: open.tradeWindow,
        entryDrawId: open.openedDrawId,
        action: 'EXIT -- DO NOT RE-ENTER YET',
        reasoning: `${currentGap} draw(s) since the last tie -- even the next draw would land at gap ${projectedGap}, past this call's validity bound (gap ${open.tradeWindow[1]}). Closing as a stop-loss -- wait for a fresh entry into the hot zone before opening another call.`
      },
      closedCall: closed
    };
  }

  // Still live, still waiting. `status` stays 'OPEN' so the next cycle's
  // "is a call open" check keeps finding it; only `phase` changes to HOLD.
  const closingRisk = (open.tradeWindow[1] - projectedGap) <= 1 ? 'HIGH'
    : (open.tradeWindow[1] - projectedGap) <= 3 ? 'MODERATE'
    : 'LOW';
  return {
    penetration: {
      ...open,
      status: 'OPEN',
      phase: 'HOLD',
      displayState: 'HOLD',
      currentGap,
      position,
      closingRisk,
      action: 'HOLD',
      reasoning: `Call opened at gap ${open.openedAtGap} is still live (targeting gap ${open.tp}, valid through gap ${open.tradeWindow[1]}). ${closingRisk === 'HIGH' ? 'Nearing the validity bound -- closing risk is elevated.' : 'No exit condition yet.'}`
    },
    closedCall: null
  };
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

function evaluateTieNextEvent(historicalDraws, tieIntelligence, priorState) {
  const state = priorState || freshTieNextEventState();
  const draws = historicalDraws || [];
  const { intervals, currentGap, totalTies } = buildTieIntervalHistory(draws);
  const nowIso = new Date().toISOString();

  if (intervals.length < MIN_INTERVALS_TO_MODEL) {
    return {
      ...state,
      engineState: 'DORMANT',
      sampleSize: intervals.length,
      totalTies,
      currentGap,
      forecast: null,
      reason: `Only ${intervals.length} recorded tie-to-tie interval(s) so far -- at least ${MIN_INTERVALS_TO_MODEL} are needed before entry timing can be modeled.`,
      updatedAt: nowIso
    };
  }

  const regime = classifyRegime(intervals);
  const clusterIntervals = intervals.filter(g => g <= CLUSTER_MAX_GAP);
  // While a cluster season is live, its own short-cycle interval history
  // is a better predictor of "when next" than the full lifetime history
  // (which mixes in droughts the current season isn't behaving like) --
  // so the hazard curve is built from the cluster-only intervals whenever
  // the live regime is CLUSTER and there's enough cluster history to
  // trust; otherwise it falls back to the full interval history.
  const matchedIntervals = (regime === 'CLUSTER' && clusterIntervals.length >= MIN_INTERVALS_TO_MODEL)
    ? clusterIntervals
    : intervals;

  const curve = buildHazardCurve(matchedIntervals);
  const zones = computeEntryZones(curve);
  const recommendation = recommendEntry(currentGap, zones, regime);
  const windowProbability = windowProbabilityFromHazard(curve, currentGap, WINDOW_PROBABILITY_SPAN);

  const n = matchedIntervals.length;
  const confidence = n >= 20 ? 'HIGH' : n >= 8 ? 'MEDIUM' : 'LOW';

  const forecast = {
    regime,
    currentGap,
    windowProbability,       // P(tie lands within the next WINDOW_PROBABILITY_SPAN draws from here)
    windowSpan: WINDOW_PROBABILITY_SPAN,
    confidence,
    sampleSize: n,
    matchedRegimeSample: regime === 'CLUSTER' && matchedIntervals === clusterIntervals ? 'cluster-only' : 'full-history',
    hazardCurve: curve,
    zones,
    recommendation
  };

  // ---- Evaluation loop: grade the previously-open forecast whenever a
  // fresh tie lands (currentGap resets to 0), then open a new one. -------
  let openForecast = state.openForecast || null;
  let predictions = Array.isArray(state.predictions) ? [...state.predictions] : [];
  const latestDrawId = draws[0] ? draws[0].drawId : null;

  if (openForecast && openForecast.status === 'OPEN') {
    // draws elapsed since THIS call opened -- not the raw interval length,
    // since the call may have opened mid-interval (openedAtGap > 0).
    const drawsSinceOpen = currentGap === 0
      ? intervals[0] - openForecast.openedAtGap
      : currentGap - openForecast.openedAtGap;

    if (currentGap === 0) {
      // The interval that just completed is the freshest entry in
      // `intervals` (index 0), since a new tie index was just added this
      // cycle -- exactly the gap the open forecast was trying to predict.
      const actualDrawsToEvent = intervals[0];
      const withinEntry = openForecast.entryWindow
        && actualDrawsToEvent >= openForecast.entryWindow[0]
        && actualDrawsToEvent <= openForecast.entryWindow[1];
      const withinAvoid = openForecast.avoidWindow
        && actualDrawsToEvent >= openForecast.avoidWindow[0]
        && actualDrawsToEvent <= openForecast.avoidWindow[1];
      // Benchmark gate: even if the tie landed inside entryWindow, it only
      // counts as a HIT if it landed within MIN_RESOLUTION_DRAWS..
      // MAX_RESOLUTION_DRAWS draws of the call actually opening.
      const withinBenchmark = drawsSinceOpen >= MIN_RESOLUTION_DRAWS
        && drawsSinceOpen <= MAX_RESOLUTION_DRAWS;

      openForecast = {
        ...openForecast,
        status: 'RESOLVED',
        actualDrawsToEvent,
        drawsSinceOpen,
        withinBenchmark,
        accurate: !!withinEntry && withinBenchmark,
        correctlyAvoided: !!withinAvoid,
        expired: false,
        resolvedDrawId: latestDrawId,
        resolvedAt: nowIso
      };
      predictions = [openForecast, ...predictions].slice(0, MAX_PREDICTION_LOG);
      openForecast = null;
    } else if (drawsSinceOpen >= MAX_RESOLUTION_DRAWS) {
      // No tie landed within the benchmark window -- force-resolve as a
      // MISS instead of leaving the call open indefinitely waiting for
      // whatever draw eventually happens to tie.
      openForecast = {
        ...openForecast,
        status: 'RESOLVED',
        actualDrawsToEvent: null,
        drawsSinceOpen,
        withinBenchmark: false,
        accurate: false,
        correctlyAvoided: false,
        expired: true,
        resolvedDrawId: latestDrawId,
        resolvedAt: nowIso
      };
      predictions = [openForecast, ...predictions].slice(0, MAX_PREDICTION_LOG);
      openForecast = null;
    }
  }

  if (!openForecast) {
    openForecast = {
      status: 'OPEN',
      openedDrawId: latestDrawId,
      openedAt: nowIso,
      openedAtGap: currentGap,
      regime,
      entryWindow: zones ? zones.entryWindow : null,
      avoidWindow: zones ? zones.avoidWindow : null,
      peakGap: zones ? zones.peakGap : null,
      confidence
    };
  }

  const resolved = predictions.filter(p => p.status === 'RESOLVED');
  const accurate = resolved.filter(p => p.accurate).length;
  const correctlyAvoided = resolved.filter(p => p.correctlyAvoided).length;
  const expired = resolved.filter(p => p.expired).length;
  const latencySamples = resolved.filter(p => p.actualDrawsToEvent != null);
  const evaluation = {
    totalPredictions: predictions.length,
    resolvedPredictions: resolved.length,
    accuratePredictions: accurate,
    accuracyRate: resolved.length > 0 ? Math.round((accurate / resolved.length) * 1000) / 10 : null,
    correctlyAvoidedCount: correctlyAvoided,
    expiredCount: expired,
    resolutionWindow: [MIN_RESOLUTION_DRAWS, MAX_RESOLUTION_DRAWS],
    avgActualLatency: latencySamples.length > 0
      ? Math.round(mean(latencySamples.map(p => p.actualDrawsToEvent)) * 10) / 10
      : null
  };

  const engineState = n >= 8 ? 'FORECASTING' : 'ARMED';

  // ---- Trade Penetration lifecycle (see this file's header) -------------
  const { penetration, closedCall } = computeTiePenetration(
    forecast, currentGap, state.penetration || null, latestDrawId, nowIso
  );
  let penetrationLog = Array.isArray(state.penetrationLog) ? [...state.penetrationLog] : [];
  if (closedCall) {
    penetrationLog = [closedCall, ...penetrationLog].slice(0, MAX_PENETRATION_LOG);
  }
  const wins = penetrationLog.filter(c => c.status === 'RESOLVED_WIN').length;
  const losses = penetrationLog.filter(c => c.status === 'RESOLVED_LOSS').length;
  const penetrationStats = {
    totalCalls: penetrationLog.length,
    wins,
    losses,
    winRate: penetrationLog.length > 0 ? Math.round((wins / penetrationLog.length) * 1000) / 10 : null
  };

  return {
    schemaVersion: state.schemaVersion || 1,
    engineState,
    sampleSize: n,
    totalTies,
    currentGap,
    forecast,
    openForecast,
    predictions,
    evaluation,
    penetration,
    penetrationLog,
    penetrationStats,
    updatedAt: nowIso
  };
}

module.exports = {
  freshTieNextEventState,
  evaluateTieNextEvent,
  MIN_RESOLUTION_DRAWS,
  MAX_RESOLUTION_DRAWS,
  // exported for tests / diagnostics
  buildTieIntervalHistory,
  classifyRegime,
  buildHazardCurve,
  computeEntryZones,
  recommendEntry,
  windowProbabilityFromHazard,
  computeTiePenetration
};
