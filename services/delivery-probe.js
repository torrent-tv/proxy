/**
 * @file Numbered delivery probes, and the verdict they make possible.
 *
 * The delivery freeze (roadmap item 11) looks identical from the proxy in two
 * cases that need opposite fixes: usrsctp stopped transmitting, or the browser
 * closed its receive window because the page stopped draining the channel. The
 * proxy's own counters cannot separate them — libdatachannel's `bytesSent`
 * counts bytes ACCEPTED into usrsctp, not bytes put on the wire — so the
 * reading has to come from the far end.
 *
 * Two facts make that cheap. The reverse direction keeps working throughout the
 * freeze (browser to proxy requests arrive and are answered for the whole
 * episode, 88 min in the 2026-08-24 case), so the browser can always report.
 * And SCTP orders per STREAM, so a probe on a channel opened UNORDERED and
 * WITHOUT retransmission passes head-of-line blocking in another stream but
 * neither a closed receive window nor a transmitter that stopped.
 *
 * So: number a probe every {@link PROBE_INTERVAL_MS} on every channel of the
 * connection, have the browser echo back the highest number it has seen on
 * each, and read the gaps:
 *
 *   every channel current                to flowing
 *   ordered behind, unreliable current   to a retransmission stuck in a stream
 *   both behind, echoes still arriving   to the association stopped transmitting
 *   no echo at all                       to the reverse direction went too
 *
 * The verdict is computed from the gaps, not chosen, and every line prints the
 * numbers that produced it.
 */

/**
 * How often a probe is numbered and sent on every channel.
 *
 * Half a second, because the transport heartbeat is five and that was the whole
 * resolution the 2026-08-24 episode had: the onset could be placed no closer
 * than the five seconds between two lines. Sending is cheap - a probe is a few
 * dozen bytes - and the interval is NOT the verdict: a healthy burst can hold a
 * probe up behind queued data, so how many probes may be outstanding is worked
 * out per channel by {@link allowedGap} from the bytes queued ahead of the
 * probe and the rate they are leaving at.
 */
export const PROBE_INTERVAL_MS = 500;

/**
 * How many probes may be outstanding on a channel before it counts as behind.
 *
 * DERIVED per channel, not chosen. A probe is handed to the same association as
 * the data, and SCTP orders per stream but SCHEDULES per association: one
 * congestion window, one send buffer. So a probe waits for whatever is queued
 * ahead of it whichever channel it rides on - the unordered one included - and
 * a fixed threshold cannot tell that wait from a stopped association. Measured
 * 2026-08-26: `association-stopped` printed with all three channels at gap 4-7
 * while 110-150 Mbps crossed that same association and 7.34 GB went through it
 * without a single failure.
 *
 * What the wait costs is arithmetic on two measured quantities: the bytes
 * queued ahead of the probe, and the rate at which this connection is getting
 * bytes away. Add one round trip for the echo to come back. A probe is behind
 * only when it is later than that.
 *
 * There is a third term, and leaving it out made this worse than the constant
 * it replaced. The browser answers on ITS own schedule, not ours: it batches
 * what it has seen and echoes on a timer, and that timer is throttled to about
 * once a second whenever the tab is hidden. So with an empty queue the
 * allowance collapsed to one probe and the bound to half a second, while echoes
 * legitimately arrived every second - measured 2026-08-27, 67 `association-
 * stopped` and 66 `reverse-direction-gone` against 84 `flowing` on a connection
 * carrying 3.4 MB/s with every queue at zero. The peer's own cadence is
 * measurable on the same connection, so it is measured and added rather than
 * assumed.
 *
 * There is a fourth term, and without it the third one arrives too late to
 * help. `echoIntervalMs` is the widest gap between two echoes this connection
 * has SHOWN, so it can only grow after a late echo has landed — and a browser
 * whose tab has just been hidden goes quiet before it has taught us anything.
 * The browser measures its own event-loop delay and puts it in every echo, so
 * the delay is known BEFORE the silence rather than after it: an echo timer
 * set for half a second cannot fire until the loop runs, and a loop reported
 * as 4297 ms behind cannot answer sooner than that. Field 2026-09-03: a viewer
 * paused at 15:24:21, the tab went hidden at 15:24:35, `loopLag` climbed
 * 681 → 1881 → 4297 → 5957 ms, and at 15:26:05 the probes read `gap 12 of 11`
 * and printed `association-stopped` on a connection that was `flowing` again
 * seven seconds later. Adding the peer's own reported lag makes that allowance
 * 15 instead of 11, and the gap of 12 is then what it was — a browser whose
 * timers are frozen, not an association that stopped.
 *
 * @param {{ queuedBytes: number, bytesPerSecond: number, rttMs: number, echoIntervalMs?: number, peerLoopLagMs?: number, intervalMs?: number }} state
 * @returns {number | null} Probes that may legitimately be outstanding, or null
 *   when no rate has been measured yet and nothing can be said.
 */
