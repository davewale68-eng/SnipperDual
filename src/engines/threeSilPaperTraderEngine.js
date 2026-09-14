/**
 * 3SIL NEXT EVENT PAPER TRADER ENGINE — v1.0
 * (direct structural clone of tiePaperTraderEngine.js, re-pointed at
 *  threeBallSeasonIntelligenceLab.js's Next Event Leaderboard instead of
 *  the Tie Next Event Engine's Trade Penetration signal)
 *
 * PURPOSE
 * -------
 * A virtual/paper trading engine that consumes threeBallSeasonIntelligence
 * Lab.js's Next Event Leaderboard (badge.topColor / badge.active) and
 * measures how a fixed stake ladder would have performed staking the
 * leaderboard's top-ranked color every draw a forecast is live, against
 * real draw outcomes.
 *
 *   LIVE DRAW DATA -> threeBallSeasonIntelligenceLab (3SIL) -> badge
 *     (active / topColor) -> 3SIL PAPER TRADER -> VIRTUAL TRADE ->
 *     RESULT EVALUATOR -> LADDER + WINDOW + CAPITAL ACCOUNTING
 *
 * No real-money betting is performed anywhere in this module. It never
 * writes to any real order/betting surface and it never feeds a signal,
 * weight, or gate back into threeBallSeasonIntelligenceLab or any other
 * engine (ABSOLUTE SEPARATION RULE) -- this is a read-only evaluation
 * consumer, following the exact same one-way boundary tiePaperTrader
 * Engine.js enforces against tieNextEventEngine.

 *
 * EVERYTHING BELOW IS AN INTENTIONAL, LINE-FOR-LINE MIRROR OF
 * tiePaperTraderEngine.js -- same ladder table, same starting capital,
 * same 2-attempts-per-stage ladder repeat strategy, same window size,
 * same single reset trigger (2 consecutive HITs at the same ladder
 * stage, window-hit trigger not ported, identical to the tie trader),
 * same config/reset API shape. The ONLY two deliberate departures are:
 *
 * SIGNAL MAPPING (deliberate departure #1)
 * ------------------------------------------
 * threeBallSeasonIntelligenceLab.js's Next Event Leaderboard has no
 * ENTER/HOLD/TAKE PROFIT/WINDOW CLOSED lifecycle the way the Tie Next
 * Event Engine's Trade Penetration state machine does -- per
 * threeBallNextEventHitCounter.js's own header, "the leaderboard has a
 * topColor every single cycle" once 3SIL is active, so it is never idle
 * waiting for a gate to open. The signal therefore collapses to:
 *   3SIL inactive OR no topColor (badge.active === false ||
 *     !badge.topColor)                                    -> 'PAUSE'
 *   3SIL active AND a topColor forecast exists              -> 'ENTER'
 * Trading is permitted ONLY on 'ENTER', exactly like the tie trader.
 *
 * MARKET MODEL (deliberate departure #2)
 * -----------------------------------------
 * The market staked is "the Next Event Leaderboard's #1-ranked color
 * (badge.topColor) will be this draw's threeBallColor" -- a single
 * market per draw at the same per-stage ladder amount, exactly the same
 * "flat stake per rung, fixed payout multiplier on a HIT" mechanic the
 * tie trader uses for its single TIE market, just resized to a
 * single-color-forecast market instead of a tie/no-tie market. The
 * forecast color used to grade a batch of newly-arrived draws is the
 * SAME badge.topColor captured once for this council cycle's call --
 * identical convention to the tie trader, which also derives one signal
 * per call and replays it across every new draw in that cycle's batch
 * rather than re-deriving a signal per historical draw.
 *
 * REQUESTED DELTA FROM THE TIE TRADER (the only numeric change)
 * -----------------------------------------------------------------
 *   DEFAULT_PAYOUT_MULTIPLIER = 3.8   (the tie trader uses 4)
 * Ladder table, ATTEMPTS_PER_LADDER_STAGE (2), window size (10),
 * SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD (2), and
 * DEFAULT_STARTING_CAPITAL (₦100,000) are all unchanged from the tie
 * trader.
 *
 * DEBOUNCING / IDEMPOTENCY
 * -------------------------
 * Same as the tie trader: a trade happens only when a NEW eligible draw
 * (drawId strictly greater than lastProcessedDrawId) arrives while the
 * signal is ENTER; lastProcessedDrawId is the dedup key.
 *
 * This engine is OBSERVATIONAL/EVALUATIVE ONLY: it must be called AFTER
 * threeBallSeasonIntelligenceLab.js each council cycle and never before,
 * and its own state must never be read back into 3SIL or any gate/weight.
 */
