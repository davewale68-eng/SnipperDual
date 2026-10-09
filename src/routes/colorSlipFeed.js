/**
 * colorSlipFeed.js — READ-ONLY feed for the SNIPER Color Slip Assistant (Chrome extension).
 *
 * It only RE-PUBLISHES what the Zero Color and 4-Ball Next Event engines already computed in the
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
        fourBall: modeOf('fourBall', snap.fourBallColorNextEvent, fourC)
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'feed_error', detail: String((e && e.message) || e) });
  }
});

module.exports = router;
