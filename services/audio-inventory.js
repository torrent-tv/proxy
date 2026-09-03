/**
 * The soundtracks a viewer may choose between, as ONE numbered list — the ones
 * muxed into the picture and the ones shipped as separate files beside it.
 *
 * Why one list. Everything downstream addresses a soundtrack by a single number:
 * the browser's menu, the `audioTrackIndex` on the session-create request, the
 * `a/<n>/` path a rendition is published at, and hls.js's own rendition order.
 * Giving a sidecar file its own numbering would mean a second vocabulary and a
 * translation at every boundary. Instead the number stays flat and this module
 * owns the only place that knows what it resolves to: which FILE the track lives
 * in, and which track it is inside that file.
 *
 * The list is built from two readings of the same file, and that is deliberate:
 *
 * - ffmpeg's `-i` banner, which is what `0:a:N` will select and therefore the
 *   authority on NUMBERING;
 * - the container's own track table (`services/container/`), which is the only
 *   authority on the FLAGS — `FlagOriginal`, `FlagCommentary`,
 *   `FlagVisualImpaired`, `FlagEnabled` and `LanguageBCP47` do not appear in the
 *   banner at all, so the audio menu could not tell a director's commentary from
 *   the film itself.
 *
 * The two are lined up by position and the pairing is CHECKED, exactly as
 * `subtitle-defaults.js` checks its own: a length that differs, or one pair that
 * agrees on neither language nor title, means the two readings are not
 * describing the same thing in the same order — and then the container reading
 * is dropped whole rather than attributed to the wrong track. A wrong flag is
 * worse than a missing one, because `0:a:N` is what the encoder is given.
 */


import { AudioTrack } from "./tracks/AudioTrack.js";





/**
 * @typedef {object} AudioInventoryEntry
 * @property {number} index - The flat number everything downstream uses.
 * @property {number} fileIndex - The torrent file this track lives in.
 * @property {number} sourceTrackIndex - `0:a:N` WITHIN that file.
 * @property {"embedded" | "sidecar"} kind - Whether it is muxed into the picture
 *   or ships as a file beside it. Not a type of track — a statement about where
 *   the bytes are.
 * @property {string} codec
 * @property {string} language - As the container states it, or "" when it does
 *   not. Never guessed here: what a folder name suggests is derived in the
 *   browser, where the language table and the viewer's locale already live.
 * @property {string} languageBcp47
 * @property {string} title
 * @property {boolean} isDefault
 * @property {boolean} declaresDefault
 * @property {boolean} isOriginal
 * @property {boolean} isCommentary
 * @property {boolean} isVisualImpaired
 * @property {boolean} isEnabled
 * @property {number | null} channels
 * @property {string} fileName - For a sidecar: its own file name. "" otherwise.
 * @property {string[]} folders - For a sidecar: the folders above it, relative
 *   to the torrent root. What the browser reads a language and a releaser from.
 */

/**
 * One numbered list from the picture's own tracks and its sidecar files.
 *
 * Order is load-bearing: embedded tracks keep the numbers they have always had,
 * so a session created before this existed and one created after agree about
 * what `audioTrackIndex: 1` means, and sidecars are appended after them in
 * torrent-file order. Sidecar files are stable in that order for a given
 * torrent, so the numbering is stable for a given file.
 *
 * @param {object} params
 * @param {object[]} params.embedded - Merged banner+container tracks of the video.
 * @param {number} params.videoFileIndex
 * @param {Array<{ file: import("./sidecar-files.js").SidecarFile, tracks: object[] }>} params.sidecars
 *   Each sidecar file with the audio tracks IT holds. A file whose container
 *   could not be read contributes one track, which is what a bare elementary
 *   stream is.
 * @returns {AudioInventoryEntry[]}
 */
