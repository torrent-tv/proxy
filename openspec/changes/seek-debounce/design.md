# Design: Debounce server-side seek restarts

Normative — member names, constants, and edge cases as written. Read before
coding:

- `services/hls-session-manager.js`: `#ensureEncodingFor(session, index)`
  (line ~1478 — the restart decision), the session object shape where
  `lastRestartAt` / `pendingRestartIndex` / `encodeStartIndex` live (~883),
  `#startEncodeRun`, `disposeSession` (must clear timers), and the constants
  block (~36–58).

## Current behaviour (what we are replacing)

`#ensureEncodingFor` runs per segment request:

1. Compute the look-ahead window `[head, currentSeg + MAX_LOOKAHEAD_SEGMENTS]`.
2. In window → return (the running encode will reach it).
3. Out of window (a seek) → if `now - lastRestartAt < RESTART_COOLDOWN_MS`,
   skip; else `#startEncodeRun(session, index)` immediately.

The cooldown is a fixed 4 s gap. Requests spaced wider than 4 s each restart
→ ping-pong. That is the bug.

## New behaviour: settle window (debounce)

Keep steps 1–2. Replace step 3 with a debounce:

    far request (index outside window):
      session.seekTarget = index                       // last far index wins
      if (!session.seekSettleTimer):
        session.seekFirstFarAt = now()
      else:
        clearTimeout(session.seekSettleTimer)
      const waited = now() - session.seekFirstFarAt
      const delay = waited >= SEEK_SETTLE_MAX_MS ? 0
                    : Math.min(SEEK_SETTLE_MS, SEEK_SETTLE_MAX_MS - waited)
      session.seekSettleTimer = setTimeout(() => fireSettledSeek(session), delay)
      return                                            // do NOT restart now

    fireSettledSeek(session):
      const target = session.seekTarget
      session.seekSettleTimer = null
      session.seekTarget = null
      session.seekFirstFarAt = 0
      if (session disposed or target == null) return
      // Minimum gap between actual restarts (defensive; the settle already
      // collapses bursts). If still cooling down, re-arm once for the
      // remaining cooldown instead of restarting.
      const sinceRestart = now() - (session.lastRestartAt ?? 0)
      if (sinceRestart < RESTART_COOLDOWN_MS):
        session.seekFirstFarAt = now()
        session.seekTarget = target
        session.seekSettleTimer = setTimeout(() => fireSettledSeek(session),
                                             RESTART_COOLDOWN_MS - sinceRestart)
        return
      log(`transcode ${id} seek settle → restart at #${target}`)
      this.#startEncodeRun(session, target)             // sets lastRestartAt

Notes:
- `timer.unref?.()` on each `setTimeout` so a pending settle never keeps the
  process alive (mirror the codebase's other timers).
- A far request whose `index` equals the current `seekTarget` still re-arms
  the timer (the player is still asking for the same place — that is fine, it
  just extends the quiet period up to the cap).
- If, while a settle is pending, the running encode advances so a later
  request falls back INSIDE the window, that request returns at step 2 and
  does not touch the settle. The pending settle still fires for the recorded
  target; that is acceptable (it restarts at a position the player recently
  wanted). Simplicity over cleverness.

## Constants (add to the constants block)

    // Quiet period after a far (seek) segment request before ffmpeg is
    // restarted at it. Further far requests within the period re-arm it, so a
    // scrub that emits a burst of scattered requests collapses to ONE restart
    // at the position the player ended on.
    SEEK_SETTLE_MS = 1200
    // Hard cap on the total settle wait measured from the first far request of
    // a burst, so a still-moving scrubber cannot delay a real seek forever.
    SEEK_SETTLE_MAX_MS = 2500

`MAX_LOOKAHEAD_SEGMENTS` and `RESTART_COOLDOWN_MS` keep their current values;
`RESTART_COOLDOWN_MS` is now only the floor between actual restarts.

## Session state (add where lastRestartAt is initialised, ~883)

    seekSettleTimer: null,   // pending settle timer handle or null
    seekTarget: null,        // pending far segment index to restart at
    seekFirstFarAt: 0,       // timestamp of the first far request in the burst

## Disposal

`disposeSession` (and any teardown that abandons a session) MUST
`clearTimeout(session.seekSettleTimer)` and null it, so a settle cannot fire
after disposal and restart a dead session.

## Why proxy-side, not client-side (the user's original framing)

The user asked for a scrubber-release debounce. On the in-page media-chrome
control that is possible but fragile, and — decisively — it cannot cover the
iOS **native fullscreen** player, whose scrubber the web app does not control;
the failing session was exactly iOS. The proxy sees the segment requests from
EVERY client (native iOS, hls.js, direct `<video>`), so debouncing the
restart here is the one place that fixes all of them. An in-page scrubber
debounce may still be added later as a responsiveness nicety; it is not a
substitute and is out of scope here.

## Verification

- Unit-test the timing/target logic in isolation (a fake session + a fake
  clock/`setTimeout`): a burst of far requests `367,732,369,368,370` within
  the window collapses to a single `#startEncodeRun` at the LAST index (370),
  and a lone later far request triggers exactly one more restart.
- `node --check`.
- Field: the earlier hang scenario (scrub Poirot on iOS) should now produce a
  single `seek settle → restart` log line per scrub instead of a train of
  `seek → restart` lines, and playback should resume after one settle + the
  (separate, unavoidable) cold-segment wait.
