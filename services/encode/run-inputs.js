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

/** The query parameter naming which run of an output a read feeds. */
const RUN_PARAMETER = "run";

/**
 * @param {object} params
 * @param {{ fileIndex: number, streamUrl: (baseUrl: string, options?: { sessionId?: string }) => URL }} params.picture
 * @param {{ fileIndex: number, streamUrl: (baseUrl: string, options?: { sessionId?: string }) => URL }} params.soundtrack
 *   The file the carried soundtrack lives in; the picture's own file for an
 *   embedded track.
 * @param {"video-only" | "audio-only" | "muxed" | "empty"} params.carries
 * @param {boolean} params.audioSeparate - The picture's sound travels as its own output.
 * @param {string} params.sessionId - Which output this read feeds.
 * @param {number} [params.runToken] - Which run of that output the read feeds,
 *   so the time its input waits is charged to that run and not to another one
 *   working on the same output.
 * @param {number} params.readWindowBytes - Zero when no window was measured.
 * @param {string} params.baseUrl
 * @returns {{ inputFile: object, audioFile: object, inputUrl: string, audioInputUrl: string }}
 */
export function encoderInputs({ picture, soundtrack, carries, audioSeparate, sessionId, runToken, readWindowBytes, baseUrl }) {
  // A soundtrack shipped as its own file is encoded FROM that file, so a
  // rendition of it reads nothing else.
  const inputFile = carries === "audio-only" && soundtrack !== picture ? soundtrack : picture;
  const input = inputFile.streamUrl(baseUrl, { sessionId });
  const forRun = (url) => {
    if (Number.isInteger(runToken)) url.searchParams.set(RUN_PARAMETER, String(runToken));
    return url;
  };
  forRun(input);
  if (Number.isFinite(readWindowBytes) && readWindowBytes > 0) {
    input.searchParams.set("windowBytes", String(readWindowBytes));
    input.searchParams.set("reader", "playback");
  }
  // The second input exists only for a picture that carries its sound inside
  // itself when that sound is in another file.
  const audioInputUrl = carries !== "audio-only" && !audioSeparate && soundtrack !== inputFile
    ? forRun(soundtrack.streamUrl(baseUrl, { sessionId })).toString()
    : "";
  return { inputFile, audioFile: soundtrack, inputUrl: input.toString(), audioInputUrl };
}
