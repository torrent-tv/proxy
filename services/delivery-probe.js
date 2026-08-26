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
 * probe up behind queued data, so the verdict takes {@link MISSES_FOR_VERDICT}
 * consecutive probes.
 */
export const PROBE_INTERVAL_MS = 500;

/**
 * How many probes may be outstanding on a channel before it counts as behind.
 *
 * A segment of 6-11 MB leaves in well under a second when the link is healthy,
 * but it shares the association with the probe, so one or two probes can
 * legitimately sit behind it. Four is two seconds - longer than any measured
 * healthy burst, shorter than the five seconds the old heartbeat needed to say
 * anything at all.
 */
export const MISSES_FOR_VERDICT = 4;

/** The label the browser gives the unordered, non-retransmitting channel. */
export const UNRELIABLE_LABEL = "proxy-fast";

/** An echo older than this means the reverse direction has stopped too. */
const ECHO_STALE_MS = 5_000;

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
 * @param {{ seq: number, seen: Map<string, number> | Record<string, number>, labels: string[], echoes: number, echoAgeMs: number | null }} state
 * @returns {{ verdict: string, detail: string }}
 */
export function readProbeState(state) {
  const seenOf = (label) =>
    state.seen instanceof Map ? state.seen.get(label) : state.seen?.[label];
  const parts = [];
  let orderedBehind = false;
  let unreliableBehind = false;
  let unreliableKnown = false;
  for (const label of state.labels) {
    const seen = seenOf(label);
    const gap = Number.isInteger(seen) ? state.seq - Number(seen) : null;
    parts.push(`${label}=${seen ?? "?"}(gap ${gap ?? "?"})`);
    const behind = gap === null || gap >= MISSES_FOR_VERDICT;
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
  if (state.echoAgeMs !== null && state.echoAgeMs > ECHO_STALE_MS) {
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
export function createDeliveryProbe({ log, intervalMs = PROBE_INTERVAL_MS }) {
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

    const { verdict, detail } = readProbeState({
      seq: connection.seq,
      seen: connection.seen,
      labels: [...new Set(connection.channels.values())],
      echoes: connection.echoes,
      echoAgeMs: connection.echoAt === 0 ? null : now - connection.echoAt
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
