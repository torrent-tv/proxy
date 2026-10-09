/**
 * @file What one viewer has chosen, and what is being prepared for them —
 * asked and told as plain values.
 *
 * WHY THIS FILE EXISTS. Encoding needs six things about a person: the mode
 * their size was picked in, what their link measured, which soundtrack they
 * chose, which step is on their screen, which step or soundtrack is being
 * prepared for a switch they have not made yet, and whether they are still
 * here. All six are facts of the VIEWER, and until now encoding read and wrote
 * them by holding the viewer itself: it was handed the registry, took the
 * object out of it and assigned to its fields.
 *
 * That is one fact with two writers, which this codebase has paid for before —
 * the position, written by a seek and by a segment request in turn, made the
 * priority map jump several times a second and cost 77 encoder starts against
 * one normal end (field 2026-09-13). Nothing here changes what is decided or
 * when; it changes who does the writing, so that the viewer layer remains the
 * only place a viewer's record is altered and encoding names people by id and
 * nothing else.
 *
 * Every function takes the registry and gives back a value or nothing. No
 * viewer crosses the boundary.
 */

/**
 * The viewer of this output, or null when nobody of that name watches it.
 *
 * Not exported on purpose: everything below answers in values, and this is the
 * one place the object itself is touched.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {object | null}
 */
function on(viewers, output, consumerId) {
  return consumerId ? viewers.getForOutput(output, consumerId) : null;
}

/**
 * Whether the size on this viewer's screen was picked by hand.
 *
 * "manual" for a page that has not said, which is what every page was before it
 * could say — see `Viewer.qualityMode`.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {"auto" | "manual"}
 */
export function qualityModeOf(viewers, output, consumerId) {
  return on(viewers, output, consumerId)?.qualityMode ?? "manual";
}

/**
 * What this viewer's link last measured, or null while nothing measurable has
 * crossed it.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {number | null}
 */
export function linkMbpsOf(viewers, output, consumerId) {
  return on(viewers, output, consumerId)?.netReport?.linkMbps ?? null;
}

/**
 * Which soundtrack this viewer chose and whether their browser needs it
 * re-encoded, or null when they have not said.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {{ trackIndex: number, transcode: boolean } | null}
 */
export function audioChoiceOf(viewers, output, consumerId) {
  const stated = on(viewers, output, consumerId)?.audio ?? null;
  return stated ? { ...stated } : null;
}

/**
 * This viewer has chosen a soundtrack: which one, and whether their browser
 * needs it re-encoded.
 *
 * BOTH FIELDS COME FROM THE CALLER. Taking only the track number and keeping
 * whatever this record held looks equivalent and is not: a viewer who has never
 * stated a choice holds the default `transcode: false`, while what they are
 * actually being given is the output's own decision about their browser. The
 * rendition is keyed on both, so the difference is a different soundtrack.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {{ trackIndex: number, transcode: boolean }} choice
 * @returns {void}
 */
export function chooseAudioTrack(viewers, output, consumerId, choice) {
  viewers.of(output, consumerId).audio = { trackIndex: choice.trackIndex, transcode: choice.transcode === true };
}

/**
 * The step on this viewer's screen, as a session id, or null for the picture
 * itself.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {string | null}
 */
export function stepOnScreenOf(viewers, output, consumerId) {
  return on(viewers, output, consumerId)?.activeVariantId ?? null;
}

/**
 * The page has said which step it is playing.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {string} stepId
 * @returns {void}
 */
export function noteStepOnScreen(viewers, output, consumerId, stepId) {
  viewers.of(output, consumerId).activeVariantId = stepId;
}

/**
 * The step being prepared for a switch this viewer has not made, or null.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {string | null}
 */
export function stepBeingWarmedOf(viewers, output, consumerId) {
  return on(viewers, output, consumerId)?.warmingVariantId ?? null;
}

/**
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {string | null} stepId
 * @returns {void}
 */
