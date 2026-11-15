import { describe, expect, it } from 'vitest';
import {
  alignAnnotations,
  absoluteToOffsetSec,
  commentGaps,
  costSummary,
  exactCounters,
  formatAlignment,
  formatCompare,
  formatReport,
  offsetSec,
  parseKv,
  parseMomentTime,
  parseRun,
  pickNewestLog,
} from './activityEval.mjs';

/**
 * Fixtures mirror the real shapes: `[HH:MM:SS.mmm] [backseat] ...` from
 * <userData>/logs/backseat-*.log, and DevTools-prefixed `[backseat/eval]` lines
 * that in reality exist only in the renderer console.
 */
const MAIN = [
  '[09:50:58.165] [backseat] session start: mode=comment, source_kind=window',
  '[09:51:02.000] [backseat] tick start -> turn',
  '[09:51:02.100] [backseat] [eval] awake_count=1 kind=start',
  '[09:51:02.120] [backseat] [eval] model_call_count=1 kind=start',
  '[09:51:03.400] [backseat] [eval] model_latency_ms=1280 kind=start aborted=false',
  '[09:51:03.500] [backseat] turn start: in=1200 cacheRead=0 cacheWrite=1100',
  '[09:51:03.600] [backseat] turn start: said 2 line(s)',
  '[09:52:10.000] [backseat] tick idle dropped (spoke 12.0s ago)',
  '[09:53:00.000] [backseat] tick jolt -> turn',
  '[09:53:00.100] [backseat] [eval] awake_count=2 kind=jolt',
  '[09:53:00.200] [backseat] [eval] model_call_count=2 kind=jolt',
  '[09:53:01.000] [backseat] [eval] model_latency_ms=800 kind=jolt aborted=false',
  '[09:53:01.100] [backseat] turn jolt: in=1300 cacheRead=1100 cacheWrite=20',
  '[09:53:01.200] [backseat] turn jolt: said 1 line(s)',
  '[09:54:00.000] [backseat] tick idle -> turn',
  '[09:54:00.100] [backseat] [eval] awake_count=3 kind=idle',
  '[09:54:00.200] [backseat] [eval] model_call_count=3 kind=idle',
  '[09:54:01.000] [backseat] [eval] model_latency_ms=700 kind=idle aborted=false',
  '[09:54:01.100] [backseat] turn idle: in=1400 cacheRead=1120 cacheWrite=0',
  '[09:54:01.200] [backseat] turn idle: note leak dropped',
  '[09:54:01.300] [backseat] session end: 183s, 3 line(s) said',
].join('\n');

const RENDERER_UTC = [
  '[09:50:59.000] captureController.ts:470 [backseat/eval] activity=long_video confidence=0.8 policy=long_video fallback=none',
  '[09:50:59.100] captureController.ts:471 [backseat/eval] policy_switch from=baseline to=long_video',
  '[09:51:02.000] captureController.ts:665 [backseat/eval] tick_count=1 kind=start policy=long_video',
  '[09:51:12.000] captureController.ts:722 [backseat/eval] sample_count=104 sample_rate=8 policy=long_video',
  '[09:52:12.000] captureController.ts:722 [backseat/eval] sample_count=584 sample_rate=8 policy=long_video',
  '[09:52:30.000] captureController.ts:812 [backseat/eval] idle_delay_ms=15000 policy=long_video',
].join('\n');

const RUN = `${MAIN}\n${RENDERER_UTC}`;

