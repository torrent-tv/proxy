# Design: Solve each recurring task one way

Notes of the analysis for torrent-tv/meta#279 (2026-11-06). Line numbers are
at proxy `66a91fb` (2.107.54) and server `f0cccb5` (0.66.27); `origin/main`
differs in `ViewerRequests.js`, `OutputForecastGeometry.js`,
`playback-readiness.js` and a few page files, so re-locate by name. Every
sub-issue carries its own evidence, steps and acceptance criteria; this file
keeps the method, the inventory, what was checked and found fine, and the
order.

## Method

1. Token clone scan: normalised lines (comments and punctuation-only lines
   dropped), 8-line windows for source, 10 for tests, 6 for scripts and
   workflows; a window seen in 2-8 places is a clone. Results:
   proxy source 8 pairs (largest 15 lines), server source 5, proxy tests 56,
   hooks/workflows/OpenSpec configs 60.
2. Pattern counts in proxy source: `Date.now()` 186 hits / 55 files,
   `performance.now()` 125 / 24, injected `now = Date.now` 76 / 49,
   `new Promise(resolve` 58 / 39, `toFixed(` 217, `1e6|1048576|1024 * 1024`
   77 / 38, `spawn(` 11 / 6, `new Map(` 423 / 119, median helpers in 8 files.
3. Five read-only audits by delegated agents, each told to verify by reading
   and to say whether copies differ in behaviour: proxy cross-cutting
   (clock, timers, statistics, units, logging, errors, processes, caches,
   machine readings, config); proxy domain (the AGENTS.md "one owner"
   claims checked one by one); proxy HTTP surface and tests; server and
   page; tooling across repositories.
4. Claims of a defect were re-read before a sub-issue was written:
   `parseRange("bytes=-500", 1000)` → `{0, 500}`; `fileDownloadedBytes`
   subtracts `lastLen` when `(offset + length) % pieceLength === 0`;
   `FOURCC_CODECS` lacks fmp4/m4s2/mp4s and `decodeFamilyOf` returns `h264`
   for them; `stopEncodeRun` loops over every live run; `seekHoldAnswer`
   returns `release` for `version !== 1`.

## Refuted

- "A worker thread has its own `performance.timeOrigin`, so every torrent
  worker capture is rejected by `sourceCaptureOf`." A Worker started from the
  main thread printed the same `timeOrigin` as the main thread (Node on the
  development machine, 2026-11-06). Recorded in #316, whose acceptance
  criteria keep a test that a real Worker capture is accepted.

## Inventory

Status of every finding: a sub-issue, merged into one, attached to existing
work, or left as it is (with the reason).

### Behaviour differs between copies

| Finding | Where it goes |
|---|---|
| tunnel relay without allowlist, body cap, abort; server `relay()` unused | #281 |
| Range parsing two ways; `/stream` never 416; hijacked answers lose CORS | #282 |
| bytes→pieces in ~10 places; `fileDownloadedBytes` boundary bug | #283 |
| five codec tables; FMP4 AVI priced as H.264 | #284 |
| strict and lenient RBSP on the same AVC slice; seven bit readers | #285 |
| cut-table correction stops every run | #286 |
| `-progress` parsed five ways; INT64_MIN guard missing in the decode fit; split chunks | #291 |
| CPU read by two parsers and three pollers; host vs bound cores; disk free without fallback | #292 |
| `--state-dir` default decided by consumers; in-place JSON writes | #293 |
| "MB" decimal in some logs, binary in others for one rate | #294 |
| request fields validated ~6 ways; departure noticed 8 ways, two miss an early departure | #295 |
| obsolete/pending/not-found answered in several shapes; stale hold docs | #296 |
| failures logged at info through level-less ports; one loop-delay histogram reset by every response | #305 |
| "block arrived" judged two ways on private WebTorrent fields | #306 |
| second caller of a coalesced job awaits different things | #307 |
| wall and monotonic clocks for one kind of measurement | #316 |
| forgotten source: cancelled, terminal, thrown or silent | #317, #318 |
| hidden tab: encoder map attenuated, native source not | #319 |
| copied picture's prior rate counts soundtracks twice; two encoder-speed readings | #320 |
| page: start gate and seek gate read the forecast oppositely | #289 |
| page: picker errors dispatched to a dialog IDLE cannot show | #290 |
| page: retryability of one refusal decided 6 ways | #299 |
| page: base32 magnet loses the holder preference | #298 |
| hooks: `pre-push` rule differs from CI; attribution unchecked | #287 |
| CI: npm readiness checked by metadata in one place and by tarball in another | #301 |
| Docker: native build checks differ between proxy and addon images | #302 |

