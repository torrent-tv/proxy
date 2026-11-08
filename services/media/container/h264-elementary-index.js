import { avcConfigurationFromUnits, avcOrderParameters } from "./h264-configuration.js";
import { AvcPictureOrder } from "./avc-picture-order.js";
import { CadencedPictureOrder } from "./CadencedPictureOrder.js";
import { Bits, EmulationPrevention, rbsp } from "./bitstream.js";
import { ElementaryAddresses } from "./ElementaryAddresses.js";

/** Incremental AVC access units, retaining addresses rather than frame payloads. */
export class H264ElementaryIndex {
  #track;
  #index;
  #position = 0;
  #zeroes = 0;
  #nal = null;
  #addresses = new ElementaryAddresses("AVC access-unit addresses are incomplete.");
  #sets = new Map();
  #frame = null;
  #prefix = 0;
  #recent = [];
  #picStruct = null;
  #order = null;
  #orderUsesClockTicks = false;
  #anchor = null;
  #cadenced = null;

  constructor(track, index) {
    this.#track = track; this.#index = index;
    if (track.presentationCadenceSeconds > 0) this.#cadenced = new CadencedPictureOrder(track, index);
  }

  push(bytes, sourceStart, stamp) {
    const from = this.#position;
    this.#addresses.map(from, bytes.length, sourceStart);
    if (stamp?.pts !== null && stamp?.pts !== undefined) this.#addresses.stamp(from, stamp.pts, stamp.dts ?? stamp.pts);
    for (const byte of bytes) {
      if (byte === 1 && this.#zeroes >= 2) {
        const start = this.#position - this.#zeroes;
        if (this.#nal) this.#finishNal(start);
        this.#nal = { start, payloadStart: this.#position + 1, bytes: [], type: null, sei: null, seiZeroes: 0 };
      } else if (this.#nal) {
        if (this.#nal.type === null) {
          if (byte & 128 || !(byte & 31)) throw new Error("AVC NAL header is invalid.");
          this.#nal.type = byte & 31;
          if (this.#nal.type === 6) this.#nal.sei = new SeiTiming();
        } else if (this.#nal.sei) {
          if (byte === 0) this.#nal.seiZeroes++;
          else {
            while (this.#nal.seiZeroes > 0) {
              this.#nal.sei.push(0);
              this.#nal.seiZeroes--;
            }
            this.#nal.sei.push(byte);
          }
        }
        // Retain only the slice prefix needed for macroblock and picture order.
        const limit = [7, 8].includes(this.#nal.type) ? 65535 : 64;
        if (this.#nal.bytes.length < limit) this.#nal.bytes.push(byte);
        else if ([7, 8].includes(this.#nal.type)) throw new Error("AVC parameter set exceeds its decoder declaration.");
      } else if (byte !== 0) throw new Error("AVC bytes precede their first start code.");
      this.#zeroes = byte === 0 ? this.#zeroes + 1 : 0;
      this.#position++;
    }
  }

  complete() {
    if (this.#nal) this.#finishNal(this.#position - this.#zeroes);
    if (this.#track.picStructPresent && this.#frame?.picStruct === null) throw new Error("AVC final access-unit duration requires its SEI picture structure.");
    const ticks = this.#frame?.picStruct === null ? this.#track.frameOnly ? 2 : null
      : [2, 1, 1, 2, 2, 3, 3, 4, 6][this.#frame?.picStruct];
    const finalDuration = ticks && this.#track.timingTickSeconds > 0
      ? ticks * this.#track.timingTickSeconds : this.#track.fps > 0 ? 1 / this.#track.fps : null;
    if (this.#frame) this.#close(this.#position - this.#zeroes, finalDuration);
    this.#cadenced?.finish();
    this.#index.complete(this.#track.trackNumber);
  }

  #finishNal(end) {
    const nal = this.#nal;
    if (end <= nal.payloadStart || nal.type === null) throw new Error("AVC NAL unit is empty.");
    if ([2, 3, 4, 19, 20, 21].includes(nal.type)) throw new Error("AVC partitioned or extended pictures require their own access-unit indexing.");
    const size = end - nal.payloadStart;
    const bytes = Buffer.from(nal.bytes.slice(0, size));
    if (nal.sei) {
      const timing = nal.sei.finish();
      if (timing && this.#track.picStructPresent) this.#picStruct = pictureStructure(timing, this.#track.seiDelayBits ?? 0);
    }
    if ([7, 8].includes(nal.type)) {
      const previous = this.#sets.get(nal.type);
      if (previous && !previous.equals(bytes)) throw new Error("AVC parameter-set changes require packet-specific declarations.");
      this.#sets.set(nal.type, bytes);
      if (this.#sets.has(7) && this.#sets.has(8)) Object.assign(this.#track,
        avcConfigurationFromUnits(this.#sets.get(7), this.#sets.get(8)));
      if (this.#sets.has(7) && this.#sets.has(8) && !this.#order) {
        const parameters = avcOrderParameters(this.#sets.get(7), this.#sets.get(8));
        this.#order = new AvcPictureOrder(parameters);
        // Types 1/2 declare order, not proportional elapsed clock ticks.
        this.#orderUsesClockTicks = parameters.type === 0;
      }
    }
    if ([6, 7, 8, 9].includes(nal.type) && this.#frame) {
      if (this.#prefix === null) this.#prefix = nal.start;
      return;
    }
    if (![1, 5].includes(nal.type)) return;
    const firstMacroblock = firstMacroblockOf(bytes);
    if (this.#frame && firstMacroblock !== 0) {
      this.#frame.keyframe ||= nal.type === 5;
      return;
    }
    if (!this.#track.codecPrivateB64) throw new Error("AVC picture precedes its decoder configuration.");
    const start = this.#prefix ?? nal.start;
    let stamp = this.#addresses.stampAt(nal.start);
    let pictureOrder = null;
    if (this.#track.frameOnly && !this.#track.picStructPresent) {
      try { pictureOrder = this.#order?.read(bytes); }
      catch (error) { if (!stamp) throw error; }
    }
    if (pictureOrder?.idr) this.#anchor = null;
    if (stamp && pictureOrder) this.#anchor = { count: pictureOrder.count, pts: stamp.pts };
    if (this.#cadenced) {
      if (!pictureOrder) throw new Error("Cadenced AVC requires complete progressive picture order.");
      stamp = { pts: 0, dts: this.#frame ? this.#frame.dts + this.#track.presentationCadenceSeconds : this.#track.startTimeSeconds };
    } else if (!stamp) {
      if (!pictureOrder || !this.#orderUsesClockTicks || !this.#anchor || !this.#frame || !(this.#track.timingTickSeconds > 0)) {
        throw new Error("AVC access unit has neither a PES timestamp nor complete timing declarations.");
      }
      stamp = { pts: this.#anchor.pts + (pictureOrder.count - this.#anchor.count) * this.#track.timingTickSeconds,
        dts: this.#frame.dts + 2 * this.#track.timingTickSeconds };
    }
    if (this.#frame) {
      const duration = stamp.dts - this.#frame.dts;
      if (!(duration > 0)) throw new Error("AVC decode timestamps do not advance.");
      this.#close(start, duration);
    }
    this.#frame = { start, pts: stamp.pts, dts: stamp.dts, keyframe: nal.type === 5, picStruct: this.#picStruct,
      pictureOrder: pictureOrder?.count, orderReset: pictureOrder?.idr };
    this.#picStruct = null;
    this.#prefix = null;
  }

  #close(end, duration) {
    if (!(duration > 0)) throw new Error("AVC final access-unit duration is unavailable.");
    const { start, picStruct: _picStruct, pictureOrder, orderReset, ...timing } = this.#frame;
    const ranges = this.#addresses.ranges(start, end);
    const packet = { ...timing, duration, ranges };
    if (this.#cadenced) this.#cadenced.push(packet, pictureOrder, orderReset);
    else this.#index.append(this.#track.trackNumber, packet);
    if (!this.#cadenced) this.#recent.push(timing.pts);
    const depth = this.#track.reorderDepth;
    if (!this.#cadenced && Number.isSafeInteger(depth) && this.#recent.length > depth + 1) {
      const earliest = Math.min(...this.#recent);
      this.#recent.splice(this.#recent.indexOf(earliest), 1);
      this.#index.coverThrough(this.#track.trackNumber, Math.max(0, earliest + duration));
    }
    this.#addresses.release(end);
  }
}

/** Skip unrelated SEI payloads without retaining them; timing needs at most 9 bytes. */
class SeiTiming {
  #phase = "type";
  #type = 0;
  #size = 0;
  #remaining = 0;
  #bytes = [];
  #timing = null;
  #escapes = new EmulationPrevention();

  push(byte) {
    if (!this.#escapes.keeps(byte)) return;
    if (this.#phase === "type") {
      this.#type += byte;
      if (byte !== 255) this.#phase = "size";
    } else if (this.#phase === "size") {
      this.#size += byte;
      if (byte !== 255) {
        this.#remaining = this.#size;
        this.#phase = "payload";
        if (this.#remaining === 0) this.#next();
      }
    } else {
      if (this.#type === 1 && this.#bytes.length < 9) this.#bytes.push(byte);
      if (--this.#remaining === 0) this.#next();
    }
  }

  #next() {
    if (this.#type === 1) this.#timing = Buffer.from(this.#bytes);
    this.#bytes = [];
    this.#type = 0;
    this.#size = 0;
    this.#phase = "type";
  }

  finish() {
    if (!(this.#phase === "size" && this.#type === 128 && this.#size === 0)) {
      throw new Error("AVC SEI payload or trailing bits are incomplete.");
    }
    return this.#timing;
  }
}

/** The pic_struct of a picture timing SEI payload, which follows `offset` bits of HRD delays. */
function pictureStructure(payload, offset) {
  if (offset + 4 > payload.length * 8) throw new Error("AVC SEI picture timing is truncated.");
  const bits = new Bits(payload, "AVC SEI picture timing");
  bits.skip(offset);
  const value = bits.uint(4);
  if (value > 8) throw new Error("AVC SEI picture structure is reserved.");
  return value;
}

/** first_mb_in_slice of an AVC slice NAL unit. */
function firstMacroblockOf(nal) {
  try { return new Bits(rbsp(nal, 1), "AVC slice header").ue(); }
  catch (error) {
    throw new Error(error.message.includes("Exp-Golomb") ? "AVC first macroblock is invalid." : "AVC slice header is truncated.");
  }
}
