/**
 * @file How much of the machine a new encoder can actually have.
 *
 * The startup measurements are filed for a QUIET host: one ffmpeg, nothing
 * else. The host is not quiet while they are taken, so each reading is divided
 * by the share of the machine other work left it (`freeShareDuring`,
 * torrent-tv/meta#3) — otherwise a reading taken while other work ran would be
 * lowered once there and again here. A real
 * encode runs on a machine that is also downloading, hashing and serving, and
 * on the addon host that machine was measured 99 % busy — `ffmpeg=52-60%
 * proxy=17-24% system=99%` — while a step predicted at 1.83x ran at 1.01-1.12x
 * (2026-08-17).
 *
 * What this corrects is ONLY the part nobody has been charged for. That
 * distinction is the whole of the file, because the alternative has already
 * shipped once and broke the product: in 2.21.0 the budget ADDED what else was
 * running while the per-file costs were being LEARNED from runs that already
 * contained that other work, so every cost was counted twice, every re-encoded
 * step was refused, and the quality menu emptied itself down to the one copied
 * height (fixed in 2.21.1).
 *
 * So: our own encoders are priced by the concurrency arithmetic. The proxy's
 * own work — the torrent thread, the hashing, the delivery, the copies of
 * encoder inputs — was to be priced per megabyte moved, and that price is not
 * established: since 2.97.9 it is measured for the log only, and nothing
 * charges the proxy's processor to an encoder. An encoder therefore gets what
 * other processes AND the proxy itself leave (`forEncoders`), the proxy's
 * share as measured over the same interval, taken off once here and nowhere
 * else (torrent-tv/meta#178). The field case of 2026-08-17 below: a step
 * predicted at 1.83x on a quiet box ran at 1.01-1.12x while ffmpeg had 56 %,
 * the proxy 20 % and the machine 99 %; what other processes leave predicts
 * 1.41x, what the proxy leaves as well predicts 1.04x.
 *
 * Once means in the readings too. A speed a running encoder is seen at already
 * contains what the machine left it then, so it is filed as if alone on a
 * quiet machine — divided by `leftForEncoders` at the reading, the unit the
 * startup measurements are filed in — and multiplied by what is left now when
 * it is used. Filed as read, the proxy's draw at the reading was taken off a
 * second time by every prediction made from it, which is the 2.21.0 failure.
 *
 * `share`, what other processes leave, stays for the download's share of the
 * proxy's processor (`processor-share.js`), which divides the proxy's room
 * between its own download and its encoders and must not lose that room twice.
 *
 * THE WHOLE MACHINE IS WHAT THIS PROCESS MAY USE (torrent-tv/meta#180, phase
 * 3). `/proc/stat` and `os.cpus()` describe the host; a container's CPU quota
 * (`cpu.max`, Docker `--cpus`) or a CPU set (`--cpuset-cpus`) gives the proxy
 * fewer cores than that. Where such a bound is smaller than the host, both
 * shares are fractions of the bound instead: the encoders get what the host's
 * other work leaves, but never more than the bound less the proxy's own draw.
 * Measured as fractions of the host, a 1.5-core quota on an 8-core host read
 * a busy neighbour as lost room the quota never had, and the proxy's own draw
 * as an eighth of what it takes from the quota. The startup measurements are
 * divided by the same fraction (`host-load.js` `freeShareDuring`), so a cost
 * filed from either stays in one unit. Without a bound smaller than the host,
 * nothing changes.
 */

/**
 * The share of the machine available to a new encoder.
 *
 * @param {object} reading - Fractions of the WHOLE machine (all cores), as
 *   `shareOfMachine` reports them.
 * @param {number | null} reading.systemBusy - Everything the machine is doing.
 * @param {number | null} reading.encoderShare - Our own ffmpeg processes.
 * @param {number | null} reading.proxyShare - The proxy process itself, every
 *   thread of it.
 * @param {number | null} [reading.hostCores] - The cores the three shares
 *   above are fractions of.
 * @param {number | null} [reading.boundCores] - The cores this process may use
 *   (`storage/machine-processor.js` `processorBound`); counts only when
 *   smaller than `hostCores`.
 * @returns {{ share: number, forEncoders: number, unattributed: number, known: boolean, boundCores?: number }}
 *   `share` is what other processes leave; `forEncoders` what they and the
 *   proxy leave; both of `boundCores` where it is given, else of the whole
 *   host. `unattributed` stays a fraction of the host. `known` is false when
 *   the host does not report its own load — then both are 1 and the caller
 *   must say it is uncorrected rather than pretend.
 */
export function availableShareFrom(reading = {}) {
  const systemBusy = finite(reading.systemBusy);
  if (systemBusy === null) {
    // No reading at all: not every host has /proc. An uncorrected prediction is
    // the honest answer, and the caller says so.
    return { share: 1, forEncoders: 1, unattributed: 0, known: false };
  }
  const encoders = finite(reading.encoderShare) ?? 0;
  const proxy = finite(reading.proxyShare) ?? 0;
  const ours = encoders + proxy;
  // Rounding, and the two readings being taken microseconds apart, can put our
  // own share fractionally above the system total. Below zero is not a
  // measurement of anything.
  const unattributed = clamp(systemBusy - ours, 0, 1);
  const hostCores = finite(reading.hostCores);
  const boundCores = finite(reading.boundCores);
  if (hostCores !== null && boundCores !== null && boundCores > 0 && boundCores < hostCores) {
    // In cores: the host's other work takes from the host, the proxy's own
    // draw from the bound as well.
    const leftOnHost = hostCores - clamp(systemBusy - encoders, 0, 1) * hostCores;
    return {
      share: clamp(Math.min(boundCores, hostCores - unattributed * hostCores) / boundCores, 0, 1),
      forEncoders: clamp(Math.min(boundCores - proxy * hostCores, leftOnHost) / boundCores, 0, 1),
      unattributed,
      known: true,
      boundCores
    };
  }
  return { share: clamp(1 - unattributed, 0, 1), forEncoders: clamp(1 - (systemBusy - encoders), 0, 1),
    unattributed, known: true };
}

/**
 * The share of the machine an encoder gets: what other processes and the
 * proxy leave, or 1 for a host that does not report its load.
 *
 * @param {{ share: number, forEncoders?: number, known: boolean } | null | undefined} availability
 * @returns {number}
 */
export function leftForEncoders(availability) {
  if (!availability?.known) {
    return 1;
  }
  return Number.isFinite(availability.forEncoders) ? availability.forEncoders : availability.share;
}

/**
 * Apply the correction to a predicted speed.
 *
 * A speed is work per unit time, so a machine that can give a new encoder only
 * `share` of itself produces `share ×` the speed the benchmark measured alone.
 *
 * @param {number} predictedSpeed - From the quiet-host benchmark.
 * @param {{ share: number, forEncoders?: number, known: boolean }} availability
 * @returns {number}
 */
export function correctForAvailability(predictedSpeed, availability) {
  if (!Number.isFinite(predictedSpeed) || predictedSpeed <= 0) {
    return predictedSpeed;
  }
  return predictedSpeed * leftForEncoders(availability);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
