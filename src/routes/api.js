/**
 * Express API Router.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { processIngestPayload } = require('../collector/adapter');
const { runSupremeCouncil } = require('../supreme/council');
const { evaluateAndLearn } = require('../services/learning');
const { store } = require('../core/store');
const { saveSnapshot } = require('../services/persistence');
const { computeColorParliamentLastStandAndAlam } = require('../engines/colorParliamentLastStand');
const { runEventIntelligence } = require('../engines/eventIntelligenceEngineCP');
const { sweepSeasonParameters } = require('../engines/tieEngine');

// BUGFIX: was a plain `===` string comparison, which leaks timing
// information about how many leading characters of the key were guessed
// correctly (JS string equality short-circuits at the first mismatched
// character). Buffer lengths are compared first -- timingSafeEqual throws
// on mismatched lengths rather than returning false -- before the
// constant-time comparison itself.
function checkAuth(req, res, next) {
  const requiredKey = process.env.GATEWAY_API_KEY;
  if (!requiredKey) return next();
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-Key header' });
  }
  try {
    const a = Buffer.from(apiKey);
    const b = Buffer.from(requiredKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  } catch (e) {
    // fall through to the 401 below
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-Key header' });
}

// Ingestion Routes
router.post(['/v1/collector', '/collector', '/receive-draws', '/draws'], checkAuth, (req, res) => {
  const result = processIngestPayload(req.body);
  if (result.accepted > 0) {
    const latestDraw = store.historicalDraws[0];
    evaluateAndLearn(latestDraw);
    runSupremeCouncil();
    saveSnapshot(store);
  }
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json({
    status: 'ok',
    ingest: result,
    snapshot
  });
});

// Snapshot & Intelligence Feeds
router.get(['/snapshot', '/v1/snapshot'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot);
});

router.get('/meta-intelligence', (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json({
    metaIntelligence: snapshot.metaIntelligence,
    regimeEngineStats: store.regimeEngineStats
  });
});


// Color Parliament port: 3-Ball Last Stand, 4-Ball Last Stand, and the
// Alam (Alert / Last-stand Alert Monitor) system that watches both. See
// src/engines/colorParliamentLastStand.js and
// src/engines/colorParliamentSeasonAdapter.js for the full port notes.
router.get('/color-parliament/last-stand', (req, res) => {
  res.json(computeColorParliamentLastStandAndAlam());
});

// Color Parliament port: 4Ball Event Intelligence Engine v2.0 (First
// Appearance Detector / Transition Corridor / Last Stand Detector +
// Event Memory Database). Dormant (seasonGate.active: false) whenever no
// 4-ball season is currently active. See
// src/engines/eventIntelligenceEngineCP.js for the full port notes.
router.get('/color-parliament/event-intelligence', (req, res) => {
  res.json(runEventIntelligence());
});

router.get('/prediction', (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.officialPredictions || {});
});

router.get('/recommendation', (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.supremeDecision || {});
});

// Draw History & Performance — recommendationLog + raw draw records, joined
// by drawId, plus lightweight aggregate accuracy windows. Backs the Draw
// History table and Performance Terminal panel on the dashboard.
router.get('/history', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const drawsById = new Map(store.historicalDraws.map(d => [String(d.drawId), d]));

  const rows = store.recommendationLog.slice(0, limit).map(entry => {
    const draw = drawsById.get(String(entry.drawId));
    return {
      drawId: entry.drawId,
      timestamp: entry.timestamp,
      colors: draw ? draw.colors : [],
      threeBallColor: draw ? draw.threeBallColor : null,
      fourBallColor: draw ? draw.fourBallColor : null,
      recommendedColor: entry.recommendedColor,
      action: entry.action,
      actualWinner: entry.actualWinner,
      wasCorrect: entry.wasCorrect,
      marketRegime: entry.marketRegime
    };
  });

  function accuracyOver(n) {
    const slice = store.recommendationLog.slice(0, n);
    if (slice.length === 0) return null;
    const hits = slice.filter(r => r.wasCorrect).length;
    return { sampleSize: slice.length, accuracyPct: Math.round((hits / slice.length) * 100) };
  }

  res.json({
    rows,
    totalLogged: store.recommendationLog.length,
    windows: {
      last10: accuracyOver(10),
      last30: accuracyOver(30),
      last100: accuracyOver(100)
    }
  });
});

// Tier Engine forecast-accuracy feed (Recommendation #1). Mirrors
// /history's shape/windowing conventions but scores the Tier Engine's own
// market-state forecasts against real outcomes, independent of the
// color-prediction engines /history covers.
router.get('/tier-engine-accuracy', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const log = store.tierForecastLog;
  const scored = log.filter(e => e.scored);

  const rows = log.slice(0, limit).map(e => ({
    forDrawId: e.forDrawId,
    madeAfterDrawId: e.madeAfterDrawId,
    timestamp: e.timestamp,
    marketStateLabel: e.marketStateLabel,
    operatorAction: e.operatorAction,
    riskLevel: e.riskLevel,
    tieProbabilityPct: e.tieProbabilityPct,
    drawsUntilNextTie: e.drawsUntilNextTie,
    // Blueprint upgrade (spec section 9 Performance Loop): Pressure,
    // Expected Window, Confidence -- alongside the existing fields above.
    tiePressureScore: e.tiePressureScore,
    expectedWindowLabel: e.expectedWindowLabel,
    confidenceLabel: e.confidenceLabel,
    scored: e.scored,
    actualWasTie: e.actualWasTie,
    hit: e.hit
  }));

  // Actionable-call accuracy: only TIE_ACTIVE/READY and TIE_APPROACHING/WATCH
  // calls carry a hit/miss verdict (see store.scoreTierForecast()'s
  // reasoning) -- MONITOR/NO_ACTION are excluded from this figure rather
  // than counted as automatic misses.
  function actionableAccuracyOver(n) {
    const slice = scored.filter(e => e.hit !== null).slice(0, n);
    if (slice.length === 0) return null;
    const hits = slice.filter(e => e.hit).length;
    return { sampleSize: slice.length, hitRatePct: Math.round((hits / slice.length) * 1000) / 10 };
  }

  // Baseline: raw tie rate across every SCORED draw regardless of what the
  // engine called, for comparison against actionableAccuracyOver() above.
  // If the engine isn't beating this number, its actionable calls aren't
  // adding value over just knowing the unconditional tie rate.
  function baselineTieRateOver(n) {
    const slice = scored.slice(0, n);
    if (slice.length === 0) return null;
    const ties = slice.filter(e => e.actualWasTie).length;
    return { sampleSize: slice.length, tieRatePct: Math.round((ties / slice.length) * 1000) / 10 };
  }

  res.json({
    rows,
    totalLogged: log.length,
    totalScored: scored.length,
    actionableAccuracy: {
      last10: actionableAccuracyOver(10),
      last30: actionableAccuracyOver(30),
      last100: actionableAccuracyOver(100)
    },
    baselineTieRate: {
      last10: baselineTieRateOver(10),
      last30: baselineTieRateOver(30),
      last100: baselineTieRateOver(100)
    }
  });
});

// Tie Precursor Pattern Engine forecast-accuracy feed -- direct
// structural mirror of /tier-engine-accuracy above, scoped to
// store.tiePrecursorForecastLog instead of store.tierForecastLog.
// Independent log, independent engine, same shape so any client already
// consuming /tier-engine-accuracy can reuse the same rendering logic
// here with a different field set.
router.get('/tie-precursor-accuracy', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const log = store.tiePrecursorForecastLog;
  const scored = log.filter(e => e.scored);

  const rows = log.slice(0, limit).map(e => ({
    forDrawId: e.forDrawId,
    madeAfterDrawId: e.madeAfterDrawId,
    timestamp: e.timestamp,
    riskLevel: e.riskLevel,
    rawCombinedScore: e.rawCombinedScore,
    calibratedCombinedScore: e.calibratedCombinedScore,
    elevatedRisk: e.elevatedRisk,
    activePrecursors: e.activePrecursors,
    scored: e.scored,
    actualWasTie: e.actualWasTie,
    hit: e.hit
  }));

  // Actionable-call accuracy: only elevatedRisk===true calls carry a
  // hit/miss verdict (see store.scoreTiePrecursorForecast()'s reasoning)
  // -- cycles where neither precursor was live are excluded from this
  // figure rather than counted as automatic misses.
  function actionableAccuracyOver(n) {
    const slice = scored.filter(e => e.hit !== null).slice(0, n);
    if (slice.length === 0) return null;
    const hits = slice.filter(e => e.hit).length;
    return { sampleSize: slice.length, hitRatePct: Math.round((hits / slice.length) * 1000) / 10 };
  }

  // Baseline: raw tie rate across every SCORED draw regardless of what
  // the engine called, for comparison against actionableAccuracyOver()
  // above -- if the engine isn't beating this number, its elevated-risk
  // calls aren't adding value over just knowing the unconditional tie
  // rate.
  function baselineTieRateOver(n) {
    const slice = scored.slice(0, n);
    if (slice.length === 0) return null;
    const ties = slice.filter(e => e.actualWasTie).length;
    return { sampleSize: slice.length, tieRatePct: Math.round((ties / slice.length) * 1000) / 10 };
  }

  res.json({
    rows,
    totalLogged: log.length,
    totalScored: scored.length,
    actionableAccuracy: {
      last10: actionableAccuracyOver(10),
      last30: actionableAccuracyOver(30),
      last100: actionableAccuracyOver(100)
    },
    baselineTieRate: {
      last10: baselineTieRateOver(10),
      last30: baselineTieRateOver(30),
      last100: baselineTieRateOver(100)
    },
    // Same shape store.buildTiePrecursorCalibrationData() returns and
    // what council.js feeds back into the engine as calibrationData --
    // included here too so a caller can inspect exactly what's driving
    // this cycle's calibration without cross-referencing /snapshot.
    calibrationByRiskLevel: store.buildTiePrecursorCalibrationData().byRiskLevel
  });
});

// Recommendation #3: season-detection parameter sweep. Diagnostic-only --
// evaluates candidate (maxGap, minTies) pairings against REAL ingested
// history to report which would have best predicted "next draw is a tie"
// via the active-season signal, compared to baseline. Does NOT change
// live SEASON_MAX_GAP/SEASON_MIN_TIES; those remain a deliberate manual
// edit to tieEngine.js's constants if this report recommends a change.
// Optional query params let a caller widen/narrow the grid or the
// minimum-sample-size floor; sane defaults apply otherwise.
router.get('/tier-engine-parameter-sweep', (req, res) => {
  const parseIntList = (raw, fallback) => {
    if (!raw) return fallback;
    const parsed = String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);
    return parsed.length > 0 ? parsed : fallback;
  };
  const options = {
    candidateGaps: parseIntList(req.query.gaps, undefined),
    candidateMinTies: parseIntList(req.query.minTies, undefined),
    minEvaluations: req.query.minEvaluations ? Math.max(1, parseInt(req.query.minEvaluations, 10) || 5) : undefined
  };
  const result = sweepSeasonParameters(store.historicalDraws, options);
  res.json(result);
});

// 5-Ball Live Prediction Engine (Phase 6) -- explicit activation.
// checkAuth-gated (same as /reset below), AND re-checks eligibility
// server-side before honoring the request -- this is the second half of
// the two-gate discipline described in fiveBallLivePredictionEngine.js's
// header. Meeting the eligibility bar alone (computed live every council
// cycle) never activates anything by itself; this route is the ONLY
// code path anywhere in this codebase that can ever set
// store.fiveBallLiveMemory.liveModeEnabled to true, and it refuses to do
// so unless the CURRENT real shadow track record (never synthetic test
// data -- this reads from the live store) actually clears the bar.
router.post(['/five-ball/enable-live-prediction'], checkAuth, (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const eligibility = snapshot.fiveBallLive && snapshot.fiveBallLive.eligibility;

  if (!eligibility || !eligibility.eligible) {
    return res.status(409).json({
      status: 'not_eligible',
      message: 'The 5-ball shadow track record does not yet meet the eligibility bar for live prediction.',
      eligibility: eligibility || null
    });
  }

  store.fiveBallLiveMemory.liveModeEnabled = true;
  store.fiveBallLiveMemory.enabledAt = new Date().toISOString();
  store.fiveBallLiveMemory.updatedAt = new Date().toISOString();
  saveSnapshot(store);

  res.json({
    status: 'live_prediction_enabled',
    enabledAt: store.fiveBallLiveMemory.enabledAt,
    eligibility
  });
});

// Explicit deactivation -- always allowed, no eligibility check needed to
// turn OFF a live capability (only to turn one on).
router.post(['/five-ball/disable-live-prediction'], checkAuth, (req, res) => {
  store.fiveBallLiveMemory.liveModeEnabled = false;
  store.fiveBallLiveMemory.updatedAt = new Date().toISOString();
  saveSnapshot(store);
  res.json({ status: 'live_prediction_disabled' });
});

// Reset Utility
router.post(['/reset', '/v1/reset'], checkAuth, (req, res) => {
  store.resetStore();
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'reset_ok', snapshot });
});

// 4SIL ENTER Call — 4-Ball Event Density Log (see
// src/engines/fourBallEnterCallLog.js). Returns the full call history:
// each ENTER call from openDrawId to closeDrawId with the count of
// 4-ball events of ANY color that landed inside that window, plus the
// currently-open call (if ENTER is active right now) and aggregate stats.
//
// Query params:
//   limit   — max closed calls to return (default 100, cap 500)
//
// Shape:
//   {
//     engine: 'FourBallEnterCallLog',
//     totalCalls: <n>,
//     closedCalls: <n>,
//     openCall: { callId, openDrawId, draws, fourBallEvents, eventDrawIds } | null,
//     aggregate: { totalFourBallEvents, totalDrawsWatched, avgEventsPerCall,
//                  avgDrawsPerCall, overallDensityPct },
//     log: [ { callId, openDrawId, openAt, closeDrawId, closeAt,
//              closeReason, draws, fourBallEvents, eventDrawIds }, ... ]
//   }
router.get('/four-ball-enter-log', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const { buildSummary } = require('../engines/fourBallEnterCallLog');

  // Build a fresh summary view with the requested limit applied to the log
  // slice without altering the stored state.
  const state = store.fourBallEnterCallLog;
  const full = buildSummary(state);
  res.json({
    ...full,
    log: state.closedCalls.slice(0, limit)
  });
});

// 4SIL Hit Average Engine -- dedicated read for the per-call hit log and
// running averages. Returns lifetime + 7-day-window averages and the
// most recent hit log entries. Same convenience pattern as /four-ball-enter-log.
router.get(['/four-sil-hit-average', '/v1/four-sil-hit-average'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const ha = snapshot.fourSilHitAverage || {};
  res.json({
    ...ha,
    hitLog: Array.isArray(ha.hitLog) ? ha.hitLog.slice(0, limit) : []
  });
});

// 5-Ball Next Event Engine (Phase 7) -- dedicated read for the blended
// leaderboard/audit trail, same convenience pattern as the other
// dedicated reads above. Already present in full on GET /v1/snapshot's
// own fiveBallNextEvent field; this just avoids fetching the whole
// snapshot when only this is wanted. SHADOW/AUDIT ONLY -- see
// fiveBallNextEventEngine.js's header.
// Zero Color Ball Intelligence -- dedicated read for zeroColorEngine.js's
// analyzeZeroColor() output (missing-color detection, interval/season
// stats, and next-event prediction). Already present in full on GET
// /v1/snapshot's own zeroColorIntelligence field; this just avoids
// fetching the whole snapshot when only this is wanted. Same convenience
// pattern as the other dedicated reads on this router.
router.get(['/zero-color', '/v1/zero-color'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.zeroColorIntelligence);
});

router.get(['/five-ball/next-event', '/v1/five-ball/next-event'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fiveBallNextEvent);
});

// 5-Ball Dual-Color Next Event Prediction Engine (Phase 8) -- dedicated
// read for the current session (armed repeat/transition prediction plus
// live hit-tracking) and its resolved session log/evaluation stats, same
// convenience pattern as the other dedicated reads above. Already
// present in full on GET /v1/snapshot's own fiveBallDualColor field;
// this just avoids fetching the whole snapshot when only this is
// wanted. SHADOW/AUDIT ONLY -- see fiveBallDualColorNextEventEngine.js's
// header.
router.get(['/five-ball/dual-color-next-event', '/v1/five-ball/dual-color-next-event'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fiveBallDualColor);
});

// 5-Ball Dual-Color Next Event Prediction Engine (Phase 8) -- dedicated
// EVALUATION LOG read. Separate from the route above because the
// snapshot's own fiveBallDualColor.recentSessions is capped at 20 for
// dashboard convenience; this route exposes the full resolved-session
// history (up to fiveBallDualColorNextEventEngine.js's own
// MAX_SESSION_LOG_ENTRIES persisted cap), each entry already carrying
// the full HIT/MISS record per this file's header: trigger event/color,
// the frozen repeat+transition call, repeatHit/transitionHit/
// bothColorsHit, firstHitColor/firstHitDrawId/firstHitDrawsElapsed, and
// status. SHADOW/AUDIT ONLY -- see fiveBallDualColorNextEventEngine.js's
// header; this log is never read by 4SIL, Parliament, or Phase 6's
// eligibility gate.
router.get(['/five-ball/dual-color-next-event/evaluation-log', '/v1/five-ball/dual-color-next-event/evaluation-log'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const dc = snapshot.fiveBallDualColor || {};
  const fullLog = (store.fiveBallDualColorMemory && Array.isArray(store.fiveBallDualColorMemory.sessionLog))
    ? store.fiveBallDualColorMemory.sessionLog
    : (dc.recentSessions || []);
  res.json({
    engine: '5-Ball Dual-Color Next Event Engine',
    phase: 8,
    mode: 'SHADOW_ONLY',
    evaluation: dc.evaluation || null,
    activeSession: dc.activeSession || null,
    log: fullLog.slice(0, limit)
  });
});

// 4SIL Paper Trader Engine (see src/engines/paperTraderEngine.js) --
// dedicated reads for the v1.1 paper-trading ledger. GET /v1/snapshot's
// own `paperTrader` field already carries the full live summary; these
// routes exist for direct/filtered access, same convenience pattern as
// /four-ball-enter-log and /four-sil-hit-average above.
router.get(['/paper-trader', '/v1/paper-trader'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.paperTrader);
});

// 4SIL Next Event Intelligence Engine (4SIL-NEI) -- see
// src/engines/fourSilNextEventIntelEngine.js. Color-agnostic forecast of
// when the next 4-ball event should land, fused from
// fourBallEnterCallLog + paperTrader timing profiles. Same convenience
// pattern as /four-sil-hit-average and /paper-trader above: GET
// /v1/snapshot's own `fourSilNextEventIntel` field already carries this
// in full; this route exists for direct/filtered access.
//
// Query params:
//   limit — max evaluation log entries to return (default 50, cap 500)
//
// Shape:
//   {
//     engine: 'FourSilNextEventIntelEngine',
//     status: 'DORMANT' | 'ARMED_WAITING' | 'ARMED_TRACKING',
//     colorAgnostic: true,
//     liveAge: <draws since current call's ENTER, or null>,
//     forecast: { primaryDraw, expectedRangeLow, expectedRangeHigh,
//                 fusedLatency, confidence, timingState } | null,
//     intel: { callHistory: {...}, paperTrader: {...} } | null,
//     activePrediction: { ..., openDrawId, primaryDrawId,
//                          expectedDrawIdLow, expectedDrawIdHigh } | null,
//       -- primaryDraw/expectedRangeLow/High are draw OFFSETS from
//          openDrawId; primaryDrawId/expectedDrawIdLow/High are the
//          same forecast expressed as absolute draw IDs
//          (openDrawId + offset), frozen at the moment this call opened.
//     calibration: { gradedPredictions, hits, hitRatePct },
//     evaluations: [ { callId, predicted: {..., primaryDrawId,
//                       expectedDrawIdLow, expectedDrawIdHigh},
//                       actual: {..., drawId}, result }, ... ],
//     updatedAt
//   }
router.get(['/four-sil-next-event', '/v1/four-sil-next-event'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const nei = snapshot.fourSilNextEventIntel || {};
  res.json({
    ...nei,
    evaluations: Array.isArray(nei.evaluations) ? nei.evaluations.slice(0, limit) : []
  });
});

// Tie Next Event / Entry Timing Engine -- see
// src/engines/tieNextEventEngine.js. Studies the Tie Intelligence
// Engine's own tie-to-tie gap/spacing/cluster history and recommends WHEN
// to enter a tie trade and WHEN NOT to, plus a Trade-Penetration-style
// call lifecycle. Same convenience pattern as /four-sil-next-event above:
// GET /v1/snapshot's own `tieNextEvent` field already carries this in
// full; this route exists for direct/filtered access.
//
// Query params:
//   predictionsLimit  — max forecast-evaluation log entries (default 50, cap 500)
//   penetrationLimit  — max closed Trade Penetration calls (default 50, cap 500)
//
// Shape:
//   {
//     engineState: 'DORMANT' | 'ARMED' | 'FORECASTING',
//     sampleSize, totalTies, currentGap,
//     forecast: { regime, currentGap, windowProbability, windowSpan,
//                 confidence, sampleSize, hazardCurve, zones,
//                 recommendation } | null,
//     openForecast, predictions: [...],
//     evaluation: { totalPredictions, resolvedPredictions,
//                    accuratePredictions, accuracyRate,
//                    correctlyAvoidedCount, avgActualLatency },
//     penetration: { status, displayState, action, reasoning, tp,
//                     tpWindow, tradeWindow, ... } | null,
//     penetrationLog: [...], penetrationStats: { totalCalls, wins,
//                                                  losses, winRate },
//     updatedAt
//   }
router.get(['/tie-next-event', '/v1/tie-next-event'], (req, res) => {
  const predictionsLimit = Math.min(500, Math.max(1, parseInt(req.query.predictionsLimit, 10) || 50));
  const penetrationLimit = Math.min(500, Math.max(1, parseInt(req.query.penetrationLimit, 10) || 50));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const tne = snapshot.tieNextEvent || {};
  res.json({
    ...tne,
    predictions: Array.isArray(tne.predictions) ? tne.predictions.slice(0, predictionsLimit) : [],
    penetrationLog: Array.isArray(tne.penetrationLog) ? tne.penetrationLog.slice(0, penetrationLimit) : []
  });
});

router.get(['/paper-trader/state', '/v1/paper-trader/state'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.paperTrader || {};
  res.json({
    engine: 'PaperTrader',
    tradingState: pt.tradingState,
    signal: pt.signal,
    ladderLimitReached: pt.ladderLimitReached,
    updatedAt: pt.updatedAt
  });
});

router.get(['/paper-trader/current', '/v1/paper-trader/current'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.paperTrader || {};
  res.json({
    engine: 'PaperTrader',
    cycle: pt.cycle,
    window: pt.window,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get(['/paper-trader/history', '/v1/paper-trader/history'], (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const trades = (store.paperTrader && store.paperTrader.trades) || [];
  res.json({
    engine: 'PaperTrader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.paperTrader ? snapshot.paperTrader.updatedAt : null
  });
});

router.get(['/paper-trader/windows', '/v1/paper-trader/windows'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.paperTrader || {};
  const closedWindows = (store.paperTrader && store.paperTrader.windows) || [];
  res.json({
    engine: 'PaperTrader',
    currentWindow: pt.window,
    closedWindows: closedWindows.slice(0, limit)
  });
});

router.get(['/paper-trader/cycles', '/v1/paper-trader/cycles'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.paperTrader || {};
  const closedCycles = (store.paperTrader && store.paperTrader.cycles) || [];
  res.json({
    engine: 'PaperTrader',
    currentCycle: pt.cycle,
    closedCycles: closedCycles.slice(0, limit)
  });
});

router.get(['/paper-trader/performance', '/v1/paper-trader/performance'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.paperTrader || {};
  res.json({
    engine: 'PaperTrader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get(['/paper-trader/resets', '/v1/paper-trader/resets'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.paperTrader && store.paperTrader.resets) || [];
  res.json({
    engine: 'PaperTrader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

// Paper Trader — manual reset (clears ladder/window state, preserves config).
// Intended for operator use when LADDER_LIMIT_REACHED or any other condition
// requires a fresh start without wiping the full store (which /reset does).
// No auth required — matches the read-only paper-trader GET routes above;
// the paper trader is evaluation-only and carries no real-money state.
router.post(['/paper-trader/reset', '/v1/paper-trader/reset'], (req, res) => {
  const { freshPaperTraderState } = require('../engines/paperTraderEngine');
  // Preserve the current config (ladder, capital, etc.) so operator
  // settings survive the reset; only the ledger is wiped.
  const existingConfig = store.paperTrader && store.paperTrader.config;
  store.paperTrader = freshPaperTraderState(existingConfig);
  store.cachedSystemState = null; // invalidate snapshot
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'paper_trader_reset_ok', paperTrader: snapshot.paperTrader });
});

// Paper Trader — update config (stake ladder, starting capital, window size).
// Resets the ledger after applying the new config so the ledger is always
// consistent with the config it was started under.
// Body (all fields optional):
//   ladder          — array of 12 stake amounts (₦ per color per stage)
//   startingCapital — new paper capital baseline (number)
//   windowSize      — 10 or 11
router.post(['/paper-trader/config', '/v1/paper-trader/config'], (req, res) => {
  const { freshPaperTraderState, defaultConfig, WINDOW_SIZE_MIN, WINDOW_SIZE_MAX, DEFAULT_LADDER } = require('../engines/paperTraderEngine');
  const body = req.body || {};
  const base = store.paperTrader && store.paperTrader.config
    ? { ...store.paperTrader.config }
    : defaultConfig();

  // Validate and apply ladder
  if (Array.isArray(body.ladder)) {
    const ladder = body.ladder.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (ladder.length >= 2) base.ladder = ladder;
    else return res.status(400).json({ error: 'ladder must be an array of at least 2 positive numbers' });
  }

  // Validate and apply startingCapital
  if (body.startingCapital !== undefined) {
    const cap = Number(body.startingCapital);
    if (!Number.isFinite(cap) || cap <= 0)
      return res.status(400).json({ error: 'startingCapital must be a positive number' });
    base.startingCapital = cap;
  }

  // Validate and apply windowSize
  if (body.windowSize !== undefined) {
    const ws = Number(body.windowSize);
    if (ws !== WINDOW_SIZE_MIN && ws !== WINDOW_SIZE_MAX)
      return res.status(400).json({ error: `windowSize must be ${WINDOW_SIZE_MIN} or ${WINDOW_SIZE_MAX}` });
    base.windowSize = ws;
  }

  store.paperTrader = freshPaperTraderState(base);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'paper_trader_config_updated', config: base, paperTrader: snapshot.paperTrader });
});

// ---------------------------------------------------------------------------
// TIE PAPER TRADER -- read/reset/config routes. Direct structural mirror
// of the 4SIL Paper Trader routes immediately above (same URL shape,
// same validation, same reset-on-config-change behavior), just pointed
// at tiePaperTraderEngine.js / store.tiePaperTrader / snapshot.tiePaperTrader
// instead. See tiePaperTraderEngine.js's header for how its signal/market
// model differs from 4SIL's (ENTER derived from the Tie Next Event
// Engine's Trade Penetration state; single TIE market at 4x payout
// instead of a 3-color 12x cover; 2 attempts per ladder stage instead
// of 3).
// ---------------------------------------------------------------------------

router.get(['/tie-paper-trader', '/v1/tie-paper-trader'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.tiePaperTrader || null);
});

router.get(['/tie-paper-trader/state', '/v1/tie-paper-trader/state'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.tiePaperTrader || {};
  res.json({
    engine: 'TiePaperTrader',
    tradingState: pt.tradingState,
    signal: pt.signal,
    ladderLimitReached: pt.ladderLimitReached,
    updatedAt: pt.updatedAt
  });
});

router.get(['/tie-paper-trader/current', '/v1/tie-paper-trader/current'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.tiePaperTrader || {};
  res.json({
    engine: 'TiePaperTrader',
    cycle: pt.cycle,
    window: pt.window,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get(['/tie-paper-trader/history', '/v1/tie-paper-trader/history'], (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const trades = (store.tiePaperTrader && store.tiePaperTrader.trades) || [];
  res.json({
    engine: 'TiePaperTrader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.tiePaperTrader ? snapshot.tiePaperTrader.updatedAt : null
  });
});

router.get(['/tie-paper-trader/windows', '/v1/tie-paper-trader/windows'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.tiePaperTrader || {};
  const closedWindows = (store.tiePaperTrader && store.tiePaperTrader.windows) || [];
  res.json({
    engine: 'TiePaperTrader',
    currentWindow: pt.window,
    closedWindows: closedWindows.slice(0, limit)
  });
});

router.get(['/tie-paper-trader/cycles', '/v1/tie-paper-trader/cycles'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.tiePaperTrader || {};
  const closedCycles = (store.tiePaperTrader && store.tiePaperTrader.cycles) || [];
  res.json({
    engine: 'TiePaperTrader',
    currentCycle: pt.cycle,
    closedCycles: closedCycles.slice(0, limit)
  });
});

router.get(['/tie-paper-trader/performance', '/v1/tie-paper-trader/performance'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.tiePaperTrader || {};
  res.json({
    engine: 'TiePaperTrader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get(['/tie-paper-trader/resets', '/v1/tie-paper-trader/resets'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.tiePaperTrader && store.tiePaperTrader.resets) || [];
  res.json({
    engine: 'TiePaperTrader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

// Tie Paper Trader — manual reset (clears ladder/window state, preserves
// config). Same intent as the 4SIL Paper Trader reset route above: an
// operator-triggered fresh start (e.g. after LADDER_LIMIT_REACHED)
// without wiping the full store. No auth required -- evaluation-only,
// no real-money state.
router.post(['/tie-paper-trader/reset', '/v1/tie-paper-trader/reset'], (req, res) => {
  const { freshTiePaperTraderState } = require('../engines/tiePaperTraderEngine');
  const existingConfig = store.tiePaperTrader && store.tiePaperTrader.config;
  store.tiePaperTrader = freshTiePaperTraderState(existingConfig);
  store.cachedSystemState = null; // invalidate snapshot
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'tie_paper_trader_reset_ok', tiePaperTrader: snapshot.tiePaperTrader });
});

// Tie Paper Trader — update config (stake ladder, starting capital,
// window size, payout multiplier). Resets the ledger after applying the
// new config so the ledger is always consistent with the config it was
// started under -- same behavior as the 4SIL Paper Trader config route
// above.
// Body (all fields optional):
//   ladder            — array of stake amounts (₦ per TIE trade per stage)
//   startingCapital   — new paper capital baseline (number)
//   windowSize        — 10 or 11
//   payoutMultiplier  — TIE payout odds (default 4, not 4SIL's 12)
router.post(['/tie-paper-trader/config', '/v1/tie-paper-trader/config'], (req, res) => {
  const { freshTiePaperTraderState, defaultConfig, WINDOW_SIZE_MIN, WINDOW_SIZE_MAX } = require('../engines/tiePaperTraderEngine');
  const body = req.body || {};
  const base = store.tiePaperTrader && store.tiePaperTrader.config
    ? { ...store.tiePaperTrader.config }
    : defaultConfig();

  if (Array.isArray(body.ladder)) {
    const ladder = body.ladder.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (ladder.length >= 2) base.ladder = ladder;
    else return res.status(400).json({ error: 'ladder must be an array of at least 2 positive numbers' });
  }

  if (body.startingCapital !== undefined) {
    const cap = Number(body.startingCapital);
    if (!Number.isFinite(cap) || cap <= 0)
      return res.status(400).json({ error: 'startingCapital must be a positive number' });
    base.startingCapital = cap;
  }

  if (body.windowSize !== undefined) {
    const ws = Number(body.windowSize);
    if (ws !== WINDOW_SIZE_MIN && ws !== WINDOW_SIZE_MAX)
      return res.status(400).json({ error: `windowSize must be ${WINDOW_SIZE_MIN} or ${WINDOW_SIZE_MAX}` });
    base.windowSize = ws;
  }

  if (body.payoutMultiplier !== undefined) {
    const pm = Number(body.payoutMultiplier);
    if (!Number.isFinite(pm) || pm <= 0)
      return res.status(400).json({ error: 'payoutMultiplier must be a positive number' });
    base.payoutMultiplier = pm;
  }

  store.tiePaperTrader = freshTiePaperTraderState(base);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'tie_paper_trader_config_updated', config: base, tiePaperTrader: snapshot.tiePaperTrader });
});

// ---------------------------------------------------------------------------
// 5-BALL DUAL-COLOR PAPER TRADER (10-rung ladder) -- read/reset/config
// routes. Same URL/response shape convention as the Tie Paper Trader
// routes above, pointed at fiveBallDualColorPaperTraderEngine.js /
// store.fiveBallDualColorPaperTrader / snapshot.fiveBallDualColorPaperTrader.
// See that engine's header for the two-phase-per-session, 10-rung,
// 85x-payout, instant-reset-on-hit ladder model.
// ---------------------------------------------------------------------------

router.get(['/five-ball-dual-color-paper-trader', '/v1/five-ball-dual-color-paper-trader'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fiveBallDualColorPaperTrader || null);
});

router.get(['/five-ball-dual-color-paper-trader/state', '/v1/five-ball-dual-color-paper-trader/state'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorPaperTrader || {};
  res.json({
    engine: '5-Ball Dual-Color Paper Trader',
    tradingState: pt.tradingState,
    currentLadderStage: pt.currentLadderStage,
    ladderLimitReached: pt.ladderLimitReached,
    updatedAt: pt.updatedAt
  });
});

router.get(['/five-ball-dual-color-paper-trader/current', '/v1/five-ball-dual-color-paper-trader/current'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorPaperTrader || {};
  res.json({
    engine: '5-Ball Dual-Color Paper Trader',
    tradeSession: pt.tradeSession,
    cycle: pt.cycle,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get(['/five-ball-dual-color-paper-trader/history', '/v1/five-ball-dual-color-paper-trader/history'], (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const trades = (store.fiveBallDualColorPaperTrader && store.fiveBallDualColorPaperTrader.trades) || [];
  res.json({
    engine: '5-Ball Dual-Color Paper Trader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.fiveBallDualColorPaperTrader ? snapshot.fiveBallDualColorPaperTrader.updatedAt : null
  });
});

router.get(['/five-ball-dual-color-paper-trader/sessions', '/v1/five-ball-dual-color-paper-trader/sessions'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorPaperTrader || {};
  const closedSessions = (store.fiveBallDualColorPaperTrader && store.fiveBallDualColorPaperTrader.sessions) || [];
  res.json({
    engine: '5-Ball Dual-Color Paper Trader',
    currentSession: pt.tradeSession,
    closedSessions: closedSessions.slice(0, limit)
  });
});

router.get(['/five-ball-dual-color-paper-trader/performance', '/v1/five-ball-dual-color-paper-trader/performance'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorPaperTrader || {};
  res.json({
    engine: '5-Ball Dual-Color Paper Trader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get(['/five-ball-dual-color-paper-trader/resets', '/v1/five-ball-dual-color-paper-trader/resets'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.fiveBallDualColorPaperTrader && store.fiveBallDualColorPaperTrader.resets) || [];
  res.json({
    engine: '5-Ball Dual-Color Paper Trader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

// Manual reset (clears ladder/session state, preserves config). Same
// intent as the Tie Paper Trader reset route above -- an
// operator-triggered fresh start (e.g. after LADDER_LIMIT_REACHED)
// without wiping the full store.
router.post(['/five-ball-dual-color-paper-trader/reset', '/v1/five-ball-dual-color-paper-trader/reset'], (req, res) => {
  const { freshState } = require('../engines/fiveBallDualColorPaperTraderEngine');
  const existingConfig = store.fiveBallDualColorPaperTrader && store.fiveBallDualColorPaperTrader.config;
  store.fiveBallDualColorPaperTrader = freshState(existingConfig);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'five_ball_dual_color_paper_trader_reset_ok', fiveBallDualColorPaperTrader: snapshot.fiveBallDualColorPaperTrader });
});

// Update config (payout multiplier or starting capital -- the ladder
// itself is derived from RUNG1_PHASE1_STAKE/RUNG_PHASE1_INCREMENT/
// PHASE2_SURCHARGE, not freely editable per-rung, since the whole point
// of this engine is the specific requested progression). Resets the
// ledger after applying the new config, same behavior as the other
// paper trader config routes.
// Body (all fields optional):
//   payoutMultiplier — odds paid on the winning color (default 85)
//   startingCapital  — new paper capital baseline (number)
router.post(['/five-ball-dual-color-paper-trader/config', '/v1/five-ball-dual-color-paper-trader/config'], (req, res) => {
  const { freshState, defaultConfig } = require('../engines/fiveBallDualColorPaperTraderEngine');
  const body = req.body || {};
  const base = store.fiveBallDualColorPaperTrader && store.fiveBallDualColorPaperTrader.config
    ? { ...store.fiveBallDualColorPaperTrader.config }
    : defaultConfig();

  if (body.payoutMultiplier !== undefined) {
    const pm = Number(body.payoutMultiplier);
    if (!Number.isFinite(pm) || pm <= 0)
      return res.status(400).json({ error: 'payoutMultiplier must be a positive number' });
    base.payoutMultiplier = pm;
  }

  if (body.startingCapital !== undefined) {
    const cap = Number(body.startingCapital);
    if (!Number.isFinite(cap) || cap <= 0)
      return res.status(400).json({ error: 'startingCapital must be a positive number' });
    base.startingCapital = cap;
  }

  store.fiveBallDualColorPaperTrader = freshState(base);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'five_ball_dual_color_paper_trader_config_updated', config: base, fiveBallDualColorPaperTrader: snapshot.fiveBallDualColorPaperTrader });
});

// ---------------------------------------------------------------------------
// 5-BALL DUAL-COLOR ADAPTIVE PAPER TRADER (FLAT / TIER_WEIGHTED / KELLY
// sizing, missStreakCap circuit breaker) -- read/reset/config routes.
// Same convention as the ladder trader routes directly above, pointed at
// fiveBallDualColorAdaptiveTraderEngine.js /
// store.fiveBallDualColorAdaptiveTrader /
// snapshot.fiveBallDualColorAdaptiveTrader.
// ---------------------------------------------------------------------------

router.get(['/five-ball-dual-color-adaptive-trader', '/v1/five-ball-dual-color-adaptive-trader'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fiveBallDualColorAdaptiveTrader || null);
});

router.get(['/five-ball-dual-color-adaptive-trader/state', '/v1/five-ball-dual-color-adaptive-trader/state'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorAdaptiveTrader || {};
  res.json({
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    tradingState: pt.tradingState,
    missStreak: pt.missStreak,
    streakCapReached: pt.streakCapReached,
    updatedAt: pt.updatedAt
  });
});

router.get(['/five-ball-dual-color-adaptive-trader/current', '/v1/five-ball-dual-color-adaptive-trader/current'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorAdaptiveTrader || {};
  res.json({
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    tradeSession: pt.tradeSession,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get(['/five-ball-dual-color-adaptive-trader/history', '/v1/five-ball-dual-color-adaptive-trader/history'], (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const trades = (store.fiveBallDualColorAdaptiveTrader && store.fiveBallDualColorAdaptiveTrader.trades) || [];
  res.json({
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.fiveBallDualColorAdaptiveTrader ? snapshot.fiveBallDualColorAdaptiveTrader.updatedAt : null
  });
});

router.get(['/five-ball-dual-color-adaptive-trader/sessions', '/v1/five-ball-dual-color-adaptive-trader/sessions'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorAdaptiveTrader || {};
  const closedSessions = (store.fiveBallDualColorAdaptiveTrader && store.fiveBallDualColorAdaptiveTrader.sessions) || [];
  res.json({
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    currentSession: pt.tradeSession,
    closedSessions: closedSessions.slice(0, limit)
  });
});

router.get(['/five-ball-dual-color-adaptive-trader/performance', '/v1/five-ball-dual-color-adaptive-trader/performance'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.fiveBallDualColorAdaptiveTrader || {};
  res.json({
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get(['/five-ball-dual-color-adaptive-trader/resets', '/v1/five-ball-dual-color-adaptive-trader/resets'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.fiveBallDualColorAdaptiveTrader && store.fiveBallDualColorAdaptiveTrader.resets) || [];
  res.json({
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

router.post(['/five-ball-dual-color-adaptive-trader/reset', '/v1/five-ball-dual-color-adaptive-trader/reset'], (req, res) => {
  const { freshState } = require('../engines/fiveBallDualColorAdaptiveTraderEngine');
  const existingConfig = store.fiveBallDualColorAdaptiveTrader && store.fiveBallDualColorAdaptiveTrader.config;
  store.fiveBallDualColorAdaptiveTrader = freshState(existingConfig);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'five_ball_dual_color_adaptive_trader_reset_ok', fiveBallDualColorAdaptiveTrader: snapshot.fiveBallDualColorAdaptiveTrader });
});

// Update config -- the whole point of this engine, so most fields are
// editable here (unlike the ladder trader's config route above).
// Body (all fields optional):
//   sizingMode        — 'FLAT' | 'TIER_WEIGHTED' | 'KELLY'
//   flatStakePerColor — ₦ stake per color for FLAT/TIER_WEIGHTED base (default 100)
//   tierMultipliers   — { EXPLORATORY, EMERGING, ESTABLISHED, STRONG } (TIER_WEIGHTED only)
//   kellyFraction     — fraction of full Kelly to use (default 0.25)
//   minStakePerColor / maxStakePerColor — KELLY stake clamp
//   missStreakCap     — consecutive session MISSes before pausing (default 5)
//   payoutMultiplier  — odds paid on the winning color (default 85)
//   startingCapital   — new paper capital baseline (number)
router.post(['/five-ball-dual-color-adaptive-trader/config', '/v1/five-ball-dual-color-adaptive-trader/config'], (req, res) => {
  const { freshState, defaultConfig } = require('../engines/fiveBallDualColorAdaptiveTraderEngine');
  const body = req.body || {};
  const base = store.fiveBallDualColorAdaptiveTrader && store.fiveBallDualColorAdaptiveTrader.config
    ? { ...store.fiveBallDualColorAdaptiveTrader.config }
    : defaultConfig();

  if (body.sizingMode !== undefined) {
    if (['FLAT', 'TIER_WEIGHTED', 'KELLY'].indexOf(body.sizingMode) === -1)
      return res.status(400).json({ error: "sizingMode must be 'FLAT', 'TIER_WEIGHTED', or 'KELLY'" });
    base.sizingMode = body.sizingMode;
  }
  if (body.flatStakePerColor !== undefined) {
    const s = Number(body.flatStakePerColor);
    if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'flatStakePerColor must be a positive number' });
    base.flatStakePerColor = s;
  }
  if (body.tierMultipliers && typeof body.tierMultipliers === 'object') {
    base.tierMultipliers = { ...base.tierMultipliers, ...body.tierMultipliers };
  }
  if (body.kellyFraction !== undefined) {
    const f = Number(body.kellyFraction);
    if (!Number.isFinite(f) || f <= 0 || f > 1) return res.status(400).json({ error: 'kellyFraction must be a number between 0 and 1' });
    base.kellyFraction = f;
  }
  if (body.minStakePerColor !== undefined) {
    const s = Number(body.minStakePerColor);
    if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'minStakePerColor must be a positive number' });
    base.minStakePerColor = s;
  }
  if (body.maxStakePerColor !== undefined) {
    const s = Number(body.maxStakePerColor);
    if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'maxStakePerColor must be a positive number' });
    base.maxStakePerColor = s;
  }
  if (body.missStreakCap !== undefined) {
    const c = Number(body.missStreakCap);
    if (!Number.isInteger(c) || c <= 0) return res.status(400).json({ error: 'missStreakCap must be a positive integer' });
    base.missStreakCap = c;
  }
  if (body.payoutMultiplier !== undefined) {
    const pm = Number(body.payoutMultiplier);
    if (!Number.isFinite(pm) || pm <= 0) return res.status(400).json({ error: 'payoutMultiplier must be a positive number' });
    base.payoutMultiplier = pm;
  }
  if (body.startingCapital !== undefined) {
    const cap = Number(body.startingCapital);
    if (!Number.isFinite(cap) || cap <= 0) return res.status(400).json({ error: 'startingCapital must be a positive number' });
    base.startingCapital = cap;
  }

  store.fiveBallDualColorAdaptiveTrader = freshState(base);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'five_ball_dual_color_adaptive_trader_config_updated', config: base, fiveBallDualColorAdaptiveTrader: snapshot.fiveBallDualColorAdaptiveTrader });
});

// ---------------------------------------------------------------------------
// 3SIL NEXT EVENT PAPER TRADER -- read/reset/config routes. Direct
// structural mirror of the Tie Paper Trader routes immediately above
// (same URL shape, same validation, same reset-on-config-change
// behavior), just pointed at threeSilPaperTraderEngine.js /
// store.threeSilPaperTrader / snapshot.threeSilPaperTrader instead. See
// threeSilPaperTraderEngine.js's header for how its signal/market model
// differs from the tie trader's (ENTER derived from 3SIL's Next Event
// Leaderboard badge.active/badge.topColor; single top-color market at
// 3.8x payout instead of the tie trader's single TIE market at 4x; same
// 2 attempts per ladder stage).
// ---------------------------------------------------------------------------

router.get(['/three-sil-paper-trader', '/v1/three-sil-paper-trader'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.threeSilPaperTrader || null);
});

router.get(['/three-sil-paper-trader/state', '/v1/three-sil-paper-trader/state'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeSilPaperTrader || {};
  res.json({
    engine: 'ThreeSilPaperTrader',
    tradingState: pt.tradingState,
    signal: pt.signal,
    ladderLimitReached: pt.ladderLimitReached,
    updatedAt: pt.updatedAt
  });
});

router.get(['/three-sil-paper-trader/current', '/v1/three-sil-paper-trader/current'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeSilPaperTrader || {};
  res.json({
    engine: 'ThreeSilPaperTrader',
    cycle: pt.cycle,
    window: pt.window,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get(['/three-sil-paper-trader/history', '/v1/three-sil-paper-trader/history'], (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const trades = (store.threeSilPaperTrader && store.threeSilPaperTrader.trades) || [];
  res.json({
    engine: 'ThreeSilPaperTrader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.threeSilPaperTrader ? snapshot.threeSilPaperTrader.updatedAt : null
  });
});

router.get(['/three-sil-paper-trader/windows', '/v1/three-sil-paper-trader/windows'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeSilPaperTrader || {};
  const closedWindows = (store.threeSilPaperTrader && store.threeSilPaperTrader.windows) || [];
  res.json({
    engine: 'ThreeSilPaperTrader',
    currentWindow: pt.window,
    closedWindows: closedWindows.slice(0, limit)
  });
});

router.get(['/three-sil-paper-trader/cycles', '/v1/three-sil-paper-trader/cycles'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeSilPaperTrader || {};
  const closedCycles = (store.threeSilPaperTrader && store.threeSilPaperTrader.cycles) || [];
  res.json({
    engine: 'ThreeSilPaperTrader',
    currentCycle: pt.cycle,
    closedCycles: closedCycles.slice(0, limit)
  });
});

router.get(['/three-sil-paper-trader/performance', '/v1/three-sil-paper-trader/performance'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeSilPaperTrader || {};
  res.json({
    engine: 'ThreeSilPaperTrader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get(['/three-sil-paper-trader/resets', '/v1/three-sil-paper-trader/resets'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.threeSilPaperTrader && store.threeSilPaperTrader.resets) || [];
  res.json({
    engine: 'ThreeSilPaperTrader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

// 3SIL Next Event Paper Trader — manual reset (clears ladder/window
// state, preserves config). Same intent as the Tie Paper Trader reset
// route above.
router.post(['/three-sil-paper-trader/reset', '/v1/three-sil-paper-trader/reset'], (req, res) => {
  const { freshThreeSilPaperTraderState } = require('../engines/threeSilPaperTraderEngine');
  const existingConfig = store.threeSilPaperTrader && store.threeSilPaperTrader.config;
  store.threeSilPaperTrader = freshThreeSilPaperTraderState(existingConfig);
  store.cachedSystemState = null; // invalidate snapshot
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'three_sil_paper_trader_reset_ok', threeSilPaperTrader: snapshot.threeSilPaperTrader });
});

// 3SIL Next Event Paper Trader — update config (stake ladder, starting
// capital, window size, payout multiplier). Resets the ledger after
// applying the new config, same behavior as the Tie Paper Trader config
// route above.
// Body (all fields optional):
//   ladder            — array of stake amounts (₦ per trade per stage)
//   startingCapital   — new paper capital baseline (number)
//   windowSize        — 10 or 11
//   payoutMultiplier  — top-color payout odds (default 3.8, not the tie trader's 4)
router.post(['/three-sil-paper-trader/config', '/v1/three-sil-paper-trader/config'], (req, res) => {
  const { freshThreeSilPaperTraderState, defaultConfig, WINDOW_SIZE_MIN, WINDOW_SIZE_MAX } = require('../engines/threeSilPaperTraderEngine');
  const body = req.body || {};
  const base = store.threeSilPaperTrader && store.threeSilPaperTrader.config
    ? { ...store.threeSilPaperTrader.config }
    : defaultConfig();

  if (Array.isArray(body.ladder)) {
    const ladder = body.ladder.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (ladder.length >= 2) base.ladder = ladder;
    else return res.status(400).json({ error: 'ladder must be an array of at least 2 positive numbers' });
  }

  if (body.startingCapital !== undefined) {
    const cap = Number(body.startingCapital);
    if (!Number.isFinite(cap) || cap <= 0)
      return res.status(400).json({ error: 'startingCapital must be a positive number' });
    base.startingCapital = cap;
  }

  if (body.windowSize !== undefined) {
    const ws = Number(body.windowSize);
    if (ws !== WINDOW_SIZE_MIN && ws !== WINDOW_SIZE_MAX)
      return res.status(400).json({ error: `windowSize must be ${WINDOW_SIZE_MIN} or ${WINDOW_SIZE_MAX}` });
    base.windowSize = ws;
  }

  if (body.payoutMultiplier !== undefined) {
    const pm = Number(body.payoutMultiplier);
    if (!Number.isFinite(pm) || pm <= 0)
      return res.status(400).json({ error: 'payoutMultiplier must be a positive number' });
    base.payoutMultiplier = pm;
  }

  store.threeSilPaperTrader = freshThreeSilPaperTraderState(base);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'three_sil_paper_trader_config_updated', config: base, threeSilPaperTrader: snapshot.threeSilPaperTrader });
});

// ---------------------------------------------------------------------------
// MAIN 3-BALL COLOR PAPER TRADER -- read/reset/config routes. Direct
// structural mirror of the 3SIL Next Event Paper Trader routes
// immediately above (same URL shape, same validation, same
// reset-on-config-change behavior), just pointed at
// threeBallColorPaperTraderEngine.js / store.threeBallColorPaperTrader /
// snapshot.threeBallColorPaperTrader instead. See
// threeBallColorPaperTraderEngine.js's header for how its signal/market
// model differs from the 3SIL trader's (ENTER derived from
// threeBallColorEngine's available/trackedColor instead of 3SIL's
// badge.active/badge.topColor; otherwise identical -- same single
// tracked-color market at 3.8x payout, same 2 attempts per ladder
// stage).
// ---------------------------------------------------------------------------

router.get(['/three-ball-color-paper-trader', '/v1/three-ball-color-paper-trader'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.threeBallColorPaperTrader || null);
});

router.get(['/three-ball-color-paper-trader/state', '/v1/three-ball-color-paper-trader/state'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeBallColorPaperTrader || {};
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    tradingState: pt.tradingState,
    signal: pt.signal,
    ladderLimitReached: pt.ladderLimitReached,
    updatedAt: pt.updatedAt
  });
});

router.get(['/three-ball-color-paper-trader/current', '/v1/three-ball-color-paper-trader/current'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeBallColorPaperTrader || {};
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    cycle: pt.cycle,
    window: pt.window,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get(['/three-ball-color-paper-trader/history', '/v1/three-ball-color-paper-trader/history'], (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const trades = (store.threeBallColorPaperTrader && store.threeBallColorPaperTrader.trades) || [];
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.threeBallColorPaperTrader ? snapshot.threeBallColorPaperTrader.updatedAt : null
  });
});

router.get(['/three-ball-color-paper-trader/windows', '/v1/three-ball-color-paper-trader/windows'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeBallColorPaperTrader || {};
  const closedWindows = (store.threeBallColorPaperTrader && store.threeBallColorPaperTrader.windows) || [];
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    currentWindow: pt.window,
    closedWindows: closedWindows.slice(0, limit)
  });
});

router.get(['/three-ball-color-paper-trader/cycles', '/v1/three-ball-color-paper-trader/cycles'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeBallColorPaperTrader || {};
  const closedCycles = (store.threeBallColorPaperTrader && store.threeBallColorPaperTrader.cycles) || [];
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    currentCycle: pt.cycle,
    closedCycles: closedCycles.slice(0, limit)
  });
});

router.get(['/three-ball-color-paper-trader/performance', '/v1/three-ball-color-paper-trader/performance'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  const pt = snapshot.threeBallColorPaperTrader || {};
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get(['/three-ball-color-paper-trader/resets', '/v1/three-ball-color-paper-trader/resets'], (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.threeBallColorPaperTrader && store.threeBallColorPaperTrader.resets) || [];
  res.json({
    engine: 'ThreeBallColorPaperTrader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

// Main 3-Ball Color Paper Trader — manual reset (clears ladder/window
// state, preserves config). Same intent as the 3SIL Paper Trader reset
// route above.
router.post(['/three-ball-color-paper-trader/reset', '/v1/three-ball-color-paper-trader/reset'], (req, res) => {
  const { freshThreeBallColorPaperTraderState } = require('../engines/threeBallColorPaperTraderEngine');
  const existingConfig = store.threeBallColorPaperTrader && store.threeBallColorPaperTrader.config;
  store.threeBallColorPaperTrader = freshThreeBallColorPaperTraderState(existingConfig);
  store.cachedSystemState = null; // invalidate snapshot
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'three_ball_color_paper_trader_reset_ok', threeBallColorPaperTrader: snapshot.threeBallColorPaperTrader });
});

// Main 3-Ball Color Paper Trader — update config (stake ladder, starting
// capital, window size, payout multiplier). Resets the ledger after
// applying the new config, same behavior as the 3SIL Paper Trader config
// route above.
// Body (all fields optional):
//   ladder            — array of stake amounts (₦ per trade per stage)
//   startingCapital   — new paper capital baseline (number)
//   windowSize        — 10 or 11
//   payoutMultiplier  — tracked-color payout odds (default 3.8, same as the 3SIL trader)
router.post(['/three-ball-color-paper-trader/config', '/v1/three-ball-color-paper-trader/config'], (req, res) => {
  const { freshThreeBallColorPaperTraderState, defaultConfig, WINDOW_SIZE_MIN, WINDOW_SIZE_MAX } = require('../engines/threeBallColorPaperTraderEngine');
  const body = req.body || {};
  const base = store.threeBallColorPaperTrader && store.threeBallColorPaperTrader.config
    ? { ...store.threeBallColorPaperTrader.config }
    : defaultConfig();

  if (Array.isArray(body.ladder)) {
    const ladder = body.ladder.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (ladder.length >= 2) base.ladder = ladder;
    else return res.status(400).json({ error: 'ladder must be an array of at least 2 positive numbers' });
  }

  if (body.startingCapital !== undefined) {
    const cap = Number(body.startingCapital);
    if (!Number.isFinite(cap) || cap <= 0)
      return res.status(400).json({ error: 'startingCapital must be a positive number' });
    base.startingCapital = cap;
  }

  if (body.windowSize !== undefined) {
    const ws = Number(body.windowSize);
    if (ws !== WINDOW_SIZE_MIN && ws !== WINDOW_SIZE_MAX)
      return res.status(400).json({ error: `windowSize must be ${WINDOW_SIZE_MIN} or ${WINDOW_SIZE_MAX}` });
    base.windowSize = ws;
  }

  if (body.payoutMultiplier !== undefined) {
    const pm = Number(body.payoutMultiplier);
    if (!Number.isFinite(pm) || pm <= 0)
      return res.status(400).json({ error: 'payoutMultiplier must be a positive number' });
    base.payoutMultiplier = pm;
  }

  store.threeBallColorPaperTrader = freshThreeBallColorPaperTraderState(base);
  store.cachedSystemState = null;
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'three_ball_color_paper_trader_config_updated', config: base, threeBallColorPaperTrader: snapshot.threeBallColorPaperTrader });
});

module.exports = router;