export function noteStepBeingWarmed(viewers, output, consumerId, stepId) {
  // Clearing does not make a watcher. Warming one FOR somebody is them
  // watching; saying nothing is being warmed for a person who watches nothing
  // would put them on this output for the sake of a null.
  const viewer = stepId ? viewers.of(output, consumerId) : on(viewers, output, consumerId);
  if (viewer) {
    // When the warming of THIS step began: kept across a repeat of the same
    // step, started afresh for another one, gone with it.
    viewer.warmingSince = stepId
      ? (viewer.warmingVariantId === stepId && Number.isFinite(viewer.warmingSince) ? viewer.warmingSince : Date.now())
      : null;
    viewer.warmingVariantId = stepId;
  }
}

/**
 * When the step being warmed for this viewer began to be warmed, or null.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {number | null}
 */
export function stepBeingWarmedSinceOf(viewers, output, consumerId) {
  const since = on(viewers, output, consumerId)?.warmingSince;
  return Number.isFinite(since) ? since : null;
}

/**
 * The soundtrack being prepared for the same reason, or null.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {string | null}
 */
export function audioBeingWarmedOf(viewers, output, consumerId) {
  return on(viewers, output, consumerId)?.warmingAudioId ?? null;
}

/**
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {string | null} renditionId
 * @returns {void}
 */
export function noteAudioBeingWarmed(viewers, output, consumerId, renditionId) {
  const viewer = renditionId ? viewers.of(output, consumerId) : on(viewers, output, consumerId);
  if (viewer) {
    viewer.warmingAudioId = renditionId;
  }
}

/**
 * This viewer is watching this output. Asking for any of its files is watching
 * it: nothing is made for an output nobody is on, so the init a player needs
 * before it can ask for a segment would never be made.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {void}
 */
export function watches(viewers, output, consumerId) {
  viewers.of(output, consumerId);
}

/**
 * This viewer is watching this output, and is here on it.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {number} seconds
 * @returns {void}
 */
export function placeOn(viewers, output, consumerId, seconds) {
  viewers.of(output, consumerId).moveTo(seconds);
}

/**
 * Who is watching this output, by name.
 *
 * @param {object} viewers
 * @param {object} output
 * @returns {string[]}
 */
export function consumersOn(viewers, output) {
  return [...viewers.forOutput(output).keys()];
}

/**
 * Who is watching this output and is still here.
 *
 * @param {object} viewers
 * @param {object} output
 * @returns {string[]}
 */
export function presentOn(viewers, output) {
  const present = [];
  for (const [consumerId, viewer] of viewers.forOutput(output)) {
    if (viewer.isPresent()) {
      present.push(consumerId);
    }
  }
  return present;
}

/**
 * What the links of this output's viewers last measured, as readings.
 *
 * Copies rather than the reports themselves: a reading is a measurement, and
 * whoever is handed one must not be able to alter the record it came from.
 *
 * @param {object} viewers
 * @param {object} output
 * @returns {object[]}
 */
export function linkReportsOn(viewers, output) {
  const readings = [];
  for (const viewer of viewers.forOutput(output).values()) {
    if (viewer.netReport) {
      readings.push({ ...viewer.netReport });
    }
  }
  return readings;
}

/**
 * The height the budget last asked THIS viewer to move to, while it stands.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {{ height: number, at: number, reason: string, urgent: boolean } | null}
 */
export function standingAskOf(viewers, output, consumerId) {
  const ask = on(viewers, output, consumerId)?.qualityAsk ?? null;
  return ask ? { ...ask } : null;
}

/**
 * Ask this viewer's player to move to another height. Only a viewer in AUTO is
 * asked — a size picked by hand is moved by nothing, which is the rule the
 * viewer layer keeps.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {number} height
 * @param {string} reason
 * @param {number} now
 * @param {boolean} [urgent] - Their buffer would run dry before anything else
 *   could arrive, so their page switches without waiting for a cushion.
 * @returns {boolean} Whether the ask was taken.
 */
export function askQualityOf(viewers, output, consumerId, height, reason, now, urgent = false) {
  return on(viewers, output, consumerId)?.askQuality(height, reason, now, urgent) ?? false;
}

/**
 * The picture as this viewer sees it, in physical pixels, or null until their
 * page has said (roadmap item 98).
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {{ width: number, height: number } | null}
 */
export function visiblePictureOf(viewers, output, consumerId) {
  const size = on(viewers, output, consumerId)?.visiblePicture ?? null;
  return size ? { ...size } : null;
}