describe('parseRun', () => {
  it('reads both sources and keeps their independent time origins', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    expect(run.sourceKind).toBe('window');
    expect(run.model.present).toBe(true);
    expect(run.capture.present).toBe(true);
    expect(run.capture.timestamps).toBe(true);
    // Log stamps are UTC and DevTools stamps are local; here they coincide, so
    // no clock-mismatch warning and both origins are within a second.
    expect(run.warnings.some((w) => w.includes('clocks differ'))).toBe(false);
    expect(run.sessionDurationSec).toBeCloseTo(183.135, 3);
    expect(run.capture.durationSec).toBeCloseTo(91, 3);
  });

  it('counts exact volume, silence by subtraction, and per-policy ticks', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    expect(exactCounters(run)).toMatchObject({
      sampleCount: 584,
      sampleCountDelta: 480,
      tickCount: 1,
      awakeCount: 3,
      modelCalls: 3,
      saidTurns: 2,
      saidLines: 3,
      inferredSilentTurns: 1, // 3 calls - 2 spoke - 0 failed - 0 aborted
      awakeWithoutCall: 0,
    });
    expect(run.capture.ticksByPolicy).toEqual({ long_video: 1 });
    expect(run.capture.ticksByKind).toEqual({ start: 1 });
    expect(run.model.droppedByReason).toEqual({ 'spoke Ns ago': 1 });
  });

  it('aggregates tokens, latency and gaps without inventing output tokens', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    const cost = costSummary(run);
    expect(cost).toMatchObject({
      calls: 3,
      latencyMeanMs: 927,
      latencyP50Ms: 800,
      latencyP90Ms: 1280,
      latencyMaxMs: 1280,
      inputTokens: 3900,
      cacheReadTokens: 2220,
      cacheWriteTokens: 1120,
      outputTokens: null,
    });
    expect(run.warnings.some((w) => w.includes('output tokens are not logged'))).toBe(true);
    const gaps = commentGaps(run);
    expect(gaps.available).toBe(1);
    expect(gaps.gaps[0]).toBeCloseTo(117.6, 1);
    expect(gaps.belowFloor).toBe(0);
  });

  it('measures capture offsets from the capture origin, not the UTC log origin', () => {
    // Renderer in local time (UTC+8) against a UTC log: the classic trap.
    const local = RENDERER_UTC.replace(/\[09:/g, '[17:');
    const run = parseRun(`${MAIN}\n${local}`, { label: 'tz' });
    // A whole-timezone difference is NORMAL, so it is context, not a warning.
    expect(Math.abs(run.clockDeltaSec - 28_800)).toBeLessThan(2);
    expect(run.warnings.some((w) => w.includes('clocks differ'))).toBe(false);
    expect(formatReport(run)).toContain('capture_origin(local,DevTools)');
    const first = run.capture.states[0];
    expect(first.offsetSec).toBe(0); // origin is the first renderer line, not 09:50:58Z
    expect(run.capture.switches[0].offsetSec).toBeCloseTo(0.1, 3);
  });

  it('warns when the two files are not even from the same session', () => {
    // 39 minutes apart: not a whole timezone offset.
    const local = RENDERER_UTC.replace('[09:50:59.000]', '[10:27:59.000]');
    const run = parseRun(`${MAIN}\n${local}`, { label: 'mismatch' });
    expect(run.warnings.some((w) => w.includes('not from the same session'))).toBe(true);
  });

  it('cross-checks the session counter and the capture coverage', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    expect(run.reportedSessionSec).toBe(183);
    expect(run.warnings.some((w) => w.includes('log may be truncated'))).toBe(false);

    const truncatedLog = MAIN.replace('session end: 183s', 'session end: 900s');
    expect(
      parseRun(`${truncatedLog}\n${RENDERER_UTC}`, { label: 't' }).warnings.some((w) =>
        w.includes('log may be truncated'),
      ),
    ).toBe(true);

    // Capture console saved 10s into a 183s session.
    const early = RENDERER_UTC.split('\n').slice(0, 3).join('\n');
    expect(
      parseRun(`${MAIN}\n${early}`, { label: 'e' }).warnings.some((w) => w.includes('cover only')),
    ).toBe(true);
  });

  it('reports time under each policy from change-only state lines', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    expect(run.capture.secUnderPolicy.long_video).toBeCloseTo(91, 3);
    expect(run.capture.secUnderPolicy.baseline).toBeCloseTo(0, 3);
  });

  it('flags whole-screen shares, a disabled flag, and missing halves', () => {
    const screen = parseRun('[09:00:00.000] [backseat] session start: mode=comment, source_kind=screen', {
      label: 'screen',
    });
    expect(screen.sourceKind).toBe('screen');
    expect(screen.warnings.some((w) => w.includes('whole-screen'))).toBe(true);

    const off = parseRun(
      '[09:00:00.000] [backseat] session start: mode=comment, source_kind=window\n' +
        '[09:00:01.000] [backseat/eval] activity=unknown confidence=0.2 policy=baseline fallback=flag_disabled',
      { label: 'off' },
    );
    expect(off.warnings.some((w) => w.includes('flag_disabled'))).toBe(true);

    const logOnly = parseRun(MAIN, { label: 'log-only' });
    expect(logOnly.warnings.some((w) => w.includes('no [backseat/eval] lines'))).toBe(true);
    const pasteOnly = parseRun(RENDERER_UTC, { label: 'paste-only' });
    expect(pasteOnly.warnings.some((w) => w.includes('no [eval]/turn lines'))).toBe(true);
  });

  it('warns when the paste is truncated relative to the tick counter', () => {
    const truncated = RENDERER_UTC.replace(/^\[09:52:12.*\n/m, '').replace(
      'tick_count=1 kind=start policy=long_video',
      'tick_count=9 kind=start policy=long_video',
    );
    const run = parseRun(`${MAIN}\n${truncated}`, { label: 'truncated' });
    expect(run.warnings.some((w) => w.includes('probably truncated'))).toBe(true);
  });

  it('warns when the flag was on but the rule never matched (null candidate run)', () => {
    // Real shape from a Chrome window on a bilibili video page: the title has
    // 哔哩哔哩_bilibili, but no name in the rule's service list and no long-form
    // cue, so the classifier returns unknown/0.2 and the policy never engages.
    const flagOnButUnknown = RENDERER_UTC.replace(
      'activity=long_video confidence=0.8 policy=long_video fallback=none',
      'activity=unknown confidence=0.2 policy=baseline fallback=insufficient_metadata',
    ).replace(/^\[09:50:59\.100.*\n/m, '');
    const run = parseRun(`${MAIN}\n${flagOnButUnknown}`, { label: 'candidate' });
    expect(run.warnings.some((w) => w.includes('never reached long_video'))).toBe(true);

    // A genuine baseline run (flag off) must NOT get this warning: having no
    // long_video state is exactly what it is supposed to look like.
    const off = parseRun(
      '[09:00:00.000] [backseat] session start: mode=comment, source_kind=window\n' +
        '[09:00:01.000] [backseat/eval] activity=unknown confidence=0.2 policy=baseline fallback=flag_disabled',
      { label: 'baseline' },
    );
    expect(off.warnings.some((w) => w.includes('never reached long_video'))).toBe(false);

    // And a run where the policy really engaged must not warn either.
    expect(parseRun(RUN, { label: 'ok' }).warnings.some((w) => w.includes('never reached long_video'))).toBe(
      false,
    );
  });

  it('never carries a window title through, including from pre-patch logs', () => {
    const legacy =
      '[09:50:58.165] [backseat] session start: mode=comment, source="Secret Movie Title (2024) - YouTube"';
    const run = parseRun(legacy, { label: 'legacy' });
    expect(run.sourceKind).toBe('window');
    const text = `${formatReport(run)}\n${JSON.stringify(run)}`;
    expect(text).not.toContain('Secret Movie Title');
    expect(text).not.toContain('YouTube');
  });

  it('parses renderer lines pasted without timestamps', () => {
    const bare = '[backseat/eval] activity=unknown confidence=0.2 policy=baseline fallback=missing_title';
    const run = parseRun(bare, { label: 'bare' });
    expect(run.capture.present).toBe(true);
    expect(run.capture.timestamps).toBe(false);
    expect(run.capture.states[0]).toMatchObject({ activity: 'unknown', fallback: 'missing_title' });
    expect(run.warnings.some((w) => w.includes('no timestamps'))).toBe(true);
  });
});

