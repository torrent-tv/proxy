/**
 * @file Base Container — abstract per RFC 9559 / ISO 14496-12.
 *
 * A Container knows how to read its own format's track table and index.
 * Concrete containers (MatroskaContainer, Mp4Container, AviContainer) implement
 * spec-specific parsing. All byte access goes through `readRange(start,end)` so
 * the class works over torrent piece windows.
 *
 * Spec refs:
 *  - Matroska RFC 9559 §5: EBML, Segment, SeekHead, Tracks, Cues, Clusters
 *  - MP4 ISO/IEC 14496-12 §8: ftyp, moov, trak, tkhd, mdhd, hdlr, elng, stbl
 *  - AVI RIFF §: LIST hdrl, idx1
 */

/**
 * What one file declares about itself. Every field is either a value the
 * container states or `null`, which means the container does not state it —
 * a defined absence, not "nobody has looked yet".
 *
 * @typedef {object} ContainerMediaInfo
 * @property {string} format - "matroska" | "mp4" | "avi" | "unknown".
 * @property {number | null} durationSeconds
 * @property {number | null} startTimeSeconds - Where this file's own timeline
 *   begins. Two files of one release need not agree on it, and the difference
 *   is what keeps a soundtrack shipped separately aligned with its picture.
 */

export class Container {
  /**
   * Two ways of reading, because two readers of one file want different things
   * and the file is opened once.
   *
   * `readRange` fetches what is missing: the head and the track table are
   * kilobytes, they are needed before anything can be offered, and the codec
   * probe has already pulled the head of every file that plays. `readHeld`
   * reads only what is already downloaded and asks the swarm for nothing, which
   * is what the cue walk needs — turning subtitles on must not pull bytes the
   * viewer is not waiting for. `isHeld` says whether a range can be read that
   * way at all, so the walk can leave a cluster for next time instead of
   * blocking on it.
   *
   * They are given per container rather than per call because a container is
   * cached per file and both readers want the same parsed head. Where the
   * caller supplies only `readRange`, the held reader is that one and every
   * range counts as held — which is the right answer for a local file, and for
   * a torrent it is the caller's job to say otherwise.
   *
   * The torrent is NOT passed in and must not be: `readHeld` and `isHeld` are
   * the only two facts about it this layer needs, and reducing it to two
   * functions is what keeps the container ignorant of where its bytes live.
   *
   * @param {object} params
   * @param {(start:number,end:number)=>Promise<Buffer|null>} params.readRange
   * @param {number} params.fileSize
   * @param {string} [params.label]
   * @param {(start:number,end:number)=>Promise<Buffer|null>} [params.readHeld]
   * @param {(start:number,end:number)=>boolean} [params.isHeld]
   */
  constructor({ readRange, fileSize, label = "", readHeld, isHeld }) {
    this.readRange = readRange;
    this.fileSize = fileSize;
    this.label = label;
    this.readHeld = typeof readHeld === "function" ? readHeld : readRange;
    this.isHeld = typeof isHeld === "function" ? isHeld : () => true;
  }


  /**
   * Whether one of ffmpeg's banner streams and one of this container's tracks
   * can be the same track.
   *
   * @param {{ language?: string, title?: string }} banner
   * @param {{ language?: string, name?: string }} container
   * @returns {boolean}
   */
  static pairingHolds(banner, container) {
    return pairingHolds(banner, container);
  }

