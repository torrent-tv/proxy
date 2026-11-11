# loopback-forward Specification

## Purpose
TBD - created by archiving change loopback-forward. Update Purpose after archive.

## Requirements

### Requirement: One owner forwards relayed requests to loopback

The proxy SHALL forward every request relayed from a remote peer to its local
HTTP server through `services/transport/loopback-forward.js`, which refuses
paths outside the browser route set and bodies over 32 MiB before opening a
connection, and uses no header or body timeout.

#### Scenario: Loopback-only route is refused
- **WHEN** a relayed request asks for `/encode-input/1/0` or `/media?…`
- **THEN** it is refused with "Invalid request path." and no connection to
  the local server is opened

#### Scenario: Oversized body is refused
- **WHEN** a relayed request carries a body larger than 32 MiB
- **THEN** it is refused with "Request body too large." and no connection is
  opened

#### Scenario: Cut-off answer is not reported complete
- **WHEN** the local server's response body fails after some bytes
- **THEN** the data channel sends a `response-error` for that request and no
  done frame
