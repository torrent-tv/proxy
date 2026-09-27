/**
 * @file Whether two init segments can serve one another's pieces.
 *
 * A player fetches `#EXT-X-MAP` once and decodes every fragment of that address
 * against it. So a piece made under one header and served under another is only
 * safe when the two headers say the same thing to a decoder — and "the same
 * thing" has to be decided BEFORE any experiment, or the rule becomes a list of
 * whatever differences happened to turn up while it was being written.
 *
 * THE RULE, conservative by construction:
 *
 * 1. the WHOLE header is compared, box by box, leaf by leaf, byte for byte;
 * 2. every difference is reported by the path it sits at;
 * 3. a difference makes the two headers INCOMPATIBLE unless it is covered by an
 *    explicitly listed exception;
 * 4. **each exception carries the reason it is one.** A field nobody can name
 *    is not an exception — an unreadable or unexpected difference refuses.
 *
 * What this gives up deliberately: it will refuse pairs that would in fact have
 * played. That is the direction to be wrong in — the other direction is a
 * viewer whose picture turns to blocks, which this project has already paid for
 * once (`research/budget-downshift-breaks-the-picture-2026-08-21.md`).
 *
 * Only a format that HAS an init is described here. MPEG-TS carries its
 * parameter sets in the stream and has no header to compare, so two of its
 * outputs are never joined by this question at all.
 */

import { walkBoxes } from "./mp4-boxes.js";

/** Boxes whose payload is a list of child boxes, mirroring `walkBoxes`. */
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex"]);

/**
 * Sample entries, and how many bytes of fixed preamble stand before their child
 * boxes.
 *
 * A sample entry is not a plain container: it opens with fields at fixed
 * offsets and only then carries boxes. The two shapes are the ones ISO/IEC
 * 14496-12 defines — `SampleEntry` is 8 bytes (six reserved plus a data
 * reference index), `VisualSampleEntry` adds 70 more and `AudioSampleEntry`
 * adds 20.
 *
 * WHY THIS MATTERS ENOUGH TO PARSE: without descending here, a difference
 * anywhere inside a sample entry is reported as one difference of the whole
 * `stsd`. Allowing it would allow `avcC` — the parameter sets — with it, which
 * is the one thing this rule exists to refuse. The preamble is a stated
 * constant and a wrong one would mis-read every child, so the descent is
 * CHECKED rather than trusted: see `tilesExactly`.
 *
 * @type {ReadonlyMap<string, number>}
 */
const SAMPLE_ENTRY_PREAMBLE = new Map([
  ["avc1", 78], ["avc3", 78], ["hvc1", 78], ["hev1", 78], ["av01", 78], ["vp09", 78],
  ["mp4a", 28], ["ac-3", 28], ["ec-3", 28], ["opus", 28], ["fLaC", 28]
]);

/** `stsd` is a FullBox: version and flags, then an entry count, then entries. */
const SAMPLE_DESCRIPTION_PREAMBLE = 8;

/**
 * The differences that do NOT refuse, each with the reason it does not.
 *
 * An entry is either an exact `path`, or a `sampleEntryBox` — a box type
 * appearing directly inside a sample entry, whichever track and whichever
 * entry. The second form exists because the reason is a property of the BOX
 * and not of where it sits: a file with the picture on the second track states
 * the same thing about it.
 *
 * @type {ReadonlyArray<{ path?: string, sampleEntryBox?: string, why: string }>}
 */
export const INIT_DIFFERENCE_EXCEPTIONS = [
  {
    sampleEntryBox: "btrt",
    why:
      "BitRateBox declares a decoding buffer size and a maximum and average rate. " +
      "Four readings, none of them from this experiment's own output: the W3C " +
      "Media Source Extensions byte stream format for ISOBMFF, which is what " +
      "governs a browser's handling of an initialization segment, does not " +
      "mention the box at all and requires only `ftyp` and `moov`; hls.js — the " +
      "player this product ships — never reads one, and writes a HARDCODED " +
      "3 Mbit/s into every init it builds for every stream whatever its real " +
      "rate (`MP4.types.btrt`, the avc1 and hvc1 sample entries); this proxy's " +
      "own code neither reads nor writes it; and what actually configures a " +
      "decoder, `avcC`, is compared separately by this same rule and a " +
      "difference there still refuses."
  }
];

