/**
 * @file Subtitle orchestrator — the track list and the cues, behind the
 * Container/Track abstraction.
 *
 * Provides per-file track list and cue streaming, with the same "only already
 * downloaded clusters" rule as before. Controllers (HTTP or data-channel)
 * depend on this, not on the worker module directly. Delegates to
 * `ContainerOrchestrator` for track enumeration so subtitle tracks and their
 * flags come from the unified `ContainerTrack` hierarchy.
 *
 * **The cue reading is HANDED IN, not imported, and that is the layer boundary.**
 * Which clusters may be read, where the cursor stands and what one walk at a
 * time means are the TORRENT's rules, and they live in
 * `torrent-worker/subtitle-cues.js`. This file used to import them, so the media
 * layer named the torrent's worker — the one direction the layers may not go.
 * Now the wiring puts the two together (`server/controllers/SubtitleController.js`) and
 * this can be exercised with four plain functions.
 */

import { logger } from "../../utils/logger.js";
import { createHash } from "node:crypto";
import { SubtitleFileContainer } from "./container/SubtitleFileContainer.js";
import { TextSubtitleTrack } from "./tracks/TextSubtitleTrack.js";
import { detectLanguage } from "./tracks/language-detect.js";
import { strictReader, isUnavailable } from "./container/unavailable.js";

export class SubtitleOrchestrator {
  #documents = new Map();
  #documentListeners = new Map();
  #packetCues = new Map();