/**
 * Which way this viewer's buffer is going, and how much film it holds, as their
 * page last said (`viewer/buffer-trend.js`).
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @param {number} spanSec - The segment duration of the output they watch.
 * @returns {{ bufferedSec: number, slope: number | null, reportGapSec: number } | null}
 *   Null for nobody of that name; `slope` null while their reports do not yet
 *   span one segment.
 */
export function bufferOf(viewers, output, consumerId, spanSec) {
  const viewer = on(viewers, output, consumerId);
  if (!viewer) {
    return null;
  }
  const trend = viewer.bufferTrend(spanSec);
  const held = Number.isFinite(viewer.bufferedSeconds) ? Math.max(0, viewer.bufferedSeconds) : 0;
  return { bufferedSec: held, slope: trend?.slope ?? null, reportGapSec: trend?.reportGapSec ?? 0 };
}

/**
 * Nothing is being asked of this viewer any more.
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {void}
 */
export function dropAskOf(viewers, output, consumerId) {
  on(viewers, output, consumerId)?.dropQualityAsk();
}

/**
 * The generation a request belongs to: the one it states, or — when it states
 * none — the one this viewer is in now.
 *
 * A request that states nothing comes from a transport with no loader of ours
 * (the native player in Safari, a plain HTTP client). It has one viewing, so
 * the current generation is the true one for it; the late-request problem a
 * stated number solves cannot arise where nothing is stated.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} stated - What the request carried; NaN when nothing.
 * @returns {number}
 */
export function generationOfRequest(viewers, consumerId, stated) {
  if (Number.isInteger(stated) && stated >= 0) {
    return stated;
  }
  return (consumerId ? viewers.get(consumerId)?.assignments.generation : 0) ?? 0;
}

/**
 * Whether this viewer still takes requests made in `stated`.
 *
 * A viewer this proxy does not know takes everything: they have no generation
 * to be behind, and the request that follows is what registers them.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} stated - What the request carried; NaN when nothing.
 * @param {number} [now]
 * @returns {boolean}
 */
export function acceptsGeneration(viewers, consumerId, stated, now = Date.now()) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer ? viewer.assignments.accepts(stated, now) : true;
}

/**
 * Which output answered this address for this viewer in this generation, or
 * an empty string.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} generation
 * @param {number} askedHeight
 * @param {number} segmentIndex - −1 for the init.
 * @returns {string}
 */
export function givenOutputOf(viewers, consumerId, generation, askedHeight, segmentIndex) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer ? viewer.assignments.givenFor(generation, askedHeight, segmentIndex) : "";
}

/**
 * Record what answered, so a repeat of the same request in the same generation
 * is answered by the same output.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} generation
 * @param {number} askedHeight
 * @param {number} segmentIndex - −1 for the init.
 * @param {string} outputKey
 * @returns {void}
 */
export function noteGivenOutput(viewers, consumerId, generation, askedHeight, segmentIndex, outputKey) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  viewer?.assignments.give(generation, askedHeight, segmentIndex, outputKey);
}

/**
 * A response from this output to this viewer has begun. Until the function
 * returned is called, the output is held whatever happens to the generation.
 *
 * The function may be called any number of times: a response ends with
 * `finish` and then `close`, or with `error` and then `close`, and each of them
 * says so.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {string} outputKey
 * @returns {() => void} Releases the hold.
 */
export function holdForResponse(viewers, consumerId, outputKey) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  if (!viewer || !outputKey) {
    return () => {};
  }
  const assignments = viewer.assignments;
  const token = assignments.accept(outputKey);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    assignments.release(token);
  };
}

/**
 * The output chosen for this viewer at this height, by key, or an empty
 * string.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} askedHeight
 * @returns {string}
 */
export function chosenOutputOf(viewers, consumerId, askedHeight) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer ? viewer.assignments.chosenFor(askedHeight) : "";
}

/**
 * The suitability rule has chosen an output for this viewer at this height.
 * Only ever called with an output that suits them: an answer of "nothing
 * suits" is not a choice and is never recorded as one.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} askedHeight
 * @param {string} outputKey
 * @returns {void}
 */
export function chooseOutput(viewers, consumerId, askedHeight, outputKey) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  viewer?.assignments.choose(askedHeight, outputKey);
}