describe('time helpers', () => {
  it('wraps a session that crosses midnight', () => {
    expect(offsetSec(10, 86_390)).toBe(20);
    expect(offsetSec(86_390, 10)).toBeCloseTo(86_380, 3);
    expect(offsetSec(null, 10)).toBeNull();
  });

  it('reads session-relative and absolute annotation times', () => {
    expect(parseMomentTime('+03:20')).toEqual({ offsetSec: 200, absolute: false });
    expect(parseMomentTime('+1:02:03')).toEqual({ offsetSec: 3723, absolute: false });
    expect(parseMomentTime('03:20')).toEqual({ todSec: 200, absolute: true });
    expect(parseMomentTime(200)).toEqual({ offsetSec: 200, absolute: false });
    expect(parseMomentTime('nonsense')).toBeNull();
  });

  it('converts a local wall-clock annotation to a log offset', () => {
    // Log origin 09:50:58.165 UTC; annotation written at 17:51:03 local (UTC+8).
    const off = absoluteToOffsetSec(17 * 3600 + 51 * 60 + 3, {
      startTodSec: 9 * 3600 + 50 * 60 + 58.165,
      tzOffsetMin: 480,
      clock: 'local',
    });
    expect(off).toBeCloseTo(4.835, 3);
    // Same string read as UTC lands 8 hours later, which is the bug being avoided.
    const asUtc = absoluteToOffsetSec(17 * 3600 + 51 * 60 + 3, {
      startTodSec: 9 * 3600 + 50 * 60 + 58.165,
      tzOffsetMin: 480,
      clock: 'utc',
    });
    expect(asUtc).toBeCloseTo(28_804.835, 3);
  });

  it('parses key=value pairs including quoted values', () => {
    expect(parseKv('activity=long_video confidence=0.8 fallback="a b"')).toEqual({
      activity: 'long_video',
      confidence: '0.8',
      fallback: 'a b',
    });
  });
});