  /** Decode only the indexed subtitle packets whose bytes are already held. */
  async inspectPackets(params) {
    const statement = "subtitle-cues";
    const revision = params.onReadStart?.(statement);
    const requestId = params.requestId;
    let result;
    try {
      const container = await this.containers.containerFor(params);
      const track = (await container.readTracks()).find(track => track.type === "subtitle" && track.declaredIndex === params.subtitleTrackIndex);
      if (track?.isTextBased?.() !== true) throw new Error("The selected subtitle track is not supported.");
      const packetResult = typeof this.containers.inspect === "function"
        ? await this.containers.inspect({ ...params, onReadStart: undefined, onReadResult: undefined,
          onNeedsRanges: undefined, onTracks: undefined }, "packets")
        : { kind: "result", value: await container.readPacketIndex(params.packetInterval) };
      const input = packetResult.kind === "result"
        ? packetResult.value.inputFor({ trackId: track.trackNumber, ...params.packetInterval }) : packetResult;
      if (input.kind !== "result") result = { ...input, requestId };
      else {
        const key = `${params.sourceKey}:${params.fileIndex}:${track.trackNumber}`;
        let state = this.#packetCues.get(key);
        if (!state) {
          this.#packetCues.set(key, state = { track, packets: new Map(), cursor: 0, ready: false });
          state.seed = Promise.resolve().then(async () => {
            const existing = await this.cues.held?.(null, params.fileIndex, params.sourceKey, track.trackNumber);
            state.cursor = (existing?.cues ?? []).reduce((highest, cue) => Math.max(highest, Number(cue.seq) || 0), 0);
          }).catch(error => {
            if (this.#packetCues.get(key) === state) this.#packetCues.delete(key);
            throw error;
          });
        }
        await state.seed;
        const read = strictReader(params.readRange, params.fileSize);
        const pending = [];
        for (const packet of input.packets) {
          const identity = JSON.stringify([packet.ranges, packet.pts, packet.duration]);
          if (state.packets.has(identity)) continue;
          const portions = [];
          for (const [from, to] of packet.ranges) portions.push(await read(from, to));
          const bytes = Buffer.concat(portions);
          if (packet.expectedHash && createHash("sha256").update(bytes).digest("hex") !== packet.expectedHash) {
            throw new Error("Subtitle packet bytes do not match the declared source addresses.");
          }
          const text = container.cueTextOf(bytes, track.codecId);
          const cue = { startSeconds: packet.pts,
            endSeconds: packet.duration > 0 ? packet.pts + packet.duration : null, text };
          pending.push({ identity, cue });
        }
        if (params.isCurrent?.() === false || this.#packetCues.get(key) !== state) {
          return { kind: "terminal", reason: "request-obsolete", requestId };
        }
        state.ready = true;
        const ordered = () => [...state.packets.values()].sort((first, second) => first.startSeconds - second.startSeconds);
        const previous = new Map(TextSubtitleTrack.finalizeCues(ordered(), track.codecId).map(cue => [cue.seq, cue]));
        pending.filter(({ identity }) => !state.packets.has(identity)).forEach(({ identity, cue }) => {
          const complete = { ...cue, seq: ++state.cursor };
          state.packets.set(identity, complete);
        });
        const withdrawn = [];
        for (const cue of TextSubtitleTrack.finalizeCues(ordered(), track.codecId)) {
          const old = previous.get(cue.seq);
          if (old && old.endSeconds !== cue.endSeconds) {
            withdrawn.push(cue.seq);
            const raw = [...state.packets.values()].find(packet => packet.seq === cue.seq);
            raw.seq = ++state.cursor;
          }
        }
        const fresh = TextSubtitleTrack.finalizeCues(ordered(), track.codecId).filter(cue => !previous.has(cue.seq));
        if (fresh.length && params.isCurrent?.() !== false) {
          const cues = fresh;
          this.cues.publish?.({ sourceKey: params.sourceKey, fileIndex: params.fileIndex,
            trackIndex: track.declaredIndex, cues, withdrawn, language: track.language ?? "",
            detectedLanguage: detectLanguage(TextSubtitleTrack.finalizeCues([...state.packets.values()], track.codecId).map(cue => cue.text).join("\n")),
            cursor: state.cursor, spanStartSeconds: cues[0]?.startSeconds ?? null,
            spanEndSeconds: cues.at(-1)?.endSeconds ?? null, walkedClusters: 0, indexedClusters: 0 });
        }
        result = { kind: "result", value: { cues: [...state.packets.values()], track, coveredClusters: 0, indexedClusters: 0 }, requestId };
      }
    } catch (error) {
      result = isUnavailable(error)
        ? { kind: "needs-ranges", ranges: [[error.start, error.end]], requestId }
        : { kind: "terminal", reason: "subtitle-cue-read-failed", message: error?.message ?? String(error), requestId };
    }
    await params.onReadResult?.(statement, result, revision);
    return result;
  }

  /** Read a text document through the same missing-byte declarations as media. */
  async inspectFile(params) {
    const statement = "subtitle-file";
    const revision = params.onReadStart?.(statement);
    const key = `${params.sourceKey}:${params.fileIndex}`;
    const requestId = params.requestId ?? key;
    let result = this.#documents.get(key);
    if (result) result = { ...result, requestId };
    else {
      try {
        const extension = String(params.label ?? "").slice(String(params.label ?? "").lastIndexOf(".")).toLowerCase();
        if (![".srt", ".ass", ".ssa", ".vtt", ".webvtt"].includes(extension)) {
          result = { kind: "terminal", reason: "subtitle-format-not-supported", requestId };
        } else if (!Number.isSafeInteger(params.fileSize) || params.fileSize < 0 || params.fileSize > 8 * 1024 * 1024) {
          result = { kind: "terminal", reason: "subtitle-size-not-supported", requestId };
        } else {
          const bytes = await strictReader(params.readRange, params.fileSize)(0, params.fileSize - 1);
          const value = this.fileAsVtt(bytes, extension);
          result = value ? { kind: "result", value, requestId }
            : { kind: "terminal", reason: "subtitle-document-invalid", requestId };
        }
      } catch (error) {
        result = isUnavailable(error)
          ? { kind: "needs-ranges", ranges: [[error.start, error.end]], requestId }
          : { kind: "terminal", reason: "subtitle-read-failed", message: error?.message ?? String(error), requestId };
      }
      if (params.isCurrent?.() === false) return { kind: "terminal", reason: "request-obsolete", requestId };
      if (result.kind !== "needs-ranges") {
        this.#documents.set(key, result);
        for (const listener of [...(this.#documentListeners.get(key) ?? [])]) listener();
      }
    }
    await params.onReadResult?.(statement, result, revision);
    return result;
  }

  documentFor(sourceKey, fileIndex) {
    return this.#documents.get(`${sourceKey}:${fileIndex}`) ?? null;
  }

  hasPacketCues(sourceKey, fileIndex, declaredIndex) {
    const prefix = `${sourceKey}:${fileIndex}:`;
    return [...this.#packetCues].some(([key, state]) => key.startsWith(prefix) && state.track.declaredIndex === declaredIndex);
  }

  hasTrackDeclaration(sourceKey, fileIndex) {
    return this.containers.tracks?.has(`${sourceKey}:${fileIndex}`) === true;
  }

  /** Subscribe before checking, so publication cannot be missed. */
  waitForDocument(sourceKey, fileIndex, signal) {
    const key = `${sourceKey}:${fileIndex}`;
    return new Promise((resolve, reject) => {
      let listeners = this.#documentListeners.get(key);
      if (!listeners) this.#documentListeners.set(key, listeners = new Set());
      const cleanup = () => {
        listeners.delete(check);
        if (!listeners.size) this.#documentListeners.delete(key);
        signal?.removeEventListener("abort", cancelled);
      };
      const cancelled = () => {
        cleanup();
        reject(signal?.reason ?? new DOMException("Subtitle request cancelled.", "AbortError"));
      };
      const check = () => {
        const result = this.#documents.get(key);
        if (!result) return;
        cleanup();
        resolve(result);
      };
      listeners.add(check);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled(); else check();
    });
  }
  /**
   * @param {import("./ContainerOrchestrator.js").ContainerOrchestrator} containerOrchestrator
   * @param {object} [cues] - How the torrent reads subtitle cues: `warm`,
   *   `tracksOf`, `declaredTracksOf`, `forget`. Absent, this answers from the
   *   containers alone, which is what a proxy with no torrent behind it can do.
   */
  constructor(containerOrchestrator, cues = {}) {
    this.containers = containerOrchestrator;
    this.cues = cues ?? {};
  }

  /**
   * Tracks for menu — text tracks via domain, enriched with ContainerTrack flags.
   * Falls back to container tracks when domain has no plan yet.
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {(start:number,end:number)=>Promise<Buffer|null>} [readRange]
   * @param {number} [fileSize]
   * @returns {Promise<import("./tracks/index.js").ContainerTrack[]>}
   */
  async getTracks(torrent, fileIndex, sourceKey, readRange, fileSize) {
    const known = this.containers.tracks?.get(`${sourceKey}:${fileIndex}`);
    if (Array.isArray(known)) return known.filter(track => track.type === "subtitle");
    try {
      const domain = await this.cues.tracksOf?.(torrent, fileIndex, sourceKey);
      if (Array.isArray(domain) && domain.length > 0) return domain;
    } catch {}
    if (readRange && Number.isFinite(fileSize)) {
      try {
        const tracks = await this.containers.getTracks({ sourceKey, fileIndex, readRange, fileSize, label: torrent?.files?.[fileIndex]?.name ?? "" });
        return tracks.filter((t) => t.type === "subtitle");
      } catch {}
    }
    return [];
  }

  /**
   * Declared subtitle tracks in container order (including image tracks) — for declaredIndex alignment.
   */
  async getDeclaredTracks(torrent, fileIndex, sourceKey) {
    const known = this.containers.tracks?.get(`${sourceKey}:${fileIndex}`);
    if (Array.isArray(known)) return known.filter(track => track.type === "subtitle");
    try {
      return (await this.cues.declaredTracksOf?.(torrent, fileIndex, sourceKey)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The cues a file already holds for one track.
   *
   * The PULL path: a browser asking `/api/subtitles` rather than being pushed
   * to. It runs the same walk as the push, on this thread — it used to be sent
   * to the torrent thread as a command, and when that command went the guard
   * here answered an EMPTY document instead of failing, which is
   * indistinguishable from a file that genuinely holds no cues. That is the one
   * failure this whole path is written to avoid, so an absent walk says so.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {number} trackNumber
   * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
   */
  async getCues(torrent, fileIndex, sourceKey, trackNumber) {
    const packets = this.#packetCues.get(`${sourceKey}:${fileIndex}:${trackNumber}`);
    if (packets) return packets.ready
      ? { cues: [...packets.packets.values()].sort((first, second) => first.startSeconds - second.startSeconds),
        track: packets.track, coveredClusters: 0, indexedClusters: 0 } : null;
    if (typeof this.cues.held !== "function") {
      logger.warn(
        "subtitle-orchestrator: no walk was supplied, so no cue can be read — " +
        "an empty document here would be indistinguishable from a file with none"
      );
      return null;
    }
    try {
      const answer = await this.cues.held(torrent, fileIndex, sourceKey, trackNumber);
      return answer?.track ? answer : null;
    } catch (e) {
      logger.warn(`subtitle-orchestrator: getCues failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Warm all subtitle tracks of a file — called periodically and on verified pieces.
   * Returns per-track fresh cues for push.
   */
  async warm(torrent, fileIndex, sourceKey) {
    try {
      return (await this.cues.warm?.(torrent, fileIndex, sourceKey)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * A subtitle FILE as WebVTT, and the language its words are in.
   *
   * The language is read from the CONVERTED document, not from the file. The
   * conversion has already dropped everything that is not the words — and on
   * an ASS file that is half of it, in Latin letters, which is what made a
   * Russian track answer `en` (field 2026-09-01,
   * `research/subtitle-language-ass-markup-2026-09-01.md`).
   *
   * @param {Buffer} bytes
   * @param {string} extension - With its dot, lower case.
   * @returns {{ vtt: string, language: string | null } | null} Null for a
   *   format this cannot convert.
   */
  fileAsVtt(bytes, extension) {
    const text = SubtitleFileContainer.decodeBytes(bytes);
    const vtt = SubtitleFileContainer.toVtt(text, extension);
    if (!vtt) {
      return null;
    }
    return { vtt, language: TextSubtitleTrack.detectLanguageFromVtt(vtt) };
  }

  /**
   * Cues held for an embedded track as WebVTT, and the language of the track.
   *
   * Two things this reads, and each of them was wrong before 2.68.1. It reads
   * the cues through `finalizeCues`, so what reaches the detector is the words
   * and not ASS's `{\…}` override groups, which are Latin on a Russian track.
   * And it reads EVERY cue held so far, not the subset being sent: a
   * re-subscription after a reconnect asks only for what the page missed,
   * which can be three lines, and three lines are not a sample of a language.
   *
   * @param {object[]} sending - The cues this answer carries.
   * @param {object[]} held - Every cue held for the track so far.
   * @param {string} codecId
   * @returns {{ vtt: string, language: string | null }}
   */
  cuesAsVtt(sending, held, codecId) {
    return {
      vtt: TextSubtitleTrack.cuesToVtt(sending, codecId),
      language: detectLanguage(TextSubtitleTrack.finalizeCues(held, codecId).map((cue) => cue.text).join("\n"))
    };
  }

  forget(sourceKey, fileIndex) {
    const prefix = fileIndex === undefined ? `${sourceKey}:` : `${sourceKey}:${fileIndex}:`;
    for (const key of this.#packetCues.keys()) if (key.startsWith(prefix)) this.#packetCues.delete(key);
    for (const key of this.#documents.keys()) {
      if (fileIndex === undefined ? key.startsWith(`${sourceKey}:`) : key === `${sourceKey}:${fileIndex}`) this.#documents.delete(key);
    }
    for (const [key, listeners] of [...this.#documentListeners]) {
      if (fileIndex === undefined ? key.startsWith(`${sourceKey}:`) : key === `${sourceKey}:${fileIndex}`) {
        this.#documents.set(key, { kind: "terminal", reason: "source-forgotten" });
        for (const listener of [...listeners]) listener();
        this.#documents.delete(key);
      }
    }
    this.cues.forget?.(sourceKey, fileIndex);
    this.containers.forget(sourceKey, fileIndex);
  }
}
