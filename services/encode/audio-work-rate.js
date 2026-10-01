/** Initial per-codec work model, replaced by the track's actual speed. */
export function audioReadingFor(readings, { codec, transcode, channels, samplingFrequency, bitrateKbps }) {
  const operation = transcode ? "aac" : "copy";
  const normalized = String(codec ?? "").replace(/^pcm_.*/, "pcm");
  const reference = readings?.find((reading) => reading.codec === normalized && reading.operation === operation);
  if (!reference) return null;
  const referenceBytesPerSecond = reference.bytes / reference.durationSeconds;
  // Copy work is encoded bytes; processing work is audio samples. Unstated
  // dimensions retain the reference measurement, rather than invented values.
  const workRatio = !transcode && bitrateKbps > 0 ? (bitrateKbps * 1000 / 8) / referenceBytesPerSecond :
    transcode && channels > 0 && samplingFrequency > 0 ?
      (channels * samplingFrequency) / (reference.channels * reference.samplingFrequency) : 1;
  return { ...reference, speed: reference.speed / workRatio,
    basis: workRatio === 1 ? "measured-reference" : transcode ? "audio-samples" : "encoded-bytes" };
}
