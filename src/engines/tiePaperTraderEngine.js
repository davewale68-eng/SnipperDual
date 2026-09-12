/**
 * TIE PAPER TRADER ENGINE — v1.0
 * (mirrors MEDIUM_GATE_PRO's 4SIL Paper Trader Engine, ported onto the
 *  Tie Next Event / Entry Timing Engine's ENTER signal instead of 4SIL's)
 *
 * PURPOSE
 * -------
 * A virtual/paper trading engine that consumes tieNextEventEngine.js's
 * Trade Penetration lifecycle (ENTER/HOLD/TAKE PROFIT/WINDOW CLOSED) and
 * measures how a fixed stake ladder would have performed staking the TIE
 * outcome every draw a call is live, against real draw outcomes.
 *
 *   LIVE DRAW DATA -> tieEngine -> tieNextEventEngine (Trade Penetration)
 *     -> TIE PAPER TRADER -> VIRTUAL TRADE -> RESULT EVALUATOR
 *     -> LADDER + WINDOW + CAPITAL ACCOUNTING
 *
 * No real-money betting is performed anywhere in this module. It never
 * writes to any real order/betting surface and it never feeds a signal,
 * weight, or gate back into tieEngine, tieNextEventEngine, or any other
 * engine (ABSOLUTE SEPARATION RULE) -- this is a read-only evaluation
 * consumer, following the exact same one-way boundary MEDIUM_GATE_PRO's
 * paperTraderEngine.js enforces against 4SIL.
 *
 * SIGNAL MAPPING (this engine's one deliberate departure from a literal
 * port -- everything else below mirrors MEDIUM_GATE_PRO structurally)
 * ---------------------------------------------------------------------
 * A trade is staked ONLY on the exact draw where
 * tieNextEventEngine.js's Trade Penetration displayState is the literal
 * 'ENTER' verb (the draw a call opens) -- never on HOLD, TAKE PROFIT, or
 * WINDOW CLOSED. Those three all mean a call is still open or just
 * closed, not that a fresh ENTER fired for the current draw, so staking
 * on them would place a new virtual bet on every draw of an already-open
 * call instead of one bet per call. So the signal collapses to two
 * states:
 *   displayState === 'ENTER'            -> 'ENTER' (place a trade)
 *   everything else (WAIT | AVOID |
 *     HOLD | TAKE PROFIT | WINDOW CLOSED
 *     | DORMANT/no penetration)         -> 'PAUSE'
 * Trading is permitted ONLY on 'ENTER', exactly like MEDIUM_GATE_PRO.
 *
 * MARKET MODEL -- the second deliberate departure
 * --------------------------------------------------
 * MEDIUM_GATE_PRO's 4SIL trader stakes THREE colors simultaneously every
 * ENTER draw (RED+BLUE+GREEN), since 4SIL's market has three possible
 * winners to cover. A tie has exactly one outcome to stake on -- TIE or
 * not -- so this engine stakes a single market per draw at the same
 * per-stage ladder amount, rather than 3x that amount across three
 * colors. Combined with the requested 4x payout (vs. 4SIL's 12x, which
 * exists specifically to price three simultaneous 1-in-~4 covers), this
 * keeps the same "flat stake per rung, fixed payout multiplier on a
 * HIT" mechanic MEDIUM_GATE_PRO uses, just resized to a one-outcome
 * market instead of a three-outcome cover.
 *
 * REQUESTED DELTAS FROM MEDIUM_GATE_PRO (everything else mirrors it
 * exactly: starting capital, window size, config/reset API shape)
 * ---------------------------------------------------------------------
 *   1. LADDER TABLE = 17 operator-specified stages (50, 75, 100, 150,
 *      200, 300, 400, 550, 700, 1000, 1500, 2000, 3000, 4000, 5500,
 *      7000, 13000) -- MEDIUM_GATE_PRO uses its own 12-stage table.
 *   2. DEFAULT_PAYOUT_MULTIPLIER = 4   (MEDIUM_GATE_PRO uses 12)
 *   3. ATTEMPTS_PER_LADDER_STAGE = 2   (MEDIUM_GATE_PRO uses 3)
 *   4. RESET RULE: only ONE trigger -- 2 consecutive HITs at the SAME
 *      ladder stage. MEDIUM_GATE_PRO also resets on "3 hits within a
 *      window," but that threshold was calibrated against a 12x payout;
 *      at this engine's 4x payout the same 3-hits-in-a-window trigger
 *      would fire far too readily relative to how much capital each hit
 *      actually returns, forcing resets long before the ladder can do
 *      useful work. So that trigger is removed entirely here -- the
 *      window still closes on its own boundary (windowSize draws) for
 *      reporting purposes, it just no longer forces a ladder reset on
 *      its own.
 *
 * DEBOUNCING / IDEMPOTENCY
 * -------------------------
 * Same as MEDIUM_GATE_PRO: a trade happens only when a NEW eligible draw
 * (drawId strictly greater than lastProcessedDrawId) arrives while the
 * signal is ENTER; lastProcessedDrawId is the dedup key.
 *
 * This engine is OBSERVATIONAL/EVALUATIVE ONLY: it must be called AFTER
 * tieNextEventEngine.js each council cycle and never before, and its own
 * state must never be read back into tieEngine, tieNextEventEngine, or
 * any gate/weight.
 */
