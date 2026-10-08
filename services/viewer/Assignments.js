/**
 * @file Which output answers THIS viewer, and for how long that stands.
 *
 * Until now the answer was one record per (file, asked height), shared by
 * everybody watching the file: `OutputCatalog.servedBy`. That is the very thing
 * roadmap item 97 forbids — a viewer on a thin link would have moved the output
 * of a viewer on a thick one, because both read the same entry. So the answer
 * belongs to the viewer, and this is where a viewer keeps it.
 *
 * FIVE FACTS, and each is here because something reads it:
 *
 * 1. **the chosen output** per asked height — what the suitability rule
 *    decided, and the only thing that may change it;
 * 2. the output being PREPARED — `Viewer.warmingVariantId`, which already
 *    exists and stays where it is;
 * 3. **this viewer's own generation**, raised when THIS viewer seeks. Not the
 *    output's `waitEpoch`: that one is shared, rises for reasons that are not a
 *    seek, and is moved by other people's seeks on a shared output. A request
 *    CARRIES the generation it was made in, because a request that arrives late
 *    would otherwise be read against the current one and answered as though it
 *    had just been made;
 * 4. **what was given**: which output answered segment N in generation G. This
 *    is what makes a repeat of a request get the same output rather than being
 *    decided again;
 * 5. **what was accepted**: the assignments whose response has already begun.
 *
 * TWO DEADLINES, NOT ONE. An earlier draft dropped an assignment the moment its
 * generation was left behind, which contradicts finishing a response that is
 * still being sent: the bytes would still be going out while the reason for
 * holding their output had gone.
 *
 * 1. a generation that has been left behind stops accepting NEW requests after
 *    `acceptWindowMs`. What that window should be is NOT derived here — the
 *    player's retry policy is overridden by the product's own page and the
 *    native path has none at all — so it is given explicitly and checked on
 *    what it is given;
 * 2. an ACCEPTED request keeps its assignment until its response finishes or is
 *    released, whatever generation it belongs to and however long that takes.
 *
 * An output is kept while any assignment of it stands: `heldKeys()` is asked
 * before an output is let go, rather than the assignments being discovered
 * afterwards.
 *
 * LIMIT, stated rather than left to be found: an assignment is keyed by the
 * HEIGHT asked for, so it speaks for the picture and its steps. A soundtrack is
 * not a height and records nothing in `given`; item 97 is about the picture.
 * A soundtrack's response is still held by `accept` while it is being sent,
 * and a request for a soundtrack made in a viewing that was left is still
 * refused — neither of those is about heights.
 *
 * WHERE EACH FACT IS READ AND WRITTEN (roadmap item 97, step 9):
 *
 * 1. the generation — told by the seek route (`ViewerRequests.requestSeek`),
 *    checked by every file route BEFORE anything else the route does
 *    (`routes/transcode/session-file/get.js`, `refusedAsStale`);
 * 2. `given` — written and read by the step route
 *    (`Renditions.resolveVariantFile`) under the height asked for and the
 *    segment, −1 for the init; written by the picture's own route under the
 *    height that output is named after (`ViewerRequests.noteAnsweredDirectly`);
 * 3. `accepted` — held from the start of a response to its `finish`, `close`
 *    or `error` (`serveSessionFile`);
 * 4. `heldKeys` — asked before an output is disposed (`Viewers.stillNeeded`,
 *    `Viewers.assignmentsHold`);
 * 5. `chosen` — written only by the suitability rule, for an output that suits
 *    this viewer (`Renditions`, through `viewer/choices.js`), and read first
 *    for every NEW address after `given` (step 11). The shared
 *    `OutputCatalog.servedBy` record it replaced is gone: one viewer's answer is
 *    no longer every viewer's. An answer of "nothing suits" is never recorded
 *    here — it is answered to the request as `output-unavailable`.
 *
 * ORDER OF ANSWERING, and why: `given` before `chosen` before the rule. A
 * repeat of an address must get what answered it, even after `chosen` has
 * moved to another output of the same height — the player holds that output's
 * header for it. When the output behind `given` has gone, the address is not
 * decided again as if new: it is served from the stored piece, or by an output
 * whose header is proven compatible, or answered `assignment-lost`.
 */

