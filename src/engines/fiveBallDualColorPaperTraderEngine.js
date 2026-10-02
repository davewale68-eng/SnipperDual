/**
 * 5-BALL DUAL-COLOR PAPER TRADER ENGINE — v1.0
 * (mirrors MEDIUM_GATE_PRO's 4SIL Paper Trader Engine / tiePaperTraderEngine.js,
 *  ported onto fiveBallDualColorNextEventEngine.js's (Phase 8) session
 *  lifecycle instead of 4SIL's continuous ENTER signal)
 *
 * PURPOSE
 * -------
 * A virtual/paper trading engine that consumes Phase 8's frozen dual-color
 * predictions (repeatColor + transitionColor, one 25-draw session at a
 * time) and measures how a fixed TWO-PHASE, TEN-RUNG stake ladder would
 * have performed staking both colors every draw a session is live,
 * against real draw outcomes.
 *
 *   LIVE DRAW DATA -> fiveBallHarvester -> fiveBallResearchLab
 *     -> fiveBallDualColorNextEventEngine (session ARMED/ACTIVE/HIT/MISS)
 *     -> 5-BALL DUAL-COLOR PAPER TRADER -> VIRTUAL TRADE -> RESULT EVALUATOR
 *     -> LADDER + SESSION + CAPITAL ACCOUNTING
 *
 * No real-money betting is performed anywhere in this module. It never
 * writes to any real order/betting surface and it never feeds a signal,
 * weight, or gate back into fiveBallDualColorNextEventEngine.js or any
 * other engine (ABSOLUTE SEPARATION RULE) -- this is a read-only
 * evaluation consumer, following the exact same one-way boundary
 * MEDIUM_GATE_PRO's paperTraderEngine.js enforces against 4SIL. It reads
 * fiveBallHarvest.eventLog directly (same source Phase 8 itself reads)
 * only to independently confirm, draw-by-draw, whether a session's two
 * predicted colors landed -- it never reads or mutates Phase 8's own
 * activeSession/sessionLog state.
 *
 * MARKET MODEL -- the deliberate departure from MEDIUM_GATE_PRO/Tie
 * ---------------------------------------------------------------------
 * MEDIUM_GATE_PRO's 4SIL trader stakes THREE colors (the whole color
 * space); tiePaperTraderEngine.js stakes ONE market (TIE or not). Phase 8
 * predicts exactly TWO colors per session (repeatColor + transitionColor)
 * -- so this engine stakes both, simultaneously, at the SAME per-draw
 * stake, every draw the session is live. That is a genuine partial cover
 * (the third, unpicked color can still win), which is why the payout
 * requested here (85-odds) is far higher than 4SIL's 12x (full 3-color
 * cover) or Tie's 4x (near-even single market).
 *
 * SESSION-SHAPED LADDER -- the second deliberate departure
 * ----------------------------------------------------------
 * Every other paper trader in this codebase advances its ladder stage
 * after a fixed COUNT of attempts (3 for 4SIL, 2 for Tie/3SIL/3-Ball
 * Color). Phase 8 has no such per-draw attempt count -- it has exactly
 * ONE 25-draw session per prediction. So here the "attempt" IS the
 * session, and each ladder rung is itself a two-phase stake schedule
 * inside that one session, not a flat repeated amount:
 *   - draws 1-15 of the session : PHASE 1 stake, per color
 *   - draws 16-25 of the session: PHASE 2 stake, per color (PHASE 1 + ₦50)
 * A session that produces a HIT on either predicted color, at any draw in
 * either phase, closes the session as HIT immediately (both colors stop
 * being staked from that draw on -- matches Phase 8's own session-closes-
 * on-first-hit rule) and resets the ladder straight back to Rung 1. A
 * session that reaches draw 25 with no hit closes as MISS and the ladder
 * advances exactly one rung for the NEXT session Phase 8 arms.
 *
 * RUNG TABLE -- 10 rungs, no repeats
 * -------------------------------------------------------------------
 *   Rung  Phase-1 (draws 1-15)   Phase-2 (draws 16-25)
 *    1      ₦50 / color             ₦100 / color
 *    2      ₦150 / color            ₦200 / color
 *    3      ₦250 / color            ₦300 / color
 *    4      ₦350 / color            ₦400 / color
 *    5      ₦450 / color            ₦500 / color
 *    6      ₦550 / color            ₦600 / color
 *    7      ₦650 / color            ₦700 / color
 *    8      ₦750 / color            ₦800 / color
 *    9      ₦850 / color            ₦900 / color
 *   10      ₦950 / color            ₦1,000 / color  (LAST MILE)
 * Phase-1 stake at rung N = ₦50 + (N-1)*₦100; Phase-2 = Phase-1 + ₦50.
 * Requested explicitly: "we don't repeat ladders" -- the ladder only ever
 * moves forward, one rung per MISS session, and jumps straight back to
 * Rung 1 on a HIT. It never cycles back through a rung it already used on
 * its way up (contrast MEDIUM_GATE_PRO, whose 12-stage ladder can be
 * revisited across many reset cycles over the engine's lifetime --
 * that's still true numerically here too, since a reset always restarts
 * at Rung 1, but within any single climb the rungs are strictly
 * increasing and never repeated or skipped). If Rung 10 (LAST MILE)
 * closes as MISS, trading stops (LADDER_LIMIT_REACHED) and waits for
 * operator review, exactly like MEDIUM_GATE_PRO's ladder-limit behavior
 * -- it does NOT wrap back to Rung 1 on its own.
 *
 * PAYOUT -- 85-odds, mirroring the flat "stake x multiplier on the
 * winning color, other stake lost" mechanic every paper trader in this
 * codebase uses. Only the color that actually lands pays; the other
 * color's stake for that draw is lost, same accounting shape as 4SIL's
 * per-color stake/return bookkeeping.
 *
 * DEBOUNCING / IDEMPOTENCY
 * -------------------------
 * A trade happens only for a NEW elapsed draw within the currently
 * tracked session (elapsedDraws strictly greater than
 * tradeSession.lastProcessedElapsed) -- a repeat council cycle with no
 * new real draw never creates extra trades. A new trade session is only
 * opened when Phase 8's activeSession.sessionId differs from
 * lastProcessedSessionId, so the same session is never re-armed twice.
 *
 * This engine is OBSERVATIONAL/EVALUATIVE ONLY: it must be called AFTER
 * fiveBallDualColorNextEventEngine.js each council cycle and never
 * before, and its own state must never be read back into Phase 8,
 * fiveBallHarvester, fiveBallResearchLab, or any gate/weight.
 */
