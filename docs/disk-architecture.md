# Disk architecture — one owner, and what goes first when it is short

Three things on this proxy write to the same disk. Until 2026-09-10 each read
the free space as though it were the only claimant, so there were three
ceilings, each standing for the whole disk.

| what | where | what bounded it before |
|---|---|---|
| segments an encoder produced | `services/encode/SegmentStore.js` | a quarter of what was free, plus a 2 GB floor — both numbers chosen by hand |
| pieces the memory store spilled | `services/piece-store/piece-disk-store.js` | **nothing at all** |
| diagnostics kept on purpose | `/data` — core dumps, heap snapshots, packet captures | a count of files, never a size |

The middle row is what it cost: one fifty-minute viewing wrote **14 400 MB** to
the spill file (field 2026-08-31) while the store held 312-424 MB, and free
space on the host fell by every megabyte of it. The bottom row is 2.9 GB of one
core dump on the addon host, inside a budget of "two dumps".

## One owner

`services/disk/DiskSpace.js` reads the free space once and divides it. The rule
is the one memory already uses, on the other reading:

```
allowance = free now + what we already hold - what everything that is not us has been seen to need
```

Nothing in it is a fraction chosen by hand. The reserve is measured: between two
readings, how much free space went away beyond what our own consumers took.

`services/disk/wire.js` says who the claimants are. The segments are told their
share by a call; the spilled pieces live on the torrent thread, so the share
travels the channel that already carries everything else and the reply says what
they hold — one exchange, both directions.

The reading is said every pass, in the series beside the memory one:

```
disk: 104584MB free; segments 0MB of 52292MB, spilled pieces 0MB of 52292MB
```

## Two rules, answering two questions

They are kept apart because they were briefly proposed as one, and that was
wrong.

**Time.** Material nobody needs should not sit on the owner's disk merely
because there is room for it. An output nobody has read for long enough goes
whole, whatever the free space is.

**Space.** Material everyone needs must still go when there is no room.

A ceiling alone would keep 5 GB on a household disk for six hours because the
disk is large. An idle rule alone would keep everything until its clock ran out,
however tight the disk had become.

## What goes first, and it is the viewers who decide

For the segments, the order is the priority map's own read from the other end:

1. outputs nobody is watching at all;
2. what lies behind the earliest viewer — furthest behind first;
3. what lies ahead of the furthest viewer — furthest ahead first.

A segment a viewer is standing on is never a victim. It used to be whole outputs
by when their directory was last read, which says nothing about what anybody is
about to watch.

## A piece is a file

`DiskTier` wrote every spilled piece into ONE sparse file at
`index * chunkLength` and answered `forget(index)` by dropping the number from a
set. The bytes stayed: a sparse file's blocks come back only by hole punching,
which Node exposes no binding for, so nothing this process could do returned a
single block before the whole file was removed.

`PieceDiskStore` gives each piece its own file. Removing one returns exactly its
blocks, needs no binding this runtime lacks, and makes the unit of eviction the
same as the unit of storage — so the order pieces leave in is the order we
choose. Over its allowance the least recently used goes, and a piece being read
is never the victim. A piece thrown away is answered as absent, so the torrent
fetches it again, which is the same bargain the memory tier makes when it
spills.

The read this replaced was chosen for its cost — 22.08 ms via `readFile` against
**7.63 ms** into a buffer we already hold, measured on the field host — and that
is unchanged: it is still one `read` into the caller's buffer. What it adds is
an `open` per read, tens of microseconds against those milliseconds.

## A clean exit leaves nothing of ours

The segments' root was removed only when it happened to be empty — from the
first commit of this repository, never a decision. What it protected against is
a second proxy sharing the root; what it did was leave every directory alone,
including this process's own orphans. A directory adopted at startup, owned by
no session, therefore survived the exit and was adopted again at the next start.

That loop is what made an orphan permanent, and it is why 5.0 GB of segments
from sessions that had ended hours before were on the addon host on 2026-09-10.
`SegmentStore.dropAll` now removes everything this process owns, root included,
which also gives the startup sweep its meaning back: whatever is found then is
from a kill.

Both kinds have both rules. For the spilled pieces the time rule is the same
statement one layer down: a piece behind every read head has been read and will
not be read again unless somebody seeks back, and a seek back re-downloads it —
the bargain this tier already makes whenever it drops a piece for room.
`PieceLru.readHeads` says where the readers stand, `PieceDiskStore.forgetBehind`
acts on it, and the eviction order under pressure is the same: behind the
earliest reader first, furthest behind first of all. With no reader at all
nothing is removed — a store between reads is not a store nobody wants, and the
torrent going idle is what empties it whole.

## How long material nobody is using is kept

One number, in one place — `services/disk/keep.js`, one hour — because
everything it governs stands for the same unmeasured thing: whether the viewer
comes back.

It was three, and they contradicted each other:

| what | was | now |
|---|---|---|
| a torrent and its downloaded bytes | 15 minutes | one hour |
| a session | 30 minutes | unchanged — a session is a record, not material |
| the segments an encoder produced | 6 hours | one hour |

The torrent went at fifteen minutes while the session it feeds lived to thirty,
so between them there was a session with no source: a viewer returning at the
twentieth minute got a session that could not make a single new segment. With
one hour for both kinds of material the session dies first, which is the right
order and needs no rule of its own to enforce.

Nothing derives the hour. Everything else in the decision is measured — a piece
comes back from the swarm in ~1430 ms, a segment in its own encode time, and the
disk has an owner that prices holding it — and only the return is unknown.

**And the return is measurable here.** A session opened on an output whose
segments are still on disk IS a return, and its age is exactly what the store
recorded. `services/disk/returns.js` keeps them and says so beside the disk
figures:

```
returns: 14 session(s) opened on material still held, 3 on material gone;
         median 12min after the last read, longest 51min — kept for 60min
```

The median and the longest are the two the period has to sit between: shorter
than the median throws away material half the returns wanted, longer than the
longest keeps material no return has ever reached. A week of ordinary use and
the hour is replaced by what viewers actually do — and then the two kinds can
have different numbers, since their costs of coming back differ.

## What is NOT solved

**The measurement that would replace the hour has not been taken yet.** The
counter is in place and says nothing until a week of ordinary use has produced a
distribution.

**The diagnostics are not a claimant yet.** They are bounded by a count of files
and never by a size, and they cannot simply be thrown away when space is short: a
dump is the only evidence of the death it records. That needs a rule of its own.
