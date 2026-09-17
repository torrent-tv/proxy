# Disk architecture — one owner, and what goes first when it is short

Three things on this proxy write to the same disk. Until 2026-09-10 each read
the free space as though it were the only claimant, so there were three
ceilings, each standing for the whole disk.

| what | where | what bounded it before |
|---|---|---|
| segments an encoder produced | `services/encode/SegmentStore.js` | a quarter of what was free, plus a 2 GB floor — both numbers chosen by hand |
| pieces the memory store spilled | `services/storage/piece-store/piece-disk-store.js` | **nothing at all** |
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

## One layer, four directories, and under the import rule

`SegmentStore` moved out of `services/encode/` on 2026-09-14 — a store of
finished pieces inside the ENCODING layer was the encoder owning its own disk.
It did not move into the room's own directory either: it is a CLAIMANT, and a
claimant inside the owner of the resource is the same fault one floor down.

**Four directories, deliberately.** They share one property — bytes on a medium
with a limit — and that is what makes them one layer. What they are is three
different things: a torrent piece is born when it is downloaded and addressed by
`(infohash, number)`; a produced segment is born when an encoder closes it and
addressed by `(output key, number)`; a whole file is born when its last piece
lands. Different birth, different death, different name, and two of the three
live in the torrent WORKER thread while the others are on the main one. Flatten
them and that thread boundary becomes invisible: code that cannot call code
looks like a sibling, and no rule catches it.

**The rule is written as an exception, not as a list.** `group: ["../**",
"!../storage/**", "!../piece-store/**", "!../segment-store/**", "!../files/**"]`
— everything outside the layer, minus the layer. A list of forbidden layers was
tried first and let `../../utils/logger.js` straight through, because a list
only catches what somebody remembered to write in it. Checked by breaking it,
in both directions, in all four directories.

**One reader of how much memory is free** (`machine-memory.js`). It had been
written three times — the health collector, the memory report and the piece
store — and the copies had already drifted: the piece store was corrected from
`os.freemem()` to the kernel's `MemAvailable` on 2026-08-27 and the health
collector went on publishing the wrong quantity until 2026-09-02.

## Every claimant is told its share

A CLAIMANT IS WHOEVER HOLDS BYTES, and by 2026-09-14 all of them are registered
with the owner (`wire.js`): the segments an encoder produced, the pieces the
memory store spilled, the files downloaded whole, and the evidence. Two of the
four live on the torrent thread and arrive as a pair of closures over its
channel.

**Whole files had no bound of any kind** until that day — a 2.8 GB film kept
whole on a host whose disk is often a 32 GB card. They now take a share, and
over it the whole file nobody has asked for in longest goes. Losing one is not
losing data: the torrent can fetch it again, and until it does the read falls
back to the pieces, which is what `piece-from-whole-file.js` exists for. A file
is also not ASSEMBLED when there is no room for it — writing it and then
removing it is the same bytes written for nothing.

**The torrent pool's own "disk cap" is gone, and it owned nothing.** It capped
`torrentDownloadedBytes` — a sum over WebTorrent's bitfield — so a piece held
purely in MEMORY told against a ceiling called disk, while the bytes it meant to
bound belong to the spill and to the whole files, each of which has an owner.
Under it, eviction removed whole idle TORRENTS to free bytes that were not
necessarily on the disk at all.

**The evidence is a claimant with a rule of its own** (`Diagnostics.js`), and the
rule is what makes a bound on it safe:

1. over its share, collection STOPS. Nothing already recorded is deleted to make
   room — a dump is the only evidence of the death it records — and a refusal is
   a LINE with the figures, so an investigation that finds nothing can tell "it
   did not happen" from "there was nowhere to put it";
2. except what is superseded, which is not evidence twice. A capture of a
   connection already captured adds nothing: the wedge does not un-wedge. Field
   2026-09-06, thirteen captures of one wedge in six hours, 74 MB, every one
   saying what the first said;
3. what it asks for is measured — what it holds plus one more of the largest
   kind seen — so the claim grows with the evidence and a proxy that has never
   faulted asks for nothing.

**Core dumps are not ours to refuse, and that is stated rather than papered
over.** The kernel writes them, whole address space at a time, and no gate of
ours is consulted. They are counted, so they take room from what the product may
hold and the figure is visible; the pruning that keeps the newest two is left
where it is, because changing it is a decision about evidence and not about
disk.

## One budget

There is one owner, one policy and one place that reads the machine —
`MachineBudget.js`. What it divides is divided PER RESOURCE, because memory
cannot be paid for with disk, and "disk" is one resource per DEVICE: measured on
the addon host 2026-09-05, `/tmp` (the segments and the spill) is the overlay
and `/data` (the evidence) is ext4 on the nvme. Dividing one figure between
claimants on both gave each a share of a disk it does not write to, which is
what the old `DiskSpace` did — it read the free space of the segment root alone.
The device is read with `statSync(dir).dev`, from the nearest ancestor that
exists, for the same reason `freeBytesFor` walks up.

**Why one owner and not two.** The claimants trade across resources: pieces that
do not fit in memory are spilled to disk, whole files exist so that pieces need
not be held, segments exist because making them again is dear. Field 2026-08-31:
14 400 MB spilled in fifty minutes while the memory store held 312-424 MB — give
it memory and there is no spill to bound. Two owners cannot make that trade,
because neither sees both sides of it. Memory was divided inside the torrent
thread and disk on the main one until 2026-09-14; the memory share now travels
the same channel the spill share already did.

**The policy is the operator's, and it is the only chosen number here.**
`--budget adaptive|share|fixed` with `--budget-share` / `--budget-bytes`, and
floors with `--min-memory-bytes` / `--min-disk-bytes`. The default is
`adaptive`, which is the measured rule of `allowance.js` and chooses nothing. A
floor lifts what the policy allows and can never invent room the machine does
not have; a claimant left below its own minimum says so in a line, because
working below what it needs is a fault of the machine and invisible otherwise.