/**
 * Where a box's child boxes begin, counted from the start of its payload, or
 * null when the box is a leaf.
 *
 * @param {string} type
 * @returns {number | null}
 */
function childrenStartOf(type) {
  if (CONTAINER_BOXES.has(type)) {
    return 0;
  }
  if (type === "stsd") {
    return SAMPLE_DESCRIPTION_PREAMBLE;
  }
  return SAMPLE_ENTRY_PREAMBLE.get(type) ?? null;
}

/**
 * Whether the range holds whole boxes and nothing else.
 *
 * The descent above rests on stated offsets, and a stated offset can be wrong —
 * for a sample entry shape this does not know, or a box carrying a 64-bit size.
 * Rather than mis-read the children, the walk asks first whether they tile the
 * range exactly. They do not, and the parent is compared whole, which is the
 * conservative answer.
 *
 * Size handling mirrors `walkBoxes`, so what this accepts is exactly what that
 * would then walk.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function tilesExactly(buffer, start, end) {
  if (!(end > start)) {
    return false;
  }
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) {
        return false;
      }
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      return false;
    }
    offset += size;
  }
  return offset === end;
}

/**
 * Every leaf of the box tree, by the path it sits at.
 *
 * A path is `type` names joined by `/`, each carrying its index among its
 * siblings OF THE SAME TYPE — so two tracks are `moov/trak[0]` and
 * `moov/trak[1]` and a field of one is never compared against the other's.
 *
 * @param {Buffer} initSegment
 * @returns {Map<string, Buffer>} path → the leaf's payload bytes
 */
export function initLeaves(initSegment) {
  /** @type {Map<string, Buffer>} */
  const leaves = new Map();
  if (!Buffer.isBuffer(initSegment) || initSegment.length === 0) {
    return leaves;
  }
  const walk = (start, end, prefix) => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    // `walkBoxes` recurses into containers itself, so this pass is given one
    // level at a time and asks for the children of each container explicitly.
    // That is what makes the path unambiguous: a bare walk would report a
    // grandchild without saying whose it is.
    walkBoxes(
      initSegment,
      (type, bodyStart, bodyEnd) => {
        const index = seen.get(type) ?? 0;
        seen.set(type, index + 1);
        const path = `${prefix}${type}[${index}]`;
        const childrenAt = childrenStartOf(type);
        if (childrenAt !== null && tilesExactly(initSegment, bodyStart + childrenAt, bodyEnd)) {
          walk(bodyStart + childrenAt, bodyEnd, `${path}/`);
          return;
        }
        leaves.set(path, initSegment.subarray(bodyStart, bodyEnd));
      },
      start,
      end,
      // One level only: the recursion above is this function's own, and it is
      // what makes a path say whose child a box is.
      () => false
    );
    return leaves;
  };
  walk(0, initSegment.length, "");
  return leaves;
}

/**
 * The box type a path's last step names, without its index.
 *
 * @param {string} path
 * @param {number} [fromEnd=0] - 0 is the leaf, 1 its parent.
 * @returns {string}
 */
function stepOf(path, fromEnd = 0) {
  const steps = path.split("/");
  const step = steps[steps.length - 1 - fromEnd] ?? "";
  return step.replace(/\[\d+\]$/, "");
}

/**
 * Whether an exception covers this path.
 *
 * @param {ReadonlyArray<{ path?: string, sampleEntryBox?: string }>} exceptions
 * @param {string} path
 * @returns {boolean}
 */