export function allowedGap({
  queuedBytes,
  bytesPerSecond,
  rttMs,
  echoIntervalMs = 0,
  peerLoopLagMs = 0,
  intervalMs = PROBE_INTERVAL_MS
}) {
  if (!(bytesPerSecond > 0) || !(intervalMs > 0)) {
    return null;
  }
  const drainMs = (Math.max(queuedBytes, 0) / bytesPerSecond) * 1000;
  const waitMs =
    drainMs +
    Math.max(rttMs, 0) +
    Math.max(echoIntervalMs, 0) +
    Math.max(peerLoopLagMs, 0);
  // At least one: a probe sent and not yet echoed is the ordinary state.
  return Math.max(1, Math.ceil(waitMs / intervalMs));
}

/** The label the browser gives the unordered, non-retransmitting channel. */
export const UNRELIABLE_LABEL = "proxy-fast";

/**
 * How old an echo may be before the reverse direction counts as gone, when
 * nothing better can be derived.
 *
 * Used only while no rate has been measured. Otherwise the caller passes
 * `echoStaleMs`, worked out the same way as {@link allowedGap}: the browser
 * only echoes a probe it has RECEIVED, so an echo waits behind our own queue
 * exactly as the probe did.
 */
const ECHO_STALE_FALLBACK_MS = 5_000;

/** How often the probe state is written to the log while nothing changes. */
const REPORT_INTERVAL_MS = 5_000;

/**
 * Whether the `seen` counter has stopped advancing for longer than this
 * connection's own history says a healthy gap between two advances ever
 * takes.
 *
 * The `association-stopped` verdict alone is not enough to act on: a
 * connection can sit BEHIND by a bounded, roughly constant amount for
 * minutes (measured 2026-08-28, session on a backgrounded tab — gap held at
 * 6-7 probes for 95+ seconds while `seen` kept climbing right along with
 * `sent`) without anything being wrong. What a true wedge shows instead,
 * measured the same day against a session already known to be one
 * (`d85ae4f5`): `seen` FROZEN at one value for over a minute while `sent`
 * climbs unbounded. So the question is not "is there a gap" but "has the
 * highest-seen number stopped moving at all, for longer than it has ever
 * legitimately taken this connection to report an advance" — the same shape
 * as {@link wedgeIsCertain} in `data-channel-handler.js`, applied to the
 * probe's own counter instead of the transport's byte counter.
 *
 * @param {{ stuckForMs: number, longestHealthySeenGapMs: number, intervalMs?: number }} state
 * @returns {{ certain: boolean, needMs: number }}
 */
export function probeWedgeIsCertain({ stuckForMs, longestHealthySeenGapMs, intervalMs = PROBE_INTERVAL_MS }) {
  const needMs = Math.max(longestHealthySeenGapMs, intervalMs);
  return { certain: stuckForMs >= needMs, needMs };
}

/**
 * One connection's probe state.
 *
 * @typedef {Object} ProbeConnection
 * @property {string} tag
 * @property {Map<import('node-datachannel').DataChannel, string>} channels
 * @property {number} seq        - Highest probe number sent.
 * @property {number} sentAt     - When that probe was sent.
 * @property {Map<string, number>} seen - Label to the highest number the browser reported.
 * @property {number} echoAt     - When the last echo arrived (0 = never).
 * @property {number} echoes     - How many echoes have arrived.
 * @property {string} verdict    - Last verdict reported, so a change is logged at once.
 * @property {number} reportedAt - When the state was last written to the log.
 * @property {number} lastSeenAdvanceAt - When any label's `seen` value last increased (0 = never yet).
 * @property {number} longestHealthySeenGapMs - The longest gap between two advances this connection has shown while not flagged as a wedge.
 * @property {number | null} peerBytes - The far end's transport-level received total, as last reported.
 * @property {number | null} peerBytesAtTick - The same, as it stood at the previous tick.
 * @property {number | null} peerLoopLagMs - The far end's own event-loop delay, as last reported.
 * @property {string | null} peerVisibility - Whether the far end's tab is visible or hidden, as last reported.
 * @property {boolean} probeCaptureStarted - One evidence-gathering attempt per wedge; reset once `seen` advances again.
 * @property {ReturnType<typeof setInterval> | null} timer
 */

