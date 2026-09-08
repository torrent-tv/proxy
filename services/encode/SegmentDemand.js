/**
 * @file What is wanted of one output, in ITS OWN segment numbers.
 *
 * One map per output and nothing else. The map itself is built once, per film,
 * by the layer that knows where the viewers are; this holds the copy converted
 * into an output's own numbering, because two outputs of one film are cut
 * independently — 454 pieces against 401 on the field file — so the same second
 * is a different number in each.
 *
 * **No viewer appears here.** It used to hold a window per viewer per band and
 * merge them itself, which was the priority layer's work done a second time in
 * the wrong place, and it carried the viewer's name as the key of a claim —
 * against the rule that the encoding and the viewer are not connected at all.
 * What arrives now is already merged and already anonymous.
 */

export class SegmentDemand {
  /** Output address to what is wanted of it. @type {Map<string, object[]>} */
  #maps = new Map();

  /**
   * What is wanted of one output, replacing whatever was wanted before.
   *
   * An EMPTY map is a statement and is stored as one: it says nobody is coming
   * anywhere in this output, which is what stops the encoders on it.
   *
   * @param {string} address
   * @param {{ from: number, to: number, priority: number, withinSeconds: number }[]} zones
   */
  state(address, zones) {
    this.#maps.set(address, Array.isArray(zones) ? zones : []);
  }

  /**
   * An output nobody has anything to say about any more.
   *
   * @param {string} address
   */
  forget(address) {
    this.#maps.delete(address);
  }

  /**
   * Every output anything is wanted of.
   *
   * @returns {string[]}
   */
  addresses() {
    return [...this.#maps.keys()];
  }

  /**
   * What is wanted of one output.
   *
   * @param {string} address
   * @returns {{ from: number, to: number, priority: number, withinSeconds: number }[]}
   */
  mapOn(address) {
    return this.#maps.get(address) ?? [];
  }

  /**
   * What the map says about one segment, and about the map it sits in.
   *
   * Asked by whoever MEASURES how well the map is being served: a wait means
   * one thing at the top rank and another at the bottom, and telling them apart
   * needs both the segment's own rank and the highest rank stated — a rank is a
   * position in this map, not an absolute number.
   *
   * AND AN EMPTY MAP IS NOT AN ANSWER, which is why the top rank comes back even
   * when the segment's own is zero. A top rank of zero says the map has not been
   * built yet — a session created a moment ago, before the first pass — and that
   * is a different thing from "nobody is coming". Conflated, every request
   * behind the run reads as absent for as long as a fresh session has no map.
   *
   * @param {string} address
   * @param {number} index
   * @returns {{ rank: number, topRank: number }} Rank zero for a number in
   *   nobody's zone, which is a statement: nothing is coming for it.
   */
  rankOf(address, index) {
    const zones = this.mapOn(address);
    let rank = 0;
    let topRank = 0;
    for (const zone of zones) {
      if (zone.priority > topRank) {
        topRank = zone.priority;
      }
      if (index >= zone.from && index <= zone.to && zone.priority > rank) {
        rank = zone.priority;
      }
    }
    return { rank, topRank };
  }
}
