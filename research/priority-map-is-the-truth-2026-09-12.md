# The priority map is the only statement of what is wanted

Measurements and decisions behind the work listed in the roadmap as "the
priority map is the only source of truth about what is wanted". Written
2026-09-12, extended as the steps land.

Everything below is tagged by where it comes from: READ (from the source),
MEASURED (a number produced here), DECIDED (agreed with the user), or REFUSED
(considered and not built, with the reason).

## Why 2.83.1 stopped playback — READ

The map is built by `PriorityOrchestrator.publishFor`, and its only input is the
live SESSIONS (`hls-session-manager.js` hands it `sessionGroups`). A session
exists once a file has been chosen and its playback plan built. The torrent,
however, is added on `POST /api/sources/:key/warm`, while the person is still
reading the list of episodes.

So there is an interval in which the map cannot say anything at all, and in it
"the map wants nothing" is indistinguishable from "there is nobody to ask yet".
The field record of 2026-09-11 lies entirely inside that interval: added
20:57:17, first peer 20:57:18, out of the swarm 20:57:21 with 741 connections
let go.

## The same fault with the opposite sign — READ

When the last viewer of a file leaves, `publishFor` deletes that file's map from
its own memory and publishes NOTHING:

```js
for (const key of [...this.#maps.keys()]) {
  if (!byFile.has(key)) { this.#maps.delete(key); this.#last.delete(key); }
}
```

`applyPriorityMap` withdraws a file's claimants only when it is CALLED, so the
demand register keeps that file's zones for the life of the torrent — nothing
else removes them but `forgetTorrent`, which runs when the torrent is removed
altogether.

Both ends are therefore broken: today the map can say neither "wanted" nor "not
wanted". That is what has to be fixed before the register can be believed by
anybody.

## The register alone cannot be asked — READ

A read states a claim only while it is STOPPED on a missing piece
(`piece-reader.js:765`, `Urgency.BLOCKED`) and withdraws it when the read ends
(`:1052`). So an empty register routinely means "at this instant everybody has
what they need", not "nobody wants this". A swarm rule built on the register
alone would release and rejoin repeatedly. The stable statement is the map,
which holds while people are there.

## No viewer-to-torrent link is needed — DECIDED

A session carries `sourceKey`, and the map is addressed by source and file. So
"is anybody here for this source" is already answered by any file of it having a
non-empty map. A second holder of that same relation would be the two-owners
fault this work removes, in a new place.

## What is in a torrent, as one statement — MEASURED

`services/torrent/Contents.js`, validated against the survey collection in
`Dropbox/trn` on 2026-09-12 (137 files, 134 parsed):

| | |
|---|---|
| torrents parsed | 134 |
| of them with more than one picture | 44 |
| items (pictures with what belongs to them) | 1357 |
| files paired to a picture | 421 |
| files paired to more than one picture | 0 |
| largest torrent | 265 pictures |
| items whose grouping differs from the per-picture call it replaces | 0 |

The last row is what says this is a move rather than a change: every one of the
1357 groupings agrees with `matchSidecarFiles` asked the old way, one picture at
a time.

The largest figure matters to the step that follows: a pack of 265 pictures is
why the edges are claimed one item at a time rather than for the whole list —
two pieces outstanding at a time, and the order is what bounds the cost.

## Telling an episode from an extra — REFUSED

Proposed, measured, and not built.

