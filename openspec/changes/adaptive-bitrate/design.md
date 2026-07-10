# Design: Adaptive bitrate (proxy)

Read before coding: `services/hwaccel.js` (`chooseSoftwareEncodeSettings`,
the software descriptor's `buildVideoArgs`), `services/hls-session-manager.js`
(the `BUDGET_*` constants, `#chooseEncodeBudget`, the budget interval check
`#enforceRealtimeBudget`, `#classifyTranscodeBound`, `#applyBudgetDownshift`,
session fields around `budgetLadder`), `routes/api/transcode-sessions/`
(route file conventions), `server.js` (route wiring, deps injection).

## (a) Caps — constrained CRF

Nominal H.264 rates by rung height (nearest rung wins for odd heights):

    RUNG_NOMINAL_KBPS = { 1080: 5000, 720: 2800, 480: 1400, 360: 800, 240: 400 }
    CAP_MAXRATE_FACTOR = 1.3
    CAP_BUFSIZE_FACTOR = 1.5

In the software descriptor's video args (where `-crf`/`-preset` are emitted),
add for encode height H (the actual encode height after budget/manual
selection, not the source height):

    -maxrate <round(nominal(H) * 1.3)>k
    -bufsize <round(nominal(H) * 1.5)>k

CRF stays the quality driver; the caps only bound peaks (standard
constrained-CRF). Do NOT touch hardware descriptors in this change.

## (b) Net report intake

Route: `POST /api/transcode-sessions/:id/net-report` (data-channel path, so
add the prefix to the allowlist regex in `data-channel-handler.js` if not
covered by the existing `/api/` rule — verify). Body:

    { linkMbps: number, bufferedAheadSec: number }

Validation: both finite numbers, `linkMbps > 0`, else 400. Unknown session →
404. On success 204. Handler stores on the session:

    session.netReport = { linkMbps, bufferedAheadSec, at: Date.now() }

## (b) Budget-loop trigger

Constants (near the other BUDGET_ constants):

    LINK_REPORT_FRESH_MS = 30_000   // ignore stale reports
    LINK_SAFETY = 0.8               // usable share of reported link
    LINK_SLOW_WINDOW_MS = 15_000    // sustained deficit before acting
    LINK_LOW_BUFFER_SEC = 10        // only act while the viewer runs dry

In the periodic budget check, for each active software-transcode session,
alongside the CPU check:

    report fresh (now - at < LINK_REPORT_FRESH_MS)?
    manualQuality not set?
    observed = observed stream bitrate, Mbit/s — recent produced segment
               bytes / segment duration (reuse/extend whatever the CPU path
               reads; a rolling average over the last ~5 segments)
    deficit = report.linkMbps * LINK_SAFETY < observed
    if deficit AND report.bufferedAheadSec < LINK_LOW_BUFFER_SEC:
        accumulate slow-time (same pattern as the CPU slow window)
        if slow ≥ LINK_SLOW_WINDOW_MS → #applyBudgetDownshift(session,
            reason "link")   // existing cooldown + step cap + floor apply
    else: reset the link slow window

`#applyBudgetDownshift` is reused as-is except the log line carries the
reason: `budget downshift (link) …` vs the current CPU wording, so the
client-log pipeline can tell them apart in the field.

No upswitch in v1 (mirrors the CPU budget's conservatism). A downshifted
session stays down until re-opened.

## Interactions

- Caps make `observed` honest: without (a) a complex scene can spike far
  above nominal and flap the trigger; with caps observed ≤ maxrate.
- CPU trigger and link trigger share the cooldown inside
  `#applyBudgetDownshift` — they cannot double-fire.
- `manualQuality` set → link trigger skipped entirely (user pinned quality
  explicitly; the proxy respects it, matching the manual-quality contract).
- Old browsers never POST reports → trigger never fires → behaviour
  identical to today plus caps.

## Verification

- Unit: nominal table lookup (exact rungs + nearest for odd heights); ffmpeg
  arg assembly contains the caps; trigger logic with a fake clock (fresh vs
  stale report, deficit accumulating to a downshift, buffer-high suppresses,
  manualQuality suppresses).
- `node --check` on touched files.
- Field (after the server change ships): cellular session shows
  `budget downshift (link)` and the stream settles at a rung whose bitrate
  fits the link; segment sizes bounded (~maxrate × segDur / 8 max).