'use strict';

const { detectTie } = require('./tieEngine');

const MAX_TRADE_LOG_ENTRIES = 3000;
const MAX_WINDOW_LOG_ENTRIES = 500;
const MAX_CYCLE_LOG_ENTRIES = 500;
const MAX_RESET_LOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Default production configuration -- identical ladder/capital/window/reset
// values to MEDIUM_GATE_PRO's paperTraderEngine.js, per the request to
// mirror those exactly.
// ---------------------------------------------------------------------------

// Ladder table -- REQUESTED: 17 stages, operator-specified stake amounts
// (not a literal port of MEDIUM_GATE_PRO's 12-stage table). Index 0 =
// Stage 1 (₦50) ... index 16 = Stage 17 (₦13,000). Configurable via
// config.ladder.
const DEFAULT_LADDER = [50, 75, 100, 150, 200, 300, 400, 550, 700, 1000, 1500, 2000, 3000, 4000, 5500, 7000, 13000];

// REQUESTED DELTA: each ladder stage is repeated 2x here, not 3x like
// MEDIUM_GATE_PRO -- e.g. Stage 1 @ ₦50 gets 2 consecutive eligible
// trades before the engine advances to Stage 2 @ ₦100.
const ATTEMPTS_PER_LADDER_STAGE = 2;

// Draw window clock -- identical to MEDIUM_GATE_PRO. The window boundary
// used to CLOSE a window and open the next one.
const WINDOW_SIZE_MIN = 10;
const WINDOW_SIZE_MAX = 11;
const DEFAULT_WINDOW_SIZE = WINDOW_SIZE_MIN;

// Reset trigger -- REQUESTED DELTA: MEDIUM_GATE_PRO's "3 hits within a
// window" trigger is removed here (see header, section 3). The window
// still closes on its own boundary for reporting, it just never forces a
// reset by itself. 2 consecutive HITs at the SAME ladder stage triggers
// an immediate ladder reset, regardless of stake size.
const SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD = 2;

// REQUESTED DELTA: payout is 4-odds here (single TIE market), not
// MEDIUM_GATE_PRO's 12-odds (three simultaneous color covers).
const DEFAULT_PAYOUT_MULTIPLIER = 4;

// Paper capital -- identical to MEDIUM_GATE_PRO.
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
// State factory (persisted at store.tiePaperTrader) -- same shape as
// MEDIUM_GATE_PRO's paperTraderEngine.js, minus the `colors` cover (single
// TIE market instead of three simultaneous colors).
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

