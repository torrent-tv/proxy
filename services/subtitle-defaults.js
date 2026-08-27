/**
 * Which subtitle track the FILE says to show, read from the file rather than
 * from ffmpeg's description of it.
 *
 * Why this exists. The browser decides which subtitle track to turn on from
 * `isDefault`, and until now that came from ffmpeg's `-i` banner, which prints
 * `(default)`. In Matroska `FlagDefault` DEFAULTS TO 1 and ffmpeg has already
 * applied that default by the time it prints — so a file whose muxer wrote the
 * flag on no track arrives looking exactly like one that wrote it on every
 * track: everything marked. The banner cannot tell the two apart, and the
 * difference is the whole question, because one of them means "show this one"
 * and the other means "the file has no opinion".
 *
 * The container itself can be asked, and the EBML reader already walks the
 * Tracks element for subtitle extraction. What it now also records is whether
 * the element was WRITTEN, which is the fact the banner destroys.
 *
 * The awkward part is lining the two readings up. ffmpeg numbers its subtitle
 * streams `0:s:0`, `0:s:1`, … over EVERY subtitle stream, picture-based ones
 * included, in the order the container declares them; the container reading is
 * a list in that same order. So position is the correspondence — but a position
 * match that is merely assumed is worth nothing, so it is CHECKED: each pair
 * has to agree on language or on title. One pair that agrees on neither, or a
 * length that differs, means the two readings are not describing the same
 * thing in the same order, and then the container reading is not used at all.
 */

/**
 * Language codes that carry no information, and so cannot confirm a pairing.
 *
 * ffmpeg prints `und` for a stream with no language; Matroska's own default
 * for `Language` is `eng`, which is why an absent element cannot be read as a
 * statement either — but `eng` is also a real answer, so it is not listed here
 * and is compared like any other.
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
 * Agreement on either the language or the name is enough; both being empty is
 * not agreement, because two tracks that say nothing about themselves say
 * nothing about their pairing either.
 *
 * @param {{ language?: string, title?: string }} banner
 * @param {{ language?: string, name?: string }} container
 * @returns {boolean}
 */
export function pairingHolds(banner, container) {
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
  // Nothing to compare on either side. Not a disagreement — a file may name
  // neither — so it does not break the alignment; it simply adds no support.
  return (
    (EMPTY_LANGUAGES.has(bannerLanguage) || EMPTY_LANGUAGES.has(containerLanguage)) &&
    (bannerTitle.length === 0 || containerName.length === 0)
  );
}

/**
 * The banner's subtitle tracks, with what the container says about each.
 *
 * Every returned track gains `declaresDefault`: whether the FILE wrote the flag
 * for it. When the container reading cannot be trusted — no declarations, a
 * different number of them, or a pair that agrees on neither language nor name
 * — every track gets `declaresDefault: false` and its `isDefault` is left as
 * the banner had it. That is the honest answer for a file we cannot read this
 * way: the container has not been heard from, so nothing is shown unasked.
 *
 * @param {Array<{ index?: number, language?: string, title?: string, isDefault?: boolean }>} bannerTracks
 * @param {Array<{ language?: string, name?: string, isDefault?: boolean, declaresDefault?: boolean }>} declared
 * @returns {{ tracks: object[], aligned: boolean, reason: string }}
 */
export function mergeContainerSubtitleFlags(bannerTracks, declared) {
  const banner = Array.isArray(bannerTracks) ? bannerTracks : [];
  const container = Array.isArray(declared) ? declared : [];
  const undecided = () => ({
    // The container reading could not be lined up, so nothing of it is used —
    // including the flags, which would otherwise be attributed to the wrong
    // track.
    tracks: banner.map((track) => ({
      ...track,
      declaresDefault: false,
      isForced: false,
      isHearingImpaired: false,
      // Not "the container says this track is unusable" — nothing of the
      // container is being used here. A track is offered unless it was read to
      // say otherwise.
      isEnabled: true,
      languageBcp47: ""
    }))
  });
  if (container.length === 0) {
    return { ...undecided(), aligned: false, reason: "the container declares no subtitle track" };
  }
  if (container.length !== banner.length) {
    return {
      ...undecided(),
      aligned: false,
      reason: `the container declares ${container.length} subtitle tracks and the probe found ${banner.length}`
    };
  }
  for (const [order, track] of banner.entries()) {
    if (!pairingHolds(track, container[order])) {
      return {
        ...undecided(),
        aligned: false,
        reason:
          `subtitle ${order} is "${normalise(track?.title) || "-"}"/${normalise(track?.language) || "-"} ` +
          `in the probe and "${normalise(container[order]?.name) || "-"}"/` +
          `${normalise(container[order]?.language) || "-"} in the container`
      };
    }
  }
  return {
    tracks: banner.map((track, order) => ({
      ...track,
      isDefault: container[order].isDefault === true,
      declaresDefault: container[order].declaresDefault === true,
      // Read from the file rather than guessed from the track's name. Both are
      // stated by the container itself (RFC 9559 §5.1.4.1) and neither reaches
      // ffmpeg's `-i` banner, which is where every other field here comes from.
      isForced: container[order].isForced === true,
      isHearingImpaired: container[order].isHearingImpaired === true,
      // FlagEnabled, so the browser can leave an unusable track out of the
      // menu. It stays in this list and keeps its number: ffmpeg creates a
      // stream for it either way.
      isEnabled: container[order].isEnabled !== false,
      // The RFC 5646 tag, where the file writes one. Kept beside the code
      // rather than replacing it: what this list is aligned against is ffmpeg's
      // banner, which prints the three-letter form.
      languageBcp47: typeof container[order].languageBcp47 === "string" ? container[order].languageBcp47 : ""
    })),
    aligned: true,
    reason: ""
  };
}
