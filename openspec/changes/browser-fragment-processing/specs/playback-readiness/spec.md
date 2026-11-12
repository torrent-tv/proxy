# playback-readiness — delta spec (proxy)

## ADDED Requirements

### Requirement: A fragment's browser processing is measured from the page's own samples

For each output track the forecast SHALL derive a processing rate from the
page's reported samples: for every fully buffered media fragment whose appends
all carry an execute span, its work SHALL be its parse span, clipped to start no
earlier than the end of its load, plus the largest per-SourceBuffer sum of the
execute spans of its appends. The track's rate SHALL be the total work over the
total bytes of those fragments. Time before a fragment's load ended SHALL NOT
count as processing, and an append's queue or block wait SHALL NOT count.

#### Scenario: Parse that started during the load is clipped
- **GIVEN** a fragment of 1500 bytes whose load ended 1000 ms before the
  snapshot, whose parse started 1100 ms and ended 900 ms before it, and whose
  one append executed in 50 ms
- **WHEN** the rate is derived
- **THEN** its work is 100 + 50 = 150 ms and the rate is 0.1 ms per byte

#### Scenario: A muxed fragment appends to two buffers in parallel
- **GIVEN** a main fragment parsed in 10 ms whose appends executed 20 ms and
  30 ms on the picture buffer and 15 ms on the sound buffer
- **WHEN** the rate is derived
- **THEN** its work is 10 + max(50, 15) = 60 ms

#### Scenario: Samples that do not show the work are not used
- **GIVEN** fragments without a buffered end, without parse marks, with no
  matching append, or with an append lacking its execute span
- **WHEN** the rate is derived
- **THEN** none of them contributes, and with no usable fragment the track is
  `browser-processing-unmeasured`

### Requirement: The schedule charges processing after delivery and before the track's next request

Each scheduled fragment SHALL be in the page at its delivery time plus its
bytes times its track's rate. The track's next transfer SHALL NOT start before
that time; the shared link SHALL remain available to the other track
meanwhile. The suffix after the near window SHALL NOT finish a track before its
own transfer at the full link rate plus its own processing.

#### Scenario: Transfer and processing are added once
- **GIVEN** a fragment whose transfer ends 2 s from now and whose processing
  takes 1 s
- **WHEN** the schedule is made
- **THEN** it is in the page at 3 s

#### Scenario: The next fragment of the track waits for processing
- **GIVEN** two ready fragments of one track, each transferred in 1 s and
  processed in 0.5 s
- **WHEN** the schedule is made
- **THEN** they are in the page at 1.5 s and 3 s

#### Scenario: The other track uses the link during processing
- **GIVEN** a ready picture fragment and a ready sound fragment, each
  transferred in 1 s, the picture processed in 0.5 s
- **WHEN** the schedule is made
- **THEN** the sound fragment's transfer is not delayed by the picture's
  processing

### Requirement: An unmeasured term is named, not assumed

When a track has no usable sample the forecast SHALL charge no processing for
it, SHALL keep computing the start, and SHALL state
`browser-processing-unmeasured` for that track in its result and log line.

#### Scenario: A cold start before the first fragment is buffered
- **GIVEN** no fragment sample from the page
- **WHEN** the forecast runs
- **THEN** the delay equals the delay without the term and the result names
  the track as `browser-processing-unmeasured`
