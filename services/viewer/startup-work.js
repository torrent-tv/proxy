/**
 * Schedule measured, unfinished opening work without treating enclosing
 * request spans as additional work. This is a diagnostic input to the
 * playback-readiness calculation; it does not infer service from completed
 * playback waits.
 *
 * Each work record states remaining work in a named unit, the measured rate
 * for a service with the same unit, and its actual predecessors. Services are
 * serial queues, while distinct services may run in parallel.
 */

const NON_WORK_KINDS = new Set(["event", "envelope", "dependency"]);
const OPENING_ATOM_IDS = [
  "A0.0", "A0.1", "A0.2", "A1", "A2.1", "A2.2.1", "A2.2.2", "A2.2.3", "A2.2.4",
  "A2.2.5", "A2.2m", "A2.2c", "A2.3", "A2.4.1", "A2.4.2", "A2.4.3", "A2.4.4",
  "A2.4.5", "A3", "A4", "A6", "A9", "A15", "W2", "W3", "W4", "W5", "P2", "P3",
  "P4", "P5", "X1"
];

/**
 * @param {Array<object>} records
 * @returns {{ finishSeconds: number | null, reason: string | null, atoms: object[] }}
 */
export function scheduleStartupWork(records) {
  if (!Array.isArray(records)) {
    return { finishSeconds: null, reason: "startup-work-records-unavailable",
      unknownAtoms: OPENING_ATOM_IDS, atoms: [] };
  }

  const byId = new Map();
  let actionId = null;
  for (const record of records) {
    if (!record || typeof record.id !== "string" || record.id.length === 0 || byId.has(record.id)) {
      return { finishSeconds: null, reason: "startup-work-identity-invalid", atoms: [] };
    }
    if (typeof record.actionId !== "string" || record.actionId.length === 0 ||
      (actionId !== null && actionId !== record.actionId)) {
      return { finishSeconds: null, reason: `startup-work-action-mismatch:${record.id}`, atoms: [] };
    }
    actionId ??= record.actionId;
    byId.set(record.id, record);
  }

  const finishes = new Map();
  const services = new Map();
  const serviceRates = new Map();
  const atoms = [];
  let reason = null;

  for (const record of records) {
    const { id, kind } = record;
    if (record.enabled === false) {
      finishes.set(id, 0);
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "not-applicable", finishSeconds: 0 });
      continue;
    }
    if (NON_WORK_KINDS.has(kind)) {
      const predecessors = [...(Array.isArray(record.dependsOn) ? record.dependsOn : []),
        ...(Array.isArray(record.children) ? record.children : [])];
      let finishSeconds = 0;
      let blockedBy = null;
      for (const predecessor of predecessors) {
        if (!byId.has(predecessor)) {
          blockedBy = `startup-work-predecessor-unknown:${id}:${predecessor}`;
          break;
        }
        if (!finishes.has(predecessor)) {
          blockedBy = `startup-work-predecessor-unavailable:${id}:${predecessor}`;
          break;
        }
        finishSeconds = Math.max(finishSeconds, finishes.get(predecessor));
      }
      if (blockedBy) {
        reason ??= blockedBy;
        atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
          state: "blocked", finishSeconds: null });
      } else {
        finishes.set(id, finishSeconds);
        atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
          state: "non-work", finishSeconds });
      }
    }
    if (NON_WORK_KINDS.has(kind)) continue;
    if (kind === "external-wait" && record.state !== "complete") {
      reason ??= `startup-external-wait:${id}`;
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "external-wait", finishSeconds: null });
      continue;
    }
    if (record.state === "complete") {
      // Completion is a known fact: its remaining work is exactly zero.
      finishes.set(id, 0);
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "complete", finishSeconds: 0 });
      continue;
    }
    if (record.state !== "pending") {
      reason ??= `startup-work-state-unknown:${id}`;
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "unknown-state", finishSeconds: null });
      continue;
    }
    if (kind !== "work") {
      reason ??= `startup-work-kind-unknown:${id}`;
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "unknown", finishSeconds: null });
      continue;
    }
    const amount = record.remainingWork?.amount;
    const unit = record.remainingWork?.unit;
    const service = record.service;
    if (!(Number.isFinite(amount) && amount >= 0) || typeof unit !== "string" || unit.length === 0) {
      reason ??= `startup-work-remaining-unknown:${id}`;
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "unknown-work", finishSeconds: null });
      continue;
    }
    if (amount === 0) {
      finishes.set(id, 0);
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "no-remaining-work", finishSeconds: 0 });
      continue;
    }
    const capture = service?.capture;
    if (!service || typeof service.key !== "string" || service.unit !== unit ||
      !(Number.isFinite(service.rate) && service.rate > 0) || typeof record.actionId !== "string" ||
      capture?.validity !== "valid" || capture.actionId !== record.actionId ||
      typeof capture.owner !== "string" || !capture.owner || !Number.isFinite(capture.clockEpoch) ||
      !Number.isFinite(capture.startedAt) || !Number.isFinite(capture.completedAt) ||
      capture.completedAt < capture.startedAt || !(Number.isFinite(capture.ageMs) && capture.ageMs >= 0)) {
      reason ??= `startup-work-service-unknown:${id}`;
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "unknown-service", finishSeconds: null });
      continue;
    }
    const existingRate = serviceRates.get(service.key);
    const captureKey = JSON.stringify([capture.owner, capture.clockEpoch, capture.startedAt,
      capture.completedAt, capture.ageMs, capture.actionId]);
    if (existingRate && (existingRate.unit !== unit || existingRate.rate !== service.rate ||
      existingRate.captureKey !== captureKey)) {
      reason ??= `startup-work-service-mismatch:${id}`;
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "unknown-service", finishSeconds: null });
      continue;
    }
    serviceRates.set(service.key, { unit, rate: service.rate, captureKey });

    const dependencies = Array.isArray(record.dependsOn) ? record.dependsOn : [];
    let readyAt = 0;
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) {
        reason ??= `startup-work-predecessor-unknown:${id}:${dependency}`;
        readyAt = null;
        break;
      }
      if (!finishes.has(dependency)) {
        reason ??= `startup-work-predecessor-unavailable:${id}:${dependency}`;
        readyAt = null;
        break;
      }
      readyAt = Math.max(readyAt, finishes.get(dependency));
    }
    if (readyAt === null) {
      atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind,
        state: "blocked", finishSeconds: null });
      continue;
    }

    const serviceAvailableAt = services.get(service.key) ?? 0;
    const startsAt = Math.max(readyAt, serviceAvailableAt);
    const finishSeconds = startsAt + amount / service.rate;
    services.set(service.key, finishSeconds);
    finishes.set(id, finishSeconds);
    atoms.push({ id, ...(record.actionId ? { actionId: record.actionId } : {}), kind, state: "scheduled", startsAt, finishSeconds,
      remainingWork: { amount, unit }, serviceKey: service.key, serviceCapture: { ...capture } });
  }

  for (const record of records) {
    if (record.state === "complete" || record.enabled === false || NON_WORK_KINDS.has(record.kind)) continue;
    for (const dependency of Array.isArray(record.dependsOn) ? record.dependsOn : []) {
      if (byId.has(dependency) && records.indexOf(byId.get(dependency)) >= records.indexOf(record)) {
        reason ??= `startup-work-order-invalid:${record.id}:${dependency}`;
      }
    }
  }

  if (reason) return { finishSeconds: null, reason,
    unknownAtoms: atoms.filter(atom => atom.finishSeconds === null).map(atom => atom.id), atoms };
  const finishSeconds = atoms.reduce((maximum, atom) => Math.max(maximum,
    Number.isFinite(atom.finishSeconds) ? atom.finishSeconds : 0), 0);
  return { finishSeconds, reason: null, unknownAtoms: [], atoms };
}