/**
 * Read the gaps and say what they mean.
 *
 * Exported so the rule is testable without a connection: the same numbers
 * always produce the same word.
 *
 * `allowed` carries, per channel label, how many probes may legitimately be
 * outstanding right now — {@link allowedGap} computes it from that channel's
 * own queue and the connection's measured rate. A label with no entry, or an
 * entry of null, cannot be judged: with no rate measured there is nothing to
 * divide the queue by, and the verdict says that rather than inventing one.
 *
 * `peerBytesAdvancing` is the fact that outranks every gap here. The gaps are
 * counted against an allowance whose only load-dependent term is OUR OWN
 * queue — and that queue is empty by construction, because it drains the moment
 * libdatachannel accepts the bytes, whether or not usrsctp then puts them on
 * the wire. So a browser filling its cushion as fast as the link allows shows
 * an empty queue, a small allowance and a large gap, which reads exactly like a
 * stopped association. Measured 2026-08-28: four `association-stopped` in the
 * first two minutes of a healthy session, on a connection whose every queue was
 * at 0 B and whose viewer never saw the picture stop. Deepening the browser's
 * cushion from 30 s to 120 s (roadmap item 4) made the burst four times longer
 * and the false verdict correspondingly likelier.
 *
 * What separates the two is not the size of the backlog — it is large in both —
 * but whether bytes are still arriving. The browser reports its own
 * transport-level received total with every echo, so the question is answered
 * by a counter rather than by a threshold: while that total is advancing, bytes
 * ARE crossing and no verdict of a stopped association can stand, however far
 * behind the probes are. `null` where the far end does not report it, and then
 * the rule falls back to what it says without the term.
 *
 * `peerLoopLagMs` and `peerVisibility` are printed but never compared against
 * anything here: they are what made the allowance as wide as it is, and a
 * reader of the log cannot check that arithmetic unless the terms are on the
 * same line as the result.
 *
 * @param {{ seq: number, seen: Map<string, number> | Record<string, number>, labels: string[], echoes: number, echoAgeMs: number | null, allowed?: Map<string, number | null> | Record<string, number | null>, echoStaleMs?: number, peerBytesAdvancing?: boolean | null, peerLoopLagMs?: number | null, peerVisibility?: string | null }} state
 * @returns {{ verdict: string, detail: string }}
 */
