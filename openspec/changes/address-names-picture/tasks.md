# Tasks: The address of "what was given" names the picture

## 1. Implementation (proxy)

- [x] 1.1 `services/encode/quality/serving-output.js`: export the picture key beside `isSameMaterial` (`pictureKeyOf`, defined in `encode/output/OutputSpec.js`, which `isSameMaterial` compares, so the two cannot disagree; the server component may import it only from `encode/output/index.js`).
- [x] 1.2 `services/viewer/Assignments.js`: `addressOf(pictureKey, askedHeight, segmentIndex)`; `give`, `givenFor`, `highestGiven` take the picture key; update the LIMIT comment; state that `chosen` is unchanged because `servingOutputFor` already filters by `#interchangeableWith`.
- [x] 1.3 `services/viewer/choices.js`: `givenOutputOf`, `noteGivenOutput`, `highestGivenSegmentOf` and their `wire` entries pass the picture key.
- [x] 1.4 `services/encode/Renditions.js`: `#givenBefore`, `stillGivenTo`, `resolveVariantFile`, `#answerForLostAddress` and the `highestGivenSegmentOf` call pass the picture key of `base`; one debug line when a record exists under another picture for the same consumer, generation, height and segment.
- [x] 1.5 `services/server/ViewerRequests.js`: `noteAnsweredDirectly` passes the picture key of the output it answered with.
- [x] 1.6 Every other caller (`git grep -n -E 'givenOutputOf|noteGivenOutput|highestGivenSegmentOf|highestGiven|givenFor|\.give\('`), tests and docs included.

## 2. Test plan (torrent-tv/meta#470)

### 2.1 Scope and risk

1. In scope: `services/viewer/Assignments.js`, `services/viewer/choices.js`, `services/encode/Renditions.js` (`resolveVariantFile`), `services/server/ViewerRequests.js` (`noteAnsweredDirectly`), `services/encode/quality/serving-output.js`. All are covered through `Renditions.resolveVariantFile` and `ViewerRequests.noteAnsweredDirectly` over the real `Viewers`, `OutputCatalog` and `viewerRelationsFor`, so the tests do not depend on the internal signatures that change.
2. Out of scope: `chosen`/`servingOutputFor` (already filters by `#interchangeableWith`); the page's generation handling and the hls.js audio offset (issue, "Out of scope"); the debug line of 1.4 (a log text, checked in the field with AC4). Existing tests that call `noteGivenOutput`, `givenOutputOf` and `Assignments` directly change their calls with the signature; their meaning stays (AC2).
3. Depth: HLS delivery to the viewer is high risk (wrong picture with no error): every case of 2.3. No torrent startup is reachable: fakes at every boundary, `refuse-torrent.cjs` loaded.

### 2.2 Types, levels, commands

1. AC1, AC2, AC3: integration level in `test/no-torrent/address-names-picture.test.js` (real `Renditions`, `OutputCatalog`, `Viewers`, `ViewerRequests`; fakes for output creation, stored pieces, header proof):
   `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/address-names-picture.test.js`
2. AC4: end-to-end on the Home Assistant host only (skill `ha-field-check`): open episode A, play past segment 10, open episode B in the same page; pass when B's `[net-debug] sent` byte counts for video segments 3-15 differ from A's of the same numbers and B's page log has no `bufferAppendNoProgress` and no `bufferSeekOverHole` in the first 3 minutes.
3. AC5: `npm test` (lint, then every `test/no-torrent` test).

### 2.3 Cases

| Test | AC | Case |
| --- | --- | --- |
| a segment given for one picture does not answer the same address of another picture | AC1 | positive: A then B, same consumer, generation, height, segment, A's stored piece available; B answered by B's step, no `recover` |
| a segment given for one picture does not make the address of another picture lost | AC1 | negative: no stored piece; B is not `lost` |
| a repeat of an address of the same picture is answered by the output that answered first | AC2 | positive, live output |
| a repeat of an address of the same picture whose output has gone is served from the stored piece | AC2 | `gone` path, same picture |
| the picture's own route for one picture does not make a request for another picture resolve to the first | AC3 | `noteAnsweredDirectly` of A, then B's request |

Boundary values: segment 5 and 7 (mid-film). Not covered: the init (-1) and `highestGiven` per picture (same address function as the segments; checked by the existing `viewer-assignments` tests after their signature change); a soundtrack (records nothing, unchanged).

### 2.4 Rules and exit

1. Expected failure before the code: AC1 tests, `sessionId` is `null` with `recover` set (A's stored piece) or `lost` set, expected B's step id; AC3 likewise. The AC2 tests pass before the change by design: they are the guard that the fix keeps them true. All five are marked `todo` with their AC id; the implementer's commit removes the markers.
2. No timers, no network, no files; every output is a plain object.
3. Exit: `npm test`.
