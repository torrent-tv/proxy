/**
 * @file How much of what this proxy hands to its viewers' connections is not
 * the film.
 *
 * A viewer's link carries the picture and the soundtrack AND everything else
 * this proxy sends down the same connection: the framing of every data-channel
 * message, playlists, answers to progress polls, delivery probes, pushed
 * subtitle cues, segments sent and then abandoned. A load that counts only the
 * picture and the sound asks the link for less than it will be given
 * (torrent-tv/meta#169).
 *
 * What is counted, all of it in bytes handed to a data channel, which is the
 * level the browser's own link measurement is taken at — application bytes,
 * without SCTP, DTLS, UDP or IP framing — and all of it at the moment it is
 * sent, so the three counts always describe the same messages:
 *
 * 1. `sent` — every message handed to a channel, frame headers included;
 * 2. `media` — the bodies of segment and init responses delivered whole;
 * 3. `measurement` — the bodies of the link measurement and the delivery sink,
 *    which are sent when a connection is made or on request and are not part
 *    of watching a film.
 *
 * The share is `(sent - media - measurement) / media`: what the film costs
 * the link beyond itself, per byte of film. Counted over the life of the
 * process and across every connection, because a viewer about to open a film
 * has no history of their own and the traffic around a film is the proxy's,
 * not the person's.
 */

/** Which kind of response a request path asks for. */
export const DELIVERY_KIND = Object.freeze({
  MEDIA: "media",
  MEASUREMENT: "measurement",
  SERVICE: "service"
});

const MEDIA_FILE = /\/(?:segment-\d+\.[a-z0-9]+|init\.mp4)$/u;
const MEASUREMENT_ROUTE = /^\/api\/(?:link-probe|delivery-sink)$/u;

/**
 * What a data-channel request path asks for.
 *
 * @param {string} path - The request path, query included or not.
 * @returns {string} One of {@link DELIVERY_KIND}.
 */
export function deliveryKindOf(path) {
  const bare = String(path ?? "").split("?")[0];
  if (MEDIA_FILE.test(bare)) return DELIVERY_KIND.MEDIA;
  if (MEASUREMENT_ROUTE.test(bare)) return DELIVERY_KIND.MEASUREMENT;
  return DELIVERY_KIND.SERVICE;
}

export class DeliveryShares {
  #sent = 0;
  #media = 0;
  #measurement = 0;

  /**
   * A response body handed over whole.
   *
   * @param {string} path
   * @param {number} bytes
   */
  recordBody(path, bytes) {
    if (!(Number.isFinite(bytes) && bytes > 0)) return;
    const kind = deliveryKindOf(path);
    if (kind === DELIVERY_KIND.MEDIA) this.#media += bytes;
    else if (kind === DELIVERY_KIND.MEASUREMENT) this.#measurement += bytes;
  }

  /**
   * One message handed to a channel, whatever it carries.
   *
   * @param {number} bytes
   */
  recordSent(bytes) {
    if (Number.isFinite(bytes) && bytes > 0) this.#sent += bytes;
  }

  /**
   * What the film costs the link beyond itself, per byte of film, or null
   * while no film has been delivered.
   *
   * Never below zero: a body is counted once its last message has gone, so
   * the two counts agree exactly between responses and the body's own
   * messages are already in `sent` when it is counted.
   *
   * @returns {number | null}
   */
  serviceShare() {
    if (this.#media <= 0) return null;
    return Math.max(0, (this.#sent - this.#media - this.#measurement) / this.#media);
  }

  /**
   * The counts behind the share, for a log line.
   *
   * @returns {{ sentBytes: number, mediaBytes: number, measurementBytes: number, serviceShare: number | null }}
   */
  figures() {
    return {
      sentBytes: this.#sent,
      mediaBytes: this.#media,
      measurementBytes: this.#measurement,
      serviceShare: this.serviceShare()
    };
  }
}
