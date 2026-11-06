# Tasks: Give the logic in the proxy composition root its owners

One sub-issue, one branch `refactor/ttv-<n>-<slug>`, one PR, in the order
below (6.5, #ttv-280, comes between 6 and 7). Tests come first and fail until the implementation lands; each
"Tests first" group is its own `test(proxy): … #ttv-<n>` commit. Code is moved
verbatim with ports in one `refactor(proxy): … #ttv-<n>` commit, and any
cleanup comes in a later commit. Nothing starts a torrent: no `bin/cli.js`, no
`server.js`, no `npm start`.

## 1. One rule for what a segment reads (#ttv-271)

### Tests first

- [x] 1.1 Write `test/no-torrent/segment-reading.test.js` with the cases in specs/segment-reading: the first usable picture, picture index ignored, soundtrack by place, absent soundtrack, mode per track, `trackIds`/`modes` and key order in the interval, `endsWithSource` kept, input not changed.
- [x] 1.2 Run `node --test test/no-torrent/segment-reading.test.js` and check that it fails because the module is missing.

### Implementation

- [x] 1.3 Add `services/media/segment-reading.js` with `trackFor`, `selectTracks`, `readingInterval` and `segmentReading` (design §1).
- [x] 1.4 In `server.js`, replace the selection in `segmentRecordOf` (`:559-568`) with `segmentReading`, and the selection in `resolveEncodeInput` (`:1110-1124`) with `selectTracks` + `readingInterval`. Keep `selected-track-is-absent` before `media-info`, and keep the `selections` index verbatim.
- [x] 1.5 Replace the soundtrack lookup in `stretchCopied` (`:1168`) with `trackFor`.
- [ ] 1.6 Check that no `firstUsable(`, `.type === choice.type` or `candidate.type === "audio"` is left in `server.js`. Then run `npm test`, which includes `biome lint` and the no-torrent check.

## 2. One resolver of a segment's source byte ranges (#ttv-272)

### Tests first

- [ ] 2.1 Write `test/no-torrent/segment-source-ranges.test.js` with the fake orchestrator and container from design §2. Cover:
  - the ranges key, cache hit and miss, and `forget`;
  - `tracksOf`: identity, `needs-index` and pass-through;
  - `shiftOf`: the default shift of 0;
  - `stale` after each await;
  - `readInput` by `source-ranges`, by `packets`, and with `needs-memory`;
  - `resolve`: direct, direct pending (with `whenBuilt`), a direct throw falling back to source ranges, fallback by packets, navigation `needs-memory`, packets `needs-memory`, `needs-source`, and stale before needs-source;
  - the five method names.
- [ ] 2.2 Check that it fails because the module is missing.

### Implementation

- [ ] 2.3 Add `services/media/SegmentSourceRanges.js` (design §2).
- [ ] 2.4 In `server.js`, construct `sourceRanges` and have both closures call it in place:
  - `resolvePlayback` uses `tracksOf`, `shiftOf`, `navigable` and `resolve`;
  - `resolveEncodeInput` uses `tracksOf`, `shiftOf`, `navigable` and `readInput`.

  Then remove `segmentSourceRanges` and its loop in `onSourceForgotten` in favour of `sourceRanges.forget(sourceKey)`.
- [ ] 2.5 Check that every P4.1 `method` and `outcome` string is still produced at the same point. Diff the strings in the old and new code.
- [ ] 2.6 Run `npm test`.

## 3. The download-map pass (#ttv-273)

### Tests first

- [ ] 3.1 Write `test/no-torrent/played-outputs-of.test.js` on `managerWithOwnStore()`. Cover:
  - a watched output;
  - no present consumer;
  - another file;
  - the slowest link;
  - `timeline` identity;
  - `sizes()` read from the store.
- [ ] 3.2 Write `test/no-torrent/playback-resolution.test.js` with the fakes from design §3, a real `SegmentSourceRanges`, the real `segmentReading` and a real `Timeline`. Cover every scenario in specs/playback-resolution:
  - order and staleness (flip `isCurrent` at each await);
  - direct and fallback;
  - pending → held → one `refresh`;
  - `needs-memory`;
  - absent track;
  - cache hits and the record cache after `clear`;
  - two outputs → `source-range-cache`;
  - repeated AVI zones (2.96.11);
  - identity caches;
  - P4.1 fields, including `error`;
  - the minute line.
- [ ] 3.3 Copy `server.js:526-904` from `origin/main` verbatim into `test/no-torrent/support/resolve-playback-before-270.js`, as `resolvePlaybackBefore270({ … })` (design §3).
- [ ] 3.4 Write `test/no-torrent/playback-resolution-equivalence.test.js`:
  - generate a 12 s AVI, MKV and MP4 with `ffmpeg-static` from `lavfi` into a temporary directory;
  - run both sides through the same maps;
  - compare windows and `(outputKey, index, joined)` notes.
- [ ] 3.5 Check that 3.1, 3.2 and 3.4 fail because the module and the port are missing.

### Implementation

- [ ] 3.6 Add `parts.playedOutputsOf` to `services/server/wire-outputs.js`, importing `trackChoicesOf`.
- [ ] 3.7 Add `services/torrent/PlaybackResolution.js`, moving `server.js:540-651` and `675-904` verbatim, with every free variable made a port (design §3).
- [ ] 3.8 In `server.js`:
  - construct `resolution` and pass `resolvePlayback: map => resolution.resolve(map)`;
  - in `setPriorityMap`, call `resolution.clear` instead of `playbackProjections…clear()`;
  - in `onSourceForgotten`, call `resolution.forget`;
  - keep `segmentInputs` in `server.js`.
- [ ] 3.9 Check that `server.js` has none of `playbackProjections`, `segmentReadings`, `choicesKeys`, `checkedGrids`, `madeRates`, `passCosts` or `refreshAfterTable`.
- [ ] 3.10 Run `npm test`. The equivalence test must pass on all three files.
- [ ] 3.11 Once a build containing #273 runs on the Home Assistant host, the field agent records the baseline and after figures (two-hour AVI and MKV, seek, audio switch) on the issue, read from the `/data` logs:
  - `download map passes … longest Nms`;
  - P4.1 outcomes;
  - time to first segment.
- [ ] 3.12 In a follow-up `test(proxy): … #ttv-273` commit on `main`, delete `playback-resolution-equivalence.test.js` and `support/resolve-playback-before-270.js`.

## 4. Media read parameters (#ttv-274)

### Tests first

- [ ] 4.1 Write `test/no-torrent/media-read-params.test.js` with the fakes from design §4. Cover:
  - no file;
  - the parameter fields and their order, and the cut read;
  - the probe URL, `onObserved` (P5/X1/P2), `onTracks` and `onReadStart`;
  - the epoch guard and the `wantsInterval` guard;
  - keyframes learned;
  - refresh only after a finished result;
  - passive `chapters` withdrawal;
  - the three metadata origins;
  - demand withdrawn on abort;
  - `needs-ranges` tracked and released;
  - one tracker per signal and file;
  - an aborted signal;
  - no tracker without a request id.
- [ ] 4.2 Check that it fails because the module is missing.

### Implementation

- [ ] 4.3 Add `services/server/MediaReadParams.js`, moving `server.js:924-1023` verbatim with ports (design §4).
- [ ] 4.4 In `server.js`, construct `mediaParams` where `containerOver` was. Give it lazy `maps` and `baseUrl` arrows, and replace every `containerOver(x)` with `mediaParams.paramsFor(x)`. This includes the `paramsFor` port of `PlaybackResolution` and the preparation, chapters and work-tags call sites.
- [ ] 4.5 Check that no `encodeMetadataRequests` or `containerOver` is left in `server.js`. Run `npm test`.

## 5. Encoder input (#ttv-275)

### Tests first

- [ ] 5.1 Write `test/no-torrent/encode-input-resolution.test.js` with the fakes from design §5. Cover:
  - an undeclared interval;
  - file order;
  - `needs-source`;
  - an absent track as `terminal`, with no `media-info` read;
  - a non-result answer passed through;
  - timing;
  - the stated interval;
  - original input when every file is navigable, packets otherwise, and packets when the format refuses original input;
  - the selection index;
  - packets refused memory;
  - the soundtrack walk from the copy, including a soundtrack already carried, a partial `read`, and a failed walk.
- [ ] 5.2 Check that it fails because the module is missing.

### Implementation

- [ ] 5.3 Add `services/encode/EncodeInputResolution.js`, moving `server.js:1070-1191` verbatim with ports (design §5).
- [ ] 5.4 In `wire-outputs.js`, replace the `resolveEncodeInput` and `stretchCopied` options with `encodeInputResolution`. No test passes the old options to `wireOutputs`: the helpers pass `encodeInputs`, and `input-copy-while-open.test.js` constructs `EncodeInputs` itself. Check this again with `grep -rn 'resolveEncodeInput' test`.
- [ ] 5.5 In `server.js`, construct `encodeInputResolution` and pass it to `wireOutputs`.
- [ ] 5.6 Run `npm test`. `encode-inputs*.test.js` and `segments-are-shared.test.js` must pass with unchanged assertions.

## 6. The output graph first; viewer changes as an event (#ttv-276)

### Tests first

- [ ] 6.1 Write `test/no-torrent/start-playback.test.js` (design §6). Cover:
  - subscribed before adoption (listener count 1);
  - a viewer change calls `preparation`, `maps` and `state` in order;
  - the maps' failure is warned;
  - an adopted segment is seen through `playedOutputsOf(...).sizes()`.
- [ ] 6.2 Add a case to `test/no-torrent/manager-surface.test.js`, or a new `viewer-changes.test.js`, checking that `viewerChanges` emits `"change"` when a viewer becomes present.
- [ ] 6.3 Check that both fail.

### Implementation

- [ ] 6.4 In `wire-outputs.js`, add `parts.viewerChanges = new EventEmitter()`, emit `"change"` in the `Viewers` `onChange`, and remove `onViewerChanged`.
- [ ] 6.5 Add `services/server/start-playback.js` (design §6).
- [ ] 6.6 Reorder `server.js` as in design §6:
  - build the graph first, then destructure `outputParts` once and rename shadowing locals;
  - then `resolution`, `downloadMaps` (with `fileWanted` reading `viewers`) and `const sourcePreparation`;
  - then `startPlayback(…)`;
  - drop `?.` on `sourcePreparation`.
- [ ] 6.7 Check that `server.js` has no `outputPartsReady`, `let sourcePreparation`, `onViewerChanged` or `adoptSegmentsLeftBehind`. Count `outputParts.`, which must be at most 10.
- [ ] 6.8 Run `npm test`.

## 6.5 The rest of the facts and long closures out of server.js (#ttv-280)

After #276, before #277 (torrent-tv/meta#280). Acceptance: the #277 check passes, `wc -l server.js` < 900, and each moved owner has a test written first.

### Tests first

- [ ] 6.5.1 Write `test/no-torrent/preparation-reads.test.js`: fake ports for each work kind the `inspect` closure handles, and `publishNative` (design §6.5 A).
- [ ] 6.5.2 Write `test/no-torrent/forwarded-response-log.test.js`: a Fastify `app.inject` with no `listen`, checking the same `[forecast-http]` and `[http-response]` lines, and nothing logged for other requests.
- [ ] 6.5.3 Write `test/no-torrent/work-tags-report.test.js` (once per file; not for `pending`/`needs-ranges`) and `test/no-torrent/watched-addresses.test.js`.
- [ ] 6.5.4 Extend `test/no-torrent/processor-share.test.js` with `watchedFiles`: grouping by file, the first output's length, summed cost, unwatched outputs skipped.
- [ ] 6.5.5 Write `test/no-torrent/measure-host.test.js` with fake `measures`: call order, software fall-back, nothing measured without `transcode`.
- [ ] 6.5.6 Write `test/no-torrent/subtitle-walk.test.js` (held file, `null` cases, container built once, one walk at a time, `subtitle push` lines) and `test/no-torrent/torrent-pool-ports.test.js` (`null` claimants, `getSourceStats` `null` cases, `fetchWholeFile`, range reads).
- [ ] 6.5.7 Check that every new test fails because its module is missing.

### Implementation

- [ ] 6.5.8 Move the source preparation `inspect` port (`server.js:1442-1536`) and `publishNative` (`:1381-1391`) to `services/server/PreparationReads.js`.
- [ ] 6.5.9 Move the forwarded-response hooks and their `WeakMap` (`server.js:157-214`) to `services/server/forwarded-response-log.js`.
- [ ] 6.5.10 Move `workTagsLogged` (`server.js:1635-1647`) to `services/media/WorkTagsReport.js`.
- [ ] 6.5.11 Move `preparedAddresses` and `watchedAddresses` (`wire-outputs.js:1127-1156`) to `services/viewer/watched-addresses.js`.
- [ ] 6.5.12 Move the `applyDownloadShare` grouping (`wire-outputs.js:777-788`) to `watchedFiles` in `services/storage/processor-share.js`, with the `watched`, `lengthOf` and `encodeCostOf` arrows of design §6.5 A.
- [ ] 6.5.13 Move the startup measurements (`server.js:286-382`) to `measureHost` in `services/encode/measure-host.js`.
- [ ] 6.5.14 Move `heldFileFor`, `pushFreshCues` and the `SubtitleOrchestrator` construction to `services/media/SubtitleWalk.js`.
- [ ] 6.5.15 Move the torrent-pool adapters of the `wireOutputs` call to `torrentPoolPorts` in `services/server/torrent-pool-ports.js`.
- [ ] 6.5.16 Run `wc -l server.js`. If it is 900 or more, continue with the further moves in design §6.5 E, each with its test first, until it is below 900. Record the count in the PR.
- [ ] 6.5.17 Run the #277 check from a local copy of its test (not committed here) and confirm it passes. Leave `biome.json` unchanged. Run `npm test`.

## 7. The check (#ttv-277)

Depends on #276 and #280. It moves nothing.

### Tests first

- [ ] 7.1 Write `test/no-torrent/composition-root-states-no-facts.test.js` (design §7, specs/composition-root). It reads both files as text, imports nothing from `services/`, and reports file, line and reason.
- [ ] 7.2 Run it against `3473cf3` locally: it must refuse what the "Today's code" scenario lists. Record the list in the PR.

### Implementation

- [ ] 7.3 Run it on `main` after #280. It must pass with no exception list.
- [ ] 7.4 Prove the check once:
  - add `const kept = new Map();` to `server.js` and see the test fail, naming that line;
  - revert the change and paste the failure into the PR.
- [ ] 7.5 Leave `biome.json` unchanged. The `wire-outputs.js` exception stays (design §6.5). Run `npm test`.

## 8. Documents and the parent's criteria (#ttv-278)

### Tests first

- [ ] 8.1 Check that `composition-root-states-no-facts.test.js` passes on `main` after #277. It is the standing check this step documents.

### Implementation

- [ ] 8.2 Update `AGENTS.md`:
  - the `server.js` line: what remains (design, "What remains in `server.js`");
  - the `services/` section: each new module with its layer.
- [ ] 8.3 Update `docs/download-architecture.md`: the segment → bytes projection is `PlaybackResolution` over `SegmentSourceRanges` and `segment-reading.js`; cover `playedOutputsOf` and the start order.
- [ ] 8.4 Update `docs/encode-architecture.md`: the encoder input is `EncodeInputResolution`.
- [ ] 8.5 Add no `CHANGELOG.md` entry, unless a log line changed in #271-#277 after all; in that case add a `**Chore**` entry under `## Unreleased`.
- [ ] 8.6 Measure the parent's criteria on `main` and record them in a comment on torrent-tv/meta#270:
  - `wc -l server.js`;
  - the `outputParts.` count;
  - the collection check;
  - CI.
  
  Add the Home Assistant figures from 3.11, or a link to where they will be recorded. "`server.js` < 900 lines" is met by #280; record the count.
- [ ] 8.7 Archive this change: `openspec archive composition-root-owners`.
