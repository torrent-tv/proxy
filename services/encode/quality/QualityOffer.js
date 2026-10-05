/**
 * @file Which heights this file is offered at, and what identifies that answer.
 *
 * `EncodeCost` says what each height WOULD cost this machine. This says which
 * of them are on the menu — which needs three more things that are nothing to
 * do with arithmetic: whose answer it is (a step knows only its own encode, so
 * the family's picture answers for all of them), what may never be withdrawn
 * (a height a live viewer has on screen), and when the answer may be reused.
 *
 * **The reuse is why this is an object and not a function.** The offer is asked
 * for on the path that serves every playlist, every init and every segment, and
 * it walks the whole ladder to answer. So it is settled once and kept — and
 * then EVERYTHING it was derived from has to be in what identifies it, or the
 * menu is pinned to what was computed before anything had been measured. Each
 * term of that key is there because leaving it out was, at some point, a menu
 * that went stale: what the file costs to decode, which heights are on screen,
 * what copying costs, what the torrent costs, what the soundtrack costs, how
 * many encoders are running, what each of them was last seen doing, the speed
 * this file's own supply demands, and the megabytes a second it moves.
 *
 * What it is handed, and why each is passed rather than reached for: the
 * arithmetic (`EncodeCost`), which sessions belong to one file (`outputs`),
 * which heights a live viewer has on screen — a list of numbers, so the viewer
 * layer does not travel — and what the swarm is doing with this file, as three
 * readings. None of it needs a session manager, a torrent or a disk.
 */

import { variantHeightsFor } from "../output/ladder.js";
import { videoLoadForFrame } from "./link-budget.js";
import { chooseOutputFps, computeOutputDimensions, TRANSCODE_FPS } from "../args.js";
import { processCanBeSignalled } from "../encode-run-state.js";
import { sourceDecodeCharacteristics } from "../../media/SourceFile.js";
import { qualityStateOf } from "./OutputQualityState.js";

export class QualityOffer {
  #cost;
  #outputs;
  #heightsOnScreen;
  #supplyFor;
  #stateFor;
  #occupancyKnownFor;

  /**
   * @param {{
   *   encodeCost: import("./EncodeCost.js").EncodeCost,
   *   outputs: import("../output/OutputCatalog.js").OutputCatalog,
   *   heightsOnScreen: (owner: object) => number[],
   *   supplyFor: (file: object) => { requiredSpeed: number | null, megabytesPerSecond: number | null, costPerMegabyte: number | null },
   *   stateFor: (output: object) => string,
   *   occupancyKnownFor: (fileKey: string | null) => boolean
   * }} deps
   */
  /** @type {(fileKey: string | null) => number} */
  #occupiedCostSec;

  constructor({
    encodeCost,
    outputs,
    heightsOnScreen = () => [],
    supplyFor = () => ({ requiredSpeed: null, megabytesPerSecond: null, costPerMegabyte: null }),
    stateFor,
    // WHAT THIS MACHINE IS ALREADY SPENDING, in seconds of work per second of
    // film, on everything that holds a place on it except the file asked
    // about (roadmap item 97, step 14). A question about a file this host does
    // not yet serve is priced BESIDE that, so the pool is not sent to a
    // machine whose every place is taken. Handed in as a number: the admission
    // owns what holds a place.
    occupiedCostSec = () => 0,
    // Whether every other output holding a place has a measured price. The
    // pool must not be told this host can serve a file while existing work is
    // unpriced (roadmap item 97, step 14).
    occupancyKnownFor = () => true
  }) {
    this.#occupiedCostSec = occupiedCostSec;
    this.#occupancyKnownFor = occupancyKnownFor;
    this.#cost = encodeCost;
    this.#outputs = outputs;
    // WHICH HEIGHTS A LIVE VIEWER HAS ON SCREEN. A height is never withdrawn
    // while somebody is watching it — their next segment would 404 on a stream
    // that is playing — and who is watching what belongs to the viewer layer,
    // so it arrives as a list of numbers and nothing else.
    this.#heightsOnScreen = heightsOnScreen;
    // WHAT THE SWARM IS DOING WITH THIS FILE: the speed its own interruptions
    // demand, how many megabytes a second a viewer draws through it, and what a
    // megabyte costs this process. Three readings taken by whoever reads the
    // file; here they are three numbers.
    this.#supplyFor = supplyFor;
    if (typeof stateFor !== "function") {
      throw new TypeError("QualityOffer requires stateFor");
    }
    this.#stateFor = stateFor;
  }

