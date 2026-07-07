# disk-cap — delta spec

## ADDED Requirements

### Requirement: Total torrent data is bounded by a disk cap
The pool SHALL keep the total downloaded torrent footprint under a cap. When
the total exceeds the cap it SHALL evict whole torrents that have no active
file reader, least-recently-used first, removing each with its on-disk store,
until back under the cap or no evictable torrent remains. A torrent with an
active reader SHALL NEVER be evicted. The cap SHALL default to the smaller of
10 GB and half the free disk, and be overridable (0 disables).

#### Scenario: Idle torrents evicted under pressure
- **WHEN** the total downloaded data exceeds the cap and some torrents have no
  active reader
- **THEN** the least-recently-used idle torrents are removed with their stores
  until the total is back under the cap

#### Scenario: Active torrent protected
- **WHEN** the cap is exceeded but the only large torrent is currently playing
- **THEN** it is not evicted (the cap cannot delete in-use data)

#### Scenario: Cap disabled
- **WHEN** the cap is set to 0
- **THEN** no eviction occurs
