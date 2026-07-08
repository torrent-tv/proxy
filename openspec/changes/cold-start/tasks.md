# Tasks: Cold-start reduction (proxy side)

Execute in order; design.md is normative. Read the code regions listed at
the top of design.md first.

## 1. Media-info reuse

- [ ] 1.1 Make the banner-parse helpers of `probeInputMediaInfo` reusable by
      the planner (export or shared module — no duplication). `node --check`
      both files.
- [ ] 1.2 playback-planner: build + cache `mediaInfo` alongside the plan on
      a codecs-detected probe; expose `getCachedMediaInfo({ sourceKey,
      fileIndex })`. Pending probes cache nothing.
- [ ] 1.3 server.js: pass `getCachedMediaInfo` into HlsSessionManager;
      hls-session-manager: consult it in `createSession` with the
      critical-fields gate (duration/width/height), probe as fallback.
- [ ] 1.4 Verify equivalence: for one file, run plan → session with the
      cache and (by temporarily disabling the wiring) without it — the
      session log line (duration, segments, ladder/rung) must be identical.

## 2. Body-start prefetch

- [ ] 2.1 playback-planner: fire-and-forget 16 MB head prefetch
      (`prefetchFileEdges` with `tailBytes: 0`) at the probe-success point;
      never on pending polls; never awaited.
- [ ] 2.2 Verify: on a fresh well-seeded magnet, proxy log/order shows the
      prefetch starting right after the plan while the session that follows
      produces its first segment without a piece-wait stall (compare
      first-segment ms with task 3 timings before/after).

## 3. Stage timings

- [ ] 3.1 `createSession`: one `cold-start …: media-info=<ms> (cached|probed)
      keyframes=<ms|skipped> create-total=<ms>` line.
- [ ] 3.2 First-segment-ready line (`+<ms>` since create entry), once per
      session (timestamp on the session object + boolean guard).

## 4. Verification and release

- [ ] 4.1 Regression: normal HLS transcode start, video-copy start (keyframe
      probe still runs), seek-restart, quality switch — behaviour unchanged;
      timings visible in the log.
- [ ] 4.2 Before/after numbers on the dev HA proxy for one cold magnet:
      media-info ms (probed → cached) and first-segment ms. Record them in
      this file.
- [ ] 4.3 CHANGELOG entry (current version + 1 patch); `npm run patch`; bump
      ha-addon `config.yaml` + its CHANGELOG; push; update the addon in HA
      (proxy FIRST, then addon — release order per root CLAUDE.md).
