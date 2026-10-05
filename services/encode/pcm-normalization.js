/** PCM variants that Matroska requires in a different byte representation. */
export function pcmNormalization(track) {
  if (track.matroskaCodecId) return null;
  const format = /^pcm_([suf])(8|16|24|32|64)(le|be)?$/.exec(track.codecId ?? "");
  if (!format) return null;
  const [, kind, bits, endian] = format;
  const width = Number(bits) / 8;
  const swap = kind === "f" && endian === "be";
  const flipSign = (kind === "s" && width === 1) || (kind === "u" && width > 1);
  return swap || flipSign ? { width, swap, flipSign, little: endian === "le" } : null;
}

/** Convert owned output bytes without modifying any shared source slice. */
export function normalizePcmSlices(slices, format) {
  const length = slices.reduce((sum, slice) => sum + slice.length, 0);
  if (length % format.width) throw new Error("PCM packet ends inside a sample.");
  const output = Buffer.alloc(length);
  let source = 0;
  for (const slice of slices) {
    for (const byte of slice) {
      const sample = Math.floor(source / format.width) * format.width;
      const within = source % format.width;
      const target = sample + (format.swap ? format.width - 1 - within : within);
      const signByte = format.little ? format.width - 1 : 0;
      output[target] = format.flipSign && within === signByte ? byte ^ 0x80 : byte;
      source++;
    }
  }
  return output;
}
