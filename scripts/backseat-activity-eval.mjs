#!/usr/bin/env node
/**
 * backseat-activity-eval.mjs — compare a baseline run and a prototype run of the
 * activity-aware sampling MVP.
 *
 * A run needs BOTH halves of the evidence, which the prototype writes to two
 * different places:
 *   - the session log `~/Library/Application Support/Sei/logs/backseat-*.log`
 *     (model calls, latency, tokens, spoken turns);
 *   - the MAIN renderer DevTools console, filtered on `[backseat/eval]`
 *     (activity, confidence, fallback, policy switches, tick/sample counts,
 *     idle delays). Nothing relays that console to disk, so select it, "Save as"
 *     a text file next to the log, and pass both files under one label.
 *
 * DevTools timestamps are LOCAL; the session log is UTC (backseatLog's `ts()`
 * is `toISOString`). Enable "Show timestamps" in the DevTools console before
 * copying, so policy timing is measurable. Annotate in SESSION-RELATIVE time
 * (`+MM:SS`, counted from the session start) to stay timezone-proof.
 *
 *   node scripts/backseat-activity-eval.mjs --run baseline:base.log --run baseline:base-console.txt \
 *     --run candidate:cand.log --run candidate:cand-console.txt \
 *     --ann baseline:base.annot.json --ann candidate:cand.annot.json
 *
 * Options:
 *   --run LABEL:FILE       repeatable; same LABEL merges (log + console paste)
 *   --latest [LABEL]       add the newest backseat session log under the logs dir
 *   --logs-dir DIR         override the logs directory
 *   --ann LABEL:FILE       annotation JSON for that label
 *   --template LABEL:FILE  write an annotation skeleton for that label and exit
 *   --tz [+-]HH:MM         offset used to read absolute annotation times
 *   --json [FILE]          machine-readable output (stdout when no FILE)
 *   --help
 *
 * This tool reads counts and timestamps only. It never prints a window title,
 * and it does not open pixels, audio, transcripts or page text.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  alignAnnotations,
  commentGaps,
  costSummary,
  exactCounters,
  formatAlignment,
  formatCompare,
  formatReport,
  median,
  parseRun,
  pickNewestLog,
} from './lib/activityEval.mjs';

const argv = process.argv.slice(2);
const help = argv.includes('--help') || argv.includes('-h') || argv.length === 0;

function flagValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out.push('');
    else {
      out.push(v);
      i++;
    }
  }
  return out;
}

function flagValue(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

if (help) {
  const header = readFileSync(new URL(import.meta.url), 'utf8')
    .split('*/')[0]
    .replace(/^#!.*\n/, '')
    .replace(/^\/\*\*\n?/, '')
    .split('\n')
    .map((l) => l.replace(/^ \* ?/, ''))
    .join('\n')
    .trimEnd();
  console.log(header);
  process.exit(0);
}

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p));

function readText(file) {
  if (file === '-') return readFileSync(0, 'utf8');
  return readFileSync(expand(file), 'utf8');
}

/**
 * The app's userData dir is "Sei Dev" under electron-vite dev and "Sei" when
 * packaged (src/main/index.ts:55), so both are searched; a caller that looks in
 * only one of them silently reads a stale session.
 */
function candidateLogDirs() {
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    return [join(base, 'Sei Dev', 'logs'), join(base, 'Sei', 'logs')];
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || homedir();
    return [join(base, 'Sei Dev', 'logs'), join(base, 'Sei', 'logs')];
  }
  const base = join(homedir(), '.config');
  return [join(base, 'Sei Dev', 'logs'), join(base, 'Sei', 'logs')];
}

