/**
 * ============================================================
 *  WINDOW SECTION TRACKER  (v1)
 * ============================================================
 *
 * QUESTION THIS ENGINE ANSWERS
 * ----------------------------
 * The Zero Color hit counter and the 4-Ball Next Event hit counter both
 * score a prediction over the same 8-draw window (ALERT_WITHIN 4 draws
 * pre-overdue + OVERDUE cap 4 draws). A HIT is a HIT wherever it lands
 * inside that window. This tracker keeps the window unchanged and only
 * records WHERE inside it each HIT landed, so we can see which section
 * of the window produces the most hits, per engine:
 *
 *   PRE       -- the "~4" countdown part of the window
 *   OVERDUE   -- overdue +1 .. +4
 *
 * SECTION MAPPING (all derived from the counter's own log entry)
 * --------------------------------------------------------------
 * Each resolved counter entry carries { result, callType, drawsElapsed }.
 *   callType 'DUE_IN_N'      -> the countdown had N draws left at open
 *   callType 'OVERDUE (+M)'  -> the event was already M draws overdue at open
 * Let N = draws-remaining-at-open (N = -M for an already-overdue open).
 * A HIT on window draw k (k = drawsElapsed, 1..8) sits at offset k - N:
 *   offset <= 0        -> PRE       (draws 1..N; the countdown incl. the due draw)
 *   offset 1 .. 4      -> OVERDUE +1 .. +4
 *   offset >= 5        -> OVERDUE +5 or more (out of spec; see below)
 * For the normal case -- a watch opened at DUE_IN_4 -- this is exactly
 * window draws 1-4 = PRE and draws 5-8 = OVERDUE +1..+4.
 *
 * WHY THERE IS AN "OVERDUE +5 OR MORE" BUCKET
 * -------------------------------------------
 * A counter watch can open with fewer than 4 draws of countdown left
 * (e.g. DUE_IN_2, or already OVERDUE (+1)), but the window is still 8
 * draws from open. Those watches can score a HIT at overdue +5 or later.
 * They are kept out of both requested totals and reported separately
 * rather than being folded into "+1 to +4". The raw window-draw
 * histogram (byDrawIndex, D1..D8) is kept alongside as the
 * interpretation-free ground truth, and openMix shows how often watches
 * open at each call type so the size of this effect is visible.
 *
 * INGESTION
 * ---------
 * Reads each counter's own resolved-prediction log (newest-first,
 * capped at 20 by the counters). Every entry is ingested exactly once,
 * keyed by openedAfterDrawId|resolvedOnDrawId|result. The first
 * evaluation seeds from whatever entries are already in those logs
 * (at most the last 20 per engine); nothing older exists to backfill.
 *
 * ABSOLUTE SEPARATION RULE: pure, read-only, observational. Does not
 * import, call, or alter zeroColorHitCounter, fourBallColorNextEventHitCounter,
 * zeroColorEngine, or fourBallColorNextEventEngine, and never feeds any
 * gate/weight/vote. It only reads their emitted output.
 */
'use strict';

const WINDOW_DRAWS = 8;      // mirrors both counters' WINDOW_DRAWS
const PRE_ALERT_DRAWS = 4;   // mirrors both engines' NEXT_EVENT_ALERT_WITHIN
const OVERDUE_CAP = 4;       // overdue +1..+4 are the requested slots
const SEEN_CAP = 60;         // counters cap their logs at 20; 60 is ample headroom
const SMALL_SAMPLE_HITS = 20;

const ENGINE_KEYS = ['zero', 'fourBall'];
const ENGINE_LABELS = { zero: 'Zero Color', fourBall: '4-Ball Next Event' };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function freshEngineStats() {
  return {
    hits: 0,
    misses: 0,
    pre: 0,
    od: new Array(OVERDUE_CAP).fill(0),
    odBeyond: 0,
    unclassified: 0,
    byDrawIndex: new Array(WINDOW_DRAWS).fill(0),
    openMix: {},
    seededEntries: 0
  };
}

function freshState() {
  return {
    schemaVersion: 1,
    seenKeys: { zero: [], fourBall: [] },
    engines: { zero: freshEngineStats(), fourBall: freshEngineStats() },
    firstEvaluatedAt: null,
    updatedAt: null
  };
}

