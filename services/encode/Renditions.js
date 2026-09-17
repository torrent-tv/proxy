/**
 * The steps of a picture and its soundtracks.
 *
 * A step is an output of the same picture at another size, a soundtrack an
 * output of one audio track; each is made the first time it is asked for, and an
 * output already producing the same thing answers instead. The master playlist
 * lists them. Which viewer is on which is the viewer's fact, stated here and
 * read back through the host.
 */

import { isOutputName } from "./output/index.js";
import { masterPlaylistText } from "./output/playlists.js";
import { PLAYLIST_FILE_NAME } from "./run-command.js";
import { variantHeightsFor } from "./output/ladder.js";
import { encoderInputs } from "./run-inputs.js";
/**
 * How a base files the audio renditions it has made.
 *
 * By the track AND by how it is produced, because those are two different
 * encodes of it: a browser that can decode the track as it stands is served a
 * copy, and one that cannot is served AAC. Two viewers of one picture can
 * legitimately need both.
 *
 * @param {number} trackIndex
 * @param {boolean} transcode
 * @returns {string}
 */
export function audioRenditionKey(trackIndex, transcode) {
  return `${Number(trackIndex) || 0}:${transcode === true ? "aac" : "copy"}`;
}

/**
 * The consumer a base session registers on its variants.
 *
 * Derived from the base's id so it is stable across requests and unique per
 * family: releasing it is how a base lets go of a variant that another family
 * may still be watching.
 *
 * @param {string} baseSessionId
 * @returns {string}
 */
export function variantConsumerId(baseSessionId) {
  return `variant-of:${baseSessionId}`;
}

/**
 * Whether this name belongs to a person or to the family bookkeeping.
 *
 * An output made on behalf of a picture — a quality step, a soundtrack — is
 * created under a made-up name so that the picture ending can let it go. That
 * name is not somebody watching, and it must not enter the viewer registry: a
 * viewer is placed the moment they arrive and counts as present until something
 * says otherwise, so a made-up one would keep its output producing for ever.
 *
 * @param {string} consumerId
 * @returns {boolean}
 */
export function isFamilyConsumerId(consumerId) {
  return typeof consumerId === "string" && consumerId.startsWith("variant-of:");
}