export function readProbeState(state) {
  const seenOf = (label) =>
    state.seen instanceof Map ? state.seen.get(label) : state.seen?.[label];
  const allowedOf = (label) => {
    const source = state.allowed;
    const value = source instanceof Map ? source.get(label) : source?.[label];
    return Number.isInteger(value) ? Number(value) : null;
  };
  const parts = [];
  let orderedBehind = false;
  let unreliableBehind = false;
  let unreliableKnown = false;
  let judgeable = false;
  for (const label of state.labels) {
    const seen = seenOf(label);
    const gap = Number.isInteger(seen) ? state.seq - Number(seen) : null;
    const allowance = allowedOf(label);
    parts.push(`${label}=${seen ?? "?"}(gap ${gap ?? "?"} of ${allowance ?? "?"})`);
    if (allowance === null) {
      continue;
    }
    judgeable = true;
    const behind = gap === null || gap > allowance;
    if (label === UNRELIABLE_LABEL) {
      unreliableKnown = true;
      unreliableBehind = behind;
    } else if (behind) {
      orderedBehind = true;
    }
  }
  const advancing = state.peerBytesAdvancing === true;
  const detail =
    `sent=${state.seq} ${parts.join(" ")} ` +
    `echoAge=${state.echoAgeMs === null ? "never" : `${state.echoAgeMs}ms`}` +
    (state.peerBytesAdvancing === null || state.peerBytesAdvancing === undefined
      ? ""
      : ` peerBytes=${advancing ? "advancing" : "still"}`) +
    (Number.isFinite(state.peerLoopLagMs) ? ` peerLoopLag=${Math.round(Number(state.peerLoopLagMs))}ms` : "") +
    (state.peerVisibility ? ` peerTab=${state.peerVisibility}` : "");

  if (state.echoes === 0) {
    return { verdict: "no-echo-yet", detail };
  }
  if (!judgeable) {
    return { verdict: "no-rate-yet", detail };
  }
  const staleAfterMs = Number.isFinite(state.echoStaleMs) && state.echoStaleMs > 0
    ? state.echoStaleMs
    : ECHO_STALE_FALLBACK_MS;
  if (state.echoAgeMs !== null && state.echoAgeMs > staleAfterMs) {
    return { verdict: "reverse-direction-gone", detail };
  }
  if (!orderedBehind && !(unreliableKnown && unreliableBehind)) {
    return { verdict: "flowing", detail };
  }
  // Bytes are still arriving at the far end. Whatever the probe gaps say, this
  // association has not stopped — the probes are behind a backlog, which is
  // what filling a cushion looks like from here.
  if (advancing) {
    return { verdict: "flowing", detail };
  }
  if (orderedBehind && unreliableKnown && !unreliableBehind) {
    return { verdict: "stream-stuck", detail };
  }
  if (orderedBehind) {
    return {
      verdict: unreliableKnown ? "association-stopped" : "ordered-behind-no-comparison",
      detail
    };
  }
  return { verdict: "unreliable-behind-only", detail };
}

/**
 * Create the probe service. One instance serves every session.
 *
 * @param {Object} options
 * @param {(message: string) => void} options.log
 * @param {number} [options.intervalMs]
 * @param {(sessionId: string) => object | null} [options.getTransportSnapshot]
 *   Needed only to hand the witness a remote endpoint when this probe is the
 *   one declaring a wedge.
 * @param {{ maybeCapture: (trigger: object) => boolean }} [options.witness]
 * @param {{ maybeRead: (reasonText: string) => boolean }} [options.usrsctpState]
 * @returns {{
 *   attach: (sessionId: string, tag: string, label: string, channel: import('node-datachannel').DataChannel) => void,
 *   detach: (sessionId: string, channel: import('node-datachannel').DataChannel) => void,
 *   noteEcho: (sessionId: string, echo: object) => void,
 *   dispose: () => void
 * }}
 */
