/**
 * @file One output that exists on this proxy.
 *
 * What it holds are the facts born with the output and gone with it: its
 * identity and format (`spec`), the file it is made from, where that file is
 * cut, the container its pieces are in, the shape the encoder is given, and the
 * playlist the player is told. Two things it deliberately does NOT hold,
 * decided with the user 2026-09-16: what has been produced — the segment store
 * owns that — and which encoders are running — the encoding orchestrator owns
 * that. An output without a live record does not make its pieces invalid;
 * pieces are valid while they exist.
 *
 * The second block of fields is TRANSITIONAL. Each is state of another owner
 * that is still kept here because the component that reads it has not taken
 * it over yet, and each names where it goes. The list is the
 * inventory of what is left to move; a field is deleted from here when it
 * moves, never added.
 */

export class EncodedOutput {
  /**
   * @param {object} params
   * @param {string} params.id - The output's name, derived from its key.
   * @param {import("./OutputSpec.js").OutputSpec} params.spec
   * @param {object} params.file - The source file, one object per file.
   * @param {object} params.keyframes - That file's keyframe table, held rather
   *   than copied so a table read later still reaches it.
   * @param {object} params.timeline - Where that file is cut, shared by every
   *   output of it.
   * @param {object} params.segmentFormat - The container the pieces are in.
   * @param {import("./Output.js").Output} params.output - The format in the
   *   terms the encoder is given, and how its pieces land.
   * @param {boolean} params.useSyntheticPlaylist - The playlist is built from
   *   the probed duration rather than written by the encoder.
   * @param {string} params.playlistText
   * @param {number | undefined} params.variantHeight - The height a step is
   *   addressed by, when it is produced at exactly that size.
   * @param {Iterable<string>} [params.claims] - The family's own claims that
   *   keep a step or a soundtrack alive for its picture. Viewers are not here.
   */
  constructor({ id, spec, file, keyframes, timeline, segmentFormat, output, useSyntheticPlaylist, playlistText, variantHeight, claims = [] }) {
    this.id = id;
    this.spec = spec;
    this.file = file;
    this.keyframes = keyframes;
    this.timeline = timeline;
    this.segmentFormat = segmentFormat;
    this.output = output;
    this.useSyntheticPlaylist = useSyntheticPlaylist === true;
    this.playlistText = typeof playlistText === "string" ? playlistText : "";
    this.variantHeight = variantHeight;
    this.claims = new Set(claims);

    // TRANSITIONAL — the quality budget's state; moves to `encode/quality/`
    // (plan step 3).
    /** Speed the offer predicted for this height, for comparing with what runs. */
    this.predictedSpeedWhenOffered = null;
    this.lastPredictionRatio = null;
    this.budgetSlowSince = 0;
    this.budgetUpSince = 0;
    this.budgetLastActionAt = 0;
    this.linkSlowSince = 0;
    /** A standing request to the player to move to another height, or null. */
    this.qualityAsk = null;
    /** The last speed read as a slope between two progress reports, and when. */
    this.recentSpeed = null;
    /** A bitrate ceiling set by the viewer's measured link, in kbit/s, or null. */
    this.rateCapKbps = null;
    this.initSizeSaid = "";
    this.learnSample = undefined;
    this.lastAloneSpeed = undefined;
    this.saidNoVariants = undefined;
    this.splicableHeights = undefined;
    this.offeredHeightsVersion = undefined;
    this.offeredHeightsCache = undefined;

    // TRANSITIONAL — the encoder's input; moves to `encode/run/` (plan step 4).
    /** How wide the encoder's read window is, measured when the output was made. */
    this.readWindowBytes = 0;
    this.inputRetryCount = undefined;
    this.backwardRestarts = undefined;
    this.firstWantedAt = undefined;
    this.landingReportedForRun = undefined;
    this.trueStartByIndex = undefined;
    this.deviationWarnedAt = undefined;
    this.stampWarnedAt = undefined;
    this.lookAheadDisagreementSince = undefined;

    // TRANSITIONAL — what the swarm delivers to this output's reads; moves to
    // the torrent component (plan step 7).
    this.supplyFigures = undefined;
    this.inputBytes = undefined;

    // TRANSITIONAL — the family of steps; moves with variants to the encoding
    // component (plan step 5).
    this.isStep = undefined;
    this.variantPending = undefined;

    // TRANSITIONAL — serving requests; moves to the server operations (plan
    // step 7).
    this.createEntryMs = 0;
    this.firstSegmentLogged = false;
    this.cushionSaidAt = 0;
    /** Issued to each incoming segment request and kept across its polls. */
    this.requestSeqCounter = 0;
    this.holdExplainedAt = undefined;
    this.initBytes = undefined;
    /** Bumped by every seek; a request held under an older value gives up. */
    this.waitEpoch = 0;
  }

  /**
   * The address of this output's pieces. Derived, so it cannot say anything
   * the spec does not.
   *
   * @returns {string}
   */
  get outputKey() {
    return this.spec.toKey();
  }
}
