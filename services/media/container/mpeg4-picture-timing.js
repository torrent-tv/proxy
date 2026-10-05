import { Bits } from "./h264-configuration.js";
import { RetainedBytes } from "./RetainedBytes.js";

/** MPEG-4 Visual VOL/VOP clocks, committed only after packet admission. */
export class Mpeg4PictureTiming {
  #state = { resolution: null, seconds: 0, previousSeconds: 0, origin: null, reference: null };
  #memory;

  constructor(memory) { this.#memory = memory; }

  async read(readRange, start, end, startSeconds) {
    let length = Math.min(4, end - start + 1);
    while (true) {
      const bytes = await readRange(start, start + length - 1);
      try {
        const picture = this.prepare(bytes, startSeconds);
        if (!picture.packed) return { pictures: [{ ...picture, start, end }], packed: false, commit: picture.commit };
        const allocation = new RetainedBytes(this.#memory);
        try {
          const full = await allocation.read(end - start + 1, () => readRange(start, end));
          const starts = [];
          for (let at = 0; at + 4 <= full.length; at++) if (!full[at] && !full[at + 1] && full[at + 2] === 1 && full[at + 3] === 0xb6) starts.push(at);
          let state = this.#state;
          const pictures = starts.map((at, position) => {
            const first = position === 0 ? 0 : at, last = starts[position + 1] ?? full.length;
            const one = this.prepare(full.subarray(first, last), startSeconds, state);
            state = one.state;
            return { ...one, start: start + first, end: start + last - 1 };
          });
          return { pictures, packed: true, commit: () => { this.#state = state; } };
        } finally { allocation.dispose(); }
      }
      catch (error) {
        if (length === end - start + 1 || !/bits are truncated|no complete VOP header/.test(error.message)) throw error;
        length = Math.min(end - start + 1, length * 2);
      }
    }
  }

  prepare(bytes, startSeconds, previous = this.#state) {
    const state = { ...previous };
    state.packed ||= /DivX[^\0]*p(?=\0|$)/.test(bytes.toString("latin1"));
    let picture = null;
    for (let at = 0; at + 4 <= bytes.length; at++) {
      if (bytes[at] || bytes[at + 1] || bytes[at + 2] !== 1) continue;
      const code = bytes[at + 3];
      if (code >= 0x20 && code <= 0x2f) state.resolution = resolutionOf(bytes.subarray(at + 4));
      if (code === 0xb3) {
        const bits = new Bits(bytes.subarray(at + 4), "MPEG-4 Visual");
        const hours = bits.uint(5), minutes = bits.uint(6);
        marker(bits);
        const seconds = bits.uint(6);
        if (hours > 23 || minutes > 59 || seconds > 59) throw new Error("MPEG-4 group clock is invalid.");
        state.seconds = hours * 3600 + minutes * 60 + seconds;
      }
      if (code !== 0xb6) continue;
      if (picture) {
        if (state.packed) break;
        throw new Error("Multiple MPEG-4 pictures require a packed-stream declaration.");
      }
      if (!(state.resolution > 0)) throw new Error("MPEG-4 picture precedes its VOL clock declaration.");
      const bits = new Bits(bytes.subarray(at + 4), "MPEG-4 Visual");
      const type = bits.uint(2);
      let seconds = 0;
      while (bits.uint(1)) seconds++;
      marker(bits);
      const increment = bits.uint(Math.max(1, Math.ceil(Math.log2(state.resolution))));
      if (increment >= state.resolution) throw new Error("MPEG-4 picture clock exceeds its resolution.");
      marker(bits);
      const coded = bits.uint(1) === 1;
      if (type !== 2) {
        state.previousSeconds = state.seconds;
        state.seconds += seconds;
      }
      const clock = (type === 2 ? state.previousSeconds + seconds : state.seconds) + increment / state.resolution;
      state.origin ??= clock - startSeconds;
      const pts = clock - state.origin;
      const coveredThrough = type === 2 ? null : state.reference;
      if (type !== 2) state.reference = pts;
      picture = { pts, keyframe: type === 0, coded, coveredThrough };
    }
    if (!picture) throw new Error("MPEG-4 packet has no complete VOP header.");
    return { ...picture, packed: state.packed === true, state, commit: () => { this.#state = state; } };
  }
}

function resolutionOf(bytes) {
  const bits = new Bits(bytes, "MPEG-4 Visual");
  bits.uint(1); bits.uint(8);
  if (bits.uint(1)) { bits.uint(4); bits.uint(3); }
  if (bits.uint(4) === 15) { bits.uint(8); bits.uint(8); }
  if (bits.uint(1)) {
    bits.uint(2); bits.uint(1);
    if (bits.uint(1)) {
      bits.uint(15); marker(bits); bits.uint(15); marker(bits);
      bits.uint(15); marker(bits); bits.uint(3); bits.uint(11); marker(bits);
      bits.uint(15); marker(bits);
    }
  }
  if (bits.uint(2) !== 0) throw new Error("MPEG-4 nonrectangular pictures require shape-specific timing.");
  marker(bits);
  const resolution = bits.uint(16);
  marker(bits);
  if (!resolution) throw new Error("MPEG-4 VOL clock resolution is zero.");
  return resolution;
}

function marker(bits) { if (bits.uint(1) !== 1) throw new Error("MPEG-4 picture marker bit is invalid."); }
