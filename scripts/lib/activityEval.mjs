/**
 * activityEval.mjs — offline reader for the activity-aware sampling prototype.
 *
 * The prototype's evaluation numbers are produced in TWO places, and a run is
 * only readable when both are present:
 *
 *   1. CAPTURE side, renderer DevTools only. `captureController.ts` prints
 *      `[backseat/eval] activity=... confidence=... policy=... fallback=...`,
 *      `policy_switch from=.. to=..`, `tick_count=..`, `sample_count=..`
 *      `sample_rate=..` and `idle_delay_ms=..`. There is NO console relay into
 *      the log file (`appendOverlayLog` exists only in a comment in
 *      backseatLog.ts), so these lines have to be copied out of the DevTools
 *      console by hand or saved there with "Save as" — no file on disk gets them.
 *
 *   2. MODEL side, the rolling session log at
 *      `<userData>/logs/backseat-<characterId>-<ISO>.log`. That file carries
 *      `[eval] awake_count=`, `[eval] model_call_count=`,
 *      `[eval] model_latency_ms=`, `turn <kind>: in=/cacheRead=/cacheWrite=`
 *      and `turn <kind>: said N line(s)`. Silence is NOT logged at all
 *      (`if (!parts.length) return` in backseatService.ts), so silence has to be
 *      inferred by subtraction.
 *
 * TIME BASE TRAP: backseatLog's `ts()` is `new Date().toISOString().slice(11,23)`,
 * so the file's `[HH:MM:SS.mmm]` stamps are **UTC**, while DevTools console
 * timestamps and your wall clock are local. Never compare the two directly.
 * This module therefore prefers SESSION-RELATIVE offsets for annotation
 * matching (`"+03:20"` = 3 min 20 s after the session's first log line), which
 * is timezone-proof, and supports absolute local annotation times only through
 * an explicit clock conversion.
 *
 * PRIVACY: this module reads counts and timestamps. It deliberately ignores the
 * pre-patch `session start: ... source="..."` payload and never surfaces a
 * window title, pixels, audio, transcript or page text. Nothing here reads
 * capture artifacts; the only file access is in the CLI.
 *
 * Pure module on purpose: no I/O, no clock, no Math.random, so vitest can pin
 * every number.
 */

/** Baseline cadence, from src/shared/backseatIpc.ts. */
export const BASELINE_POLICY = Object.freeze({
  name: 'baseline',
  sampleIntervalMs: 100, // SAMPLE_INTERVAL_MS -> 10 Hz
  idleMinMs: 12_000, // IDLE_MIN_MS
  idleMaxMs: 60_000, // IDLE_MAX_MS
  idleMeanMs: 28_000, // IDLE_MIN_MS + IDLE_MEAN_EXTRA_MS
});

/** Prototype cadence, from src/renderer/src/lib/backseat/activitySampling.ts. */
export const LONG_VIDEO_POLICY = Object.freeze({
  name: 'long_video',
  sampleIntervalMs: 125, // 8 Hz; 125 ms still resolves the grid's 187.5 ms pair
  idleScale: 1.25,
  idleMinMs: 15_000, // 12 s * 1.25
  idleMaxMs: 75_000, // min(60 s * 1.25, IDLE_MAX_MS + 15_000)
  idleMeanMs: 35_000, // 28 s * 1.25
});

/** Floor between two companion lines, from src/shared/backseatIpc.ts. */
export const MIN_SPEAK_GAP_MS = 8_000;

/**
 * Newest `backseat-*.log` from a list of `{ path, mtimeMs }`. The app writes to
 * a DIFFERENT userData dir in dev ("Sei Dev") than when packaged ("Sei"), so a
 * caller that only looks in one of them silently reads a stale session.
 */
export function pickNewestLog(entries) {
  const valid = (entries ?? []).filter(
    (e) => e && typeof e.path === 'string' && /(^|[\\/])backseat-[^\\/]*\.log$/.test(e.path),
  );
  if (!valid.length) return null;
  return valid.reduce((best, e) => (e.mtimeMs > best.mtimeMs ? e : best)).path;
}

