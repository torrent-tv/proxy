/**
 * @file Automatic port mapping (UPnP IGD / NAT-PMP / PCP) for the proxy.
 *
 * Opens a port on the user's home router so the proxy is reachable from the
 * internet without any manual port forwarding. Uses `@silentbot1/nat-api`
 * (the same library WebTorrent already uses for the torrent port, so this adds
 * no new dependency surface on the host).
 *
 * Strictly best-effort: a router without UPnP/NAT-PMP — or one that declines —
 * is a normal case, not an error. Mapping failure never blocks proxy startup
 * and never throws to the caller. Reachability of the mapped endpoint is
 * verified separately (server-side dial-back probe — a later stage).
 *
 * The mapping is created with a TTL and auto-renewed while the proxy runs
 * (`autoUpdate`), and removed on graceful shutdown via {@link stop}. If the
 * process dies without calling `stop()`, the router drops the mapping when the
 * lease expires.
 */

import NatAPI from "@silentbot1/nat-api";
import { logger } from "../utils/logger.js";

// nat-api clamps ttl to a 1200 s minimum; it auto-renews at (ttl - 600) s.
const DEFAULT_TTL_SECONDS = 7200;
// SSDP discovery can hang on networks with no responding gateway — bound it so
// startup is never delayed waiting for a router that will not answer.
const START_TIMEOUT_MS = 10_000;
// A slow/unreachable router must not hang shutdown; lease expiry is the backstop.
const STOP_TIMEOUT_MS = 5_000;

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reject after `ms` if `promise` has not settled, so a hung NAT operation
 * cannot block startup or shutdown.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * @typedef {object} MappedEndpoint
 * @property {string | null} externalIp - Public IP as seen by NAT-PMP/UPnP, or null if unknown.
 * @property {number} externalPort
 * @property {"TCP" | "UDP"} protocol
 */

/**
 * @typedef {object} PortMapper
 * @property {() => Promise<void>} start - Create the mapping (best-effort, never throws).
 * @property {() => Promise<void>} stop - Remove the mapping and stop auto-renew (idempotent).
 * @property {() => MappedEndpoint | null} getMappedEndpoint - The active mapping, or null.
 */

/**
 * Create a port mapper for a single local port.
 *
 * @param {object} opts
 * @param {number} opts.port - The local port to expose (used as both public and private port).
 * @param {"TCP" | "UDP"} [opts.protocol] - Protocol to map. Defaults to "TCP" (the HTTP/stream port).
 * @param {string} [opts.description] - Human-readable label shown in the router's port-mapping table.
 * @param {number} [opts.ttlSeconds] - Lease time in seconds. Defaults to {@link DEFAULT_TTL_SECONDS}.
 * @param {number} [opts.portRangeEnd] - When set and > `port`, map the whole
 *   contiguous range `[port..portRangeEnd]` (used for the WebRTC UDP range, so
 *   whichever port a session binds is reachable). Single port otherwise.
 * @returns {PortMapper}
 */
export function createPortMapper({
  port,
  protocol = "TCP",
  description = "torrent-tv proxy",
  ttlSeconds = DEFAULT_TTL_SECONDS,
  portRangeEnd
} = {}) {
  const rangeEnd = Number.isInteger(portRangeEnd) && portRangeEnd > port ? portRangeEnd : null;
  const portList = rangeEnd
    ? Array.from({ length: rangeEnd - port + 1 }, (_, i) => port + i)
    : [port];
  const label = rangeEnd ? `${protocol} ${port}-${rangeEnd}` : `${protocol} ${port}`;

  /** @type {InstanceType<typeof NatAPI> | null} */
  let nat = null;
  /** @type {MappedEndpoint | null} */
  let mappedEndpoint = null;
  let started = false;

  /**
   * Destroy the NatAPI instance, swallowing errors. `destroy()` unmaps every
   * open port and clears the auto-renew timers.
   *
   * @param {InstanceType<typeof NatAPI>} instance
   * @returns {Promise<void>}
   */
  async function safeDestroy(instance, { logRemoval = false } = {}) {
    try {
      await withTimeout(instance.destroy(), STOP_TIMEOUT_MS, "destroy");
      if (logRemoval) {
        logger.info(`port-mapper: removed mapping for ${label}`);
      }
    } catch (error) {
      // Lease expiry (ttl) is the backstop if we cannot unmap cleanly.
      logger.warn(`port-mapper: failed to remove ${label} mapping cleanly: ${describeError(error)}`);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function start() {
    if (started) {
      return;
    }
    started = true;

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      logger.warn(`port-mapper: invalid port ${port}; skipping port mapping`);
      return;
    }

    let instance;
    let mappedCount = 0;
    try {
      instance = new NatAPI({ ttl: ttlSeconds, autoUpdate: true, description });
      // Map every port in the range, best-effort per port (one port failing
      // must not abort the rest). All share the one NatAPI instance, so its
      // auto-renew covers them and a single destroy() unmaps all.
      for (const p of portList) {
        try {
          await withTimeout(
            instance.map({ publicPort: p, privatePort: p, protocol, description, ttl: ttlSeconds }),
            START_TIMEOUT_MS,
            `map ${p}`
          );
          mappedCount++;
        } catch (error) {
          logger.warn(`port-mapper: failed to map ${protocol} ${p}: ${describeError(error)}`);
        }
      }
    } catch (error) {
      mappedEndpoint = null;
      logger.warn(`port-mapper: no port mapping available (${describeError(error)}); continuing without it`);
      if (instance) {
        await safeDestroy(instance);
      }
      return;
    }

    if (mappedCount === 0) {
      // No UPnP/NAT-PMP on this router, or it declined. Normal, non-fatal: the
      // proxy still works on LAN and wherever hole punching succeeds.
      mappedEndpoint = null;
      logger.warn(`port-mapper: no ports mapped for ${label}; continuing without it`);
      await safeDestroy(instance);
      return;
    }

    // Mapping succeeded — keep the instance so its auto-renew timers stay alive
    // and stop() can remove the mappings later.
    nat = instance;

    // Discover the external IP (best-effort; the mapping is valid without it).
    let externalIp = null;
    try {
      externalIp = await withTimeout(instance.externalIp(), START_TIMEOUT_MS, "externalIp");
    } catch (error) {
      logger.warn(`port-mapper: mapped ${label} but could not read external IP: ${describeError(error)}`);
    }

    mappedEndpoint = { externalIp: externalIp || null, externalPort: port, protocol };
    const counts = portList.length > 1 ? ` (${mappedCount}/${portList.length} ports)` : "";
    if (externalIp) {
      logger.success(
        `port-mapper: mapped ${externalIp} → ${label}${counts} (ttl ${ttlSeconds}s, auto-renew)`
      );
    } else {
      logger.info(
        `port-mapper: mapped ${label}${counts} (external IP unknown; ttl ${ttlSeconds}s, auto-renew)`
      );
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function stop() {
    if (!nat) {
      return;
    }
    const instance = nat;
    nat = null;
    mappedEndpoint = null;
    await safeDestroy(instance, { logRemoval: true });
  }

  /**
   * @returns {MappedEndpoint | null}
   */
  function getMappedEndpoint() {
    return mappedEndpoint;
  }

  return { start, stop, getMappedEndpoint };
}
