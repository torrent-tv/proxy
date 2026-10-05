/** Synthetic AVC declaration with explicit coded size and timing. */
export function configuration({ reorder = 2, buffering = 4, picStruct = false, pocType = 0 } = {}) {
  let bits = "";
  const uint = (value, width) => { bits += value.toString(2).padStart(width, "0"); };
  const ue = value => { const encoded = (value + 1).toString(2); bits += "0".repeat(encoded.length - 1) + encoded; };
  uint(66, 8); uint(0, 8); uint(30, 8); ue(0);
  ue(0); ue(pocType);
  if (pocType === 0) ue(0);
  else if (pocType === 1) { uint(1, 1); ue(2); ue(0); ue(1); ue(3); }
  ue(2); uint(0, 1);
  ue(3); ue(3); uint(1, 1); uint(1, 1); uint(0, 1);
  uint(1, 1); uint(0, 4); uint(1, 1); uint(1, 32); uint(50, 32); uint(1, 1);
  uint(0, 2); uint(Number(picStruct), 1); uint(1, 1); uint(1, 1); ue(0); ue(0); ue(0); ue(0); ue(reorder); ue(buffering);
  uint(1, 1);
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const rbsp = Buffer.from(bits.match(/.{8}/g).map(value => Number.parseInt(value, 2)));
  const escaped = [];
  for (let at = 0, zeroes = 0; at < rbsp.length; at++) {
    if (zeroes >= 2 && rbsp[at] <= 3) { escaped.push(3); zeroes = 0; }
    escaped.push(rbsp[at]); zeroes = rbsp[at] === 0 ? zeroes + 1 : 0;
  }
  const sps = Buffer.concat([Buffer.from([0x67]), Buffer.from(escaped)]);
  const size = Buffer.alloc(2); size.writeUInt16BE(sps.length);
  return Buffer.concat([Buffer.from([1, 66, 0, 30, 255, 225]), size, sps, Buffer.from([1, 0, 2, 0x68, 0xe0])]);
}