function listLogsIn(dir) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^backseat-.*\.log$/.test(f))
    .map((f) => {
      const path = join(dir, f);
      try {
        return { path, mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function newestLog(dir) {
  const best = pickNewestLog(listLogsIn(dir));
  if (!best) throw new Error(`no backseat-*.log in ${dir}`);
  return best;
}

function newestLogAcross(dirs) {
  const best = pickNewestLog(dirs.flatMap(listLogsIn));
  if (!best) throw new Error(`no backseat-*.log found in:\n  ${dirs.join('\n  ')}`);
  return best;
}

/** ISO stamp embedded in `backseat-<id>-<ISO>.log`, used to date the session. */
function sessionUtcMsFromName(file) {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
  if (!m) return null;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

// ── assemble runs ──────────────────────────────────────────────────────────
const inputs = new Map(); // label -> { files: [], annotation: null, sourceFileForDate: null }
function slot(label) {
  if (!inputs.has(label)) inputs.set(label, { files: [], annotation: null, sourceFileForDate: null });
  return inputs.get(label);
}

for (const spec of flagValues('--run')) {
  if (!spec) throw new Error('--run needs LABEL:FILE');
  const at = spec.indexOf(':');
  if (at < 0) throw new Error(`--run needs LABEL:FILE, got "${spec}"`);
  const label = spec.slice(0, at);
  const file = spec.slice(at + 1);
  const s = slot(label);
  s.files.push(file);
  if (!s.sourceFileForDate && /\.log$/i.test(file)) s.sourceFileForDate = file;
}

const latestVals = flagValues('--latest');
if (latestVals.length) {
  const dir = flagValue('--logs-dir');
  const label = flagValue('--latest') ?? 'latest';
  const file = dir ? newestLog(dir) : newestLogAcross(candidateLogDirs());
  const s = slot(label);
  s.files.push(file);
  s.sourceFileForDate = file;
  console.error(`# --latest: ${file}`);
}

for (const spec of flagValues('--ann')) {
  const at = spec.indexOf(':');
  if (at < 0) throw new Error(`--ann needs LABEL:FILE, got "${spec}"`);
  slot(spec.slice(0, at)).annotation = spec.slice(at + 1);
}

if (!inputs.size) {
  console.error('nothing to read: pass --run LABEL:FILE (and the console paste under the same LABEL), or --latest.');
  console.error('see --help for the two log sources and the UTC/local timestamp trap.');
  process.exit(2);
}

const runs = [];
for (const [label, s] of inputs) {
  if (!s.files.length) {
    throw new Error(`label "${label}" has an annotation but no --run FILE; pass --run ${label}:<file>`);
  }
  const text = s.files.map(readText).join('\n');
  const run = parseRun(text, { label });
  run.files = s.files;
  run.sessionUtcMs = s.sourceFileForDate ? sessionUtcMsFromName(s.sourceFileForDate) : null;
  runs.push(run);
}

// Timezone offset: prefer the offset in force at the session instant, since the
// log is UTC and the machine may have been in a different DST phase.
const explicitTz = flagValue('--tz');
function tzOffsetMinFor(run) {
  if (explicitTz) {
    const m = /^([+-])(\d{1,2}):?(\d{2})$/.exec(explicitTz);
    if (!m) throw new Error(`--tz wants [+-]HH:MM, got "${explicitTz}"`);
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  }
  const at = run.sessionUtcMs ?? Date.now();
  return -new Date(at).getTimezoneOffset();
}

// ── --template ─────────────────────────────────────────────────────────────
const templateSpec = flagValue('--template');
if (templateSpec) {
  const at = templateSpec.indexOf(':');
  if (at < 0) throw new Error('--template needs LABEL:FILE');
  const label = templateSpec.slice(0, at);
  const file = templateSpec.slice(at + 1);
  const run = runs.find((r) => r.label === label);
  if (!run) throw new Error(`--template: no run labelled "${label}" (have: ${runs.map((r) => r.label).join(', ')})`);
  const skeleton = {
    label,
    video: '<one long video, reviewed twice with similar session lengths>',
    clock: 'relative',
    toleranceSec: 20,
    interruptionRating: null,
    notes: 'at = "+MM:SS" after the session start. Set expect to "comment" or "silent" only where you have an opinion; leave "" to skip.',
    moments: run.model.said.length
      ? run.model.said.map((s) => {
          if (s.offsetSec == null) return { at: '', expect: '', note: '' };
          // Round the TOTAL, then split, so 119.7s never renders as "+01:60".
          const total = Math.round(s.offsetSec);
          const pad = (v) => String(v).padStart(2, '0');
          const at =
            total < 3600
              ? `+${pad(Math.floor(total / 60))}:${pad(total % 60)}`
              : `+${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
          return { at, expect: '', note: '' };
        })
      : [{ at: '+00:00', expect: '', note: '' }],
  };
  writeFileSync(expand(file), `${JSON.stringify(skeleton, null, 2)}\n`);
  console.error(`# wrote template ${file} (${skeleton.moments.length} spoken turn(s) pre-listed, all skipped until you label them)`);
  process.exit(0);
}

// ── report ─────────────────────────────────────────────────────────────────
const alignments = new Map();
for (const run of runs) {
  const s = inputs.get(run.label);
  if (!s.annotation) continue;
  const ann = JSON.parse(readText(s.annotation));
  alignments.set(run.label, alignAnnotations(run, ann, { tzOffsetMin: tzOffsetMinFor(run) }));
}

const jsonOut = {
  generatedAt: new Date().toISOString(),
  tzOffsetMin: Object.fromEntries(runs.map((r) => [r.label, tzOffsetMinFor(r)])),
  runs: Object.fromEntries(
    runs.map((r) => [
      r.label,
      {
        sourceKind: r.sourceKind,
        sessionDurationSec: r.sessionDurationSec,
        reportedSessionSec: r.reportedSessionSec ?? null,
        captureDurationSec: r.capture.durationSec,
        clockDeltaSec: r.clockDeltaSec ?? null,
        counters: exactCounters(r),
        cost: costSummary(r),
        gaps: commentGaps(r),
        ticksByPolicy: r.capture.ticksByPolicy,
        idleDelays: r.capture.idleDelays.length
          ? {
              n: r.capture.idleDelays.length,
              medianMs: median(r.capture.idleDelays),
              minMs: Math.min(...r.capture.idleDelays),
              maxMs: Math.max(...r.capture.idleDelays),
            }
          : null,
        secUnderPolicy: r.capture.secUnderPolicy,
        policySwitches: r.capture.switches.map((s) => ({ from: s.from, to: s.to, offsetSec: s.offsetSec })),
        states: r.capture.states.map((s) => ({
          activity: s.activity,
          confidence: s.confidence,
          policy: s.policy,
          fallback: s.fallback,
          offsetSec: s.offsetSec,
        })),
        warnings: r.warnings,
      },
    ]),
  ),
  annotations: Object.fromEntries([...alignments].map(([k, v]) => [k, { counts: v.counts, extras: v.extras.map((e) => e.offsetSec) }])),
};

const jsonSpec = flagValue('--json');
if (jsonSpec != null || argv.includes('--json')) {
  const text = `${JSON.stringify(jsonOut, null, 2)}\n`;
  if (jsonSpec) {
    writeFileSync(expand(jsonSpec), text);
    console.error(`# wrote ${jsonSpec}`);
  } else process.stdout.write(text);
} else {
  for (const run of runs) {
    console.log(formatReport(run));
    const a = alignments.get(run.label);
    if (a) console.log(formatAlignment(run, a));
    console.log('');
  }
  if (runs.length === 2) {
    console.log(formatCompare(runs[0], runs[1]));
    console.log('');
  } else if (runs.length > 2) {
    console.error(`# ${runs.length} runs given; comparison table needs exactly 2. Reports printed individually.`);
  }
  console.log('Reminder: this run was NOT a matched-length, same-video pair unless you made it one.');
  console.log('Fewer model calls is not better behavior — read the alignment and your own notes.');
}
