import { IndexMemoryUnavailable } from "./memory-unavailable.js";

/** Next distinct presentation timestamp, with admitted temporary sorting bytes. */
export function followingPacketTime(records, endTime, memory = {}) {
  let held = 0;
  let times;
  const owner = { dispose() {
    if (held) allocation.release?.(held);
    held = 0;
    times = null;
    allocation.dispose?.();
  } };
  const allocation = memory.forRecord?.(owner, "timing") ?? memory;
  const bytes = records.length * Float64Array.BYTES_PER_ELEMENT;
  if (allocation.reserve?.(bytes) === false) {
    allocation.dispose?.();
    throw new IndexMemoryUnavailable(bytes);
  }
  held = bytes;
  try {
    times = new Float64Array(records.length);
    for (let index = 0; index < records.length; index++) times[index] = records.ptsAt(index);
    times.sort();
  }
  catch (error) { owner.dispose(); throw error; }
  const next = time => {
    let left = 0, right = times.length;
    while (left < right) {
      const middle = left + Math.floor((right - left) / 2);
      if (times[middle] <= time) left = middle + 1;
      else right = middle;
    }
    return left < times.length ? times[left] : endTime;
  };
  next.dispose = owner.dispose;
  return next;
}