**Words.** `sample|trailer|extras?|bonus|preview|teaser|making|interview|
deleted|featurette` as whole tokens against every video path of the 134
torrents: **four matches, all four false**. Three are the word "making" inside
ordinary episode titles ("Making cash with her pussy", "Perfect pleasure making
pussy") and their sizes are 0.84 to 2.35 of their torrent's median, i.e. they
are the content. Not one real `Sample/` file exists in the collection, so the
rule cannot even be validated here — that is a property of this collection, not
a claim that extras do not exist.

**Size.** The ratio of each video to the median of the videos in its own torrent
runs continuously from 0.0000 to 1.0 with no gap anywhere: 53 videos sit under a
quarter of their median, and they are short clips that ARE what the torrent is
for (`REX1080_<name> - 720P_4000K_….mp4`, 6-23 MB, in collections of them). Two
shapes are genuinely not content — `preview1..5.mp4` in one torrent, and
`VIDEO_TS/VIDEO_TS.VOB` plus `VTS_01_0.VOB`, which are a DVD's menu and a
structure question rather than a size one.

So there is nothing here to derive a threshold from, and an invented one would
decide the order in which a stranger's bandwidth is spent. Every picture is an
item. The survey script is `scratchpad`-only and is reproduced by walking the
collection with `parse-torrent` and the two functions named above.

## Two classifications of one torrent, and they have already diverged — MEASURED

The browser classifies the file list itself (`public/domain/torrent-parser.js`,
`VIDEO_EXTENSIONS`, `classifyMediaFiles`, `orderForDisplay`) and the proxy does
it again (`services/torrent/files.js`). Compared 2026-09-12: the browser offers
`.dat` as video and the proxy does not count it, every other extension agreeing.
On such a torrent the person is offered a file the proxy does not consider a
picture, and `countVideoFiles` answers 0 — which also changes the one-picture
relaxation in the pairing.

One fact, one owner: the proxy owns the composition and the file-list route
returns it. The cost is one round trip for a `.torrent` the browser parsed
locally; the proxy holds those same bytes from registration, so it can answer
without the swarm.

## What the pool asks now, and the two things it no longer counts — DECIDED

One question: **is anything wanted of this torrent**, answered from the register
(`isWanted`). It is true from the moment a torrent is opened, because a torrent
with no file list yet cannot be stated about and is being fetched precisely
because somebody asked for it; and it becomes false exactly when the last
viewer leaves, because that is when the map is published with nothing in it.

Two facts decide the swarm, and they are separated from the doing
(`swarmDecisionFor`) because this is the rule that has failed twice in the
field:

| wanted | ever wanted | swarm | idle clock |
|---|---|---|---|
| yes | — | take | stopped |
| no | yes | let go | running |
| no | no | leave alone | running |

The last row is the 2.83.1 failure as a rule rather than as a mechanism: a
torrent nobody has ever wanted is one being OPENED, and taking its swarm away
there destroys the connections it will need a minute later.

**Leaving on `done` was considered and NOT built.** A complete torrent can want
nothing from a swarm, and the field case of 596 connections was exactly that.
But a piece can be lost after the fact — the disk tier discards pieces under
its own cap — and rejoining would then need a trigger nothing states today, so
the failure mode is a read that waits for ever. The complete-file case is
already answered from two directions: the upload policy refuses to seed when
nothing anybody asked for is missing, and `keepWholeFiles` destroys a torrent
whose every file has been written out whole.

**What is accepted as narrowed, and stated so it is not discovered as a
surprise.** A read that is flowing states nothing — it is reading bytes that
are present — so a torrent is no longer held by the mere existence of a read.
Three cases were checked: a `/stream` read belongs to a session whose map is
live; the subtitle walk reads only what is downloaded; the background fill of a
sidecar is covered by that file's ends. What is left is the disk cap evicting a
torrent whose read is in flight during a moment when nothing is stated for it.
The eviction order is the mitigation rather than a guard: candidates are sorted
by when they were last WANTED, so a torrent an encoder is reading sorts last
among them.

**A torrent is on the idle clock from the moment it exists.** Until now the only
thing that ever started that clock was a reader letting go, so a file list
fetched and never played was held for the life of the process.

## What the review of this work caught — READ

Two defects, both found by reading the finished code rather than by a test, and
both fixed with a check apiece.

1. **A warm-up could take the urgency away from a plan somebody was waiting
   for.** The two ends of a file are stated by whoever asks for them, and there
   are two such callers: the playback plan, which a person is watching a loading
   screen for, and the warm-up, which by its whole purpose nobody is waiting
   for. The warm-up fires off the files beside the picture without awaiting
   them, so it can arrive second — and it restated the same claimants at its own
   lower level. The statement is raise-only now; the one caller entitled to put
   them back down is the read that has just finished, which says so.
2. **A departure could be noticed by nobody.** The background fill states a
   claim of its own per file and withdraws it once nothing else wants that file
   — but the withdrawal happened inside a pass that nothing acted on, so a
   torrent everybody had left could be held "wanted" by the fill's own claim at
   the moment of the departure and then never re-examined: in its swarm, with no
   idle clock running. The pass acts on what it just said now.

## Where the shared statement lives — DECIDED, then REVERSED the same day

It was first published as a package, `@torrent-tv/torrent-contents`, so that
both runtimes could read the same three files: the proxy states what to fetch
from them, and the browser showed the list of episodes the instant a `.torrent`
was dropped, before a proxy had been chosen.

**Withdrawn within the hour, on the user's question: is the package better than
moving it all to the proxy, when the torrent has to go there after the choice
anyway.** It is not. The package bought one property — the instant list — with
three permanent costs: a third artifact to version and publish, two copies at
runtime that drift by version (a test was written for that drift, which is an
admission the risk is real), and three wiring points that break the page at load
with no error anybody sees (a second test was written for those).

The answer is the route that already lists a source's files. For a magnet
nothing changes at all — that is the path it has always taken — and the dropped
`.torrent` now takes the same one. What leaves the browser with it is not only
the classification but the whole notion of deciding anything from a name; what
stays is what only the browser can see (the trackers and the web seeds in the
file it holds) and how a name is SHOWN.

**The cost is answered by connecting earlier, which is the user's own point.**
Everything a viewer does needs a proxy, and choosing one and connecting to it
used to begin only after a file had been picked. It begins when the page loads
now, silently and with its failure swallowed, and `#acquireTransport` is
joinable — so whatever the viewer does next joins that attempt instead of
starting a second. Verified in a browser 2026-09-12: the page opens, the connect
runs on its own (`public-only connect failed …; trying local path` on a dev
server with no proxies registered), nothing is shown for it, and the page's own
adapter turns the proxy's answer into the three lists with the order preserved,
the torrent's own numbers kept and the release's repeated part taken off the
names.

`@torrent-tv/torrent-contents@1.0.0` is deprecated on npm with the reason.
