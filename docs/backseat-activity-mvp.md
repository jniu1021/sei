# Backseat long-video activity prototype

This opt-in MVP uses only the existing zero-thumbnail window-title poll. A
video-service title with an explicit long-form cue selects an 8 Hz retained JPEG
ring and a 1.25× scheduled `idle` delay (75 s maximum). The baseline remains
10 Hz with the original 12–60 s shifted-exponential idle schedule. A missing,
failed or ambiguous title read falls back to baseline. Whole-screen shares also
fall back because the frontmost title is only an ordering heuristic; use a
specific window share for this prototype. The 60 fps shared stream,
local gain/colour signals, streaming Whisper and `user`/`start`/`jolt` wakes
remain unchanged. Titles are coarse activity hints, not event detection; there
is no browser URL or foreground-app API and no new capture permission.

The flag is off by default. Run `npm ci` and `npm run dev -- --tools` (which
builds the macOS audio helper in `predev`). In the main
renderer DevTools console, run
`localStorage.setItem('backseat.activityAwareSampling', 'false')` and begin a new
share for baseline. Run the same command with `'true'`, then begin a new share
for the prototype. The flag is read once per capture session. A title such as
`Full documentary (2024) - YouTube` is a useful positive check; a generic
`YouTube` title should stay baseline. Read `[backseat/eval]` in renderer DevTools
for activity, confidence, fallback reason, policy switches, exact cumulative
JPEG encode count, tick count and delay. Read `[eval]` in the Backseat session
log for awake turns, model-call count and call latency. The model call may use
the user's own key or the Sei proxy; the count does not distinguish billing.
No evaluation entry includes the title, pixels, audio, transcript or page text.
Unpackaged grid dumps require `BACKSEAT_DEBUG_GRIDS=1` explicitly.

For a controlled local test, choose one long video and review it twice with
similar session lengths, once per flag value. Avoid FPS games. Before comparing
the logs, annotate timestamps for scene changes, dialogue moments worth a
comment, and moments where silence was preferable. For each run, report model
calls and token usage, JPEG encodes, missed or late marked moments, irrelevant
or repeated comments, and perceived interruption quality separately. Review
the actual comments against the event list; fewer calls alone do not establish
better behavior. The title classifier's confidence is a rule score, not a
measured probability, and same-activity event detection still needs real use
data and a future awake evaluator.

## Confirmed coverage limit: the rule cannot fire on a Chinese platform

A real baseline share (Chrome on a bilibili video page, flag off, 2026-09-16)
exercised the whole chain and produced no activity match. The classifier saw the
complete, untruncated title ending in `_哔哩哔哩_bilibili` (41 characters, so
`shareLabel`'s 70-character cap was not involved) and reported
`activity=unknown confidence=0.2 reason=insufficient_metadata` for the entire
session. Sampling stayed at 10 Hz throughout, and one idle draw hit the baseline
60 s cap and never exceeded it. In other words the run was a valid baseline, not
a broken one: the flag read, the title polling, the switch plumbing and the
evaluation log all worked.

Two independent gates rejected that title:

1. The service list (`youtube`, `plex`, `netflix`, `prime video`, `disney+`,
   `vimeo`) contains no Chinese platform, so `bilibili` / `哔哩哔哩` never
   matches.
2. The long-form cue is shaped after YouTube titles. `(YYYY)`, a duration,
   `H:MM:SS` or the words movie/film/episode/documentary are all absent from a
   typical bilibili video-page title, so adding the platform name alone would
   not be enough.

The consequence is worth stating plainly: for someone who watches long videos on
bilibili, this rule cannot fire for any video, which makes the 8 Hz and 1.25x
idle policy unreachable in real use. That is a coverage limit of the rule, not a
defect in capture or in the flag path.

A second, separate mechanism was ruled out here but remains live. `readShareLabel`
truncates to `MAX_LABEL_CHARS = 70` keeping the HEAD, while browser window titles
put the service name at the END (`<page title> - YouTube`). Any title longer
than 70 characters therefore loses its service name. This run's title was 41
characters, so it did not apply, but a long YouTube title would fail the same
way for a different reason. `[backseat/eval]` cannot tell the two apart: both
appear as `confidence=0.2 insufficient_metadata`. The offline reader
(`docs/backseat-activity-eval.md`) raises a warning when the flag was on and
`long_video` never appeared, because such a run is baseline in effect and must
not be compared against a baseline run.

Whether to widen the service list, or to replace the generic long-form cue with
a per-platform "this is a video page" signal, is deliberately left open. It is a
design decision that needs real viewing data rather than a quick patch.
