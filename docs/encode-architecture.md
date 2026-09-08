# Encode architecture — who decides where encoders go

One question, one answer, and the answer is arithmetic.

> Viewers are always independent and always reuse what can be reused. The
> number of encoders is however many are needed; how many are needed follows
> from which sets of output parameters are wanted and where the viewers stand
> inside each. Segments produced by ANY encoder are available to ANY viewer, and
> which viewer asked never enters the question.

## The one authority

`services/encode/EncodePlan.js` decides. Nothing else places an encoder,
nothing else takes one away for scheduling reasons, and there is exactly one
call to `#startEncodeRun` in the whole proxy — the one the plan asks through.

It decides from four things and no others:

| what | where it comes from |
|---|---|
| what is already made | the segment store, asked afresh before every decision |
| what is being made | the coverage map's live claims |
| what is wanted | the priority map of that output |
| how many the machine can hold | `run-budget.js`, from measurements of this host |

**No viewer reaches it.** `services/encode/` and
`services/orchestrators/EncodeOrchestrator.js` do not import the viewer layer,
name a consumer id, or hold a person. What crosses is a priority map: zones of
segment numbers with a rank and a real time, and nobody's name on it.

## Viewers become a map, and that is the whole crossing

```mermaid
flowchart TB
  subgraph V["services/viewer — where people are"]
    VW[Viewer<br/>position, playing, buffered, chosen track]
    VS[Viewers<br/>the relation, indexed from both ends]
  end

  subgraph P["services/priority — one fact, two scopes"]
    PM[PriorityMap<br/>seconds of film to a rank]
    PO[PriorityOrchestrator<br/>merge, publish, keep]
  end

  subgraph E["services/encode — where encoders go"]
    CM[CoverageMap<br/>ready / making / free]
    EP[EncodePlan<br/>argmin over arrangements]
    RB[run-budget<br/>what this host can hold]
    ER[EncodeRun<br/>one process, one interval]
  end

  subgraph D["services/demand + download — what the swarm is told"]
    DR[DemandRegister]
    SS[SwarmSelection]
  end

  VW --> VS
  VS -->|"positions, presence"| PO
  PM --> PO
  PO -->|"per FILE, in bytes"| DR
  DR --> SS
  PO -->|"per OUTPUT, in segments"| EO[EncodeOrchestrator]
  EO --> EP
  CM --> EP
  RB --> EP
  EP -->|"start / stop / move"| ER
  ST[(SegmentStore<br/>the disk)] -->|"what is ready"| CM
```

## Two scopes of one map, and both are right

The map is built from where the viewers are, once, and read at two scopes.

**Per FILE, for the swarm.** The picture, a quality step and a soundtrack of one
film read the same bytes, so every viewer of any of them wants that file's
bytes. This is what `PriorityOrchestrator.mapFor(sourceKey, fileIndex)`
answers, and what is published to the download layer.

**Per OUTPUT, for the encoders.** A person watching 480p wants nothing of the
1080p output at all. This is `mapForOutput(address)`.

One map for both was the second authority over encoders. Handed the film's map,
the plan wanted an encoder on every output of the film; what actually stopped
the ones nobody was watching was the session manager killing them by its own
judgement — and since a viewer moving between steps announces itself, the plan
started them again on the very next pass. Two parties answering "should this
encoder exist" by different rules, several times a second.

An output nobody is on gets a map with **nothing in it**, which is a statement
and not an absence: the walk writes one for every output a session exists for,
including the ones everybody has left. That is how the plan is told to stop what
is on it.

## Which output a person is consuming

A person holds a record on more outputs than they are consuming. The picture is
where their record lives — the browser addresses it, their chosen soundtrack is
written on it, their position is read from it — so they are never let go of it;
but the moment they step down to 480p, the 1080p output is producing for nobody.

That distinction is answered where the two facts meet, and neither layer is
handed the other:

- **which step is on their screen** is a fact about a PERSON, read off the
  viewer as one field;
- **which output a step supersedes** is a fact about the FILM'S SHAPE, answered
  by `LiveOutputs.supersededBy(session, stepOnScreen)`, which takes a plain id
  and has never seen a viewer.

A step, a soundtrack, and a step being warmed are consumed by whoever is
registered on them — everywhere but the picture, a person who stops watching is
let go of, so being known to an output is consuming it. Through a warm-up both
the step on screen and the step being made ready are genuinely produced, which
is the price of the switch not being visible.

## What each of the eight other places used to do

Before 2026-09-08 the plan was one opinion among nine. Each of these placed or
killed encoders by a rule of its own; each now states the fact it knows.

| it knows | it used to do | it now says |
|---|---|---|
| a session was created | start a run at the viewer's position, worked out again | the viewer is placed; the plan reads that |
| a viewer joined further in | start a run there if nothing was being made | as above |
| a step or soundtrack is being warmed | point that session at the switch and start it | this person is at N seconds on it |
| a step was switched to | stop the one left, point the new one | this person is on this step now |
| a step or track was abandoned | stop its encoder | this person has left that output |
| the hardware encoder failed | start a run at the dead one's start | what this host encodes with has changed |
| the input came back | start a run at the last requested segment | decide again |
| the cut table was corrected | restart the members at the measured instant | this run is producing in the wrong place; the instant is in the file's table |
| the bitrate cap changed | restart at where the encoder had got to | this run's arguments are stale |

A **seek** is not in that list because it was already reduced to one thing: it
puts the viewer where they are. The settle timer behind it, its cooldown and its
one-segment backoff are gone — a second debounce on a signal the browser had
already debounced, and every millisecond of it was dead time in front of the
viewer.

## Whether the map is being served in its own order

