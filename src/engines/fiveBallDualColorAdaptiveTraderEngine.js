/**
 * 5-BALL DUAL-COLOR ADAPTIVE PAPER TRADER ENGINE — v1.0
 * (sibling of fiveBallDualColorPaperTraderEngine.js -- same session
 *  source, same read-only separation rule, DIFFERENT stake-sizing
 *  philosophy)
 *
 * WHY THIS EXISTS
 * -----------------
 * fiveBallDualColorPaperTraderEngine.js implements the originally
 * requested 10-rung martingale-style ladder (stake grows every MISS
 * session, resets to Rung 1 on a HIT). That ladder's SHAPE never changes
 * the odds of a HIT -- only the real per-draw hit-probability and the
 * 85x payout determine whether a session is +EV. Escalating the stake
 * after losses doesn't recover a bad edge, it just multiplies exposure
 * to it (₦260,000 worst-case to reach Rung 10, per that engine's own
 * backtest). This engine keeps everything else identical (same Phase 8
 * session source, same 25-draw window, same 85x payout, same instant-
 * reset-on-hit, same read-only separation rule) but replaces the
 * escalating rung table with a stake size that reflects Phase 8's own
 * ALREADY-COMPUTED confidence, not loss history, plus a hard circuit
 * breaker instead of an ever-growing ladder.
 *
 * THREE SELECTABLE SIZING MODES (config.sizingMode)
 * ---------------------------------------------------
 *   'FLAT'          -- both predicted colors staked at the same fixed
 *                       amount every session, no escalation, ever. The
 *                       simplest way to capture a real edge with a flat,
 *                       predictable capital requirement.
 *   'TIER_WEIGHTED' -- each color's stake is the flat base amount scaled
 *                       by that color's OWN evidence tier from Phase 8's
 *                       session (repeatTier / transitionTier: EXPLORATORY
 *                       / EMERGING / ESTABLISHED / STRONG). An
 *                       EXPLORATORY side is skipped entirely (stake 0) --
 *                       splitting money onto a near-zero-evidence call
 *                       just dilutes the stronger side's edge for no
 *                       reason. See TIER_MULTIPLIERS below.
 *   'KELLY'         -- each color's stake is a FRACTIONAL Kelly stake
 *                       computed from that color's own confidencePct
 *                       (treated as the win-probability estimate),
 *                       DEFAULT_PAYOUT_MULTIPLIER, and current bankroll,
 *                       scaled down by config.kellyFraction (default
 *                       0.25 -- quarter-Kelly, standard practice for
 *                       taming variance against an estimated, not
 *                       certain, edge) and floored/ceilinged by
 *                       config.minStakePerColor / config.maxStakePerColor
 *                       so a confidence spike near 100% can't demand an
 *                       unreasonable fraction of the paper bankroll.
 *
 * CIRCUIT BREAKER INSTEAD OF A LADDER
 * --------------------------------------
 * There is no rung to climb here, so there is nothing to reset TO on a
 * HIT beyond zeroing the counter below. Consecutive session MISSes are
 * still tracked (missStreak); reaching config.missStreakCap (default 5,
 * i.e. 5 unbroken 25-draw sessions with no hit on either color) trips
 * PAUSED_STREAK_CAP -- trading stops and waits for operator review,
 * exactly like the ladder engine's LADDER_LIMIT_REACHED, but without
 * ever having grown the stake to get there. Any HIT zeroes missStreak
 * and clears the pause. This bounds worst-case capital at risk to
 * missStreakCap x (one session's stake), which at FLAT/TIER_WEIGHTED
 * sizing is a small, FIXED number -- not the ladder engine's ₦260,000
 * climb.
 *
 * EVERYTHING ELSE IS IDENTICAL TO fiveBallDualColorPaperTraderEngine.js:
 * reads fiveBallHarvest.eventLog directly to independently confirm hits
 * (never reads/mutates Phase 8's own state), stakes both predicted
 * colors simultaneously every draw a session is live, session closes
 * (and stops staking) the instant either predicted color lands, 85x
 * payout on the winning color only, must be called AFTER
 * fiveBallDualColorNextEventEngine.js each cycle, ABSOLUTE SEPARATION
 * RULE (never feeds a signal/weight/gate back anywhere).
 */
'use strict';

const { WINDOW_SIZE_DRAWS } = require('./fiveBallDualColorNextEventEngine');

const MAX_TRADE_LOG_ENTRIES = 3000;
const MAX_SESSION_LOG_ENTRIES = 500;
const MAX_RESET_LOG_ENTRIES = 500;

