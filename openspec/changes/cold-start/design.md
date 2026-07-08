# Design: Cold-start reduction (proxy side)

Written to be executed as specified. Read before coding:

- `services/playback-planner.js`: `probeStreamCodecs` (how the ffmpeg banner
  is parsed today), `getPlan` (prefetch → probe → pending loop → plan cache
  and its key/invalidation).
- `services/hls-session-manager.js`: `probeInputMediaInfo` (~line 383 — what
  it parses: durationSeconds, width, height, fps, startTime, isHdr),
  `createSession` (~line 806: the probe call at ~817, keyframe probe at
  ~854), the segment-ready path (where segment 00000 first becomes
  servable — grep the long-poll the `routes/transcode/session-file/get.js`
  route uses).
- `services/torrent-pool.js`: `prefetchFileEdges` (~line 608) — signature
  `(torrent, fileIndex, { headBytes, tailBytes, timeoutMs })`.
- `server.js`: how `playbackPlanner` and `hlsSessionManager` are constructed
  and injected.

## 1. Media-info reuse (kill ffmpeg scan #2)

Both probes run ffmpeg over the same input URL and parse the same stderr
banner; they just extract different fields. Unify:

1. Extract the banner-parsing helpers that `probeInputMediaInfo` uses
   (duration/width/height/fps/startTime/HDR detection) so the planner can
   apply them to ITS probe's stderr. Where they live is the executor's
   choice (export from hls-session-manager or move to a small shared
   module) — do NOT duplicate the parsing logic.
2. In the planner, on a probe whose codecs were detected (the same condition
   that allows caching the plan), build a `mediaInfo` object
   `{ durationSeconds, width, height, fps, startTime, isHdr }` and cache it
   ALONGSIDE the plan — same key, same lifetime, same invalidation. A
   pending (empty) probe caches nothing, exactly like the plan.
3. Planner exposes `getCachedMediaInfo({ sourceKey, fileIndex })` →
   `MediaInfo | null`.
4. `server.js` passes it into HlsSessionManager (new constructor option
   `getCachedMediaInfo`).
5. `createSession`:

       const cached = this.getCachedMediaInfo?.({ sourceKey, fileIndex }) ?? null;
       const usable = cached
         && Number.isFinite(cached.durationSeconds) && cached.durationSeconds > 0
         && Number.isFinite(cached.width) && cached.width > 0
         && Number.isFinite(cached.height) && cached.height > 0;
       const mediaInfo = usable ? cached : await probeInputMediaInfo(this.ffmpegBin, inputUrl.toString());

   Duration/width/height gate the cache because downstream logic depends on
   them (synthetic VOD playlist, resolution ladder); fps/startTime/isHdr
   have safe defaults and do not gate. The probe stays as the fallback —
   behaviour is unchanged whenever the cache cannot serve.

Keyframe probe (`probeVideoKeyframeTimes`) is NOT touched: it runs only on
the video-copy path and probes different data (packet flags, not the
banner).

## 2. Body-start prefetch

In `getPlan`, at the point where the probe succeeded and the plan is about
to be cached/returned, fire and FORGET:

    void torrentPool.prefetchFileEdges(torrent, fileIndex, {
      headBytes: BODY_PREFETCH_BYTES, // 16 MB
      tailBytes: 0,
      timeoutMs: 60_000
    }).catch(() => {});

    const BODY_PREFETCH_BYTES = 16 * 1024 * 1024;

No new torrent-pool method — `prefetchFileEdges` with `tailBytes: 0` is
exactly a head prefetch. Not awaited: the client's session-create follows
within a couple of seconds and ffmpeg reads sequentially behind the
prefetch. 16 MB ≈ 25 s of typical 5 Mbit media — covers the first segments
without denting the disk cap. Do NOT start it on pending polls (the header
prefetch must keep absolute priority while the probe is starving).

## 3. Stage timings

- `createSession` measures and logs (one line, existing logger, prefix
  matches the session log style):

      cold-start <sessionId8>: media-info=<ms> (cached|probed) keyframes=<ms|skipped> create-total=<ms>

- When the FIRST segment file of a fresh session becomes servable (the
  long-poll in the session-file path returns it), log once per session:

      cold-start <sessionId8>: first-segment ready +<ms since createSession entry>

  Store the create-entry timestamp on the session object; guard with a
  boolean so the line logs once.

## Rules — do NOT

- Do NOT change probe semantics, the pending/poll contract, or the plan
  cache key.
- Do NOT prioritise body bytes before the probe has succeeded.
- Do NOT make session create fail on a cache problem — any doubt → fall
  back to the probe.
- No behavioural change for the video-copy path beyond the timing lines.