The zones say what matters most. What the viewer actually waited for is measured
where a viewer measurably waits — the one place in the proxy that holds a
request for a named segment — and recorded against the rank the map gave that
segment **at the moment it was asked for**. It reaches the `encode:` state line
as `served[...]`:

```
served[now 42 wait(s) median 180ms worst 1900ms, soon 6 wait(s) median 90ms worst 240ms, later none]
```

Read it like this:

| what it says | what is wrong |
|---|---|
| long waits at `now` | the urgent zone is not being served first — a fault in whoever acts on the map |
| long waits at `soon`/`later`, none at `now` | the zones are the wrong width: the urgent one too narrow, so the viewer reaches material only ranked "soon" |
| `now none` while the viewer is watching | nothing was ever urgent — the map is not reaching this output |
| a band reading `none` | silence, not a zero, and it is printed as `none` so it cannot be read as "no waits, all good" |

Ranks are collapsed into three bands because the map's own scale is as long as
the film needs — a hundred ranks on a long file — and a hundred-row table says
nothing a reader can hold. The width of `soon` is a tenth of the top rank, which
is the map's own shape (its zones widen geometrically) rather than a threshold
chosen for the table.

The download half is measured the same way and on the same scale, so the two are
comparable: `download-architecture.md`.

## What the master playlist declares, and why it is not cosmetic

`BANDWIDTH` and `AVERAGE-BANDWIDTH` per variant, both measured
(`services/output/rates.js`):

- the average is the file's own length over its duration, exact and known when
  the session is created;
- the peak is the biggest piece produced over the span it covers, and equals the
  average until a piece exists — a ratio invented meanwhile would be the
  fabrication this replaced;
- a re-encoded height is declared at the cap we impose, which is exact;
- a smaller height at the pixel share of the source's rate, which errs high, and
  high is the safe direction.

It used to be `height * height * 3.2`. **The browser sizes its cushion in BYTES
from `BANDWIDTH`**, so a figure five times low makes the cushion five times
shallow: field 2026-09-08, 3.73 Mbit/s declared for a file carrying 18.4, 120 s
asked bought 56 MB — 26 s of that film — and the deepest the browser ever held
was 17.1 s. Inflating it is not the answer either: hls.js compares it against
its own estimate of the link to decide a level is unplayable, and its recovery
then moves level by itself, which does not honour our pinning.

## The objective is the map's own rank order

Not three terms in seconds. One pair per rank the map states, most urgent rank
first, compared position by position:

```
[ late(100), done(100), late(99), done(99), … late(1), done(1) ], bodies, wasted
```

`late(r)` is how long anybody waits past a deadline at rank `r`; `done(r)` is
when the last number of that rank is made. A difference at a higher rank settles
it and nothing lower can reopen it — which is the stated order: nobody stares at
a spinner; then the film in front is encoded as fast as it can be, band by band
as the map ranks them; then, with what is left over and only then, the film
behind, in case somebody seeks back.

**No weights, and none possible.** A weight would let seconds at one rank buy
seconds at another, and it would be a figure nobody measured. The map is the
source of truth about what matters and it already says so — ten ranks on a film,
p100 at the number a viewer is stopped on, doubling zones down to p91 for the far
tail, p1 for what lies behind them.

`bodies` ranks below every rank of the map, so spare capacity cannot buy an
encoder where the map is indifferent. `wasted` is the swarm's bill for anything
fetched twice.

## Three rules that stop an encoder being moved for nothing

**A zone with no deadline never takes a live run.** Residual work — the film
behind the viewers, kept in case somebody seeks back — is done with capacity
that is left over, and a run already standing in front of a viewer is not left
over.

**An act must pay for itself.** Where an arrangement is only reachable by killing
a running encoder, a gain smaller than what the killing costs is not a gain. The
margin is the measured cost of the act.

**The plan remembers what it is already carrying out.** A staying run is priced
at what it still has to go — the measured time to a first piece less the time it
has been alive — not at zero. A run 0.8 s old has 0.14 s left against 0.94 s to
move it; one working half a minute has nothing left, and a move then happens
exactly when the film it would reach sooner is worth the restart.

And what a move costs is `Infinity` until something has been measured: a move is
irreversible and leaving the encoder alone is always available. Placing one where
there is none takes the unknown the other way, because the film gets made or it
does not.

### What all three were for

Field 2026-09-08. The map states `withinSeconds: null` for the film behind the
viewers; `deadlineReaderFor` read it through `Number()`, where `null` is 0, so
that film was due IMMEDIATELY and was the most urgent material in the file. It
bought encoders and it took the run standing in front of the viewer, because
that run was the nearest body to it — 39 moves in one session, 24 of them between
three adjacent numbers about 0.8 s apart. One viewer on a host affording three
runs got three. The picture stood still for 116.7 s in three interruptions, the
worst of them 91.8 s.

The numbers are worth keeping because they are so close: driving from #58 to #59
means making TWO pieces, 1.89 s at 4.45x on a 4.2 s grid, against a cold start
and ONE piece, 0.94 + 0.94 = 1.88 s. Every one of those 39 moves was
individually the cheapest arrangement it was offered. That is the signature of an
optimiser with no memory, and the three rules above are what give it one.

## What is checked

`test/one-authority.test.js` holds the shape: one caller of `#startEncodeRun`,
no encoder stopped for being unwatched, the settle machinery absent, each output
reading its own map, and the soundtrack's start instant read off the table
rather than handed in.

`test/priority-map-per-output.test.js` holds the two scopes, over the real
viewer registry, the real `LiveOutputs` and the real `PriorityOrchestrator`.

`test/encode-plan.test.js` holds the arithmetic, including that every encoder
stops when nobody is watching the output.
