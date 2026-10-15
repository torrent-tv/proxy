/**
 * @file Which input a run fed packet by packet goes on with.
 *
 * Such a run keeps its input open while more is appended, and FFmpeg closes a
 * piece only once it reads past the piece's end, so a piece is published when
 * the input after it arrives or the input ends. Waited for, the next input
 * held each piece back for as long as preparing it took: on Home Assistant a
 * soundtrack's #7 waited 14 s for #8's attempt, which ended refused memory, and
 * the picture stood at 61.8 s (r54, r55, torrent-tv/meta#178).
 *
 * So a run is given the next input only when it is ready, and the one after it
 * is begun as soon as one is taken: the run goes on while preparation keeps
 * ahead of it, and ends, publishing its last piece, when it does not. The plan
 * starts the next run on the input being prepared.
 */

/**
 * A source of the inputs after a run's first.
 *
 * @param {object} params
 * @param {(index: number) => object | null} params.take - The input of one
 *   piece if ready, beginning its preparation otherwise (`EncodeInputs.take`).
 * @param {(index: number) => boolean} params.canAppend - Whether the piece may
 *   still be made by this run.
 * @param {number} params.first - The first piece after the run's own.
 * @param {number} params.last - The last piece the run may reach.
 * @returns {{ next: (onTaken?: (index: number) => void) => object | null, release: () => void }}
 */
export function nextPacketInputs({ take, canAppend, first, last }) {
  let index = first;
  let ahead = null;
  const begin = at => {
    if (at <= last && canAppend(at)) ahead = take(at);
  };
  begin(index);
  return {
    next(onTaken) {
      if (index > last || !canAppend(index)) return null;
      const input = ahead ?? take(index);
      ahead = null;
      if (!input) return null;
      if (!canAppend(index)) {
        input.release();
        return null;
      }
      onTaken?.(index);
      index += 1;
      begin(index);
      return input;
    },
    release() {
      ahead?.release();
      ahead = null;
    }
  };
}
