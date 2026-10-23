/**
 * Keep source preparation stated until the viewer's playback map is applied.
 *
 * @param {() => Promise<unknown>} publishPlayback
 * @param {() => unknown} refreshPreparation
 * @returns {Promise<void>}
 */
export async function publishPlaybackBeforePreparationRefresh(publishPlayback, refreshPreparation) {
  await publishPlayback();
  refreshPreparation();
}
