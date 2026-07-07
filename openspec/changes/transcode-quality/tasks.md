# Tasks: Transcode quality

## 1. Source fps

- [x] 1.1 hwaccel: `chooseOutputFps` (integer, capped); `buildVideoArgs`
      takes `fps`, threaded into the filter + frame-count GOP (software,
      v4l2m2m) and the filter only (nvenc); VAAPI/QSV unchanged (already
      inherit); startup test-encode/benchmark keep the fixed rate
- [x] 1.2 hls-session-manager: parse source fps from the probe, compute
      `session.outputFps`, pass it into `buildVideoArgs`
- [x] 1.3 Unit-verify fps choice and fps↔GOP consistency (25→100, 24→96,
      default→96); syntax checks

## 2. Realtime budget

- [x] 2.1 Startup: benchmark picks resolution + preset within a realtime
      margin; downscale below the client-target ceiling instead of refusing
      (`chooseSoftwareEncodeSettings`/`buildResolutionLadder` in hwaccel;
      `#chooseEncodeBudget` + `encodeWidth`/`encodeHeight` in the session
      manager; fixed the needed-pixels calc to use the session's `outputFps`
      not the fixed `TRANSCODE_FPS`). Verified on the FIFA host profile
      (720p60→480p) + strong/weak/no-benchmark profiles.
- [x] 2.2 Runtime `speed<1` watch → step down the resolution ladder + restart
      at the current segment (hard-restart tier). Gate on CPU-bound only:
      compare `getFileStats().downloadSpeed` with the source byte-rate so a
      download-starved input is NOT misread as an encoder limit (don't degrade
      quality for a download bottleneck — log it instead). Hysteresis +
      cooldown + floor + max steps; slow window reset on every (re)start; no
      upswitch in v1 (oscillation risk). `#enforceRealtimeBudget` +
      `#classifyTranscodeBound` + `#applyBudgetDownshift` in the session
      manager; `getSourceStats` injected from server.js.
      NOTE (follow-up 2.2b): seamless switch via `EXT-X-DISCONTINUITY` /
      parallel encoder tier keyed by host resources — the hard restart can blip
      at the switch point.
- [ ] 2.3 `-maxrate`/`-bufsize`

## 3. HDR tone mapping (planned)

- [ ] 3.1 Detect 10-bit/HDR; insert tonemap chain when re-encoding to 8-bit
- [ ] 3.2 Guard on tonemap-filter availability in the ffmpeg build

## 4. Manual quality (planned)

- [ ] 4.1 Proxy honours requested target height (already partly there)
- [ ] 4.2 Server Quality menu (Auto + forced resolutions)

## 5. Release

- [ ] 5.1 Batch release: proxy 2.9.29 + ha-addon bump; field-test on the
      owner's hardware (25/30 fps content plays without judder; seek intact)