  /**
   * The heights this session's file is offered at, largest first.
   *
   * The base session's OWN height is always among them, even when it is not a
   * ladder rung: it is whatever the realtime budget and the viewer's viewport
   * settled on, and an encoder is already producing it. Leaving it out would
   * mean the player, on loading the master, immediately asks for a rung nobody
   * is encoding — a second cold start in place of the run that is already
   * serving segments.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  offeredHeightsFor(session) {
    // Always answered by the family's BASE, whichever member is asking. A rung
    // is a session of its own, and it knows only its own encode: asked while
    // the viewer watches 240p, the 240p session priced the 1080p rung as a
    // re-encode — because ITS video is re-encoded — and refused it on a host
    // that was serving that very height by COPY minutes earlier. Field
    // 2026-08-15: `proxy now offers 360p 240p` seconds after the switch, and
    // the viewer could not go back. Only the base knows what the family can do
    // with the source.
    // Answered ON the base, never recursively: the family is one level deep by
    // construction, and a cycle between a picture and its steps would otherwise blow the stack on
    // the path that serves every playlist, init and segment.
    const owner = this.#outputs.pictureOf(session);
    // Settled once per session, and re-settled when this file's own decode cost
    // is measured or improves, or when the viewer moves to another rung — the
    // rung on screen is exempt from refusal, so it is an INPUT to this list and
    // belongs in what identifies a cached answer. Left out, the exemption
    // outlived the rung: a rung the host cannot hold went on being offered, and
    // went on passing every route guard, after the viewer had left it.
    // Everything else is fixed for the session's life.
    const observed = this.#cost.decodeCostFor(owner.file.key);
    // Every rung a live viewer has on screen. One answer was enough while a
    // picture had one viewer; two of them can be on two rungs, and withdrawing
    // either is withdrawing a stream that is playing.
    const playingHeights = new Set(
      this.#heightsOnScreen(owner)
    );
    const playing = [...playingHeights].sort((left, right) => left - right).join(",");
    // Everything the answer is derived from belongs in what identifies it. The
    // copy's price and the torrent's are inputs now, and left out of this key
    // the menu would keep the answer computed before either was measured — on
    // a copied picture, which is the case they exist for, the decode version
    // never moves at all, so the cache would never be recomputed.
    const copyVersion = this.#cost.copyVersionFor(owner.file.key);
    const supply = this.#supplyFor(owner.file);
    const torrentCost = supply.costPerMegabyte ?? 0;
    // The soundtrack's price is an input too, and so is how many encoders of
    // this family are running: both move the answer, and an answer cached
    // across them is the stale menu this key exists to prevent.
    const audioVersion = [...this.#outputs.familyOf(owner)]
      .filter((member) => member.spec.carries === "audio-only")
      .map((member) => this.#cost.audioVersionFor(member))
      .reduce((total, one) => total + one, 0);
    const running = [...this.#outputs.familyOf(owner)]
      .filter((member) => processCanBeSignalled(this.#stateFor(member))).length;
    // What each running encode was last seen doing, which is BOTH an input to
    // the answer twice over — it withdraws a step measured below realtime, and
    // it prices every running picture in the committed total — and a figure
    // rewritten every five seconds. Left out of the key, the menu could be
    // pinned to what was computed before anything had been measured: on a
    // COPIED picture the decode version never moves at all, so nothing else in
    // the key would ever have recomputed it.
    // Encoded for the DECISIONS it feeds, not as a raw figure. Two of them: is
    // this encode below realtime (which withdraws its own step outright), and
    // what does it cost (which is charged against every other step). A raw
    // speed at two decimals moves on nearly every five-second reading, so the
    // menu would be recomputed — and its "not offering" line written — for the
    // whole film; while rounding alone would hide the 0.995-1.005 crossing,
    // which is exactly the band a step spends its time in when the host is
    // marginal. The flag carries the crossing, the rounded cost carries the
    // rest.
    const measured = this.#outputs.familyOf(owner)
      .map((member) => {
        const speed = qualityStateOf(member).lastAloneSpeed;
        if (!Number.isFinite(speed) || !(speed > 0)) {
          return "-";
        }
        return `${speed < 1 ? "slow" : "ok"}${(1 / speed).toFixed(2)}`;
      })
      .join(",");
    // The bar the answer is judged against, and the rate the torrent's price is
    // charged at. Both are inputs now — the bar rises when the reader meets
    // interruptions, the rate moves every five seconds — and neither moves any
    // other term of this key. Left out, a menu computed while nothing was known
    // about the swarm would stand for the whole film, offering steps that
    // supply cannot support and passing every route guard on the way.
    const demanded = supply.requiredSpeed;
    const movingMegabytes = supply.megabytesPerSecond;
    const version =
      `${observed?.version ?? 0}:${playing}:${copyVersion}:${torrentCost.toFixed(6)}:` +
      `${audioVersion}:${running}:${measured}:${(demanded ?? 0).toFixed(2)}:` +
      `${(movingMegabytes ?? 0).toFixed(2)}`;
    const state = qualityStateOf(owner);
    if (Array.isArray(state.offeredHeightsCache) && state.offeredHeightsVersion === version) {
      return state.offeredHeightsCache;
    }
    const heights = new Set(variantHeightsFor(Number(owner.file.height) || 0));
    const own = this.#outputs.variantHeightOf(owner);
    if (own > 0) {
      heights.add(own);
    }
    const ordered = [...heights].sort((left, right) => right - left);
    // The rung ON SCREEN is never withdrawn while it is on screen. The list is
    // recomputed as the host learns what this source costs, and the reading
    // that teaches it comes from the rung the viewer has just switched to — so
    // the rung that taught the lesson would be the first to be dropped, and
    // every route guard reads this list: its next segment would 404 on a stream
    // that is playing, with its own encoder still running.
    const answer = this.#cost.sustainableHeights({
      heights: ordered,
      ownHeight: own,
      playingHeights,
      // What each rung was actually seen doing in this session, which is the
      // only thing a live reading may speak for.
      measuredHeights: this.#cost.measuredRungSpeeds(owner),
      // The speed this file's supply demands, measured by its own reader on
      // this swarm. A well-seeded film and a thin one ask different speeds of
      // the same machine, so the bar belongs to the pair, not to the host.
      requiredSpeed: demanded,
      // What the family is already spending while a rung is considered. The
      // picture being COPIED is the common case and used to be priced at
      // nothing; measured, it is about an eighth of the machine.
      concurrentCostSec: this.#cost.committedCostOf(owner),
      // So a height already being produced is not charged for itself when it is
      // judged. See the subtraction in EncodeCost#sustainableHeights.
      runningCostByHeight: this.#cost.runningCostByHeight(owner),
      sourceWidth: Number(owner.file.width) || 0,
      sourceHeight: Math.round(Number(owner.file.height) || 0),
      fps: Number(owner.output.outputFps) || TRANSCODE_FPS,
      source: owner.file.decode ?? null,
      transcodeVideo: owner.spec.transcodesVideo,
      // NOT the learned cost. What a rung is OFFERED on is the startup
      // measurement, which is taken on a quiet machine against known clips and
      // does not move; the figure learned from a live session moves with
      // whatever else the box was doing at that second, and three field
      // sessions in a row (2026-08-15) show what that costs: 0.87x, then
      // 1.34-1.57x against calibration's 2.6x, each reading refusing another
      // rung until the offer held one height and the menu disappeared with it.
      //
      // The learned figure keeps its job — but only over the rung it was
      // measured ON, and only to take that one away (below). A measurement of
      // one rung is not a prediction about the others.
      observedDecodeCostSec: null
    });
    if (owner !== session) {
      // An orphan: its base is gone, so this is the family's last word and
      // there is nobody to keep it for. Answering is right — the viewer is
      // still watching it — but caching it on a session whose flags are its
      // own encode's is how the wrong answer became the family's in the first
      // place.
      return answer;
    }
    state.offeredHeightsVersion = version;
    state.offeredHeightsCache = answer;
    return answer;
  }

  /**
   * The heights this session's file will be served at, largest first — the
   * public form of the same answer the master playlist is built from.
   *
   * The browser asks because the master is not the only way quality changes: a
   * stream without variants changes it by re-opening the session at a chosen
   * height, and that list was being invented in the browser from the source
   * height alone. It has to come from the host that would have to encode it.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  offeredHeights(session) {
    if (!session) {
      return [];
    }
    return this.offeredHeightsFor(session);
  }

  /**
   * The heights this host would serve a file at, answered from the PROBE alone
   * — before any session exists.
   *
   * The viewer sees the quality menu the moment they open a file, so the list
   * cannot wait for an encoder to exist. Everything it needs is already known
   * by then: the source's size, rate and bitrate from the probe, and this
   * host's two benchmarks from startup.
   *
   * Both branches are answered because only the browser knows which one it will
   * take — it decides per track whether it can play the video as it is. With a
   * COPIED video the source height costs no encoder and is always there; with a
   * re-encoded one it is a prediction like every other rung.
   *
   * These are first figures, not final ones: what the encoder then really does
   * with this file replaces them (`offeredHeights` on a live session).
   *
   * @param {{ width: number | null, height: number | null, fps: number | null, bitrateKbps: number | null }} mediaInfo
   * @returns {{ copy: number[], transcode: number[] } | null}
   */
  predictOfferedHeights(mediaInfo) {
    const sourceHeight = Math.round(Number(mediaInfo?.height) || 0);
    const sourceWidth = Number(mediaInfo?.width) || 0;
    if (sourceHeight <= 0 || sourceWidth <= 0) {
      return null;
    }
    const fps = chooseOutputFps(Number(mediaInfo?.fps) || 0);
    const source = sourceDecodeCharacteristics(mediaInfo);
    const heights = variantHeightsFor(sourceHeight);
    // What an encoder has already been seen to cost on this very file, when it
    // has run before. Without it a second open of a file answers from the
    // startup clips again, undoing the correction the first playback earned.
    const observedDecodeCostSec = mediaInfo?.sourceKey !== undefined
      ? (this.#cost.decodeCostFor(`${mediaInfo.sourceKey}:${mediaInfo.fileIndex}`)?.costSec ?? null)
      : null;
    // What the swarm has been doing with this file, asked of whoever reads it.
    // Known before any session exists, so the FIRST offer — the one the viewer
    // actually sees when they open a file — is priced with it too.
    const plannedSupply = mediaInfo?.sourceKey !== undefined
      ? this.#supplyFor({
        sourceKey: mediaInfo.sourceKey,
        fileIndex: mediaInfo.fileIndex,
        key: `${mediaInfo.sourceKey}:${mediaInfo.fileIndex}`,
        lengthBytes: mediaInfo.fileLength ?? null,
        durationSeconds: mediaInfo.durationSeconds ?? null
      })
      : { requiredSpeed: null, megabytesPerSecond: null, costPerMegabyte: null };
    // Without this the plan and a live session answer differently about one file.
    const torrentCostSec = plannedSupply.costPerMegabyte !== null && plannedSupply.megabytesPerSecond !== null
      ? plannedSupply.costPerMegabyte * plannedSupply.megabytesPerSecond
      : 0;
    const fileKey = mediaInfo?.sourceKey !== undefined ? `${mediaInfo.sourceKey}:${mediaInfo.fileIndex}` : null;
    if (!this.#occupancyKnownFor(fileKey)) {
      return null;
    }
    const occupied = Number(this.#occupiedCostSec(fileKey));
    const forBranch = (transcodeVideo) =>
      this.#cost.sustainableHeights({
        heights,
        concurrentCostSec: torrentCostSec + (Number.isFinite(occupied) && occupied > 0 ? occupied : 0),
        // What this file's swarm demanded the last time it was read. Absent on
        // a first open, and then the bar is realtime.
        requiredSpeed: plannedSupply.requiredSpeed,
        observedDecodeCostSec,
        // Nothing is running yet, so nothing is exempt from being predicted —
        // except the copy itself, which the branch flag already covers.
        ownHeight: 0,
        sourceWidth,
        sourceHeight,
        fps,
        source,
        transcodeVideo
      });
    return { copy: forBranch(false), transcode: forBranch(true) };
  }

  /**
   * The next offered height above `current`, never above the source.
   *
   * @param {HlsSession} base
   * @param {number} current
   * @returns {number | undefined}
   */
  nextHeightUp(base, current) {
    const ceiling = Math.round(Number(base.file.height) || 0);
    return this.offeredHeights(base)
      .filter((height) => height > current && height <= ceiling)
      .sort((left, right) => left - right)[0];
  }

  /**
   * The height this family serves by COPY, or zero when every rung is encoded.
   *
   * The one rung whose cost does not depend on the machine: the source's own
   * height, on a base whose video is not re-encoded. `offeredHeights` never
   * withdraws it for that reason, so it is always available as somewhere to
   * return to — which is exactly what `QualityController#askLowerHeight`
   * had no way to say.
   *
   * @param {HlsSession} base
   * @returns {number}
   */
  copiedHeightOf(base) {
    if (!base || base.spec.transcodesVideo) {
      return 0;
    }
    return Math.round(Number(base.file.height) || 0);
  }

  /**
   * The picture part of the load a stream of this picture at this height
   * would put on a link, with how far its figure can be trusted.
   *
   * The arithmetic is `link-budget.js`. This is where a picture is turned INTO
   * its inputs, in one place: built at each call site instead, the mapping was
   * written twice and the two could come apart — which on this question means
   * pricing a re-encode at the bitrate of a file nobody is copying.
   *
   * @param {object} base - The family's picture.
   * @param {number} height
   * @param {string} encoderKind - What this host would encode it with.
   * @returns {import("./link-budget.js").LoadPart}
   */
  videoLoadFor(base, height, encoderKind) {
    const sourceWidth = Number(base.file.width) || 0;
    const sourceHeight = Math.round(Number(base.file.height) || 0);
    // The frame a step of this height is opened at: no width asked, the height
    // asked, from this source — exactly the box `Renditions` opens a step with,
    // so the row priced here is the row the step will be encoded in.
    const dimensions = computeOutputDimensions(0, height, sourceWidth, sourceHeight);
    const frame = dimensions ? { width: dimensions.w, height: dimensions.h } : { width: 0, height };
    if (!(frame.width > 0)) {
      // No source size read yet: the frame, and so its row, cannot be named,
      // and a load that cannot be named is unknown rather than a guess.
      return videoLoadForFrame({ sourceHeight, copiesAtSource: false, sourceMbps: null, encoderKind: "" }, frame);
    }
    return videoLoadForFrame({
      sourceHeight,
      copiesAtSource: !base.spec.transcodesVideo,
      sourceMbps: base.file.megabitsPerSecond,
      encoderKind
    }, frame);
  }
}