const RENDERER_MARK = '[backseat/eval]';
const MAIN_TS = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/;
/** DevTools may prefix a local clock stamp before `source.ts:line`. */
const ANY_TS = /(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?/;

function todOf(h, m, s, ms = '0') {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** `key=value` / `key="value"` pairs after a `[backseat/eval]` marker. */
export function parseKv(text) {
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

/**
 * Session-relative offset in seconds. Tolerates a session crossing midnight:
 * the log stamps are time-of-day only, so a negative difference wraps +24 h.
 * Returns null when either side has no timestamp (pasted lines often don't).
 */
export function offsetSec(todSec, startTodSec) {
  if (todSec == null || startTodSec == null) return null;
  const d = todSec - startTodSec;
  return d >= 0 ? d : d + 86_400;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export { median };

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
}

/**
 * Parse one run from raw text: a main backseat `.log`, pasted renderer console
 * output, or (usual case) both concatenated. Line kinds are detected by shape,
 * so order between the two sources does not matter.
 */
export function parseRun(text, { label = 'run' } = {}) {
  const run = {
    label,
    sourceKind: null,
    startTodSec: null,
    endTodSec: null,
    capture: {
      present: false,
      timestamps: false,
      /**
       * Capture offsets are measured from the FIRST renderer line, never from
       * the session log's first line: the log stamps are UTC and DevTools
       * stamps are local, so mixing origins would be off by the whole timezone.
       * Both origins sit within a couple of seconds of the real session start.
       */
      originTodSec: null,
      endTodSec: null,
      durationSec: null,
      states: [], // { activity, confidence, policy, fallback, todSec, offsetSec }
      switches: [], // { from, to, todSec, offsetSec }
      tickCount: 0,
      ticksByPolicy: {},
      ticksByKind: {},
      tickLines: 0,
      sampleCountFirst: null,
      sampleCountLast: null,
      sampleRates: [],
      sampleReadingsByPolicy: {},
      idleDelays: [],
      stateDurationsSec: null,
      secUnderPolicy: null,
    },
    model: {
      present: false,
      awakeCount: 0,
      callCount: 0,
      latencies: [],
      aborted: 0,
      tokens: { in: 0, cacheRead: 0, cacheWrite: 0, lines: 0 },
      outputTokens: null, // never logged by the prototype
      said: [], // { at, offsetSec, lines, kind }
      failed: 0,
      noteLeakDropped: 0,
      droppedByReason: {},
      turnsByKind: {},
    },
    warnings: [],
    lines: 0,
  };

  let seq = 0;
  const raw = String(text ?? '').split(/\r?\n/);

  for (const original of raw) {
    const line = original.trim();
    if (!line) continue;
    run.lines++;

    // ── renderer `[backseat/eval]` ────────────────────────────────────────
    const markAt = line.indexOf(RENDERER_MARK);
    if (markAt >= 0) {
      run.capture.present = true;
      const ts = ANY_TS.exec(line.slice(0, markAt));
      const todSec = ts ? todOf(ts[1], ts[2], ts[3], ts[4]) : null;
      if (todSec != null) {
        run.capture.timestamps = true;
        if (run.capture.originTodSec == null) run.capture.originTodSec = todSec;
        run.capture.endTodSec = todSec;
      }
      const kv = parseKv(line.slice(markAt + RENDERER_MARK.length));
      const c = run.capture;

      if (kv.activity) {
        c.states.push({
          activity: kv.activity,
          confidence: kv.confidence != null ? Number(kv.confidence) : null,
          policy: kv.policy ?? null,
          fallback: kv.fallback ?? null,
          todSec,
          seq: seq++,
        });
      } else if (kv.from && kv.to) {
        c.switches.push({ from: kv.from, to: kv.to, todSec, seq: seq++ });
      } else if (kv.tick_count != null) {
        const n = Number(kv.tick_count);
        if (Number.isFinite(n)) c.tickCount = Math.max(c.tickCount, n);
        c.tickLines++;
        const kind = kv.kind ?? 'unknown';
        c.ticksByKind[kind] = (c.ticksByKind[kind] ?? 0) + 1;
        if (kv.policy) c.ticksByPolicy[kv.policy] = (c.ticksByPolicy[kv.policy] ?? 0) + 1;
        seq++;
      } else if (kv.sample_count != null) {
        const n = Number(kv.sample_count);
        if (Number.isFinite(n)) {
          if (c.sampleCountFirst == null) c.sampleCountFirst = n;
          c.sampleCountLast = c.sampleCountLast == null ? n : Math.max(c.sampleCountLast, n);
        }
        const rate = Number(kv.sample_rate);
        if (Number.isFinite(rate)) c.sampleRates.push(rate);
        if (kv.policy) {
          c.sampleReadingsByPolicy[kv.policy] = (c.sampleReadingsByPolicy[kv.policy] ?? 0) + 1;
        }
        seq++;
      } else if (kv.idle_delay_ms != null) {
        const n = Number(kv.idle_delay_ms);
        if (Number.isFinite(n)) c.idleDelays.push(n);
        seq++;
      }
      continue;
    }

    // ── main log line: optional UTC stamp, then `[backseat] message` ──────
    let msg = line;
    let todSec = null;
    const mt = MAIN_TS.exec(msg);
    if (mt) {
      todSec = todOf(mt[1], mt[2], mt[3], mt[4]);
      msg = msg.slice(mt[0].length).trim();
    }
    const mark = msg.indexOf('[backseat]');
    if (mark >= 0) msg = msg.slice(mark + '[backseat]'.length).trim();

    if (run.startTodSec == null) run.startTodSec = todSec;
    if (todSec != null) run.endTodSec = todSec;

    // session start: keep ONLY source_kind. The pre-patch form also embedded
    // `source="<window title>"`; that is exactly what must not be carried here.
    if (/^session start\b/.test(msg)) {
      if (/source_kind=screen\b/.test(msg)) run.sourceKind = 'screen';
      else if (/source_kind=window\b/.test(msg)) run.sourceKind = 'window';
      else if (/source="screen:/.test(msg)) run.sourceKind = 'screen';
      else if (/source="/.test(msg)) run.sourceKind = 'window';
      seq++;
      continue;
    }

    // The app's own session counter, kept only to cross-check that the log and
    // the console paste really came from the same session.
    const endHit = /^session end: (\d+)s\b/.exec(msg);
    if (endHit) {
      run.reportedSessionSec = Number(endHit[1]);
      seq++;
      continue;
    }

    const m = run.model;
    let hit = null;

    if ((hit = /^\[eval\] awake_count=(\d+)/.exec(msg))) {
      m.present = true;
      m.awakeCount = Math.max(m.awakeCount, Number(hit[1]));
    } else if ((hit = /^\[eval\] model_call_count=(\d+)/.exec(msg))) {
      m.present = true;
      m.callCount = Math.max(m.callCount, Number(hit[1]));
    } else if ((hit = /^\[eval\] model_latency_ms=(\d+) kind=(\w+) aborted=(\w+)/.exec(msg))) {
      m.present = true;
      m.latencies.push(Number(hit[1]));
      if (hit[3] === 'true') m.aborted++;
    } else if ((hit = /^turn (\w+): in=(\d+) cacheRead=(\d+) cacheWrite=(\d+)/.exec(msg))) {
      m.present = true;
      m.tokens.in += Number(hit[2]);
      m.tokens.cacheRead += Number(hit[3]);
      m.tokens.cacheWrite += Number(hit[4]);
      m.tokens.lines++;
    } else if ((hit = /^turn (\w+): said (\d+) line\(s\)/.exec(msg))) {
      m.present = true;
      const kind = hit[1];
      m.turnsByKind[kind] = (m.turnsByKind[kind] ?? 0) + 1;
      m.said.push({
        kind,
        lines: Number(hit[2]),
        todSec,
        offsetSec: null,
        seq: seq++,
      });
      continue;
    } else if (/^turn failed\b/.test(msg)) {
      m.present = true;
      m.failed++;
    } else if (/^turn \w+: note leak dropped\b/.test(msg)) {
      m.present = true;
      m.noteLeakDropped++;
    } else if ((hit = /^tick \w+ dropped \(([^)]*)\)/.exec(msg))) {
      m.present = true;
      const reason = hit[1].replace(/\d+(\.\d+)?/g, 'N');
      m.droppedByReason[reason] = (m.droppedByReason[reason] ?? 0) + 1;
    } else if (/^tick \w+ (?:-> turn|preempts in-flight)/.test(msg)) {
      m.present = true;
    }
    seq++;
  }

  // ── derived ──────────────────────────────────────────────────────────────
  const c = run.capture;

  // Two independent time origins on purpose (see `capture.originTodSec`).
  const capOrigin = c.originTodSec;
  for (const s of c.states) s.offsetSec = offsetSec(s.todSec, capOrigin);
  for (const s of c.switches) s.offsetSec = offsetSec(s.todSec, capOrigin);
  // Spoken turns are main-side, so they align with the main log's UTC origin —
  // which is also what absolute-time annotations are converted against.
  for (const s of run.model.said) s.offsetSec = offsetSec(s.todSec, run.startTodSec);

  c.durationSec = offsetSec(c.endTodSec, capOrigin);

  if (c.states.length && c.states.every((s) => s.offsetSec != null)) {
    // The renderer logs a state line only when it CHANGES, so consecutive lines
    // bound the interval the previous state was in force.
    let under = { baseline: 0, long_video: 0 };
    for (let i = 0; i < c.states.length; i++) {
      const from = c.states[i].offsetSec;
      const to = i + 1 < c.states.length ? c.states[i + 1].offsetSec : c.durationSec;
      if (to == null || to < from) continue;
      if (c.states[i].policy === 'long_video') under.long_video += to - from;
      else if (c.states[i].policy === 'baseline') under.baseline += to - from;
    }
    c.secUnderPolicy = under;
  }

  run.sessionDurationSec = offsetSec(run.endTodSec, run.startTodSec);

  if (c.sampleCountFirst != null && c.sampleCountLast != null) {
    c.sampleCountDelta = c.sampleCountLast - c.sampleCountFirst;
  }

  // ── sanity warnings (each one is a way the run can be unreadable) ───────
  if (!c.present) {
    run.warnings.push(
      'no [backseat/eval] lines: capture-side metrics are missing. Copy the renderer DevTools console (enable "Show timestamps" first) into the same file as the main log.',
    );
  } else if (!c.timestamps && (c.states.length || c.tickLines)) {
    run.warnings.push(
      'capture lines carry no timestamps: policy timing and annotation matching are unavailable; only exact counters are reported.',
    );
  }
  if (!run.model.present) {
    run.warnings.push(
      'no [eval]/turn lines: the main session log is missing or predates the prototype build.',
    );
  }
  if (c.tickLines && c.tickCount && c.tickLines !== c.tickCount) {
    run.warnings.push(
      `tick lines (${c.tickLines}) != last tick_count (${c.tickCount}): the renderer paste is probably truncated, so per-policy tick counts under-count.`,
    );
  }
  if (run.sourceKind === 'screen') {
    run.warnings.push(
      'source_kind=screen: whole-screen shares fall back by design, so this run cannot test the prototype.',
    );
  }
  if (c.timestamps && capOrigin != null && run.startTodSec != null) {
    // Minimal signed difference, wrapped to +/-12 h. A whole-timezone offset is
    // NORMAL here (log is UTC, DevTools is local), so it is reported as context
    // rather than a warning; only a non-timezone difference means the two files
    // probably came from different sessions.
    let d = capOrigin - run.startTodSec;
    d = ((((d + 43_200) % 86_400) + 86_400) % 86_400) - 43_200;
    run.clockDeltaSec = d;
    const offMinutes = d / 60;
    const onQuarterHour = Math.abs(offMinutes - Math.round(offMinutes / 15) * 15) < 1;
    if (Math.abs(d) > 900 && !onQuarterHour) {
      run.warnings.push(
        `first capture line and first log line differ by ${offMinutes.toFixed(1)} min, which is not a timezone offset: the console paste and the log are probably not from the same session.`,
      );
    }
  }
  if (run.reportedSessionSec != null && run.sessionDurationSec != null) {
    const diff = Math.abs(run.reportedSessionSec - run.sessionDurationSec);
    if (diff > 30) {
      run.warnings.push(
        `session end reports ${run.reportedSessionSec}s but the log stamps span ${run.sessionDurationSec.toFixed(1)}s: the log may be truncated or from another session.`,
      );
    }
  }
  if (c.present && c.timestamps && c.durationSec != null && run.sessionDurationSec) {
    const coverage = c.durationSec / run.sessionDurationSec;
    if (coverage < 0.8) {
      run.warnings.push(
        `capture lines cover only ${(coverage * 100).toFixed(0)}% of the session (${c.durationSec.toFixed(0)}s of ${run.sessionDurationSec.toFixed(0)}s): save the DevTools console at the END of the session, because per-policy timing is incomplete for the uncovered part.`,
      );
    }
  }
  if (c.states.some((s) => s.fallback === 'flag_disabled')) {
    run.warnings.push('saw fallback=flag_disabled: the localStorage flag was off for this run.');
  } else if (c.present && c.states.length && !c.states.some((s) => s.activity === 'long_video')) {
    // The flag was on (no state reported flag_disabled) yet the rule never
    // matched, so the prototype policy never engaged. This run is baseline in
    // effect, and comparing it against a baseline run proves nothing. Not
    // hypothetical: a bilibili share does exactly this, because the service
    // list has no Chinese platform and bilibili titles carry no long-form cue.
    run.warnings.push(
      'the flag was on but activity never reached long_video: the prototype policy never engaged, so this run is baseline in effect and cannot be compared against a baseline run. Check that the shared window is a video page whose title the rule accepts (see docs/backseat-activity-mvp.md).',
    );
  }
  if (run.model.tokens.lines > 0) {
    run.warnings.push(
      'output tokens are not logged by the prototype (only in=/cacheRead=/cacheWrite=), so output cost per run cannot be computed from logs.',
    );
  }

  return run;
}

/** Exact counters that do not depend on any timestamp. */
export function exactCounters(run) {
  const c = run.capture;
  const m = run.model;
  const calls = m.callCount;
  const inferredSilent = Math.max(0, calls - m.said.length - m.failed - m.aborted);
  return {
    sampleCount: c.sampleCountLast,
    sampleCountDelta: c.sampleCountDelta ?? null,
    tickCount: c.tickCount || null,
    awakeCount: m.awakeCount,
    modelCalls: calls,
    saidTurns: m.said.length,
    saidLines: m.said.reduce((a, s) => a + s.lines, 0),
    inferredSilentTurns: inferredSilent,
    failedTurns: m.failed,
    abortedCalls: m.aborted,
    awakeWithoutCall: Math.max(0, m.awakeCount - calls),
  };
}

/** Latency and token aggregates. */
export function costSummary(run) {
  const m = run.model;
  return {
    calls: m.callCount,
    latencyMeanMs: m.latencies.length
      ? Math.round(m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length)
      : null,
    latencyP50Ms: percentile(m.latencies, 50),
    latencyP90Ms: percentile(m.latencies, 90),
    latencyMaxMs: m.latencies.length ? Math.max(...m.latencies) : null,
    inputTokens: m.tokens.in,
    cacheReadTokens: m.tokens.cacheRead,
    cacheWriteTokens: m.tokens.cacheWrite,
    outputTokens: m.outputTokens, // null: not logged
  };
}

/** Gaps between consecutive spoken turns, as a repetition/duplication proxy. */
export function commentGaps(run) {
  const offsets = run.model.said.map((s) => s.offsetSec).filter((x) => x != null);
  if (offsets.length < 2) return { available: offsets.length === 1 ? 0 : null, gaps: [] };
  const gaps = [];
  for (let i = 1; i < offsets.length; i++) gaps.push(offsets[i] - offsets[i - 1]);
  return { available: gaps.length, gaps, belowFloor: gaps.filter((g) => g * 1000 < MIN_SPEAK_GAP_MS).length };
}

function fmt(n, digits = 0) {
  return n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);
}

/** `HH:MM:SS.mmm` for an origin stamp. */
export function fmtTod(todSec) {
  if (todSec == null || !Number.isFinite(todSec)) return 'n/a';
  const s = Math.floor(todSec);
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const ms = Math.round((todSec - Math.floor(todSec)) * 1000);
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(ss)}.${pad(ms, 3)}`;
}

/** `+MM:SS` / `+H:MM:SS` — the annotation form that avoids the UTC trap. */
export function fmtOffset(sec) {
  if (sec == null || !Number.isFinite(sec)) return 'n/a';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `+${h}:${pad(m)}:${pad(ss)}` : `+${pad(m)}:${pad(ss)}`;
}

/** Human report for one run. */
export function formatReport(run) {
  const c = run.capture;
  const e = exactCounters(run);
  const cost = costSummary(run);
  const gaps = commentGaps(run);
  const L = [];
  L.push(`── ${run.label} ──`);
  L.push(
    `source_kind=${run.sourceKind ?? 'unknown'}  session_duration=${fmt(run.sessionDurationSec, 1)}s  log_lines=${run.lines}`,
  );

  L.push('capture (renderer DevTools)');
  if (!c.present) L.push('  missing');
  else {
    L.push(
      `  states=${c.states.length}  policy_switches=${c.switches.length}  capture_span=${fmt(c.durationSec, 1)}s  ticks=${e.tickCount ?? 'n/a'}  jpeg_encodes_total=${e.sampleCount ?? 'n/a'}` +
        (e.sampleCountDelta != null ? ` (window delta ${e.sampleCountDelta})` : ''),
    );
    if (Object.keys(c.ticksByPolicy).length) {
      L.push(`  ticks_by_policy=${JSON.stringify(c.ticksByPolicy)}`);
    }
    if (c.originTodSec != null && run.startTodSec != null) {
      L.push(
        `  clocks: log_origin(UTC)=${fmtTod(run.startTodSec)} capture_origin(local,DevTools)=${fmtTod(c.originTodSec)} delta=${fmt((run.clockDeltaSec ?? 0) / 3600, 1)}h — each block is measured from its own first line, so do not compare a capture offset with a spoken-turn offset`,
      );
    }
    if (Object.keys(c.ticksByKind).length) {
      L.push(`  ticks_by_kind=${JSON.stringify(c.ticksByKind)}`);
    }
    if (c.sampleRates.length) {
      L.push(
        `  sample_rate readings: n=${c.sampleRates.length} median=${fmt(median(c.sampleRates), 1)}/s min=${fmt(Math.min(...c.sampleRates), 1)} max=${fmt(Math.max(...c.sampleRates), 1)}`,
      );
    }
    if (c.idleDelays.length) {
      L.push(
        `  idle_delay_ms: n=${c.idleDelays.length} median=${fmt(median(c.idleDelays))} mean=${fmt(c.idleDelays.reduce((a, b) => a + b, 0) / c.idleDelays.length)} min=${Math.min(...c.idleDelays)} max=${Math.max(...c.idleDelays)}`,
      );
      L.push(
        `    expected: baseline ~${BASELINE_POLICY.idleMeanMs / 1000}s (${BASELINE_POLICY.idleMinMs / 1000}-${BASELINE_POLICY.idleMaxMs / 1000}s) | long_video ~${LONG_VIDEO_POLICY.idleMeanMs / 1000}s (${LONG_VIDEO_POLICY.idleMinMs / 1000}-${LONG_VIDEO_POLICY.idleMaxMs / 1000}s)`,
      );
    }
    if (c.secUnderPolicy) {
      L.push(
        `  seconds_in_policy: baseline=${fmt(c.secUnderPolicy.baseline, 1)} long_video=${fmt(c.secUnderPolicy.long_video, 1)}`,
      );
    }
    for (const s of c.states) {
      L.push(
        `  ${s.offsetSec != null ? fmtOffset(s.offsetSec) : '(no ts)'} activity=${s.activity} confidence=${s.confidence} policy=${s.policy} fallback=${s.fallback}`,
      );
    }
    for (const s of c.switches) {
      L.push(`  ${s.offsetSec != null ? fmtOffset(s.offsetSec) : '(no ts)'} switch ${s.from} -> ${s.to}`);
    }
  }

  L.push('model (session log)');
  if (!run.model.present) L.push('  missing');
  else {
    L.push(
      `  awake=${e.awakeCount} turns_run=${e.modelCalls} awake_without_call=${e.awakeWithoutCall} failed=${e.failedTurns} aborted=${e.abortedCalls}`,
    );
    L.push(
      `  spoke=${e.saidTurns} turn(s)/${e.saidLines} line(s)  silence_inferred=${e.inferredSilentTurns}  note_leaks_dropped=${run.model.noteLeakDropped}`,
    );
    if (Object.keys(run.model.droppedByReason).length) {
      L.push(`  dropped_ticks=${JSON.stringify(run.model.droppedByReason)}`);
    }
    L.push(
      `  latency_ms: p50=${fmt(cost.latencyP50Ms)} p90=${fmt(cost.latencyP90Ms)} mean=${fmt(cost.latencyMeanMs)} max=${fmt(cost.latencyMaxMs)}`,
    );
    L.push(
      `  tokens: in=${cost.inputTokens} cacheRead=${cost.cacheReadTokens} cacheWrite=${cost.cacheWriteTokens} output=${cost.outputTokens == null ? 'NOT LOGGED' : cost.outputTokens}`,
    );
    if (gaps.available) {
      L.push(
        `  gaps between spoken turns (s): median=${fmt(median(gaps.gaps), 1)} min=${fmt(Math.min(...gaps.gaps), 1)} max=${fmt(Math.max(...gaps.gaps), 1)} below_min_speak_gap=${gaps.belowFloor}`,
      );
    }
  }

  if (run.warnings.length) {
    L.push('warnings');
    for (const w of run.warnings) L.push(`  ! ${w}`);
  }
  return L.join('\n');
}

/** Side-by-side comparison. Refuses to imply quality from volume alone. */
export function formatCompare(a, b) {
  const rows = [
    ['source_kind', (r) => r.sourceKind ?? 'unknown'],
    ['session_duration_s', (r) => fmt(r.sessionDurationSec, 1)],
    ['policy_switches', (r) => r.capture.switches.length],
    ['ticks', (r) => exactCounters(r).tickCount ?? 'n/a'],
    ['jpeg_encodes_total', (r) => exactCounters(r).sampleCount ?? 'n/a'],
    ['jpeg_encodes_window', (r) => exactCounters(r).sampleCountDelta ?? 'n/a'],
    ['sample_rate_median', (r) => fmt(median(r.capture.sampleRates), 1)],
    ['idle_delay_median_ms', (r) => fmt(median(r.capture.idleDelays))],
    ['awake', (r) => exactCounters(r).awakeCount],
    ['model_calls', (r) => exactCounters(r).modelCalls],
    ['spoke_turns', (r) => exactCounters(r).saidTurns],
    ['said_lines', (r) => exactCounters(r).saidLines],
    ['silence_inferred', (r) => exactCounters(r).inferredSilentTurns],
    ['latency_p50_ms', (r) => fmt(costSummary(r).latencyP50Ms)],
    ['latency_p90_ms', (r) => fmt(costSummary(r).latencyP90Ms)],
    ['input_tokens', (r) => costSummary(r).inputTokens],
    ['cacheRead_tokens', (r) => costSummary(r).cacheReadTokens],
    ['cacheWrite_tokens', (r) => costSummary(r).cacheWriteTokens],
    ['output_tokens', (r) => 'not logged'],
  ];
  const w = 22;
  const L = [];
  L.push(`${''.padEnd(w)}${String(a.label).padEnd(16)}${String(b.label).padEnd(16)}`);
  for (const [name, get] of rows) {
    L.push(`${name.padEnd(w)}${String(get(a)).padEnd(16)}${String(get(b)).padEnd(16)}`);
  }
  L.push('');
  L.push('A lower model-call count is NOT evidence of better behavior. Judge it only');
  L.push('against the annotated comment-worthy / keep-silent moments below.');
  return L.join('\n');
}

// ── annotation matching ────────────────────────────────────────────────────

/** `"+MM:SS"`, `"+H:MM:SS"`, `"MM:SS"`-style absolute, or a number of seconds. */
export function parseMomentTime(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return { offsetSec: at, absolute: false };
  const s = String(at ?? '').trim();
  const rel = /^\+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (rel) {
    const a = Number(rel[1]);
    const b = Number(rel[2]);
    const c2 = rel[3] != null ? Number(rel[3]) : null;
    // `+MM:SS` unless three groups, where it is `+H:MM:SS`.
    return c2 == null
      ? { offsetSec: a * 60 + b, absolute: false }
      : { offsetSec: a * 3600 + b * 60 + c2, absolute: false };
  }
  const abs = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (abs) {
    const a = Number(abs[1]);
    const b = Number(abs[2]);
    const c2 = abs[3] != null ? Number(abs[3]) : null;
    const todSec = c2 == null ? a * 60 + b : a * 3600 + b * 60 + c2;
    return { todSec, absolute: true };
  }
  return null;
}

/**
 * Convert an absolute annotation time-of-day to a session offset.
 * `clock: 'local'` means the annotation was written from the wall clock while
 * the log stamps are UTC, so the machine's offset at the session instant is
 * subtracted. `clock: 'utc'` compares directly against the log stamps.
 */
export function absoluteToOffsetSec(annTodSec, { startTodSec, tzOffsetMin = 0, clock = 'local' }) {
  if (annTodSec == null || startTodSec == null) return null;
  const utcTodSec = clock === 'local' ? annTodSec - tzOffsetMin * 60 : annTodSec;
  return offsetSec(((utcTodSec % 86_400) + 86_400) % 86_400, startTodSec);
}

/**
 * Match annotated moments against what the character actually said.
 *
 * expect: 'comment' -> a spoken turn should land within toleranceSec
 * expect: 'silent'  -> nothing should be said within toleranceSec
 *
 * Returns per-moment verdicts plus "extra" spoken turns that match no
 * comment-worthy moment. The verdicts are mechanical alignment, not a judgement
 * of whether a comment was GOOD — that stays with the reviewer.
 */
export function alignAnnotations(run, annotation, { tzOffsetMin = 0 } = {}) {
  const moments = Array.isArray(annotation?.moments) ? annotation.moments : [];
  const defaultTol = Number(annotation?.toleranceSec ?? 20);
  const clock = annotation?.clock === 'utc' ? 'utc' : 'local';
  const said = run.model.said
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => s.offsetSec != null);
  // Without timestamps on the spoken turns nothing can be matched. Saying
  // "missed" there would be a fabricated finding, so every moment is reported
  // unresolved instead.
  const timingAvailable = run.model.said.length === 0 || said.length === run.model.said.length;

  const resolved = moments.map((mo, i) => {
    const t = parseMomentTime(mo.at);
    let offset = null;
    if (t && !t.absolute) offset = t.offsetSec;
    else if (t && t.absolute) {
      offset = absoluteToOffsetSec(t.todSec, { startTodSec: run.startTodSec, tzOffsetMin, clock });
    }
    return {
      index: i,
      at: mo.at,
      // Anything that is not an explicit 'comment'/'silent' is SKIPPED, never
      // coerced to 'comment'. A pre-filled template must not score itself.
      expect: mo.expect === 'silent' ? 'silent' : mo.expect === 'comment' ? 'comment' : 'skip',
      note: mo.note ?? '',
      toleranceSec: Number(mo.toleranceSec ?? defaultTol),
      offsetSec: offset,
    };
  });

  const verdicts = resolved.map((mo) => {
    if (mo.expect === 'skip') {
      return { ...mo, verdict: 'skipped', matched: null, deltaSec: null };
    }
    if (!timingAvailable || mo.offsetSec == null) {
      return { ...mo, verdict: 'unresolved', matched: null, deltaSec: null };
    }
    const within = said.filter((s) => Math.abs(s.offsetSec - mo.offsetSec) <= mo.toleranceSec);
    const nearest = said.length
      ? said.reduce((best, s) =>
          Math.abs(s.offsetSec - mo.offsetSec) < Math.abs(best.offsetSec - mo.offsetSec) ? s : best,
        )
      : null;
    const nearestDelta = nearest ? nearest.offsetSec - mo.offsetSec : null;

    if (mo.expect === 'silent') {
      return {
        ...mo,
        verdict: within.length ? 'interrupted' : 'respected',
        matched: within[0] ?? null,
        deltaSec: within.length ? within[0].offsetSec - mo.offsetSec : null,
      };
    }
    if (within.length) {
      const first = within.reduce((a, b) => (a.offsetSec <= b.offsetSec ? a : b));
      return { ...mo, verdict: 'on_time', matched: first, deltaSec: first.offsetSec - mo.offsetSec };
    }
    if (nearestDelta != null && nearestDelta >= 0 && nearestDelta <= mo.toleranceSec * 3) {
      return { ...mo, verdict: 'late', matched: nearest, deltaSec: nearestDelta };
    }
    return { ...mo, verdict: 'missed', matched: nearest, deltaSec: nearestDelta };
  });

  const claimed = new Set();
  for (const v of verdicts) {
    if (!v.matched) continue;
    if (v.expect === 'comment' && (v.verdict === 'on_time' || v.verdict === 'late')) {
      claimed.add(v.matched.index);
    }
  }
  const extras = timingAvailable ? said.filter((s) => !claimed.has(s.index)) : [];

  const counts = {
    on_time: verdicts.filter((v) => v.verdict === 'on_time').length,
    late: verdicts.filter((v) => v.verdict === 'late').length,
    missed: verdicts.filter((v) => v.verdict === 'missed').length,
    interrupted: verdicts.filter((v) => v.verdict === 'interrupted').length,
    respected: verdicts.filter((v) => v.verdict === 'respected').length,
    unresolved: verdicts.filter((v) => v.verdict === 'unresolved').length,
    skipped: verdicts.filter((v) => v.verdict === 'skipped').length,
    extra_comments: extras.length,
    annotated: verdicts.length,
  };
  counts.scored = counts.on_time + counts.late + counts.missed + counts.interrupted + counts.respected;

  const note = annotation?.interruptionRating != null ? ` subjective_interruption=${annotation.interruptionRating}` : '';

  return { verdicts, extras, counts, toleranceSec: defaultTol, clock, timingAvailable, note };
}

export function formatAlignment(run, alignment) {
  const L = [];
  L.push(`annotation alignment for ${run.label} (tolerance ${alignment.toleranceSec}s, clock=${alignment.clock})`);
  for (const v of alignment.verdicts) {
    const at = v.offsetSec != null ? fmtOffset(v.offsetSec) : `?${v.at}`;
    const d = v.deltaSec != null ? ` (${v.deltaSec >= 0 ? '+' : ''}${v.deltaSec.toFixed(1)}s)` : '';
    L.push(`  ${at} expect=${v.expect} -> ${v.verdict}${d}${v.note ? `  [${v.note}]` : ''}`);
  }
  const c = alignment.counts;
  L.push(
    `  counts: annotated=${c.annotated} scored=${c.scored} on_time=${c.on_time} late=${c.late} missed=${c.missed} interrupted=${c.interrupted} respected=${c.respected} extra_comments=${c.extra_comments} skipped=${c.skipped} unresolved=${c.unresolved}${alignment.note}`,
  );
  if (c.unresolved) {
    L.push(
      '  ! unresolved moments: every verdict is unknown for this run — enable DevTools timestamps so the spoken turns carry times.',
    );
  }
  if (alignment.extras.length) {
    L.push(
      `  extra spoken turns with no annotated moment nearby: ${alignment.extras.map((s) => fmtOffset(s.offsetSec)).join(', ')}`,
    );
  }
  if (c.scored === 0) {
    L.push('  ! nothing was scored: fill in expect="comment" or "silent" on the moments you care about.');
  }
  return L.join('\n');
}
