# seek-run-range Specification

## Purpose
An encoder run is started only inside the input it is given: every stretch handed out holds the piece it is taken for. An output's production ends only on a terminal input fact (`EncodeInputs.failureOf`, `InputFailures.reason`); a failed run without one leaves the output idle and its requests held until a later run makes the piece (torrent-tv/meta#341).

## Requirements

### Requirement: An encoder input holds the piece it is taken for

Every original-input stretch that `EncodeInputs.take(output, from, to, serves)`
returns SHALL satisfy `result.from <= serves <= result.to`.

#### Scenario: A stretch that reaches the piece is handed out as before
- **GIVEN** the input of an output keyed at #187 is ready with the stretch
  #187..#189
- **WHEN** `take(output, 187, 263, 188)` is called
- **THEN** it returns that stretch and prepares nothing

### Requirement: A held stretch that misses the piece is prepared again

When the stretch held for a request ends below the `serves` it is now taken
for, `EncodeInputs` SHALL release it, prepare the request again with that
`serves` without waiting for new bytes, and log `encode input
#<from>..#<to> of <output>: the held stretch #<from>..#<end> does not reach
#<serves>, the piece it is now taken for; prepared again`.

#### Scenario: A stretch prepared for the piece before is taken for the next piece
- **GIVEN** the input keyed at #187 is ready with the stretch #187..#187,
  prepared for `serves` 187
- **WHEN** `take(output, 187, 263, 188)` is called
- **THEN** it returns null, the held stretch is released, the request is
  prepared again with `serves` 188, and the line is logged once
- **AND WHEN** that preparation is ready
- **THEN** `take(output, 187, 263, 188)` returns a stretch with `from` 187 and
  `to` at least 188

### Requirement: A stretch is never sized below the piece it serves

Preparing a stretch SHALL NOT answer a stretch ending below `serves`; while
the stretch through `serves` cannot be stated, the request's answer SHALL be
that resolution's own answer.

#### Scenario: The stretch through the served piece cannot be stated yet
- **GIVEN** a request from #187 serving #188 whose resolution of #187..#188
  answers `needs-bytes`
- **WHEN** the stretch is prepared
- **THEN** the request's answer is `needs-bytes` naming the awaited ranges,
  not a stretch #187..#187

### Requirement: No run is started past its input

The proxy SHALL NOT build an encoder run whose last piece is below its first.

#### Scenario: The start reads from the keyframe before
- **GIVEN** the piece before #188 is being made, so the run for #188 reads
  from the keyframe before, and the input keyed at #187 holds #187..#187
- **WHEN** the plan starts a run at #188
- **THEN** no encoder process is spawned and no run with `to < from` exists
- **AND WHEN** an input reaching #188 is ready
- **THEN** the run is built with `from` 188 and `to` at least 188

### Requirement: Production ends only on a terminal input fact

Where the output has an encode-input owner, its run state SHALL be
`ENDED_FAILED` only when `EncodeInputs.failureOf(output)` answers a terminal
input, or when `InputFailures.reason(outputKey)` names a failed input that will
not be retried and no run of the output is alive. A last run that ended
`ENDED_FAILED` with neither fact SHALL leave the output `IDLE`.

#### Scenario: A run ends short with no input failure recorded
- **GIVEN** an output whose only run ends `EXITED_SHORT` and records no input
  failure, and no terminal input
- **WHEN** a request for a segment of that output that is not on disk arrives
- **THEN** the output's state is `IDLE`, `hasFailed` is false and the request
  is held, not answered 500
- **AND WHEN** a later run publishes the segment
- **THEN** the held request is answered 200 with it

#### Scenario: A held request is not failed by the ending
- **GIVEN** a request for a missing segment is held while the output's only
  run is alive
- **WHEN** that run ends `ENDED_FAILED` with no input failure recorded
- **THEN** the held request is not answered with a failure and stays held

#### Scenario: A terminal input fact still ends production
- **GIVEN** an output whose single-piece input failed and was recorded by
  `InputFailures`, or whose input is terminal in `EncodeInputs`, with no run
  alive
- **WHEN** a request for a segment of that output that is not on disk arrives
- **THEN** the output's state is `ENDED_FAILED` and the request is answered
  500 with `canRetry: false`, as before

### Requirement: A failed run that leaves production going says so

For an ending of the previous requirement that leaves the output `IDLE`, the
proxy SHALL log once `encode: run #<from>..#<to> of <output> ended
ENDED_FAILED (<because>); production goes on — no input failure ends it, so
requests for its pieces stay held`.

#### Scenario: The line is logged only when production goes on
- **WHEN** a run ends `ENDED_FAILED` with no terminal input fact
- **THEN** the line is logged once
- **AND WHEN** a run ends `ENDED_FAILED` with a terminal input fact
- **THEN** the line is not logged
