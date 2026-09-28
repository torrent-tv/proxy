# Browser–proxy playback contract

This document records the HTTP contract used by the browser playback code and
implemented by this proxy. The same paths and payloads pass through either the
direct HTTP transport or the WebRTC data channel. It is a description of the
current code, not a generated schema or a version negotiation protocol.

## Source and file discovery

| Request | Required input | Successful answer |
|---|---|---|
| `POST /api/sources` | `{ sourceType, source }` | `{ sourceKey }` identifies the registered source. |
| `GET /api/sources/:sourceKey/files?maxWaitMs=N` | Registered `sourceKey`; optional wait budget | While magnet metadata is unavailable: `{ pending: true }`. When ready: `{ name, infoHash, files, items }`. `files` carries `fileIndex`, `name`, `relativePath`, `length`, and `kind`; `items` maps each video `fileIndex` to audio, subtitle, and image file indices. |
| `GET /api/sources/:sourceKey/stats?fileIndex=N` | Registered source; optional file index | Current peer, transfer, header, and file progress readings. A reading may not contain every measurement; absent or `null` measurements are unknown. |
| `POST /api/sources/:sourceKey/warm` | Optional `{ fileIndex, positionSeconds }`; an empty object warms source metadata and the first video | `{ started, swarm, edges, sidecars }` reports which preparation started. Work continues in the background. |
| `GET /api/link-probe?bytes=N` | Positive byte count | A no-store binary body of zero bytes, capped at 2 MiB. The browser measures completed transfer time; an unavailable route leaves link speed unknown. |

`pending: true` means the requested metadata or plan is not ready yet. The
browser polls again. It does not mean that the torrent has no video or that the
request failed. A non-pending file-list answer uses the proxy's file indices;
the browser must keep those indices when opening a file.

## Playback plan and transcode session

`POST /api/playback-plan` takes `{ sourceKey, fileIndex, userAgent }`. Its answer
contains `mode`, `directUrl`, codec and container names, duration and source
dimensions, track inventories, paired sidecar files, `offeredHeights`, and
`pending`. The browser uses the codec fields to make the direct-versus-transcode
decision itself; `mode` is advisory.

`sidecarSubtitles` lists subtitle files the proxy paired with this video. Each
entry carries the torrent `fileIndex` and the proxy's filename-derived language
and release metadata. The browser uses these entries to fetch subtitle files
and to identify a remembered choice. `sidecarImages` is returned beside it but
is not needed for playback. Older proxies and plans made with transcoding
disabled may omit these fields; the browser treats a missing or non-array list
as empty.

The browser maps a missing `mode` to `direct`, uses its registered `/stream`
URL when `directUrl` is absent, maps missing codec/container names to empty
strings, maps missing duration or dimensions to `0`, and maps missing audio or
subtitle track arrays to `[]`. It maps missing or non-object `offeredHeights` to
`null`; for an object value, missing or invalid `copy` and `transcode` lists
become empty arrays. `null` means no offer was supplied, while empty lists
explicitly offer no heights for their respective playback branch. Only
`pending: true` asks the browser to poll again.

`POST /api/transcode-sessions` requires `sourceKey`, `fileIndex`, and
`consumerId`. The browser also sends the requested audio/video transcode flags,
the visible picture size, whether audio is requested as separate renditions,
the start position, selected audio track, and segment format when known. The
answer contains `sessionId`, `playlistPath`, `offeredHeights`, declared `tracks`,
and `lookaheadSeconds`. `masterPath` and `variantHeight` are present only when
the session has quality variants.

The browser interprets `409` with `outcome: "output-unavailable"` as a refusal
for this viewer's link and `outcome: "no-capacity"` as a proxy capacity
refusal. Other non-success statuses remain errors; an error body only adds
display detail and is not required for status handling.

## Session control and media files

| Request | Meaning |
|---|---|
| `POST /api/transcode-sessions/:id/seek` | `{ positionSeconds, consumerId, generation }` reports the viewer's seek. A successful answer is `204`; the proxy handles the seek server side. |
| `GET /api/transcode-sessions/:id/progress?consumer=:id` | Reads current session progress and also keeps the viewer's session alive. The browser consumes available progress fields; an unreadable or failed answer does not imply that playback has ended. |
| `POST /api/transcode-sessions/:id/net-report` | `{ consumerId, bufferedAheadSec, ... }` reports the viewer's buffer and optional state/link measurements. `consumerId` and non-negative `bufferedAheadSec` are required; missing `linkMbps` does not reject the report and leaves the last link reading intact. Missing `playing` becomes `false`; missing `waiting` is derived from the playback and buffer state. Missing `positionSeconds` leaves the position unchanged, missing `qualityMode` leaves the prior mode, `onScreen` defaults to `true`, and `inPictureInPicture` defaults to `false`. Success is `204`. |
| `POST /api/transcode-sessions/:id/fragment-far` | Diagnostic fragment and buffer positions; does not change encoding. Best effort, success `204`. |
| `POST /api/transcode-sessions/:id/release` | `{ consumerId, reason }` releases this viewer's session assignment. |
| `GET /transcode/:id/:fileName` | HLS playlist, init, or media segment. A file that is still being produced is answered with retryable `503`, not `202`. |
| `GET /transcode/:id/v/:height/warm` and `/transcode/:id/a/:track/warm` | Prepare the requested video height or audio track at a position. `204` means ready. Audio warm-up `404` means the proxy does not support this operation for that session. |
| `GET /stream?sourceKey=…&fileIndex=N` | Direct file bytes with HTTP range support. |

## Subtitles

`GET /api/subtitles` requires `sourceKey` and `fileIndex`. Without `trackIndex`
it reads a paired sidecar file. With `trackIndex`, it reads cues from an
embedded text track and may take `consumerId` to subscribe that viewer to
subsequent cue pushes. `since` asks for cues after a previously received
cursor.

`200` returns WebVTT. Embedded cue answers may include
`X-Subtitle-Cursor`, `X-Subtitle-Covered-Clusters`, and
`X-Subtitle-Indexed-Clusters`; language detection may include
`X-Subtitle-Language` and `X-Subtitle-Language-Name`. While an embedded track
is being extracted, the response is `202` with `{ pending: true }`; the browser
waits and repeats the request. A missing cursor or language header means that
the browser has no value to preserve or display yet. A failed sidecar or
embedded-track request skips that track without failing video playback.

Subtitle cue pushes are delivered through the established proxy connection,
not by a separate browser polling route. After reconnect, the browser repeats
the embedded-track request with `since` to restore the subscription and receive
missed cues.