/**
 * The address of one thing asked for: a height of the picture and a segment.
 *
 * @param {number} askedHeight
 * @param {number} segmentIndex
 * @returns {string}
 */
function addressOf(askedHeight, segmentIndex) {
  return `${askedHeight}:${segmentIndex}`;
}

export class Assignments {
  /** Chosen output per asked height. @type {Map<number, string>} */
  #chosen = new Map();
  /** Generation → (address → output key). @type {Map<number, Map<string, string>>} */
  #given = new Map();
  /** Generation → when it stopped being the current one. @type {Map<number, number>} */
  #leftAt = new Map();
  /** Accepted responses, by their own token. @type {Map<string, { outputKey: string }>} */
  #accepted = new Map();
  #generation = 0;
  #nextToken = 0;
  #acceptWindowMs;

  /**
   * @param {{ acceptWindowMs: number }} limits - Explicitly given; see the
   *   first deadline above for why it is not derived.
   */
  constructor({ acceptWindowMs }) {
    if (!Number.isFinite(acceptWindowMs) || acceptWindowMs < 0) {
      throw new TypeError("Assignments: acceptWindowMs must be a number of milliseconds");
    }
    this.#acceptWindowMs = acceptWindowMs;
  }

  /** The generation a request made now belongs to. @returns {number} */
  get generation() {
    return this.#generation;
  }

  /**
   * The page states which viewing its requests now belong to.
   *
   * TOLD, NOT COUNTED. The page is where a seek begins and where every request
   * is built, so it is the only place that can stamp a request with the viewing
   * it belongs to; a number counted here would be a second owner of one fact
   * and the two would disagree exactly when a request and a seek cross.
   *
   * Monotonic — a lower number is ignored, so a reordered or repeated message
   * cannot take the viewer back. The generation being left is not dropped: it
   * is marked with the moment it stopped being current, which is what its
   * acceptance window is measured from.
   *
   * @param {number} generation
   * @param {number} [now]
   * @returns {number} The generation now current.
   */
  statedGeneration(generation, now = Date.now()) {
    if (!Number.isInteger(generation) || generation <= this.#generation) {
      return this.#generation;
    }
    this.#leftAt.set(this.#generation, now);
    this.#generation = generation;
    return this.#generation;
  }

  /**
   * Whether a request made in `generation` may still be answered.
   *
   * A generation AHEAD of the one stated is accepted, and that is not
   * laxness: the page raises its own number before it sends anything, so a
   * segment request can overtake the seek that announces the new viewing. The
   * page is the owner, so being behind it means this side has not heard yet.
   *
   * A request that states nothing at all is accepted — a transport with no
   * loader of ours builds no such parameter, and it has one viewing.
   *
   * @param {number} generation
   * @param {number} [now]
   * @returns {boolean}
   */
  accepts(generation, now = Date.now()) {
    if (!Number.isInteger(generation) || generation >= this.#generation) {
      return true;
    }
    const left = this.#leftAt.get(generation);
    return left !== undefined && now - left <= this.#acceptWindowMs;
  }

  /** The output chosen for this height, or an empty string. @returns {string} */
  chosenFor(askedHeight) {
    return this.#chosen.get(askedHeight) ?? "";
  }

  /**
   * The suitability rule has decided. This is the ONLY thing that moves a
   * choice: a request never decides one for itself.
   *
   * @param {number} askedHeight
   * @param {string} outputKey
   * @returns {void}
   */
  choose(askedHeight, outputKey) {
    if (!(askedHeight > 0) || !outputKey) {
      return;
    }
    this.#chosen.set(askedHeight, outputKey);
  }

  /**
   * The asked heights whose choice is this output.
   *
   * A step is NAMED after the height it produces and CHOSEN under the height
   * the player asked for, and the two can differ. A move to another output of
   * the same height has to replace the choice under the height the player
   * asks for, so it is read back from the choice rather than from the name.
   *
   * @param {string} outputKey
   * @returns {number[]}
   */
  heightsChosenAs(outputKey) {
    const heights = [];
    for (const [askedHeight, key] of this.#chosen) {
      if (key === outputKey) {
        heights.push(askedHeight);
      }
    }
    return heights;
  }

