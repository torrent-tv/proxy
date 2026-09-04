/**
 * @file One file of one torrent, as this proxy reads it.
 *
 * Which torrent, which file inside it, what it is called, what a probe of it
 * said, and the address this proxy's own HTTP serves it at. Every one of those
 * is a fact about the FILE: it is the same for the picture and for every
 * quality step of it, the same for one viewer and for five, and it does not
 * change while anybody is watching.
 *
 * They used to be nine fields copied onto every session, and the copying was
 * visible in the code that read them back: twenty places in the session manager
 * assembled `${sourceKey}:${fileIndex}` by hand, through five different
 * spellings of the same two values, to key the caches that are keyed by a file —
 * the host timings, the download stats, the decode cost, the cut table. A file
 * that knows its own key removes all twenty.
 *
 * **What this is NOT.** It is not the container: a container answers for what
 * the format states about itself and needs bytes to do it. It is not the track:
 * a track is one stream inside a container. This is the file as a HANDLE — how
 * it is named, addressed and identified — plus the facts a probe of it
 * returned, which arrive together and are cheapest to keep where the handle is.
 *
 * Nothing here reaches outward, the address included: the proxy's own base URL
 * is passed in, because where this proxy listens is not a property of a film.
 */

/**
 * What decoding this source costs per second of it, and which measurement of
 * this host applies.
 *
 * The codec and bit depth travel with the rates because they decide WHICH
 * measurement applies: the model is fitted per codec family, and a video that
 * has to be re-encoded is by definition one the browser could not play — HEVC,
 * 10-bit — which is exactly where H.264 constants are wrong.
 *
 * @param {{ width: number | null, height: number | null, fps: number | null, bitrateKbps: number | null, codec?: string | null, bitDepth?: number | null } | null} mediaInfo
 * @returns {{ megapixelsPerSecond: number, megabitsPerSecond: number, codec: string, bitDepth: number | null } | null}
 */
export function sourceDecodeCharacteristics(mediaInfo) {
  const width = Number(mediaInfo?.width);
  const height = Number(mediaInfo?.height);
  const fps = Number(mediaInfo?.fps);
  const kbps = Number(mediaInfo?.bitrateKbps);
  if (!(width > 0) || !(height > 0) || !(fps > 0) || !(kbps > 0)) {
    return null;
  }
  const depth = Number(mediaInfo?.bitDepth);
  return {
    megapixelsPerSecond: (width * height * fps) / 1e6,
    megabitsPerSecond: kbps / 1000,
    codec: typeof mediaInfo?.codec === "string" ? mediaInfo.codec : "",
    bitDepth: Number.isFinite(depth) && depth > 0 ? depth : null
  };
}

export class SourceFile {
  /**
   * @param {object} params
   * @param {string} params.sourceKey - The registry's key for the torrent.
   * @param {number} params.fileIndex - Zero-based index of the file in it.
   * @param {string} [params.name] - The file's own name, for log lines.
   */
  constructor({ sourceKey, fileIndex, name = "" }) {
    this.sourceKey = String(sourceKey ?? "");
    this.fileIndex = Number.isFinite(fileIndex) ? Number(fileIndex) : 0;
    this.givenName = typeof name === "string" ? name.trim() : "";
    /**
     * What a probe of this file said. Null until one has answered — a cold
     * torrent has no header yet, and "not read" is not the same as "zero".
     *
     * @type {object | null}
     */
    this.media = null;
  }

  /**
   * The key every cache about this file is keyed by.
   *
   * @returns {string}
   */
  get key() {
    return `${this.sourceKey}:${this.fileIndex}`;
  }

  /**
   * What to call this file in a log line. A file with no name is named by its
   * index, so a line is never about a nameless thing.
   *
   * @returns {string}
   */
  get name() {
    return this.givenName.length > 0 ? this.givenName : `file#${this.fileIndex}`;
  }

  /**
   * Take in what a reading of this file returned.
   *
   * Readings are MERGED rather than replaced, because there is more than one
   * reader and they answer about different things: ffmpeg's banner states the
   * frame size, the frame rate and the bitrate, while the container's own
   * header states where its timeline begins — and a sidecar soundtrack is read
   * for that one field alone. Replacing would mean the second reader erasing
   * what the first found.
   *
   * Called again whenever a fresher reading arrives: on a cold torrent the
   * first answer can be missing the duration, and the second is what has it.
   *
   * @param {object | null} mediaInfo
   * @returns {this}
   */
  learn(mediaInfo) {
    if (mediaInfo && typeof mediaInfo === "object") {
      this.media = { ...(this.media ?? {}), ...mediaInfo };
    }
    return this;
  }