  /**
   * ffmpeg's description of a file's subtitle streams, corrected by what the
   * container itself declares.
   *
   * The banner cannot express the difference between "no track is marked" and
   * "every track is marked", because Matroska's `FlagDefault` defaults to 1 and
   * ffmpeg has already applied that default by the time it prints. The
   * container can be asked, and this is where the two readings are lined up —
   * by position, checked pair by pair rather than assumed.
   *
   * @param {object[]} bannerTracks
   * @param {object[]} declared - This container's own subtitle tracks, in its order.
   * @returns {object[]}
   */
    /**
   * The picture's facts, from the two readings that state them.
   *
   * Audio and subtitles have had this since the flags were first read from the
   * file; video never did. Every figure the encode is planned from — the size,
   * the frame rate, whether it is HDR, how many bits a sample carries — was
   * taken from ffmpeg's `-i` banner alone, and the `VideoTrack` the container
   * declares was read and then used for nothing but a line in the log.
   *
   * Which reading wins is decided per field by what each one IS, and the rule
   * is the one `readMediaInfo` already states: a fact the container DECLARES is
   * read from the container; a fact only the media has is measured from the
   * media.
   *
   * - the coded size and the frame rate are the BANNER's. Both are declared by
   *   the container as well, but what the encoder receives is what the decoder
   *   produced, and the ladder and the scale filter have to be sized to that. A
   *   container that declares something else is mis-declaring, and using its
   *   numbers would size the encode to a picture that never arrives;
   * - the bit depth and the HDR signalling are the CONTAINER's where it states
   *   them. They are not properties of the decoded frames at all — they are the
   *   file saying how its samples are to be read — and ffmpeg prints them only
   *   as a side effect of naming a pixel format. HDR is not compared for
   *   disagreement: both sides give a boolean, and a boolean cannot say "I did
   *   not look";
   * - the display size is the container's alone; the banner has no such field.
   *
   * Where only one side states a field, that side answers whatever the rule
   * would have preferred. Where both state it and they DISAGREE, the
   * disagreement is reported: it is a fact about the file, and until now
   * nothing could see it.
   *
   * @param {{ width?: number|null, height?: number|null, fps?: number|null, isHdr?: boolean, bitDepth?: number|null }} banner
   * @param {object | null} declared - The container's own `VideoTrack`.
   * @returns {{ width: number|null, height: number|null, fps: number|null, isHdr: boolean, bitDepth: number|null, displayWidth: number|null, displayHeight: number|null, disagreements: string[] }}
   */
  static mergeVideoFacts(banner, declared) {
    const number = (value) => (Number.isFinite(value) && value > 0 ? Number(value) : null);
    const fromBanner = {
      width: number(banner?.width),
      height: number(banner?.height),
      fps: number(banner?.fps),
      isHdr: banner?.isHdr === true,
      bitDepth: number(banner?.bitDepth)
    };
    if (!declared) {
      return { ...fromBanner, displayWidth: null, displayHeight: null, disagreements: [] };
    }
    const fromContainer = {
      width: number(declared.width),
      height: number(declared.height),
      fps: number(declared.fps),
      isHdr: declared.isHdr === true,
      bitDepth: number(declared.bitDepth)
    };
    const disagreements = [];
    const note = (field, mine, theirs) => {
      if (mine !== null && theirs !== null && mine !== theirs) {
        disagreements.push(`${field} ${theirs} in the container against ${mine} in the probe`);
      }
    };
    note("width", fromBanner.width, fromContainer.width);
    note("height", fromBanner.height, fromContainer.height);
    if (fromBanner.bitDepth !== null && fromContainer.bitDepth !== null && fromBanner.bitDepth !== fromContainer.bitDepth) {
      disagreements.push(
        `bit depth ${fromContainer.bitDepth} in the container against ${fromBanner.bitDepth} in the probe`
      );
    }
    // HDR is deliberately NOT compared. Both sides give it as a boolean, and a
    // boolean cannot say "I did not look": a container with no Colour element
    // and one that states SDR are the same `false`, as are a probe that printed
    // no colour metadata and one that printed BT.709. Reporting that as a
    // disagreement would report it on almost every file. Either side saying yes
    // is taken as yes, which is the safe direction — the cost of tone mapping a
    // picture that did not need it is smaller than showing a washed-out one.
    return {
      width: fromBanner.width ?? fromContainer.width,
      height: fromBanner.height ?? fromContainer.height,
      fps: fromBanner.fps ?? fromContainer.fps,
      // The container declares these; the probe only reflects them.
      bitDepth: fromContainer.bitDepth ?? fromBanner.bitDepth,
      isHdr: fromContainer.isHdr || fromBanner.isHdr,
      displayWidth: number(declared.displayWidth),
      displayHeight: number(declared.displayHeight),
      disagreements
    };
  }

