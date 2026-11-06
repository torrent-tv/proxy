# Tasks: Solve each recurring task one way

Parent: torrent-tv/meta#279. Each line is a sub-issue in `Ready`, in
Priority order (16.01-16.40); the issue holds why, how, checks, constraints
and what is out of scope. Ticked when the issue is `Done`.

## 1. Behaviour differs between copies

- [ ] 1.1 #281 Forward relayed requests to the local proxy server in one place (proxy + server)
- [ ] 1.2 #282 Parse and answer byte-range requests one way in the proxy routes
- [ ] 1.3 #283 Convert bytes to pieces only in torrent/demand/pieces.js
- [ ] 1.4 #284 Name codecs from one table in the media layer
- [ ] 1.5 #285 Read video and audio bitstreams with one bit reader and one RBSP rule
- [ ] 1.6 #286 Stop only the misplaced run when the cut table is corrected
- [ ] 1.7 #287 Keep one copy of each git hook and check commit attribution in hooks and CI
- [ ] 1.8 #288 Remove the retired wait estimate and progress bar from the page (server)
- [ ] 1.9 #289 Read the proxy's playback forecast with one rule at start and after a seek (server)
- [ ] 1.10 #290 Report picker input errors the way the magnet field does (server)

## 2. Converge, proxy and page

- [ ] 2.1 #291 Run ffmpeg and ffprobe through one runner and parse -progress once
- [ ] 2.2 #292 Read CPU, cores and free disk only in services/storage (after #291)
- [ ] 2.3 #293 Resolve proxy options once and write state files atomically
- [ ] 2.4 #294 Compute medians and print byte units one way
- [ ] 2.5 #295 Read request fields and detect a departed requester one way (after #282)
- [ ] 2.6 #296 Answer obsolete, pending, not-found and retry-later requests in one shape (after #295)
- [ ] 2.7 #297 Decide which tracks to transcode in one page function (server, after #289)
- [ ] 2.8 #298 Open a .torrent and a magnet through one flow (server, after #297)
- [ ] 2.9 #299 Read proxy answers, pending polls and cancellation one way in the page (server, after #296, #298)

## 3. Tooling across repositories

- [ ] 3.1 #300 State release and commit rules once and remove stale copies
- [ ] 3.2 #301 Check npm readiness and push bot commits through one script each
- [ ] 3.3 #302 Build the proxy's native modules with one script; smoke-test every image
- [ ] 3.4 #303 Enforce LF line endings the same way (after #287)
- [ ] 3.5 #304 Share ffprobe CI steps; align lint and dead-code config (after #287, #302)

## 4. Converge, proxy internals and tests

- [ ] 4.1 #305 One logger-shaped port and one loop-delay owner (after #281)
- [ ] 4.2 #306 Touch WebTorrent internals only in the worker-side adapter (after #283)
- [ ] 4.3 #307 Coalesce, race aborts and yield with one helper each (after #291, #306)
- [ ] 4.4 #308 Reach the domain from routes one way; merge twin routes (after #296)
- [ ] 4.5 #309 Shared helpers for managers, outputs, Renditions hosts in tests
- [ ] 4.6 #310 Shared container byte builders, waits and source-text readers in tests
- [ ] 4.7 #311 Test route handlers over real Fastify with one helper (after #282, #295, #296)

## 5. Page internals

- [ ] 5.1 #312 One WebRTC signalling session in the page
- [ ] 5.2 #313 Contract literals once in the page; one proxy registration path (after #299, #312, #281)
- [ ] 5.3 #314 Shared view helpers and player colour tokens (after #298)
- [ ] 5.4 #315 Shared DOM, fetch and signalling fakes in server tests (after #289, #299)

## 6. After existing work

- [ ] 6.1 #316 One clock rule (after #292)
- [ ] 6.2 #317 One form for bytes-not-yet, source-forgotten and cancelled (after #270)
- [ ] 6.3 #318 Forget a source through one registration (after #317, #270)
- [ ] 6.4 #319 One viewer demand and native-source zones via SegmentInputs (after #276)
- [ ] 6.5 #320 One output rate and one encoder speed (after #273, #263)

## 7. Close the parent

- [ ] 7.1 Re-run `clones.py` and the sub-issues' greps; record the result on #279