const PHASE1_DRAWS = 15;
const PHASE2_DRAWS = WINDOW_SIZE_DRAWS - PHASE1_DRAWS; // kept for parity/reporting only -- no stake difference between phases in this engine

const DEFAULT_PAYOUT_MULTIPLIER = 85; // identical market to the ladder engine
const DEFAULT_STARTING_CAPITAL = 100000;

const TIER_MULTIPLIERS = {
  EXPLORATORY: 0,     // skip staking this side entirely
  EMERGING: 0.5,
  ESTABLISHED: 1,
  STRONG: 1.5
};

const DEFAULT_MISS_STREAK_CAP = 5;
const DEFAULT_FLAT_STAKE_PER_COLOR = 100;
const DEFAULT_KELLY_FRACTION = 0.25;      // quarter-Kelly
const DEFAULT_MIN_STAKE_PER_COLOR = 50;
const DEFAULT_MAX_STAKE_PER_COLOR = 1000;

function defaultConfig() {
  return {
    sizingMode: 'TIER_WEIGHTED',        // 'FLAT' | 'TIER_WEIGHTED' | 'KELLY'
    flatStakePerColor: DEFAULT_FLAT_STAKE_PER_COLOR,
    tierMultipliers: { ...TIER_MULTIPLIERS },
    kellyFraction: DEFAULT_KELLY_FRACTION,
    minStakePerColor: DEFAULT_MIN_STAKE_PER_COLOR,
    maxStakePerColor: DEFAULT_MAX_STAKE_PER_COLOR,
    missStreakCap: DEFAULT_MISS_STREAK_CAP,
    payoutMultiplier: DEFAULT_PAYOUT_MULTIPLIER,
    startingCapital: DEFAULT_STARTING_CAPITAL
  };
}

// ---------------------------------------------------------------------------
// Stake sizing -- the one part that genuinely differs by mode. Each
// function returns a per-color stake (0 means "do not stake this color
// this session").
// ---------------------------------------------------------------------------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Kelly fraction for a single-outcome bet at given win probability p and
// payout multiplier b (net odds b-to-1): f* = (b*p - (1-p)) / b, clamped
// to [0, 1] since a negative Kelly means "don't bet."
function kellyFractionOf(p, payoutMultiplier) {
  const b = payoutMultiplier;
  const f = (b * p - (1 - p)) / b;
  return Math.max(0, f);
}

function stakeForColor(cfg, confidencePct, tier, bankroll) {
  const p = clamp((confidencePct || 0) / 100, 0, 1);

  if (cfg.sizingMode === 'FLAT') {
    return cfg.flatStakePerColor;
  }

  if (cfg.sizingMode === 'TIER_WEIGHTED') {
    const mult = (cfg.tierMultipliers && cfg.tierMultipliers[tier] != null) ? cfg.tierMultipliers[tier] : 0;
    return round2(cfg.flatStakePerColor * mult);
  }

  if (cfg.sizingMode === 'KELLY') {
    if (tier === 'EXPLORATORY') return 0; // same "don't bet near-zero evidence" rule as TIER_WEIGHTED
    const fullKelly = kellyFractionOf(p, cfg.payoutMultiplier);
    const stake = fullKelly * cfg.kellyFraction * bankroll;
    if (stake <= 0) return 0;
    return round2(clamp(stake, cfg.minStakePerColor, cfg.maxStakePerColor));
  }

  return cfg.flatStakePerColor; // unknown mode -- safe fallback
}

// ---------------------------------------------------------------------------
// State factory (persisted at store.fiveBallDualColorAdaptiveTrader)
// ---------------------------------------------------------------------------

function freshTradeSession(sessionId, triggerPosition, session, cfg, bankroll) {
  const repeatStake = stakeForColor(cfg, session.repeatConfidencePct, session.repeatTier, bankroll);
  const transitionStake = stakeForColor(cfg, session.transitionConfidencePct, session.transitionTier, bankroll);
  return {
    sessionId,
    triggerPosition,
    predictedColors: [session.repeatColor, session.transitionColor],
    sizingMode: cfg.sizingMode,
    stakes: {
      [session.repeatColor]: repeatStake,
      [session.transitionColor]: transitionStake
    },
    tiers: {
      [session.repeatColor]: session.repeatTier,
      [session.transitionColor]: session.transitionTier
    },
    startedAt: new Date().toISOString(),
    closedAt: null,
    lastProcessedElapsed: 0,
    tradesPlayed: 0,
    hits: 0,
    misses: 0,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    result: null,
    hitColor: null,
    hitElapsedDraws: null
  };
}

