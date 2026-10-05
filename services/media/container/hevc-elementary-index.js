import { hevcConfigurationFromUnits } from "./hevc-configuration.js";
import { HevcPictureOrder } from "./hevc-picture-order.js";
import { CadencedPictureOrder } from "./CadencedPictureOrder.js";

/** HEVC access units keep exact source addresses and the PES presentation/decode clocks. */
export class HevcElementaryIndex {
  #track;
  #index;
  #position = 0;
  #zeroes = 0;
  #nal = null;
  #mappings = [];
  #stamps = [];
  #sets = new Map();
  #frame = null;
  #prefix = 0;
  #recent = [];
  #order = null;
  #anchor = null;
  #cadenced = null;

  constructor(track, index) {
    this.#track = track; this.#index = index;
    if (track.presentationCadenceSeconds > 0) this.#cadenced = new CadencedPictureOrder(track, index);
  }

  push(bytes, sourceStart, stamp) {
    const from = this.#position;
    this.#mappings.push({ from, to: from + bytes.length, sourceStart });
    if (stamp?.pts !== null && stamp?.pts !== undefined) this.#stamps.push({ position: from, pts: stamp.pts, dts: stamp.dts ?? stamp.pts });
    for (const byte of bytes) {
      if (byte === 1 && this.#zeroes >= 2) {
        const start = this.#position - this.#zeroes;
        if (this.#nal) this.#finishNal(start);
        this.#nal = { start, payloadStart: this.#position + 1, bytes: [], type: null };
      } else if (this.#nal) {
        if (this.#nal.type === null) {
          if (byte & 128) throw new Error("HEVC NAL header is invalid.");
          this.#nal.type = (byte >> 1) & 63;
        }
        const limit = [32, 33, 34].includes(this.#nal.type) ? 65535 : 64;
        if (this.#nal.bytes.length < limit) this.#nal.bytes.push(byte);
        else if ([32, 33, 34].includes(this.#nal.type)) throw new Error("HEVC parameter set exceeds its decoder declaration.");
      } else if (byte !== 0) throw new Error("HEVC bytes precede their first start code.");
      this.#zeroes = byte === 0 ? this.#zeroes + 1 : 0;
      this.#position++;
    }
  }

  complete() {
    if (this.#nal) this.#finishNal(this.#position - this.#zeroes);
    if (this.#frame) {
      if (!(this.#track.fps > 0) || this.#track.fieldSequence) throw new Error("HEVC final frame timing is not declared.");
      this.#close(this.#position - this.#zeroes, 1 / this.#track.fps);
    }
    this.#cadenced?.finish();
    this.#index.complete(this.#track.trackNumber);
  }

  #finishNal(end) {
    const nal = this.#nal;
    if (end < nal.payloadStart + 2 || nal.bytes.length < 2) throw new Error("HEVC NAL unit is truncated.");
    const bytes = Buffer.from(nal.bytes.slice(0, end - nal.payloadStart));
    if (!(bytes[1] & 7) || (bytes[0] & 1) || (bytes[1] >> 3)) throw new Error("HEVC NAL temporal identity or layer is invalid.");
    if ([32, 33, 34].includes(nal.type)) {
      const previous = this.#sets.get(nal.type);
      if (previous && !previous.equals(bytes)) throw new Error("HEVC parameter-set changes require packet-specific declarations.");
      this.#sets.set(nal.type, bytes);
      if ([32, 33, 34].every(type => this.#sets.has(type))) {
        Object.assign(this.#track, hevcConfigurationFromUnits(this.#sets.get(32), this.#sets.get(33), this.#sets.get(34)));
        this.#order ??= new HevcPictureOrder(this.#track, this.#sets.get(34));
      }
    }
    if ([32, 33, 34, 35, 39].includes(nal.type) && this.#frame) {
      if (this.#prefix === null) this.#prefix = nal.start;
      return;
    }
    if (nal.type > 31) return;
    if (bytes.length < 3) throw new Error("HEVC slice header is truncated.");
    const firstSlice = (bytes[2] & 128) !== 0;
    if (!firstSlice) {
      if (!this.#frame) throw new Error("HEVC access unit starts with a dependent slice.");
      return;
    }
    if (!this.#track.codecPrivateB64) throw new Error("HEVC picture precedes its decoder configuration.");
    const start = this.#prefix ?? nal.start;
    let stamp = null;
    while (this.#stamps[0]?.position <= nal.start) stamp = this.#stamps.shift();
    let pictureOrder = null;
    try { pictureOrder = this.#order?.read(bytes); }
    catch (error) { if (!stamp) throw error; }
    if (pictureOrder?.reset) this.#anchor = null;
    if (stamp && pictureOrder) this.#anchor = { count: pictureOrder.count, pts: stamp.pts };
    if (this.#cadenced) {
      if (!pictureOrder || this.#track.fieldSequence || this.#track.frameFieldInfo) throw new Error("Cadenced HEVC requires complete progressive picture order.");
      stamp = { pts: 0, dts: this.#frame ? this.#frame.dts + this.#track.presentationCadenceSeconds : this.#track.startTimeSeconds };
    }
    if (!stamp) {
      if (!pictureOrder || !this.#anchor || !this.#frame || !this.#track.pocProportional ||
        this.#track.fieldSequence || this.#track.frameFieldInfo || !(this.#track.fps > 0)) {
        throw new Error("HEVC access unit has neither a PES timestamp nor complete picture-order timing declarations.");
      }
      stamp = { pts: this.#anchor.pts + (pictureOrder.count - this.#anchor.count) / this.#track.fps,
        dts: this.#frame.dts + 1 / this.#track.fps };
    }
    if (this.#frame) {
      const duration = stamp.dts - this.#frame.dts;
      if (!(duration > 0)) throw new Error("HEVC decode timestamps do not advance.");
      this.#close(start, duration);
    }
    this.#frame = { start, pts: stamp.pts, dts: stamp.dts, keyframe: nal.type >= 16 && nal.type <= 21,
      ...(this.#cadenced ? { pictureOrder: pictureOrder.count, orderReset: pictureOrder.reset } : {}) };
    this.#prefix = null;
  }

  #close(end, duration) {
    const { start, pictureOrder, orderReset, ...timing } = this.#frame;
    const ranges = this.#mappings.filter(range => range.from < end && range.to > start).map(range => [
      range.sourceStart + Math.max(start, range.from) - range.from,
      range.sourceStart + Math.min(end, range.to) - range.from - 1]);
    if (ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0) !== end - start) throw new Error("HEVC access-unit addresses are incomplete.");
    if (this.#cadenced) this.#cadenced.push({ ...timing, duration, ranges }, pictureOrder, orderReset);
    else this.#index.append(this.#track.trackNumber, { ...timing, duration, ranges });
    if (!this.#cadenced) this.#recent.push(timing.pts);
    if (!this.#cadenced && this.#recent.length > this.#track.reorderDepth + 1) {
      const earliest = Math.min(...this.#recent);
      this.#recent.splice(this.#recent.indexOf(earliest), 1);
      this.#index.coverThrough(this.#track.trackNumber, Math.max(0, earliest + duration));
    }
    this.#mappings = this.#mappings.filter(range => range.to > end);
  }
}