'use strict';

const { WINDOW_SIZE_DRAWS } = require('./fiveBallDualColorNextEventEngine');

const MAX_TRADE_LOG_ENTRIES = 3000;
const MAX_SESSION_LOG_ENTRIES = 500;
const MAX_CYCLE_LOG_ENTRIES = 500;
const MAX_RESET_LOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Default production configuration
// ---------------------------------------------------------------------------

const MAX_LADDER_STAGE = 10;
const PHASE1_DRAWS = 15;                 // draws 1-15 of a session
const PHASE2_DRAWS = WINDOW_SIZE_DRAWS - PHASE1_DRAWS; // draws 16-25
const RUNG1_PHASE1_STAKE = 50;
const RUNG_PHASE1_INCREMENT = 100;       // +₦100/color per rung, phase 1
const PHASE2_SURCHARGE = 50;             // phase 2 = phase 1 + ₦50/color

// REQUESTED: 85-odds payout, applied to the single predicted color that
// actually lands (the other predicted color's stake that draw is lost).
const DEFAULT_PAYOUT_MULTIPLIER = 85;

// Paper capital -- identical convention to every other trader here.
const DEFAULT_STARTING_CAPITAL = 100000;

function stakesForStage(stage) {
  const phase1 = RUNG1_PHASE1_STAKE + (stage - 1) * RUNG_PHASE1_INCREMENT;
  return { phase1, phase2: phase1 + PHASE2_SURCHARGE };
}

