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
 * @returns {{ outputs: string[], inputs: number[] }}
 */
export function passInputs({ pieceLength, shift, targets, demands }) {
  const outputs = [...targets.keys()];
  const inputs = [pieceLength, shift];
  for (const target of targets.values()) inputs.push(target ?? -1);
  for (const demand of demands) {
    // The segment's own interval too: a cut grid read again can give one
    // number other bytes.
    inputs.push(outputs.indexOf(demand.outputKey), demand.index, demand.priority,
      (demand.urgent ? 1 : 0) + (demand.behind ? 2 : 0) + (demand.deferred ? 4 : 0),
      demand.from, demand.to, demand.sourceInterval?.from ?? -1, demand.sourceInterval?.to ?? -1);
  }
  return { outputs, inputs };
}

/**
 * Whether a pass is worked out from what an earlier one was.
 *
 * @param {{ tracks: unknown, outputs: string[], inputs: number[] } | undefined} last
 * @param {{ tracks: unknown, outputs: string[], inputs: number[] }} next
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
