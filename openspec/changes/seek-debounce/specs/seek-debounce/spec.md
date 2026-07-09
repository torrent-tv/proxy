# seek-debounce — delta spec (proxy)

## ADDED Requirements

### Requirement: Scattered post-seek segment requests collapse to one restart

When segment requests land outside the running encode's look-ahead window
(server-side seeks), the proxy SHALL NOT restart ffmpeg on each one. It SHALL
wait a short settle period, treating further out-of-window requests as
re-arming the period and updating the target to the most recently requested
index, and then restart the encoder exactly once at the settled target. A
fixed cap SHALL bound the total settle wait so a genuine seek is not delayed
indefinitely while the scrubber is still moving. During the settle the
segment route behaves as before (long-poll / client retry).

#### Scenario: Scrub emits a burst of scattered requests
- **WHEN** a player, after a seek, requests several far-apart segments in
  quick succession (e.g. 367, 732, 369, 368, 370)
- **THEN** ffmpeg is restarted only once, at the last requested index, and
  produces a continuous run from there — no ping-pong between positions

#### Scenario: Settle resolves on the wrong position
- **WHEN** the settled restart target turns out not to be where the player
  ultimately needs to play (e.g. it was a lone probe request)
- **THEN** the player's next out-of-window request arms exactly one more
  settle and one more restart — never an unbounded restart loop

#### Scenario: Request falls back inside the window
- **WHEN** a requested segment is within the current run's look-ahead window
- **THEN** it is served by the running encode with no restart and without
  affecting any pending settle

### Requirement: A pending settle never outlives its session

When a session is disposed, any pending settle timer SHALL be cleared so it
cannot fire and restart a disposed session.

#### Scenario: Session disposed mid-settle
- **WHEN** a session with a pending seek-settle timer is disposed (idle TTL,
  shutdown, or teardown)
- **THEN** the timer is cleared and no encode restart occurs afterwards
