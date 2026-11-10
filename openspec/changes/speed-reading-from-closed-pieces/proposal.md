# Proposal: An encoder run's speed reading is the film of the pieces it closed

Issue: torrent-tv/meta#414.

## Why

Field check of #312 on the Home Assistant host, 2026-11-10, proxy 2.107.80,
server 0.66.55. Logs are kept outside git in
`/Users/silentimp/Work/torrent-tv/logs/session-logs-2026-11-10-ttv414/`
(`proxy-cap2.log.gz`, `proxy-tail-safari.log.gz`, `proxy-final.log.gz`); the
lines that prove each step are quoted in `design.md` §1.

At 20:34:00 the viewer opened `Below.S01E01.1080p.rus.LostFilm.TV.mkv` on an
idle proxy ("nothing encoding and nothing downloading") and
`POST /api/transcode-sessions` answered 409: the proxy refused the output
`video-only:v=0/copy` — a stream copy — saying "this machine would make 0.12x
of every output with one more encoder (6.606 s of work per second of film)".
The page told the viewer the proxy has no capacity.

The 6.606 s of work per second of film is the price of copying that film, and
it came from one speed reading of one encoder run 48 minutes earlier: at
19:46:13 the run that copied piece #9 (10.417 s of film, named 1.684 s after
the run was made) reported a speed of 0.02x, which `EncodeCost.learnFrom`
filed as "copies at 0.15x" (0.02x over the 16 % of the machine left to
encoders). The same run's own figures say it made film at no less than 6.2x.
The reading is not what the run did, and the admission refuses on it for as
long as the process lives (5 Whys in `design.md` §1.2).

The reading is taken by `EncodeRun.#measureSpeed` from ffmpeg's `-progress`
reports: film between a baseline report and the latest report, over the run's
own working time between them (`RunClock`, which leaves input waits and stops
out). Two code paths let that film be a sliver of the piece that closed:
`inputWaitEnds` moves the baseline to the latest report every time an input
read is answered before the first reading, and the reading is taken at
publication from whatever report came last, which can predate the close.
Which of the two produced 0.02x is not shown by the log; the change removes
both by not reading the film from progress reports at all.

For the viewer: a film the proxy can copy at many times realtime is refused as
"no capacity" on an idle machine, and every later viewer of that film on that
proxy is refused until the proxy restarts. The same wrong reading also feeds
the playback forecast and the open estimate ("at a measured 0.02x the piece
takes longer than that", 19:46:13.113).

## What changes

- `services/encode/EncodeRun.js`: a speed reading is taken when a piece is
  published, from two facts of that piece: its film, which is its end on the
  output's timeline minus where the previous reading ended (the run's
  `startSeconds` for the first), and the run's working time at the moment the
  encoder named the piece closed, minus the working time at the previous
  reading (zero for the first). `RunClock` still leaves input waits and stops
  out. Progress reports no longer enter the reading; the baseline move in
  `inputWaitEnds` and the pending-measurement state are removed.
- `services/encode/EncodeRun.js` gains the port `pieceEndSeconds(index)`;
  `services/encode/EncodeRuns.js` passes it from the output's timeline. Where it
  answers nothing finite, no reading is taken.
- The first reading of every run is logged once (`design.md` §3.3), so the
  field shows whether readings now describe the runs.
- `docs/encode-architecture.md` (or the file that describes speed readings,
  see `design.md` §3.4) states where a reading comes from.
- A changeset (`fix`).

## Out of scope

- `encode: no encoder could be made for …` and the
  `… is wanted and NO ENCODER IS MAKING IT` line that follows it for copy
  outputs: a different cause (`take` returned null while the input stretch was
  still `needs-bytes`), tracked by torrent-tv/meta#364; evidence added there.
- Pricing a copy by its CPU use instead of its speed. A copy runs on one core
  and is bound by its input: the cfbe copy run #8 used 0.66 CPU-s for 8.04 s of
  film (0.082 CPU-s per film-s, 0.02 of a 4-core machine), and the Nightmare
  copy run measured `k/U=0.004–0.007` against a price `c=0.033`. Whether the
  admission's claim moves from speed (`c`) to CPU (`k/U`) is the question
  torrent-tv/meta#180 plan 2.3 left open; it is a separate decision.
- The refusal at 19:43:05 ("0.93x … 0.138 s of work"), made while the host was
  busy (`for-encoders=16–20%`): not the idle case of this issue.
- How `EncodeCost` combines readings (median, scatter, `lastAloneSpeed`) and the
  admission arithmetic (`EncodeAdmission`): unchanged.