  /** @returns {number | null} */
  get width() {
    const value = Number(this.media?.width);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** @returns {number | null} */
  get height() {
    const value = Number(this.media?.height);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** @returns {number | null} */
  get fps() {
    const value = Number(this.media?.fps);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** @returns {boolean} */
  get isHdr() {
    return this.media?.isHdr === true;
  }

  /**
   * Where this file's own timeline begins. Zero when nothing said otherwise —
   * which is what a container that states no start time means.
   *
   * @returns {number}
   */
  get startTime() {
    const value = Number(this.media?.startTime);
    return Number.isFinite(value) ? value : 0;
  }

  /** @returns {number | null} */
  get durationSeconds() {
    const value = Number(this.media?.durationSeconds);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** @returns {boolean} */
  get hasDuration() {
    return this.durationSeconds !== null;
  }

  /**
   * How many streams of each kind ffmpeg's own banner said this file carries.
   * The one place the file says what it has, and what tells a failed run whose
   * fault it was: an audio index past the end of the list is ours, no streams
   * at all is the file's.
   *
   * @returns {object | null}
   */
  get streamCounts() {
    return this.media?.streamCounts ?? null;
  }

  /**
   * Where this file's picture has its keyframes, in seconds, or null while
   * nobody has read them.
   *
   * A fact of the file in both container formats and by their own
   * specifications: Matroska's Cues name the track each entry belongs to, and
   * MP4 keeps the sync-sample table inside the track. It used to live on the
   * cut table, which is held per file AND grid — so a file cut two ways kept
   * two copies of one immutable list, and the table's own header said it
   * belonged to "the file and its grid", which is two things.
   *
   * @returns {number[] | null}
   */
  get keyframeTimes() {
    return Array.isArray(this.media?.keyframeTimes) ? this.media.keyframeTimes : null;
  }

  /**
   * How far a time in that table may be from the true keyframe. Zero means the
   * table is exact, which is what a Cues element or a sync-sample table gives.
   *
   * @returns {number}
   */
  get keyframeTolerance() {
    const value = Number(this.media?.keyframeTolerance);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * Which container answered about this file, so a log line can say what was
   * read rather than what was guessed from the name.
   *
   * @returns {string}
   */
  get containerFormat() {
    return typeof this.media?.containerFormat === "string" ? this.media.containerFormat : "";
  }

  /**
   * What decoding this file costs per second, or null while its facts are
   * incomplete.
   *
   * @returns {{ megapixelsPerSecond: number, megabitsPerSecond: number, codec: string, bitDepth: number | null } | null}
   */
  get decode() {
    return sourceDecodeCharacteristics(this.media);
  }

  /**
   * The address this proxy's own HTTP serves this file at.
   *
   * The base URL is a parameter because where this proxy listens is not a
   * property of a film. `session` travels with it so the stream route can count
   * the bytes it delivers against a session — that count is what tells a
   * waiting browser the proxy is alive while nothing has been encoded yet,
   * since the encoder's own progress cannot move before its first frame is
   * decoded.
   *
   * @param {string} baseUrl - This proxy's own base, e.g. `http://127.0.0.1:9090`.
   * @param {{ sessionId?: string }} [options]
   * @returns {URL}
   */
  streamUrl(baseUrl, { sessionId = "" } = {}) {
    const url = new URL("/stream", `${baseUrl}/`);
    url.searchParams.set("sourceKey", this.sourceKey);
    if (sessionId.length > 0) {
      url.searchParams.set("session", sessionId);
    }
    url.searchParams.set("fileIndex", String(this.fileIndex));
    return url;
  }
}

/**
 * The source files this proxy holds, one per file.
 *
 * Keyed by the torrent and the index inside it, which is the only pair that
 * identifies a file — and the same key every cache about a file already used,
 * spelled once here instead of at twenty call sites.
 */
export class SourceFiles {
  /** @type {Map<string, SourceFile>} */
  #byKey = new Map();

  /**
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {string}
   */
  static keyFor(sourceKey, fileIndex) {
    return `${sourceKey}:${fileIndex}`;
  }

  /**
   * The file with this key, made if it is not held yet.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {string} [name]
   * @returns {SourceFile}
   */
  get(sourceKey, fileIndex, name = "") {
    const key = SourceFiles.keyFor(sourceKey, fileIndex);
    let file = this.#byKey.get(key);
    if (!file) {
      file = new SourceFile({ sourceKey, fileIndex, name });
      this.#byKey.set(key, file);
    } else if (name.length > 0 && file.givenName.length === 0) {
      // A name learned later is still this file's name. The first caller is
      // sometimes a route that has an index and no name.
      file.givenName = name.trim();
    }
    return file;
  }

  /**
   * @param {string} key
   * @returns {SourceFile | null}
   */
  peek(key) {
    return this.#byKey.get(key) ?? null;
  }

  /**
   * Drop every file nobody names any more.
   *
   * A file holds a handle and one probe result — a few dozen numbers — so it is
   * kept for as long as anything refers to it and dropped in one sweep rather
   * than reference-counted. What must NOT happen is dropping one while a
   * session still points at it: the facts would be read again, and a cold
   * torrent would answer differently the second time.
   *
   * Held by the OBJECT rather than by its key, the same way the timelines and
   * the outputs are swept: what must survive is what a live session points at,
   * and that is a reference, not a string that happens to match one.
   *
   * @param {Set<SourceFile>} filesInUse
   * @returns {number} How many were dropped.
   */
  forgetUnused(filesInUse) {
    let dropped = 0;
    for (const [key, file] of [...this.#byKey.entries()]) {
      if (!filesInUse.has(file)) {
        this.#byKey.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** @returns {number} */
  get size() {
    return this.#byKey.size;
  }
}
