# track-selection — delta spec

## ADDED Requirements

### Requirement: The playback plan lists every track
The playback plan SHALL include `audioTracks` and `subtitleTracks` arrays
parsed from the probe: for each track its type-relative index (what
`-map 0:a:N` / `0:s:N` selects), codec, language tag, `title` metadata,
default disposition, and — for subtitles — a `textBased` flag. Output-side
streams of the probe run MUST NOT leak into the inventory.

#### Scenario: MKV with an embedded subtitle
- **WHEN** the plan is requested for an MKV with one video, one audio and one
  ASS subtitle stream
- **THEN** the plan lists exactly one audio track and one subtitle track with
  `textBased: true`

### Requirement: Audio track selection
`POST /api/transcode-sessions` SHALL accept `audioTrackIndex` (type-relative,
default 0) and the session SHALL map that audio track. The index SHALL be
part of the session identity so different tracks never share a session.

#### Scenario: Second audio track
- **WHEN** a session is created with `audioTrackIndex: 1`
- **THEN** ffmpeg maps `0:a:1` and a later request with `audioTrackIndex: 0`
  gets a different session

### Requirement: Embedded subtitles as WebVTT
`GET /api/subtitles?sourceKey&fileIndex&trackIndex` SHALL stream the chosen
embedded TEXT subtitle track converted to WebVTT, starting the response as
soon as ffmpeg produces output. A track that produces no output (image-based
or broken) SHALL return 422 before any body. Extraction MUST stop when the
client disconnects.

#### Scenario: Text track extracted
- **WHEN** the client requests a text subtitle track
- **THEN** the response is `text/vtt` starting with `WEBVTT` and real cues

#### Scenario: Image-based track refused
- **WHEN** the client requests a PGS/VobSub track
- **THEN** the proxy responds 422 with an explanatory error
