# Proposal: Pick the ffprobe binary by what it can do, and make the proxy tests stable on every platform

Parent: torrent-tv/meta#336, stage 6 (proxy), AC 20: the proxy tests are stable on every
platform they run on, the CI Linux runner and the agents' Mac. `auto-quality-step.test.js`
passes 25 of 25 solo runs on each, and the full `npm test` exits 0 on each.

## Problem

Three independent causes keep `npm test` from passing on the Mac. Facts measured by the
analyst on 2026-11-10 (proxy `origin/main` c7f63aa2, with PR 63 merged):

1. **Group A, a test defect.** `test/no-torrent/auto-quality-step.test.js` fails at lines 408,
   433, 546 and 587 in 19 to 24 of 25 solo runs on the Mac, in 0 of 25 on Linux CI (probe run)
   and in 81 of 81 CI history runs. The four cases write their segment files with
   `fs.writeFile` in `produceSegments()` and decide at once. Before the writes a scheduled
   `planEncodersNow` reads the watched directory once and finds 0 files; afterwards the segment
   store learns of a file only through `SegmentStore.publish()` or an `fs.watch` event. On macOS
   the watch events arrive 5 to 38 ms after the write (median of the first event) and the
   decision comes about 8 ms in, so the store holds 0 pieces, the observed bitrate is null and no
   request is made. One second later the store held all 4 pieces in every iteration: the events
   are late, not lost. Waiting 20 ms before writing (PR 63's helper `untilWatchIsLive`) still
   fails 40 of 40. A 200 ms wait after the writes, or writing the pieces through
   `SegmentStore.publish`, gave 0 failures in 25 runs each. Three other cases (lines 466, 653,
   670) pass even when the store knows no piece.
2. **Group B1, a code defect.** `test/no-torrent/ffprobe-packets-local.test.js` (the `mp4` and
   `flv` cases) fails on every darwin-arm64 run with
   `ffprobe refused the input (1): No match for section 'stream_side_data'`.
   `services/media/probe-packets.js` (`bundledProbe()`) prefers the ffprobe bundled by
   `@ffprobe-installer`; the newest darwin-arm64 package ships ffprobe 4.4.1, which has no
   section named `stream_side_data`; the Linux packages ship build 20230721-c2b3861, which has
   it. The production probe wired in `server.js` therefore refuses every probe on every
   darwin-arm64 host.
3. **Group B2, a test defect.** The `libxvid` case of
   `test/no-torrent/avi-reordered-local.test.js` fails on the Mac with `Unknown encoder
   'libxvid'`: the darwin-arm64 `ffmpeg-static` (ffmpeg 6.0) has no libxvid, the Linux build has.

## What Changes

- Group A: `produceSegments()` publishes each piece through `SegmentStore.publish`, as the
  encoder's closing of a piece does, and asserts the store holds all four pieces before the
  case decides. Test-only; already committed by this change's test writer.
- Group B1: at startup the proxy picks the ffprobe binary by capability. A new module
  `services/media/ffprobe-selection.js` takes the candidates (the bundled binary, then
  `ffprobe` on PATH) and runs each candidate's `-sections`; the first whose output names the
  section `stream_side_data` is chosen. `bin/cli.js` makes the choice once, before
  `startProxyServer`, and hands the chosen path in; `probePackets` no longer chooses a binary
  of its own. When no candidate qualifies, the proxy logs one line and stops with a clear
  message at startup, instead of refusing every probe.
- Group B2: the libxvid case reads a committed libxvid-made AVI instead of encoding one.
  Test-only.

## Out of scope

- A `--ffprobe-bin` option. No task asks for one; `--ffmpeg-bin` exists for ffmpeg only.
- Replacing the bundled ffprobe package or pinning another version of it.
- Any change of the entries requested from ffprobe (`-show_entries`).
