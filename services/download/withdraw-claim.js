/**
 * @file Withdrawing the claim that this proxy has a piece.
 *
 * **The fact has one owner and it is the store.** The store holds the bytes, so
 * it says what this proxy has. The library keeps a second copy of that fact in
 * its completion bitfield, and until 2026-09-12 nothing reconciled the two: the
 * disk tier drops a piece once every reader is past it — correctly, and that is
 * what bounds the spill — while the bitfield went on saying the piece was
 * verified. A read then concluded the piece was had, asked for it, was told it
 * was absent, and failed. Nor was it ever fetched again, because the library
 * does not download what it believes it already owns.
 *
 * Field 2026-09-12: a film played 80 seconds; the encoder ran on to 725 s, so
 * some 565 spilled pieces fell behind every read head and were dropped,
 * including piece 0; the encoder then lost its input and restarted, which
 * re-opens the input at byte 0; and `/stream` answered `0 of 2363497962 bytes:
 * Piece 0 is verified but absent from the store` to every read for the next 92
 * minutes while the browser retried one segment and the picture stood still.
 *
 * So the eviction's own bargain — "a seek back re-downloads it" — is made true
 * here, and the bitfield becomes a projection of what the store holds.
 *
 * **Why it is a plain function.** It takes the values it needs and holds
 * nothing: no pool, no store, no client. That is what lets it be exercised with
 * an object literal, and it is the rule the layers are checked against — a layer
 * must be usable with plain values alone, with no process, no disk and no clock.
 */

/**
 * Tell the library it no longer has a piece, so the next read of it waits for a
 * download instead of failing.
 *
 * **What it deliberately does not do.** The library's `_markUnverified` would
 * also re-select the piece; it does not here, because every torrent is added
 * with `deselect: true`, which sets the library's own `_startAsDeselected` and
 * makes it skip that call. The download set has exactly one owner —
 * `SwarmSelection`, from the priority map — and a withdrawn piece is fetched
 * again when a read states it, which is the same statement every other piece
 * waits on.
 *
 * @param {object} what
 * @param {number} what.index - The piece the store can no longer produce.
 * @param {object[]} [what.files] - The store's own files; the torrent that owns
 *   them is found through one of them, because the store has no idea what a
 *   torrent is.
 * @param {object} [what.torrent] - Given directly instead of through `files`.
 * @param {(line: string) => void} [what.warn] - Said when the library refuses.
 * @returns {"withdrawn" | "nothing-to-withdraw" | "no-torrent" | "refused"}
 */
export function withdrawClaim({ index, files, torrent, warn = () => undefined }) {
  if (!Number.isInteger(index) || index < 0) {
    return "nothing-to-withdraw";
  }
  const owner = torrent ?? files?.[0]?._torrent ?? null;
  // A torrent being destroyed is the ordinary case at the end of a session, and
  // it has no claim left to withdraw: the store is going with it.
  if (!owner || owner.destroyed || typeof owner._markUnverified !== "function") {
    return "no-torrent";
  }
  // NOTHING TO WITHDRAW, which is most of the time: the store also drops pieces
  // it never completed, and marking one unverified that the library already
  // knows is missing would re-create the piece and discard whatever blocks are
  // in flight for it.
  if (!owner.bitfield?.get?.(index)) {
    return "nothing-to-withdraw";
  }
  try {
    owner._markUnverified(index);
  } catch (error) {
    // This reaches into the library's own bookkeeping. If a later version
    // changes it, the honest result is a line saying so rather than an eviction
    // that fails.
    warn(
      `could not withdraw the claim on piece ${index} of ${owner.name ?? "?"}: ` +
      `${error?.message ?? error}`
    );
    return "refused";
  }
  return "withdrawn";
}
