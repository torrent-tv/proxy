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
