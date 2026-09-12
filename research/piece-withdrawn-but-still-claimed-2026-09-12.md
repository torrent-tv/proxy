# A film played 80 seconds and then stood still for 92 minutes — 2026-09-12

Proxy 2.83.4, addon 0.74.1, one viewer, `Reacher.S04E07.1080p.rus.LostFilm.TV.mkv`
(2 363 497 962 bytes). Reported by the user as "the film only managed to play
one minute nineteen seconds".

Every claim below is tagged by where it comes from: **[log]** read out of a
captured log, **[code]** read out of the source, **[measured]** computed from
the captured logs, **[derived]** reasoned from two of the above.

## 1. What the viewer saw

**[log, browser]** Every one of the 1112 `decode` readings in the captured
window is identical: `t=80.0s size=1920x1080 frames=1920 dropped=0
readyState=2`. 1920 frames at 24 fps is 80.0 s, so the picture advanced 80
seconds and then never moved again. The page stayed open until 18:52.

**[log, browser]** From then on the player asked for one segment and was
refused, about once a minute for 92 minutes:

```
18:30:47 non-fatal: fragLoadError currentTime=79.97 msReadyState=open
         frag=segment-00008.mp4 sn=8 action=5 error=Error: HTTP Error 503 …
18:41:15 fatal:     fragLoadError … sn=8 … HTTP Error 503
18:41:17 recovered fatal networkError, resuming at 80.0s
```

`msReadyState=open` throughout, so this is **not** the closed-MediaSource
failure of item 86. **[log]** The transport was healthy the whole time —
`rtt=4ms`, `state=connected ice=connected`, every counter advancing — so it is
not item 10 either.

## 2. What the proxy answered, and why

**[code]** 503 in `routes/transcode/session-file/get.js:143` is the
`warming-up` branch: the segment is still being produced. It was never produced.

**[log]** 239 times:

```
transcode 17ec5953 holding segment-00008.mp4: the file is not on disk
  (runs from #8, viewer at #8, encoder alive, index #8, produced 0.0s at 2.23x
   — the encoder has not made it)
[hold] segment-00008.mp4 warming-up after 60400ms (the map wants it now, rank 69 of 69)
```

**[log]** The encoder could not open its input, 5712 times:

```
encode-run #8..#247 lost its input ([http @ …] Error reading HTTP response: End of file)
Error opening input file http://127.0.0.1:9090/stream?sourceKey=94dda59f…   (8514×)
Error opening input files: End of file                                       (5712×)
```

**[log]** And `/stream` said exactly what was wrong, 2884 times:

```
stream: read of "Reacher.S04E07.1080p.rus.LostFilm.TV.mkv" bytes 0-2363497961
  ended after 0 of 2363497962 bytes: Piece 0 is verified but absent from the store.
```

Zero bytes of 2.36 GB. ffmpeg reads an empty body as the end of the file.

## 3. The cause

**[log]** The torrent believed it had the whole file:

```
[stats] 94dda59f 5d276be5 peers=54 connected … file=100.0% header=8388608/8388608B
```

**[log]** The store did not:

```
piece-store "Reacher.S04E07…": resident=27/42 (108MB of 168MB allowed)
  committed=108MB blocks=27 on-disk=26MB pinned=0 spilled=7
  reads=5932 (73.8% from memory) spills=571 revivals=41
```

**[measured]** 571 spills at a 4 MB piece is about 2284 MB written to disk;
26 MB remained. So roughly 565 pieces had been removed. **[log]** It was not
the disk cap: `disk: 93634MB free; spilled pieces 26MB of 46656MB` — the
ceiling never came near binding, and 93 GB were free.

**[code]** That leaves exactly one remover: `PieceDiskStore.forgetBehind`,
called from `SharedPieceStore.reviseSpillCeiling`, which drops every piece
lying behind the earliest read head. **[log]** The encoder had reached
`proxyProcessed=725.643`, twelve minutes of film, so piece 0 — the start of the
file and its Matroska header — was far behind every reader and was dropped.
That is the rule working as designed.

