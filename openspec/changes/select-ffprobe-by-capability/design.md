# Design: select-ffprobe-by-capability

Facts are marked **Fact** with their source; everything else is a decision or an
**Assumption**.

## Context

`services/media/probe-packets.js` runs ffprobe over the proxy's own strict byte endpoint
(`statement` `streams` or `packets`). Its default argument `ffprobeBin = bundledProbe()` takes
the path from `@ffprobe-installer/ffprobe`, and `ffprobe` on PATH when that file is not
executable. `server.js` hands `probePackets` to `MediaReadParams` as a port. The `streams`
statement asks for the entries `stream_side_data=` (`probe-packets.js` line 28).

- **Fact** (analyst, 2026-11-10): the darwin-arm64 bundled build is ffprobe 4.4.1 and fails with
  `No match for section 'stream_side_data'`; the Linux builds (20230721-c2b3861) accept it.
- **Fact** (test writer, 2026-11-10, run on this Mac with a copy of the bundled binary): the
  `-sections` output of 4.4.1 goes to stdout, has 49 lines, and holds the text `stream_side_data`
  on exactly one line, `.A.              side_data_list/stream_side_data_list`; taken apart at
  whitespace and `/`, no name equals `stream_side_data` (0 matches). A substring test would
  therefore accept the binary that refuses the probe; a whole-name test rejects it.
- **Fact** (same run): in the 4.4.1 build, `.A. ... side_data_list/stream_side_data_list` names the
  list and the entry beneath it is `side_data` with no unique name; ffprobe prints a section as
  `NAME/UNIQUE_NAME` (as in `tags/format_tags`).
- **Assumption, unverified here**: a build that accepts `stream_side_data=` prints the entry as
  `side_data/stream_side_data`. No ffprobe of that build runs on this Mac. The whole-name rule is
  written so that any line that carries the name as a word qualifies. The check that the
  assumption holds is the CI Linux run of `ffprobe-packets-local.test.js`.
- **Fact**: the bundled package on this Mac was installed with scripts off and its binary is not
  executable (`permission denied` when run in place), so `bundledProbe()` falls back to `ffprobe`
  on PATH there today. A candidate that cannot be started is a normal case of the selection.

## Decisions

1. **Capability, not version.** A binary qualifies by what `-sections` prints. A version number
   would need a table of which release added the section; the section list is the fact.
2. **One owner, one choice.** `selectFfprobe` (in `services/media/ffprobe-selection.js`) is the
   only code that decides which binary is used. `bin/cli.js` calls it once, before
   `startProxyServer`, in the same place that resolves `ffmpegBin`, and passes the result in as
   `ffprobeBin` to `startProxyServer`, which hands it to the `probePackets` port. `server.js`
   stays composition only. `probePackets` loses `bundledProbe()` and its default.
3. **Injected process.** `selectFfprobe({ candidates, run, logger })`:
   - `candidates`: `[{ source: "bundled" | "PATH", binary }]` in order of preference;
     `ffprobeCandidates({ bundledBinary })` builds the list: the bundled entry when
     `bundledBinary` is a non-empty string, then `{ source: "PATH", binary: "ffprobe" }`.
   - `run(binary, args)`: resolves `{ status, stdout, stderr }`; rejects when the process cannot be
     started. The entry point supplies one over `child_process.spawn` with a timeout; tests
     supply fakes. The two argument lists are exactly `["-version"]` and
     `["-hide_banner", "-sections"]`.
   - Returns `{ source, binary, version }` of the first qualifying candidate.
   - On none: `logger.error(line)` once, no other call at any level, then throws
     `FfprobeUnavailableError` (exported, `name` `FfprobeUnavailableError`, `message` equal to the
     line). Later candidates are not run once one is chosen; each candidate is run at most once,
     so the choice cannot change while the proxy runs.
4. **The line.** `ffprobe: no usable binary: <entry>; <entry>` where an entry is
   `<source> <binary> (version <version>) lacks section stream_side_data` or
   `<source> <binary> cannot be run (<reason>), so stream_side_data was not checked`. The text is
   written by the implementer; the tests require the parts named in the plan.
5. **Failure at startup.** `FfprobeUnavailableError` propagates out of `bin/cli.js`' existing
   startup `try` and ends the process with its message, as `assertFfmpegAvailability` does.
   Whether the process exit is exercised is a property of `bin/cli.js`, which no test starts
   (it composes the torrent pool).

## Alternatives

| Alternative | Why not |
| --- | --- |
| Keep choosing per probe in `probePackets` | A choice made per probe is made again at every probe and its failure is a refusal per probe, which is the defect. |
| Match `stream_side_data` as a substring of `-sections` | **Fact**: accepts ffprobe 4.4.1 (1 line contains it), the binary that refuses. |
| Choose by version number | Needs a table of versions; the section list states the capability. |
| Pin another version of the bundled package | Changes a dependency for one platform; the PATH fallback also serves hosts with a newer system ffprobe. |

## Risks and undo

- A host whose bundled binary qualifies is unchanged. A host with none that qualifies, which
  refused every probe, now stops at startup with one line: no viewer is affected who could have
  been served.
- Undo: revert the code commit; the tests of this change are then `todo`.

## Group A and group B2 (test-only)

- **A.** `produceSegments(manager, session, bytesEach)` calls
  `manager.segmentStore.publish(session.outputKey, "making-0-<NNNNN>.mp4", fmp4Format, { bytes })`
  for pieces 0 to 3 and asserts that `segmentStore.sizesOf(outputKey)` holds those four pieces,
  each `bytesEach` long, before the case decides. `sizesOf` is what the observed-bitrate reading
  of the link check asks, so the assertion is on the view the decision reads. Restoring the old
  fixture (`fs.writeFile` of `segment-<NNNNN>.mp4`) makes the assertion fail in 7 of 26 cases,
  6 of 6 runs (measured by the test writer on the Mac, 2026-11-10), including the three cases that
  passed without the store knowing a piece.
- **B2.** The libxvid case reads `test/no-torrent/fixtures/avi-xvid-bframes.avi`, a libxvid-made
  AVI of at most a few hundred kilobytes, instead of encoding. Beside it, a text file
  `avi-xvid-bframes.avi.md` records the generating command, the ffmpeg version and build that ran
  it, and the file's sha256. The case reads and compares as today (index removed, presentation
  order retained, framemd5 equal to ffmpeg's own). Whether built-in `mpeg4 -vtag XVID` is
  equivalent is **unknown** and not assumed. The generating command is the one the case ran
  (`-f lavfi -i testsrc2=size=64x64:rate=10 -t 3 -c:v libxvid -bf 2`) on a host whose ffmpeg has
  libxvid. **The test writer's Mac has no libxvid encoder, no Linux ffmpeg and no container
  runtime, so the fixture is not made in this change's test commit; see Tasks 3.**
