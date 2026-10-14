/**
 * @file What one pass that turns a file's playback map into bytes is worked out
 * from, so a pass whose inputs have not changed hands back what the last one
 * resolved (torrent-tv/meta#178).
 *
 * The viewer's map moves a second at a time while segments are seconds long,
 * so most passes give the zones the pass before gave: on Home Assistant 30–110
 * of 50–120 download maps a minute came out unchanged, and working them out
 * took 72 s of the main thread in fifteen minutes (r22). The deadlines are left
 * out of what is compared and their order is kept in it: a segment's deadline
 * is when the viewer reaches it, which moves only when they stop or seek, and
 * what is sent to the torrent is compared by the deadlines' order alone
 * (`DownloadMaps` `shapeOf`).
 */

/**
 * @param {object} params
 * @param {number} params.pieceLength - The precision the torrent fetches at.
 * @param {number} params.shift - Where the file's own clock starts.
 * @param {Map<string, number | null>} params.targets - Each output's next input, by output.
 * @param {Array<{ outputKey: string, index: number, priority: number, urgent?: boolean,
 *   behind?: boolean, deferred?: boolean, from: number, to: number,
 *   sourceInterval?: { from: number, to: number } }>} params.demands - In the
 *   order of their deadlines.
 * @returns {{ outputs: string[], inputs: Float64Array }}
 */
export function passInputs({ pieceLength, shift, targets, demands }) {
  const outputs = [...targets.keys()];
  const position = new Map(outputs.map((outputKey, at) => [outputKey, at]));
  // Numbers in a list made to its length: grown a value at a time, eight for
  // each of a film's 3500 segments, it was most of what comparing a pass cost
  // (r30, torrent-tv/meta#178).
  const inputs = new Float64Array(2 + targets.size + demands.length * 8);
  let at = 0;
  inputs[at++] = pieceLength;
  inputs[at++] = shift;
  for (const target of targets.values()) inputs[at++] = target ?? -1;
  for (const demand of demands) {
    // The segment's own interval too: a cut grid read again can give one
    // number other bytes.
    inputs[at++] = position.get(demand.outputKey) ?? -1;
    inputs[at++] = demand.index;
    inputs[at++] = demand.priority;
    inputs[at++] = (demand.urgent ? 1 : 0) + (demand.behind ? 2 : 0) + (demand.deferred ? 4 : 0);
    inputs[at++] = demand.from;
    inputs[at++] = demand.to;
    inputs[at++] = demand.sourceInterval?.from ?? -1;
    inputs[at++] = demand.sourceInterval?.to ?? -1;
  }
  return { outputs, inputs };
}

/**
 * Whether a pass is worked out from what an earlier one was.
 *
 * @param {{ tracks: unknown, outputs: string[], inputs: ArrayLike<number> } | undefined} last
 * @param {{ tracks: unknown, outputs: string[], inputs: ArrayLike<number> }} next
 * @returns {boolean}
 */
export function samePass(last, next) {
  return Boolean(last) && last.tracks === next.tracks &&
    sameValues(last.outputs, next.outputs) && sameValues(last.inputs, next.inputs);
}

/** Whether two lists hold the same values in the same order. */
function sameValues(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) return false;
  return true;
}