'use strict';

const MAX_TRADE_LOG_ENTRIES = 3000;
const MAX_WINDOW_LOG_ENTRIES = 500;
const MAX_CYCLE_LOG_ENTRIES = 500;
const MAX_RESET_LOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Default production configuration -- identical ladder/capital/window/reset
// values to tiePaperTraderEngine.js, per the request to mirror it exactly.
// ---------------------------------------------------------------------------

// Ladder table -- identical to the tie trader. Index 0 = Stage 1 (₦50) ...
// index 11 = Stage 12 (₦3,000). Configurable via config.ladder.
const DEFAULT_LADDER = [50, 75, 100, 150, 200, 300, 400, 550, 700, 1000, 1500, 2000, 3000, 4000, 5500, 7000, 13000];

// Identical to the tie trader: each ladder stage is repeated 2x --
// e.g. Stage 1 @ ₦50 gets 2 consecutive eligible trades before the
// engine advances to Stage 2 @ ₦100.
const ATTEMPTS_PER_LADDER_STAGE = 2;

// Draw window clock -- identical to the tie trader. The window boundary
// used to CLOSE a window and open the next one.
const WINDOW_SIZE_MIN = 10;
const WINDOW_SIZE_MAX = 11;
const DEFAULT_WINDOW_SIZE = WINDOW_SIZE_MIN;

// Reset trigger -- identical to the tie trader: 2 consecutive HITs at the
// SAME ladder stage triggers an immediate ladder reset, regardless of
// stake size. No window-hit trigger (same reasoning as the tie trader:
// that trigger was calibrated against 4SIL's 12x payout and doesn't
// transfer cleanly to a lower-payout single-outcome market).
const SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD = 2;

// REQUESTED DELTA: payout is 3.8-odds here (single top-color-forecast
// market), vs. the tie trader's 4-odds (single TIE market).
const DEFAULT_PAYOUT_MULTIPLIER = 3.8;

// Paper capital -- identical to the tie trader.
const DEFAULT_STARTING_CAPITAL = 100000;

function defaultConfig() {
  return {
    ladder: DEFAULT_LADDER.slice(),
    attemptsPerStage: ATTEMPTS_PER_LADDER_STAGE,
    windowSize: DEFAULT_WINDOW_SIZE,
    sameStageConsecutiveHitResetThreshold: SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD,
    payoutMultiplier: DEFAULT_PAYOUT_MULTIPLIER,
    startingCapital: DEFAULT_STARTING_CAPITAL
  };
}

// ---------------------------------------------------------------------------
// State factory (persisted at store.threeSilPaperTrader) -- same shape as
// tiePaperTraderEngine.js, minus the TIE-specific `market` label (this
// engine's market is the forecasted color instead of TIE).
// ---------------------------------------------------------------------------

function freshLadderCycle(cycleId, startingCapital) {
  return {
    cycleId,
    startedAt: new Date().toISOString(),
    closedAt: null,
    startingCapital,
    endingCapital: null,
    stage: 1,                // 1-based index into config.ladder
    attempt: 0,               // attempts completed at the current stage
    stageHits: 0,
    stageMisses: 0,
    consecutiveHits: 0,       // consecutive HITs at the CURRENT stage only
    lastResultAtStage: null,  // 'HIT' | 'MISS' | null -- resets whenever the stage changes
    maxStageReached: 1,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    resetTriggered: false,
    resetReason: null
  };
}

