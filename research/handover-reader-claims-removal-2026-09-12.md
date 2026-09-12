# Handover: the priority map is the only thing that says a file is wanted

Written 2026-09-12, after the instruction that reversed the work in the tree.

## The instruction, in the user's own terms

The priority map answers ONE question: how much is this stretch of this file
wanted. Nothing anywhere asks WHO is reading a torrent. There are no reader
counters. Everything built around counting readers comes out.

The map is rebuilt when viewers come and go, so it already shows the current
state of affairs. A second bookkeeping of the same thing is what has to go.

## What is in the working tree right now, and why it is all wrong

HEAD is `79e802a`. On top of it, UNCOMMITTED:

| file | what was done to it |
|---|---|
| `services/torrent/ReaderClaims.js` | NEW, untracked. The whole class is the mistake. |
| `services/torrent-pool.js` | `fileUsageByTorrent` replaced by `this.readers = new ReaderClaims()`; a listener on it calls `rejoinSwarm`, `leaveSwarm` and `#scheduleIdleRemoval`; `torrentsForUploadPolicy` changed from taking a usage map to taking an `isRead` predicate. |
| `services/torrent-worker/worker.js` | `warmActiveFiles` (`:842`) and `keepWholeFiles` (`:1024`) read `pool.readers.of(torrent)`. |
| `test/swarm-follows-readers.test.js` | the announcement test rewritten around `ReaderClaims`. |
| `test/upload-hurry.test.js` | rewritten around the `isRead` predicate. |

All of it counts readers. All of it comes out. Two further facts about this
tree, both of which the next agent needs:

1. A bulk text replacement earlier in that session DESTROYED three methods of
   `TorrentPool` — `#scheduleIdleRemoval`, `#cancelIdleRemoval` and
   `#forgetDeadTorrent` — which were then called but not defined. They were
   restored BY HAND from HEAD and adapted, not diffed line by line against the
   original. One log line was changed deliberately: the idle-timer message no
   longer prints a reader count. **Diff the restored bodies against
   `git show HEAD:services/torrent-pool.js` before trusting them**, or discard
   the tree and start from HEAD.
2. Discarding the uncommitted changes is probably the cheapest start, since
   every one of them is being reversed. That is a destructive action and is the
   USER'S CALL — ask before running anything that throws work away.

## What already exists and answers the question without counting anybody

Read these before designing. Line numbers are of the working tree.

**The map is built from viewers and published.** `services/priority/PriorityOrchestrator.js`
builds one map per film+file, and a second per output, from where the viewers
are. `services/priority/PriorityMap.js` holds the scale and the words for
reading it — `isAtAWatchingViewer`, `isBehindEverybody`, `isNobodyComingNow`.

**The map reaches the torrent thread as a command.** `Command.PRIORITY_MAP` in
`services/torrent-worker/worker.js:539` calls `pool.applyPriorityMap(torrent,
fileIndex, zones, durationSeconds)`.

**`applyPriorityMap` (`services/torrent-pool.js:1191`) is where seconds become
bytes**, and it writes the result into the demand register:
`demandFor(torrent).register.state({ claimant, fileIndex, byteStart, byteEnd,
urgency })`, with the claimant named `${MAP_CLAIMANT}:${fileIndex}:${index}`
(`:1257`). It WITHDRAWS its own stale claimants for that file afterwards
(`:1266-1273`), so a map that shrinks does shrink the register. **Whether a map
that wants NOTHING leaves the register empty for that file is not established —
check it, do not assume it.**

**The register is therefore the existing statement of what is wanted.**
`services/demand/DemandRegister.js` offers `size`, `files()`, `windows()`,
`at(urgency)`, `union(fileIndex)`, `mostUrgent()`, `withdraw(claimant)`,
`clear()`. `services/download/registry.js` offers `demandFor(torrent)`,
`hasUnmetDemand(torrent)`, `forgetTorrent(torrent)`, `reconcileAll()`.

## THE TRAP — read this before writing a line

**Not every claimant in the register is a viewer, and the ones that are not are
exactly what a naive rule kills.**

Measured claimants other than the map:

- `services/torrent-worker/piece-reader.js:670` — a read that is STOPPED on a
  piece right now, stated at the BLOCKED level. Only a read can say this; the
  map deliberately never states BLOCKED (see the comment at
  `torrent-pool.js:1204`).
- `services/torrent-pool.js:1147`, `:1159`, `:1162` — the background fill and
  the tail.

And several reads exist that no viewer has yet asked for: the codec probe
reading the file's head and tail, the keyframe table, the subtitle cluster
walk, a sidecar soundtrack being fetched whole.

