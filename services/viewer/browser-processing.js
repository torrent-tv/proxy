/**
 * The browser's own work on each media fragment, measured from the page's
 * samples (torrent-tv/meta#260), and a track's rate as that work over the
 * fragments' bytes.
 *
 * One fragment's work is the time during which the page was parsing or
 * appending it after its load ended: the length of the union of its parse span
 * and the execute spans of its media appends in either SourceBuffer. A union,
 * not a sum: hls.js can execute an append before the parse ends, and separate
 * SourceBuffers append in parallel, so a moment of both counts once. Every
 * span is clipped to start no earlier than the end of the load: a parse that
 * hls.js streams while the fragment loads overlaps the transfer, which the
 * schedule already charges on the link. A gap between spans — an append's wait
 * in its buffer's queue, or behind the picture — is not work and is not
 * counted. A fragment is used only when every one of these facts is in its
 * samples; a partial value is never made.
 *
 * Ages are milliseconds before the page's snapshot, so a later event has a
 * smaller age. An append's `ageMs` is the age of the end of its execution, so
 * it executed over the ages `[ageMs, ageMs + executeMs]`.
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
    const spans = appendSpans(appends, sample.fragmentId, ages.loadEnd);
    if (spans === null) continue;
    spans.push([ages.parseEnd, Math.min(ages.parseStart, ages.loadEnd)]);
    workMs += unionLength(spans);
    bytes += sample.bytes;
    used += 1;
  }
  if (used === 0) return { reason: BROWSER_PROCESSING_UNMEASURED };
  const seconds = workMs / 1000;
  return { secondsPerByte: seconds / bytes, fragments: used, bytes, seconds };
}

/**
 * The execute spans `[later, earlier]` (ages) of the fragment's media appends
 * in either buffer, each clipped to the load end, or null when it has none or
 * one of them has no usable span.
 */
function appendSpans(appends, fragmentId, loadEnd) {
  const spans = [];
  for (const buffer of BUFFERS) {
    const samples = appends[buffer]?.media?.samples;
    if (!Array.isArray(samples)) continue;
    for (const sample of samples) {
      if (sample?.fragmentId !== fragmentId) continue;
      if (!isMilliseconds(sample.executeMs) || !isMilliseconds(sample.ageMs)) return null;
      spans.push([sample.ageMs, Math.min(sample.ageMs + sample.executeMs, loadEnd)]);
    }
  }
  return spans.length > 0 ? spans : null;
}

/** The length of the union of age spans `[later, earlier]`; a span with later ≥ earlier is empty. */
function unionLength(spans) {
  const sorted = spans.filter(([later, earlier]) => later < earlier).sort((a, b) => a[0] - b[0]);
  let length = 0;
  let end = -Infinity;
  for (const [later, earlier] of sorted) {
    length += Math.max(0, earlier - Math.max(later, end));
    end = Math.max(end, earlier);
  }
  return length;
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0;
}

/** A finite, non-negative number of milliseconds. */
function isMilliseconds(value) {
  return Number.isFinite(value) && value >= 0;
}