function freshTiePaperTraderState(config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };
  return {
    schemaVersion: 1,
    config: cfg,

    // WAITING_FOR_ENTER | ACTIVE | PAUSED | LADDER_LIMIT_REACHED
    tradingState: 'WAITING_FOR_ENTER',
    signal: null,            // last derived signal: ENTER | PAUSE
    ladderLimitReached: false,

    lastProcessedDrawId: null,

    // ENTER-run tracking, same convention as MEDIUM_GATE_PRO -- a "run"
    // is one unbroken stretch of ENTER draws, independent of ladder
    // cycleId (which can reset mid-run without a genuine break in the
    // underlying ENTER signal).
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
// same convention as MEDIUM_GATE_PRO's ensureStateShape(): council.js
// passes store.tiePaperTrader directly and never reassigns it, so a copy
// here would silently detach the live state from the store.
function ensureStateShape(persistentState) {
  const fresh = freshTiePaperTraderState();
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

const ENTER_DISPLAY_STATE = 'ENTER';

function deriveSignal(tieNextEvent) {
  const tne = tieNextEvent || {};
  if (tne.engineState === 'DORMANT' || !tne.penetration) return 'PAUSE';
  const displayState = tne.penetration.displayState || tne.penetration.status;
  return displayState === ENTER_DISPLAY_STATE ? 'ENTER' : 'PAUSE';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the tie paper trader for the current council cycle.
 * Must be called AFTER tieNextEventEngine.js (evaluateTieNextEvent) each
 * cycle -- see header for the separation rule.
 *
 * @param {Array} historicalDraws newest-first draw history (store.getRecentDraws)
 * @param {Object} tieNextEvent   this cycle's tieNextEventEngine.js result
 * @param {Object} persistentState store.tiePaperTrader (mutated in place)
 * @returns {Object} read-only summary for snapshot / dashboard
 */
function advanceTiePaperTrader(historicalDraws, tieNextEvent, persistentState) {
  const state = ensureStateShape(persistentState);
  const cfg = state.config;
  const draws = Array.isArray(historicalDraws) ? historicalDraws : [];
  const signal = deriveSignal(tieNextEvent);
  state.signal = signal;

  // Collect draws newer than lastProcessedDrawId, oldest-first, so ladder
  // and window state advances in real chronological order -- same
  // debouncing/idempotency convention as MEDIUM_GATE_PRO.
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

    processOneDraw(state, cfg, draw, signal, state.enterRun.id, state.enterRun.drawsIntoRun);
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

function processOneDraw(state, cfg, draw, signal, enterRunId, drawsIntoEnterRun) {
  // PAUSE: does not consume a trading draw, is not a MISS, does not
  // close a window, does not reset, does not advance the ladder. Only
  // lastProcessedDrawId moves.
  if (signal !== 'ENTER' || state.ladderLimitReached) return;

  const ladder = Array.isArray(cfg.ladder) && cfg.ladder.length ? cfg.ladder : DEFAULT_LADDER;
  const cycle = state.cycle;
  const window = state.window;

  if (window.startDrawId == null) window.startDrawId = draw.drawId;
  if (window.startingCapital == null) window.startingCapital = state.capital.currentCapital;
  if (window.startingLadderStage == null) window.startingLadderStage = cycle.stage;

  const stakePerTrade = ladder[cycle.stage - 1];
  const totalStake = stakePerTrade; // single TIE market -- no 3x color cover

  // Market model: stake the TIE outcome only. Result model: HIT if this
  // draw is itself a 3-ball tie (detectTie), same tie definition
  // tieEngine.js uses everywhere else in this codebase.
  const isTie = detectTie(draw);
  const result = isTie ? 'HIT' : 'MISS';
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

  // Reset trigger -- SAME-STAGE 2 CONSECUTIVE HITS ONLY (see header,
  // section 3, for why MEDIUM_GATE_PRO's window-hit trigger is not
  // ported here).
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
    market: 'TIE',
    outcome: isTie ? 'TIE' : null,
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
// independence rule as MEDIUM_GATE_PRO).
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
// Ladder advancement (2 attempts per stage -- REQUESTED DELTA, see header).
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
// logs, same convention as MEDIUM_GATE_PRO's buildPerformance().
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

  // Only one reset trigger exists in this engine (see header, section 3):
  // 2 consecutive HITs at the same ladder stage. `resets` here is always
  // that single reason, but the field names below are kept for shape
  // continuity with MEDIUM_GATE_PRO's payload -- windowResets/
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
    engine: 'TiePaperTrader',
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
  freshTiePaperTraderState,
  ensureStateShape,
  deriveSignal,
  advanceTiePaperTrader,
  buildSummary
};
