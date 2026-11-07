/**
 * The value, held between `low` and `high` (torrent-tv/meta#294: one clamp).
 *
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
