/**
 * @file Which container an output's segments are in, read from its key.
 *
 * The key names the format produced, so a directory of segments can be read
 * back without any record kept elsewhere — which is what adopting segments an
 * earlier process left behind needs. A key in a shape this version does not
 * write (one naming the box a viewer asked for rather than the format
 * produced) cannot say what is inside, and the answer is null.
 */

import { OutputSpec } from "./output/index.js";
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "./segment-formats/index.js";

/**
 * @param {string} key
 * @returns {object | null} The segment format, or null when the key cannot say.
 */
export function segmentFormatOfKey(key) {
  const stated = OutputSpec.fromKey(key)?.segmentFormatId ?? "";
  return SEGMENT_FORMAT_IDS.includes(stated) ? resolveSegmentFormat(stated) : null;
}