// Fill any missing / malformed fields in place so a stored snapshot (or the
// store's bare placeholder object) is always safe to accumulate into.
function normalizeState(state) {
  if (!state.seenKeys || typeof state.seenKeys !== 'object') state.seenKeys = {};
  if (!state.engines || typeof state.engines !== 'object') state.engines = {};
  for (const key of ENGINE_KEYS) {
    if (!Array.isArray(state.seenKeys[key])) state.seenKeys[key] = [];
    const s = (state.engines[key] && typeof state.engines[key] === 'object')
      ? state.engines[key] : (state.engines[key] = freshEngineStats());
    s.hits = num(s.hits);
    s.misses = num(s.misses);
    s.pre = num(s.pre);
    s.odBeyond = num(s.odBeyond);
    s.unclassified = num(s.unclassified);
    s.seededEntries = num(s.seededEntries);
    if (!Array.isArray(s.od)) s.od = [];
    s.od = Array.from({ length: OVERDUE_CAP }, (_, i) => num(s.od[i]));
    if (!Array.isArray(s.byDrawIndex)) s.byDrawIndex = [];
    s.byDrawIndex = Array.from({ length: WINDOW_DRAWS }, (_, i) => num(s.byDrawIndex[i]));
    if (!s.openMix || typeof s.openMix !== 'object' || Array.isArray(s.openMix)) s.openMix = {};
  }
  if (!state.schemaVersion) state.schemaVersion = 1;
  if (state.firstEvaluatedAt === undefined) state.firstEvaluatedAt = null;
  if (state.updatedAt === undefined) state.updatedAt = null;
  return state;
}

// callType -> draws remaining in the countdown when the watch opened
// (negative = already overdue). Returns null for legacy / unknown labels.
function parseOpenRemaining(callType) {
  if (typeof callType !== 'string') return null;
  let m = /^DUE_IN_(\d+)$/.exec(callType);
  if (m) return Number(m[1]);
  m = /^OVERDUE \(\+(\d+)\)$/.exec(callType);
  if (m) return -Number(m[1]);
  return null;
}

function openBucket(callType) {
  if (typeof callType !== 'string') return 'OTHER';
  if (/^DUE_IN_\d+$/.test(callType)) return callType;
  if (/^OVERDUE/.test(callType)) return 'OVERDUE';
  return 'OTHER';
}

function entryKey(e) {
  return `${e.openedAfterDrawId ?? 'null'}|${e.resolvedOnDrawId ?? 'null'}|${e.result}`;
}

function ingestEntry(stats, e) {
  const bucket = openBucket(e.callType);
  stats.openMix[bucket] = num(stats.openMix[bucket]) + 1;

  if (e.result === 'MISS') {
    stats.misses++;
    return;
  }

  stats.hits++;
  const k = Number(e.drawsElapsed);
  const kValid = Number.isInteger(k) && k >= 1 && k <= WINDOW_DRAWS;
  if (kValid) stats.byDrawIndex[k - 1]++;

  const openRemaining = parseOpenRemaining(e.callType);
  if (!kValid || openRemaining === null) {
    stats.unclassified++;
    return;
  }
  const offset = k - openRemaining;
  if (offset <= 0) stats.pre++;
  else if (offset <= OVERDUE_CAP) stats.od[offset - 1]++;
  else stats.odBeyond++;
}

