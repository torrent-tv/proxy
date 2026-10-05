/** Decode ffprobe's compact C-escaped records without splitting escaped separators. */
export function ffprobeRecord(line) {
  const fields = [];
  let field = "", escaped = false;
  for (const character of line.replace(/\r$/, "")) {
    if (escaped) {
      field += ({ n: "\n", r: "\r", t: "\t", f: "\f", b: "\b" })[character] ?? character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === "|") { fields.push(field); field = ""; }
    else field += character;
  }
  if (escaped) throw new Error("Truncated ffprobe escape.");
  fields.push(field);
  const kind = fields.shift();
  const record = { kind };
  for (const [position, value] of fields.entries()) {
    // ffprobe 5 emits an empty nested section even when its entries are disabled.
    if (value === "side_data" && fields.slice(position + 1).every(field => field === "")) break;
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error(`Malformed ffprobe field: ${value.slice(0, 80)}`);
    const key = value.slice(0, separator);
    if (Object.hasOwn(record, key)) throw new Error(`Duplicate ffprobe field: ${key}`);
    record[key] = value.slice(separator + 1);
  }
  return record;
}

/** Stream extradata's documented hexadecimal dump contains addresses and ASCII. */
export function ffprobeExtradata(dump, expectedSize) {
  const chunks = [];
  let offset = 0;
  for (const line of String(dump ?? "").split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{8}):\s([0-9a-fA-F ]+?)\s{2,}/.exec(line);
    if (!match || Number.parseInt(match[1], 16) !== offset) throw new Error("Invalid ffprobe extradata address.");
    const hex = match[2].replaceAll(" ", "");
    if (hex.length % 2) throw new Error("Truncated ffprobe extradata.");
    const bytes = Buffer.from(hex, "hex");
    chunks.push(bytes);
    offset += bytes.length;
  }
  if (offset !== expectedSize) throw new Error("Incomplete ffprobe extradata.");
  return Buffer.concat(chunks);
}
