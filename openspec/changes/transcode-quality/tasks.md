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

## 2. Realtime budget (planned)

- [ ] 2.1 Benchmark picks encoder/preset/resolution/fps within a realtime
      margin; downscale instead of refuse
- [ ] 2.2 Runtime `speed<1` watch → restart with a lighter profile
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
