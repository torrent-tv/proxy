/**
 * The steps of a picture and its soundtracks.
 *
 * A step is an output of the same picture at another size, a soundtrack an
 * output of one audio track; each is made the first time it is asked for, and an
 * output already producing the same thing answers instead. The master playlist
 * lists them. Which viewer is on which is the viewer's fact, stated here and
 * read back through the host.
 */

import { isOutputName, OUTPUT_UNAVAILABLE } from "./output/index.js";
import { masterPlaylistText, PLAYLIST_FILE_NAME } from "./output/playlists.js";
import { variantHeightsFor } from "./output/ladder.js";
import { isSameMaterial, outputSuits } from "./quality/serving-output.js";
import { audioLoadOf, linkAnswerFigures, linkCouldCarry, loadOf, videoLoadOfLimit, videoLoadOfSpec } from "./quality/link-budget.js";
import { AUDIO_TRANSCODE_KBPS, maxrateKbpsFor } from "./args.js";
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

export class Renditions {
  #variantPending = new WeakMap();
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `viewerSecondsOn`, `audioStartSecondsFor`, `activeOutputFor`, `viewersOf`, `audioRenditionName`, `logger`, `placeViewer`, `viewerLeaves`, `createOrGetSession`, `planEncodersSoon`, `disposeSession`, `viewerPositionOf`, `encodeRuns`, `fileStartTimeReads`, `getCachedAudioTracks`, `getCachedMediaInfo`, `getContainerMediaInfo`, `localBaseUrl`, `outputTimes`, `outputs`, `quality`, `qualityOffer`, `segmentDurationSec`, `sourceFiles`, `viewers`, `generationOfRequest`, `givenOutputOf`, `noteGivenOutput`, `chosenOutputOf`, `chooseOutput`, `storedPieceReady`, `headersCompatible`, `audioChoiceOf`, `linkMbpsOf`, `qualityModeOf`, `noteServingVerdict`, `limitsFor`, `heightsChosenAs`, `highestGivenSegmentOf`, `sameHeightSwitchOf`, `noteSameHeightSwitch`, `switchingOnto`, `segmentClosed`, `bufferedSecondsOf`, `minimumBufferSecondsFor`
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
  /**
   * The output chosen for THIS viewer at this height, if it is still here.
   *
   * THE VIEWER'S OWN CHOICE, and nothing else (roadmap item 97, step 11). It
   * used to be one record per file and height, read by everybody watching the
   * file, and then a step NAMED after the height: the first viewer's answer
   * became every viewer's, whatever their link or their mode. Now the choice is
   * recorded on the viewer, and only the suitability rule ever makes one.
   *
   * A choice whose output has gone is no answer; the height is decided again
   * by the same rule, never by looking for the first output of that height.
   * The recorded key is looked up among the outputs of THIS picture's material,
   * so a step of another container can never be the answer.
   *
   * @param {HlsSession} base
   * @param {number} height
   * @param {string} consumerId
   * @returns {HlsSession | null}
   */
  servingOutputFor(base, height, consumerId) {
    if (!base || !Number.isInteger(height) || height <= 0 || !consumerId) {
      return null;
    }
    const key = this.#host.chosenOutputOf(consumerId, height);
    if (!key) {
      return null;
    }
    return this.#interchangeableWith(base, base.spec).find((other) => other.outputKey === key) ?? null;
  }

