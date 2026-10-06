/** Prepared input boundary for process/accounting tests; never reads a source. */
export function fakeEncodeInputs() {
  return {
    held: () => 0, wanted: () => 0, required: () => 0, allow() {}, bytesChanged() {}, retain() {}, forget() {}, failureOf: () => null,
    acquire: async () => null,
    take(output, index) {
      const originSeconds = output.timeline?.published?.[index] ?? output.timeline?.boundaries?.[index] ?? index * 4;
      return { kind: "result", fingerprint: String(index).padStart(64, "0"), originSeconds, bytes: 1,
        tracks: [], release() {}, stream: async function* () { yield Buffer.alloc(0); } };
    }
  };
}