  /**
   * Line ffmpeg's banner up with what the container declares, and say whether the
   * two are describing the same thing in the same order.
   *
   * ffmpeg numbers a file's streams `0:a:N` / `0:s:N` over every stream of that
   * kind, in the order the container declares them; the container reading is a
   * list in that same order. So position is the correspondence — but a position
   * match that is merely assumed is worth nothing, and it is CHECKED: each pair
   * has to agree on language or on title. One pair that agrees on neither, or a
   * length that differs, means the two readings are not about the same thing, and
   * then the container reading is not used AT ALL. A wrong flag is worse than a
   * missing one, because `0:a:N` is what the encoder is given.
   *
   * One alignment for every media kind, because it is one rule. It was written
   * twice — once for subtitles, once for audio — down to a `pairingHolds` that
   * was byte-for-byte the same function under two names.
   *
   * @param {object[]} bannerTracks
   * @param {object[]} declared
   * @param {string} noun - "subtitle" or "audio"; only for the reason text.
   * @returns {{ aligned: boolean, reason: string, banner: object[], container: object[] }}
   */
  static alignWithBanner(bannerTracks, declared, noun) {
    const banner = Array.isArray(bannerTracks) ? bannerTracks : [];
    const container = Array.isArray(declared) ? declared : [];
    if (banner.length === 0) {
      return { aligned: false, reason: `the probe found no ${noun} stream`, banner, container };
    }
    if (container.length === 0) {
      return { aligned: false, reason: `the container declares no ${noun} track`, banner, container };
    }
    if (container.length !== banner.length) {
      return {
        aligned: false,
        reason: `the container declares ${container.length} ${noun} tracks and the probe found ${banner.length}`,
        banner,
        container
      };
    }
    for (const [order, track] of banner.entries()) {
      if (!Container.pairingHolds(track, container[order])) {
        return {
          aligned: false,
          reason:
            `${noun} ${order} is "${normalise(track?.title) || "-"}"/${normalise(track?.language) || "-"} ` +
            `in the probe and "${normalise(container[order]?.name) || "-"}"/` +
            `${normalise(container[order]?.language) || "-"} in the container`,
          banner,
          container
        };
      }
    }
    return { aligned: true, reason: "", banner, container };
  }

  /**
   * What the banner says, with the flags only the container knows added — or the
   * banner alone where the two could not be lined up.
   *
   * `take` says which of the container's fields this kind of track wants, and is
   * the only part that differs between them.
   *
   * @param {object[]} bannerTracks
   * @param {object[]} declared
   * @param {string} noun
   * @param {(containerTrack: object, bannerTrack: object) => object} take
   * @param {object} absent - The same fields as `take` returns, for a track whose
   *   container reading could not be used. Not "the container says no" — the
   *   container has not been heard from.
   * @returns {{ tracks: object[], aligned: boolean, reason: string }}
   */
  static mergeDeclaredFlags(bannerTracks, declared, noun, take, absent) {
    const { aligned, reason, banner, container } = Container.alignWithBanner(bannerTracks, declared, noun);
    if (!aligned) {
      return {
        tracks: banner.map((track) => ({ ...track, ...absent })),
        aligned,
        reason
      };
    }
    return {
      tracks: banner.map((track, order) => ({ ...track, ...take(container[order], track) })),
      aligned: true,
      reason: ""
    };
  }

  static mergeSubtitleFlags(bannerTracks, declared) {
    return Container.mergeDeclaredFlags(
      bannerTracks,
      declared,
      "subtitle",
      (track) => ({
        isDefault: track.isDefault === true,
        declaresDefault: track.declaresDefault === true,
        // Read from the file rather than guessed from the track's name. Both
        // are stated by the container itself (RFC 9559 §5.1.4.1) and neither
        // reaches ffmpeg's `-i` banner, which is where every other field here
        // comes from.
        isForced: track.isForced === true,
        isHearingImpaired: track.isHearingImpaired === true,
        // FlagEnabled, so the browser can leave an unusable track out of the
        // menu. It stays in the list and keeps its number: ffmpeg creates a
        // stream for it either way.
        isEnabled: track.isEnabled !== false,
        // The RFC 5646 tag where the file writes one, kept BESIDE the code
        // rather than replacing it: this list is aligned against ffmpeg's
        // banner, which prints the three-letter form.
        languageBcp47: typeof track.languageBcp47 === "string" ? track.languageBcp47 : ""
      }),
      {
        declaresDefault: false,
        isForced: false,
        isHearingImpaired: false,
        isEnabled: true,
        languageBcp47: ""
      }
    );
  }

