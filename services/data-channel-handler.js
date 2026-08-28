/**
 * @file WebRTC data channel request handler (proxy side).
 *
 * When a browser opens a data channel to this proxy, this handler wires up
 * message handlers that implement an HTTP-over-DataChannel protocol:
 * each incoming `request` message triggers a local `fetch` to the Fastify
 * server, and the response is streamed back as base64-encoded chunks.
 *
 * ## Wire protocol
 *
 * Browser → Proxy
 * ```
 * { type: "request",  requestId, method, path, query, headers, body }
 * { type: "ping",     id }
 * { type: "probe-echo", seen: { <label>: seq }, report }
 * ```
 *
 * Proxy → Browser
 * ```
 * { type: "probe",          seq, sentAt }                   (JSON string)
 * { type: "response-start", requestId, status, headers }   (JSON string)
 * { type: "response-error", requestId, error: string }     (JSON string)
 * { type: "pong",           id }                            (JSON string)
 * { type: "subtitle-cues",  fileIndex, trackIndex, cues, language, cursor } (JSON string)
 * ```
 * The last one is unsolicited — sent the moment new cues are read from a
 * file's already-downloaded pieces, to whichever channel last asked for that
 * file's subtitles over `/api/subtitles`. Not a response to any `requestId`.
 *
 * Response bodies are sent as BINARY data-channel messages (not JSON), to
 * avoid the ~33% base64 overhead and the JSON encode/decode cost. Each binary
 * frame is laid out as:
 * ```
 * byte 0          flags     (bit 0: done)
 * byte 1          idLen     (length of the requestId in bytes)
 * bytes 2..2+N    requestId (ASCII)
 * bytes 2+N..     payload   (raw body bytes; empty on the final done frame)
 * ```
 * Control messages stay JSON strings so the browser can distinguish them from
 * body frames by message type (string vs ArrayBuffer).
 *
 * The protocol mirrors the tunnel relay protocol so both transports share
 * the same mental model and the same browser-side `WebRtcProxy` implementation.
 */

/** @import { DataChannel } from 'node-datachannel' */

import { deriveSourceKey } from "./torrent-source-key.js";
import { createDeliveryProbe, PROBE_INTERVAL_MS } from "./delivery-probe.js";

/**
 * Configuration for the data channel handler.
 *
 * @typedef {Object} DataChannelHandlerOptions
 * @property {number} proxyPort
 *   Local port the proxy's Fastify HTTP server is listening on.
 *   Incoming requests are forwarded to `http://127.0.0.1:{proxyPort}`.
 * @property {(message: string) => void} [onLog]
 *   Optional log sink.
 * @property {{ maybeCapture: (trigger: {
 *   sessionId: string, tag: string, label: string,
 *   remote: { address: string, port: number } | null,
 *   queuedBytes: number, stuckForMs: number
 * }) => boolean }} [witness]
 *   The packet witness (services/packet-witness.js). When {@link wedgeIsCertain}
 *   says delivery has stopped, the watcher hands it the transport snapshot's
 *   remote endpoint: the ring's history is kept and a tail capture records what
 *   the wire actually does. Optional; absent means no captures are taken.
 */

/**
 * An incoming request message received over the data channel.
 *
 * @typedef {Object} DataChannelRequest
 * @property {string}  requestId
 * @property {string}  method    - HTTP method (GET, POST, …).
 * @property {string}  path      - Request path (e.g. "/api/sources").
 * @property {string}  query     - Raw query string without the leading "?".
 * @property {Record<string, string>} headers - Headers to forward.
 * @property {string | null} body - Request body string, or null.
 */

/**
 * The object returned by {@link createDataChannelHandler}.
 *
 * @typedef {Object} DataChannelHandler
 * @property {(sessionId: string, channel: DataChannel) => void} handleChannel
 *   Wire message handlers onto a freshly opened data channel.
 */

/**
 * How long a wedge must hold before the packet witness is asked for evidence.
 *
 * Derived per connection rather than chosen, because a chosen number is what
 * cost the two field captures their onset: the previous rule waited a flat 30 s
 * and the recording therefore began half a minute after the interesting part.
 *
 * Three quantities, all measured on this connection:
 *
 *   the queue's own drain time — `queuedBytes / bytesPerSecond`, how long a
 *   healthy channel would need to clear what is sitting in it, at the best rate
 *   this very connection has been seen to move bytes at;
 *
 *   the longest this connection has EVER paused while healthy — an ordinary
 *   retransmission timeout stops the accepted-byte counter dead for as long as
 *   it lasts, because a full send buffer accepts nothing, and a link with loss
 *   does that routinely. The longest such pause already observed here is what
 *   the link's own behaviour says a legitimate pause looks like;
 *
 *   the interval at which we offer bytes at all — the delivery probe hands
 *   every channel a message every {@linkcode PROBE_INTERVAL_MS}, so in health
 *   the accepted-byte counter cannot stand still for longer than that.
 *
 * A wedge is certain once ALL of them have passed with the counter unmoved.
 * Without a rate there is nothing to divide by, and the function says so
 * instead of guessing.
 *
 * @param {{ queuedBytes: number, bytesPerSecond: number, flatForMs: number, longestHealthyFlatMs?: number }} state
 * @returns {{ certain: boolean, needMs: number | null }}
 */
export function wedgeIsCertain({ queuedBytes, bytesPerSecond, flatForMs, longestHealthyFlatMs = 0 }) {
  if (!(queuedBytes > 0) || !(bytesPerSecond > 0)) {
    return { certain: false, needMs: null };
  }
  const drainMs = (queuedBytes / bytesPerSecond) * 1000;
  const needMs = Math.max(drainMs, longestHealthyFlatMs, PROBE_INTERVAL_MS);
  return { certain: flatForMs >= needMs, needMs };
}

