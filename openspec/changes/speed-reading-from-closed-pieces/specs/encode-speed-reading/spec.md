# encode-speed-reading — delta spec (proxy)

## ADDED Requirements

### Requirement: A speed reading is the film of the pieces a run closed

When an encoder run publishes a piece, its speed reading SHALL be the film
between the end of that piece on the output's timeline and the end of the
piece of its previous reading (the run's own start for its first reading),
divided by the run's own working time between the moments the encoder named
those pieces closed (the run's start for the first). Input waits and stops
SHALL NOT count as working time. `-progress` reports SHALL NOT enter the
reading.

#### Scenario: A one-piece copy whose last input read ends after most of the piece was reported
- **GIVEN** a run starting at 93.750 s whose piece #9 ends at 104.167 s, whose
  input reads wait 0.4 s in all, whose progress reports say 10.40 s of film
  before its last input read is answered, and which names #9 closed 1.684 s
  after it was made
- **WHEN** #9 is published
- **THEN** the reading is 10.417 s of film over 1.284 s of work (8.11x), not
  the film reported after the last input read

#### Scenario: A one-piece copy whose last progress report predates the close
- **GIVEN** the same run, whose only progress report before publication says
  0.04 s of film
- **WHEN** #9 is published
- **THEN** the reading is the same 10.417 s over 1.284 s

#### Scenario: Later pieces are measured between closes
- **GIVEN** a run that published #4 (ending 40 s) at 2.0 s of work and names
  #5 (ending 50 s) closed at 3.0 s of work
- **WHEN** #5 is published
- **THEN** the reading is 10 s of film over 1.0 s of work

#### Scenario: A piece whose end is unknown is not a reading
- **GIVEN** the end of the published piece on the timeline is unknown
- **WHEN** it is published
- **THEN** no reading is taken and no speed is reported to the cost

### Requirement: The first reading of a run is logged with its figures

Each run SHALL log once, at its first reading,
`encode-run #<from>..#<to> on <address>: first speed reading <s>x —
<film>s of film to the close of #<index> over <working>s of its own work,
<idle>s waiting for input or stopped left out`.

#### Scenario: The line is said once
- **GIVEN** a run that publishes three pieces
- **WHEN** each is published
- **THEN** the line is logged once, for the first

### Requirement: A copy measured fast is not refused on an idle machine

With no encoder alive and no output holding a place, an output whose price
comes from readings of §1 SHALL be admitted when that price, corrected for
availability, gives at least realtime.

#### Scenario: The field case of 2026-11-10
- **GIVEN** the copy of `Below.S01E01` was learned only from the one-piece run
  of the first scenario, with 16 % of the machine left to encoders when it was
  read, and the machine now has 83 % to spare
- **WHEN** a viewer opens that copy output
- **THEN** `admitsWatching` admits it and no 409 is answered
