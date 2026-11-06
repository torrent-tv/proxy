# segment-reading Specification

## Purpose
TBD - created by archiving change composition-root-owners. Update Purpose after archive.

## Requirements

### Requirement: One rule finds the track a choice names

`services/media/segment-reading.js` SHALL export `trackFor(trackList, choice)`.
For a `video` choice it MUST return `ContainerTrack.firstUsable(trackList,
"video")` and ignore `choice.index`; for any other type it MUST return the
track at `choice.index` among the tracks of `trackList` whose `type` equals
`choice.type`, in list order, and `null` when there is none. The module MUST
import nothing but `./tracks/ContainerTrack.js` and MUST keep no state.

#### Scenario: The picture is the first usable video track

- **WHEN** `trackList` holds a video track with `isEnabled: false`, then a
  video track with `declaredIndex: 1`, and `trackFor(trackList, { type:
  "video", index: 0, mode: "copy" })` is called
- **THEN** the second video track is returned, the same object as in
  `trackList`

#### Scenario: The picture's choice index does not matter

- **WHEN** `trackFor` is called with `{ type: "video", index: null }` and with
  `{ type: "video", index: 0 }` on the same list
- **THEN** both calls return the same track

#### Scenario: A soundtrack is chosen by its place among soundtracks

- **WHEN** `trackList` is `[video#1, audio#3 (declaredIndex 0), audio#4
  (declaredIndex 1)]` and `trackFor(trackList, { type: "audio", index: 1 })` is
  called
- **THEN** the track with `trackNumber` 4 is returned

#### Scenario: An absent soundtrack

- **WHEN** `trackFor(trackList, { type: "audio", index: 2 })` is called on a
  list with two soundtracks
- **THEN** `null` is returned

### Requirement: The tracks of a segment are selected once

`selectTracks(trackList, choices)` SHALL return `{ wanted, modes }` where
`wanted` holds `trackFor(trackList, choice)` for each choice in choice order
and `modes` is a `Map` from each wanted track to its choice's `mode`. It MUST
return `null` when any choice finds no track.

#### Scenario: Mode per track

- **WHEN** `selectTracks(trackList, [{ type: "video", index: 0, mode: "copy" },
  { type: "audio", index: 1, mode: "transcode" }])` is called
- **THEN** `wanted` is `[video track, second soundtrack]`, `modes.get(video
  track) === "copy"` and `modes.get(second soundtrack) === "transcode"`

#### Scenario: One absent track makes the whole selection absent

- **WHEN** one of the choices names a soundtrack the file does not have
- **THEN** `selectTracks` returns `null`

### Requirement: The interval a segment states

`readingInterval({ wanted, modes }, sourceInterval)` SHALL return a new object
whose keys are, in order, those of `sourceInterval`, then `trackIds` (the
wanted tracks' `trackNumber`s), then `modes` (each wanted `trackNumber` to its
mode). `segmentReading(trackList, choices, sourceInterval)` SHALL return `{
wanted, modes, interval }`, or `null` when `selectTracks` returns `null`.

#### Scenario: trackIds and modes in the interval

- **WHEN** `segmentReading(trackList, [{ type: "video", index: 0, mode: "copy"
  }, { type: "audio", index: 0, mode: "transcode" }], { from: 4, to: 8 })` is
  called on `[video#2, audio#3]`
- **THEN** `JSON.stringify(result.interval)` is
  `{"from":4,"to":8,"trackIds":[2,3],"modes":{"2":"copy","3":"transcode"}}`

#### Scenario: The end of the source is kept

- **WHEN** `sourceInterval` is `{ from: 8, to: 12, endsWithSource: true }`
- **THEN** `interval.endsWithSource === true` and its key comes before
  `trackIds`

#### Scenario: The interval does not alter its input

- **WHEN** `readingInterval` returns
- **THEN** `sourceInterval` has no `trackIds` or `modes` key

#### Scenario: No interval for an absent track

- **WHEN** `segmentReading` is called with a choice that finds no track
- **THEN** it returns `null`

### Requirement: Both call sites use the one rule

The download-map pass and the encoder input SHALL select tracks only through
these functions; no other copy of the selection rule MAY remain in
`server.js`, `services/torrent/PlaybackResolution.js` or
`services/encode/EncodeInputResolution.js`. The encoder's ffmpeg selection
index of an original input MUST stay `track.declaredIndex ?? choices.find(choice
=> choice.type === track.type)?.index ?? 0`.

#### Scenario: No second copy

- **WHEN** `server.js`, `PlaybackResolution.js` and `EncodeInputResolution.js`
  are searched for `firstUsable(`, `.type === choice.type` and
  `candidate.type === "audio"`
- **THEN** there is no match

#### Scenario: The soundtrack walk uses the rule

- **WHEN** the encoder looks up another output's soundtrack to walk its
  packets from a copy
- **THEN** it calls `trackFor(tracks, { type: "audio", index:
  spec.audio.trackIndex })`

#### Scenario: The layer rule holds

- **WHEN** `npx biome lint` runs
- **THEN** `services/media/segment-reading.js` passes the `services/media/*.js`
  rule

### Requirement: Each call site keeps its answer to an absent track

When the shared functions answer `null`, the pass SHALL record P4.1 outcome
`segment-reading-unavailable` and mark the segment unreadable, and the encoder
SHALL return `{ kind: "terminal", reason: "selected-track-is-absent" }` before
it reads `media-info`.

#### Scenario: The pass

- **WHEN** a played output names a soundtrack the file does not have
- **THEN** its segments end `segment-reading-unavailable` and
  `projection.setUnreadable` is called for each

#### Scenario: The encoder

- **WHEN** an encoder run names a soundtrack the file does not have
- **THEN** it returns `selected-track-is-absent` and `media-info` is not
  inspected
