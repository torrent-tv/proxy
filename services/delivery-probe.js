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
 * @param {{ queuedBytes: number, bytesPerSecond: number, rttMs: number, intervalMs?: number }} state
 * @returns {number | null} Probes that may legitimately be outstanding, or null
 *   when no rate has been measured yet and nothing can be said.
 */
export function allowedGap({ queuedBytes, bytesPerSecond, rttMs, intervalMs = PROBE_INTERVAL_MS }) {
  if (!(bytesPerSecond > 0) || !(intervalMs > 0)) {
    return null;
  }
  const drainMs = (Math.max(queuedBytes, 0) / bytesPerSecond) * 1000;
  const waitMs = drainMs + Math.max(rttMs, 0);
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
 * @param {{ seq: number, seen: Map<string, number> | Record<string, number>, labels: string[], echoes: number, echoAgeMs: number | null, allowed?: Map<string, number | null> | Record<string, number | null>, echoStaleMs?: number }} state
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
  const detail =
    `sent=${state.seq} ${parts.join(" ")} ` +
    `echoAge=${state.echoAgeMs === null ? "never" : `${state.echoAgeMs}ms`}`;

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
 * @returns {{
 *   attach: (sessionId: string, tag: string, label: string, channel: import('node-datachannel').DataChannel) => void,
 *   detach: (sessionId: string, channel: import('node-datachannel').DataChannel) => void,
 *   noteEcho: (sessionId: string, echo: object) => void,
 *   dispose: () => void
 * }}
 */
export function createDeliveryProbe({ log, intervalMs = PROBE_INTERVAL_MS, readDelivery }) {
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
      const allowance = allowedGap({ queuedBytes, bytesPerSecond, rttMs, intervalMs });
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
    const { verdict, detail } = readProbeState({
      seq: connection.seq,
      seen: connection.seen,
      labels: [...new Set(connection.channels.values())],
      echoes: connection.echoes,
      echoAgeMs: connection.echoAt === 0 ? null : now - connection.echoAt,
      allowed,
      echoStaleMs: widest > 0 ? widest * intervalMs + rttMs : 0
    });
    if (verdict !== connection.verdict || now - connection.reportedAt >= REPORT_INTERVAL_MS) {
      connection.verdict = verdict;
      connection.reportedAt = now;
      log(`[dc-probe] ${connection.tag} ${verdict} — ${detail} at=${new Date(now).toISOString()}`);
    }
  }

  return {
    attach(sessionId, tag, label, channel) {
      let connection = connections.get(sessionId);
      if (!connection) {
        connection = {
          id: sessionId,
          tag,
          channels: new Map(),
          seq: 0,
          sentAt: 0,
          seen: new Map(),
          echoAt: 0,
          echoes: 0,
          verdict: "",
          reportedAt: 0,
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
      const seen = echo.seen;
      if (seen && typeof seen === "object") {
        for (const [label, value] of Object.entries(seen)) {
          if (Number.isInteger(value)) {
            connection.seen.set(label, value);
          }
        }
      }
      connection.echoAt = Date.now();
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