**This is not hypothetical.** On 2026-09-11 a rule of exactly this shape shipped
as proxy 2.83.1: a torrent nobody had stated anything about left its swarm. A
torrent that has just been added has stated nothing yet, because its edges are
still being read and its playback plan is still being built. Field record:
added 20:57:17, first peer 20:57:18, out of the swarm 20:57:21 with 741
connections let go, and nothing ever rejoined it — rejoining waited for a
reader, and the reader was waiting for the header the swarm had been fetching.
`peers=0 connected of 0 known (94 queued, 5 tracker(s) offered up to 683
seeders)` for as long as the viewer would wait. Playback never started.

So "the map wants nothing, therefore let the swarm go" is WRONG as written. The
honest question is whether ANYTHING in the register wants bytes of this torrent
— the map's zones and every other claimant together — and that question has to
be asked of the register, which already knows, rather than of a counter.

## What has to change, and what each site should ask instead

Each of these currently asks "who is reading". Work out, per site, what it
actually needs from the register.

1. **`TorrentPool.acquireFile`** (`torrent-pool.js:1770`) and its release
   function. Callers: `routes/stream/get.js:211`,
   `routes/api/transcode-sessions/post.js:47`,
   `services/controllers/SubtitleController.js:54`,
   `services/torrent-worker/worker.js:251` and `:366`,
   `services/torrent-worker/pool-adapter.js:88`,
   `services/torrent-worker/client.js:327`. Note it also does two things that
   are NOT counting: it cancels a pending idle removal and stamps
   `#lastAccess`, which the disk-cap LRU reads. Decide where those two belong
   before deleting the method.
2. **Leaving and rejoining the swarm.** `leaveSwarm` and `rejoinSwarm` are
   exported from `torrent-pool.js:465` and `:497`. Today the trigger is the
   first claim taken and the last released. It becomes a fact of the register.
3. **Idle removal.** `#scheduleIdleRemoval` fires on the last reader leaving and
   re-checks for readers when the timer fires.
4. **The upload policy.** `torrentsForUploadPolicy` (`torrent-pool.js:349`) sets
   `torrent.hasActiveReader` and `torrent.hasUnmetDemand`. The second already
   comes from the register (`hasUnmetDemand`); the first is the counter.
5. **`#reportStalledDownloads`** (`:1311`) and **`#adjustUploadLimit`** (`:1354`)
   skip a torrent with no readers.
6. **The disk-cap LRU** (`:1411`) picks torrents with no readers.
7. **`#removeTorrent`** (`:1886`) prints a refcount for diagnostics.
8. **`warmActiveFiles`** (`worker.js:842`) walks "the files being read" to keep
   subtitle cues current. `register.files()` says which files anything wants.
9. **`keepWholeFiles`** (`worker.js:1024`) refuses to write a completed file out
   while it is being read, so that the write does not take the disk from a
   viewer. This one genuinely needs "is anybody reading THIS file right now" and
   is the site most likely to need a different answer from the register than a
   plain "is it wanted".

## Rules that hold whatever the design turns out to be

- **Plan first, approval before any edit.** No exceptions, including when told
  to get on with it.
- **Never add a line to `services/hls-session-manager.js`.** It is being taken
  apart. Deletion only; `git diff --numstat` must show more removed than added.
- **All code, comments and documents in the repositories are English.**
- **Do not run the whole test suite.** Run the tests of the files changed.
  Relevant here: `test/swarm-follows-readers.test.js`, `test/upload-hurry.test.js`,
  `test/file-claims.test.js`, `test/background-fill.test.js`,
  `test/priority-map-download.test.js`, `test/read-window.test.js`,
  `test/piece-reader.test.js`, `test/dead-torrent-handle.test.js`.
- **A CHANGELOG entry is part of the change**, written at the version
  `npm run patch` will produce — the current `package.json` version plus one
  patch. Never edit the version in `package.json` by hand.
- **Bumping the proxy means bumping the addon**, `ha-addon/torrent_tv_proxy/config.yaml`,
  with its own CHANGELOG entry, and the proxy is published FIRST.
- **Publishing is pre-authorised.** Destructive actions are not.
- Refer to work by what it is, never by a list number.

## State of the tree as measured, 2026-09-12

- `node --check` passes on the three touched source files.
- Biome is clean over `services/`, `test/` and `routes/` — 282 files.
- Tests of the changed files: 131 of 131 pass.
- Nothing has been verified in the field; the released proxy is 2.83.3 with
  addon 0.74.0 on the host.

None of that argues for keeping the work. It is recorded so that a failure
after the removal is not mistaken for a failure that was already there.