function freshState(config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };
  return {
    schemaVersion: 1,
    config: cfg,

    // WAITING_FOR_SESSION | ACTIVE | PAUSED_STREAK_CAP
    tradingState: 'WAITING_FOR_SESSION',
    streakCapReached: false,
    missStreak: 0,

    lastProcessedSessionId: null,
    tradeSession: null,

    capital: {
      startingCapital: cfg.startingCapital,
      currentCapital: cfg.startingCapital,
      realizedPnL: 0,
      totalStaked: 0,
      totalReturned: 0
    },

    trades: [],
    sessions: [],
    resets: [],

    updatedAt: null
  };
}

function ensureStateShape(persistentState) {
  const fresh = freshState();
  const s = persistentState && typeof persistentState === 'object' ? persistentState : fresh;
  if (s.schemaVersion == null) s.schemaVersion = 1;
  s.config = { ...fresh.config, ...(s.config || {}) };
  s.config.tierMultipliers = { ...TIER_MULTIPLIERS, ...(s.config.tierMultipliers || {}) };
  if (!s.tradingState) s.tradingState = fresh.tradingState;
  s.streakCapReached = Boolean(s.streakCapReached);
  if (!s.missStreak) s.missStreak = 0;
  if (typeof s.lastProcessedSessionId === 'undefined') s.lastProcessedSessionId = null;
  if (typeof s.tradeSession === 'undefined') s.tradeSession = null;
  if (!s.capital || typeof s.capital !== 'object') s.capital = fresh.capital;
  if (!Array.isArray(s.trades)) s.trades = [];
  if (!Array.isArray(s.sessions)) s.sessions = [];
  if (!Array.isArray(s.resets)) s.resets = [];
  if (typeof s.updatedAt === 'undefined') s.updatedAt = null;
  return s;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {Object} fiveBallHarvest  this cycle's fiveBallHarvester.js result (needs eventLog, totalDrawsObserved)
 * @param {Object} dualColorResult  this cycle's evaluateFiveBallDualColorNextEvent() output
 * @param {Object} persistentState  store.fiveBallDualColorAdaptiveTrader (mutated in place)
 */
function advanceFiveBallDualColorAdaptiveTrader(fiveBallHarvest, dualColorResult, persistentState) {
  const state = ensureStateShape(persistentState);
  const cfg = state.config;
  const harvest = fiveBallHarvest || {};
  const dual = dualColorResult || {};
  const eventLog = Array.isArray(harvest.eventLog) ? harvest.eventLog : [];
  const totalDrawsObserved = harvest.totalDrawsObserved || 0;

  if (!state.streakCapReached) {
    maybeOpenSession(state, cfg, dual);
    if (state.tradeSession) {
      advanceTradeSession(state, cfg, eventLog, totalDrawsObserved);
    }
  }

  state.tradingState = state.streakCapReached
    ? 'PAUSED_STREAK_CAP'
    : (state.tradeSession ? 'ACTIVE' : 'WAITING_FOR_SESSION');

  state.updatedAt = new Date().toISOString();
  return buildSummary(state);
}

function maybeOpenSession(state, cfg, dual) {
  if (state.tradeSession) return;
  const src = dual.activeSession;
  if (!src) return;
  if (src.sessionId === state.lastProcessedSessionId) return;

  state.tradeSession = freshTradeSession(src.sessionId, src.triggerPosition, src, cfg, state.capital.currentCapital);
  state.lastProcessedSessionId = src.sessionId;
}

function advanceTradeSession(state, cfg, eventLog, totalDrawsObserved) {
  const session = state.tradeSession;
  const currentElapsed = Math.max(0, Math.min(totalDrawsObserved - session.triggerPosition, WINDOW_SIZE_DRAWS));

  for (let elapsed = session.lastProcessedElapsed + 1; elapsed <= currentElapsed; elapsed++) {
    const drawPosition = session.triggerPosition + elapsed;
    const hitEvent = eventLog.find(e => e.position === drawPosition && session.predictedColors.indexOf(e.eventColor) !== -1);
    playTrade(state, cfg, session, elapsed, drawPosition, hitEvent ? hitEvent.eventColor : null);
    session.lastProcessedElapsed = elapsed;
    if (session.result) break;
  }

  if (!session.result && currentElapsed >= WINDOW_SIZE_DRAWS) {
    closeSession(state, cfg, 'MISS');
  }
}

function playTrade(state, cfg, session, elapsedDraws, drawPosition, hitColor) {
  const phase = elapsedDraws <= PHASE1_DRAWS ? 1 : 2;
  const [colorA, colorB] = session.predictedColors;
  const stakeA = session.stakes[colorA] || 0;
  const stakeB = session.stakes[colorB] || 0;
  const totalStake = stakeA + stakeB;

  const result = hitColor && (session.stakes[hitColor] > 0) ? 'HIT' : 'MISS';
  const winningStake = result === 'HIT' ? session.stakes[hitColor] : 0;
  const grossReturn = result === 'HIT' ? winningStake * cfg.payoutMultiplier : 0;
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

  const trade = {
    tradeId: `${session.sessionId}-${elapsedDraws}`,
    timestamp: new Date().toISOString(),
    sessionId: session.sessionId,
    drawPosition,
    elapsedDraws,
    phase,
    sizingMode: session.sizingMode,
    stakes: { [colorA]: stakeA, [colorB]: stakeB },
    totalStake,
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
    closeSession(state, cfg, 'HIT');
  }
}

function closeSession(state, cfg, outcome) {
  const session = state.tradeSession;
  if (!session) return;
  session.result = outcome;
  session.closedAt = new Date().toISOString();

  state.sessions.unshift({ ...session });
  if (state.sessions.length > MAX_SESSION_LOG_ENTRIES) state.sessions.length = MAX_SESSION_LOG_ENTRIES;

  if (outcome === 'HIT') {
    state.missStreak = 0;
    state.streakCapReached = false;
    state.resets.unshift({
      resetAt: new Date().toISOString(),
      sessionId: session.sessionId,
      reason: 'SESSION_HIT',
      hitColor: session.hitColor,
      hitElapsedDraws: session.hitElapsedDraws,
      sessionPnL: session.netPnL,
      capitalAfter: state.capital.currentCapital
    });
    if (state.resets.length > MAX_RESET_LOG_ENTRIES) state.resets.length = MAX_RESET_LOG_ENTRIES;
  } else {
    state.missStreak += 1;
    if (state.missStreak >= cfg.missStreakCap) state.streakCapReached = true;
  }

  state.tradeSession = null;
}

// ---------------------------------------------------------------------------
// Performance rollups
// ---------------------------------------------------------------------------

function buildPerformance(state) {
  const trades = state.trades;
  const totalTrades = trades.length;
  let totalHits = 0, totalStake = 0, totalReturn = 0;
  let maxDrawdown = 0;
  let peakCapital = state.capital.startingCapital;

  const chronological = trades.slice().reverse();
  for (const t of chronological) {
    if (t.result === 'HIT') totalHits++;
    totalStake += t.totalStake;
    totalReturn += t.grossReturn;
    if (t.capitalAfter > peakCapital) peakCapital = t.capitalAfter;
    const drawdown = peakCapital - t.capitalAfter;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const sessions = state.sessions;
  const sessionHits = sessions.filter(s => s.result === 'HIT').length;
  const sessionMisses = sessions.filter(s => s.result === 'MISS').length;

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
      sessionHitRate: sessions.length ? round2((sessionHits / sessions.length) * 100) : null
    },
    risk: {
      maxDrawdown: round2(maxDrawdown),
      missStreak: state.missStreak,
      missStreakCap: state.config.missStreakCap,
      streakCapReached: state.streakCapReached
    }
  };
}

function buildSummary(state) {
  return {
    engine: '5-Ball Dual-Color Adaptive Paper Trader',
    tradingState: state.tradingState,
    streakCapReached: state.streakCapReached,
    missStreak: state.missStreak,
    config: state.config,
    tradeSession: state.tradeSession,
    capital: state.capital,
    currentTrade: state.trades[0] || null,
    lastReset: state.resets[0] || null,
    performance: buildPerformance(state),
    trades: state.trades.slice(0, 100),
    sessions: state.sessions.slice(0, 50),
    resets: state.resets.slice(0, 50),
    updatedAt: state.updatedAt
  };
}

module.exports = {
  DEFAULT_PAYOUT_MULTIPLIER,
  DEFAULT_STARTING_CAPITAL,
  TIER_MULTIPLIERS,
  DEFAULT_MISS_STREAK_CAP,
  DEFAULT_FLAT_STAKE_PER_COLOR,
  DEFAULT_KELLY_FRACTION,
  defaultConfig,
  kellyFractionOf,
  stakeForColor,
  freshState,
  ensureStateShape,
  advanceFiveBallDualColorAdaptiveTrader,
  buildSummary
};
