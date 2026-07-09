# Tasks: Debounce server-side seek restarts

## 1. Implementation (proxy)

- [x] 1.1 Add `SEEK_SETTLE_MS = 1200` and `SEEK_SETTLE_MAX_MS = 2500` to the
      constants block in `hls-session-manager.js`.
- [x] 1.2 Add session state `seekSettleTimer: null`, `seekTarget: null`,
      `seekFirstFarAt: 0` where `lastRestartAt` is initialised.
- [x] 1.3 Rewrite the out-of-window branch of `#ensureEncodingFor` as the
      settle/debounce (design.md): record target, arm/re-arm the timer with
      the capped delay, restart once on fire (`#fireSettledSeek`), re-arm for
      the cooldown remainder if still cooling down. `timer.unref?.()`.
- [x] 1.4 `disposeSession`: clear `seekSettleTimer` and null it.
- [x] 1.5 Restart log line: `transcode <id> seek settle → restart at segment #<target>`.

## 2. Verification

- [x] 2.1 Timing/target logic verified with a fake-clock replica: burst
      `367,732,369,368,370` → one restart at 370; lone later far request →
      exactly one more restart (900); disposal mid-settle → no restart; the
      2.5 s cap forces a fire while the scrubber keeps moving. (Replica, not
      the wired private method — the methods are private and `#startEncodeRun`
      spawns ffmpeg; the wired code mirrors the replica.)
- [x] 2.2 `node --check services/hls-session-manager.js`.

## 3. Release

- [ ] 3.1 CHANGELOG (proxy, next patch) + `npm run patch` (user OTP).
- [ ] 3.2 Bump `ha-addon/torrent_tv_proxy/config.yaml` + CHANGELOG; push;
      update the addon in HA.
- [ ] 3.3 Field: scrub Poirot on iOS → a single `seek settle → restart` per
      scrub (not a train of `seek → restart`), playback resumes after the
      settle + the unavoidable cold-segment wait.
