/**
 * colorSlipFeed.js — READ-ONLY feed for the SNIPER Color Slip Assistant (Chrome extension).
 *
 * It only RE-PUBLISHES what the Zero Color, 4-Ball and Tie (3-ball) Next Event engines already computed in the
 * cached snapshot. It never recomputes, adjusts or overrides a prediction, and it never writes to the store.
 *
 *   GET /api/v1/color-slip/feed        header  X-API-Key: <SLIP_API_KEY>
 *
 * If SLIP_API_KEY is not set on the server the feed answers 503 slip_feed_disabled (same convention as
 * the GEN X number slip feed): nothing is exposed until you set a key.
 */
const express = require('express');
const crypto = require('crypto');
const { store } = require('../core/store');
const { runSupremeCouncil } = require('../supreme/council');

const router = express.Router();

function keyOk(req) {
  const required = process.env.SLIP_API_KEY;
  if (!required) return 'disabled';
  const given = req.headers['x-api-key'];
  if (!given || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(required);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function engineDrawIdOf(snap) {
  if (!snap) return null;
  if (snap.basedOnDrawId != null) return String(snap.basedOnDrawId);
  for (const k of Object.keys(snap)) {
    const v = snap[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && v.basedOnDrawId != null && v.basedOnDrawId !== 'NONE') return String(v.basedOnDrawId);
  }
  return null;
}

function counterOf(c) {
  const call = c && c.eventCall ? c.eventCall : (c && c.zeroCall) || null;
  const p = call && call.pending;
  return {
    pending: p ? { openedAfterDrawId: String(p.openedAfterDrawId), drawsElapsed: num(p.drawsElapsed), callType: p.callType || null } : null,
    missLocked: !!(c && c.missLockEventDrawId != null)
  };
}

function modeOf(kind, eng, counter) {
  if (!eng) return { available: false };
  const np = eng.nextEventPrediction || null;
  const last = kind === 'zero' ? eng.lastZeroEvent : eng.lastEvent;
  const out = {
    available: !!eng.available && !!np,
    cycleId: last ? String(last.drawId) : null,          // the event that opened this cycle
    lastEvent: last ? { drawId: String(last.drawId), drawsAgo: num(last.drawsAgo) } : null,
    active: !!(np && np.active),
    isOverdue: !!(np && np.isOverdue),
    drawsRemaining: np ? num(np.drawsRemaining) : null,   // engine value, clamped at 0
    overdueByDraws: np ? num(np.overdueByDraws) : null,
    countdownLabel: np ? np.countdownLabel : null,        // "~4 draws" / "OVERDUE (+2)"
    statusLabel: np ? np.statusLabel : null,
    avgGap: eng.intervalStats ? num(eng.intervalStats.avgIntervalDraws) : null,
    pressure: num(kind === 'zero' ? eng.zeroPressureScore : eng.fourBallPressureScore),
    probability: num(kind === 'zero' ? eng.zeroProbabilityPct : eng.eventProbabilityPct),
    confidence: eng.confidenceLabel || null,
    badge: eng.marketStateLabel || null,                  // the engine's own badge, e.g. "NO EDGE"
    expectedWindow: eng.expectedWindow ? eng.expectedWindow.label : null,
    counter: counterOf(counter)
  };
  if (kind === 'zero') {
    out.lastEventDetail = last ? { drawId: String(last.drawId), drawsAgo: num(last.drawsAgo), missingColors: last.missingColors || [] } : null;
  } else {
    const cb = eng.colorBreakdown || {};
    out.candidates = ['RED', 'BLUE', 'GREEN'].map((c) => ({ color: c, drawsAgo: cb[c] ? num(cb[c].lastPlayedDrawsAgo) : null }));
    out.dueColor = eng.predictedNextColor || null;        // telemetry only — never narrows the slip
  }
  return out;
}

/**
 * TIE (3-ball) mode — v3.4. Pure re-publication of what the server already computed; nothing here changes a prediction.
 *   snap.tieIntelligence                 (tieEngine.js)  → countdown, avg gap, last tie, pressure, probability, confidence, market state, expected window
 *   snap.tiePrecursorPatterns            (tiePrecursorPatternEngine.js) → prediction.unifiedSignal = the PRECURSOR trigger
 *   snap.tieNextEvent                    (tieNextEventEngine.js) → regime / hot-cold zones / entry read (telemetry only)
 *   snap.tierOverduePrecursorHitCounter  (tierOverduePrecursorHitCounter.js) → the server's own 8-draw OVERDUE/PRECURSOR watch (telemetry only)
 *
 * Countdown: tieEngine's drawsUntilNextTie = max(0, round(avgInterval − drawsSinceLastTie)); 0 means OVERDUE. tieEngine has no
 * "overdue by N" figure, so overdueByDraws is DERIVED here as max(0, round(drawsSinceLastTie − avgInterval)) purely for the label.
 * cycleId = lastTie.drawId (the draw the last tie landed on) — it changes exactly when a new tie lands, which is how the
 * extension scores a HIT (same convention as the colour modes' last-event draw).
 */
function tieModeOf(snap) {
  const tie = snap && snap.tieIntelligence;
  if (!tie) return { available: false };
  const pred = tie.tiePrediction || {};
  const iv = tie.intervalStats || {};
  const last = tie.lastTie || null;
  const win = tie.expectedWindow || pred.expectedWindow || null;
  const drawsUntil = num(tie.drawsUntilNextTie != null ? tie.drawsUntilNextTie : pred.drawsUntilNextTie);
  const avg = num(iv.avgIntervalDraws);
  const drawsAgo = last ? num(last.drawsAgo) : null;
  const isOverdue = drawsUntil === 0;
  const overdueBy = isOverdue && avg != null && drawsAgo != null ? Math.max(0, Math.round(drawsAgo - avg)) : 0;
  const market = tie.marketStateLabel || pred.marketStateLabel || null;

  const pre = snap.tiePrecursorPatterns || null;
  const preP = pre && pre.prediction ? pre.prediction : null;
  const us = preP && preP.unifiedSignal ? preP.unifiedSignal : null;
  const precursor = {
    sufficient: !!(pre && pre.sufficientHistory),
    active: !!(us && us.active),                         // the PRECURSOR trigger (same gate the server's own Tier counter uses)
    type: us ? us.type || null : null,                   // NEXT_DRAW | WINDOW
    message: us ? us.message || null : null,
    drawsRemaining: us ? num(us.drawsRemaining) : null,
    probabilityPct: us ? num(us.probabilityPct) : null,
    riskLevel: preP ? preP.riskLevel || null : null,
    combinedScore: preP ? num(preP.combinedScore) : null,
    sources: preP && Array.isArray(preP.activePrecursors) ? preP.activePrecursors.slice() : []
  };

  const ne = snap.tieNextEvent || null;
  const fc = ne && ne.forecast ? ne.forecast : null;
  const nextEvent = ne ? {
    engineState: ne.engineState || null,
    regime: fc ? fc.regime || null : null,
    windowProbability: fc ? num(fc.windowProbability) : null,
    windowSpan: fc ? num(fc.windowSpan) : null,
    entryRead: fc && fc.recommendation ? fc.recommendation.action || null : null,        // ENTER | AVOID | MONITOR | CAUTION_OVERDUE | INSUFFICIENT_DATA
    entryWindow: fc && fc.zones ? fc.zones.entryWindow || null : null,
    avoidWindow: fc && fc.zones ? fc.zones.avoidWindow || null : null,
    peakGap: fc && fc.zones ? num(fc.zones.peakGap) : null,
    penetration: ne.penetration ? ne.penetration.displayState || null : null,
    accuracyRate: ne.evaluation ? num(ne.evaluation.accuracyRate) : null
  } : null;

  const hc = snap.tierOverduePrecursorHitCounter || null;
  const counter = hc && hc.tierCall ? {
    windowDraws: num(hc.windowDraws), missLocked: !!hc.missLocked, totalCalls: num(hc.totalCalls),
    hits: num(hc.tierCall.hits), misses: num(hc.tierCall.misses), hitRatePct: num(hc.tierCall.hitRatePct),
    pending: !!hc.tierCall.pending, callType: hc.tierCall.callType || null, drawsElapsed: num(hc.tierCall.drawsElapsed)
  } : null;

  return {
    available: !!(tie.sufficientSample && last && drawsUntil !== null),
    cycleId: last ? String(last.drawId) : null,           // the draw the last tie landed on
    lastEvent: last ? { drawId: String(last.drawId), drawsAgo: drawsAgo, shape: last.shape || null } : null,
    active: true,
    isOverdue,
    drawsRemaining: drawsUntil,                            // engine value, clamped at 0 (0 = overdue)
    overdueByDraws: overdueBy,
    countdownLabel: drawsUntil === null ? null : (isOverdue ? 'OVERDUE (+' + overdueBy + ')' : '~' + drawsUntil + ' draws'),
    statusLabel: market ? String(market).replace(/_/g, ' ') : null,
    avgGap: avg,
    pressure: num(tie.tiePressureScore != null ? tie.tiePressureScore : (tie.tiePressure || {}).score),
    probability: num(pred.tieProbabilityPct),
    confidence: tie.confidenceLabel || pred.confidenceLabel || null,
    riskLevel: pred.riskLevel || null,
    operatorAction: tie.operatorAction || pred.operatorAction || null,
    badge: market ? String(market).replace(/_/g, ' ') : null,
    expectedWindow: win ? win.label || null : null,
    precursor, nextEvent, counter
  };
}

router.get(['/color-slip/feed', '/v1/color-slip/feed'], (req, res) => {
  const k = keyOk(req);
  if (k === 'disabled') return res.status(503).json({ ok: false, error: 'slip_feed_disabled' });
  if (!k) return res.status(401).json({ ok: false, error: 'bad_api_key' });
  try {
    const snap = store.cachedSystemState || runSupremeCouncil();
    const draws = store.historicalDraws || [];
    const zeroC = snap.zeroColorHitCounter, fourC = snap.fourBallColorNextEventHitCounter;
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      serverTime: Date.now(),
      latestDrawId: draws.length ? String(draws[0].drawId) : null,
      engineDrawId: engineDrawIdOf(snap),
      recentDrawIds: draws.slice(0, 30).map((d) => String(d.drawId)),   // newest first
      modes: {
        zero: modeOf('zero', snap.zeroColorIntelligence, zeroC),
        fourBall: modeOf('fourBall', snap.fourBallColorNextEvent, fourC),
        tie: tieModeOf(snap)                                   // v3.4
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'feed_error', detail: String((e && e.message) || e) });
  }
});

module.exports = router;
module.exports.tieModeOf = tieModeOf;   // exported for the test harness only