  /**
   * The highest segment given at this height in this generation, or −1 when
   * nothing but perhaps the init was.
   *
   * What the player asks for next is the segment after it: hls.js fetches a
   * level's segments in order within one viewing. Nothing given yet is the
   * state straight after a seek, and then the next is where the viewer stands,
   * which only the caller can turn into a number.
   *
   * @param {number} generation
   * @param {number} askedHeight
   * @returns {number}
   */
  highestGiven(generation, askedHeight) {
    const byAddress = this.#given.get(generation);
    if (!byAddress) {
      return -1;
    }
    const prefix = `${askedHeight}:`;
    let highest = -1;
    for (const address of byAddress.keys()) {
      if (!address.startsWith(prefix)) {
        continue;
      }
      const index = Number(address.slice(prefix.length));
      if (Number.isInteger(index) && index > highest) {
        highest = index;
      }
    }
    return highest;
  }

  /**
   * What answered this segment in this generation, or an empty string.
   *
   * @param {number} generation
   * @param {number} askedHeight
   * @param {number} segmentIndex
   * @returns {string}
   */
  givenFor(generation, askedHeight, segmentIndex) {
    return this.#given.get(generation)?.get(addressOf(askedHeight, segmentIndex)) ?? "";
  }

  /**
   * Record what answered, so a repeat of the same request is answered the same
   * way rather than decided again.
   *
   * @param {number} generation
   * @param {number} askedHeight
   * @param {number} segmentIndex
   * @param {string} outputKey
   * @returns {void}
   */
  give(generation, askedHeight, segmentIndex, outputKey) {
    if (!outputKey || !(askedHeight > 0) || !Number.isInteger(segmentIndex)) {
      return;
    }
    const byAddress = this.#given.get(generation) ?? new Map();
    byAddress.set(addressOf(askedHeight, segmentIndex), outputKey);
    this.#given.set(generation, byAddress);
  }

  /**
   * A response has begun. The token returned releases it, and until it is
   * released this output is held whatever else happens to its generation.
   *
   * @param {string} outputKey
   * @returns {string} token
   */
  accept(outputKey) {
    this.#nextToken += 1;
    const token = `a${this.#nextToken}`;
    this.#accepted.set(token, { outputKey });
    return token;
  }

  /**
   * The response is finished or cancelled.
   *
   * @param {string} token
   * @returns {void}
   */
  release(token) {
    this.#accepted.delete(token);
  }

  /** Whether a response from this output has begun and has not finished. */
  responseHolds(outputKey) {
    return [...this.#accepted.values()].some(accepted => accepted.outputKey === outputKey);
  }

  /**
   * Every output this viewer's assignments hold, asked BEFORE one is let go.
   *
   * Three sources, and each is a reason on its own: a choice that stands, a
   * response still being sent, and what was given inside a generation still
   * within its acceptance window. Generations past that window are forgotten
   * here — this is the one place that prunes, so the maps cannot grow with
   * every seek of a long viewing.
   *
   * @param {number} [now]
   * @returns {Set<string>}
   */
  heldKeys(now = Date.now()) {
    const held = new Set(this.#chosen.values());
    for (const { outputKey } of this.#accepted.values()) {
      held.add(outputKey);
    }
    for (const generation of [...this.#given.keys()]) {
      if (this.accepts(generation, now)) {
        for (const outputKey of this.#given.get(generation).values()) {
          held.add(outputKey);
        }
      } else {
        this.#given.delete(generation);
        this.#leftAt.delete(generation);
      }
    }
    return held;
  }

  /**
   * This viewer has gone: nothing they asked for holds anything any more.
   *
   * An accepted response is dropped with the rest, because the connection it
   * was being sent over is what went.
   *
   * @returns {void}
   */
  clear() {
    this.#chosen.clear();
    this.#given.clear();
    this.#leftAt.clear();
    this.#accepted.clear();
  }
}