/**
 * Watch one channel's send queue and, when it stops draining, say WHY.
 *
 * A channel that is open, keeps accepting requests and delivers nothing was
 * seen in the field 2026-08-06: the queue grew from 214 049 to 239 731 bytes in
 * fourteen seconds and never fell, while every layer above reported success —
 * the route answered in 15 ms, the handler sent 378 bytes, the channel was
 * open. The viewer sat in front of a spinner for eleven minutes.
 *
 * `bufferedAmount` alone cannot say why: it only proves the bytes are still
 * OURS. The transport counters can, and this is the table the snapshot is read
 * against — written down in advance so the answer is a reading, not an opinion:
 *
 *   bytesSent rising, queue rising    → packets leave, nothing acknowledges
 *                                       them: the return path is broken.
 *   bytesSent flat, queue rising      → SCTP is not transmitting: the peer's
 *                                       receive window is shut or congestion
 *                                       control has collapsed.
 *   bytesReceived rising either way   → the peer is alive and its packets do
 *                                       reach us; the failure is one-way.
 *   both flat                         → nothing crosses at all.
 *
 * Sampled every second; reported only once the queue has failed to fall for
 * {@link SEND_QUEUE_STUCK_MS}, then every second while it lasts, so the trend
 * of every counter is in the log rather than one snapshot of it.
 *
 * @param {string} sessionId
 * @param {string} tag
 * @param {string} label
 * @param {DataChannel} channel
 * @returns {() => void} Stops the watch.
 */