  /**
   * The same for audio, with the flags RFC 9559 §5.1.4.1 defines for it.
   *
   * `FlagOriginal`, `FlagCommentary` and `FlagVisualImpaired` do not appear in
   * the banner at all, so without this the audio menu cannot tell a director's
   * commentary from the film.
   *
   * @param {object[]} bannerTracks
   * @param {object[]} declared
   * @returns {{ tracks: object[], aligned: boolean, reason: string }}
   */
  static mergeAudioFlags(bannerTracks, declared) {
    return Container.mergeDeclaredFlags(
      bannerTracks,
      declared,
      "audio",
      (track, banner) => ({
        isOriginal: track.isOriginal === true,
        isCommentary: track.isCommentary === true,
        isVisualImpaired: track.isVisualImpaired === true,
        isEnabled: track.isEnabled !== false,
        isDefault: track.isDefault === true,
        declaresDefault: track.declaresDefault === true,
        languageBcp47: typeof track.languageBcp47 === "string" ? track.languageBcp47 : "",
        channels: Number.isFinite(track.channels) ? track.channels : null,
        title:
          typeof banner?.title === "string" && banner.title.length > 0
            ? banner.title
            : (typeof track.name === "string" ? track.name : "")
      }),
      {
        declaresDefault: false,
        isOriginal: false,
        isCommentary: false,
        isVisualImpaired: false,
        isEnabled: true,
        languageBcp47: "",
        channels: null
      }
    );
  }


  /** @returns {string} Human name: "matroska" | "mp4" | "avi" | "unknown" */
  get formatName() {
    return "unknown";
  }

  /** Whether `head` (first bytes) looks like this container. */
  static detect(_head) {
    return false;
  }

  /**
   * All tracks declared by the container, in container order.
   * Includes disabled tracks (isEnabled=false) to preserve declaredIndex alignment with ffmpeg.
   * @returns {Promise<import("../tracks/index.js").ContainerTrack[]>}
   */
  async readTracks() {
    throw new Error("readTracks not implemented");
  }


  /**
   * This container's subtitle tracks and where their cues are, in ONE shape
   * whichever container answers.
   *
   * `tracks` carries a `clusterPositions` list for a container that stores cues
   * in clusters and a `samples` list for one that states each cue's own byte
   * range; a caller reads neither, and asks {@link Container#readHeldCues}
   * instead. `declared` is what the container says about its subtitle tracks in
   * its own order, and empty means the container said nothing — a real answer,
   * not a missing one.
   *
   * @returns {Promise<{ tracks: object[], declared: object[], secondsPerTick: number, segmentDataOffset: number } | null>}
   *   Null where this container declares no subtitles at all.
   */
  async readSubtitlePlan() {
    return null;
  }

  /**
   * The cues this container can read RIGHT NOW for one track, without fetching.
   *
   * Every container answers this, and each reads what its own specification
   * says: Matroska walks the clusters its Cues table names, an MP4 reads the
   * samples its table states. The caller therefore chooses a container once —
   * from the bytes — and never again. It used to choose twice, once by file
   * extension for the container and once by whether a track carried a sample
   * list for the reading, and two choices that must agree and are made from
   * different evidence are a disagreement waiting to happen.
   *
   * `progress` is what has already been read, kept by the caller because it
   * belongs to the file rather than to one pass: `walked` holds cluster
   * positions, `harvested` holds sample offsets per track. Each container adds
   * to the one it uses.
   *
   * @param {object} _plan - This file's subtitle plan.
   * @param {object} _track - The track asked about.
   * @param {{ walked: Set<number>, harvested: Map<number, Set<number>> }} _progress
   * @returns {Promise<{ found: Map<number, object[]>, covered: number, indexed: number }>}
   *   `found` is track number to the cues found in THIS pass — Matroska fills
   *   every track from one walk, so it is a map and not a list.
   */
  async readHeldCues(_plan, _track, _progress) {
    return { found: new Map(), covered: 0, indexed: 0 };
  }