function ingestEngine(state, key, counterOutput) {
  const stats = state.engines[key];
  const seen = state.seenKeys[key];
  const seenSet = new Set(seen);
  const log = counterOutput && Array.isArray(counterOutput.predictions)
    ? counterOutput.predictions : [];

  // log is newest-first; ingest oldest-first so seenKeys stays chronological
  const fresh = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (!e || (e.result !== 'HIT' && e.result !== 'MISS')) continue;
    const k = entryKey(e);
    if (seenSet.has(k)) continue;
    seenSet.add(k);
    fresh.push({ e, k });
  }

  const isFirstIngest = seen.length === 0 && stats.hits + stats.misses === 0;
  for (const { e, k } of fresh) {
    ingestEntry(stats, e);
    seen.push(k);
  }
  if (isFirstIngest) stats.seededEntries = fresh.length;
  if (seen.length > SEEN_CAP) seen.splice(0, seen.length - SEEN_CAP);
}

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function summarizeEngine(key, stats) {
  const odTotal = stats.od.reduce((a, b) => a + b, 0);
  const preHits = stats.pre;

  let leader = null;
  if (preHits > 0 || odTotal > 0) {
    leader = preHits > odTotal ? 'PRE' : odTotal > preHits ? 'OVERDUE_1_4' : 'TIE';
  }

  const slots = [{ label: '~4 zone', hits: preHits }]
    .concat(stats.od.map((h, i) => ({ label: `+${i + 1}`, hits: h })));
  const maxSlot = Math.max(...slots.map(s => s.hits));
  const topSlot = maxSlot > 0
    ? slots.filter(s => s.hits === maxSlot).map(s => s.label).join(' = ')
    : null;

  const leaderText = leader === 'PRE' ? '~4 zone leads'
    : leader === 'OVERDUE_1_4' ? 'overdue +1..+4 leads'
    : leader === 'TIE' ? 'dead level'
    : 'no hits yet';

  let reasoning = `${ENGINE_LABELS[key]}: ${stats.hits} hit(s) — ~4 zone ${preHits}`
    + (pct(preHits, stats.hits) != null ? ` (${pct(preHits, stats.hits)}%)` : '')
    + `, overdue +1..+4 ${odTotal}`
    + (pct(odTotal, stats.hits) != null ? ` (${pct(odTotal, stats.hits)}%)` : '')
    + `; ${leaderText}.`;
  if (stats.odBeyond > 0) {
    reasoning += ` ${stats.odBeyond} hit(s) landed at overdue +5 or later (watch opened with <4 draws of countdown) — counted separately.`;
  }
  if (stats.unclassified > 0) {
    reasoning += ` ${stats.unclassified} hit(s) had an unparseable call type — in the D1..D8 histogram only.`;
  }
  if (stats.hits > 0 && stats.hits < SMALL_SAMPLE_HITS) {
    reasoning += ` Small sample (<${SMALL_SAMPLE_HITS} hits) — directional only.`;
  }

  return {
    label: ENGINE_LABELS[key],
    hits: stats.hits,
    misses: stats.misses,
    resolved: stats.hits + stats.misses,
    sections: {
      pre: { label: '~4 zone', hits: preHits, sharePct: pct(preHits, stats.hits) },
      overdue1to4: {
        label: 'Overdue +1..+4',
        hits: odTotal,
        sharePct: pct(odTotal, stats.hits),
        perSlot: stats.od.slice()
      },
      overdueBeyond4: { label: 'Overdue +5 or later', hits: stats.odBeyond },
      unclassified: { label: 'Unclassified', hits: stats.unclassified }
    },
    leader,
    topSlot,
    byDrawIndex: stats.byDrawIndex.slice(),
    openMix: Object.assign({}, stats.openMix),
    seededEntries: stats.seededEntries,
    smallSample: stats.hits < SMALL_SAMPLE_HITS,
    reasoning
  };
}

/**
 * Main entry point. Called once per council cycle AFTER both hit counters
 * have run for the cycle.
 *
 * @param {object} zeroCounterOutput   evaluateZeroColorHitCounter() result
 * @param {object} fourBallCounterOutput evaluateFourBallColorNextEventHitCounter() result
 * @param {object} persistentState     store.windowSectionTracker (mutated in place)
 */
function evaluateWindowSectionTracker(zeroCounterOutput, fourBallCounterOutput, persistentState) {
  const state = (persistentState && typeof persistentState === 'object')
    ? persistentState
    : freshState();
  normalizeState(state);

  const now = new Date().toISOString();
  if (!state.firstEvaluatedAt) state.firstEvaluatedAt = now;

  ingestEngine(state, 'zero', zeroCounterOutput);
  ingestEngine(state, 'fourBall', fourBallCounterOutput);
  state.updatedAt = now;

  const zero = summarizeEngine('zero', state.engines.zero);
  const fourBall = summarizeEngine('fourBall', state.engines.fourBall);

  return {
    engine: 'WindowSectionTracker',
    schemaVersion: 1,
    windowDraws: WINDOW_DRAWS,
    preZoneDraws: PRE_ALERT_DRAWS,
    overdueSlots: OVERDUE_CAP,
    zero,
    fourBall,
    firstEvaluatedAt: state.firstEvaluatedAt,
    updatedAt: state.updatedAt,
    reasoning: `${zero.reasoning} ${fourBall.reasoning}`
  };
}

module.exports = {
  WINDOW_DRAWS,
  PRE_ALERT_DRAWS,
  OVERDUE_CAP,
  evaluateWindowSectionTracker
};
