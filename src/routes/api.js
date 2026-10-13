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

// Identifies which collector installation sent a request, for health
// telemetry keying. Prefers the API key (stable per collector install and
// already required for real deployments); falls back to a fixed label
// when auth is off (dev/single-collector setups) so bySource still has a
// consistent key instead of one entry per request.
function collectorSourceId(req) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (apiKey && typeof apiKey === 'string') {
    return `key:${crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;
  }
  return 'default';
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
  // v2.3.0 collector: draws POSTs now carry a `health` object describing
  // Bet9ja/session health (poll success/failure, staleness, queue depth,
  // circuit state) alongside the draws. Older collector versions simply
  // omit the field, so this stays a no-op for them.
  if (req.body && req.body.health) {
    store.updateCollectorHealth(collectorSourceId(req), req.body.health);
  }
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json({
    status: 'ok',
    ingest: result,
    snapshot
  });
});

// Bet9ja collector health -- what the extension reports about its own
// draw source (Bet9ja page + session), not this server's own uptime
// (that's /api/health). Returns every known source's latest snapshot plus
// a worst-of-all rollup so the dashboard can show one badge even with
// multiple collector installs feeding in.
router.get(['/collector-health', '/v1/collector-health'], (req, res) => {
  const sources = Object.values(store.collectorHealth.bySource);
  const worst = sources.reduce((acc, s) => (!acc || s.score < acc.score ? s : acc), null);
  res.json({
    sources,
    worst,
    historyTail: store.collectorHealth.history.slice(0, 50)
  });
});

// Snapshot & Intelligence Feeds
router.get(['/snapshot', '/v1/snapshot'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot);
});

// Lightweight cursor endpoint for collectors/extensions -- so a client
// can check what's already been ingested (last drawId + a small tail of
// recent IDs) WITHOUT pulling the full (heavy) /api/snapshot payload,
// and only POST draws newer than that. Reduces duplicate-heavy ingest
// traffic like the 772-rejected/20-accepted pattern seen when a
// collector blindly re-sends its whole local batch every cycle.
router.get(['/ingest-cursor', '/v1/ingest-cursor'], (req, res) => {
  const recentIds = store.historicalDraws.slice(0, 25).map(d => d.drawId);
  res.json({
    lastDrawId: store.ingestStats && store.ingestStats.lastDrawId ? store.ingestStats.lastDrawId : null,
    recentDrawIds: recentIds,
    totalDrawsIngested: store.ingestStats ? store.ingestStats.totalDrawsIngested || 0 : 0,
    acceptedDraws: store.ingestStats ? store.ingestStats.acceptedDraws || 0 : 0
  });
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

// Reset Utility
router.post(['/reset', '/v1/reset'], checkAuth, (req, res) => {
  store.resetStore();
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'reset_ok', snapshot });
});

// NOTE: the 4SIL ENTER Call — 4-Ball Event Density Log
// (fourBallEnterCallLog.js) and its dedicated /four-ball-enter-log route
// were removed per operator direction.

// 4SIL Hit Average Engine -- dedicated read for the running average.
// Now a thin pass-through since the engine is stateless (see
// fourSilHitAverageEngine.js's header).
router.get(['/four-sil-hit-average', '/v1/four-sil-hit-average'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fourSilHitAverage || {});
});

// 4-Ball Color Next Event Engine -- dedicated read for
// fourBallColorNextEventEngine.js's analyzeFourBallColorNextEvent()
// output (per-color last-played/interval/season stats, and next-event
// color prediction). Already present in full on GET /v1/snapshot's own
// fourBallColorNextEvent field; this just avoids fetching the whole
// snapshot when only this is wanted. Same convenience pattern as the
// other dedicated reads on this router.
router.get(['/fourball-color-next-event', '/v1/fourball-color-next-event'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fourBallColorNextEvent);
});

// 4-Ball Color Next Event Hit Counter -- dedicated read for
// fourBallColorNextEventHitCounter.js's evaluateFourBallColorNextEventHitCounter()
// output (continuous predictedNextColor hit/miss scoring log). Already
// present in full on GET /v1/snapshot's own fourBallColorNextEventHitCounter
// field; this just avoids fetching the whole snapshot when only this is
// wanted. Same convenience pattern as the other dedicated reads on this
// router.
router.get(['/fourball-color-next-event-hit-counter', '/v1/fourball-color-next-event-hit-counter'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fourBallColorNextEventHitCounter);
});

// Window Section Tracker -- dedicated read for windowSectionTracker.js's
// evaluateWindowSectionTracker() output (which section of the 8-draw
// window -- ~4 zone vs overdue +1..+4 -- the Zero Color and 4-Ball Next
// Event HITs landed in). Also present in full on GET /v1/snapshot's own
// windowSectionTracker field. Same convenience pattern as the other
// dedicated reads on this router.
router.get(['/window-section-tracker', '/v1/window-section-tracker'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.windowSectionTracker);
});

// 4-Ball → Zero-Color Correlation Engine -- cross-event intelligence:
// how 4-ball events predict zero-color windows. See
// fourBallZeroCorrelationEngine.js. Also present in full on GET
// /v1/snapshot's own fourBallZeroCorrelation field.
router.get(['/fourball-zero-correlation', '/v1/fourball-zero-correlation'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.fourBallZeroCorrelation);
});

// NOTE: the 4SIL Paper Trader Engine (paperTraderEngine.js) and its
// read/reset/config routes, plus the 4SIL Next Event Intelligence
// Engine (4SIL-NEI, fourSilNextEventIntelEngine.js) and its route, were
// removed per operator direction.
// ---------------------------------------------------------------------------
// TIE PAPER TRADER -- read/reset/config routes. Was a direct structural
// mirror of the 4SIL Paper Trader routes (same URL shape, same
// validation, same reset-on-config-change behavior; that 4SIL Paper
// Trader has since been removed, see the NOTE above), just pointed
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
