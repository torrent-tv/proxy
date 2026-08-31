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

/**
 * Language codes that carry no information, so cannot confirm a pairing. Same
 * rule and same reasoning as `subtitle-defaults.js`: ffmpeg prints `und` for a
 * stream with no language, while Matroska's own default for `Language` is `eng`
 * — which is also a real answer, so it is compared like any other.
 */
const EMPTY_LANGUAGES = new Set(["", "und", "unknown"]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalise(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Whether one banner stream and one container track can be the same track.
 *
 * Agreement on either the language or the title is enough; both sides saying
 * nothing is not agreement, but it is not disagreement either — a file may name
 * neither, and then this pair simply adds no support to the alignment.
 *
 * @param {{ language?: string, title?: string }} banner
 * @param {{ language?: string, name?: string }} container
 * @returns {boolean}
 */
export function audioPairingHolds(banner, container) {
  const bannerLanguage = normalise(banner?.language);
  const containerLanguage = normalise(container?.language);
  if (
    !EMPTY_LANGUAGES.has(bannerLanguage) &&
    !EMPTY_LANGUAGES.has(containerLanguage) &&
    bannerLanguage === containerLanguage
  ) {
    return true;
  }
  const bannerTitle = normalise(banner?.title);
  const containerName = normalise(container?.name);
  if (bannerTitle.length > 0 && bannerTitle === containerName) {
    return true;
  }
  return (
    (EMPTY_LANGUAGES.has(bannerLanguage) || EMPTY_LANGUAGES.has(containerLanguage)) &&
    (bannerTitle.length === 0 || containerName.length === 0)
  );
}

/**
 * The banner's audio streams, with what the container declares about each.
 *
 * @param {Array<{ index?: number, language?: string, title?: string, isDefault?: boolean, codec?: string }>} bannerTracks
 * @param {Array<object>} declared - `AudioTrack`s in container order.
 * @returns {{ tracks: object[], aligned: boolean, reason: string }}
 */
export function mergeContainerAudioFlags(bannerTracks, declared) {
  const banner = Array.isArray(bannerTracks) ? bannerTracks : [];
  const container = Array.isArray(declared) ? declared : [];
  const undecided = () => ({
    // Nothing of the container reading is used, flags included — attributing
    // them to the wrong track is the failure this guard exists to prevent.
    tracks: banner.map((track) => ({
      ...track,
      declaresDefault: false,
      isOriginal: false,
      isCommentary: false,
      isVisualImpaired: false,
      // Not "the container says this track is unusable": the container has not
      // been heard from. A track is offered unless it was read to say otherwise.
      isEnabled: true,
      languageBcp47: "",
      channels: null
    }))
  });
  if (banner.length === 0) {
    return { tracks: [], aligned: false, reason: "the probe found no audio stream" };
  }
  if (container.length === 0) {
    return { ...undecided(), aligned: false, reason: "the container declares no audio track" };
  }
  if (container.length !== banner.length) {
    return {
      ...undecided(),
      aligned: false,
      reason: `the container declares ${container.length} audio tracks and the probe found ${banner.length}`
    };
  }
  for (const [order, track] of banner.entries()) {
    if (!audioPairingHolds(track, container[order])) {
      return {
        ...undecided(),
        aligned: false,
        reason:
          `audio ${order} is "${normalise(track?.title) || "-"}"/${normalise(track?.language) || "-"} ` +
          `in the probe and "${normalise(container[order]?.name) || "-"}"/` +
          `${normalise(container[order]?.language) || "-"} in the container`
      };
    }
  }
  return {
    tracks: banner.map((track, order) => ({
      ...track,
      // Read from the file itself (RFC 9559 §5.1.4.1). None of these four
      // reaches ffmpeg's banner, which is where every other field here is from.
      isOriginal: container[order].isOriginal === true,
      isCommentary: container[order].isCommentary === true,
      isVisualImpaired: container[order].isVisualImpaired === true,
      isEnabled: container[order].isEnabled !== false,
      // FlagDefault, and whether the file actually WROTE it. Matroska defaults
      // the flag to 1 and ffmpeg prints the applied default, so the banner
      // cannot tell "every track marked" from "the file has no opinion".
      isDefault: container[order].isDefault === true,
      declaresDefault: container[order].declaresDefault === true,
      languageBcp47:
        typeof container[order].languageBcp47 === "string" ? container[order].languageBcp47 : "",
      channels: Number.isFinite(container[order].channels) ? container[order].channels : null,
      title:
        typeof track?.title === "string" && track.title.length > 0
          ? track.title
          : (typeof container[order].name === "string" ? container[order].name : "")
    })),
    aligned: true,
    reason: ""
  };
}

/**
 * Codec identifiers as containers write them, against the name ffmpeg prints.
 *
 * Needed because the browser decides whether it can play a soundtrack from that
 * name, and for a sidecar file there is no ffmpeg banner to read it from — the
 * track came from the container's own table, where Matroska writes `A_AC3` and
 * MP4 writes `ac-3` for the thing ffmpeg calls `ac3`. Only what a soundtrack can
 * actually be is listed; an identifier not here is reported as it was written,
 * which the browser treats as one it does not know and therefore transcodes.
 */
const CODEC_NAMES = new Map([
  ["A_AAC", "aac"],
  ["A_AC3", "ac3"],
  ["A_EAC3", "eac3"],
  ["A_DTS", "dts"],
  ["A_FLAC", "flac"],
  ["A_OPUS", "opus"],
  ["A_VORBIS", "vorbis"],
  ["A_TRUEHD", "truehd"],
  ["A_MPEG/L3", "mp3"],
  ["A_MPEG/L2", "mp2"],
  ["A_ALAC", "alac"],
  ["mp4a", "aac"],
  ["ac-3", "ac3"],
  ["ec-3", "eac3"],
  ["alac", "alac"],
  ["opus", "opus"],
  ["Opus", "opus"],
  ["fLaC", "flac"],
  ["flac", "flac"]
]);

/**
 * Extensions of raw elementary streams, against the codec they carry.
 *
 * A bare `.ac3` has no track table to read, and its extension is the only thing
 * that states its codec — which for an elementary stream is exactly what the
 * extension means.
 */
const CODEC_BY_EXTENSION = new Map([
  [".aac", "aac"],
  [".ac3", "ac3"],
  [".eac3", "eac3"],
  [".dts", "dts"],
  [".dtshd", "dts"],
  [".flac", "flac"],
  [".mp3", "mp3"],
  [".mp2", "mp2"],
  [".opus", "opus"],
  [".ogg", "vorbis"],
  [".oga", "vorbis"],
  [".wav", "pcm"],
  [".thd", "truehd"],
  [".mlp", "truehd"],
  [".m4a", "aac"]
]);

/**
 * The ffmpeg-side codec name for one track, from whatever the reading gave.
 *
 * @param {{ codec?: string, codecId?: string }} track
 * @param {string} [extension] - The sidecar file's extension, when the track
 *   came from a file with no readable table.
 * @returns {string}
 */
export function codecNameOf(track, extension = "") {
  const fromBanner = typeof track?.codec === "string" ? track.codec.trim() : "";
  if (fromBanner.length > 0) {
    return fromBanner.toLowerCase();
  }
  const codecId = typeof track?.codecId === "string" ? track.codecId.trim() : "";
  if (codecId.length > 0) {
    const known = CODEC_NAMES.get(codecId);
    if (known) {
      return known;
    }
    // Matroska allows a suffix — `A_AAC/MPEG4/LC`, `A_PCM/INT/LIT` — so the
    // family is what the first two segments say.
    const family = codecId.split("/").slice(0, 2).join("/");
    const byFamily = CODEC_NAMES.get(family) ?? CODEC_NAMES.get(codecId.split("/")[0]);
    if (byFamily) {
      return byFamily;
    }
    if (codecId.startsWith("A_PCM")) {
      return "pcm";
    }
    return codecId.toLowerCase();
  }
  return CODEC_BY_EXTENSION.get(extension) ?? "";
}

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
      codec: codecNameOf(track, file?.extension ?? ""),
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