function defaultLadder() {
  const rows = [];
  for (let s = 1; s <= MAX_LADDER_STAGE; s++) rows.push(stakesForStage(s));
  return rows;
}

function defaultConfig() {
  return {
    maxLadderStage: MAX_LADDER_STAGE,
    phase1Draws: PHASE1_DRAWS,
    phase2Draws: PHASE2_DRAWS,
    ladder: defaultLadder(),          // [{phase1, phase2}, ...] index 0 = Rung 1
    payoutMultiplier: DEFAULT_PAYOUT_MULTIPLIER,
    startingCapital: DEFAULT_STARTING_CAPITAL
  };
}

// ---------------------------------------------------------------------------
// State factory (persisted at store.fiveBallDualColorPaperTrader)
// ---------------------------------------------------------------------------

function freshLadderCycle(cycleId, startingCapital, startingStage) {
  return {
    cycleId,
    startedAt: new Date().toISOString(),
    closedAt: null,
    startingCapital,
    endingCapital: null,
    startingStage,
    maxStageReached: startingStage,
    sessionsPlayed: 0,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    resetTriggered: false,
    resetReason: null
  };
}

function freshTradeSession(sessionId, triggerPosition, predictedColors, ladderStage, cfg) {
  const stakes = cfg.ladder[ladderStage - 1] || stakesForStage(ladderStage);
  return {
    sessionId,
    triggerPosition,
    predictedColors: predictedColors.slice(),
    ladderStage,
    phase1Stake: stakes.phase1,
    phase2Stake: stakes.phase2,
    startedAt: new Date().toISOString(),
    closedAt: null,
    lastProcessedElapsed: 0,
    tradesPlayed: 0,
    hits: 0,
    misses: 0,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    result: null,          // 'HIT' | 'MISS' | null while active
    hitColor: null,
    hitElapsedDraws: null,
    hitPhase: null
  };
}

function freshState(config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };
  return {
    schemaVersion: 1,
    config: cfg,

    // WAITING_FOR_SESSION | ACTIVE | LADDER_LIMIT_REACHED
    tradingState: 'WAITING_FOR_SESSION',
    ladderLimitReached: false,

    currentLadderStage: 1,
    lastProcessedSessionId: null,

    nextCycleId: 1,
    nextSessionLogId: 1,

    tradeSession: null,            // currently tracked live session, or null
    cycle: freshLadderCycle(1, cfg.startingCapital, 1),

    capital: {
      startingCapital: cfg.startingCapital,
      currentCapital: cfg.startingCapital,
      realizedPnL: 0,
      lockedProfit: 0,
      totalStaked: 0,
      totalReturned: 0
    },

    trades: [],       // newest-first, individual per-draw stakes
    sessions: [],      // closed trade sessions, newest-first
    cycles: [],        // closed ladder cycles, newest-first
    resets: [],         // reset events, newest-first

    updatedAt: null
  };
}

