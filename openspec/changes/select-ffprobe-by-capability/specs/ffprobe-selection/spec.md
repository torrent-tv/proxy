# ffprobe-selection — delta spec (proxy)

## ADDED Requirements

### Requirement: The ffprobe binary is chosen once, at startup, by capability

The proxy SHALL choose the ffprobe binary it probes with once, before it serves anything. The
candidates are, in this order, the binary bundled by `@ffprobe-installer/ffprobe` (when its
path is known) and `ffprobe` found on PATH. A candidate qualifies when it runs
`ffprobe -hide_banner -sections` and exits 0, and a name in that output, taking the output
apart at whitespace and `/`, equals `stream_side_data` exactly. The first candidate that
qualifies is chosen and no later candidate is run. Each candidate is asked its version
(`ffprobe -version`, the word after `ffprobe version` on the first line) and its sections at most
once. `probePackets` SHALL NOT choose a binary: it takes the chosen one as `ffprobeBin` and
throws `TypeError` when it is missing.

#### Scenario: The bundled binary has the section
- **WHEN** the bundled candidate's sections name `stream_side_data`
- **THEN** it is chosen, and the candidate on PATH is not run

#### Scenario: The bundled binary lacks the section, or cannot run
- **WHEN** the bundled candidate's sections do not name `stream_side_data` (a name that only
  begins with it, such as `stream_side_data_list`, does not count), or it cannot be started, or
  its `-sections` exits non-zero
- **THEN** the candidate on PATH is tried, and chosen if it qualifies

### Requirement: No qualifying ffprobe stops the proxy at startup with one line

When no candidate qualifies, `selectFfprobe` SHALL write exactly one line at level `error`
naming every candidate with its source, its binary, its version (or why it could not be run)
and the missing section `stream_side_data`, and SHALL throw `FfprobeUnavailableError` whose
message is that line. The proxy then does not start. It never starts and refuses each probe
afterwards.

#### Scenario: Nothing qualifies
- **WHEN** the bundled binary is ffprobe 4.4.1 and `ffprobe` is not on PATH
- **THEN** one `error` line names the bundled binary with `4.4.1`, the missing PATH binary with
  the reason it could not be run, and `stream_side_data`, and the startup fails with that message