export function createDeliveryProbe({
  log,
  intervalMs = PROBE_INTERVAL_MS,
  readDelivery,
  getTransportSnapshot,
  witness,
  usrsctpState
}) {
  /** @type {Map<string, ProbeConnection>} */
  const connections = new Map();

  /**
   * Send this tick's probe on every channel of one connection, then report.
   *
   * @param {ProbeConnection} connection
   * @returns {void}
   */
  function tick(connection) {
    const now = Date.now();
    connection.seq += 1;
    connection.sentAt = now;
    const message = JSON.stringify({ type: "probe", seq: connection.seq, sentAt: now });
    for (const channel of connection.channels.keys()) {
      try {
        channel.sendMessage(message);
      } catch {
        // A channel closing between the check and the send is ordinary.
      }
    }

    // What this connection is getting away, and how far behind it therefore
    // sits. Both come from the send-queue watcher, which measures them anyway.
    const delivery = typeof readDelivery === "function" ? readDelivery(connection.id) : null;
    const bytesPerSecond = Number(delivery?.bytesPerSecond) || 0;
    const rttMs = Number(delivery?.rttMs) || 0;
    /** @type {Map<string, number | null>} */
    const allowed = new Map();
    for (const [channel, label] of connection.channels) {
      let queuedBytes = 0;
      try {
        queuedBytes = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0;
      } catch {
        queuedBytes = 0;
      }
      const allowance = allowedGap({
        queuedBytes,
        bytesPerSecond,
        rttMs,
        echoIntervalMs: connection.echoIntervalMs,
        peerLoopLagMs: connection.peerLoopLagMs ?? 0,
        intervalMs
      });
      // Several channels can carry one label only in malformed cases; the
      // larger allowance is the safer of the two.
      const held = allowed.get(label);
      if (allowance !== null && (!Number.isInteger(held) || allowance > held)) {
        allowed.set(label, allowance);
      } else if (!allowed.has(label)) {
        allowed.set(label, allowance);
      }
    }
    const widest = [...allowed.values()].reduce(
      (most, value) => (Number.isInteger(value) && value > most ? value : most),
      0
    );
    // Advancing SINCE THE PREVIOUS TICK, not since the connection began: the
    // question is whether bytes are crossing now.
    const peerBytesAdvancing = connection.peerBytes === null
      ? null
      : connection.peerBytesAtTick === null || connection.peerBytes > connection.peerBytesAtTick;
    connection.peerBytesAtTick = connection.peerBytes;
    const { verdict, detail } = readProbeState({
      seq: connection.seq,
      seen: connection.seen,
      peerBytesAdvancing,
      labels: [...new Set(connection.channels.values())],
      echoes: connection.echoes,
      echoAgeMs: connection.echoAt === 0 ? null : now - connection.echoAt,
      peerLoopLagMs: connection.peerLoopLagMs,
      peerVisibility: connection.peerVisibility,
      allowed,
      // Same arithmetic for the echo's own age: the peer cannot answer sooner
      // than its own cadence allows, nor sooner than its own event loop runs.
      echoStaleMs:
        widest > 0
          ? widest * intervalMs +
            rttMs +
            connection.echoIntervalMs +
            Math.max(connection.peerLoopLagMs ?? 0, 0)
          : 0
    });
    if (verdict !== connection.verdict || now - connection.reportedAt >= REPORT_INTERVAL_MS) {
      connection.verdict = verdict;
      connection.reportedAt = now;
      log(`[dc-probe] ${connection.tag} ${verdict} — ${detail} at=${new Date(now).toISOString()}`);
    }

    // `association-stopped` alone is not certainty — see probeWedgeIsCertain.
    // A connection that is merely lagging by a bounded amount reaches this
    // verdict too (a hidden tab's own echo cadence, measured 2026-08-28), and
    // `seen` keeps advancing right along with it. Only a `seen` value that has
    // stopped moving ENTIRELY, for longer than this connection has ever shown
    // as a legitimate gap, is the wedge this exists to catch.
    const stuckForMs = connection.lastSeenAdvanceAt === 0 ? 0 : now - connection.lastSeenAdvanceAt;
    if (verdict === "association-stopped") {
      const { certain, needMs } = probeWedgeIsCertain({
        stuckForMs,
        longestHealthySeenGapMs: connection.longestHealthySeenGapMs
      });
      if (certain && !connection.probeCaptureStarted) {
        connection.probeCaptureStarted = true;
        const reasonText =
          `probe seen-counter unmoved ${Math.round(stuckForMs / 1000)}s against the ` +
          `${(needMs / 1000).toFixed(1)}s this connection's own history says is legitimate`;
        if (witness) {
          const snapshot = getTransportSnapshot?.(connection.id) ?? null;
          const started = witness.maybeCapture({
            sessionId: connection.id,
            tag: connection.tag,
            label: "probe",
            remote: snapshot?.remote ?? null,
            queuedBytes: 0,
            stuckForMs
          });
          if (!started) {
            connection.probeCaptureStarted = false;
          }
        }
        if (usrsctpState) {
          usrsctpState.maybeRead(reasonText);
        }
      }
    } else {
      // Not association-stopped any more: whatever was flagged has cleared,
      // and a later wedge on the same connection deserves its own attempt.
      connection.probeCaptureStarted = false;
    }
  }

  return {
    attach(sessionId, tag, label, channel) {
      let connection = connections.get(sessionId);
      if (!connection) {
        connection = {
          id: sessionId,
          tag,
          // The longest this peer has ever taken between two echoes. Its own
          // schedule, measured rather than assumed - a hidden tab answers
          // about once a second because the browser throttles the timer.
          echoIntervalMs: 0,
          channels: new Map(),
          seq: 0,
          sentAt: 0,
          seen: new Map(),
          echoAt: 0,
          echoes: 0,
          // The far end's own transport-level received total, and its value at
          // the previous tick. Null until a browser that reports it has echoed.
          /** @type {number | null} */
          peerBytes: null,
          /** @type {number | null} */
          peerBytesAtTick: null,
          // The far end's own event-loop delay and tab state, as last reported.
          // The lag is a term in every allowance below; the tab state is only
          // printed, so that a wide allowance can be read back to its cause.
          /** @type {number | null} */
          peerLoopLagMs: null,
          /** @type {string | null} */
          peerVisibility: null,
          verdict: "",
          reportedAt: 0,
          lastSeenAdvanceAt: 0,
          longestHealthySeenGapMs: 0,
          probeCaptureStarted: false,
          timer: null
        };
        connections.set(sessionId, connection);
      }
      connection.channels.set(channel, label);
      if (connection.timer === null) {
        const held = connection;
        connection.timer = setInterval(() => tick(held), intervalMs);
        // The probe must never be the reason a process stays alive.
        if (typeof connection.timer.unref === "function") {
          connection.timer.unref();
        }
      }
    },

    detach(sessionId, channel) {
      const connection = connections.get(sessionId);
      if (!connection) {
        return;
      }
      connection.channels.delete(channel);
      if (connection.channels.size === 0) {
        if (connection.timer !== null) {
          clearInterval(connection.timer);
          connection.timer = null;
        }
        if (connections.get(sessionId) === connection) {
          connections.delete(sessionId);
        }
      }
    },

    noteEcho(sessionId, echo) {
      const connection = connections.get(sessionId);
      if (!connection || !echo || typeof echo !== "object") {
        return;
      }
      const now = Date.now();
      const seen = echo.seen;
      if (seen && typeof seen === "object") {
        let advanced = false;
        for (const [label, value] of Object.entries(seen)) {
          if (!Number.isInteger(value)) {
            continue;
          }
          const previous = connection.seen.get(label);
          if (!Number.isInteger(previous) || value > previous) {
            advanced = true;
          }
          connection.seen.set(label, value);
        }
        // What a wedge shows is this counter frozen, not merely behind — see
        // probeWedgeIsCertain. The gap since the last time ANY label moved is
        // this connection's own answer to "how long may a healthy report take
        // to arrive", recorded only while nothing is currently flagged (the
        // same guard `longestHealthyFlatMs` uses): a stretch already under
        // suspicion must not teach the detector to tolerate it.
        if (advanced) {
          if (connection.lastSeenAdvanceAt !== 0 && !connection.probeCaptureStarted) {
            const gap = now - connection.lastSeenAdvanceAt;
            if (gap > connection.longestHealthySeenGapMs) {
              connection.longestHealthySeenGapMs = gap;
            }
          }
          connection.lastSeenAdvanceAt = now;
        }
      }
      // What the far end says it has received at the transport level. It is the
      // one figure that separates a backlog from a stopped association, and it
      // arrives on the direction that goes on working through a freeze.
      const peerBytes = Number(echo?.report?.transportBytesReceived);
      if (Number.isFinite(peerBytes) && peerBytes >= 0) {
        connection.peerBytes = peerBytes;
      }
      // How far behind the far end's own event loop is running. A browser that
      // cannot run its timers cannot answer a probe, and every allowance here
      // is a wait the answer has to fit inside — so this is a term in the
      // arithmetic, not a note. It is the peer's own measurement, taken on the
      // peer, and it arrives on the direction that survives a freeze.
      const peerLoopLag = Number(echo?.report?.loopLagMs);
      if (Number.isFinite(peerLoopLag) && peerLoopLag >= 0) {
        connection.peerLoopLagMs = peerLoopLag;
      }
      const peerVisibility = echo?.report?.visibility;
      if (typeof peerVisibility === "string" && peerVisibility.length > 0) {
        connection.peerVisibility = peerVisibility;
      }
      if (connection.echoAt !== 0) {
        const sinceLast = now - connection.echoAt;
        if (sinceLast > connection.echoIntervalMs) {
          connection.echoIntervalMs = sinceLast;
        }
      }
      connection.echoAt = now;
      connection.echoes += 1;
    },

    dispose() {
      for (const connection of connections.values()) {
        if (connection.timer !== null) {
          clearInterval(connection.timer);
          connection.timer = null;
        }
      }
      connections.clear();
    }
  };
}
