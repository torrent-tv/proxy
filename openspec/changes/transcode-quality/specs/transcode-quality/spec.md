# transcode-quality — delta spec

## ADDED Requirements

### Requirement: Output frame rate follows the source
When re-encoding video, the proxy SHALL NOT force a fixed 24 fps. The output
rate SHALL follow the source, and the fps handling SHALL depend on how the
chosen encoder places keyframes:

- Frame-count-GOP encoders (software libx264, v4l2m2m) SHALL use an INTEGER
  output rate — source rate rounded and capped — with the `fps` filter and
  the GOP length (`segmentDuration × fps`) using that same integer, so a
  keyframe lands on every segment boundary and segments do not drift off the
  synthetic playlist's uniform grid. When the source rate is unknown they
  SHALL fall back to the default rate.
- Time-based-keyframe encoders (nvenc, vaapi, qsv) SHALL inherit the exact
  source rate with no fps filter (their keyframes are forced by output time,
  so any rate segments correctly); no rounding, no cap.

#### Scenario: 25 fps source on the software encoder
- **WHEN** a 25 fps video is re-encoded with libx264 and 4-second segments
- **THEN** the output is 25 fps and the GOP is 100 frames (keyframe every
  segment)

#### Scenario: High-fps source on the software encoder
- **WHEN** a 60 fps video is re-encoded with libx264/v4l2m2m
- **THEN** the output rate is capped at 30 fps (speed guard)

#### Scenario: Fractional source on a hardware time-based encoder
- **WHEN** a 23.976 fps video is re-encoded with nvenc/vaapi/qsv
- **THEN** the exact source rate is kept (no fps filter) and segments are
  still cut on time

#### Scenario: Unknown source rate
- **WHEN** the source frame rate cannot be probed on the software path
- **THEN** the output falls back to the default rate and playback still
  segments correctly

### Requirement: Software encode fits a realtime budget at startup

For the software encoder, the proxy SHALL choose the output resolution and
libx264 preset a startup benchmark predicts this host can encode faster than
realtime (with a margin), rather than always encoding at the client-requested
resolution. The client-requested box, capped to the source resolution (never
upscaled), is the ceiling; the proxy SHALL pick the highest resolution rung at
or below that ceiling that clears the realtime margin, then the highest-quality
preset that still clears it at that resolution. When even the lowest rung
cannot clear the margin, the proxy SHALL use the lowest rung (best effort). The
realtime need SHALL be computed from the session's actual output frame rate.
Hardware encoders and the no-benchmark case SHALL keep the ceiling resolution
and the default preset.

#### Scenario: Weak host, source above realtime capacity
- **WHEN** the software benchmark shows the host cannot encode the source-capped
  resolution faster than realtime (e.g. 720p60→30 that runs below 1×)
- **THEN** the proxy downscales to the highest ladder rung that clears the
  realtime margin (e.g. 480p) instead of encoding sub-realtime at full size

#### Scenario: Capable host
- **WHEN** the benchmark shows ample headroom at the ceiling resolution
- **THEN** the proxy keeps the ceiling resolution and spends the headroom on a
  higher-quality (slower) preset

#### Scenario: Hardware encoder
- **WHEN** a hardware encoder is selected
- **THEN** no benchmark-based downscale is applied and the ceiling resolution
  is used

### Requirement: Software encode downswitches at runtime when CPU-bound

The proxy SHALL, for the software encoder, step the output resolution one rung
down the ladder and restart the encode at the segment currently being watched
when a transcode runs below realtime for a sustained window. Before downscaling
it SHALL determine whether the limit is the encoder or a download-starved
input — comparing the torrent download rate with the source's average byte rate
(a fully-downloaded file is never download-bound) — and SHALL NOT downscale when
the limit is the download (it SHALL log that instead). The downswitch SHALL be
bounded by a sustained-slow window, a post-action cooldown, a maximum number of
steps, and a resolution floor, and SHALL reset its slow window on every encode
(re)start. There SHALL be no automatic upswitch in this version.

#### Scenario: Sustained CPU-bound transcode
- **WHEN** a software transcode's encoder speed stays below realtime for the
  sustained window while the input download keeps up
- **THEN** the proxy downscales one rung and restarts at the current segment,
  up to the step cap / resolution floor

#### Scenario: Download-limited, not CPU-limited
- **WHEN** the encoder speed is below realtime but the torrent cannot download
  the source's byte rate and the file is not fully downloaded
- **THEN** the proxy does not downscale and logs that the download is the limit

#### Scenario: No thrash after a switch
- **WHEN** a downswitch (or a viewer seek) has just restarted the encode
- **THEN** the slow window is reset and no further downswitch occurs until a new
  sustained-slow window elapses after the cooldown

### Requirement: Manual quality forces a constant resolution

The viewer SHALL be able to force a specific output resolution instead of Auto.
When a resolution is forced the proxy SHALL encode exactly that box (capped to
the source, never upscaled) with the realtime budget disabled — no startup
auto-downscale and no runtime downswitch — so the resolution stays constant for
the whole session. The browser SHALL offer Auto plus resolutions at or below the
source height, built from the source resolution reported in the playback plan.
Selecting a quality SHALL re-open the stream at the new resolution with the
playback position preserved. Auto SHALL keep the current realtime-budget
behaviour.

#### Scenario: Forced resolution is constant
- **WHEN** the viewer forces a resolution (e.g. 480p)
- **THEN** the proxy encodes at that resolution for the whole session, with no
  budget downscale or runtime downswitch, and playback resumes at the same
  position

#### Scenario: Auto
- **WHEN** the viewer selects Auto
- **THEN** the proxy applies the realtime budget (startup selection + runtime
  downswitch) as before
