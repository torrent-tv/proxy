/**
 * @file Which outputs of one file exist right now, and what each of them is.
 *
 * Every question here is answered by walking the live sessions and looking at
 * what they ARE — the same file, a step, a soundtrack, this height — and not by
 * following a list of ids anybody keeps. A list of ids is a link between
 * sessions: it ties their lifetimes together, it goes stale when one of them is
 * disposed, and it has to be cleaned from the other side. What an output is is
 * enough to find it, which is the rule `OutputSpec` exists for.
 *
 * Nothing here writes anything except the two answers a session memoizes about
 * itself, and nothing here knows about encoders, viewers, the torrent or the
 * disk. It is the layer the quality budget and the serving path both stand on,
 * and it is separated first for that reason.
 */

import { variantHeightsFor } from "./ladder.js";

export class LiveOutputs {
  /**
   * @param {object} params
   * @param {Map<string, object>} params.sessionsById - The live sessions. Read,
   *   never written.
   */
  constructor({ sessionsById }) {
    this.sessionsById = sessionsById;
  }

  /**
   * Every live session of one file: the picture, its quality steps, and the
   * soundtracks published separately.
   *
   * The file is what they share, so the file is what this asks about. Where the
   * sums this feeds are concerned that is also the right question: two pictures
   * of one file are two encoders on one machine whether or not anybody thinks
   * of them as one film.
   *
   * @param {object} session
   * @returns {object[]}
   */
  familyOf(session) {
    const family = [session];
    const key = session?.file?.key;
    for (const other of this.sessionsById.values()) {
      if (other === session || other.state === "disposed" || other.file?.key !== key) {
        continue;
      }
      family.push(other);
    }
    return family;
  }

  /**
   * The soundtracks published separately for this picture, live ones only.
   *
   * @param {object} base
   * @returns {object[]}
   */
  renditionsOf(base) {
    return this.familyOf(base).filter((session) => session !== base && session.audioOnly === true);
  }

  /**
   * The quality steps of this picture, live ones only.
   *
   * A step is a session made as one — `isStep`, written where it is created —
   * and not merely "another session of this file that carries a picture". The
   * difference is the second picture: one file can hold two — a browser that
   * understands rendition groups and one that needs the sound muxed in produce
   * two — and calling one of them a step of the other would let a switch away
   * from a step stop the encoder of somebody else's picture.
   *
   * @param {object} base
   * @returns {object[]}
   */
  stepsOf(base) {
    return this.familyOf(base).filter((session) => session !== base && session.isStep === true);
  }

  /**
   * The picture a step belongs to, or the session itself when it is not a step.
   *
   * How a session came to be is a fact about it, not a link to another session
   * — so a step whose picture has gone answers for itself rather than following
   * a dead reference, and nothing has to be cleaned from the other side when
   * one of them ends.
   *
   * One file can carry two pictures at once, and then this returns whichever
   * was made first. Everything asked of the answer is a fact of the FILE and of
   * this host: what heights can be offered, what a step costs, when the budget
   * last acted. Two pictures of one file answer all of those alike.
   *
   * @param {object} session
   * @returns {object}
   */
  pictureOf(session) {
    if (!session || session.isStep !== true) {
      return session;
    }
    for (const other of this.familyOf(session)) {
      if (other.isStep !== true && other.audioOnly !== true) {
        return other;
      }
    }
    return session;
  }

  /**
   * Which variant a session IS, as a height. Zero encode height means "keep the
   * source", so the source's own height is the answer.
   *
   * Settled once and then kept, because it is a NAME — the player addresses the
   * variant by it for the whole session, having fetched the master exactly
   * once. The height a session encodes at is not stable: the realtime budget
   * steps it down when the host cannot keep up. Deriving the name afresh each
   * time would mean a downshift silently renames the variant the viewer is
   * watching, and the next segment request under the old name would build a
   * SECOND session at the height the host had just proved it could not manage.
   * A downshift changes the picture inside the variant instead, which is what
   * it has always done.
   *
   * @param {object} session
   * @returns {number}
   */
  variantHeightOf(session) {
    if (Number.isInteger(session.variantHeight) && session.variantHeight > 0) {
      return session.variantHeight;
    }
    const encodeHeight = Number(session.output.encodeHeight) || 0;
    session.variantHeight = encodeHeight > 0
      ? encodeHeight
      : Math.round(Number(session.file.height) || 0);
    return session.variantHeight;
  }

  /**
   * The height a session's encoder is actually producing, or 0 when it produces
   * no encoded picture of its own (a copy, or a soundtrack).
   *
   * A COPY must never be adopted: it costs no encoder at all, so handing it to
   * a request for a re-encoded rung would give away the one thing this host can
   * always serve.
   *
   * @param {object} session
   * @returns {number}
   */
  producedHeightOf(session) {
    if (!session || session.transcodeVideo !== true || session.audioOnly === true) {
      return 0;
    }
    return Math.round(Number(session.output.encodeHeight) || 0);
  }

  /**
   * The heights this file's variants CAN be spliced at — a fact about the
   * source and the cut grid, settled once and never moved.
   *
   * Separate from which of them are worth OFFERING to the viewer right now, on
   * a machine whose load moves every five seconds. Both were the same list
   * until 2026-08-18, and that is what broke playback outright: the browser is
   * told at session creation that a master playlist exists, and 192 ms later —
   * after the session's own encoder had started and the first supply reading
   * had arrived — the live list had fallen from five rungs to one,
   * `buildMasterPlaylist` returned null for having fewer than two, and the
   * master answered 404 to the very session that had just published it. hls.js
   * treats that as fatal and unrecoverable, so nothing played at all (session
   * `4ef731d8`, "Moana (2016).mkv", 17:43:01).
   *
   * A live figure may decide what to offer. It may not decide whether a
   * published document exists.
   *
   * @param {object} session
   * @returns {number[]} Largest first.
   */
  splicableHeights(session) {
    const owner = this.pictureOf(session);
    if (Array.isArray(owner.splicableHeights)) {
      return owner.splicableHeights;
    }
    const heights = new Set(variantHeightsFor(Number(owner.file.height) || 0));
    const own = this.variantHeightOf(owner);
    if (own > 0) {
      heights.add(own);
    }
    owner.splicableHeights = [...heights].sort((left, right) => right - left);
    return owner.splicableHeights;
  }

  /**
   * Whether this stream publishes a master playlist at all — that is, whether
   * there is anything for a player to move BETWEEN.
   *
   * Asked in one place because two callers depend on the same answer and used
   * to compute it differently: the builder refused a copied stream whose cut
   * grid is a fiction, while the budget looked only at how many heights could
   * in principle be spliced. A copy with no readable keyframe index therefore
   * had requests recorded against it — asking a player with no variants to
   * change variant, once every window, for the whole film.
   *
   * @param {object} session
   * @returns {boolean}
   */
  publishesVariants(session) {
    const owner = this.pictureOf(session);
    // A copy can only be cut where the source already has a keyframe, so a rung
    // meant to splice into it has to be cut at exactly those times. A copy that
    // fell back to an even grid ffmpeg does not cut on has nothing to align to.
    if (!owner.transcodeVideo && owner.timeline.cutGrid !== "keyframe") {
      return false;
    }
    return this.splicableHeights(owner).length >= 2;
  }
}