  /**
   * The rule has chosen `output` for this viewer at this height: record the
   * choice, and on what it was judged, for their progress report.
   *
   * @param {string} consumerId
   * @param {number} height
   * @param {HlsSession} output
   * @param {HlsSession} base
   * @returns {void}
   */
  #choose(consumerId, height, output, base) {
    this.#host.chooseOutput(consumerId, height, output.outputKey ?? "");
    const answer = this.#suitsViewer(output, base, consumerId).answer;
    this.#host.noteServingVerdict(
      consumerId,
      answer ? { ...linkAnswerFigures(answer), outputKey: output.outputKey ?? "", height } : null
    );
  }

  /**
   * Whether an output may serve this viewer, by the one rule every path asks
   * (`serving-output.js`, `outputSuits`): the picture's material, the size a
   * viewer who picked by hand requires, and a whole load their own link admits.
   *
   * @param {HlsSession} output
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {{ width: number, height: number } | null} [wanted]
   * @returns {{ suits: boolean, answer: object | null, reason: string }}
   */
  #suitsViewer(output, base, consumerId, wanted = null) {
    const linkMbps = this.#host.linkMbpsOf(base, consumerId);
    const audioLoad = audioLoadOf(this.#viewerAudioOf(base, consumerId), AUDIO_TRANSCODE_KBPS);
    const encode = output.spec?.video?.encode ?? null;
    return outputSuits({
      spec: output.spec,
      pictureSpec: base.spec,
      mode: this.#host.qualityModeOf(base, consumerId),
      size: encode
        ? { width: encode.width, height: encode.height }
        : { width: Number(base.file.width) || 0, height: Number(base.file.height) || 0 },
      wanted,
      judge: (spec) => linkCouldCarry(
        linkMbps,
        loadOf(videoLoadOfSpec(spec, base.file.decode?.megabitsPerSecond ?? null, this.#host.observedPeakMbps?.(spec) ?? null), audioLoad)
      )
    });
  }

  /**
   * The soundtrack part of the load this viewer's link carries.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @returns {import("./quality/link-budget.js").LoadPart | null}
   */
  viewerAudioLoadOf(base, consumerId) {
    return audioLoadOf(this.#viewerAudioOf(base, consumerId), AUDIO_TRANSCODE_KBPS);
  }

  /**
   * The soundtrack THIS viewer receives with the picture, as the link sees it:
   * whether it is re-encoded, and the rate the file states for it.
   *
   * Their own choice where they have made one, else the picture's own track.
   * Counted whether it travels inside the picture or as a stream of its own:
   * it crosses the same link either way.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @returns {{ transcode: boolean, bitrateKbps: number | null }}
   */
  #viewerAudioOf(base, consumerId) {
    const choice = this.#host.audioChoiceOf(base, consumerId) ??
      { trackIndex: this.#flatAudioTrackOf(base), transcode: base.spec.transcodesAudio };
    const inventory = this.#host.getCachedAudioTracks?.({
      sourceKey: base.file.sourceKey,
      fileIndex: base.file.fileIndex
    }) ?? [];
    const entry = Array.isArray(inventory) ? inventory.find((one) => one?.index === choice.trackIndex) : null;
    return {
      transcode: choice.transcode === true,
      bitrateKbps: Number.isFinite(entry?.bitrateKbps) ? entry.bitrateKbps : null
    };
  }

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
    // A height is chosen FOR somebody. A request naming nobody has no link, no
    // mode and no soundtrack to be judged by, so it is refused rather than
    // answered by whatever somebody else was given.
    if (!consumerId) {
      return null;
    }
    const existing = this.servingOutputFor(base, height, consumerId);
    if (existing) {
      this.#host.outputs.touch(existing);
      return existing;
    }
    // hls.js asks for a new level's playlist, its init and its first segments
    // within the same moment. Without this every one of them would build its
    // own session, and the ones that lost would encode for nobody. Per VIEWER:
    // two viewers of one height may be given two different outputs.
    //
    // A PREPARATION HOLDS THE DECISION IT WAS MADE ON: the link reading and the
    // mode at its start. A request of theirs arriving meanwhile joins it and is
    // told on what it was decided; a newer reading is weighed by the next
    // decision, once this one has ended.
    const pendingByHeight = this.#variantPending.get(base) ?? new Map();
    this.#variantPending.set(base, pendingByHeight);
    const pendingKey = `${height}:${consumerId}`;
    const pending = pendingByHeight.get(pendingKey);
    if (pending) {
      this.#host.logger.info(
        `transcode ${base.id} ${height}p for ${consumerId} joins the preparation decided on ` +
        `link=${pending.linkMbps ?? "unmeasured"} mode=${pending.mode}`
      );
      return pending.creation;
    }
    const mode = this.#host.qualityModeOf(base, consumerId);
    const linkMbps = this.#host.linkMbpsOf(base, consumerId);
    if (height === this.#host.outputs.variantHeightOf(base)) {
      // The picture's own height is answered by the picture only when it suits
      // this viewer, by the same rule as any other output. A picture that does
      // not is not handed over for being the one addressed.
      const verdict = this.#suitsViewer(base, base, consumerId);
      if (verdict.suits) {
        this.#choose(consumerId, height, base, base);
        return base;
      }
      this.#host.logger.info(
        `transcode ${base.id} the picture's own ${height}p does not suit ${consumerId} (${verdict.reason}); deciding again`
      );
    }
    const creation = this.#host.createOrGetSession(this.#stepOpening(base, {
      height,
      // Where this variant must begin. The segment the player asked it for when
      // it can be known — that is the player stating outright where it will
      // start fetching, and it is the only figure that cannot be stale.
      //
      // The other rung's read head is NOT that figure, and using it cost a
      // stuck session on 2026-08-11: a 240p rung encoding at 5-6x had read 56 s
      // further than the picture had played, so switching back to 400p placed
      // that run at 3084 s while the player needed 3028 s, and no segment it
      // wanted was ever produced.
      startSeconds: this.#variantStartSeconds(
        base,
        Number.isInteger(wantedIndex) && wantedIndex >= 0 ? this.#host.outputTimes.segmentStartTime(base, wantedIndex) : undefined,
        consumerId
      ),
      mode,
      linkMbps,
      consumerId,
      capKbps: null
    }))
      .then(async (variant) => {
        // Making a session takes seconds — a probe and a keyframe index — and
        // the viewer can leave inside that window. A variant registered onto a
        // disposed base is reachable by nobody: the browser never learns its
        // id, so nothing would release it and it would hold an encoder, a temp
        // directory and a claim on the torrent until its own idle timer noticed
        // half an hour later.
        if (!this.#host.encodeRuns.isLive(base)) {
          await this.#letGoIfNobodyIsOn(
            variant,
            `the picture it was made for ended while it was being made`
          );
          return null;
        }
        // Served by the picture itself, which does not become a step. RECORDED
        // like any other answer: a path that answers without recording leaves
        // the next request to decide the same question again, and the four
        // addressings of one step then name different outputs.
        if (variant === base) {
          this.#choose(consumerId, height, base, base);
          return base;
        }
        const incumbent = await this.#adoptIfAlreadyProduced(base, height, variant, consumerId);
        if (incumbent) {
          this.#choose(consumerId, height, incumbent, base);
          return incumbent;
        }
        // WHATEVER IT TURNED OUT TO BE is the answer for the height asked for.
        // It used to be recorded only where the produced height equalled the
        // one asked for — which is the case that needs no record at all: a step
        // produced at another size is NAMED after that size, so nothing could
        // find it by the height it answers, and every later request decided
        // again.
        const produced = this.#host.outputs.producedHeightOf(variant);
        variant.variantHeight ??= produced > 0 ? produced : height;
        // How it came to be: a step of a picture, not a picture a browser
        // opened. Read where a step needs the facts of the file rather than of
        // its own encode.
        this.#host.outputs.markStep(variant);
        this.#choose(consumerId, height, variant, base);
        return variant;
      })
      .finally(() => {
        pendingByHeight.delete(pendingKey);
      });
    pendingByHeight.set(pendingKey, { creation, linkMbps, mode, startedAt: Date.now() });
    return creation;
  }

  /**
   * What opening a step of this picture asks of `OutputOpening`, for one
   * viewer, at one height and, when named, one bitrate limit.
   *
   * One place for it, because two paths open steps — a height asked for, and a
   * move to another limit of the height on screen — and the two must agree
   * about everything but the size and the limit: the cuts, where the sound
   * travels, the container. A step that differed from its picture in any of
   * those would not be a step of it.
   *
   * @param {HlsSession} base
   * @param {{ height: number, startSeconds: number, mode: "auto" | "manual", linkMbps: number | null, consumerId: string, capKbps: number | null }} params
   * @returns {object}
   */
  #stepOpening(base, { height, startSeconds, mode, linkMbps, consumerId, capKbps }) {
    return {
      sourceKey: base.file.sourceKey,
      fileIndex: base.file.fileIndex,
      transcodeVideo: true,
      transcodeAudio: base.spec.transcodesAudio,
      fileName: base.file.name,
      // Opened by nobody in particular: the viewer who wants this step is
      // registered on it by whoever asked for it.
      consumerId: "",
      targetWidth: 0,
      targetHeight: height,
      // Floored onto the ten-second grid that session keys are bucketed to:
      // rounding is what that bucket does, and a position rounded UP starts the
      // run past the viewer, so the run just spawned is killed and restarted
      // before it has produced anything.
      startPositionSeconds: Math.floor(startSeconds / 10) * 10,
      audioTrackIndex: this.#flatAudioTrackOf(base),
      // A rung is produced at exactly the size it names and the realtime budget
      // does not move it — otherwise two rungs could drift onto the same height
      // and the choice between them would mean nothing. True of EVERY rung,
      // including one the player moved itself onto.
      exactSize: true,
      // Whose request this is decides whether an output already here may serve
      // it: a size picked by hand is served exactly, the automatic choice by the
      // quality rules. A viewer whose page does not say is taken as picking.
      servingMode: mode,
      viewerLinkMbps: linkMbps,
      // A limit named outright, or null for the rule to choose one. Named, it
      // is answered with that limit or not at all (`output-format.js`).
      capKbps,
      // The soundtrack THIS viewer hears, which is part of what their link
      // has to carry and need not be the one the picture was opened with.
      viewerAudio: this.#viewerAudioOf(base, consumerId),
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
    };
  }

  /**
   * Begin moving this viewer onto another output of the height on their
   * screen, at another bitrate limit (roadmap item 97, step 12).
   *
   * THE ADDRESS DOES NOT CHANGE. Their player goes on asking `v/<height>/…`;
   * what changes is which output this side answers that address with, and it
   * changes only once the segment they will ask for next is closed on the new
   * output (`noteSegmentPublished`). Until then they are given what they were
   * given, so a move that never completes costs them nothing.
   *
   * WHAT IS MOVED BETWEEN: outputs of the same material and the same produced
   * size whose bounds are two neighbouring limits of `limitsFor(frame)` — the
   * row of the frame on screen, chosen by its area, the same row the output was
   * opened in (`output-format.js`). Down,
   * the highest lower limit their link admits; up, the next limit only, and
   * only if their link admits it. A copy has no limit and a hardware encode is
   * given none, so neither has anywhere to move to here, and the caller's other
   * lever — another height — is what remains.
   *
   * The output prepared may be one another viewer is already watching at that
   * limit: it is found by its key, and opening an output that exists returns it.
   *
   * @param {HlsSession} named - The output the browser addresses.
   * @param {string} consumerId
   * @param {"down" | "up"} direction
   * @param {string} reasonText - Why, for the log.
   * @returns {Promise<{ started: boolean, reason: string, noPlace?: boolean }>}
   *   `noPlace` when the refusal is the machine's: it holds no more encoders.
   */
  async prepareSameHeightSwitch(named, consumerId, direction, reasonText) {
    const base = named ? this.#host.outputs.pictureOf(named) : null;
    const refuse = (reason) => ({ started: false, reason });
    if (!consumerId || !base) {
      return refuse("nobody named, or no picture");
    }
    // Only a master's variants go through the choice: without one, the player
    // addresses a single output by name and there is nothing to answer with
    // anything else.
    if (!this.#host.outputs.publishesVariants(base)) {
      return refuse("this stream publishes no variants");
    }
    if (this.#host.sameHeightSwitchOf(consumerId)) {
      return refuse("a move is already being prepared for this viewer");
    }
    const current = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
    const encode = current?.spec?.video?.encode ?? null;
    if (!encode || !encode.rateControl) {
      return refuse("the output on screen has no limit to change (a copy, or a hardware encode)");
    }
    const askedHeights = this.#host.heightsChosenAs(consumerId, current.outputKey ?? "");
    if (askedHeights.length === 0) {
      return refuse("no height is chosen as the output on screen");
    }
    const limits = this.#host.limitsFor({ width: encode.width, height: encode.height });
    const at = limits.findIndex((limit) => maxrateKbpsFor(limit) === encode.rateControl.maxrateKbps);
    if (at < 0) {
      return refuse(`the limit on screen (maxrate ${encode.rateControl.maxrateKbps}k) is not one of ${encode.height}p's`);
    }
    const linkMbps = this.#host.linkMbpsOf(base, consumerId);
    const audioLoad = this.viewerAudioLoadOf(base, consumerId);
    const admits = (limit) => linkCouldCarry(linkMbps, loadOf(videoLoadOfLimit(limit), audioLoad)).admitted;
    const target = direction === "down"
      ? limits.slice(at + 1).find(admits)
      : (at > 0 && admits(limits[at - 1]) ? limits[at - 1] : undefined);
    if (target === undefined) {
      return refuse(direction === "down"
        ? `no lower limit of ${encode.height}p is admitted by this viewer's link`
        : `no higher limit of ${encode.height}p is admitted by this viewer's link, or ${encode.height}p is at its highest`);
    }
    let prepared;
    try {
      prepared = await this.#host.createOrGetSession(this.#stepOpening(base, {
        height: encode.height,
        startSeconds: this.#host.viewerPositionOf(base.id, consumerId),
        // Exactly the size on screen: a move between limits never changes it,
        // and an automatic answer could.
        mode: "manual",
        linkMbps,
        consumerId,
        capKbps: target
      }));
    } catch (error) {
      if (error?.code === OUTPUT_UNAVAILABLE) {
        return refuse(`the ${target}kbps output of ${encode.height}p does not suit this viewer: ${error.details?.reason ?? ""}`);
      }
      throw error;
    }
    // The picture and the viewer may both have moved while it was being made.
    if (!this.#host.encodeRuns.isLive(base) || !prepared) {
      return refuse("the picture ended while the output was being made");
    }
    const preparedEncode = prepared.spec?.video?.encode ?? null;
    if (
      prepared === current ||
      preparedEncode?.height !== encode.height ||
      preparedEncode?.width !== encode.width ||
      preparedEncode?.rateControl?.maxrateKbps !== maxrateKbpsFor(target) ||
      !isSameMaterial(prepared.spec, base.spec)
    ) {
      return refuse(`what was opened (${prepared.outputKey}) is not ${encode.height}p at ${target}kbps of this picture`);
    }
    // An output whose encoding has failed for good will close no segment, so a
    // move onto it would wait for ever — and, cancelled on that failure, be
    // prepared again on the next budget pass, once per cooldown.
    if (this.#host.encodeRuns.hasFailed(prepared)) {
      return refuse(`encoding ${prepared.outputKey} has failed`);
    }
    if (this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs }) !== current ||
      this.#host.sameHeightSwitchOf(consumerId)) {
      return refuse("the output on this viewer's screen changed while the move was being prepared");
    }
    // A PLACE ON THIS MACHINE, asked before anything is recorded and in the same
    // synchronous stretch as the record (roadmap item 97, step 13). Two moves
    // onto two different outputs cannot then both be told there is room for
    // one: the second is asked after the first is written, and is counted.
    // Refused, nothing is recorded, and the caller goes to its other lever.
    const place = this.#host.admitsPreparation(prepared);
    if (!place.admitted) {
      await this.#letGoIfNobodyIsOn(prepared, `a move onto it was refused a place: ${place.reason}`);
      // Said as its own kind of refusal: "no limit to move to" sends the budget
      // to another height, and "no place on the machine" must not send it UP,
      // where the encoder would cost more still.
      return { ...refuse(`the machine has no place for ${prepared.outputKey}: ${place.reason}`), noPlace: true };
    }
    // A STEP OF THIS PICTURE, as any step made for a height is: without it the
    // output is a picture of its own, `pictureOf` answers with it rather than
    // with the picture, and the choice about to point at it is looked up among
    // this picture's steps and not found.
    if (prepared !== base) {
      prepared.variantHeight ??= encode.height;
      this.#host.outputs.markStep(prepared);
    }
    this.#host.noteSameHeightSwitch(consumerId, {
      askedHeights,
      outputId: prepared.id,
      outputKey: prepared.outputKey ?? "",
      direction,
      reason: reasonText,
      since: Date.now()
    });
    // On it for as long as the move is prepared: that is what buys it an
    // encoder, from where they stand. `watches` and not `placeOn`: a viewer is
    // one record whose position is already known, and placing them again would
    // restate it and clear the cushion they reported with it.
    this.#host.watches(prepared, consumerId);
    this.#host.planEncodersSoon();
    this.#host.logger.info(
      `transcode ${base.id} preparing ${consumerId}'s move ${direction} from ${current.outputKey} to ` +
      `${prepared.outputKey} (${encode.height}p, ${target}kbps): ${reasonText}`
    );
    // It may already be made there — another viewer on it, or material kept.
    this.#reconsiderSameHeightSwitch(base, consumerId, null);
    const active = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
    if (active === prepared || this.#host.sameHeightSwitchOf(consumerId)) {
      return { started: true, reason: "" };
    }
    return refuse("the prepared output was not usable for this viewer");
  }

  /**
   * Whether a move to another limit is being prepared for this viewer.
   *
   * @param {string} consumerId
   * @returns {boolean}
   */
  sameHeightSwitchPending(consumerId) {
    return Boolean(this.#host.sameHeightSwitchOf(consumerId));
  }

  /**
   * Which way the move being prepared for this viewer goes, or null.
   *
   * @param {string} consumerId
   * @returns {"down" | "up" | null}
   */
  sameHeightSwitchDirection(consumerId) {
    return this.#host.sameHeightSwitchOf(consumerId)?.direction ?? null;
  }

  /**
   * Stop preparing this viewer's move, for a reason the quality budget found:
   * the conditions a move up was started under have gone back (roadmap item
   * 98).
   *
   * @param {string} consumerId
   * @param {string} reason
   * @returns {void}
   */
  cancelSameHeightSwitch(consumerId, reason) {
    const move = consumerId ? this.#host.sameHeightSwitchOf(consumerId) : null;
    const prepared = move ? this.#host.outputs.get(move.outputId) : null;
    if (!move || !prepared) {
      if (move) {
        this.#host.noteSameHeightSwitch(consumerId, null);
      }
      return;
    }
    this.#cancelSameHeightSwitch(this.#host.outputs.pictureOf(prepared), consumerId, reason);
  }

  /**
   * Whether a step of this picture at `height` is READY for this viewer: it
   * exists and the piece they will ask for next is closed on it (roadmap item
   * 98). Ready means that piece — not the whole film.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {number} height
   * @returns {boolean}
   */
  heightReadyFor(base, consumerId, height) {
    const step = this.#interchangeableWith(base, base.spec)
      .find((output) => this.#host.outputs.variantHeightOf(output) === height);
    if (!step) {
      return false;
    }
    const current = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
    const askedHeights = current ? this.#host.heightsChosenAs(consumerId, current.outputKey ?? "") : [];
    const next = this.#nextSegmentOf(base, consumerId, askedHeights, step);
    return next < step.timeline.segmentCount && this.#host.segmentClosed(step.outputKey ?? "", next);
  }

  /**
   * A segment was closed on some output. If a viewer's move is being prepared
   * onto it, whether that move can be made now is asked again.
   *
   * Told by `SegmentStore.onPublished`, and nothing here polls: a move waits
   * for exactly the event that makes it possible.
   *
   * @param {string} key - The output the segment was closed on.
   * @param {number} index
   * @returns {void}
   */
  noteSegmentPublished(key, index) {
    if (!key) {
      return;
    }
    for (const output of this.#host.outputs.values()) {
      if (output.outputKey !== key) {
        continue;
      }
      const base = this.#host.outputs.pictureOf(output);
      for (const consumerId of this.#host.switchingOnto(output)) {
        this.#reconsiderSameHeightSwitch(base, consumerId, index);
      }
    }
  }

  /**
   * A viewer reported on themselves. If a move is being prepared for them,
   * whether it is still wanted is asked again.
   *
   * WHY THIS EVENT. A publication is the only other one, and it comes only
   * from an output that is producing. A move waiting on an output that closes
   * nothing would otherwise stand for ever: a link that recovered would not
   * cancel it, and the quality budget, which leaves alone a viewer with a move
   * being prepared, would never decide for them again. The report is what
   * carries a change of their link, so it is where that change is judged.
   *
   * The move can also be made here, and only on the condition every other
   * trigger uses: the segment they will ask for next is closed on the new
   * output. The report changes when the question is asked, not its answer.
   *
   * @param {string} sessionId - The output the page addressed.
   * @param {string} consumerId
   * @returns {void}
   */
  noteViewerReported(sessionId, consumerId) {
    const move = consumerId ? this.#host.sameHeightSwitchOf(consumerId) : null;
    if (!move) {
      return;
    }
    // The picture the move belongs to, read from the output being prepared: the
    // page may address a picture of another film, and a move is about one.
    const prepared = this.#host.outputs.get(move.outputId);
    const named = prepared ?? (sessionId ? this.#host.outputs.get(sessionId) : null);
    const base = named ? this.#host.outputs.pictureOf(named) : null;
    if (!base) {
      return;
    }
    this.#reconsiderSameHeightSwitch(base, consumerId, null);
  }

  /**
   * Encoding an output has failed for good. Every move being prepared onto it
   * is asked again, which cancels it: nothing will close the segment it waits
   * for, and no publication will come to say so.
   *
   * Told by `EncodeRuns` at the moment the failure is recorded.
   *
   * @param {HlsSession} output
   * @returns {void}
   */
  noteProductionFailed(output) {
    if (!output) {
      return;
    }
    const base = this.#host.outputs.pictureOf(output);
    for (const consumerId of this.#host.switchingOnto(output)) {
      this.#reconsiderSameHeightSwitch(base, consumerId, null);
    }
  }

  /**
   * The segment this viewer will ask for next at these heights.
   *
   * Their player fetches one level's segments in order within one viewing, so
   * the next is one past the highest they were given in the viewing they are in
   * NOW. Given nothing yet in it — straight after a seek — the next is the one
   * where they stand. Read at the moment of asking, so a decision taken on an
   * event that arrived late is taken about where they are.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {number[]} askedHeights
   * @param {HlsSession} prepared
   * @returns {number}
   */
  #nextSegmentOf(base, consumerId, askedHeights, prepared) {
    const highest = Math.max(-1, ...askedHeights.map((height) => this.#host.highestGivenSegmentOf(consumerId, height)));
    if (highest >= 0) {
      return highest + 1;
    }
    return this.#host.outputTimes.segmentIndexForTime(prepared, this.#host.viewerPositionOf(base.id, consumerId));
  }

  /**
   * Make the move being prepared for this viewer, if it can be made now; cancel
   * it, if it should not be made at all; otherwise leave it waiting.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {number | null} publishedIndex - The segment whose closing caused
   *   this, or null when asked for no event in particular.
   * @returns {void}
   */
  #reconsiderSameHeightSwitch(base, consumerId, publishedIndex) {
    const move = this.#host.sameHeightSwitchOf(consumerId);
    if (!move) {
      return;
    }
    const prepared = this.#host.outputs.get(move.outputId);
    if (!prepared || prepared.outputKey !== move.outputKey) {
      this.#cancelSameHeightSwitch(base, consumerId, "the output being prepared has gone");
      return;
    }
    const current = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
    if (current === prepared) {
      this.#host.noteSameHeightSwitch(consumerId, null);
      return;
    }
    if (this.#host.encodeRuns.hasFailed(prepared)) {
      this.#cancelSameHeightSwitch(base, consumerId, "encoding the output being prepared has failed");
      return;
    }
    if (!this.#suitsViewer(prepared, base, consumerId).suits) {
      this.#cancelSameHeightSwitch(base, consumerId, "the output being prepared no longer suits this viewer's link");
      return;
    }
    if (move.direction === "down" && this.#suitsViewer(current, base, consumerId).suits) {
      this.#cancelSameHeightSwitch(base, consumerId, "this viewer's link carries the output on screen again");
      return;
    }
    const next = this.#nextSegmentOf(base, consumerId, move.askedHeights, prepared);
    if (next >= prepared.timeline.segmentCount) {
      this.#cancelSameHeightSwitch(base, consumerId, "there is nothing left of the film to give from it");
      return;
    }
    // A segment closed BEHIND the one they will ask for says nothing about it:
    // the move would hand them an output that does not yet have what they need.
    if (publishedIndex !== null && publishedIndex < next) {
      return;
    }
    if (!this.#host.segmentClosed(prepared.outputKey ?? "", next)) {
      return;
    }
    // THE CUSHION, for a move that is not urgent (roadmap item 98): a move up
    // is made once the viewer holds the cushion this file needs, and their
    // next report asks again until they do. A move DOWN is made at once — it
    // was started because their buffer would run dry, and a cushion that is
    // shrinking would be waited for for ever. A file with no cushion stated has
    // none to wait for.
    if (move.direction !== "down") {
      const needed = this.#host.minimumBufferSecondsFor(prepared);
      if (Number.isFinite(needed) && needed > 0 && this.#host.bufferedSecondsOf(consumerId) < needed) {
        return;
      }
    }
    // The player fetches the fMP4 init once and decodes every later fragment
    // against it. Changing bitrate outputs is safe only when the prepared
    // output's init says the same thing to that decoder. The new segment is
    // closed here, so its init is available for this check. MPEG-TS has no init
    // and is self-contained, so it does not use this gate.
    if (
      current &&
      current.outputKey !== prepared.outputKey &&
      current.segmentFormat?.initFileName !== null &&
      prepared.segmentFormat?.initFileName !== null
    ) {
      const verdict = this.#host.headersCompatible(current.outputKey, prepared.outputKey);
      if (verdict?.compatible !== true) {
        const differences = verdict?.differences?.join("; ") || "the headers are missing or incompatible";
        this.#cancelSameHeightSwitch(base, consumerId, `the prepared output has an incompatible init: ${differences}`);
        return;
      }
    }
    this.#completeSameHeightSwitch(base, consumerId, move, prepared, current, next);
  }

  /**
   * The move itself.
   *
   * ONE SYNCHRONOUS STRETCH, with no `await` anywhere in it. The choice, the
   * output on screen and where the viewer is registered are three records of
   * one fact, and a suspension between them would let a request be answered by
   * the new choice while the viewer is still registered only on the old output,
   * or the plan run on the old output's map with the viewer already gone from
   * the choice.
   *
   * THE OUTPUT LEFT IS NOT DISPOSED. The viewer stops watching it, its priority
   * map loses them, and the plan stops its encoder when nobody is left on it;
   * the output itself goes by the ordinary idle expiry, which keeps it while an
   * assignment stands — a response still being sent from it, or a segment of it
   * given in a viewing still inside its window. A repeat of such an address is
   * answered by it, because `given` is read before `chosen`.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {{ askedHeights: number[], direction: string, reason: string }} move
   * @param {HlsSession} prepared
   * @param {HlsSession} current
   * @param {number} next
   * @returns {void}
   */
  #completeSameHeightSwitch(base, consumerId, move, prepared, current, next) {
    for (const height of move.askedHeights) {
      this.#choose(consumerId, height, prepared, base);
    }
    this.#host.noteStepOnScreen(base, consumerId, prepared.id);
    this.#host.watches(prepared, consumerId);
    // The picture is never left: their soundtrack and their position are
    // recorded on it (`#noteVariantActive`).
    if (current !== base) {
      this.#host.viewerLeaves(current, consumerId);
    }
    this.#host.noteSameHeightSwitch(consumerId, null);
    this.#host.planEncodersSoon();
    // How long this move took to be ready, and what the viewer held when it
    // happened — kept for the next time this host decides when to start one.
    if (Number.isFinite(move.since)) {
      this.#host.notePreparation?.(prepared, (Date.now() - move.since) / 1000, this.#host.bufferedSecondsOf(consumerId));
    }
    this.#host.logger.info(
      `transcode ${base.id} moved ${consumerId} ${move.direction} from ${current.outputKey} to ` +
      `${prepared.outputKey} from segment #${next}: ${move.reason}`
    );
  }

  /**
   * Stop preparing this viewer's move.
   *
   * They stop watching the output being prepared — unless it is the one on
   * their screen or the picture itself — and nothing else: whether its encoder
   * goes on is the plan's, from who is left on it, and the output itself goes
   * by the idle expiry.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {string} reason
   * @returns {void}
   */
  #cancelSameHeightSwitch(base, consumerId, reason) {
    const move = this.#host.sameHeightSwitchOf(consumerId);
    if (!move) {
      return;
    }
    this.#host.noteSameHeightSwitch(consumerId, null);
    const prepared = this.#host.outputs.get(move.outputId);
    const current = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
    if (prepared && prepared !== current && prepared !== base) {
      this.#host.viewerLeaves(prepared, consumerId);
    }
    // The place the move held on this machine ended with its record, so what
    // may run elsewhere has changed whether or not anybody left an output.
    this.#host.planEncodersSoon();
    this.#host.logger.info(`transcode ${base.id} ${consumerId}'s move to ${move.outputKey} cancelled: ${reason}`);
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
  /**
   * Let go of an output this call has finished with — unless somebody is on it.
   *
   * WHY IT IS ASKED AT THE MOMENT OF LETTING GO, and not decided in advance.
   * Two of these disposals reasoned "nobody is on it yet", and neither could
   * know it. An output is addressed by what it PRODUCES, so opening one returns
   * the output that already makes that picture whenever there is one: what came
   * back may be a step another viewer has been watching for an hour. And even a
   * genuinely new one is only new for as long as nothing else has reached it —
   * making a step takes a probe and a keyframe index, seconds in which a second
   * viewer can ask for the same height and be registered onto it.
   *
   * So the question is the registry's, asked now: is anybody watching this. A
   * step nobody is on is stopped by the plan on its next pass anyway, because
   * its priority map is empty; what must never happen is taking away an output
   * somebody is watching, which stops their encoder and empties their screen.
   *
   * @param {HlsSession} output
   * @param {string} because
   * @returns {Promise<boolean>} Whether it went.
   */
  async #letGoIfNobodyIsOn(output, because) {
    // NOBODY WATCHING IS NOT THE WHOLE QUESTION. A response already begun is
    // still being sent from this output, and a request made moments ago may
    // still be repeated and has to be answered by whatever answered it first.
    // Both stand after the last viewer has stopped being registered on it.
    if (this.#host.outputStillNeeded(output)) {
      this.#host.logger.info(
        `transcode ${output.id} kept although ${because}: ` +
        `${this.#host.viewerCountOn(output)} viewer(s) watching it, and assignments may still stand`
      );
      return false;
    }
    this.#host.logger.info(`transcode ${output.id} disposed: ${because}`);
    await this.#host.disposeSession(output.id);
    return true;
  }

  /**
   * The outputs of this picture that could stand in for `spec` — the same
   * material, so interchangeable as far as anything but picture size goes.
   *
   * ONE RULE, ASKED BY EVERY PATH THAT PICKS AN OUTPUT. Two of them used to
   * gather the family for themselves, and only one checked the material: a
   * 720p step in MPEG-TS could be found by produced height and handed to a
   * picture cut for fMP4, whose player cannot even ask for its segment names.
   * Fixing the one path left the other open inside the same operation, which
   * is why the rule is stated here rather than at each caller.
   *
   * The picture itself is filtered like any other member. It passes trivially
   * when compared against its own identity, and comparing it is what makes
   * this one rule instead of two.
   *
   * @param {HlsSession} base
   * @param {import("./output/OutputSpec.js").OutputSpec} spec - What the
   *   candidate must be interchangeable WITH: the picture's own identity when
   *   answering for a height, the created output's when replacing it.
   * @returns {HlsSession[]}
   */
  #interchangeableWith(base, spec) {
    return [base, ...this.#host.outputs.stepsOf(base)]
      .filter((other) => other && isSameMaterial(other.spec, spec));
  }

  /**
   * The output that answered this address for this viewer earlier in the same
   * generation, if it is still here and still interchangeable with the picture.
   *
   * An answer whose output has gone — disposed on a hardware encoder's failure,
   * the one disposal that does not ask the assignments — is no answer, and the
   * address is decided afresh.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @param {number} generation
   * @param {number} height
   * @param {number} segmentIndex - −1 for the init.
   * @returns {{ state: "none" } | { state: "live", output: HlsSession } | { state: "gone", key: string }}
   */
  #givenBefore(base, consumerId, generation, height, segmentIndex) {
    const key = this.#host.givenOutputOf(consumerId, generation, height, segmentIndex);
    if (!key) {
      return { state: "none" };
    }
    const output = this.#interchangeableWith(base, base.spec).find((other) => other.outputKey === key) ?? null;
    return output ? { state: "live", output } : { state: "gone", key };
  }

  /**
   * A repeat of an address whose output has gone.
   *
   * NEVER DECIDED AGAIN AS IF NEW. The player holds the header of the output
   * that answered this address; a piece of another output under the same
   * address may not decode under it. So, in order:
   *
   * 1. the very piece that was given, from what is stored under the gone
   *    output's key — its pieces and header outlive it until the disk needs the
   *    room;
   * 2. a piece of the output this viewer would be given now, but only when its
   *    header is PROVEN compatible with the gone one (`init-compat.js`);
   * 3. otherwise the address is lost, and the page is told so: it starts a new
   *    viewing where the picture is, which is the one way out that does not
   *    serve a piece under a header it may not match. Answering "retry" here
   *    instead would be answered the same way for ever.
   *
   * @param {HlsSession} base
   * @param {number} height
   * @param {string} fileName
   * @param {number} segmentIndex
   * @param {string} consumerId
   * @param {number} generation
   * @param {string} goneKey
   * @returns {Promise<{ sessionId: string | null, recover?: { key: string, likeId: string }, lost?: object, unavailable?: object, error?: string }>}
   */
  async #answerForLostAddress(base, height, fileName, segmentIndex, consumerId, generation, goneKey) {
    if (this.#host.storedPieceReady(goneKey, fileName)) {
      return { sessionId: null, recover: { key: goneKey, likeId: base.id } };
    }
    let current = null;
    try {
      current = await this.resolveVariantSession(base.id, height, segmentIndex, consumerId);
    } catch (error) {
      if (error?.code !== OUTPUT_UNAVAILABLE) {
        const message = error instanceof Error ? error.message : String(error);
        return { sessionId: null, error: message };
      }
    }
    const verdict = current ? this.#host.headersCompatible(goneKey, current.outputKey ?? "") : null;
    if (current && verdict?.compatible) {
      this.#host.placeViewerOn(current, consumerId, this.#host.viewerPositionOf(base.id, consumerId));
      this.#host.noteGivenOutput(consumerId, generation, height, segmentIndex, current.outputKey ?? "");
      this.#host.logger.info(
        `transcode ${base.id} ${fileName} for ${consumerId}: ${goneKey} has gone; served by ` +
        `${current.outputKey}, whose header is compatible with it`
      );
      return { sessionId: current.id };
    }
    const reason = current
      ? `the output that answered it has gone, and the one that would answer now has a header not proven compatible (${(verdict?.differences ?? []).join("; ") || "no header yet"})`
      : "the output that answered it has gone, and nothing that could answer now suits this viewer";
    this.#host.logger.info(`transcode ${base.id} ${fileName} for ${consumerId}: assignment lost — ${reason}`);
    return { sessionId: null, lost: { reason, goneKey, height, segmentIndex, generation } };
  }

  async #adoptIfAlreadyProduced(base, askedHeight, candidate, consumerId) {
    const produced = this.#host.outputs.producedHeightOf(candidate);
    if (produced <= 0) {
      return null;
    }
    const seen = new Set([candidate.id]);
    // The base belongs in this scan: it is a rung like any other, and when it
    // is itself a re-encode the clamp can land a variant right on top of it.
    // Compared against the CANDIDATE, because it is the candidate's place the
    // incumbent takes — the viewer asked for what the candidate is.
    for (const other of this.#interchangeableWith(base, candidate.spec)) {
      if (!other || seen.has(other.id)) {
        continue;
      }
      seen.add(other.id);
      if (this.#host.outputs.producedHeightOf(other) !== produced) {
        continue;
      }
      // THE SAME PICTURE IS NOT ENOUGH: it has to suit THIS viewer by the one
      // rule every path asks — their mode and a load their own link admits. Two
      // outputs of one size can differ in their limit, and the one already here
      // may be more than this viewer's link carries.
      const verdict = this.#suitsViewer(other, base, consumerId);
      if (!verdict.suits) {
        continue;
      }
      // Same picture, already being made. Let go of the one just created — if
      // it IS one, and if it is still nobody's.
      await this.#letGoIfNobodyIsOn(candidate, `${other.id.slice(0, 8)} already produces this picture`);
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
   * @param {number} [statedGeneration] - Which viewing of theirs the request was
   *   made in, as the page stamped it; NaN when it states none.
   * @returns {Promise<{ sessionId: string | null, error?: string }>} The session
   *   to serve the file from; a null id means there is no such variant.
   */
  async resolveVariantFile(baseSessionId, height, fileName, consumerId = "", statedGeneration = Number.NaN) {
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
    // THE ADDRESS OF THIS ANSWER: the height asked for and the segment, the
    // init being segment −1. Within one generation of this viewer's viewing a
    // repeat of the same address is answered by what answered it first — not
    // decided again, which could now name another output than the one whose
    // bytes the player already holds for it.
    // A step is asked for BY somebody; see resolveVariantSession.
    if (!consumerId) {
      return { sessionId: null };
    }
    const segmentIndex = isSegment ? base.segmentFormat.segmentIndexFromName(fileName) : -1;
    const generation = this.#host.generationOfRequest(consumerId, statedGeneration);
    const given = this.#givenBefore(base, consumerId, generation, height, segmentIndex);
    if (given.state === "live") {
      this.#host.outputs.touch(given.output);
      this.#host.placeViewerOn(given.output, consumerId, this.#host.viewerPositionOf(baseSessionId, consumerId));
      return { sessionId: given.output.id };
    }
    if (given.state === "gone") {
      return this.#answerForLostAddress(base, height, fileName, segmentIndex, consumerId, generation, given.key);
    }
    let variant;
    try {
      variant = await this.resolveVariantSession(
        baseSessionId,
        height,
        segmentIndex,
        // WHOSE REQUEST THIS IS. Whether an output already here may serve a
        // height depends on the asking viewer's mode, and this path dropped the
        // name: the request was then taken as a size picked by hand, which is
        // served exactly and reuses nothing. Whichever of the two paths creates
        // the step first decides for both, so an automatic viewer whose player
        // fetched before the warm-up finished got a second encoder where an
        // output already here would have served them.
        consumerId
      );
    } catch (error) {
      if (error?.code === OUTPUT_UNAVAILABLE) {
        return { sessionId: null, unavailable: error.details };
      }
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
    if (consumerId) {
      // The same circle as a soundtrack's: the init has to be made before a
      // segment can be asked for, and nothing is made for an output nobody is
      // watching. Asking for any of its files is watching it.
      this.#host.placeViewerOn(variant, consumerId, this.#host.viewerPositionOf(baseSessionId, consumerId));
      // Recorded AFTER placing them: a viewer this request is the first sign of
      // exists only from that moment, and a record kept for nobody is lost.
      this.#host.noteGivenOutput(consumerId, generation, height, segmentIndex, variant.outputKey ?? "");
    }
    // WHICH RUNG IS ON THE SCREEN IS NOT READ OFF THIS REQUEST. The page says
    // so itself (`viewerPlays`), the moment the player has switched: a request
    // for a rung's segment is the player fetching, and it used to be taken as
    // the person having moved.
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
  async prepareAudioTrack(baseSessionId, trackIndex, positionSeconds, consumerId) {
    const base = this.#host.outputs.get(baseSessionId);
    // A track is prepared FOR somebody; a request naming nobody prepares nothing.
    if (!consumerId || !base || !this.servesAudioSeparately(base)) {
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
    const stillWarming = this.#host.audioBeingWarmedOf(base, consumerId);
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
    this.#host.noteAudioBeingWarmed(base, consumerId, rendition.id);
    // Being prepared for them is watching it: it is made for this viewer, and
    // when they leave it must be let go with everything else of theirs.
    // Where the switch will land. An existing track was left wherever the
    // viewer last was on it; saying where they are now is the whole of pointing
    // it there, because the encoder follows the person and not the request.
    this.#host.placeOn(rendition, consumerId, positionSeconds);
    this.#host.planEncodersSoon();
    const index = this.#host.outputTimes.segmentIndexForTime(rendition, positionSeconds);
    return { sessionId: rendition.id, fileName: rendition.segmentFormat.segmentFileName(index) };
  }

  async prepareVariant(baseSessionId, height, positionSeconds, consumerId) {
    // A step is warmed FOR somebody; a request naming nobody warms nothing.
    if (!consumerId || !isOutputName(baseSessionId)) {
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
    const stillWarming = this.#host.stepBeingWarmedOf(base, consumerId);
    if (stillWarming && stillWarming !== variant.id) {
      const abandoned = this.#host.outputs.get(stillWarming);
      if (abandoned && !this.#host.quality.variantsOnScreen(base).has(abandoned.id)) {
        this.#host.viewerLeaves(abandoned, consumerId);
      }
    }
    // The base is not a rung being prepared for anybody — it is what the family
    // is named by — so warming its own height leaves nothing outstanding.
    if (variant.id === base.id) {
      this.#host.noteStepBeingWarmed(base, consumerId, null);
    } else {
      const onScreen = this.#host.activeOutputFor({ base, consumerId, outputs: this.#host.outputs });
      if (variant.id !== onScreen.id) {
        // A PLACE ON THIS MACHINE (roadmap item 97, step 13). The step warmed
        // before this one stops holding its place first — the viewer asked for
        // another rung, so it is no longer theirs to wait for — and then the
        // place is asked for, in the same synchronous stretch as the record is
        // written. Refused, nothing is recorded: the rung on screen goes on
        // playing and the page is told why.
        this.#host.noteStepBeingWarmed(base, consumerId, null);
        const place = this.#host.admitsPreparation(variant);
        if (!place.admitted) {
          this.#host.logger.info(
            `transcode ${base.id} warming ${height}p for ${consumerId} refused a place: ${place.reason}`
          );
          const error = new Error(`No place on this machine for ${height}p: ${place.reason}.`);
          error.code = OUTPUT_UNAVAILABLE;
          error.details = {
            reason: `this machine cannot encode ${height}p beside what it already encodes`,
            figures: { machineSpeedX: place.speedX, height }
          };
          throw error;
        }
      }
      this.#host.noteStepBeingWarmed(base, consumerId, variant.id);
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
      this.#host.placeOn(variant, consumerId, this.#host.outputTimes.segmentStartTime(base, index));
      this.#host.planEncodersSoon();
    }
    this.#host.logger.info(
      `transcode ${base.id} warming ${height}p at ${positionSeconds.toFixed(1)}s (segment #${index})`
    );
    return { sessionId: variant.id, fileName: variant.segmentFormat.segmentFileName(index) };
  }

  /**
   * The rung this viewer's player is playing, as the page states it.
   *
   * The page says so when the player has switched (`LEVEL_SWITCHED`), with the
   * height of that rung and where the picture is. A rung this proxy has not
   * made is not one the player can be playing, so a height with no output
   * behind it changes nothing.
   *
   * @param {string} baseSessionId - The output the browser addresses.
   * @param {string} consumerId
   * @param {number} height
   * @param {number} [positionSeconds] - Where the picture is, when stated.
   * @returns {boolean} Whether a rung was found for that height.
   */
  viewerPlays(baseSessionId, consumerId, height, positionSeconds) {
    const named = this.#host.outputs.get(baseSessionId);
    if (!consumerId || !named || !(height > 0)) {
      return false;
    }
    const base = this.#host.outputs.pictureOf(named);
    // THE CHOICE ALREADY MADE for this viewer at that height, read and never
    // made here: the page names a height, and a height does not say which of
    // two limits the viewer was given.
    const rung = this.servingOutputFor(base, height, consumerId);
    if (!rung) {
      return false;
    }
    this.#noteVariantActive(base, rung, positionSeconds, consumerId);
    return true;
  }

  /**
   * Record which variant the viewer is watching, and give it the encoder.
   *
   * The person is put on the new rung where their picture is, because a
   * segment request steers no encoder and a rung that was watched a minute ago
   * is parked wherever it was left.
   *
   * @param {HlsSession} base
   * @param {HlsSession} variant
   * @param {number} [positionSeconds] - Where the picture is, as the page
   *   stated it with the switch.
   * @param {string} [consumerId] - Which viewer moved.
   * @returns {void}
   */
  #noteVariantActive(base, variant, positionSeconds, consumerId) {
    // Which step is on a screen is a fact about a PERSON: a request that names
    // nobody, or names the family itself, says nothing about any screen.
    if (!consumerId) {
      return;
    }
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
    // Their player has moved to another rung, so a move between limits of the
    // one they were on is for a height they have left.
    this.#cancelSameHeightSwitch(base, consumerId, "the player moved to another rung");
    // A rung is being left, so whatever was warmed is decided: either it is the
    // rung now being switched to, or the viewer went somewhere else and it must
    // stop like any other rung nobody is watching. Nothing else would ever stop
    // it — only the rung being LEFT is stopped below.
    const warmed = this.#host.stepBeingWarmedOf(base, consumerId);
    const warmedSince = this.#host.stepBeingWarmedSinceOf?.(base, consumerId) ?? null;
    this.#host.noteStepBeingWarmed(base, consumerId, null);
    // The step warmed for this viewer is the one they moved onto: how long it
    // took, and what they held when they moved.
    if (warmed === variant.id && Number.isFinite(warmedSince)) {
      this.#host.notePreparation?.(variant, (Date.now() - warmedSince) / 1000, this.#host.bufferedSecondsOf(consumerId));
    }
    if (warmed && warmed !== variant.id && warmed !== previous.id) {
      const abandoned = this.#host.outputs.get(warmed);
      if (abandoned && !this.#host.quality.variantsOnScreen(base).has(abandoned.id)) {
        this.#host.viewerLeaves(abandoned, consumerId);
      }
    }
    const position = this.#variantStartSeconds(base, positionSeconds, consumerId);
    this.#host.noteStepOnScreen(base, consumerId, variant.id);
    // The step is an output of this viewer's now.
    this.#host.watches(variant, consumerId);
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
      this.#host.invalidateWaits(previous);
    }
    if (position > 0) {
      // The rung being switched TO, named literally: a warm-up may have left
      // the family pointing elsewhere, and forwarding would move that one
      // instead. Saying where this person is on it is the whole of pointing its
      // encoder there.
      this.#host.placeOn(variant, consumerId, position);
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
      readWindowBytes: this.#host.encodeRuns.readWindowFor(session),
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
    if (rendition && consumerId) {
      // Asking for ANY file of this soundtrack is this viewer watching it, and
      // the init is the file they ask for first. Registered here rather than on
      // the segment alone, because the segment cannot be asked for until the
      // init has been served, and the init cannot be made unless somebody is
      // watching: that circle is what left a soundtrack with no encoder, no
      // init and a viewer waiting sixty seconds on 2026-09-05.
      //
      // WHERE they are on it is where they are on the picture: the two are
      // played together.
      this.#host.placeViewerOn(rendition, consumerId, this.#host.viewerPositionOf(base.id, consumerId));
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
   * @param {string} consumerId - Who is listening. A request that names
   *   nobody changes nobody's track.
   */
  #noteAudioTrackActive(base, trackIndex, consumerId) {
    if (!consumerId) {
      return;
    }
    const previous = this.#audioChoiceOf(base, consumerId);
    if (previous.trackIndex === trackIndex) {
      return;
    }
    this.#host.chooseAudioTrack(base, consumerId, { ...previous, trackIndex });
    // Every soundtrack nobody present is listening to any more stops being
    // waited on.
    const wanted = this.#liveAudioRenditionKeys(base);
    for (const other of this.#host.outputs.renditionsOf(base)) {
      if (wanted.has(audioRenditionKey(this.#flatAudioTrackOf(other), other.spec.transcodesAudio))) {
        continue;
      }
      // Requests held on it are for segments nobody will produce now, and the
      // player stopped waiting for them the moment it changed track.
      if (this.#host.encodeRuns.liveRunsOf(other).length > 0) {
        this.#host.invalidateWaits(other);
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
      for (const consumerId of this.#host.presentOn(member)) {
        live.add(consumerId);
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
    const stated = this.#host.audioChoiceOf(base, consumerId);
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
    for (const consumerId of this.#host.consumersOn(base)) {
      const choice = this.#audioChoiceOf(base, consumerId);
      // A viewer counts while some session of the family has heard from them.
      if (live.size > 0 && !live.has(consumerId)) {
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
      // Opened by nobody in particular, as a step is.
      consumerId: "",
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
      name: typeof entry.fileName === "string" ? entry.fileName : "",
      // The rate the file states for this track, or null; what a viewer's link
      // is asked to carry for it when it is copied.
      bitrateKbps: Number.isFinite(entry.bitrateKbps) ? entry.bitrateKbps : null
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
   * Where a person stands when they come onto a rung, in seconds.
   *
   * A stated position when there is one — the picture's, sent with the switch,
   * or the start of the segment the player asked a new rung for. Otherwise the
   * position they have stated on the rung they are on. Never the rung's READ
   * head, which sits a whole buffer further on.
   *
   * @param {HlsSession} base
   * @param {number} [positionSeconds] - A stated position, when there is one.
   * @param {string} [consumerId]
   * @returns {number}
   */
  #variantStartSeconds(base, positionSeconds, consumerId = "") {
    if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
      return positionSeconds;
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
