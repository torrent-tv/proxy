# cold-start — delta spec (proxy)

## ADDED Requirements

### Requirement: Session create reuses the planner's probe

Creating an HLS transcode session SHALL NOT re-probe an input whose media
info the playback planner already probed and cached for the same source and
file. The cached info is used only when its critical fields (duration,
width, height) are present and valid; otherwise the session SHALL probe as
before. Cache lifetime and invalidation follow the plan cache exactly.

#### Scenario: Warm plan, immediate session
- **WHEN** the browser requests a transcode session right after receiving a
  playback plan for the same file
- **THEN** the session starts without a second ffmpeg input scan and its
  playlist/ladder decisions are identical to what the probe would have
  produced

#### Scenario: Cache cannot serve
- **WHEN** no cached media info exists (e.g. proxy restarted between plan
  and session) or a critical field is missing
- **THEN** the session probes the input itself, exactly as before this
  change

### Requirement: The file-body start is warm before the encoder needs it

Once a playback plan probe succeeds, the proxy SHALL prefetch the beginning
of the file body (bounded, ~16 MB) in the background, without delaying the
plan response and without competing with a still-running header probe.

#### Scenario: First segment does not wait for pieces
- **WHEN** the viewer confirms playback within the normal flow (seconds
  after the plan)
- **THEN** the encoder's initial reads are served from already-downloaded
  data and the first segment's production is not blocked on piece download

### Requirement: Session startup is measurable per stage

Session creation SHALL log the media-info acquisition time (and whether it
was cached or probed), the keyframe-probe time when it runs, and — once per
session — the time from session-create entry to the first servable segment.

#### Scenario: Field regression triage
- **WHEN** a tester reports a slow start
- **THEN** the proxy log shows, for that session, where the time went:
  media info, keyframes, or first-segment production
