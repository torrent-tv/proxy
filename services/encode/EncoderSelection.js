/**
 * @file The encoder this host currently uses for new video outputs.
 *
 * Detection chooses the initial descriptor. A genuine hardware encoder failure
 * moves the host to software for the rest of the process. That mutable choice
 * belongs to encoding, not to the server composition object.
 */

export class EncoderSelection {
  #current;
  #softwareDescriptor;

  /**
   * @param {object} params
   * @param {object | null} params.detected
   * @param {() => object} params.softwareDescriptor
   */
  constructor({ detected, softwareDescriptor }) {
    this.#softwareDescriptor = softwareDescriptor;
    this.#current = detected ?? softwareDescriptor();
  }

  get current() {
    return this.#current;
  }

  /**
   * Select software encoding and return the descriptor that failed.
   *
   * @returns {object | null}
   */
  useSoftware() {
    if (this.#current?.kind === "software") return null;
    const failed = this.#current;
    this.#current = this.#softwareDescriptor();
    return failed;
  }
}
