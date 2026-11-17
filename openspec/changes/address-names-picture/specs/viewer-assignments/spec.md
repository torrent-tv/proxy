# viewer-assignments — delta spec (proxy)

## ADDED Requirements

### Requirement: A given address names the picture

The record of what was given to a viewer SHALL address an answer by the picture
the request named, the asked height and the segment (the init being segment −1).
The picture is the material identity that `isSameMaterial` compares: the same
value for a picture's base and every step of it, a different value for another
film, container, cut grid, soundtrack or segment format. An address of one
picture SHALL NOT match a request that names another picture, in the same
consumer and the same generation, on the step route or after the picture's own
route recorded it.

#### Scenario: Another picture, same consumer, generation, height and segment
- **WHEN** a viewer was given segment N at height H of picture A in generation G
  and then asks for segment N at height H of picture B in generation G
- **THEN** the request is decided as a new address of picture B and answered by
  B's own output; A's output and A's stored piece are never the answer, and the
  address is not reported lost

#### Scenario: The picture's own route records under the picture
- **WHEN** `noteAnsweredDirectly` records a segment answered by picture A's output
  and the same viewer then asks for the same segment and height of picture B
- **THEN** the record does not answer B's request

### Requirement: A repeat inside one picture is answered by what answered first

A repeat of an address of the SAME picture in the same generation SHALL be
answered by the output that answered it first. When that output has gone, the
repeat is served from the piece stored under its key, then by an output whose
header is proven compatible, else answered `assignment-lost`, as before.

#### Scenario: Repeat while the output is here
- **WHEN** segment N at height H of picture A was answered by output X and is asked again in the same generation
- **THEN** X answers it

#### Scenario: Repeat after the output has gone
- **WHEN** X was disposed and a stored piece for the address exists
- **THEN** the repeat is answered from the stored piece under X's key
