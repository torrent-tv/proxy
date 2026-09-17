/**
 * @file NAT classification via STUN (minimal, dependency-free client).
 *
 * Determines whether the proxy's home NAT preserves its external UDP port
 * across destinations (endpoint-independent / "cone") or assigns a new port
 * per destination ("symmetric"). This decides whether the fixed-UDP-port +
 * UPnP mapping (the WebRTC reachability of proxy 2.9.18) is sufficient:
 *
 *   - endpoint-independent → a static mapping works; no port prediction needed.
 *   - symmetric            → the mapped port differs per viewer; WebRTC needs
 *                            port prediction (a later roadmap step).
 *
 * Method: from ONE local UDP socket, send a STUN Binding Request to TWO
 * different public STUN servers (different destinations) and compare the
 * reported external port. Same port → endpoint-independent; different →
 * symmetric. This is the modern, reliable test — unlike RFC 3489's CHANGE-
 * REQUEST classification, it needs no special STUN-server support (works with
 * Google/Cloudflare STUN). The two queries MUST share one socket: a fresh
 * socket would get its own NAT mapping and make even a cone NAT look symmetric.
 *
 * Strictly best-effort: never throws; returns `klass: "unknown"` if the probes
 * fail (STUN blocked, offline). Used for diagnostics/telemetry and to gate the
 * future WebRTC port-prediction work.
 */

import dgram from "node:dgram";
import crypto from "node:crypto";

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;

// Public STUN servers from DIFFERENT operators, so the destination genuinely
// differs between the two queries (required for the symmetric test).
const DEFAULT_STUN_SERVERS = [
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun.cloudflare.com", port: 3478 },
  { host: "stun1.l.google.com", port: 19302 }
];

const QUERY_TIMEOUT_MS = 4000;

/**
 * @typedef {object} NatObservation
 * @property {string} server   - "host:port" that was queried.
 * @property {string} ip       - Reflexive external IP reported.
 * @property {number} port     - Reflexive external port reported.
 */

/**
 * @typedef {object} NatClassification
 * @property {"endpoint-independent" | "symmetric" | "unknown"} klass
 * @property {string | null} externalIp - External IP (from the first success).
 * @property {NatObservation[]} observations
 * @property {number | null} portDelta   - port(2nd) - port(1st) when symmetric, else null.
 */

/**
 * Build a 20-byte STUN Binding Request with a random 96-bit transaction id.
 *
 * @returns {Buffer}
 */
function buildBindingRequest() {
  const msg = Buffer.alloc(20);
  msg.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  msg.writeUInt16BE(0, 2); // message length (no attributes)
  msg.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  crypto.randomFillSync(msg, 8, 12); // transaction id
  return msg;
}

/**
 * Parse the reflexive address from a STUN response, preferring
 * XOR-MAPPED-ADDRESS and falling back to MAPPED-ADDRESS. IPv4 only.
 *
 * @param {Buffer} msg
 * @returns {{ ip: string, port: number } | null}
 */
function parseMappedAddress(msg) {
  if (msg.length < 20) {
    return null;
  }
  let offset = 20;
  while (offset + 4 <= msg.length) {
    const type = msg.readUInt16BE(offset);
    const length = msg.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    if (valueStart + length > msg.length) {
      break;
    }

    if (type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) {
      const family = msg.readUInt8(valueStart + 1);
      if (family === 0x01) {
        // IPv4
        const xored = type === ATTR_XOR_MAPPED_ADDRESS;
        const rawPort = msg.readUInt16BE(valueStart + 2);
        const port = xored ? rawPort ^ (STUN_MAGIC_COOKIE >>> 16) : rawPort;
        const addrBytes = [
          msg.readUInt8(valueStart + 4),
          msg.readUInt8(valueStart + 5),
          msg.readUInt8(valueStart + 6),
          msg.readUInt8(valueStart + 7)
        ];
        const cookieBytes = [
          (STUN_MAGIC_COOKIE >>> 24) & 0xff,
          (STUN_MAGIC_COOKIE >>> 16) & 0xff,
          (STUN_MAGIC_COOKIE >>> 8) & 0xff,
          STUN_MAGIC_COOKIE & 0xff
        ];
        const ipParts = addrBytes.map((b, i) => (xored ? b ^ cookieBytes[i] : b));
        return { ip: ipParts.join("."), port };
      }
    }

    // Attributes are padded to 4-byte boundaries.
    offset = valueStart + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

/**
 * Send one Binding Request to `host:port` over the given socket and resolve
 * with the reflexive address, or null on timeout / parse failure.
 *
 * @param {import("node:dgram").Socket} socket
 * @param {string} host
 * @param {number} port
 * @returns {Promise<{ ip: string, port: number } | null>}
 */
function queryStun(socket, host, port) {
  return new Promise((resolve) => {
    let settled = false;
    const onMessage = (msg) => {
      if (settled) {
        return;
      }
      const parsed = parseMappedAddress(msg);
      if (!parsed) {
        return; // ignore unrelated datagrams; let the timeout fire if needed
      }
      settled = true;
      socket.off("message", onMessage);
      resolve(parsed);
    };
    socket.on("message", onMessage);
    socket.send(buildBindingRequest(), port, host, (err) => {
      if (err && !settled) {
        settled = true;
        socket.off("message", onMessage);
        resolve(null);
      }
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.off("message", onMessage);
        resolve(null);
      }
    }, QUERY_TIMEOUT_MS);
    timer.unref?.();
  });
}

/**
 * Classify the host's NAT by comparing the external port seen by two different
 * STUN servers over a single local socket.
 *
 * @param {{ servers?: Array<{ host: string, port: number }> }} [options]
 * @returns {Promise<NatClassification>}
 */
export async function classifyNat({ servers = DEFAULT_STUN_SERVERS } = {}) {
  /** @type {NatClassification} */
  const unknown = { klass: "unknown", externalIp: null, observations: [], portDelta: null };

  const socket = dgram.createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, () => {
        socket.off("error", reject);
        resolve(undefined);
      });
    });
  } catch {
    try {
      socket.close();
    } catch {
      // ignore
    }
    return unknown;
  }

  /** @type {NatObservation[]} */
  const observations = [];
  try {
    for (const server of servers) {
      const result = await queryStun(socket, server.host, server.port);
      if (result) {
        observations.push({ server: `${server.host}:${server.port}`, ip: result.ip, port: result.port });
      }
      // Stop once we have two observations from two different destinations.
      if (observations.length >= 2) {
        break;
      }
    }
  } finally {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }

  if (observations.length < 2) {
    return { ...unknown, observations };
  }

  const [first, second] = observations;
  const externalIp = first.ip;
  if (first.port === second.port) {
    return { klass: "endpoint-independent", externalIp, observations, portDelta: null };
  }
  return {
    klass: "symmetric",
    externalIp,
    observations,
    portDelta: second.port - first.port
  };
}
