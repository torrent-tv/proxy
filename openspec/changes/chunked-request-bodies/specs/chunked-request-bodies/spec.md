# chunked-request-bodies — delta spec (proxy)

## ADDED Requirements

### Requirement: Request bodies arrive in bounded binary chunks

The proxy SHALL accept a request whose body is delivered as binary frames
(mirroring the response-frame layout) announced by a `request-start`
control message, assemble it, and execute it through the same path as a
single-message request. Assembly SHALL be bounded: a per-body byte cap, a
TTL for incomplete bodies, an abort flag that drops the partial state, and
release of all partial state when the channel closes. Legacy single-message
requests SHALL keep working unchanged.

#### Scenario: Large .torrent registration
- **WHEN** the browser registers a multi-season torrent whose base64 body
  exceeds any single-message limit
- **THEN** the body arrives in frames, the source registers, and the
  response streams back exactly as for a small request

#### Scenario: Oversized or inconsistent body
- **WHEN** the announced or delivered size exceeds the cap, or the
  delivered bytes do not match the announcement
- **THEN** the proxy replies with a response-error for that request and
  drops the partial state; the channel and other requests are unaffected

#### Scenario: Sender vanishes mid-body
- **WHEN** frames stop arriving (tab closed, aborted without a frame)
- **THEN** the partial body is dropped after the TTL (or immediately on
  channel close) and its memory is released