/**
 * The asked heights under which this viewer's choice is this output.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {string} outputKey
 * @returns {number[]}
 */
export function heightsChosenAs(viewers, consumerId, outputKey) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer && outputKey ? viewer.assignments.heightsChosenAs(outputKey) : [];
}

/**
 * The highest segment given to this viewer at this height in the viewing they
 * are in NOW, or −1 when none was.
 *
 * Read in the viewing current at the moment of asking, so a question asked for
 * an event that arrives late is answered about where the viewer is, not about
 * where they were when the event was caused.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {number} askedHeight
 * @returns {number}
 */
export function highestGivenSegmentOf(viewers, consumerId, askedHeight) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer ? viewer.assignments.highestGiven(viewer.assignments.generation, askedHeight) : -1;
}

/**
 * The move to another output of the same height being prepared for this
 * viewer, as a copy, or null.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @returns {{ askedHeights: number[], outputId: string, outputKey: string, direction: "down" | "up", reason: string, since: number } | null}
 */
export function sameHeightSwitchOf(viewers, consumerId) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer?.sameHeightSwitch ? { ...viewer.sameHeightSwitch } : null;
}

/**
 * Record, or with null clear, the move being prepared for this viewer.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {{ askedHeights: number[], outputId: string, outputKey: string, direction: "down" | "up", reason: string, since: number } | null} value
 * @returns {void}
 */
export function noteSameHeightSwitch(viewers, consumerId, value) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  if (viewer) {
    viewer.sameHeightSwitch = value ? { ...value } : null;
  }
}

/**
 * Who, among the viewers placed on this output, is having it prepared as the
 * output their next segments come from.
 *
 * Asked of the output's own viewers: a viewer a move is prepared for is placed
 * on the output being prepared, so nobody else can be.
 *
 * @param {object} viewers
 * @param {object} output
 * @returns {string[]}
 */
export function switchingOnto(viewers, output) {
  const found = [];
  for (const [consumerId, viewer] of viewers.forOutput(output)) {
    if (viewer.isPresent() && viewer.sameHeightSwitch?.outputKey === output.outputKey) {
      found.push(consumerId);
    }
  }
  return found;
}

/**
 * Every output a present viewer is being prepared onto, as ids.
 *
 * @param {object} viewers
 * @returns {Set<string>}
 */
export function outputsBeingPrepared(viewers) {
  return viewers.outputsBeingPrepared();
}

/**
 * What this viewer's own link last reported, as a copy, or null.
 *
 * ONE viewer's reading, never a worst over several: a thin link decides for
 * the person on it and for nobody else (roadmap item 97, step 11).
 *
 * @param {object} viewers
 * @param {object} output
 * @param {string} consumerId
 * @returns {{ linkMbps: number, bufferedAheadSec: number } | null}
 */
export function linkReportOf(viewers, output, consumerId) {
  const report = on(viewers, output, consumerId)?.netReport ?? null;
  return report && Number.isFinite(report.linkMbps) ? { ...report } : null;
}

/**
 * Record on what this viewer's output was judged — verdict, figures, and which
 * output — for their progress report. Called only for an output that suits
 * them; "nothing suits" is answered to the request and never recorded here.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @param {object | null} verdict
 * @returns {void}
 */
export function noteServingVerdict(viewers, consumerId, verdict) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  if (viewer) {
    viewer.servingVerdict = verdict ? { ...verdict } : null;
  }
}

/**
 * On what this viewer's output was judged, as a copy, or null.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @returns {object | null}
 */
export function servingVerdictOf(viewers, consumerId) {
  const viewer = consumerId ? viewers.get(consumerId) : null;
  return viewer?.servingVerdict ? { ...viewer.servingVerdict } : null;
}

/**
 * How much film this viewer's page last said it held, in seconds; zero for
 * nobody of that name.
 *
 * @param {object} viewers
 * @param {string} consumerId
 * @returns {number}
 */
export function bufferedSecondsOf(viewers, consumerId) {
  const held = consumerId ? viewers.get(consumerId)?.bufferedSeconds : null;
  return Number.isFinite(held) ? Math.max(0, held) : 0;
}