function makeSendQueueWatcher({ log, getTransportSnapshot, witness, usrsctpState }) {
  // Every channel of one connection reads the SAME transport counters — the
  // snapshot describes the peer connection, not the channel — so the heartbeat
  // belongs to the connection and is printed once for it. Printed per channel
  // it produced two byte-for-byte identical lines (measured 2026-08-14:
  // `sent=5153491` under both "proxy" and "proxy-control"), which read as two
  // independent readings agreeing and made the second channel invisible: the
  // one thing that IS per channel, its queue depth, was the only real
  // difference and it was buried in a line that looked like a duplicate.
  //
  // sessionId → the channels currently open on that connection, and when it was
  // last reported. Channels are keyed by the channel OBJECT, not by its label:
  // a label is whatever the peer chose and two channels can carry the same one
  // (or none, where `getLabel` is missing and both fall back to "?"), and a
  // Map keyed on that would let one channel evict the other and then, on
  // closing, delete the survivor's entry. `captureStarted` rides on the same
  // record: both channels of one wedged connection must ask the witness once,
  // not once per channel.
  /** @type {Map<string, { channels: Map<DataChannel, string>, at: number, previous: object | null, unknown: number, captureStarted: boolean }>} */
  const connections = new Map();

  /**
   * What each channel of a connection is holding, right now.
   *
   * @param {Map<DataChannel, string>} channels
   * @returns {string} `label:NB` per channel, in the order they opened.
   */
  const queueDepths = (channels) => {
    const parts = [];
    for (const [openChannel, channelLabel] of channels) {
      let depth = -1;
      try {
        depth = typeof openChannel.bufferedAmount === "function" ? openChannel.bufferedAmount() : 0;
      } catch {
        depth = -1;
      }
      parts.push(`${channelLabel}:${depth}B`);
    }
    return parts.join(" ");
  };

  /**
   * What this connection is getting away, for whoever else needs it.
   *
   * The delivery probe judges a late probe against the queue ahead of it, and
   * the queue's drain time needs a rate. It is measured here already, once a
   * second, so it is read from here rather than measured twice.
   *
   * @param {string} sessionId
   * @returns {{ bytesPerSecond: number, rttMs: number } | null}
   */
  const readDelivery = (sessionId) => {
    const connection = connections.get(sessionId);
    if (!connection) {
      return null;
    }
    return {
      bytesPerSecond: connection.bytesPerSecond,
      rttMs: Number(connection.previous?.rtt) || 0
    };
  };

  /**
   * @param {string} sessionId
   * @param {string} tag
   * @param {string} label
   * @param {DataChannel} channel
   * @returns {() => void} Stops the watch.
   */
  const watchSendQueue = (sessionId, tag, label, channel) => {
    let lowestSinceDrain = Number.POSITIVE_INFINITY;
    let stuckSince = 0;
    let previous = null;
    // The peer's byte count when this queue stopped falling. What separates a
    // wedge from an ordinary dead connection is that the far end keeps sending
    // throughout — measured across the whole wedge window rather than sampled
    // in a one-second slice, because the browser polls every 1.5 s and plenty
    // of individual seconds are legitimately empty.
    let receivedWhenStuck = -1;
    // Per CHANNEL, not per connection: `proxy-control` and `proxy-fast` hold an
    // empty queue in health and tick every second, so a flag shared with them
    // would be cleared a second after the wedged channel set it and the line
    // would print for every second of a 54-minute episode.
    let wedgeSaid = false;
    let connection = connections.get(sessionId);
    if (!connection) {
      connection = {
        channels: new Map(),
        at: 0,
        previous: null,
        unknown: 0,
        captureStarted: false,
        // The accepted-byte counter and when it last moved, plus the rate it
        // was moving at. `wedgeIsCertain` divides the queue by that rate.
        rateAt: 0,
        sentAt: 0,
        sentBytes: 0,
        bytesPerSecond: 0,
        longestHealthyFlatMs: 0
      };
      connections.set(sessionId, connection);
    }
    connection.channels.set(channel, label);
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null;
    let stopped = false;
    // Record the wire for as long as this channel is open. Held here rather
    // than beside `onClosed`, because `onClosed` does not always come — a peer
    // connection can die without it — and the watch below already ends itself
    // when the transport stops answering. A hold that outlives its channel
    // would leave tcpdump writing on an idle proxy for the life of the process.
    witness?.holdRing?.();
    /**
     * End this channel's watch and let go of its entry.
     *
     * @returns {void}
     */
    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      witness?.releaseRing?.();
      if (timer) {
        clearInterval(timer);
      }
      connection.channels.delete(channel);
      // Only if the map still holds THIS record: a late stop, after the same
      // session id has been reused and a new record made for it, must not evict
      // the live one.
      if (connection.channels.size === 0 && connections.get(sessionId) === connection) {
        connections.delete(sessionId);
      }
    };
    // Independent of the queue: the transport's own counters, sampled for as
    // long as the channel is open. The queue was the wrong thing to watch —
    // field 2026-08-06, a 9.26 MB segment was accepted by the transport with
    // `maxBuffered=0 bufferedAtEnd=0`, reported as sent at 274 Mbit/s, and
    // never arrived; everything the proxy sent from that moment on was lost the
    // same way while requests kept coming the other direction. With nothing
    // queued this watcher never woke, so the one question that matters — did
    // those bytes leave the machine — has no answer in the log. It does now.
    // A connection the transport no longer knows about is gone, whatever the
    // channel says. `onClosed` is the ordinary way this watch ends, and it does
    // not always come — a peer connection can die without it, leaving the timer
    // and this channel's entry behind for the life of the process.
    //
    // The count is kept on the CONNECTION: exactly one channel enters the
    // heartbeat branch per interval, so a per-channel count would advance only
    // on that channel's turn and the teardown would take three heartbeats per
    // channel rather than three in total.
    timer = setInterval(() => {
      const sampledAt = Date.now();
      // Whichever channel's timer arrives first past the interval reports for
      // the whole connection; the others find the timestamp already moved and
      // skip. So the line appears once however many channels are open.
      if (sampledAt - connection.at >= TRANSPORT_HEARTBEAT_MS) {
        connection.at = sampledAt;
        const snapshot = getTransportSnapshot?.(sessionId) ?? null;
        connection.unknown = snapshot ? 0 : connection.unknown + 1;
        if (connection.unknown >= TRANSPORT_UNKNOWN_HEARTBEATS) {
          stop();
          return;
        }
        if (snapshot) {
          const sent = connection.previous ? snapshot.bytesSent - connection.previous.bytesSent : null;
          const received = connection.previous
            ? snapshot.bytesReceived - connection.previous.bytesReceived
            : null;
          connection.previous = snapshot;
          log(
            `[dc-transport] ${tag} sent=${snapshot.bytesSent}` +
            `${sent === null ? "" : ` (+${sent})`} received=${snapshot.bytesReceived}` +
            `${received === null ? "" : ` (+${received})`} queued[${queueDepths(connection.channels)}] ` +
            `rtt=${snapshot.rtt}ms pc=${snapshot.state} ice=${snapshot.iceState} pair=${snapshot.pair}`
          );
        }
      }
      // The rate this connection accepts bytes at, and how long that counter
      // has stood still — both measured every second, whatever the queue is
      // doing, because the rate has to come from the HEALTHY stretch that
      // precedes a wedge. One channel updates it for the whole connection.
      if (sampledAt - connection.rateAt >= SEND_QUEUE_SAMPLE_MS) {
        connection.rateAt = sampledAt;
        const snapshot = getTransportSnapshot?.(sessionId) ?? null;
        const sentNow = Number(snapshot?.bytesSent);
        if (Number.isFinite(sentNow) && sentNow >= 0) {
          if (connection.sentAt === 0 || sentNow < connection.sentBytes) {
            // First reading, or the counter went backwards — a fresh peer
            // connection reusing this session id. Either way the old baseline
            // describes a transport that no longer exists, so start over
            // rather than measure a pause against it for ever.
            connection.sentBytes = sentNow;
            connection.sentAt = sampledAt;
          } else if (sentNow > connection.sentBytes) {
            const seconds = (sampledAt - connection.sentAt) / 1000;
            if (seconds > 0) {
              // The BEST rate this connection has shown, not the latest one.
              // The latest is usually the quietest: with the browser's buffer
              // full nothing is requested for tens of seconds and the only
              // traffic is the probe, a few hundred bytes a second. Dividing a
              // queue by that gives hours, and the wedge would never be called.
              const rate = (sentNow - connection.sentBytes) / seconds;
              if (rate > connection.bytesPerSecond) {
                connection.bytesPerSecond = rate;
              }
            }
            // How long the counter stood still before this advance. While the
            // queue is draining that pause was legitimate, so it is the link's
            // own answer to "how long may a healthy pause be".
            const pausedMs = sampledAt - connection.sentAt;
            if (stuckSince === 0 && pausedMs > connection.longestHealthyFlatMs) {
              connection.longestHealthyFlatMs = pausedMs;
            }
            connection.sentBytes = sentNow;
            connection.sentAt = sampledAt;
          }
        }
      }
      let queued = 0;
      try {
        queued = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0;
      } catch {
        return;
      }
      if (queued === 0 || queued < lowestSinceDrain) {
        lowestSinceDrain = queued;
        stuckSince = 0;
        previous = null;
        receivedWhenStuck = -1;
        wedgeSaid = false;
        // The queue moved, so whatever was called a wedge has cleared. Let a
        // later one be recorded too: one mistaken call must not spend the
        // session's only capture.
        connection.captureStarted = false;
        return;
      }
      const now = Date.now();
      if (stuckSince === 0) {
        stuckSince = now;
        return;
      }
      const snapshot = getTransportSnapshot?.(sessionId) ?? null;
      if (!snapshot) {
        if (now - stuckSince >= SEND_QUEUE_STUCK_MS) {
          log(`[dc] Session ${tag} "${label}": send queue stuck at ${queued}B for ` +
            `${Math.round((now - stuckSince) / 1000)}s — no transport to ask`);
        }
        return;
      }
      const sentDelta = previous ? snapshot.bytesSent - previous.bytesSent : null;
      const recvDelta = previous ? snapshot.bytesReceived - previous.bytesReceived : null;
      previous = snapshot;
      if (receivedWhenStuck < 0) {
        receivedWhenStuck = snapshot.bytesReceived;
      }
      // The periodic line waits for {@link SEND_QUEUE_STUCK_MS}, because a
      // queue that has merely not fallen for a second is ordinary and a line a
      // second for it is noise. The WEDGE below does not wait for it: its own
      // condition already says how long this queue may legitimately take, and
      // on a fast link that is under a second. Holding the evidence back for a
      // fixed five seconds would repeat, in miniature, the mistake that left
      // both field captures without an onset in them.
      if (now - stuckSince >= SEND_QUEUE_STUCK_MS) {
        log(
          `[dc] Session ${tag} "${label}": send queue stuck at ${queued}B for ` +
          `${Math.round((now - stuckSince) / 1000)}s — transport ` +
          `sent=${snapshot.bytesSent}${sentDelta === null ? "" : ` (+${sentDelta})`} ` +
          `received=${snapshot.bytesReceived}${recvDelta === null ? "" : ` (+${recvDelta})`} ` +
          `rtt=${snapshot.rtt}ms pc=${snapshot.state} ice=${snapshot.iceState} pair=${snapshot.pair}`
        );
      }
      // Roadmap item 11: ask for the packet-level truth the moment the wedge is
      // CERTAIN, not after a chosen delay. The three facts below are not
      // ambiguous together — the queue has not fallen, the accepted-byte
      // counter has not moved for longer than the queue's own drain time at
      // this link's own speed, and the peer is still sending. The previous
      // rule's flat 30 s is what left both field captures with no onset in
      // them. One attempt per connection — the witness applies its own
      // single-flight and cooldown rules after that.
      const flatForMs = connection.sentAt === 0 ? 0 : now - connection.sentAt;
      const verdict = wedgeIsCertain({
        queuedBytes: queued,
        bytesPerSecond: connection.bytesPerSecond,
        flatForMs,
        longestHealthyFlatMs: connection.longestHealthyFlatMs
      });
      const peerStillSending = snapshot.bytesReceived > receivedWhenStuck;
      if (verdict.certain && peerStillSending && !wedgeSaid) {
        wedgeSaid = true;
        log(
          `[dc] Session ${tag} "${label}": delivery has stopped — ${queued}B queued, ` +
          `accepted-byte counter unmoved for ${Math.round(flatForMs / 1000)}s against the ` +
          `${(verdict.needMs / 1000).toFixed(1)}s this queue needs at the ` +
          `${(connection.bytesPerSecond / 1024).toFixed(0)} KB/s last measured here, ` +
          "and the peer is still sending"
        );
      }
      if (
        witness &&
        !connection.captureStarted &&
        verdict.certain &&
        peerStillSending
      ) {
        connection.captureStarted = true;
        const started = witness.maybeCapture({
          sessionId,
          tag,
          label,
          remote: snapshot.remote ?? null,
          queuedBytes: queued,
          stuckForMs: now - stuckSince
        });
        if (!started) {
          // Refused for now (no remote endpoint yet, capture already running
          // elsewhere, cooldown): let the next tick try again rather than
          // spending the one attempt per wedge on a refusal.
          connection.captureStarted = false;
        }
      }
      if (usrsctpState && verdict.certain && peerStillSending) {
        // Its own single-flight and cooldown, independent of the witness's —
        // one gdb attach per wedge is enough, and a refusal here (already
        // read, cooling down) costs nothing to retry on the next tick.
        usrsctpState.maybeRead(
          `send queue stuck ${queued}B, accepted-byte counter unmoved ${Math.round(flatForMs / 1000)}s`
        );
      }
    }, SEND_QUEUE_SAMPLE_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return stop;
  };

  return { watchSendQueue, readDelivery };
}