export class Renditions {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `viewerSecondsOn`, `audioStartSecondsFor`, `activeOutputFor`, `viewersOf`, `audioRenditionName`, `logger`, `placeViewer`, `viewerLeaves`, `createOrGetSession`, `planEncodersSoon`, `releaseSessionConsumer`, `viewerPositionOf`, `encodeRuns`, `fileStartTimeReads`, `getCachedAudioTracks`, `getCachedMediaInfo`, `getContainerMediaInfo`, `localBaseUrl`, `outputTimes`, `outputs`, `quality`, `qualityOffer`, `segmentDurationSec`, `sourceFiles`, `viewers`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * The session that produces a given height for the same file, created on
   * first request.
   *
   * A variant IS a session — same source, same file, a different encode — so
   * this makes one rather than inventing a parallel object. It is created only
   * when its playlist is actually asked for, which is what keeps a weak host
   * running one encoder: with the player's own bitrate adaptation off, no
   * variant is ever requested unless the viewer picked it.
   *
   * @param {string} baseSessionId
   * @param {number} height - Encode height; must be one of the offered rungs.
   * @returns {Promise<HlsSession | null>} Null when the base session is unknown,
   *   or the height is not offered for it.
   */
  async resolveVariantSession(baseSessionId, height, wantedIndex = -1, consumerId = "") {
    if (!isOutputName(baseSessionId)) {
      return null;
    }
    const base = this.#host.outputs.get(baseSessionId);
    if (!base) {
      return null;
    }
    if (!Number.isInteger(height) || height <= 0) {
      return null;
    }
    // Only the heights the master offers. Anything else is a made-up request,
    // and honouring it would let a client start encoder runs at will. The
    // MASTER's list, not the live one: a rung is published for the session's
    // whole life, and refusing what we published is how a quality switch became
    // a 404 storm across every level.
    if (!this.#host.outputs.splicableHeights(base).includes(height)) {
      return null;
    }
    if (height === this.#host.outputs.variantHeightOf(base)) {
      return base;
    }
    // What this height was answered with before, if it has been asked. Kept as
    // a height and not as a session id: the answer must not move — a player
    // holding an init for one size cannot be sent another — and a number cannot
    // go stale, so nothing has to be cleaned from the other side when a session
    // ends.
    const answeredWith = base.file.stepHeights.get(height);
    if (answeredWith) {
      const serving = this.#host.outputs.stepsOf(base).find((other) => this.#host.outputs.producedHeightOf(other) === answeredWith);
      const existing = this.#host.outputs.producedHeightOf(base) === answeredWith ? base : serving;
      if (existing) {
        this.#host.outputs.touch(existing);
        return existing;
      }
    }
    // hls.js asks for a new level's playlist, its init and its first segments
    // within the same moment. Without this every one of them would build its
    // own session, and the ones that lost would encode for nobody.
    base.variantPending ??= new Map();
    const pending = base.variantPending.get(height);
    if (pending) {
      return pending;
    }
    const creation = this.#host.createOrGetSession({
      sourceKey: base.file.sourceKey,
      fileIndex: base.file.fileIndex,
      transcodeVideo: true,
      transcodeAudio: base.spec.transcodesAudio,
      fileName: base.file.name,
      // The family's own claim on it. Sessions are already shared between
      // consumers and disposed when the last one leaves, and a variant is
      // shareable in exactly the same way — two viewers on the same rung of the
      // same file are one encode. This is how the base lets go of it.
      consumerId: variantConsumerId(base.id),
      targetWidth: 0,
      targetHeight: height,
      // Where this variant must begin. The segment the player asked it for when
      // it can be known — that is the player stating outright where it will
      // start fetching, and it is the only figure that cannot be stale.
      //
      // The other rung's read head is NOT that figure, and using it cost a
      // stuck session on 2026-08-11: a 240p rung encoding at 5-6x had read 56 s
      // further than the picture had played, so switching back to 400p placed
      // that run at 3084 s while the player needed 3028 s, and no segment it
      // wanted was ever produced.
      //
      // Floored onto the ten-second grid that session keys are bucketed to:
      // rounding is what that bucket does, and a position rounded UP starts the
      // run past the viewer, so the run just spawned is killed and restarted
      // before it has produced anything.
      startPositionSeconds: Math.floor(this.#variantStartSeconds(base, wantedIndex, consumerId) / 10) * 10,
      audioTrackIndex: this.#flatAudioTrackOf(base),
      // A rung is produced at exactly the size it names and the realtime budget
      // does not move it — otherwise two rungs could drift onto the same height
      // and the choice between them would mean nothing. True of EVERY rung,
      // including one the player moved itself onto.
      exactSize: true,
      // Whose request this is decides whether an output already here may serve
      // it: a size picked by hand is served exactly, the automatic choice by the
      // quality rules. A viewer whose page does not say is taken as picking.
      servingMode: this.#host.viewersOf(base).get(consumerId)?.qualityMode ?? "manual",
      viewerLinkMbps: this.#host.viewersOf(base).get(consumerId)?.netReport?.linkMbps ?? null,
      // A rung of a session whose audio is published separately carries no
      // audio either — every rung of one master must agree about that, or
      // switching rung would start or stop a second copy of the same track.
      audioRenditions: this.servesAudioSeparately(base),
      // Not re-decided here: asked on its own, a variant would answer about the
      // rungs IT would be offered at — a 540p rung of a copied 1080p source is
      // offered nothing but itself, so it would conclude "audio muxed" and
      // start carrying a second copy of a track the player is already fetching
      // from the rendition.
      inheritedAudioSeparate: this.servesAudioSeparately(base),
      segmentFormatId: base.segmentFormat?.id ?? "",
      // Cut where the base is cut. Only for a base on the source's own keyframe
      // grid — a copy — where the variant has to land on those exact times to
      // be interchangeable with it. A base on the uniform grid needs nothing
      // passed: the variant computes the same even grid from the same duration.
      inheritedGrid: base.timeline.cutGrid === "keyframe"
        ? {
            // The table as it stands NOW, corrections included — not the index
            // it was first built from. This is what the new session CUTS at.
            boundaries: base.timeline.boundaries,
            // And this is what it must SAY, which is not the same thing: every
            // member of a family has to publish one timeline, or two sessions
            // stamp the same moment differently and the picture and the sound
            // drift apart by exactly the corrections made between their two
            // creations (field 2026-08-17, corrections of 0.6-2.9 s).
            published: base.timeline.published
          }
        : null
    })
      .then(async (variant) => {
        // Making a session takes seconds — a probe and a keyframe index — and
        // the viewer can leave inside that window. A variant registered onto a
        // disposed base is reachable by nobody: the browser never learns its
        // id, so nothing would release it and it would hold an encoder, a temp
        // directory and a claim on the torrent until its own idle timer noticed
        // half an hour later.
        if (!this.#host.encodeRuns.isLive(base)) {
          await this.#host.releaseSessionConsumer(
            variant.id,
            variantConsumerId(base.id),
            "the session it was made for ended while it was being made"
          );
          return null;
        }
        // Served by the picture itself, which does not become a step.
        if (variant === base) {
          return base;
        }
        const incumbent = await this.#adoptIfAlreadyProduced(base, height, variant);
        if (incumbent) {
          base.file.stepHeights.set(height, this.#host.outputs.producedHeightOf(incumbent));
          return incumbent;
        }
        // A step at its own height. A stand-in of another height chosen for this
        // viewer is not remembered as the answer for the height asked for.
        const produced = this.#host.outputs.producedHeightOf(variant);
        variant.variantHeight ??= produced > 0 ? produced : height;
        // How it came to be: a step of a picture, not a picture a browser
        // opened. Read where a step needs the facts of the file rather than of
        // its own encode.
        variant.isStep = true;
        if (produced === height) {
          base.file.stepHeights.set(height, produced);
        }
        return variant;
      })
      .finally(() => {
        base.variantPending.delete(height);
      });
    base.variantPending.set(height, creation);
    return creation;
  }

  /**
   * A session of this family already making exactly this picture, if there is
   * one — so that a second request for it does not start a second encoder.
   *
   * WHY IT COMPARES THE HEIGHT PRODUCED. An output is named by its whole
   * format, and a rung produced exactly at a height can still differ from one
   * already running at that height by its speed setting or its encoder. For
   * the viewer those two are the same picture, so the one already producing it
   * is used rather than a second encoder beside it. It was written when a
   * manual pick was clamped below the height named, which put three encoders on
   * one identical picture on 2026-08-28
   * (`research/session-pileup-variant-key-2026-08-28.md`); the clamp is gone,
   * and choosing an existing output by quality replaces this comparison.
   *
   * @param {HlsSession} base
   * @param {number} askedHeight
   * @param {HlsSession} candidate - The session just created for `askedHeight`.
   * @returns {Promise<HlsSession | null>} The incumbent to use instead, or null
   *   to keep the one just made.
   */
  async #adoptIfAlreadyProduced(base, askedHeight, candidate) {
    const produced = this.#host.outputs.producedHeightOf(candidate);
    if (produced <= 0) {
      return null;
    }
    const seen = new Set([candidate.id]);
    // The base belongs in this scan: it is a rung like any other, and when it
    // is itself a re-encode the clamp can land a variant right on top of it.
    for (const other of [base, ...this.#host.outputs.stepsOf(base)]) {
      if (!other || seen.has(other.id)) {
        continue;
      }
      seen.add(other.id);
      if (this.#host.outputs.producedHeightOf(other) !== produced) {
        continue;
      }
      // Same picture, already being made. Let go of the one just created; the
      // incumbent already carries this family's claim, because both were made
      // with the same consumer id.
      await this.#host.releaseSessionConsumer(
        candidate.id,
        variantConsumerId(base.id),
        `${produced}p is already being produced by ${other.id.slice(0, 8)}`
      );
      this.#host.logger.info(
        `transcode ${base.id.slice(0, 8)} the ${askedHeight}p rung encodes at ${produced}p on this ` +
          `machine, which ${other.id.slice(0, 8)} is already producing — serving it from there ` +
          `instead of starting a second encoder "${base.file.name}"`
      );
      return other;
    }
    return null;
  }

  /**
   * Resolve one file request addressed to a variant: `v/<height>/<fileName>`
   * under a session.
   *
   * The single entry point for the variant route, so the policy — which variant
   * exists, which one the viewer is watching, which encoder runs — stays here
   * rather than being spread into a route handler.
   *
   * @param {string} baseSessionId
   * @param {number} height
   * @param {string} fileName
   * @param {string} [consumerId] - Which viewer is asking. One picture is shared
   *   by everyone watching it, and the quality each of them chose is their own.
   * @returns {Promise<{ sessionId: string | null, error?: string }>} The session
   *   to serve the file from; a null id means there is no such variant.
   */
  async resolveVariantFile(baseSessionId, height, fileName, consumerId = "") {
    if (!isOutputName(baseSessionId)) {
      return { sessionId: null };
    }
    const base = this.#host.outputs.get(baseSessionId);
    if (!base) {
      return { sessionId: null };
    }
    // A variant carries a media playlist, an init segment and segments. Nothing
    // else lives under that path — a master there would describe variants of a
    // variant.
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    const isInit = base.segmentFormat.initFileName !== null &&
      fileName === base.segmentFormat.initFileName;
    const isSegment = base.segmentFormat.isSegmentFileName(fileName);
    if (!isPlaylist && !isInit && !isSegment) {
      return { sessionId: null };
    }
    if (!this.#host.outputs.splicableHeights(base).includes(height)) {
      return { sessionId: null };
    }
    // Answered from the base, and no encoder is started for it. Every variant of
    // a file has the SAME media playlist — same duration, same boundaries, same
    // init name — because that is exactly what makes them interchangeable. The
    // player fetches a level's playlist to decide with, and creating a session
    // for one it may never switch to would leave a second encoder running on a
    // host that has capacity for one.
    if (isPlaylist) {
      return { sessionId: base.id };
    }
    let variant;
    try {
      variant = await this.resolveVariantSession(
        baseSessionId,
        height,
        isSegment ? base.segmentFormat.segmentIndexFromName(fileName) : -1
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#host.logger.error(
        `transcode ${baseSessionId} could not prepare the ${height}p variant: ${message}` +
        (error instanceof Error && error.stack ? `\n${error.stack}` : "")
      );
      return { sessionId: null, error: message };
    }
    if (!variant) {
      return { sessionId: null };
    }
    if (consumerId && !isFamilyConsumerId(consumerId)) {
      // The same circle as a soundtrack's: the init has to be made before a
      // segment can be asked for, and nothing is made for an output nobody is
      // watching. Asking for any of its files is watching it.
      const watcher = this.#host.viewers.of(variant, consumerId);
      this.#host.placeViewer(variant, watcher, this.#host.viewerPositionOf(baseSessionId, consumerId));
    }
    // Only a SEGMENT says the viewer is watching this rung — and it says more
    // than that: it names the exact segment the player wants from it.
    if (isSegment) {
      this.#noteVariantActive(
        base,
        variant,
        variant.segmentFormat.segmentIndexFromName(fileName),
        consumerId
      );
    }
    return { sessionId: variant.id };
  }

  /**
   * Prepare an audio track at a position, so a change of track is instant.
   *
   * The player, told to change track, discards the audio it holds and cannot
   * show a frame until the new track covers the playhead — so switching first
   * and producing second puts the whole of the track's cold start on screen as
   * a spinner. Measured 2026-08-15: the picture stopped for as long as the
   * first piece took. Prepared first, the player finds the bytes already there.
   *
   * The same shape as {@link prepareVariant}, and for the same reason.
   *
   * @param {string} baseSessionId
   * @param {number} trackIndex
   * @param {number} positionSeconds
   * @returns {Promise<{ sessionId: string, fileName: string } | null>}
   */
  async prepareAudioTrack(baseSessionId, trackIndex, positionSeconds, consumerId = "") {
    const base = this.#host.outputs.get(baseSessionId);
    if (!base || !this.servesAudioSeparately(base)) {
      return null;
    }
    if (!this.#audioRenditionsOf(base).some((track) => track.trackIndex === trackIndex)) {
      return null;
    }
    const rendition = await this.#resolveAudioRenditionSession(base, trackIndex, consumerId);
    if (!rendition) {
      return null;
    }
    // A track prepared for a change the viewer did not make would otherwise
    // encode for nobody until its own idle timer noticed — the same trap
    // warming a quality rung has, and the same answer. Kept per viewer, because
    // one viewer's abandoned preparation must not stop a track another viewer
    // is listening to.
    const stillWarming = this.#host.viewers.of(base, consumerId).warmingAudioId;
    if (stillWarming && stillWarming !== rendition.id) {
      const abandoned = this.#host.outputs.get(stillWarming);
      const wanted = this.#liveAudioRenditionKeys(base);
      const wantedIds = new Set(
        this.#host.outputs.renditionsOf(base)
          .filter((other) => wanted.has(audioRenditionKey(
            this.#flatAudioTrackOf(other),
            other.spec.transcodesAudio
          )))
          .map((other) => other.id)
      );
      if (abandoned && !wantedIds.has(abandoned.id)) {
        // They are not listening to it, so they stop watching it. Its encoder
        // follows from that and is not commanded here: nobody left on an output
        // is a map with nothing in it, and the plan stops what is on it.
        this.#host.viewerLeaves(abandoned, consumerId);
      }
    }
    this.#host.viewers.of(base, consumerId).warmingAudioId = rendition.id;
    // Being prepared for them is watching it: it is made for this viewer, and
    // when they leave it must be let go with everything else of theirs.
    // Where the switch will land. An existing track was left wherever the
    // viewer last was on it; saying where they are now is the whole of pointing
    // it there, because the encoder follows the person and not the request.
    this.#host.viewers.of(rendition, consumerId).moveTo(positionSeconds);
    this.#host.planEncodersSoon();
    const index = this.#host.outputTimes.segmentIndexForTime(rendition, positionSeconds);
    return { sessionId: rendition.id, fileName: rendition.segmentFormat.segmentFileName(index) };
  }

  async prepareVariant(baseSessionId, height, positionSeconds, consumerId = "") {
    if (!isOutputName(baseSessionId)) {
      return null;
    }
    const base = this.#host.outputs.get(baseSessionId);
    if (!base) {
      return null;
    }
    if (!this.#host.qualityOffer.offeredHeightsFor(base).includes(height)) {
      return null;
    }
    const index = this.#host.outputTimes.segmentIndexForTime(base, positionSeconds);
    const variant = await this.resolveVariantSession(baseSessionId, height, index, consumerId);
    if (!variant) {
      return null;
    }
    // A rung warmed for a switch that was never made. Nothing else would ever
    // stop it: only becoming active stops the rung being left, so a viewer
    // trying two rungs in a row would leave the first encoding for nobody until
    // the look-ahead cap suspended it — three encoders at once on a host sized
    // for one, which is the opposite of what warming is for.
    // Kept per viewer, and stopped only if nobody has it on screen: with two
    // viewers, what one of them abandons may be what the other is watching.
    const stillWarming = this.#host.viewers.of(base, consumerId).warmingVariantId;
    if (stillWarming && stillWarming !== variant.id) {
      const abandoned = this.#host.outputs.get(stillWarming);
      if (abandoned && !this.#host.quality.variantsOnScreen(base).has(abandoned.id)) {
        this.#host.viewerLeaves(abandoned, consumerId);
      }
    }
    // The base is not a rung being prepared for anybody — it is what the family
    // is named by — so warming its own height leaves nothing outstanding.
    if (variant.id === base.id) {
      this.#host.viewers.of(base, consumerId).warmingVariantId = null;
    } else {
      this.#host.viewers.of(base, consumerId).warmingVariantId = variant.id;
    }
    // An existing rung may be parked wherever it was left, so it is pointed at
    // the switch position exactly as an activation would — the difference is
    // only that the rung on screen keeps its own encoder meanwhile.
    this.#host.outputs.touch(variant);
    // Anything that is not the rung on screen has to be pointed at the switch
    // position — INCLUDING the base. Skipping it because it is the base was a
    // defect: the base is parked wherever it was when the viewer left it, and
    // its encoder was stopped then. Measured 2026-08-12, warming 400p at
    // 6506.5s found the base still at `run from #0`, so the segment the switch
    // needed was never produced and the viewer got nothing at all.
    // A rung that is not on their screen is parked where they last left it, so
    // being warmed begins with saying where they are. Their being ON it is what
    // buys it an encoder, and both halves are said here: a warmed rung is one
    // this person is watching for as long as the warm-up lasts, which is why
    // two encoders run through it.
    if (variant.id !== this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs }).id) {
      this.#host.viewers.of(variant, consumerId).moveTo(this.#host.outputTimes.segmentStartTime(base, index));
      this.#host.planEncodersSoon();
    }
    this.#host.logger.info(
      `transcode ${base.id} warming ${height}p at ${positionSeconds.toFixed(1)}s (segment #${index})`
    );
    return { sessionId: variant.id, fileName: variant.segmentFormat.segmentFileName(index) };
  }

  /**
   * Record which variant the viewer is watching, and give it the encoder.
   *
   * The previous variant's encoder is stopped and the new one is pointed at
   * where the viewer stands, because a segment request does not steer the
   * encoder anywhere (see #ensureEncodingFor) and a variant that was watched a
   * minute ago is parked wherever it was left.
   *
   * @param {HlsSession} base
   * @param {HlsSession} variant
   * @param {number} wantedIndex - The segment this rung was just asked for.
   * @param {string} [consumerId] - Which viewer moved.
   * @returns {void}
   */
  #noteVariantActive(base, variant, wantedIndex = -1, consumerId = "") {
    const previous = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
    if (previous.id === variant.id) {
      // The rung on screen asking for more of itself, which it does every few
      // seconds. Nothing is being decided here — and deciding anything was the
      // defect: the warm-up was cancelled by the next segment the CURRENT rung
      // fetched, measured 2026-08-12 at 117 ms and 1.5 s after two warm-ups
      // began, so the rung being prepared was stopped before it had encoded
      // anything and the viewer waited out the full thirty-second warm-up for a
      // segment nobody was making, then waited again for the switch itself.
      return;
    }
    // A rung is being left, so whatever was warmed is decided: either it is the
    // rung now being switched to, or the viewer went somewhere else and it must
    // stop like any other rung nobody is watching. Nothing else would ever stop
    // it — only the rung being LEFT is stopped below.
    const baseViewer = this.#host.viewersOf(base).get(consumerId) ?? null;
    const warmed = baseViewer?.warmingVariantId ?? null;
    if (baseViewer) {
      baseViewer.warmingVariantId = null;
    }
    if (warmed && warmed !== variant.id && warmed !== previous.id) {
      const abandoned = this.#host.outputs.get(warmed);
      if (abandoned && !this.#host.quality.variantsOnScreen(base).has(abandoned.id)) {
        this.#host.viewerLeaves(abandoned, consumerId);
      }
    }
    const position = this.#variantStartSeconds(base, wantedIndex, consumerId);
    this.#host.viewers.of(base, consumerId).activeVariantId = variant.id;
    // The step is an output of this viewer's now.
    this.#host.viewers.of(variant, consumerId);
    // And the one they came off is not — unless it is the picture itself, which
    // they never stop watching: the browser addresses the picture, their chosen
    // soundtrack is recorded on it, and the plan reads their position from it.
    // Leaving it deleted their whole record, so a viewer who went down a step,
    // back to the picture's own height and down again lost the soundtrack they
    // had chosen, and the encoder making it was stopped as unwanted.
    if (previous !== base && previous !== variant) {
      this.#host.viewerLeaves(previous, consumerId);
    }
    this.#host.logger.info(
      `transcode ${base.id} variant now ${this.#host.outputs.variantHeightOf(variant)}p ` +
      `(was ${this.#host.outputs.variantHeightOf(previous)}p) at ${position.toFixed(1)}s` +
      (consumerId ? ` for ${consumerId}` : "")
    );
    // Requests still held on the rung they came off are for segments nobody
    // will produce now, and the player stopped waiting for them the moment it
    // switched. Answering "retry" at once frees them instead of holding each for
    // the full minute.
    //
    // WHETHER ITS ENCODER GOES ON IS NOT DECIDED HERE. It used to be stopped
    // from this line whenever no viewer had it on screen — the plan, handed the
    // whole film's priority map, wanted an encoder on every output of it and
    // started one again on the very next pass, which this viewer's own move had
    // just triggered. Each output is handed its own map now, so a rung nobody is
    // on has nothing in it and the plan stops what is on it, once.
    if (!this.#host.quality.variantsOnScreen(base).has(previous.id)) {
      previous.waitEpoch = (previous.waitEpoch ?? 0) + 1;
    }
    if (position > 0) {
      // The rung being switched TO, named literally: a warm-up may have left
      // the family pointing elsewhere, and forwarding would move that one
      // instead. Saying where this person is on it is the whole of pointing its
      // encoder there.
      this.#host.viewers.of(variant, consumerId).moveTo(position);
    }
    this.#host.planEncodersSoon();
  }

  /**
   * The master playlist: every resolution this file can be served at, as HLS
   * variants.
   *
   * This is what makes a change of quality seamless. Our media playlist is VOD
   * and terminated with `#EXT-X-ENDLIST`, and hls.js only re-reads a playlist
   * that is live — so rewriting it underneath the player achieves nothing, and
   * a switch had to tear the player down and build a new session. Offered as
   * variants instead, the switch is the player's own: it fetches the other
   * variant, appends it after what is already buffered, and changes the
   * decoder's type if the codec parameters differ.
   *
   * Offered only where the variants can actually be joined, which is a question
   * about the CUT GRID and not about who produces the frames:
   *
   * - a re-encoded session on the uniform grid — its variants are re-encoded on
   *   the same one, keyframes forced onto it;
   * - a session cut at the source's own keyframes — a copy, which has no other
   *   choice — where the variants are re-encoded and forced onto those very
   *   times, so a rung's segment covers the same span as the copy's.
   *
   * What is refused is a session whose own grid is a fiction: a copy with no
   * readable keyframe index falls back to an even grid that ffmpeg then does
   * not cut on, and nothing can be aligned to that.
   *
   * @param {string} sessionId
   * @returns {string | null} The playlist text, or null when there is nothing
   *   to choose between, or nothing to align to.
   */
  buildMasterPlaylist(sessionId, consumerId = "") {
    if (!isOutputName(sessionId)) {
      return null;
    }
    const session = this.#host.outputs.get(sessionId);
    if (!session) {
      return null;
    }
    if (!this.#host.outputs.publishesVariants(session)) {
      return null;
    }
    // The audio tracks, published once for the whole file rather than muxed
    // into every rung. Two things follow from that: the same track is not
    // encoded once per rung on a host that struggles to encode it once, and
    // changing track becomes the player switching rendition instead of this
    // proxy rebuilding the session with another `audioTrackIndex`.
    //
    // Only for a session that asked for them. A browser that does not know
    // about renditions is served audio in its stream, as before, and gets no
    // `#EXT-X-MEDIA` lines to be confused by.
    const renditions = this.servesAudioSeparately(session)
      // Which track is marked DEFAULT is the ASKING viewer's business: one
      // picture is shared by everyone watching it, and each of them may have
      // chosen a different language. A default written from the session's own
      // field would start the second viewer in the first viewer's language.
      ? this.#audioRenditionsOf(session, this.#audioChoiceOf(session, consumerId).trackIndex)
      : [];
    return masterPlaylistText({
      // The shape of the film and the rates it carries, asked of the layer that
      // holds both. What CAN be spliced, not what is worth offering this second:
      // the live judgement travels in `offeredHeights` and in every progress
      // report, and letting it decide the master's existence made a live session
      // answer 404 to its own published address.
      ...this.#host.outputs.masterFactsOf(session),
      renditions,
      playlistFileName: PLAYLIST_FILE_NAME
    });
  }

  /**
   * Whether this session's audio is published separately rather than muxed into
   * its picture.
   *
   * Two things have to hold, and the second is why this is asked here rather
   * than settled when the session was made. The browser must understand
   * renditions — it says so when it creates the session, and one that does not
   * has to be sent audio in the stream. AND there must be a master playlist to
   * publish them in: a stream served as a single media playlist has nowhere to
   * carry an `#EXT-X-MEDIA` line, so taking the audio out of it would leave the
   * viewer with a picture and silence.
   *
   * @param {HlsSession} session
   * @returns {boolean}
   */
  servesAudioSeparately(session) {
    return session.spec.carries !== "audio-only" && session.spec.carriesAudioSeparately;
  }

  inputOf(session) {
    return encoderInputs({
      picture: session.file,
      soundtrack: session.spec.audio
        ? this.#host.sourceFiles.get(session.file.sourceKey, session.spec.audioFileIndex)
        : session.file,
      carries: session.spec.carries,
      audioSeparate: this.servesAudioSeparately(session),
      sessionId: session.id,
      readWindowBytes: session.readWindowBytes,
      baseUrl: this.#host.localBaseUrl
    });
  }

  /**
   * One file of an audio rendition: its playlist, its init segment or one of
   * its segments.
   *
   * A rendition is an ordinary session underneath — same source, same file,
   * same cut grid, one audio track and no picture — created on the first
   * request for it, exactly as a quality variant is. What differs is that the
   * player fetches it ALONGSIDE a variant rather than instead of one, so both
   * encoders run: a rung and the audio it is played with.
   *
   * @param {string} baseSessionId
   * @param {number} trackIndex
   * @param {string} fileName
   * @param {string} [consumerId] - Who is asking. One picture serves everyone
   *   watching it, and which soundtrack they are listening to is theirs alone.
   * @returns {Promise<{ sessionId: string | null, error?: string }>}
   */
  async resolveAudioRenditionFile(baseSessionId, trackIndex, fileName, consumerId = "") {
    if (!isOutputName(baseSessionId) || !Number.isInteger(trackIndex) || trackIndex < 0) {
      return { sessionId: null };
    }
    const base = this.#host.outputs.get(baseSessionId);
    if (!base || !this.servesAudioSeparately(base)) {
      return { sessionId: null };
    }
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    const isInit = base.segmentFormat.initFileName !== null && fileName === base.segmentFormat.initFileName;
    const isSegment = base.segmentFormat.isSegmentFileName(fileName);
    if (!isPlaylist && !isInit && !isSegment) {
      return { sessionId: null };
    }
    if (!this.#audioRenditionsOf(base).some((rendition) => rendition.trackIndex === trackIndex)) {
      return { sessionId: null };
    }
    // The playlist is answered from the base, for the same reason a variant's
    // is: every rendition of a file has the same boundaries and the same
    // duration — they are cut on one grid — and the player fetches the playlist
    // of tracks it may never select. Starting an encoder for each would put as
    // many encoders on the host as the file has languages.
    if (isPlaylist) {
      return { sessionId: base.id };
    }
    let rendition;
    try {
      rendition = await this.#resolveAudioRenditionSession(base, trackIndex, consumerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#host.logger.error(
        `transcode ${baseSessionId} could not prepare audio track ${trackIndex}: ${message}` +
        (error instanceof Error && error.stack ? `\n${error.stack}` : "")
      );
      return { sessionId: null, error: message };
    }
    if (rendition && consumerId && !isFamilyConsumerId(consumerId)) {
      // Asking for ANY file of this soundtrack is this viewer watching it, and
      // the init is the file they ask for first. Registered here rather than on
      // the segment alone, because the segment cannot be asked for until the
      // init has been served, and the init cannot be made unless somebody is
      // watching: that circle is what left a soundtrack with no encoder, no
      // init and a viewer waiting sixty seconds on 2026-09-05.
      //
      // WHERE they are on it is where they are on the picture: the two are
      // played together.
      const listener = this.#host.viewers.of(rendition, consumerId);
      this.#host.placeViewer(rendition, listener, this.#host.viewerPositionOf(base.id, consumerId));
    }
    if (isSegment && rendition) {
      this.#noteAudioTrackActive(base, trackIndex, consumerId);
    }
    return { sessionId: rendition?.id ?? null };
  }

  /**
   * A SEGMENT of this track is what says the viewer is listening to it — the
   * player fetches the playlist and the init of tracks it may never choose.
   *
   * Every other track is then stopped. Each one is an ffmpeg process AND a
   * reader holding pieces of the torrent in memory, and the store can only
   * spill a piece nobody is reading: on 2026-08-15 a viewer who had changed
   * track once had three readers on one file — picture, the track they chose
   * and the track they left — and at a seek all three revived their windows at
   * once, every resident piece was pinned, a read ended with zero bytes, and
   * every encoder took that for the end of the file and died. Playback was over
   * for good; the sessions answered 500 to everything after that.
   *
   * Stopped, not disposed: the track keeps its place, its grid and its
   * position, so switching back does not build it again — the same treatment a
   * quality rung gets when the viewer moves off it.
   *
   * "Every other track" is every track NO LIVE VIEWER is listening to, which
   * with one viewer is what it always was. It has to be asked that way now that
   * two viewers share one picture: each of them fetches the sound they chose,
   * and stopping "the others" per request would have them switch each other's
   * soundtrack off in turn, once per segment, for the whole film.
   *
   * @param {HlsSession} base
   * @param {number} trackIndex
   * @param {string} consumerId - Who is listening. Empty on a transport that
   *   cannot say, which is one viewer by construction.
   */
  #noteAudioTrackActive(base, trackIndex, consumerId) {
    const previous = this.#audioChoiceOf(base, consumerId);
    if (previous.trackIndex === trackIndex) {
      return;
    }
    this.#host.viewers.of(base, consumerId).audio = { ...previous, trackIndex };
    // Kept for the viewer who cannot name themselves, and for the master's
    // default rendition when nobody has said anything else.
    const wanted = this.#liveAudioRenditionKeys(base);
    for (const other of this.#host.outputs.renditionsOf(base)) {
      if (wanted.has(audioRenditionKey(this.#flatAudioTrackOf(other), other.spec.transcodesAudio))) {
        continue;
      }
      // Requests held on it are for segments nobody will produce now, and the
      // player stopped waiting for them the moment it changed track.
      if (this.#host.encodeRuns.liveRunsOf(other).length > 0) {
        other.waitEpoch = (other.waitEpoch ?? 0) + 1;
      }
      // Nobody is listening to it any more: this viewer stops watching that
      // output, on both sides of the relation, and the claim their listening
      // placed on it is released with them. Its encoder follows from that —
      // an output with nobody on it has a map with nothing in it — and was
      // additionally stopped from here, which is the same decision taken twice
      // by two parties with two rules.
      this.#host.viewerLeaves(other, consumerId);
    }
  }

  /**
   * The viewers this family has heard from recently enough to still be watching.
   *
   * Asked of the whole family, not of one session: a viewer on a quality step
   * asks that step for its segments, so the picture they started on has not
   * heard from them since they switched. Their head expires by the same rule the
   * encoder's own steering uses.
   *
   * It is what decides whether an encoder is still wanted, and it is needed
   * because nothing releases a session when a channel closes (roadmap item 54)
   * — without it a viewer whose tab is gone would hold a soundtrack or a rung
   * for the session's whole life.
   *
   * @param {HlsSession} base
   * @returns {Set<string>}
   */
  liveConsumers(base) {
    const live = new Set();
    for (const member of this.#host.outputs.familyOf(base)) {
      for (const [consumerId, viewer] of this.#host.viewersOf(member)) {
        if (viewer.isPresent()) {
          live.add(consumerId);
        }
      }
    }
    return live;
  }

  /**
   * What one viewer wants of the sound: which soundtrack, and whether their
   * browser needs it re-encoded.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @returns {{ trackIndex: number, transcode: boolean }}
   */
  #audioChoiceOf(base, consumerId) {
    const stated = this.#host.viewersOf(base).get(consumerId)?.audio ?? null;
    if (stated) {
      return stated;
    }
    // A viewer this session has not heard from by name. The session's own
    // parameters are the honest fallback: they are what the request that
    // created it asked for.
    return {
      trackIndex: this.#flatAudioTrackOf(base),
      transcode: base.spec.transcodesAudio
    };
  }

  /**
   * The renditions live viewers are listening to, as the keys they are filed
   * under.
   *
   * A viewer counts while their head is fresh on the picture — the same
   * expiry the encoder's own steering uses. Without that test a viewer whose
   * tab was closed without releasing the session (roadmap item 54) would hold
   * an encoder for the session's whole life.
   *
   * @param {HlsSession} base
   * @returns {Set<string>}
   */
  #liveAudioRenditionKeys(base) {
    const wanted = new Set();
    const live = this.liveConsumers(base);
    for (const [consumerId, viewer] of this.#host.viewersOf(base)) {
      const choice = viewer.audio;
      // The unnamed viewer has no head to expire and is always counted; a named
      // one counts while some session of the family has heard from them.
      if (consumerId && live.size > 0 && !live.has(consumerId)) {
        continue;
      }
      wanted.add(audioRenditionKey(choice.trackIndex, choice.transcode));
    }
    return wanted;
  }

  /**
   * The session producing one audio track of this file, made on first request.
   *
   * Filed under the track AND how it has to be produced, because those are two
   * different encodes: a browser that can decode this track as it stands is
   * served a copy, and one that cannot is served AAC. The base cannot answer
   * for either of them now that it is shared — its own `transcodeAudio` is
   * whatever the first viewer's browser needed.
   *
   * @param {HlsSession} base
   * @param {number} trackIndex
   * @param {string} consumerId - Who is asking.
   * @returns {Promise<HlsSession | null>}
   */
  async #resolveAudioRenditionSession(base, trackIndex, consumerId = "") {
    const transcodeAudio = this.#audioChoiceOf(base, consumerId).transcode;
    // Found by what it IS: a soundtrack of this file, this track, produced this
    // way. That is what a map from a rendition key to a session id said, at the
    // price of a link between two sessions' lifetimes — one that had to be
    // cleaned from the other side when either ended.
    const already = this.#host.outputs.renditionsOf(base).find(
      (other) =>
        this.#flatAudioTrackOf(other) === trackIndex &&
        other.spec.transcodesAudio === transcodeAudio
    );
    if (already) {
      this.#host.outputs.touch(already);
      return already;
    }
    const rendition = await this.#host.createOrGetSession({
      sourceKey: base.file.sourceKey,
      fileIndex: base.file.fileIndex,
      // No picture at all: the video flag says what to do with a video stream
      // this output does not carry.
      transcodeVideo: false,
      transcodeAudio,
      fileName: base.file.name,
      consumerId: variantConsumerId(base.id),
      audioTrackIndex: trackIndex,
      audioOnly: true,
      // Where the viewer is, so the rendition starts with the picture rather
      // than at the beginning of the file. Read the same way a quality variant
      // reads it: the base's own field is only written by a seek or by a
      // segment IT served, so on a resume-from-position open it is still unset
      // while the player is asking for segment #537 — and the audio would begin
      // at zero and never catch up, since nothing treats a far request as a
      // seek. The accessor falls back to the last segment actually requested.
      // Where the PICTURE is, not where it has been read to.
      //
      // The position this class keeps is written by the segments a session
      // serves, so it is the READ head, and the viewer's picture sits behind it
      // by everything the player has buffered. Started at the read head, the
      // audio run begins AHEAD of the viewer, and every request they then make
      // is behind a run that only moves forward — field 2026-08-15, placed at
      // #16 while the player asked for #10, and the audio arrived only after
      // the encoder was dragged back.
      //
      // The distance is measured, not assumed: the browser reports how many
      // seconds it holds ahead of the picture with every link report, so the
      // playhead is one subtraction away. A stale report is no use — a viewer
      // who seeked since then is somewhere else entirely — so an old one is
      // ignored and the whole look-ahead is subtracted instead, which cannot
      // leave the run ahead of them.
      startPositionSeconds: this.#host.audioStartSecondsFor({
        family: this.#host.outputs.familyOf(base),
        openedAtSeconds: this.#host.encodeRuns.progressOf(base)?.startPositionSeconds,
        segmentSeconds: this.#host.segmentDurationSec
      }),
      segmentFormatId: base.segmentFormat.id,
      // Cut where the picture is cut. Two streams meant to be played together
      // have to be divided at the same times, and the grid is the base's — the
      // table as it stands now, corrections included. A base on the uniform
      // grid passes nothing: the rendition computes the same even grid from the
      // same duration.
      inheritedGrid: base.timeline.cutGrid === "keyframe"
        ? {
            boundaries: base.timeline.boundaries,
            published: base.timeline.published
          }
        : null
    });
    return rendition ?? null;
  }

  /**
   * Whether a session created with these parameters publishes its sound as its
   * own stream rather than muxing it into the picture.
   *
   * Asked before the session exists, because the session's KEY depends on the
   * answer: an output that carries no sound must not be told apart by which
   * soundtrack was asked for, and an output that carries it must be.
   *
   * Three conditions, all of them facts about the request and the file rather
   * than about the machine's load, so the answer cannot move afterwards:
   *
   * 1. the browser said it understands rendition groups. One that did not must
   *    be sent its sound inside the picture, or it gets silence;
   * 2. the file has soundtracks to publish;
   * 3. there is more than one height to move between, because renditions are
   *    published in a master playlist and a stream served as a single media
   *    playlist has nowhere to carry an `#EXT-X-MEDIA` line.
   *
   * Condition 3 is the reason a source too small for a ladder mixes its sound
   * in as it always did. It is asked of the same ladder the master's rung list
   * comes from; the realtime budget may still encode below the height named
   * here, and cannot change the count, because what it picks is a rung of that
   * same ladder.
   *
   * @param {{ sourceKey: string, fileIndex: number, audioRenditions: boolean, ownHeight: number }} params
   * @returns {boolean}
   */
  audioTravelsSeparately({ sourceKey, fileIndex, audioRenditions, ownHeight }) {
    if (audioRenditions !== true) {
      return false;
    }
    const tracks = this.#host.getCachedAudioTracks?.({ sourceKey, fileIndex }) ?? [];
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return false;
    }
    // The source's own height, from the probe the playback plan already ran.
    // Absent, this answers "mix it in" — which is what the later computation
    // answered too, since a session with no source height has an empty ladder.
    const sourceHeight = Math.round(Number(this.#host.getCachedMediaInfo?.({ sourceKey, fileIndex })?.height) || 0);
    const heights = new Set(variantHeightsFor(sourceHeight));
    if (Number.isInteger(ownHeight) && ownHeight > 0) {
      heights.add(ownHeight);
    }
    return heights.size >= 2;
  }

  /**
   * Where one numbered soundtrack actually is: which file of the torrent, and
   * which `0:a:N` inside it.
   *
   * The number is flat across the picture's own tracks and every soundtrack
   * shipped as a file beside it, so that the browser's menu, the
   * `audioTrackIndex` on a session request and the `a/<n>/` path a rendition is
   * published at all mean the same thing. This resolves it, once, from the
   * inventory the playback plan built — the very list the menu was drawn from,
   * so the two cannot disagree about what a number means.
   *
   * A number the inventory does not describe resolves to the picture's own file
   * at that index, which is exactly what every session did before soundtracks in
   * their own files existed: a plan cached by an older build carries no
   * inventory, and a session created against it must keep working.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex - The PICTURE's file.
   * @param {number} flatIndex
   * @returns {{ fileIndex: number, sourceTrackIndex: number, isSidecar: boolean, name: string }}
   */
  resolveAudioSource(sourceKey, fileIndex, flatIndex) {
    const inventory = this.#host.getCachedAudioTracks?.({ sourceKey, fileIndex }) ?? [];
    const entry = Array.isArray(inventory)
      ? inventory.find((candidate) => candidate?.index === flatIndex)
      : null;
    if (!entry || !Number.isInteger(entry.fileIndex) || !Number.isInteger(entry.sourceTrackIndex)) {
      return { fileIndex, sourceTrackIndex: flatIndex, isSidecar: false, name: "" };
    }
    return {
      fileIndex: entry.fileIndex,
      sourceTrackIndex: entry.sourceTrackIndex,
      isSidecar: entry.fileIndex !== fileIndex,
      name: typeof entry.fileName === "string" ? entry.fileName : ""
    };
  }

  /**
   * The browser's flat soundtrack number for the audio carried by this output.
   *
   * `OutputSpec` keeps the stable source address: file plus `0:a:N`. The flat
   * number belongs to the browser menu and is reconstructed from that menu's
   * inventory when a route needs it. It is therefore not kept as a duplicate
   * field on the output.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #flatAudioTrackOf(session) {
    const audio = session.spec.audio;
    if (!audio) {
      return 0;
    }
    const tracks = this.#host.getCachedAudioTracks?.({
      sourceKey: session.file.sourceKey,
      fileIndex: session.file.fileIndex
    }) ?? [];
    const matching = Array.isArray(tracks)
      ? tracks.find((entry) => entry?.fileIndex === audio.fileIndex && entry?.sourceTrackIndex === audio.trackIndex)
      : null;
    return Number.isInteger(matching?.index) ? matching.index : audio.trackIndex;
  }

  /**
   * Start reading where a soundtrack file's own timeline begins, if nobody has.
   *
   * Read by the container layer from the file's own header — the same 64 KB,
   * the same reader and the same per-file cache the audio menu's track list
   * comes from. A container states this, so it is read from the container and
   * not measured from the media.
   *
   * The answer goes onto the FILE, which is where it belongs and which is what
   * removed the pair of maps this used to keep beside it: a start time held per
   * `sourceKey:fileIndex` is a fact of that file, and a second store of facts
   * about files is a second thing that can disagree. Every session of the
   * soundtrack shares the one object, so a reading that lands after a session
   * has started is seen by that session too — which is what the spawn path
   * needed and used to re-read a map for.
   *
   * Until 2.73.0 the session spawned an ffmpeg against the proxy's own
   * `/stream` for it and waited up to eight seconds for the banner. Field
   * 2026-09-03: that read cost 8121 ms of a cold start, three times out of
   * three, while the container layer had read the same header of the same file
   * in 8 ms in the same second. The eight seconds were not even spent on the
   * answer — the early exit was gated on a DURATION, and a partly downloaded
   * file prints `Duration: N/A` with the start time on that very line.
   *
   * Runs behind whoever asked, so no viewer waits for it. Once per file per
   * process: a container's start time is a property of the file and cannot
   * change. A reading that comes back without an answer is NOT remembered — the
   * file may simply not have been downloaded far enough yet, and the next
   * session asks again.
   *
   * @param {SourceFile} file - The soundtrack's own file.
   * @returns {void}
   */
  warmFileStartTime(file) {
    if (typeof this.#host.getContainerMediaInfo !== "function") {
      return;
    }
    if (!(this.#host.fileStartTimeReads instanceof Set)) {
      this.#host.fileStartTimeReads = new Set();
    }
    if (file.media?.startTime !== undefined || this.#host.fileStartTimeReads.has(file.key)) {
      return;
    }
    this.#host.fileStartTimeReads.add(file.key);
    void Promise.resolve(
      this.#host.getContainerMediaInfo({ sourceKey: file.sourceKey, fileIndex: file.fileIndex })
    )
      .then((info) => {
        if (info && Number.isFinite(info.startTimeSeconds)) {
          file.learn({ startTime: info.startTimeSeconds });
          this.#host.logger.info(
            `transcode: soundtrack file ${file.fileIndex}'s own timeline starts at ` +
            `${info.startTimeSeconds.toFixed(6)}s, read from its header`
          );
        }
      })
      .catch((error) => {
        this.#host.logger.info(
          `transcode: the start of soundtrack file ${file.fileIndex}'s timeline could not be read ` +
          `(${error instanceof Error ? error.message : String(error)}) — the two timelines are ` +
          "taken to agree until it can be"
        );
      })
      .finally(() => {
        this.#host.fileStartTimeReads.delete(file.key);
      });
  }

  /**
   * The audio tracks of this session's file, as renditions for the master.
   *
   * Taken from the inventory the playback plan already probed — the same list
   * the browser's audio menu is built from — so nothing is probed again here.
   * The track the session was created with is the default one: it is what the
   * viewer chose (or the file's first track), and a master that defaulted to
   * something else would change the language on its own.
   *
   * @param {HlsSession} session
   * @param {number} [chosenTrack] - The track to mark as the default one.
   *   Defaults to the session's own, which is what a caller that is only
   *   counting the renditions wants.
   * @returns {Array<{ trackIndex: number, name: string, language: string, isDefault: boolean }>}
   */
  #audioRenditionsOf(session, chosenTrack) {
    const tracks = this.#host.getCachedAudioTracks?.({
      sourceKey: session.file.sourceKey,
      // The PICTURE's file, which is what `file` is on every session of a
      // family — a rendition is created with its base's, and only its
      // `audioFile` points at the file its sound comes from. The inventory is
      // keyed on the picture and spans the soundtracks beside it.
      fileIndex: session.file.fileIndex
    }) ?? [];
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return [];
    }
    const chosen = Number.isInteger(chosenTrack) ? chosenTrack : this.#flatAudioTrackOf(session);
    // One line per entry of the inventory, in its order and without omissions —
    // including a track the container marks unusable. The player addresses a
    // rendition by its POSITION in this list, and the browser addresses it by
    // the number the inventory gave it; leaving anything out would make those two
    // disagree from that point on. A track the file says not to offer is kept out
    // of the VIEWER's menu, which is the browser's own business and does not
    // touch the numbering.
    return tracks.map((entry, order) => {
      const index = Number.isInteger(entry?.index) ? entry.index : order;
      const language = typeof entry?.languageBcp47 === "string" && entry.languageBcp47.length > 0
        ? entry.languageBcp47
        : (typeof entry?.language === "string" ? entry.language : "");
      return {
        trackIndex: index,
        name: this.#host.audioRenditionName(
          { ...entry, index, folders: Array.isArray(entry?.folders) ? entry.folders : [] },
          tracks
        ),
        // Only what the container itself states. What a folder name suggests
        // about a language is derived in the browser, where the language table
        // and the viewer's own locale already are; writing a guess into
        // `LANGUAGE` would put it in a playlist as though the file had said it.
        language,
        isDefault: index === chosen
      };
    });
  }

  /**
   * Where a variant's first encode run should begin, in seconds.
   *
   * The segment the player asked for, when there is one: after a level switch
   * hls.js discards what it had buffered ahead and fetches from the picture's
   * own position, so its first request IS that position. Falling back to the
   * rung being left means falling back to that rung's READ head, which sits a
   * whole buffer further on.
   *
   * @param {HlsSession} base
   * @param {number} wantedIndex - Segment index asked for, or -1.
   * @returns {number}
   */
  #variantStartSeconds(base, wantedIndex, consumerId = "") {
    if (Number.isInteger(wantedIndex) && wantedIndex >= 0) {
      return this.#host.outputTimes.segmentStartTime(base, wantedIndex);
    }
    return this.#host.viewerSecondsOn(this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs }));
  }

  /**
   * The track set this session's output will carry — what the proxy DECLARES,
   * and the one answer both sides must agree on.
   *
   * The source may hold any number of tracks: several dubs, subtitles, even a
   * cover-art video stream. The output does not inherit that list — the command
   * maps at most one video and at most one audio, each optional, and subtitles
   * never enter the HLS output at all (they are served separately as WebVTT).
   * So this is not an inference about the file; it is the proxy stating what it
   * chose to produce.
   *
   * Used in two places, and that is the point: the init segment is checked
   * against it here, and it is sent to the browser so the browser can check
   * what it actually received against the same statement. Without the second
   * check a missing track is only noticed by its absence, minutes later, as a
   * black picture with working sound.
   *
   * @param {HlsSession} session
   * @returns {{ video: boolean, audio: boolean }}
   */
  declaredTracks(session) {
    const probed = this.#host.getCachedMediaInfo?.({
      sourceKey: session.file.sourceKey,
      fileIndex: session.file.fileIndex
    }) ?? null;
    // What the SOURCE has, narrowed to what this session's output carries. A
    // rendition maps only audio and a stream whose audio travels separately
    // maps only video, so answering from the source alone would tell the
    // browser about a track that is not in the stream, and would leave
    // `#initFromFirstSegment` waiting for a second track that no init will ever
    // declare — its warning about a short header would then fire on every one.
    const carriesVideo = session.spec.carries !== "audio-only";
    const carriesAudio = !this.servesAudioSeparately(session);
    // The soundtrack of this session may not be in the file that was probed. A
    // release that ships its dub as a separate file often ships the picture with
    // no sound of its own at all, and then the picture's probe says there is no
    // audio while the output plainly carries some — which would leave the header
    // check expecting one track where two arrive, and tell the browser its sound
    // was lost.
    const audioFromAnotherFile = session.spec.audioFileIndex !== session.file.fileIndex;
    return {
      video: carriesVideo && Boolean(probed?.videoCodec),
      audio: carriesAudio && (audioFromAnotherFile || Boolean(probed?.audioCodec))
    };
  }
}
