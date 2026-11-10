# Design: An encoder run's speed reading is the film of the pieces it closed

Line numbers are at proxy `origin/main` `93163ea1`; re-locate by name. Log
anchors are line numbers of the gunzipped files in
`/Users/silentimp/Work/torrent-tv/logs/session-logs-2026-11-10-ttv414/`
(local only, never committed).

## 1. Findings

### 1.1 Facts

Proxy 2.107.80 on the HA host. The process that refused started at 19:42
(`calibration: libx264 5 of 5 mode(s) usable`, `proxy-final.log` line 77); no
later calibration appears up to 20:34 (`proxy-tail-safari.log` from 20:32:59,
and meta field-check logs of #312 up to 20:28).

The refusal, `proxy-cap2.log`:

| line | time | text (shortened) |
|---|---|---|
| 153 | 20:34:00.012 | `transcode: not offering … on a machine with 83% to spare` |
| 176 | 20:34:00.292 | `transcode "Below.S01E01…": not opened for this viewer — this machine would make 0.12x of every output with one more encoder (6.606 s of work per second of film) (key=…cfbe…:video-only:v=0/copy)` |
| 181 | 20:34:00.311 | `[http-response] … url=/api/transcode-sessions … status=409` |

No encoder was alive and no other output held a place: the line before the
request is `budget — … admitted encode inputs 0MiB of 0MiB` (line 94), and no
`encode-run` line appears in the file.

Where the price came from, `proxy-final.log`:

| line | time | text (shortened) |
|---|---|---|
| — | 19:45:58.315 | `encode-plan on …cfbe…/copy: start #7..#263 [speed=144.90x …]` — the startup copy measurement, used while nothing was learned |
| 12282 | 19:46:09.634 | `host-load: … available=58% for-encoders=16% …` |
| 12314 | 19:46:11.018 | `encode-run #8..#8 on …cfbe…/copy: ffmpeg used 0.66s of CPU for 8.04s of film, 0.082s per second of film` |
| 12319 | 19:46:11.058 | `encode-run #9..#9 of …cfbe…/copy by libx264: #9 is wanted …` (`-ss 93.880435 … -to 104.167`) |
| — | 19:46:11.247 | `run #9..#9 positioned at 93.750s for boundary #9` |
| — | 19:46:11.339 | `encode input #9..#9 …: stretch copied, 38755101 bytes` |
| 12377 | 19:46:13.001 | `encode-run #9..#9 …: #9 written by the encoder +1644ms, named +1684ms, published +1943ms` |
| 12378 | 19:46:13.005 | `transcode: Below.S01E01.1080p.rus.LostFilm.TV.mkv copies at 0.15x on this host (median of 1, latest 0.15x)` |
| 12395 | 19:46:13.113 | `encode input of run #9..#9 …: 5 read(s), 30889471 bytes, first at 680ms, last at 1153ms, ended at 2055ms` |
| 12396 | 19:46:13.113 | `encode input of run #9..#9 …: open not measured (first piece named at 1684ms, 10.417s of film, at a measured 0.02x the piece takes longer than that)` |

No later `Below… copies at` line exists in any log of the day.

Code:

1. `EncodeAdmission.admitsWatching` → `admitsPreparation` → `#assessCandidate`
   (`services/encode/EncodeAdmission.js:285, 183, 246–271`): refuses when
   `correctForAvailability(1 / (others + added), availability) < 1`, with
   `added = fileCostSec + costSec` of the output (`#added`, `:160`).
   `OutputOpening.#claimOrRefuse` (`services/encode/OutputOpening.js:85–104`)
   logs the refusal and throws `OUTPUT_NO_CAPACITY` (→ 409), called for both a
   new and an existing output (`:659`, `:690`) through the claim of
   `ViewerRequests` (`services/server/ViewerRequests.js:381–399`).
2. The output's price is `EncodeCost.loadOfOutput` → `#loadOfSession`
   (`services/encode/quality/EncodeCost.js:495, 530–559`): the session's
   `lastAloneSpeed` if set, else for a copy `#copyCost[file.key]`, else the
   startup `copySpeedX` (144.90x here).
3. `EncodeCost.learnFrom` (`:942–1043`) writes both from a run's
   `speedReading`: `quietSpeed = speed / leftForEncoders(availability)`,
   `state.lastAloneSpeed = quietSpeed` (`:1004`), then `#learnCopyCost`
   (`:1045–1063`), whose log line prints `1 / median` and the latest
   `quietSpeed`.
4. `EncodeRun.#measureSpeed` (`services/encode/EncodeRun.js:769–785`):
   `workDeltaBetween(#pieceSample, #workSample)` — film and working time
   between the baseline and the latest `-progress` report. It is called on
   publication (`:742–743`) and, when that gives nothing, on the next report
   (`:613`).
5. `EncodeRun.inputWaitEnds` (`:462–476`): while no reading exists, every
   answered input read moves the baseline to the latest report, with the
   working time of now.
6. `RunClock` (`services/encode/RunClock.js`) leaves input waits and stops out
   of `workingMs`; `workingMs(at)` takes a moment.
7. `#readClosedPieces` (`:642–700`) records the moment each piece is named
   closed (`#namedAt`); `#publishClosed` deletes it in its `finally` (`:733–738`)
   before `#measureSpeed` runs.
8. The run is built in `EncodeRuns.#startEncodeRun` (`services/encode/EncodeRuns.js:1145`)
   with `startSeconds` = the timeline start of its first piece (`:1116`);
   `Timeline.publishedStartOf(index)` (`services/encode/output/Timeline.js:89`)
   gives where piece `index` begins on the output.
9. `EncodeCost.learnFrom`'s own contract (`:933–936`) says the reading is
   "film made between two closed pieces over the run's own working time".

### 1.2 Analysis (5 Whys)

1. Why 409 for a copy on an idle proxy? The admission priced one encoder on
   that output at 6.606 s of work per second of film (fact table line 176,
   code 1); 1/6.606 = 0.151x, which the availability correction (83 % to spare)
   lowers to 0.12x, below 1.
2. Why 6.606? It is 1/0.1514: the copy price learned from the run #9..#9
   reading, logged as "copies at 0.15x" (line 12378). The logged figure is
   rounded to two places, and 1/0.145…1/0.155 = 6.45…6.90 s/s contains 6.606;
   nothing else was priced (no live run, no held output). The file's own cost
   (`fileCostSec`) is not printed; the figures are consistent with it being
   near 0, which is an inference. Which of the two stores answered (the
   session's `lastAloneSpeed` or the file's `#copyCost`) is not shown; both are
   written from readings by `learnFrom` (code 3).
3. Why 0.15x? `learnFrom` divided the run's reading by the 16 % left to
   encoders (line 12282): 0.15 × 0.16 = 0.024, and the run's own line says "at
   a measured 0.02x" (line 12396).
4. Why did the run read 0.02x? The run made 10.417 s of film and named the
   piece 1.684 s after it was made (line 12377, 12396), so over any working
   time not longer than its life up to the close its speed is at least 6.2x.
   A reading of 0.024x means the film in the reading was about 1/250 of the
   piece, i.e. the reading's film is not the film of the piece that closed.
   Two code paths allow that (code 4, 5):
   - **H1**: the last answered input read (reads up to 1153 ms after start,
     line 12395) moved the baseline to a report that already counted almost
     the whole piece, so the reading saw only the tail;
   - **H2**: the reading was taken at publication (13.001 → 13.005) from a
     report made before the piece closed, which counted almost no film.
   The log does not separate them: no line prints the samples.
5. Why can the reading's film differ from the piece's film at all? The reading
   takes its film from `-progress` reports, which are sampled by ffmpeg on its
   own period and are not tied to the close of a piece, while the contract of
   the reading (code 9) is the film between closed pieces. **Root cause: the
   speed reading is measured from progress reports instead of from the pieces
   the run closed.**

Assumption: in one-piece copy runs H1 and H2 recur, because the whole piece is
made in a few hundred milliseconds near the last input read. It is not
measured; the fix does not depend on it, because neither path exists after
§3.1. The line of §3.3 prints each run's film and working time, so a reading
that disagrees with the run's own `written by the encoder +Xms` line is
visible in the field.

## 2. Alternatives

| | what | viewer gets | cost | verdict |
|---|---|---|---|---|
| A | reading from closed pieces (this design) | copy priced from what the run did; field case 0.026 s/s instead of 6.606 | one port, ~40 lines in `EncodeRun`, tests rewritten | chosen: removes H1 and H2 and matches the stated contract |
| B | drop the `inputWaitEnds` baseline move only | fixes H1 only; H2 still possible | ~10 lines | rejected: does not remove the root cause |
| C | ignore a learned copy price below the startup copy measurement | hides the symptom; forecasts keep the wrong reading | small | rejected: a chosen rule over a wrong measurement |
| D | price copies by CPU (`k/U`) | admission matches machine use | large; meta#180 plan 2.3 | out of scope; separate decision |

Reversible: A is one commit; reverting it restores the progress-based reading.

## 3. Design

### 3.1 `EncodeRun`: a reading per published piece

State replaced: `#workSample`, `#pieceSample`, `#speedMeasurementPending` and
the baseline move in `inputWaitEnds` are removed. New state:
`#lastReadingEnd = { filmEndSeconds: startSeconds, workingMs: 0, monotonicAt:
<monotonicNow() at construction> }`.

1. `#readClosedPieces`: beside `#namedAt.set(name, this.now())`, record the
   working time and the monotonic time at that moment:
   `#closedAt.set(name, { at, workingMs: this.clock.workingMs(at), monotonicAt:
   this.monotonicNow() })`, and delete it wherever `#namedAt` is deleted.
2. `#publishClosed`: read the entry of `#closedAt` for `name` BEFORE the
   `finally` deletes it (fact 7); after the piece is served, call
   `#measureSpeed(index, closedAt)` where `index = this.indexOfName(served)`.
3. `#measureSpeed(index, closedAt)`:
   - `filmEnd = Number(this.pieceEndSeconds(index))`; return when not finite;
   - `workSeconds = filmEnd - #lastReadingEnd.filmEndSeconds`,
     `workingSeconds = (closedAt.workingMs - #lastReadingEnd.workingMs) / 1000`;
     return when either is not finite or not > 0 (use `workDeltaBetween` from
     `encoder-readings.js` with samples `{ producedSeconds, workingMs }` so the
     guards stay in one place);
   - `#speedReading = { speed: workSeconds / workingSeconds, at: closedAt.at,
     workSeconds, workingSeconds, captureOwner: "proxy-encoder", captureClock:
     "performance", captureClockEpoch: performance.timeOrigin,
     captureStartedAtMonotonic: #lastReadingEnd.monotonicAt,
     captureCompletedAtMonotonic: closedAt.monotonicAt }` — the same fields as
     today, so `SpeedReadings`, the forecast and `learnFrom` read it unchanged;
   - `#lastReadingEnd = { filmEndSeconds: filmEnd, workingMs: closedAt.workingMs,
     monotonicAt: closedAt.monotonicAt }`; `onSpeedMeasured(this.speedReading)`.
4. `#reportProgress` keeps feeding `this.progress` and `onProgress`; it no
   longer touches the reading.
5. Pieces published `quiet` at a stop or `tentative` follow the same path as
   today's publication: a reading is taken only for a piece that was served.

### 3.2 `pieceEndSeconds` port

`EncodeRun` constructor takes `pieceEndSeconds: (index) => number | null`
(default `() => null`: no reading). `EncodeRuns.#startEncodeRun` passes
`(index) => Number.isInteger(index) && index + 1 < session.timeline.published.length
? session.timeline.publishedStartOf(index + 1) : Number(session.file.durationSeconds) || null`.
The implementer confirms against `Timeline.js:58–95` whether `published`
already holds the end of the last piece and uses it when it does; the rule is
"the end of piece `index` on the same timeline `startSeconds` is taken from".

### 3.3 The line that shows it worked

Once per run, at its first reading, `EncodeRun` logs:

`encode-run #<from>..#<to> on <address>: first speed reading <s>x — <film>s of
film to the close of #<index> over <working>s of its own work, <idle>s waiting
for input or stopped left out`

with `<idle> = (closedAt.at - <run construction time>)/1000 - working`. Field
pass: for copy outputs on HA the first readings are above 1x and agree with
the run's own `#N written by the encoder +Xms` line (film / X ≥ reading), and
`transcode: <file> copies at <x>x on this host` lines are above 1x.

### 3.4 Documentation

Where the speed reading is described (`docs/encode-architecture.md`, or
`docs/encode-run-state.md` if that is where `speedReading` is described —
grep `speed reading`), state: a reading is the film between the ends of two
published pieces (the run's start for the first) over the run's own working
time between the moments they were named closed; progress reports do not
enter it. Update the header comment of `services/encode/encoder-readings.js`
("the run takes them when it closes pieces") if its wording no longer matches.

### 3.5 Changeset

`.changeset/fix-ttv-414-copy-output-capacity.md`, standard `@changesets/cli`
format (proxy `AGENTS.md`, "Checks scripts, changesets and release path"):
front matter `"@torrent-tv/proxy": patch`, one sentence a viewer understands,
for example: "A film the proxy copies is no longer refused as having no
capacity on an idle machine because one encoder run was measured wrongly."

## 4. Constraints

- Nothing on this Mac starts a torrent; every check uses fakes (fake ffmpeg
  process emitting `-progress` text and closed-piece names on fd 3, fake clock).
- One owner per fact: the run owns its readings; `EncodeCost` stays their only
  consumer for prices. No new store, no chosen numbers.
- Every commit passes `npm test`.
- No server, ha-addon or infra change: the answer contract is unchanged.

## 5. Tests that change

In `test/no-torrent/encode-run.test.js`:

- "its speed is film made over its own working time, including for a one-piece
  run" (`:174`) expects 3.5x from progress reports 0.5 → 4; rewritten so the
  run gets `pieceEndSeconds` and the reading is the piece's film over working
  time, the 30 s input wait still left out.
- "one positive progress report measures a one-piece run after its input wait"
  (`:222`) expects 2x from one report; rewritten the same way (the piece's film
  over 2 s of work).

Their intent (input waits are not working time; a one-piece run is measured)
stays. `test/no-torrent/encoder-readings.test.js` is unchanged.
