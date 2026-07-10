# Proposal: Adaptive bitrate for thin viewer links (proxy side)

## Why

Field evidence (iPhone on cellular, 2026-07-10, session `14cc1017`): encode
bitrate is unbounded — transcoded segments reached 9 MB per 4 s (~18 Mbit/s)
against a measured 1–5.8 Mbit/s cellular link. Result: 45 s prebuffer, buffer
draining during playback (`bottleneck delta=-7.1s`), "было так себе". The
realtime budget protects the PROXY's CPU but nothing protects the VIEWER's
link: quality never adapts to how fast the viewer can actually download.

## What Changes

Two parts, one release:

- **(a) Bitrate caps (constrained CRF).** Software video encodes gain
  `-maxrate`/`-bufsize` sized per resolution rung from a nominal-rate table
  (H.264 ladder: 1080p→5000K, 720p→2800K, 480p→1400K, 360p→800K, 240p→400K;
  nearest rung by encode height). Multipliers from webtor's production
  ladder: `maxrate = 1.3×` nominal, `bufsize = 1.5×` nominal. CRF/preset
  selection stays — the caps only bound the peaks that killed the cellular
  session. Applies to the software (libx264) path; hardware encoders keep
  their current args (follow-up — their rate-control flags differ and any
  change must pass the strict startup test on real hardware).
- **(b) Viewer-link downshift trigger.** A new data-channel route lets the
  browser report its measured link state (`linkMbps` — rolling median of
  per-segment transfer throughput; `bufferedAheadSec`) every ~10 s. The
  existing realtime-budget loop gains a SECOND downshift trigger: when
  reports are fresh, `manualQuality` is not set, the viewer's link is
  sustainedly slower than the produced stream (`linkMbps × 0.8 <` observed
  segment bitrate for ≥ 15 s) AND the viewer's buffer is low (< 10 s), step
  one rung down via the existing `#applyBudgetDownshift` (same cooldown,
  step cap, no upswitch v1). Distinct log reason (`reason=link`) so field
  logs distinguish CPU-bound from link-bound downshifts.

Missing/stale reports change nothing (old clients keep working — the trigger
simply never fires). Manual quality pins win: when `manualQuality` is set the
trigger is skipped.

## Capabilities

### Modified Capabilities

- `transcode-quality`: encodes are bitrate-capped per rung; the budget loop
  adapts to the viewer's link, not only to the proxy's CPU.

## Impact

- `services/hwaccel.js` — nominal-rate table + caps in the software
  descriptor's video args.
- `services/hls-session-manager.js` — accept/store net reports per session;
  link trigger in the budget check; log line.
- `routes/api/transcode-sessions/net-report/post.js` (new) + `server.js`
  wiring — report intake.
- Proxy release + ha-addon bump. The server-side reporter is a separate
  change (`server/viewer-net-report`); release proxy+addon FIRST.
