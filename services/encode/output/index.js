export { OutputSpec, VideoOutput, AudioOutput, CutGrid, isOutputName } from "./OutputSpec.js";
export { PLAYLIST_FILE_NAME } from "./playlists.js";

/**
 * The code an error carries when no output suits the viewer: nothing this proxy
 * could produce or already holds is admitted by their link. Its `details` say
 * why and with which figures. A definition shared by both sides of the
 * interface — the encoding that decides it and the routes that answer it.
 */
export const OUTPUT_UNAVAILABLE = "OUTPUT_UNAVAILABLE";

/**
 * The code an error carries when THIS MACHINE cannot take the output: no mode
 * of its encoder was shown at startup to hold the picture at any size this
 * viewer could be given, or the machine has no place for one more encoder
 * beside what already runs (roadmap item 97, step 14). Not the viewer's link —
 * another proxy may well serve it, and the page asks the pool before anything
 * plays. Its `details` say why, with the figures.
 */
export const OUTPUT_NO_CAPACITY = "OUTPUT_NO_CAPACITY";
