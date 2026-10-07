/**
 * @file The subtitle a viewer has chosen, as a term of their playback readiness.
 *
 * A file that says which subtitle to show — `FlagDefault` — is saying the film
 * is to be watched with it, the opening included. Starting the picture before
 * that track's cues have been read where the viewer stands showed the opening
 * without them (torrent-tv/meta#8). So the chosen track is one more input the
 * forecast waits for, beside the picture and the separately published sound.
 *
 * **What bounds the wait.** The read it waits for is one segment of that track
 * at the viewer's position (`SourcePreparation`, the `subtitle-embedded`
 * work), demanded at the picture's own urgency. It ends with the cues or with
 * the proxy's refusal to read the track, and `subtitleReadyFor` counts both.
 * No time limit is added: there is no measured figure to set one from, and the
 * bytes it needs are the ones beside the picture's own at the same position.
 *
 * The answer always carries `subtitles`, `null` included, so the page can tell
 * a proxy that weighed the chosen track from one that never heard of it.
 */

/**
 * @param {object} forecast - What `predictPlaybackReadiness` answered.
 * @param {{ fileIndex: number, trackIndex: number | null } | null} selection -
 *   The subtitle this viewer chose, for the file being opened; null for none.
 * @param {boolean} ready - Whether that subtitle has been read where they stand.
 * @returns {object} The forecast, holding for the subtitle where it must.
 */
export function withSubtitleReadiness(forecast, selection, ready) {
  const subtitles = selection
    ? { fileIndex: selection.fileIndex, trackIndex: selection.trackIndex, ready: ready === true }
    : null;
  if (forecast?.ready !== true || !subtitles || subtitles.ready) {
    return { ...forecast, subtitles };
  }
  // No delay: the forecast's figure is the picture's, which is already met, and
  // no rate predicts when a read of a few cues finishes.
  return { ...forecast, ready: false, delaySeconds: null, reason: "subtitles-pending", subtitles };
}