### Same behaviour, maintenance cost only

| Finding | Where it goes |
|---|---|
| median ×13, clamp ×2, `megabytes()` ×3 | #294 |
| twin routes (container-metadata/cover/fingerprint, warm, file, health) | #308 |
| test fixtures: managers ×3 ways, outputs ×23, Renditions host ×3 | #309 |
| test byte builders (MP4 ×19, EBML ×9), waits ×9, source readers ×8 | #310 |
| fake replies ×28, encode-input adapters ×4 | #311 |
| ffmpeg runners ×7 | #291 |
| elementary-index address map ×3, range union ×10 | #285, #283 |
| page: dead wait estimate and progress bar | #288 |
| page: transcode decision ×3, dead HTTP transport | #297 |
| page: .torrent and magnet open flows | #298 |
| page: signalling handshake ×2 | #312 |
| page: contract literals scattered; two proxy registration paths | #313 |
| page: dialog/panel/log helpers, CSS palette | #314 |
| server tests: DOM ×3, fetch fake ×20, slicers ×4 | #315 |
| release rules restated in ~13 places, 8 stale | #300 |
| LF enforced three ways | #303 |
| ffprobe CI steps ×2; lint rules and knip configs diverge | #304 |

### Attached to existing work

- `server.js` `bytesPerSecondOf` duplicates `QualityController.observedStreamMbps`:
  #273 moves it; #320 removes the copy afterwards. Comment on #273.
- `server.js` `onReadResult` writes the keyframe table a second time without
  `copyable`, and `KeyframeTables.learn` has no other caller (the
  `keyframe-probe.js` it was written for is gone): to be dropped where #274
  moves `containerOver`. Comment on #274.
- Forecast-side copies (`playback-readiness.js` `sourcePiecesFor`, the
  half-open range union, the native-map deadline arithmetic): left to
  #255-#266; #283 and #319 exclude them.
- `test/no-torrent/support/whole-film-forecast.js` (1082 lines,
  `predictPlaybackReadiness`) may be a second implementation of
  `playback-readiness.js`; not compared in this analysis. Belongs to the
  forecast series.

### Checked, not duplication

- `SwarmSelection` is the only caller of `select`/`deselect`/`critical`.
- `ContainerFactory.create` has one caller; one `ContainerOrchestrator`; one
  `KeyframeTables`; one `DemandRegister` writer; one `MachineBudget`; memory
  read only in `machine-memory.js`; output keys parsed only by
  `OutputSpec.fromKey`; `planEncoders` called once.
- Transport framing (`encodeFrame`, `bodySender`) exists once.
- HLS content types and cache headers have one owner each.
- Only `utils/logger.js` writes to the console; `process.env` is read in one
  documented pair.
- Decision-path unit conversions (MB costs, Mbps ↔ bytes/s) are all decimal.
- Bounded maps (piece LRU, completed-files order, logger repeat map,
  wait-trace) each bound a different store.
- Release, version and changelog writing has one implementation,
  `@changesets/cli`; audit has one implementation.
- Server route validation is uniform; signalling relay, proxy scoring and
  event names have one owner each; no `px` in CSS.
- `/health` and `/healthz` have different consumers; both stay (#308 shares
  the body only).

## Order and conflicts

Priority 16.01-16.40, after the forecast series (Priority 2-15) and before
#167 (27). Defects where copies disagree come first; maintenance-only
convergence after; sub-issues that need #270-#278 or the forecast series last.

Chains (each starts after the previous one is published), because they edit
the same files:

1. proxy routes: #282 → #295 → #296 → #308, and #311 after #282, #295, #296.
2. page `loading.js`: #288 → #289 → #297 → #298 → #299; #314 after #298;
   #315 after #289 and #299; #313 after #299, #312 and #281.
3. proxy processes and machine: #291 → #292 → #316; #307 after #291 and #306.
4. proxy torrent: #283 → #306.
5. tooling: #287 → #303; #304 after #287 and #302.
6. after existing work: #317 after #270 → #318; #319 after #276; #320 after
   #273 and #263; #305 after #281.

Everything else has no prerequisite and can run in parallel with sub-issues
that touch other files. Paired releases (#281, #288, #296 → #299, #313):
the proxy ships first.

## Re-running the check

The parent's third criterion asks for the scan and the greps to be run again
once the sub-issues are done. The scan is `clones.py` beside this file:

```sh
python3 -I openspec/changes/one-way-per-task/clones.py 8 2 "$PWD/" \
  $(git ls-files | grep -E '\.(m?js|cjs)$' | grep -v '^test/' | sed "s|^|$PWD/|")
```

The greps are the acceptance criteria of the sub-issues.