function freshDrawWindow(windowId) {
  return {
    windowId,
    startDrawId: null,
    endDrawId: null,
    eligibleDraws: 0,
    hits: 0,
    misses: 0,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    startingCapital: null,
    endingCapital: null,
    startingLadderStage: null,
    endingLadderStage: null,
    resetTriggered: false,
    resetReason: null,
    closedAt: null
  };
}

function freshThreeSilPaperTraderState(config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };
  return {
    schemaVersion: 1,
    config: cfg,

    // WAITING_FOR_ENTER | ACTIVE | PAUSED | LADDER_LIMIT_REACHED
    tradingState: 'WAITING_FOR_ENTER',
    signal: null,            // last derived signal: ENTER | PAUSE
    ladderLimitReached: false,

    lastProcessedDrawId: null,

    // ENTER-run tracking, same convention as tiePaperTraderEngine.js -- a
    // "run" is one unbroken stretch of ENTER draws, independent of
    // ladder cycleId (which can reset mid-run without a genuine break in
    // the underlying ENTER signal).
    wasLastDrawEnter: false,
    enterRun: { id: 0, startDrawId: null, drawsIntoRun: 0 },

    nextCycleId: 1,
    nextWindowId: 1,

    cycle: freshLadderCycle(1, cfg.startingCapital),
    window: freshDrawWindow(1),

    capital: {
      startingCapital: cfg.startingCapital,
      currentCapital: cfg.startingCapital,
      realizedPnL: 0,
      lockedProfit: 0,
      totalStaked: 0,
      totalReturned: 0
    },

    trades: [],   // newest-first
    windows: [],  // closed windows, newest-first
    cycles: [],   // closed cycles, newest-first
    resets: [],   // reset events, newest-first

    updatedAt: null
  };
}

// Mutates persistentState IN PLACE and returns the same reference --
// same convention as tiePaperTraderEngine.js's ensureStateShape():
// council.js passes store.threeSilPaperTrader directly and never
// reassigns it, so a copy here would silently detach the live state
// from the store.
function ensureStateShape(persistentState) {
  const fresh = freshThreeSilPaperTraderState();
  const s = persistentState && typeof persistentState === 'object' ? persistentState : fresh;
  if (s.schemaVersion == null) s.schemaVersion = 1;
  s.config = { ...fresh.config, ...(s.config || {}) };
  if (!s.tradingState) s.tradingState = fresh.tradingState;
  if (typeof s.signal === 'undefined') s.signal = null;
  s.ladderLimitReached = Boolean(s.ladderLimitReached);
  if (typeof s.lastProcessedDrawId === 'undefined') s.lastProcessedDrawId = null;
  if (typeof s.wasLastDrawEnter === 'undefined') s.wasLastDrawEnter = false;
  if (!s.enterRun || typeof s.enterRun !== 'object') s.enterRun = { id: 0, startDrawId: null, drawsIntoRun: 0 };
  if (!s.nextCycleId) s.nextCycleId = fresh.nextCycleId;
  if (!s.nextWindowId) s.nextWindowId = fresh.nextWindowId;
  if (!s.cycle || typeof s.cycle !== 'object') s.cycle = fresh.cycle;
  if (!s.window || typeof s.window !== 'object') s.window = fresh.window;
  if (!s.capital || typeof s.capital !== 'object') s.capital = fresh.capital;
  if (!Array.isArray(s.trades)) s.trades = [];
  if (!Array.isArray(s.windows)) s.windows = [];
  if (!Array.isArray(s.cycles)) s.cycles = [];
  if (!Array.isArray(s.resets)) s.resets = [];
  if (typeof s.updatedAt === 'undefined') s.updatedAt = null;
  return s;
}

// ---------------------------------------------------------------------------
// Signal derivation -- see header comment for the mapping rationale.
// ---------------------------------------------------------------------------

function deriveSignal(threeSIL) {
  const t = threeSIL || {};
  const badge = t.badge || null;
  if (!badge || badge.active === false || !badge.topColor) return 'PAUSE';
  return 'ENTER';
}