/**
 * Create a handler for incoming WebRTC data channels.
 *
 * @param {DataChannelHandlerOptions} options
 * @returns {DataChannelHandler}
 */
import { performance } from "node:perf_hooks";
import { eventLoopDelay, resetEventLoopDelay } from "../utils/perf.js";

/**
 * Build one body frame: `[flags(1)][idLen(1)][requestId][payload]`.
 *
 * One allocation and one copy. The previous version made two of each — a copy
 * of the chunk into a `Buffer`, then a `concat` that copied it again into the
 * frame — which measured 75.9 ms per 13 MB segment on the field host against
 * 40.0 ms this way, and allocated ~600 extra buffers over a segment's 208
 * chunks. One copy is the floor: chunks arrive from a web stream that allocates
 * them itself, so there is no buffer of ours to read them into.
 *
 * @param {Buffer} idBytes - The request id, already encoded.
 * @param {Uint8Array | null} bytes - Payload, or nothing for the done frame.
 * @param {boolean} done
 * @returns {Buffer}
 */
export function encodeFrame(idBytes, bytes, done) {
  const payloadLength = bytes?.length ?? 0;
  const frame = Buffer.allocUnsafe(2 + idBytes.length + payloadLength);
  frame[0] = done ? 1 : 0;
  frame[1] = idBytes.length;
  idBytes.copy(frame, 2);
  if (payloadLength > 0) {
    frame.set(bytes, 2 + idBytes.length);
  }
  return frame;
}