  /**
   * Keyframe times for the video track, ascending seconds. Null when index
   * absent (MPEG-TS, fragmented MP4, truncated).
   *
   * Read ONCE per file, like the track table and the media info beside it: this
   * is a property of immutable bytes, so a second reading could only agree —
   * and the reading is not cheap, since the table lives at the end of the file
   * and comes off a torrent. The wait belongs here too: two sessions created in
   * the same moment join one read instead of making two, which is exactly what
   * two viewers opening one film do.
   *
   * The subclass says how its format states it; this says how often it is
   * asked.
   *
   * @returns {Promise<{times:number[],tolerance:number}|null>}
   */
  async readKeyframeIndex() {
    if (this.keyframeIndexRead) {
      return this.keyframeIndexRead;
    }
    this.keyframeIndexRead = Promise.resolve(this.parseKeyframeIndex()).catch((error) => {
      // A failed read is not remembered as an answer: the bytes it needed may
      // simply not have arrived yet.
      this.keyframeIndexRead = null;
      throw error;
    });
    return this.keyframeIndexRead;
  }

  /**
   * How THIS format states where its keyframes are. Overridden by every
   * container that has such a table; the default is the honest answer for one
   * that does not.
   *
   * @returns {Promise<{times:number[],tolerance:number}|null>}
   */
  async parseKeyframeIndex() {
    return null;
  }

  /**
   * What this file DECLARES about itself as a whole, as distinct from what its
   * individual tracks declare.
   *
   * The rule this method exists to hold: a fact the container declares is read
   * from the container; a fact only the media itself has is measured from the
   * media. Both halves used to be asked of ffmpeg, so the same header was read
   * twice — measured 2026-09-03, this layer read one `.mka` header in 8 ms while
   * a second ffmpeg read the same header over HTTP for 8121 ms, in the same
   * second, on the same file.
   *
   * `null` is not "unknown, ask someone else". It means the container does not
   * declare the field, which is a final answer about the container and the point
   * at which a caller may go to the media — see `docs/container-architecture.md`.
   *
   * @returns {Promise<import("./Container.js").ContainerMediaInfo>}
   */
  async readMediaInfo() {
    if (!this.mediaInfo) {
      this.mediaInfo = {
        format: this.formatName,
        durationSeconds: null,
        startTimeSeconds: null
      };
    }
    return this.mediaInfo;
  }

  /**
   * Subtitle-specific: where cues live (Matroska cluster positions or MP4 sample ranges).
   * Returned via track objects' clusterPositions/samples, so base has no extra method — tracks carry it.
   */

  /**
   * The TEXT FIELD of one subtitle cue, taken out of this container's framing.
   *
   * How a cue's bytes are wrapped is stated by the container's own
   * specification, so each subclass answers for itself: Matroska reorders an ASS
   * dialogue row, drops its two timing fields and prepends a read order
   * (`matroska.org/technical/subtitles.html`); an MP4 prefixes a `tx3g` sample
   * with its length (ISO/IEC 14496-12 §12.6); a subtitle FILE states its own
   * field order in `[Events]`. None of that is a fact about the subtitle format,
   * and the format's own markup — `{\pos(…)}`, `\N` — is not a fact about the
   * container. The second half is `TextSubtitleTrack`; this is the
   * first, and the two are applied in that order.
   *
   * Static because de-framing reads no instance state: a caller that has bytes
   * and knows the format needs no container built over the whole file. The
   * instance form below exists so a caller that DOES hold a container gets the
   * right answer without naming the subclass.
   *
   * @param {Buffer} _payload - The cue's bytes as the container stores them.
   * @param {string} _codecId - CodecID / sample entry type / file extension.
   * @returns {string} The text field, markup still in place.
   */
  static cueTextOf(_payload, _codecId) {
    throw new Error("cueTextOf not implemented");
  }

  /**
   * @param {Buffer} payload
   * @param {string} codecId
   * @returns {string}
   */
  cueTextOf(payload, codecId) {
    return /** @type {typeof Container} */ (this.constructor).cueTextOf(payload, codecId);
  }
}

// ---------------------------------------------------------------------------
// Lining ffmpeg's banner up with what a container declares. Here because the
// correction is about what a CONTAINER states and the banner cannot.
// ---------------------------------------------------------------------------
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
function pairingHolds(banner, container) {
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

