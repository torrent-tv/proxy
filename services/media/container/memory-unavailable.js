/** A resource shortage is pending work, not evidence of damaged media. */
export class IndexMemoryUnavailable extends Error {
  constructor(bytes) {
    super(`Packet index requires ${bytes} additional allocation bytes.`);
    this.name = "IndexMemoryUnavailable";
    this.bytes = bytes;
  }
}