// Mutates persistentState IN PLACE and returns the same reference -- same
// convention as every other paper trader's ensureStateShape() here.
function ensureStateShape(persistentState) {
  const fresh = freshState();
  const s = persistentState && typeof persistentState === 'object' ? persistentState : fresh;
  if (s.schemaVersion == null) s.schemaVersion = 1;
  s.config = { ...fresh.config, ...(s.config || {}) };
  if (!Array.isArray(s.config.ladder) || s.config.ladder.length !== s.config.maxLadderStage) {
    s.config.ladder = defaultLadder();
  }
  if (!s.tradingState) s.tradingState = fresh.tradingState;
  s.ladderLimitReached = Boolean(s.ladderLimitReached);
  if (!s.currentLadderStage) s.currentLadderStage = 1;
  if (typeof s.lastProcessedSessionId === 'undefined') s.lastProcessedSessionId = null;
  if (!s.nextCycleId) s.nextCycleId = fresh.nextCycleId;
  if (!s.nextSessionLogId) s.nextSessionLogId = fresh.nextSessionLogId;
  if (typeof s.tradeSession === 'undefined') s.tradeSession = null;
  if (!s.cycle || typeof s.cycle !== 'object') s.cycle = fresh.cycle;
  if (!s.capital || typeof s.capital !== 'object') s.capital = fresh.capital;
  if (!Array.isArray(s.trades)) s.trades = [];
  if (!Array.isArray(s.sessions)) s.sessions = [];
  if (!Array.isArray(s.cycles)) s.cycles = [];
  if (!Array.isArray(s.resets)) s.resets = [];
  if (typeof s.updatedAt === 'undefined') s.updatedAt = null;
  return s;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the 5-Ball Dual-Color Paper Trader for the current council
 * cycle. Must be called AFTER fiveBallDualColorNextEventEngine.js
 * (evaluateFiveBallDualColorNextEvent) each cycle -- see header for the
 * separation rule.
 *
 * @param {Object} fiveBallHarvest    this cycle's fiveBallHarvester.js result (needs eventLog, totalDrawsObserved)
 * @param {Object} dualColorResult    this cycle's evaluateFiveBallDualColorNextEvent() output
 * @param {Object} persistentState    store.fiveBallDualColorPaperTrader (mutated in place)
 * @returns {Object} read-only summary for snapshot / dashboard
 */
function advanceFiveBallDualColorPaperTrader(fiveBallHarvest, dualColorResult, persistentState) {
  const state = ensureStateShape(persistentState);
  const cfg = state.config;
  const harvest = fiveBallHarvest || {};
  const dual = dualColorResult || {};
  const eventLog = Array.isArray(harvest.eventLog) ? harvest.eventLog : [];
  const totalDrawsObserved = harvest.totalDrawsObserved || 0;

  if (!state.ladderLimitReached) {
    maybeOpenSession(state, cfg, dual);
    if (state.tradeSession) {
      advanceTradeSession(state, cfg, eventLog, totalDrawsObserved);
    }
  }

  state.tradingState = state.ladderLimitReached
    ? 'LADDER_LIMIT_REACHED'
    : (state.tradeSession ? 'ACTIVE' : 'WAITING_FOR_SESSION');

  state.updatedAt = new Date().toISOString();
  return buildSummary(state);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function maybeOpenSession(state, cfg, dual) {
  if (state.tradeSession) return; // one live session at a time, same as Phase 8 itself
  const src = dual.activeSession;
  if (!src) return;
  if (src.sessionId === state.lastProcessedSessionId) return; // already traded this session

  state.tradeSession = freshTradeSession(
    src.sessionId,
    src.triggerPosition,
    src.predictedColors && src.predictedColors.length === 2 ? src.predictedColors : [src.repeatColor, src.transitionColor],
    state.currentLadderStage,
    cfg
  );
  state.lastProcessedSessionId = src.sessionId;
}

function advanceTradeSession(state, cfg, eventLog, totalDrawsObserved) {
  const session = state.tradeSession;
  const windowSize = cfg.phase1Draws + cfg.phase2Draws;

  const currentElapsed = Math.max(0, Math.min(totalDrawsObserved - session.triggerPosition, windowSize));

  for (let elapsed = session.lastProcessedElapsed + 1; elapsed <= currentElapsed; elapsed++) {
    const drawPosition = session.triggerPosition + elapsed;
    const hitEvent = eventLog.find(e => e.position === drawPosition && session.predictedColors.indexOf(e.eventColor) !== -1);
    playTrade(state, cfg, session, elapsed, drawPosition, hitEvent ? hitEvent.eventColor : null);
    session.lastProcessedElapsed = elapsed;
    if (session.result) break; // HIT closes the session immediately, per Phase 8's own rule
  }

  if (!session.result && currentElapsed >= windowSize) {
    closeSession(state, cfg, 'MISS');
  }
}

function playTrade(state, cfg, session, elapsedDraws, drawPosition, hitColor) {
  const phase = elapsedDraws <= cfg.phase1Draws ? 1 : 2;
  const stakePerColor = phase === 1 ? session.phase1Stake : session.phase2Stake;
  const totalStake = stakePerColor * 2; // both predicted colors staked simultaneously
  const result = hitColor ? 'HIT' : 'MISS';
  const grossReturn = result === 'HIT' ? stakePerColor * cfg.payoutMultiplier : 0;
  const netPnL = grossReturn - totalStake;

  const capitalBefore = state.capital.currentCapital;
  state.capital.totalStaked += totalStake;
  state.capital.totalReturned += grossReturn;
  state.capital.realizedPnL += netPnL;
  state.capital.currentCapital += netPnL;
  const capitalAfter = state.capital.currentCapital;

  session.tradesPlayed += 1;
  session.totalStaked += totalStake;
  session.totalReturned += grossReturn;
  session.netPnL += netPnL;
  if (result === 'HIT') session.hits += 1; else session.misses += 1;

  const cycle = state.cycle;
  cycle.totalStaked += totalStake;
  cycle.totalReturned += grossReturn;
  cycle.netPnL += netPnL;

  const trade = {
    tradeId: `${session.sessionId}-${elapsedDraws}`,
    timestamp: new Date().toISOString(),
    sessionId: session.sessionId,
    drawPosition,
    elapsedDraws,
    phase,
    ladderStage: session.ladderStage,
    stakePerColor,
    totalStake,
    predictedColors: session.predictedColors,
    hitColor,
    result,
    grossReturn,
    netPnL,
    capitalBefore,
    capitalAfter
  };
  state.trades.unshift(trade);
  if (state.trades.length > MAX_TRADE_LOG_ENTRIES) state.trades.length = MAX_TRADE_LOG_ENTRIES;

  if (result === 'HIT') {
    session.result = 'HIT';
    session.hitColor = hitColor;
    session.hitElapsedDraws = elapsedDraws;
    session.hitPhase = phase;
    closeSession(state, cfg, 'HIT');
  }
}

function closeSession(state, cfg, outcome) {
  const session = state.tradeSession;
  if (!session) return;
  session.result = outcome;
  session.closedAt = new Date().toISOString();

  state.sessions.unshift({ ...session, logId: state.nextSessionLogId });
  if (state.sessions.length > MAX_SESSION_LOG_ENTRIES) state.sessions.length = MAX_SESSION_LOG_ENTRIES;
  state.nextSessionLogId += 1;

  state.cycle.sessionsPlayed += 1;
  state.cycle.maxStageReached = Math.max(state.cycle.maxStageReached, session.ladderStage);

  if (outcome === 'HIT') {
    performReset(state, cfg, 'SESSION_HIT', session);
  } else {
    advanceLadderStage(state, cfg);
  }

  state.tradeSession = null;
}

// ---------------------------------------------------------------------------
// Ladder advancement -- one rung per MISS session, never repeated on the
// way up (spec: "we don't repeat ladders").
// ---------------------------------------------------------------------------

function advanceLadderStage(state, cfg) {
  if (state.currentLadderStage >= cfg.maxLadderStage) {
    // LAST MILE (Rung 10) closed as MISS -- stop and flag for operator
    // review rather than wrapping back to Rung 1 on its own.
    state.ladderLimitReached = true;
    return;
  }
  state.currentLadderStage += 1;
}

// ---------------------------------------------------------------------------
// Reset procedure -- fires on ANY hit, at any draw, in either phase, of
// the active session. Capital is never reset, only the ladder position;
// the closed ladder cycle is logged and a fresh one opened at Rung 1.
// ---------------------------------------------------------------------------

function performReset(state, cfg, resetReason, session) {
  const cycle = state.cycle;
  cycle.closedAt = new Date().toISOString();
  cycle.endingCapital = state.capital.currentCapital;
  cycle.resetTriggered = true;
  cycle.resetReason = resetReason;
  state.capital.lockedProfit += cycle.netPnL;

  state.resets.unshift({
    resetAt: new Date().toISOString(),
    sessionId: session.sessionId,
    reason: resetReason,
    hitColor: session.hitColor,
    hitElapsedDraws: session.hitElapsedDraws,
    hitPhase: session.hitPhase,
    previousCycleId: cycle.cycleId,
    previousStage: session.ladderStage,
    cyclePnL: cycle.netPnL,
    capitalAfter: state.capital.currentCapital
  });
  if (state.resets.length > MAX_RESET_LOG_ENTRIES) state.resets.length = MAX_RESET_LOG_ENTRIES;

  state.cycles.unshift(cycle);
  if (state.cycles.length > MAX_CYCLE_LOG_ENTRIES) state.cycles.length = MAX_CYCLE_LOG_ENTRIES;

  state.currentLadderStage = 1;
  state.ladderLimitReached = false;
  state.nextCycleId += 1;
  state.cycle = freshLadderCycle(state.nextCycleId, state.capital.currentCapital, 1);
}

// ---------------------------------------------------------------------------
// Performance / analytics rollups
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildPerformance(state) {
  const trades = state.trades;
  const totalTrades = trades.length;
  let totalHits = 0, totalStake = 0, totalReturn = 0;
  let maxDrawdown = 0;
  let peakCapital = state.capital.startingCapital;
  const stageStats = {}; // stage -> { hits, misses, pnl, count }

  const chronological = trades.slice().reverse();
  for (const t of chronological) {
    if (t.result === 'HIT') totalHits++;
    totalStake += t.totalStake;
    totalReturn += t.grossReturn;
    if (t.capitalAfter > peakCapital) peakCapital = t.capitalAfter;
    const drawdown = peakCapital - t.capitalAfter;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (!stageStats[t.ladderStage]) {
      stageStats[t.ladderStage] = { stage: t.ladderStage, hits: 0, misses: 0, pnl: 0, count: 0 };
    }
    const ss = stageStats[t.ladderStage];
    ss.count += 1;
    ss.pnl += t.netPnL;
    if (t.result === 'HIT') ss.hits += 1; else ss.misses += 1;
  }

  const sessions = state.sessions;
  const sessionHits = sessions.filter(s => s.result === 'HIT').length;
  const sessionMisses = sessions.filter(s => s.result === 'MISS').length;
  const hitElapsed = sessions.filter(s => s.result === 'HIT' && Number.isFinite(s.hitElapsedDraws)).map(s => s.hitElapsedDraws);
  const avgHitDraw = hitElapsed.length ? round2(hitElapsed.reduce((a, b) => a + b, 0) / hitElapsed.length) : null;

  const closedCycles = state.cycles;
  const maxLadderStageReached = Math.max(state.cycle.maxStageReached, ...closedCycles.map(c => c.maxStageReached), state.currentLadderStage);

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
    sessions: {
      totalSessions: sessions.length,
      sessionHits,
      sessionMisses,
      sessionHitRate: sessions.length ? round2((sessionHits / sessions.length) * 100) : null,
      avgHitDraw
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
          pnl: round2(s.pnl)
        })),
      maxLadderStageReached
    },
    resets: {
      totalResets: state.resets.length,
      averageCycleProfitBeforeReset: state.resets.length
        ? round2(state.resets.reduce((s, r) => s + r.cyclePnL, 0) / state.resets.length)
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
  return {
    engine: '5-Ball Dual-Color Paper Trader',
    tradingState: state.tradingState,
    ladderLimitReached: state.ladderLimitReached,
    currentLadderStage: state.currentLadderStage,
    config: state.config,
    tradeSession: state.tradeSession,
    cycle: state.cycle,
    capital: state.capital,
    currentTrade: state.trades[0] || null,
    lastReset: state.resets[0] || null,
    performance,
    trades: state.trades.slice(0, 100),
    sessions: state.sessions.slice(0, 50),
    cycles: state.cycles.slice(0, 50),
    resets: state.resets.slice(0, 50),
    updatedAt: state.updatedAt
  };
}

module.exports = {
  MAX_LADDER_STAGE,
  PHASE1_DRAWS,
  PHASE2_DRAWS,
  DEFAULT_PAYOUT_MULTIPLIER,
  DEFAULT_STARTING_CAPITAL,
  stakesForStage,
  defaultLadder,
  defaultConfig,
  freshState,
  ensureStateShape,
  advanceFiveBallDualColorPaperTrader,
  buildSummary
};
