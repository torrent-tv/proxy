/**
 * The browser's own work on each media fragment, measured from the page's
 * samples (torrent-tv/meta#260), and a track's rate as that work over the
 * fragments' bytes.
 *
 * One fragment's work is its parse after its load ended — a parse that hls.js
 * streams while the fragment loads overlaps the transfer, which the schedule
 * already charges on the link — plus the time its appends executed. Separate
 * SourceBuffers append in parallel, so of a muxed fragment's appends to the
 * picture and the sound buffer only the larger sum counts. An append's wait in
 * its buffer's queue, or behind the picture, is not work and is not in
 * `executeMs`. A fragment is used only when every one of these facts is in
 * its samples; a partial value is never made.
 *
 * Ages are milliseconds before the page's snapshot, so a later event has a
 * smaller age.
 */

export const BROWSER_PROCESSING_UNMEASURED = "browser-processing-unmeasured";

const BUFFERS = ["video", "audio"];

/**
 * @param {object | null} fragments - `fragmentService[track]` of the output's own track.
 * @param {object | null} appends - the whole `appendService` (`{ video, audio }`).
 * @returns {{ secondsPerByte: number, fragments: number, bytes: number, seconds: number }
 *   | { reason: "browser-processing-unmeasured" }}
 */
export function browserProcessingOf(fragments, appends) {
  const samples = fragments?.media?.samples;
  if (!Array.isArray(samples) || !appends || typeof appends !== "object") {
    return { reason: BROWSER_PROCESSING_UNMEASURED };
  }
  // A fragment loaded again has two samples under one identity, and its
  // appends join by identity only: which append belongs to which load is not
  // shown, so neither load is measured.
  const loads = new Map();
  for (const sample of samples) {
    if (isIdentity(sample?.fragmentId)) loads.set(sample.fragmentId, (loads.get(sample.fragmentId) ?? 0) + 1);
  }
  let workMs = 0;
  let bytes = 0;
  let used = 0;
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample?.bytes) || sample.bytes <= 0 || !isIdentity(sample.fragmentId) ||
      loads.get(sample.fragmentId) !== 1) continue;
    const ages = sample.eventAgesMs;
    // Buffered: every append of the fragment is done.
    if (![ages?.loadEnd, ages?.parseStart, ages?.parseEnd, ages?.bufferingEnd].every(isMilliseconds)) continue;
    const append = appendWorkMs(appends, sample.fragmentId);
    if (append === null) continue;
    const parse = Math.max(0, Math.min(ages.parseStart, ages.loadEnd) - ages.parseEnd);
    workMs += parse + append;
    bytes += sample.bytes;
    used += 1;
  }
  if (used === 0) return { reason: BROWSER_PROCESSING_UNMEASURED };
  const seconds = workMs / 1000;
  return { secondsPerByte: seconds / bytes, fragments: used, bytes, seconds };
}

/**
 * The largest per-buffer sum of the execute spans of the fragment's media
 * appends, or null when it has none or one of them has no usable span.
 */
function appendWorkMs(appends, fragmentId) {
  let found = false;
  let largest = 0;
  for (const buffer of BUFFERS) {
    const samples = appends[buffer]?.media?.samples;
    if (!Array.isArray(samples)) continue;
    let sum = 0;
    for (const sample of samples) {
      if (sample?.fragmentId !== fragmentId) continue;
      if (!isMilliseconds(sample.executeMs)) return null;
      found = true;
      sum += sample.executeMs;
    }
    largest = Math.max(largest, sum);
  }
  return found ? largest : null;
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0;
}

/** A finite, non-negative number of milliseconds. */
function isMilliseconds(value) {
  return Number.isFinite(value) && value >= 0;
}