**[code]** `piece-reader.js:151` then asks `torrent.bitfield.get(index)`. The
library still answered yes, because it had downloaded and hashed that piece
once. **Nothing ever told it otherwise:** `bitfield.set` does not occur
anywhere in `services/piece-store/`, `services/torrent-pool.js` or
`services/torrent-worker/`. So the read concluded the piece was had, asked the
store, was told it was absent, and threw.

**[derived]** And it was never fetched again, because the library does not
download a piece it believes it owns. The comment on `forgetBehind` states the
bargain in as many words — "a seek back re-downloads it, which is the same
bargain this tier makes whenever it drops a piece for room" — and that bargain
had never once been honoured.

**[derived]** The trigger is ordinary: an encoder restart re-opens its input at
byte 0 (`bytes 0-2363497961` in the log), which is precisely the region
`forgetBehind` removes first.

This is the "un-have problem" the parent `CLAUDE.md` names in the Level 2 disk
design — "mark the piece incomplete in the completion store → it re-downloads on
the next read". The eviction shipped; the un-have did not.

## 4. Two amplifiers, each a defect of its own

### The delay after a lost input did not bind

**[code]** `hls-session-manager.js` timed a retry against the DEAD RUN, doubling
2 s → 15 s. **[code]** `EncodeRun.isAlive` is false in `RETRY_WAIT`, and the
orchestrator plans from live runs only — so the plan saw the stretch as free and
placed a new run at once, on every event.

**[measured]** 2432 `restart for` lines in 23 minutes: one every 0.57 s, for 61
minutes, while the delay printed `retrying in 15s`. The comment beside that
timer predicted this exactly and the code did not prevent it.

### The log destroyed the record of its own failure

**[measured]** 76 385 lines in 23 minutes and 159 000 in the previous 38 — about
55 lines a second, of which **52 567 of 76 385 (68.8 %) are byte-identical
repeats**. **[code]** `MAX_FILE_BYTES` was 32 MiB with one previous turn kept, so
the file turned over twice inside the session: 61 minutes of 92 survived, and the
onset — everything before 17:51 — was overwritten by the second rotation and is
gone. **[log]** `/data` had 91.4 GB free.

## 5. What was built (proxy 2.83.5)

1. the store announces when it can no longer produce a piece at all — not
   resident, not on disk, not in a file held whole — and the pool withdraws the
   library's claim with `_markUnverified`. The disk tier states only its own
   loss; the store decides whether that is a loss;
2. a read whose piece is withdrawn under it goes back one step and takes the
   whole ordinary path again instead of throwing. Once per piece;
3. the delay lives in the orchestrator, per output, and the plan places nothing
   there until it is over — unless something on that output is still producing.
   It is lifted only by a run that actually produced;
4. an established fact is logged once, then at doubling intervals to a minute,
   saying how many were held back. Matched verbatim; digits are deliberately not
   normalised, because that would merge the memory series;
5. the log file may reach 1 GB before turning over.

## 6. What this does NOT establish

1. **Nothing here has been seen in the field.** The next session is the proof.
   What should appear: `withdrawn=` climbing on the piece-store line while reads
   keep succeeding, `its input was not there (attempt N) — placing nothing for
   Xs`, and `[said N more time(s) …]` instead of a flood. What should disappear:
   `Piece N is verified but absent from the store`.
2. **The onset was not read.** Both log turns begin with the failure already
   established, so which piece failed FIRST, and whether the encoder's first
   input loss had the same cause, is not known. The mechanism is established;
   its first instance is not.
3. **A consequence, stated rather than discovered later:** a torrent whose
   pieces have been withdrawn is no longer `done`, so a film watched to the end
   is not assembled into a whole file. That is the honest state — those bytes
   are not here — and the previous behaviour was worse than it looked, since the
   assembly reads the file through the store and would have waited for pieces
   the library wrongly believed it had. What is NOT measured is how often a film
   now fails to be assembled, and whether keeping the pieces of a nearly-finished
   file would be worth the disk.
4. **The re-download cost is not measured.** A seek back past the read heads now
   waits for pieces to be fetched again instead of failing. How long that takes
   on a real swarm, and whether the viewer notices, needs a session.
5. **`peers=54 connected of -4599 known (…, -1128 queued)`** — the negative
   figures come from WebTorrent's own `_peersLength`/`_numQueued`, read for the
   log only. Not investigated, not touched.
