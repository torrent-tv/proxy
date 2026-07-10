# Tasks: Adaptive bitrate (proxy)

## 1. Caps

- [x] 1.1 `hwaccel.js`: `RUNG_NOMINAL_KBPS` table + nearest-rung lookup;
      software descriptor's video args emit `-maxrate`/`-bufsize`
      (1.3× / 1.5× nominal for the actual encode height). Hardware
      descriptors untouched.

## 2. Net report intake

- [x] 2.1 `routes/api/transcode-sessions/net-report/post.js`: validate
      `{ linkMbps, bufferedAheadSec }`, store
      `session.netReport = { linkMbps, bufferedAheadSec, at }`, 204/400/404.
- [x] 2.2 Wire in `server.js`; verify the data-channel path allowlist covers
      the route.

## 3. Budget trigger

- [x] 3.1 Constants `LINK_REPORT_FRESH_MS`, `LINK_SAFETY`,
      `LINK_SLOW_WINDOW_MS`, `LINK_LOW_BUFFER_SEC`.
- [x] 3.2 Observed produced bitrate (rolling, last ~5 segments) available to
      the budget check.
- [x] 3.3 Link deficit accumulation + `#applyBudgetDownshift(session,
      reason "link")`; skip on manualQuality/stale/comfortable buffer; log
      reason distinctly.

## 4. Verification

- [x] 4.1 Unit: table lookup, arg assembly, trigger logic (fake clock):
      deficit→downshift, stale report→no-op, high buffer→no-op,
      manualQuality→no-op.
- [x] 4.2 `node --check` on touched files.

## 5. Release

- [ ] 5.1 CHANGELOG (next patch) + `npm run patch` (user OTP), then addon
      bump + push + HA update. Release BEFORE the server reporter change.
- [ ] 5.2 Field: cellular Poirot/Mavka run shows `budget downshift (link)`
      and bounded segment sizes; correlate via client-log pipeline.
