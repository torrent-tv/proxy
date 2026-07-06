# observability — delta spec

## ADDED Requirements

### Requirement: Health endpoints report the version
`GET /healthz` and `GET /health` SHALL include the running proxy version
(from package.json) alongside the existing `ok` field.

#### Scenario: Version visible remotely
- **WHEN** a client requests `/healthz`
- **THEN** the response contains `ok: true` and the exact npm package version
  of the running proxy

### Requirement: Peer-discovery diagnostics
The proxy SHALL log, per torrent: an added line with file count, `private`
flag and tracker count; every torrent-level warning (tracker rejections and
errors surface as warnings); and each tracker announce response with the
seeder/leecher counts returned. Logging failures MUST NOT affect playback
(best-effort, defensive against WebTorrent internals).

#### Scenario: Zero-peer torrent is explainable
- **WHEN** a torrent sits at zero peers
- **THEN** the log shows either the tracker's rejection/warning text or an
  announce response with zero seeders — distinguishing "tracker refused us"
  from "the swarm is empty"

### Requirement: No SSDP listener warnings
Port mapping SHALL NOT flood the log with `MaxListenersExceededWarning`
regardless of how many ports one mapper maps or renews.

#### Scenario: WebRTC UDP range mapping
- **WHEN** the UDP mapper maps its 10-port range and later auto-renews it
- **THEN** no MaxListenersExceededWarning lines appear in the log
