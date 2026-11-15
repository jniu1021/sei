# Backseat activity-aware evaluation tool

`scripts/backseat-activity-eval.mjs` reads the prototype's evaluation output and
puts a baseline run and a prototype run side by side. It measures; it does not
judge. Every number it prints is a count, a timestamp or an aggregate of those.
Whether a comment was *good*, *wanted* or *interrupting* stays a human call, and
the tool says so in its own output.

Run `node scripts/backseat-activity-eval.mjs --help` for the flag list.

## A run has two halves, and they live in different places

The prototype writes evaluation output to two destinations that never meet on
disk. A run is only fully readable when you supply both under one label.

| Half | Where it is | What it carries |
| --- | --- | --- |
| capture | MAIN renderer DevTools console, lines marked `[backseat/eval]` | `activity`, rule `confidence`, `fallback`, policy, `policy_switch`, `tick_count`, `sample_count`, `sample_rate`, `idle_delay_ms` |
| model | `logs/backseat-<characterId>-<ISO>.log` in the app's userData dir | `[eval] awake_count`, `[eval] model_call_count`, `[eval] model_latency_ms`, `turn <kind>: in=/cacheRead=/cacheWrite=`, `turn <kind>: said N line(s)` |

The userData dir differs by build (`src/main/index.ts:55`): a dev run writes
`~/Library/Application Support/Sei Dev/logs`, a packaged app writes
`~/Library/Application Support/Sei/logs`. `--latest` searches **both** and takes
the newest `backseat-*.log`; `--logs-dir` overrides. Reading only one of them is
how you end up analysing last week's session.

`npm run dev -- --tools` opens the app's DevTools console for you (and a browser
viewer with a Logs tab).

There is no console relay: `appendOverlayLog` is mentioned in `backseatLog.ts`
only in a comment, so nothing copies the capture lines into the log file. Select
the `[backseat/eval]` lines in the DevTools console and use **Save as** to write
them next to the log.

**Turn timestamps on first.** DevTools timestamps are off by default. Without
them the capture lines carry no times, per-policy timing is unmeasurable, and the
tool reports those numbers as unavailable instead of guessing.

**Silence is not logged.** `runTurn` returns early when nothing is said, so an
awake tick that stayed quiet leaves no line. The tool infers `silence_inferred =
model calls - spoke - failed - aborted` and labels it as inferred.

## The timestamp trap

`backseatLog.ts` stamps lines with `new Date().toISOString().slice(11, 23)`, so
the log's `[HH:MM:SS.mmm]` is **UTC**, while DevTools timestamps are **local**.
The two differ by your timezone — normally, on every run.

The tool never mixes the two origins. Each half is measured from its own first
line, so a whole-timezone difference is reported as context (`clocks: ...`) and
is not treated as a fault. It only warns when the gap is *not* a plausible
timezone offset, which usually means the console paste and the log came from
different sessions.

For the same reason, annotate in **session-relative** time (`"+03:20"`), which
needs no clock conversion at all. Absolute times (`"14:32:10"`) are also
accepted and converted with `--tz [+-]HH:MM` (default: the machine offset in
force at the session instant), but relative times are harder to get wrong.

## Workflow

1. `npm run dev -- --tools`, then in the chat header press the **Backseat**
   button, stay on the **Window** tab, and share the one window holding a long
   video. Never whole-screen: that path falls back by design, and the tool warns
   when it sees `source_kind=screen`. Avoid FPS content.
2. In the main renderer DevTools console, enable timestamps and set the flag:
   `localStorage.setItem('backseat.activityAwareSampling', 'false')`.
3. **Start a new share** (the flag is read once per capture session), watch for
   a comparable stretch of the video, then save the console lines and the session
   log. Label this pair `baseline`.
4. Repeat the same video for a similar length with the flag set to `'true'`, and
   label that pair `candidate`.
5. While reviewing, note the moments worth a comment and the moments where
   silence was preferable. Scaffold the file from the run's own spoken turns:

       node scripts/backseat-activity-eval.mjs --run candidate:cand.log \
         --template candidate:cand.annot.json

   Then set `"expect": "comment"` or `"expect": "silent"` only where you have an
   opinion. An unlabelled moment stays `""` and is **skipped**, never scored as a
   comment — a pre-filled template must not score itself.
6. Compare:

       node scripts/backseat-activity-eval.mjs \
         --run baseline:base.log --run baseline:base-console.txt \
         --run candidate:cand.log --run candidate:cand-console.txt \
         --ann baseline:base.annot.json --ann candidate:cand.annot.json

   Add `--json out.json` for machine-readable output. `--latest [LABEL]` picks up
   the newest session log without retyping its path.

## Reading the output

Exact, no timestamp needed: cumulative JPEG encodes, tick count, awake count,
model calls, spoken turns and lines, dropped ticks by reason, token sums.

Measured from the capture half: `sample_rate` readings, `idle_delay_ms`
distribution, seconds in each policy, policy switch times. Compare
`idle_delay_ms` against the built-in expectation line (baseline ~28 s over
12–60 s; long video ~35 s over 15–75 s).

Inferred, and labelled as such: `silence_inferred`, plus `extra_comments`, which
are spoken turns matching no annotated moment.

Integrity checks the tool raises on its own, each one a way a run can be
unreadable rather than merely bad:

- no capture lines, or no model lines — one half is missing;
- capture lines carry no timestamps;
- the console paste is shorter than the session, so per-policy timing is partial;
- tick lines disagree with the last `tick_count`, so the paste is truncated;
- `session end` disagrees with the log's own span;
- the two halves look like different sessions;
- `source_kind=screen`, or `fallback=flag_disabled`;
- the flag was on but `long_video` never appeared, so the prototype never
  engaged and this run is baseline in effect — comparing it against a baseline
  run proves nothing. This happened for real on a bilibili share; see
  `docs/backseat-activity-mvp.md` for why the rule cannot match there. The tool
  can only see the counters, never the title, so it can flag the null result but
  not explain which gate rejected the title.

## What this tool deliberately does not do

- It never reads or prints a window title. `session start` lines from pre-patch
  logs embedded `source="<title>"`; the parser reduces that to `source_kind` and
  drops the rest. It opens no pixels, audio, transcript or page text.
- It does not compute output-token cost: the prototype logs `in`, `cacheRead` and
  `cacheWrite` per turn but never output tokens. Every report says `output=NOT
  LOGGED`, and input/cache totals are not a full cost comparison.
- It does not decide that fewer model calls is better. The comparison table ends
  with that refusal on purpose; a call count only means something next to the
  annotated moments and your own notes.

A single baseline/candidate pair is one observation, not a result. Report the
call counts, tokens, JPEG encodes, missed and late moments, irrelevant or
repeated comments, and perceived interruption quality separately, as
`docs/backseat-activity-mvp.md` describes.