export function createDataChannelHandler({
  proxyPort,
  onLog,
  getTransportSnapshot,
  sourceRegistry,
  witness,
  // Reads usrsctp's own association state (services/usrsctp-state.js) the
  // moment a wedge is declared, from either detector below. Optional: a host
  // without gdb simply never gets a reading, same as the witness without
  // tcpdump.
  usrsctpState
}) {
  /**
   * Channels currently interested in one file's subtitle cues, keyed by
   * `sourceKey:fileIndex`. Populated the moment a browser asks for an
   * embedded track — there is no separate subscribe message on the wire, the
   * existing `/api/subtitles` request already says which file a viewer opened
   * subtitles for. Pruned on channel close and, defensively, on a failed send.
   *
   * @type {Map<string, Set<DataChannel>>}
   */
  const subtitleSubscribers = new Map();

  /**
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {DataChannel} channel
   * @returns {void}
   */
  function subscribeSubtitles(sourceKey, fileIndex, channel) {
    const key = `${sourceKey}:${fileIndex}`;
    let set = subtitleSubscribers.get(key);
    if (!set) {
      set = new Set();
      subtitleSubscribers.set(key, set);
    }
    const isNew = !set.has(channel);
    set.add(channel);
    if (isNew) {
      log(`[dc] subtitle push: channel subscribed to ${key} (${set.size} channel(s) now)`);
    }
  }

  /** @param {DataChannel} channel */
  function unsubscribeSubtitlesAll(channel) {
    for (const set of subtitleSubscribers.values()) {
      set.delete(channel);
    }
  }

  /**
   * Send new cues to every channel watching this file — the push side of
   * subtitles arriving as they download rather than being polled for. Cues
   * are tiny (kilobytes at most for a whole track), so this is one message,
   * not a stream.
   *
   * @param {{ sourceKey: string, fileIndex: number, trackIndex: number, cues: object[], language: string, cursor: number }} event
   * @returns {void}
   */
  function publishSubtitleCues({ sourceKey, fileIndex, trackIndex, cues, language, cursor }) {
    const set = subtitleSubscribers.get(`${sourceKey}:${fileIndex}`);
    if (!set || set.size === 0) {
      log(
        `[dc] subtitle push: ${cues.length} cue(s) for ${sourceKey.slice(0, 8)}:${fileIndex} track ${trackIndex} ` +
        "found no subscribed channel"
      );
      return;
    }
    const message = { type: "subtitle-cues", fileIndex, trackIndex, cues, language, cursor };
    const total = set.size;
    let sent = 0;
    for (const channel of set) {
      try {
        channel.sendMessage(JSON.stringify(message));
        sent += 1;
      } catch {
        // Closed between the subscription and this send; onClosed will not
        // fire for a channel that is already gone, so drop it here too.
        set.delete(channel);
      }
    }
    log(
      `[dc] subtitle push: sent ${cues.length} cue(s) for ${sourceKey.slice(0, 8)}:${fileIndex} track ${trackIndex} ` +
      `to ${sent}/${total} channel(s)`
    );
  }

  /** Request id → its ASCII bytes; see {@link requestIdBytes}. */
  const requestIdCache = new Map();

  const { watchSendQueue, readDelivery } = makeSendQueueWatcher({
    log: (message) => log(message),
    getTransportSnapshot,
    witness,
    usrsctpState
  });
  // Numbered probes on every channel, and the browser's echo of what it saw.
  // The proxy's own counters cannot say whether bytes it handed to usrsctp were
  // ever put on the wire; the far end can, and it keeps answering throughout a
  // freeze. See services/delivery-probe.js.
  //
  // Also the ONLY wedge signal that does not require a nonzero channel queue —
  // `wedgeIsCertain` above needs `queuedBytes > 0`, which small, infrequent
  // traffic never produces (confirmed 2026-08-28: the 2026-08-27 episode's
  // ring was never saved automatically for exactly this reason). So this is
  // wired to the same evidence-gathering as the queue watcher.
  const deliveryProbe = createDeliveryProbe({
    log: (message) => log(message),
    readDelivery,
    getTransportSnapshot,
    witness,
    usrsctpState
  });

  /**
   * @param {string} message
   * @returns {void}
   */
  function log(message) {
    if (typeof onLog === "function") {
      onLog(message);
    }
  }

  /**
   * Wire up the `onMessage`, `onClosed`, and `onError` handlers for a channel.
   *
   * @param {string}      sessionId
   * @param {DataChannel} channel
   * @returns {void}
   */
  function handleChannel(sessionId, channel) {
    const tag = sessionId.slice(0, 8);
    const label = typeof channel.getLabel === "function" ? channel.getLabel() : "?";
    log(`[dc] Session ${tag}: channel open`);
    const stopWatchdog = watchSendQueue(sessionId, tag, label, channel);
    deliveryProbe.attach(sessionId, tag, label, channel);

    // Partial chunked-request bodies in flight on THIS channel, keyed by
    // requestId. Each entry buffers frames until the done frame, then runs the
    // assembled request through the same path as a single-message request.
    /** @type {Map<string, { meta: object, chunks: Buffer[], receivedBytes: number, bodyBytes: number, timer: ReturnType<typeof setTimeout> }>} */
    const partials = new Map();

    const dropPartial = (requestId) => {
      const entry = partials.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        partials.delete(requestId);
      }
    };

    /**
     * Begin assembling a chunked request. Validates the path and size up front
     * so an invalid or oversized request never buffers a body.
     *
     * @param {any} message - The `request-start` control message.
     */
    const startPartialRequest = (message) => {
      const { requestId, method, path, query, headers, bodyBytes } = message ?? {};
      if (typeof requestId !== "string" || requestId.length === 0) {
        return;
      }
      if (!isValidRequestPath(path)) {
        send(channel, { type: "response-error", requestId, error: "Invalid request path." });
        return;
      }
      if (!Number.isInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > PROXY_MAX_REQUEST_BODY_BYTES) {
        send(channel, { type: "response-error", requestId, error: "Request body too large." });
        return;
      }
      dropPartial(requestId); // replace any stale entry with the same id
      const timer = setTimeout(() => {
        const entry = partials.get(requestId);
        partials.delete(requestId);
        log(`[dc] Session ${tag}: dropped stale partial request ${requestId.slice(0, 8)} (${entry?.receivedBytes ?? 0}B)`);
      }, PARTIAL_REQUEST_TTL_MS);
      partials.set(requestId, {
        meta: { requestId, method, path, query, headers },
        chunks: [],
        receivedBytes: 0,
        bodyBytes,
        timer
      });
    };

    /**
     * Handle a binary body frame for a chunked request.
     * Layout: [flags(1)][idLen(1)][requestId(ASCII)][payload].
     *
     * @param {Buffer} buf
     */
    const handleBodyFrame = (buf) => {
      if (buf.length < 2) {
        return;
      }
      const flags = buf[0];
      const idLen = buf[1];
      if (buf.length < 2 + idLen) {
        return;
      }
      const requestId = buf.toString("ascii", 2, 2 + idLen);
      const entry = partials.get(requestId);
      if (!entry) {
        return; // stale / already-dropped / aborted
      }
      if (flags & 2) {
        // Aborted by the browser — drop silently, no reply.
        dropPartial(requestId);
        return;
      }
      if (buf.length > 2 + idLen) {
        const payload = buf.subarray(2 + idLen);
        entry.chunks.push(Buffer.from(payload));
        entry.receivedBytes += payload.length;
      }
      if (entry.receivedBytes > entry.bodyBytes || entry.receivedBytes > PROXY_MAX_REQUEST_BODY_BYTES) {
        dropPartial(requestId);
        send(channel, { type: "response-error", requestId, error: "Request body size mismatch." });
        return;
      }
      if (flags & 1) {
        // Done frame — assemble and execute.
        dropPartial(requestId);
        if (entry.receivedBytes !== entry.bodyBytes) {
          send(channel, { type: "response-error", requestId, error: "Request body size mismatch." });
          return;
        }
        const body = Buffer.concat(entry.chunks).toString("utf8");
        void handleRequest(channel, { ...entry.meta, body }, true).catch((error) => {
          log(`[dc] Session ${tag}: request error: ${error?.message ?? error}`);
        });
      }
    };

    channel.onMessage((raw) => {
      // Binary messages are chunked-request body frames; the proxy otherwise
      // only ever receives JSON strings, so the type discriminates cleanly.
      if (typeof raw !== "string") {
        handleBodyFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        return;
      }

      /** @type {DataChannelRequest | { type: string, id?: string }} */
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.type === "request") {
        void handleRequest(channel, message).catch((error) => {
          log(`[dc] Session ${tag}: request error: ${error?.message ?? error}`);
        });
        return;
      }

      if (message.type === "request-start") {
        startPartialRequest(message);
        return;
      }

      if (message.type === "ping") {
        send(channel, { type: "pong", id: message.id });
        return;
      }

      // The far end's answer to the numbered probes, plus what it can see of
      // its own receiving. It travels browser to proxy, the direction that goes
      // on working through a freeze, so it arrives when nothing else does.
      if (message.type === "probe-echo") {
        deliveryProbe.noteEcho(sessionId, message);
        if (message.report && typeof message.report === "object") {
          const report = message.report;
          const channels = report.channels && typeof report.channels === "object"
            ? Object.entries(report.channels)
                .map(([name, counters]) => `${name}=${counters?.messages ?? "?"}msg/${counters?.bytes ?? "?"}B`)
                .join(" ")
            : "";
          log(
            `[dc-far] ${tag} visibility=${report.visibility ?? "?"} ` +
            `loopLag=${report.loopLagMs ?? "?"}ms handler=${report.handlerMaxMs ?? "?"}ms ` +
            `transportIn=${report.transportBytesReceived ?? "?"} ${channels} ` +
            `pending=${report.pending ?? "?"} at=${new Date().toISOString()}`
          );
        }
        return;
      }
    });

    channel.onClosed(() => {
      stopWatchdog();
      deliveryProbe.detach(sessionId, channel);
      for (const entry of partials.values()) {
        clearTimeout(entry.timer);
      }
      partials.clear();
      unsubscribeSubtitlesAll(channel);
      log(`[dc] Session ${tag}: channel closed`);
    });

    channel.onError((err) => {
      log(`[dc] Session ${tag}: channel error: ${err}`);
    });
  }

  /**
   * Fetch a resource from the local proxy HTTP server and stream the response
   * back to the browser over the data channel.
   *
   * The `Host` header is rewritten to `127.0.0.1:{proxyPort}` so that Fastify
   * routes the request correctly regardless of what the browser sent.
   *
   * @param {DataChannel}        channel
   * @param {DataChannelRequest} req
   * @returns {Promise<void>}
   */
  async function handleRequest(channel, req, viaChunks = false) {
    const { requestId, method, path, query, headers: forwardedHeaders, body } = req;

    // Reject paths that are not absolute, contain traversal sequences, or
    // do not start with a known proxy route prefix.  All valid browser-side
    // requests use /api/*, /stream, /transcode/*, /health, or /healthz.
    if (!isValidRequestPath(path)) {
      send(channel, { type: "response-error", requestId, error: "Invalid request path." });
      return;
    }

    // Piggy-backs on the browser's own request for an EMBEDDED track — no
    // separate subscribe message. `trackIndex` is what tells the two request
    // shapes apart: an external subtitle FILE (no trackIndex) names a
    // different file's own index in `fileIndex` — the subtitle file's, not the
    // video's — and subscribing under that would just be a key nothing ever
    // publishes to (an external file is one whole-file read, not something
    // this walks incrementally). `fileIndex` alone would also scope this to
    // the wrong grain for the real case — a torrent can carry several playable
    // files — so the pair is what a push is ever addressed to.
    //
    // The browser's `sourceKey` is a REGISTRY key — a hash of the raw request
    // bytes, one per (magnet-or-.torrent, this API session). The torrent pool
    // publishes under its OWN key — the content's infohash, deliberately the
    // SAME for a magnet and a `.torrent` naming the same film, so the two
    // share one swarm (item 10). The two are different strings for the same
    // torrent whenever a source was added by its `.torrent` file (a `.torrent`
    // and a magnet are different request bytes, same infohash) — subscribing
    // under the registry key found no publisher for that reason, not because
    // nothing was ever read: field case 2026-08-22, cues were found and
    // logged, every push answered "found no subscribed channel". Resolved to
    // the pool's key here, the one place both are in hand.
    if (path === "/api/subtitles" && typeof query === "string") {
      const params = new URLSearchParams(query);
      const registrySourceKey = params.get("sourceKey");
      const fileIndex = Number(params.get("fileIndex"));
      const hasTrackIndex = params.get("trackIndex") !== null && params.get("trackIndex") !== "";
      if (registrySourceKey && Number.isInteger(fileIndex) && hasTrackIndex) {
        const record = sourceRegistry?.get(registrySourceKey);
        if (record) {
          try {
            const poolSourceKey = await deriveSourceKey(record.sourceType, record.source);
            subscribeSubtitles(poolSourceKey, fileIndex, channel);
          } catch (error) {
            log(`[dc] subtitle push: could not resolve ${registrySourceKey.slice(0, 8)} to a pool key: ` +
              `${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }

    const queryInfo = query ? `?${query}` : "";
    const bodyInfo =
      body != null && typeof body === "string" && body.length > 0
        ? ` body=${body.length} bytes${viaChunks ? " (chunked)" : ""}`
        : "";
    log(`[dc] ${method} ${path}${queryInfo}${bodyInfo}`);

    const targetUrl = `http://127.0.0.1:${proxyPort}${path}${query ? `?${query}` : ""}`;
    const requestHeaders = { ...(forwardedHeaders ?? {}), host: `127.0.0.1:${proxyPort}` };

    let response;
    // [net-debug] TEMPORARY: time spent in the local fetch (waiting for the
    // route to return a response — e.g. long-polling until an HLS segment is
    // finalized by ffmpeg) vs. the body transfer over the data channel.
    const fetchStartedAt = Date.now();
    try {
      response = await fetch(targetUrl, {
        method,
        headers: requestHeaders,
        body: body != null ? body : undefined,
        redirect: "manual"
      });
    } catch (fetchError) {
      log(`[dc] ${method} ${path}${queryInfo} → error: ${fetchError?.message ?? String(fetchError)}`);
      send(channel, { type: "response-error", requestId, error: fetchError?.message ?? String(fetchError) });
      return;
    }

    if (response.status !== 200 && response.status !== 206) {
      log(`[dc] ${method} ${path}${queryInfo} → ${response.status}`);
    }

    /** @type {Record<string, string>} */
    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      responseHeaders[name] = value;
    }

    send(channel, { type: "response-start", requestId, status: response.status, headers: responseHeaders });

    if (!response.body) {
      sendChunk(channel, requestId, null, true);
      return;
    }

    try {
      const reader = response.body.getReader();
      // [net-debug] TEMPORARY: measure transfer size/time and channel buffering.
      // fetchMs = time waiting for the route (incl. ffmpeg segment finalization).
      // ttfbMs  = time from body-read start to the first chunk with data (loopback).
      // sendMs  = total body read+send duration over the data channel.
      const fetchMs = Date.now() - fetchStartedAt;
      const sendStartedAt = Date.now();
      let firstByteMs = -1;
      let chunks = 0;
      let totalBytes = 0;
      let maxBuffered = 0;
      // Attribute the transfer to the step that actually consumes the time.
      // Without this split a slow transfer is indistinguishable between "the
      // source is slow", "the channel is slow" and "the event loop is blocked",
      // which is exactly the argument a field seek left unresolved.
      let readMs = 0;
      let sendMs2 = 0;
      let drainMs = 0;
      resetEventLoopDelay();
      while (true) {
        const readStartedAt = performance.now();
        const { done, value } = await reader.read();
        readMs += performance.now() - readStartedAt;
        if (done) {
          sendChunk(channel, requestId, null, true);
          const elapsedMs = Date.now() - sendStartedAt;
          let bufferedNow = 0;
          try { bufferedNow = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0; } catch { /* ignore */ }
          const loop = eventLoopDelay();
          const mbps = elapsedMs > 0 ? (totalBytes * 8) / (elapsedMs * 1000) : 0;
          log(
            `[net-debug] sent ${path}${queryInfo} bytes=${totalBytes} fetchMs=${fetchMs} ` +
              `ttfbMs=${firstByteMs} sendMs=${elapsedMs} chunks=${chunks} ` +
              `maxBuffered=${maxBuffered} bufferedAtEnd=${bufferedNow} ` +
              // Where the time went: reading the body from the local route,
              // handing chunks to the channel, or waiting for its queue. Plus
              // the event-loop delay over the same window — a large max here
              // means the transfer was blocked by synchronous work, not by the
              // network, and the three figures above will all look inflated.
              `readMs=${readMs.toFixed(0)} chanMs=${sendMs2.toFixed(0)} drainMs=${drainMs.toFixed(0)} ` +
              `loopMean=${loop.meanMs.toFixed(1)} loopP99=${loop.p99Ms.toFixed(1)} loopMax=${loop.maxMs.toFixed(1)} ` +
              `rate=${mbps.toFixed(1)}Mbps`
          );
          break;
        }
        if (firstByteMs < 0) firstByteMs = Date.now() - sendStartedAt;
        chunks += 1;
        totalBytes += value.length;
        try {
          const b = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0;
          if (b > maxBuffered) maxBuffered = b;
        } catch { /* ignore */ }
        const sendStepAt = performance.now();
        sendChunk(channel, requestId, value, false);
        sendMs2 += performance.now() - sendStepAt;
        // Backpressure: do not keep queuing chunks once the channel's outgoing
        // buffer is large — wait for it to drain. Prevents the SCTP send buffer
        // from ballooning, which stalls throughput.
        const drainStepAt = performance.now();
        await waitForBufferDrain(channel);
        drainMs += performance.now() - drainStepAt;
      }
    } catch {
      sendChunk(channel, requestId, null, true);
    }
  }

  /**
   * Send a response body frame as a BINARY data-channel message.
   * Layout: [flags(1)][idLen(1)][requestId(ASCII)][payload].
   *
   * @param {DataChannel}            channel
   * @param {string}                 requestId
   * @param {Uint8Array | null}      bytes - Body bytes, or null/empty for the done frame.
   * @param {boolean}                done
   * @returns {void}
   */
  /**
   * The request id as bytes, prepared once per request rather than per chunk.
   *
   * A segment is a couple of hundred chunks, and each one was re-encoding the
   * same 32-character string. The map is bounded because request ids are
   * short-lived and unbounded in number — dropping the whole cache when it
   * grows costs one re-encode per live request and cannot leak.
   *
   * @param {string} requestId
   * @returns {Buffer}
   */
  function requestIdBytes(requestId) {
    let bytes = requestIdCache.get(requestId);
    if (!bytes) {
      if (requestIdCache.size > 64) {
        requestIdCache.clear();
      }
      bytes = Buffer.from(requestId, "ascii");
      requestIdCache.set(requestId, bytes);
    }
    return bytes;
  }

  function sendChunk(channel, requestId, bytes, done) {
    try {
      channel.sendMessageBinary(encodeFrame(requestIdBytes(requestId), bytes, done));
    } catch {
      // Channel closed between check and send — safe to ignore.
    }
  }

  /**
   * Resolve once the channel's outgoing buffer has drained below the low-water
   * mark. No-op (resolves immediately) when the buffer is already small or the
   * channel does not expose buffer APIs. A timeout fallback guards against a
   * missed low-water event so the send loop can never deadlock.
   *
   * @param {DataChannel} channel
   * @returns {Promise<void>}
   */
  function waitForBufferDrain(channel) {
    return new Promise((resolve) => {
      try {
        if (typeof channel.bufferedAmount !== "function" || channel.bufferedAmount() <= DC_BUFFER_HIGH_WATER) {
          resolve();
          return;
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        channel.setBufferedAmountLowThreshold(DC_BUFFER_LOW_WATER);
        channel.onBufferedAmountLow(done);
        // Guard against a race where the buffer drained between the check above
        // and registering the callback (the low-water event would never fire).
        if (channel.bufferedAmount() <= DC_BUFFER_LOW_WATER) {
          done();
          return;
        }
        setTimeout(done, DC_BUFFER_DRAIN_TIMEOUT_MS);
      } catch {
        resolve();
      }
    });
  }

  /**
   * Serialise `message` to JSON and send it over the data channel.
   * Errors are silently swallowed — the channel may have closed between
   * the open check and the actual send.
   *
   * @param {DataChannel} channel
   * @param {object}      message
   * @returns {void}
   */
  function send(channel, message) {
    try {
      channel.sendMessage(JSON.stringify(message));
    } catch {
      // Channel closed between check and send — safe to ignore.
    }
  }

  return { handleChannel, publishSubtitleCues };
}

/**
 * Allowed path prefixes for data-channel requests.
 * Only the known proxy API and streaming routes are accepted.
 */
const PATH_ALLOWLIST_RE = /^(?:\/api\/|\/stream(?:$|\?)|\/?transcode\/|\/health(?:z)?(?:$|\?))/;

/**
 * True when `path` is an absolute, traversal-free path on a known proxy route.
 * Shared by the single-message and chunked request entry points.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
function isValidRequestPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("..") &&
    PATH_ALLOWLIST_RE.test(path)
  );
}

/** Max assembled size of a chunked request body (guards proxy memory). */
const PROXY_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** Drop an incomplete chunked body if no further frame arrives within this window. */
const PARTIAL_REQUEST_TTL_MS = 60_000;

/** Pause sending body chunks once the channel buffer exceeds this many bytes. */
// How often the send queue is sampled, and how long it must fail to fall
// before the transport is asked what it is doing. Five seconds is far longer
// than any healthy burst drains in — measured, a 6-11 MB segment leaves in
// well under a second on the LAN — and short enough that a stuck channel is
// named while the viewer is still looking at it.
const SEND_QUEUE_SAMPLE_MS = 1_000;
// How often the transport's own counters are written to the log, whatever the
// send queue is doing. Frequent enough to place a loss within a few seconds,
// sparse enough that a two-hour film costs a few hundred lines.
const TRANSPORT_HEARTBEAT_MS = 5_000;

// How many heartbeats in a row may find no transport for this session before
// the watch gives up. Several rather than one, so a momentary gap in the
// registry does not end a healthy watch.
const TRANSPORT_UNKNOWN_HEARTBEATS = 3;
const SEND_QUEUE_STUCK_MS = 5_000;
const DC_BUFFER_HIGH_WATER = 8 * 1024 * 1024;
/** Resume sending once the channel buffer drains to this many bytes. */
const DC_BUFFER_LOW_WATER = 1 * 1024 * 1024;
/** Safety fallback so the send loop cannot deadlock on a missed drain event. */
const DC_BUFFER_DRAIN_TIMEOUT_MS = 5000;