function deriveForecastColor(threeSIL) {
  const t = threeSIL || {};
  const badge = t.badge || null;
  return badge ? badge.topColor || null : null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the 3SIL paper trader for the current council cycle.
 * Must be called AFTER threeBallSeasonIntelligenceLab.js
 * (evaluateThreeBallSeasonIntelligenceLab) each cycle -- see header for
 * the separation rule.
 *
 * @param {Array} historicalDraws newest-first draw history (store.getRecentDraws)
 * @param {Object} threeSIL       this cycle's evaluateThreeBallSeasonIntelligenceLab() result
 * @param {Object} persistentState store.threeSilPaperTrader (mutated in place)
 * @returns {Object} read-only summary for snapshot / dashboard
 */
function advanceThreeSilPaperTrader(historicalDraws, threeSIL, persistentState) {
  const state = ensureStateShape(persistentState);
  const cfg = state.config;
  const draws = Array.isArray(historicalDraws) ? historicalDraws : [];
  const signal = deriveSignal(threeSIL);
  const forecastColor = deriveForecastColor(threeSIL);
  state.signal = signal;

  // Collect draws newer than lastProcessedDrawId, oldest-first, so ladder
  // and window state advances in real chronological order -- same
  // debouncing/idempotency convention as tiePaperTraderEngine.js.
  const lastId = state.lastProcessedDrawId != null ? Number(state.lastProcessedDrawId) : -Infinity;
  const newDraws = [];
  for (let i = 0; i < draws.length; i++) {
    const d = draws[i];
    const id = Number(d.drawId);
    if (Number.isFinite(id) && id > lastId) newDraws.push(d);
  }
  newDraws.sort((a, b) => Number(a.drawId) - Number(b.drawId));

  for (const draw of newDraws) {
    const isEnter = signal === 'ENTER';

    if (isEnter) {
      if (!state.wasLastDrawEnter) {
        state.enterRun.id += 1;
        state.enterRun.startDrawId = draw.drawId;
        state.enterRun.drawsIntoRun = 0;
      }
      state.enterRun.drawsIntoRun += 1;
    }

    processOneDraw(state, cfg, draw, signal, forecastColor, state.enterRun.id, state.enterRun.drawsIntoRun);
    state.wasLastDrawEnter = isEnter;
    state.lastProcessedDrawId = draw.drawId;
  }

  // Trading state machine. When trading stops, the current ladder,
  // attempt counter, window counter, capital and all statistics are
  // preserved -- nothing below this line mutates cycle/window/capital.
  if (state.ladderLimitReached) {
    state.tradingState = 'LADDER_LIMIT_REACHED';
  } else if (signal === 'ENTER') {
    state.tradingState = 'ACTIVE';
  } else {
    state.tradingState = 'PAUSED';
  }

  state.updatedAt = new Date().toISOString();
  return buildSummary(state);
}

// ---------------------------------------------------------------------------
// Per-draw trade processing
// ---------------------------------------------------------------------------

function processOneDraw(state, cfg, draw, signal, forecastColor, enterRunId, drawsIntoEnterRun) {
  // PAUSE: does not consume a trading draw, is not a MISS, does not
  // close a window, does not reset, does not advance the ladder. Only
  // lastProcessedDrawId moves.
  if (signal !== 'ENTER' || state.ladderLimitReached || !forecastColor) return;

  const ladder = Array.isArray(cfg.ladder) && cfg.ladder.length ? cfg.ladder : DEFAULT_LADDER;
  const cycle = state.cycle;
  const window = state.window;

  if (window.startDrawId == null) window.startDrawId = draw.drawId;
  if (window.startingCapital == null) window.startingCapital = state.capital.currentCapital;
  if (window.startingLadderStage == null) window.startingLadderStage = cycle.stage;

  const stakePerTrade = ladder[cycle.stage - 1];
  const totalStake = stakePerTrade; // single top-color-forecast market -- no 3x color cover

  // Market model: stake the leaderboard's top-ranked color only. Result
  // model: HIT if this draw's own threeBallColor matches the forecast
  // color that was live for this cycle.
  const actualColor = draw.threeBallColor || null;
  const isHit = actualColor != null && actualColor === forecastColor;
  const result = isHit ? 'HIT' : 'MISS';
  const grossReturn = result === 'HIT' ? stakePerTrade * cfg.payoutMultiplier : 0;
  const netPnL = grossReturn - totalStake;

  const capitalBefore = state.capital.currentCapital;
  state.capital.totalStaked += totalStake;
  state.capital.totalReturned += grossReturn;
  state.capital.realizedPnL += netPnL;
  state.capital.currentCapital += netPnL;
  const capitalAfter = state.capital.currentCapital;

  cycle.attempt += 1;
  cycle.totalStaked += totalStake;
  cycle.totalReturned += grossReturn;
  cycle.netPnL += netPnL;
  if (result === 'HIT') cycle.stageHits += 1; else cycle.stageMisses += 1;

  // Same-stage consecutive-HIT tracking -- resets whenever the stage
  // changes (freshLadderCycle / the advance branch below always zero it).
  const consecutiveHits = (result === 'HIT' && cycle.lastResultAtStage === 'HIT')
    ? cycle.consecutiveHits + 1
    : (result === 'HIT' ? 1 : 0);
  cycle.consecutiveHits = consecutiveHits;
  cycle.lastResultAtStage = result;

  window.eligibleDraws += 1;
  window.totalStaked += totalStake;
  window.totalReturned += grossReturn;
  window.netPnL += netPnL;
  window.endDrawId = draw.drawId;
  if (result === 'HIT') window.hits += 1; else window.misses += 1;

  // Reset trigger -- SAME-STAGE 2 CONSECUTIVE HITS ONLY (see header).
  const resetTriggered = consecutiveHits >= cfg.sameStageConsecutiveHitResetThreshold;
  const resetReason = resetTriggered ? 'SAME_STAGE_2_CONSECUTIVE_HITS' : null;

  const trade = {
    tradeId: `${draw.drawId}-${cycle.cycleId}`,
    timestamp: new Date().toISOString(),
    drawId: draw.drawId,
    signal: 'ENTER',
    windowId: window.windowId,
    windowDrawNumber: window.eligibleDraws,
    cycleId: cycle.cycleId,
    enterRunId,
    drawsIntoEnterRun,
    ladderStage: cycle.stage,
    stakePerTrade,
    totalStake,
    market: 'NEXT_EVENT_TOP_COLOR',
    forecastColor,
    outcome: actualColor,
    result,
    grossReturn,
    netPnL,
    stageAttempt: cycle.attempt,
    stageHits: cycle.stageHits,
    stageMisses: cycle.stageMisses,
    consecutiveHits,
    windowHits: window.hits,
    windowMisses: window.misses,
    capitalBefore,
    capitalAfter,
    resetTriggered,
    resetReason
  };
  state.trades.unshift(trade);
  if (state.trades.length > MAX_TRADE_LOG_ENTRIES) state.trades.length = MAX_TRADE_LOG_ENTRIES;

  if (resetTriggered) {
    performReset(state, cfg, resetReason, draw.drawId);
  } else if (cycle.attempt >= cfg.attemptsPerStage) {
    advanceLadderStage(state, ladder);
  }

  maybeCloseWindow(state, cfg);
}

// ---------------------------------------------------------------------------
// Reset procedure -- capital is never reset, only the ladder position; the
// window keeps counting independently toward its own boundary (same
// independence rule as tiePaperTraderEngine.js).
// ---------------------------------------------------------------------------

function performReset(state, cfg, resetReason, drawId) {
  const cycle = state.cycle;
  const window = state.window;

  cycle.closedAt = new Date().toISOString();
  cycle.endingCapital = state.capital.currentCapital;
  cycle.resetTriggered = true;
  cycle.resetReason = resetReason;

  state.capital.lockedProfit += cycle.netPnL;

  window.resetTriggered = true;
  window.resetReason = window.resetReason
    ? `${window.resetReason}+${resetReason}`
    : resetReason;

  state.resets.unshift({
    resetAt: new Date().toISOString(),
    drawId,
    reason: resetReason,
    previousCycleId: cycle.cycleId,
    previousStage: cycle.stage,
    cyclePnL: cycle.netPnL,
    windowId: window.windowId,
    windowHits: window.hits,
    capitalAfter: state.capital.currentCapital
  });
  if (state.resets.length > MAX_RESET_LOG_ENTRIES) state.resets.length = MAX_RESET_LOG_ENTRIES;

  state.cycles.unshift(cycle);
  if (state.cycles.length > MAX_CYCLE_LOG_ENTRIES) state.cycles.length = MAX_CYCLE_LOG_ENTRIES;

  state.nextCycleId += 1;
  state.cycle = freshLadderCycle(state.nextCycleId, state.capital.currentCapital);
}

// ---------------------------------------------------------------------------
// Ladder advancement (2 attempts per stage -- identical to tiePaperTrader
// Engine.js).
// ---------------------------------------------------------------------------

function advanceLadderStage(state, ladder) {
  const cycle = state.cycle;
  if (cycle.stage >= ladder.length) {
    // LADDER_LIMIT_REACHED -- stop and flag for operator review rather
    // than inventing a stage beyond the configured table.
    state.ladderLimitReached = true;
    return;
  }
  cycle.stage += 1;
  cycle.attempt = 0;
  cycle.stageHits = 0;
  cycle.stageMisses = 0;
  cycle.consecutiveHits = 0;
  cycle.lastResultAtStage = null;
  cycle.maxStageReached = Math.max(cycle.maxStageReached, cycle.stage);
}

// ---------------------------------------------------------------------------
// Window boundary
// ---------------------------------------------------------------------------

function maybeCloseWindow(state, cfg) {
  const window = state.window;
  if (window.eligibleDraws < cfg.windowSize) return;

  window.closedAt = new Date().toISOString();
  window.endingCapital = state.capital.currentCapital;
  window.endingLadderStage = state.cycle.stage;

  state.windows.unshift(window);
  if (state.windows.length > MAX_WINDOW_LOG_ENTRIES) state.windows.length = MAX_WINDOW_LOG_ENTRIES;

  state.nextWindowId += 1;
  state.window = freshDrawWindow(state.nextWindowId);
}

// ---------------------------------------------------------------------------
// Performance / analytics rollups -- derived read-only from the stored
// logs, same convention as tiePaperTraderEngine.js's buildPerformance().
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildPerformance(state) {
  const trades = state.trades;
  const totalTrades = trades.length;
  let totalHits = 0, totalStake = 0, totalReturn = 0;
  let maxLadderStageReached = state.cycle.maxStageReached;
  let maxDrawdown = 0;
  let peakCapital = state.capital.startingCapital;
  const stageStats = {}; // stage -> { hits, misses, pnl, count, resets }

  const chronological = trades.slice().reverse();
  for (const t of chronological) {
    if (t.result === 'HIT') totalHits++;
    totalStake += t.totalStake;
    totalReturn += t.grossReturn;
    if (t.capitalAfter > peakCapital) peakCapital = t.capitalAfter;
    const drawdown = peakCapital - t.capitalAfter;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (t.ladderStage > maxLadderStageReached) maxLadderStageReached = t.ladderStage;

    if (!stageStats[t.ladderStage]) {
      stageStats[t.ladderStage] = { stage: t.ladderStage, hits: 0, misses: 0, pnl: 0, count: 0, resets: 0 };
    }
    const ss = stageStats[t.ladderStage];
    ss.count += 1;
    ss.pnl += t.netPnL;
    if (t.result === 'HIT') ss.hits += 1; else ss.misses += 1;
    if (t.resetTriggered) ss.resets += 1;
  }

  const closedCycles = state.cycles;
  const avgLadderStage = closedCycles.length
    ? round2(closedCycles.reduce((sum, c) => sum + c.maxStageReached, 0) / closedCycles.length)
    : (totalTrades ? round2(trades.reduce((s, t) => s + t.ladderStage, 0) / totalTrades) : null);

  const closedWindows = state.windows;
  const windowsWith3PlusHits = closedWindows.filter(w => w.hits >= 3).length;

  // Only one reset trigger exists in this engine (see header): 2
  // consecutive HITs at the same ladder stage. `resets` here is always
  // that single reason, but the field names below are kept for shape
  // continuity with tiePaperTraderEngine.js's payload -- windowResets/
  // combinedResets stay 0 since that trigger doesn't exist here.
  const resets = state.resets;
  const consecutiveHitResets = resets.filter(r => r.reason === 'SAME_STAGE_2_CONSECUTIVE_HITS').length;
  const windowResets = 0;
  const combinedResets = 0;

  return {
    overall: {
      totalTrades,
      totalHits,
      totalMisses: totalTrades - totalHits,
      hitRate: totalTrades ? round2((totalHits / totalTrades) * 100) : null,
      totalStake: round2(totalStake),
      totalReturn: round2(totalReturn),
      netPnL: round2(totalReturn - totalStake),
      roi: totalStake ? round2(((totalReturn - totalStake) / totalStake) * 100) : null
    },
    ladder: {
      byStage: Object.values(stageStats)
        .sort((a, b) => a.stage - b.stage)
        .map(s => ({
          stage: s.stage,
          trades: s.count,
          hits: s.hits,
          misses: s.misses,
          hitRate: s.count ? round2((s.hits / s.count) * 100) : null,
          pnl: round2(s.pnl),
          resetsFromStage: s.resets
        })),
      maxLadderStageReached,
      averageLadderStage: avgLadderStage
    },
    windows: {
      totalWindows: closedWindows.length,
      averageHitsPerWindow: closedWindows.length
        ? round2(closedWindows.reduce((s, w) => s + w.hits, 0) / closedWindows.length)
        : null,
      windowsWith3PlusHits: windowsWith3PlusHits,
      windowsUnder3Hits: closedWindows.length - windowsWith3PlusHits,
      totalWindowPnL: round2(closedWindows.reduce((s, w) => s + w.netPnL, 0))
    },
    resets: {
      totalResets: resets.length,
      windowResets,
      consecutiveHitResets,
      combinedResets,
      averageCycleProfitBeforeReset: resets.length
        ? round2(resets.reduce((s, r) => s + r.cyclePnL, 0) / resets.length)
        : null
    },
    risk: {
      maxDrawdown: round2(maxDrawdown),
      maxLadderStageReached,
      ladderLimitReached: state.ladderLimitReached
    }
  };
}

function buildSummary(state) {
  const performance = buildPerformance(state);
  const cfg = state.config;
  return {
    engine: 'ThreeSilPaperTrader',
    tradingState: state.tradingState,
    signal: state.signal,
    ladderLimitReached: state.ladderLimitReached,
    config: cfg,
    cycle: state.cycle,
    window: state.window,
    capital: state.capital,
    currentTrade: state.trades[0] || null,
    lastReset: state.resets[0] || null,
    performance,
    trades: state.trades.slice(0, 100),
    windows: state.windows.slice(0, 50),
    cycles: state.cycles.slice(0, 50),
    resets: state.resets.slice(0, 50),
    updatedAt: state.updatedAt
  };
}

module.exports = {
  DEFAULT_LADDER,
  ATTEMPTS_PER_LADDER_STAGE,
  WINDOW_SIZE_MIN,
  WINDOW_SIZE_MAX,
  DEFAULT_WINDOW_SIZE,
  SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD,
  DEFAULT_PAYOUT_MULTIPLIER,
  DEFAULT_STARTING_CAPITAL,
  defaultConfig,
  freshThreeSilPaperTraderState,
  ensureStateShape,
  deriveSignal,
  advanceThreeSilPaperTrader,
  buildSummary
};
