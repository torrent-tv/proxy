/**
 * @file The addresses an encoder reads its source from.
 *
 * Built per run from facts that belong elsewhere — which files the output
 * reads (`OutputSpec`), where the stream route listens, which output the read
 * feeds, and how wide its read window is — and kept nowhere.
 *
 * Two query parameters are what make the encoder's read what it is to the
 * stream route: `reader=playback`, the one read that says where the viewer is,
 * and `windowBytes`, how far ahead of itself that read asks the swarm for,
 * sized in seconds of playback by whoever knows the file's byte rate.
 */

/**
 * @param {object} params
 * @param {{ fileIndex: number, streamUrl: (baseUrl: string, options?: { sessionId?: string }) => URL }} params.picture
 * @param {{ fileIndex: number, streamUrl: (baseUrl: string, options?: { sessionId?: string }) => URL }} params.soundtrack
 *   The file the carried soundtrack lives in; the picture's own file for an
 *   embedded track.
 * @param {"video-only" | "audio-only" | "muxed" | "empty"} params.carries
 * @param {boolean} params.audioSeparate - The picture's sound travels as its own output.
 * @param {string} params.sessionId - Which output this read feeds.
 * @param {number} params.readWindowBytes - Zero when no window was measured.
 * @param {string} params.baseUrl
 * @returns {{ inputFile: object, audioFile: object, inputUrl: string, audioInputUrl: string }}
 */
export function encoderInputs({ picture, soundtrack, carries, audioSeparate, sessionId, readWindowBytes, baseUrl }) {
  // A soundtrack shipped as its own file is encoded FROM that file, so a
  // rendition of it reads nothing else.
  const inputFile = carries === "audio-only" && soundtrack !== picture ? soundtrack : picture;
  const input = inputFile.streamUrl(baseUrl, { sessionId });
  if (Number.isFinite(readWindowBytes) && readWindowBytes > 0) {
    input.searchParams.set("windowBytes", String(readWindowBytes));
    input.searchParams.set("reader", "playback");
  }
  // The second input exists only for a picture that carries its sound inside
  // itself when that sound is in another file.
  const audioInputUrl = carries !== "audio-only" && !audioSeparate && soundtrack !== inputFile
    ? soundtrack.streamUrl(baseUrl, { sessionId }).toString()
    : "";
  return { inputFile, audioFile: soundtrack, inputUrl: input.toString(), audioInputUrl };
}