describe('alignAnnotations', () => {
  const annotation = {
    label: 'candidate',
    clock: 'local',
    toleranceSec: 20,
    interruptionRating: 4,
    moments: [
      { at: '+00:05', expect: 'comment', note: 'opening beat' },
      { at: '+02:03', expect: 'comment' },
      { at: '+01:30', expect: 'comment' }, // nearest speech is +02:03, 33s late
      { at: '+02:00', expect: 'silent' }, // speech lands 3s in
      { at: '+01:00', expect: 'silent' },
      { at: '+05:00', expect: 'comment' }, // nothing near it at all
    ],
  };

  it('classifies on-time, late, missed, interrupted and respected', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    const a = alignAnnotations(run, annotation);
    const byAt = Object.fromEntries(a.verdicts.map((v) => [v.at, v.verdict]));
    expect(byAt['+00:05']).toBe('on_time');
    expect(byAt['+02:03']).toBe('on_time');
    expect(byAt['+01:30']).toBe('late');
    expect(byAt['+02:00']).toBe('interrupted');
    expect(byAt['+01:00']).toBe('respected');
    expect(byAt['+05:00']).toBe('missed');
    expect(a.counts).toMatchObject({
      annotated: 6,
      on_time: 2,
      late: 1,
      missed: 1,
      interrupted: 1,
      respected: 1,
      unresolved: 0,
    });
    expect(a.note).toBe(' subjective_interruption=4');
    expect(formatAlignment(run, a)).toContain('extra_comments=');
  });

  it('reports spoken turns that match no annotated moment as extras', () => {
    const run = parseRun(RUN, { label: 'candidate' });
    const a = alignAnnotations(run, {
      toleranceSec: 5,
      moments: [{ at: '+00:05', expect: 'comment' }],
    });
    // The +02:03 turn is 118s away from the only annotated moment.
    expect(a.counts.extra_comments).toBe(1);
    expect(a.extras[0].offsetSec).toBeCloseTo(123.035, 3);
  });

  it('refuses to call a turn missed when the run has no timestamps', () => {
    const noTs = MAIN.split('\n')
      .map((l) => l.replace(/^\[[0-9:.]+\] /, ''))
      .join('\n');
    const run = parseRun(noTs, { label: 'untimed' });
    const a = alignAnnotations(run, { moments: [{ at: '+00:05', expect: 'comment' }] });
    expect(a.timingAvailable).toBe(false);
    expect(a.verdicts[0].verdict).toBe('unresolved');
    expect(a.counts).toMatchObject({ unresolved: 1, missed: 0, on_time: 0 });
    expect(a.counts.extra_comments).toBe(0);
  });
});

describe('pickNewestLog', () => {
  it('picks the newest session log across dev and packaged dirs', () => {
    const entries = [
      { path: '/x/Sei/logs/backseat-b-2026-09-08T05-01-00-956Z.log', mtimeMs: 100 },
      { path: '/x/Sei Dev/logs/backseat-b-2026-09-16T10-00-00-000Z.log', mtimeMs: 900 },
      { path: '/x/Sei Dev/logs/updater.log', mtimeMs: 999 },
      { path: '/x/Sei Dev/logs/chess-b-2026-09-16T11-00-00-000Z.log', mtimeMs: 999 },
    ];
    expect(pickNewestLog(entries)).toBe('/x/Sei Dev/logs/backseat-b-2026-09-16T10-00-00-000Z.log');
  });

  it('returns null when there is no session log at all', () => {
    expect(pickNewestLog([])).toBeNull();
    expect(pickNewestLog([{ path: '/x/updater.log', mtimeMs: 1 }])).toBeNull();
  });
});

describe('formatCompare', () => {
  it('puts both runs side by side and states the non-claim', () => {
    const a = parseRun(RUN, { label: 'baseline' });
    const b = parseRun(RUN, { label: 'long_video' });
    const out = formatCompare(a, b);
    expect(out).toContain('baseline');
    expect(out).toContain('long_video');
    expect(out).toContain('model_calls');
    expect(out).toContain('output_tokens');
    expect(out).toContain('NOT evidence of better behavior');
  });
});