function permits(exceptions, path) {
  for (const exception of exceptions) {
    if (exception.path !== undefined && exception.path === path) {
      return true;
    }
    if (
      exception.sampleEntryBox !== undefined &&
      stepOf(path) === exception.sampleEntryBox &&
      SAMPLE_ENTRY_PREAMBLE.has(stepOf(path, 1))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * What a difference at this path amounts to, in words.
 *
 * Decoding is for READING the report, never for deciding it: the verdict is the
 * byte comparison, and a path this cannot decode is still a difference.
 *
 * @param {string} path
 * @param {Buffer | null} left
 * @param {Buffer | null} right
 * @returns {string}
 */
function describeDifference(path, left, right) {
  if (!left) return `${path}: absent from the first header`;
  if (!right) return `${path}: absent from the second header`;
  if (stepOf(path) === "btrt" && left.length >= 12 && right.length >= 12) {
    const rates = (buffer) =>
      `buffer ${buffer.readUInt32BE(0)}B, max ${buffer.readUInt32BE(4)}, avg ${buffer.readUInt32BE(8)} bit/s`;
    return `${path}: ${rates(left)} against ${rates(right)}`;
  }
  if (path.includes("mdhd")) {
    // FullBox: version+flags, then creation/modification, then timescale.
    const at = left.readUInt8(0) === 1 ? 20 : 12;
    if (left.length > at + 4 && right.length > at + 4) {
      return `${path}: timescale ${left.readUInt32BE(at)} against ${right.readUInt32BE(at)}`;
    }
  }
  if (stepOf(path) === "stsd") {
    // Reached only where the entries did not tile, so the walk could not
    // descend. The entry's own type is at a fixed place and is worth naming.
    const entryType = (buffer) => (buffer.length >= 16 ? buffer.toString("latin1", 12, 16) : "?");
    const left4 = entryType(left);
    const right4 = entryType(right);
    const kind = SAMPLE_ENTRY_PREAMBLE.has(left4) || SAMPLE_ENTRY_PREAMBLE.has(right4) ? "" : " (unrecognised)";
    return `${path}: sample entry ${left4} against ${right4}${kind}, ${left.length} bytes against ${right.length}`;
  }
  if (left.length !== right.length) {
    return `${path}: ${left.length} bytes against ${right.length}`;
  }
  let firstDifferent = 0;
  while (firstDifferent < left.length && left[firstDifferent] === right[firstDifferent]) {
    firstDifferent += 1;
  }
  return `${path}: differs from byte ${firstDifferent}`;
}

/**
 * Whether a piece made under `made` may be served under `served`.
 *
 * @param {Buffer} served - The header the player already holds.
 * @param {Buffer} made - The header the other output produces under.
 * @param {{ exceptions?: ReadonlyArray<{ path?: string, sampleEntryBox?: string }> }} [options]
 * @returns {{ compatible: boolean, differences: string[], refusedPaths: string[] }}
 */
export function compareInits(served, made, { exceptions = INIT_DIFFERENCE_EXCEPTIONS } = {}) {
  if (!Buffer.isBuffer(served) || !Buffer.isBuffer(made) || served.length === 0 || made.length === 0) {
    return {
      compatible: false,
      differences: ["one of the two headers is missing"],
      refusedPaths: ["<missing>"]
    };
  }
  if (served.equals(made)) {
    return { compatible: true, differences: [], refusedPaths: [] };
  }
  const left = initLeaves(served);
  const right = initLeaves(made);
  /** @type {string[]} */
  const differences = [];
  /** @type {string[]} */
  const refusedPaths = [];
  const paths = new Set([...left.keys(), ...right.keys()]);
  for (const path of paths) {
    const a = left.get(path) ?? null;
    const b = right.get(path) ?? null;
    if (a && b && a.equals(b)) {
      continue;
    }
    differences.push(describeDifference(path, a, b));
    if (!permits(exceptions, path)) {
      refusedPaths.push(path);
    }
  }
  if (differences.length === 0) {
    // The bytes differ but every leaf agrees, so what moved is a box header —
    // a size field, or a box present in one tree and absent from the other at a
    // level this walk treats as a container. Not attributable, therefore not
    // permitted.
    differences.push("the headers differ outside any leaf this walk can name");
    refusedPaths.push("<unattributed>");
  }
  return { compatible: refusedPaths.length === 0, differences, refusedPaths };
}
