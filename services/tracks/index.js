export { ContainerTrack } from "./ContainerTrack.js";
export { VideoTrack } from "./VideoTrack.js";
export { AudioTrack } from "./AudioTrack.js";
export { SubtitleTrack } from "./SubtitleTrack.js";
export { TextSubtitleTrack, TEXT_CODECS_MATROSKA, TEXT_FORMATS_MP4 } from "./TextSubtitleTrack.js";
export { ImageSubtitleTrack } from "./ImageSubtitleTrack.js";
export { MarkupKind } from "./TextSubtitleTrack.js";
// There is deliberately no class for a track that lives in a file of its own.
// `<name>.mka` is a Matroska container holding an `AudioTrack`, and
// `MatroskaContainer` reads it exactly as it reads the picture's — so "external"
// is not a KIND of track, only the answer to where a track's bytes are. That
// answer belongs to the application layer, which knows about torrents; this one
// describes what a container declares and must not. `ExternalSubtitleFile`,
// which asserted the opposite, was never used by anything and is gone.
