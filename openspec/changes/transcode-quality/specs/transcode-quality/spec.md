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
