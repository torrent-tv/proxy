/** A declared constant presentation cadence uses picture order as order, not time. */
export class CadencedPictureOrder {
  #track;
  #index;
  #pending = [];
  #next;
  #last = null;
  #covered = 0;

  constructor(track, index) {
    this.#track = track;
    this.#index = index;
    this.#next = track.startTimeSeconds;
  }

  push(packet, order, reset) {
    if (!Number.isSafeInteger(order)) throw new Error("A cadenced picture has no declared order.");
    if (reset) { this.finish(); this.#last = null; }
    const depth = this.#track.reorderDepth;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 16) throw new Error("A cadenced picture has no bounded reorder declaration.");
    this.#pending.push({ packet, order, assigned: false });
    if (this.#pending.filter(one => !one.assigned).length > depth + 1) this.#assign();
  }

  #assign() {
    const one = this.#pending.filter(one => !one.assigned).reduce((first, next) => !first || next.order < first.order ? next : first, null);
    if (!one) return;
    if (this.#last !== null && one.order <= this.#last) throw new Error("Picture order exceeds its declared reorder bound.");
    one.packet.pts = this.#next;
    one.packet.duration = this.#track.presentationCadenceSeconds;
    this.#next += one.packet.duration;
    this.#last = one.order;
    one.assigned = true;
    while (this.#pending[0]?.assigned) {
      this.#index.append(this.#track.trackNumber, this.#pending.shift().packet);
    }
    const through = Math.min(this.#next, ...this.#pending.filter(entry => entry.assigned).map(entry => entry.packet.pts));
    if (through > this.#covered) {
      this.#index.coverThrough(this.#track.trackNumber, through);
      this.#covered = through;
    }
  }

  finish() { while (this.#pending.length) this.#assign(); }
}
