# adaptive-bitrate — delta spec (proxy)

## ADDED Requirements

### Requirement: Software encodes are bitrate-capped per resolution rung

Software video encodes SHALL carry `-maxrate`/`-bufsize` derived from a
per-rung nominal-rate table (1.3× / 1.5× of the rung's nominal), keeping the
existing CRF/preset quality selection (constrained CRF). The cap follows the
ACTUAL encode height after budget or manual selection.

#### Scenario: Complex scene on a capped encode
- **WHEN** a transcoded scene would spike far above the rung's nominal rate
- **THEN** the produced segments stay bounded by the cap instead of reaching
  multi-megabyte sizes that a thin viewer link cannot download in time

### Requirement: The proxy accepts viewer link reports

A data-channel route SHALL accept periodic reports
`{ linkMbps, bufferedAheadSec }` for an active transcode session and store
the latest report with its arrival time. Invalid bodies are rejected;
unknown sessions get 404; missing reports are not an error condition.

#### Scenario: Old client
- **WHEN** a browser never sends net reports
- **THEN** the session behaves exactly as before this change (plus caps)

### Requirement: The budget loop downshifts on a sustained link deficit

When a fresh report shows the viewer's usable link (reported × safety
margin) sustainedly below the observed produced bitrate AND the viewer's
buffer is low, the existing budget downshift SHALL step the encode one rung
down (same cooldown, step cap and floor as the CPU trigger; no upswitch).
The trigger SHALL be skipped when `manualQuality` is set, when reports are
stale, or when the viewer's buffer is comfortable. The downshift log line
SHALL name the reason (`link`) distinctly from the CPU reason.

#### Scenario: Cellular viewer, stream too fat
- **WHEN** reports show 3 Mbit/s usable link against 6 Mbit/s produced
  bitrate for longer than the slow window, with a draining buffer
- **THEN** the encode steps down one rung and the log shows a link-reason
  downshift

#### Scenario: Slow link but full buffer
- **WHEN** the link is slower than the stream but the viewer's buffer stays
  comfortable (e.g. paused playback filling ahead)
- **THEN** no downshift happens

#### Scenario: Manual quality pinned
- **WHEN** the viewer picked a forced quality
- **THEN** link reports never trigger a downshift