export function buildAudioInventory({ embedded, videoFileIndex, sidecars }) {
  /** @type {AudioInventoryEntry[]} */
  const inventory = [];
  const add = (track, fileIndex, sourceTrackIndex, kind, file) => {
    inventory.push({
      index: inventory.length,
      fileIndex,
      sourceTrackIndex,
      kind,
      // The name the browser judges "can I play this?" by. For an embedded
      // track it is ffmpeg's own; for a sidecar it is translated from what the
      // container wrote, or from the extension when there was no table to read.
      codec: AudioTrack.codecNameOf(track, file?.extension ?? ""),
      language: typeof track?.language === "string" ? track.language : "",
      languageBcp47: typeof track?.languageBcp47 === "string" ? track.languageBcp47 : "",
      title:
        typeof track?.title === "string" && track.title.length > 0
          ? track.title
          : (typeof track?.name === "string" ? track.name : ""),
      isDefault: track?.isDefault === true,
      declaresDefault: track?.declaresDefault === true,
      isOriginal: track?.isOriginal === true,
      isCommentary: track?.isCommentary === true,
      isVisualImpaired: track?.isVisualImpaired === true,
      isEnabled: track?.isEnabled !== false,
      channels: Number.isFinite(track?.channels) ? track.channels : null,
      fileName: kind === "sidecar" ? (file?.name ?? "") : "",
      folders: kind === "sidecar" && Array.isArray(file?.folders) ? file.folders : []
    });
  };

  for (const [order, track] of (Array.isArray(embedded) ? embedded : []).entries()) {
    add(track, videoFileIndex, order, "embedded", null);
  }
  for (const sidecar of Array.isArray(sidecars) ? sidecars : []) {
    const tracks = Array.isArray(sidecar?.tracks) && sidecar.tracks.length > 0
      ? sidecar.tracks
      // A file whose track table could not be read is one track: `.ac3`, `.dts`
      // and `.mp3` have no table to read, and a `.mka` whose head has not
      // arrived yet is better offered than hidden — ffmpeg will find its first
      // audio stream either way.
      : [{}];
    for (const [order, track] of tracks.entries()) {
      add(track, sidecar.file.fileIndex, order, "sidecar", sidecar.file);
    }
  }
  return inventory;
}

/**
 * Resolve the flat number back to the file and the track inside it.
 *
 * @param {AudioInventoryEntry[]} inventory
 * @param {number} index
 * @returns {AudioInventoryEntry | null}
 */
export function resolveAudioIndex(inventory, index) {
  if (!Array.isArray(inventory) || !Number.isInteger(index) || index < 0) {
    return null;
  }
  return inventory.find((entry) => entry.index === index) ?? null;
}

/**
 * The name an `#EXT-X-MEDIA` line carries for one soundtrack.
 *
 * Deliberately plain, and deliberately NOT localised: this is the name inside a
 * playlist, and what the viewer reads in the menu is composed in the browser
 * from the same facts, where the language table and the viewer's own locale are.
 * The only requirements here are that it says something and that no two
 * renditions of one file share it — hls.js groups renditions by name.
 *
 * @param {AudioInventoryEntry} entry
 * @param {AudioInventoryEntry[]} inventory
 * @returns {string}
 */
export function audioRenditionName(entry, inventory) {
  const parts = [];
  if (entry.title) {
    parts.push(entry.title);
  } else if (entry.languageBcp47 || entry.language) {
    parts.push(entry.languageBcp47 || entry.language);
  } else if (entry.folders.length > 0) {
    // The folder a dub sits in is usually the only thing naming it, and a
    // release names it for a reason: "Rus Sound", "Ukr Dub".
    parts.push(entry.folders[entry.folders.length - 1]);
  } else if (entry.fileName) {
    parts.push(entry.fileName);
  } else {
    parts.push(`Track ${entry.index + 1}`);
  }
  if (entry.isCommentary) {
    parts.push("commentary");
  } else if (entry.isVisualImpaired) {
    parts.push("described");
  }
  const name = parts.join(" · ");
  const clash = (Array.isArray(inventory) ? inventory : []).some(
    (other) => other.index !== entry.index && audioRenditionNameCore(other) === audioRenditionNameCore(entry)
  );
  return clash ? `${name} (${entry.index + 1})` : name;
}

/**
 * The part of a rendition name that a clash is judged on — the name without the
 * disambiguating number, so that adding the number cannot itself cause a clash.
 *
 * @param {AudioInventoryEntry} entry
 * @returns {string}
 */
function audioRenditionNameCore(entry) {
  return (
    entry.title ||
    entry.languageBcp47 ||
    entry.language ||
    (entry.folders.length > 0 ? entry.folders[entry.folders.length - 1] : "") ||
    entry.fileName ||
    ""
  );
}
