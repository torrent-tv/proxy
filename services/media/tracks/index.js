// Only what is imported through this file, which is the one type five other
// modules name in their JSDoc. Every class beside it — `VideoTrack`,
// `AudioTrack`, `SubtitleTrack`, `TextSubtitleTrack`, `ImageSubtitleTrack` —
// and the tables `TEXT_CODECS_MATROSKA`, `TEXT_FORMATS_MP4` and `MarkupKind`
// were re-exported here and taken by nobody: whoever needs one imports the
// module that declares it.
export { ContainerTrack } from "./ContainerTrack.js";

// There is deliberately no class for a track that lives in a file of its own.
// `<name>.mka` is a Matroska container holding an `AudioTrack`, and
// `MatroskaContainer` reads it exactly as it reads the picture's — so "external"
// is not a KIND of track, only the answer to where a track's bytes are. That
// answer belongs to the application layer, which knows about torrents; this one
// describes what a container declares and must not. `ExternalSubtitleFile`,
// which asserted the opposite, was never used by anything and is gone.
