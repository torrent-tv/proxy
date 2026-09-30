# Browser–proxy playback contract

This document records the HTTP contract used by the browser playback code and
implemented by this proxy. The same paths and payloads pass through either the
direct HTTP transport or the WebRTC data channel. It is a description of the
current code, not a generated schema or a version negotiation protocol.

## Source and file discovery

| Request | Required input | Successful answer |
|---|---|---|
| `POST /api/sources` | `{ sourceType, source }` | `{ sourceKey }` identifies the registered source. |
| `GET /api/sources/:sourceKey/files?maxWaitMs=N` | Registered `sourceKey`; optional wait budget | While magnet metadata is unavailable: `{ pending: true }`. When ready: `{ name, infoHash, files, items, shape }`. `files` carries `fileIndex`, `name`, `relativePath`, `length`, and `kind`; `items` maps each video `fileIndex` to audio, subtitle, and image file indices and carries `episode` — what the name states in the release's own numbering (`season`, `episodes`, `part`, `special`, `showHint`, `titleHint`) or `null`. `shape` is `single`, `series` or `undetermined` (2.88.0); an older proxy sends neither field. |
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
dimensions, track inventories, paired sidecar files, `offeredHeights`,
`audioTracksPending`, and `pending`. The browser uses the codec fields to make
the direct-versus-transcode decision itself; `mode` is advisory.

When `audioTracksPending` is `true`, one or more sidecar headers were still
unavailable. The browser may call `POST /api/playback-plan/audio-tracks` with
`{ sourceKey, fileIndex }`; the answer contains the current `audioTracks` and
`pending`. A resolved header updates metadata on the already-published first
track for that sidecar. It never changes track indices or the number of HLS
renditions in the active plan.

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
| `GET /api/transcode-sessions/:id/progress?consumer=:id` | Reads current session progress and also keeps the viewer's session alive. `playbackReadiness` is the proxy's versioned forecast used to release the startup wait; missing or unsupported versions do not authorize playback. An unreadable or failed answer does not imply that playback has ended. |
| `POST /api/transcode-sessions/:id/net-report` | `{ consumerId, bufferedAheadSec, ... }` reports the viewer's buffer and optional state/link measurements. `consumerId` and non-negative `bufferedAheadSec` are required. `linkMbps` is the smoothed estimate used by the quality budget; `linkSampleMbps` and `linkSampleAt` carry the newest raw delivery measurement and its sample time for the readiness forecast. `bufferLimitSeconds` states the browser's accepted forward-buffer ceiling. Missing optional values do not reject the report or erase the last known value. Missing `playing` becomes `false`; missing `waiting` is derived from the playback and buffer state. Missing `positionSeconds` leaves the position unchanged, missing `qualityMode` leaves the prior mode, `onScreen` defaults to `true`, and `inPictureInPicture` defaults to `false`. Success is `204`. |
| `POST /api/transcode-sessions/:id/fragment-far` | Diagnostic fragment and buffer positions; does not change encoding. Best effort, success `204`. |
| `POST /api/transcode-sessions/:id/release` | `{ consumerId, reason }` releases this viewer's session assignment. |
| `GET /transcode/:id/:fileName` | HLS playlist, init, or media segment. A file that is still being produced is answered with retryable `503`, not `202`. |
| `GET /transcode/:id/v/:height/warm` and `/transcode/:id/a/:track/warm` | Prepare the requested video height or audio track at a position. `204` means ready. Audio warm-up `404` means the proxy does not support this operation for that session. |
| `GET /stream?sourceKey=…&fileIndex=N` | Direct file bytes with HTTP range support. |

### Playback readiness forecast

The progress response may include `playbackReadiness`:

| Field | Meaning |
|---|---|
| `version` | Forecast contract version. The browser releases its startup wait only for version `1` with `ready: true`. |
| `ready` | The proxy's simulated buffer trajectory can cover the remaining playback while preserving the measured interruption reserve, starting now. |
| `delaySeconds` | When `ready` is false, the predicted minimum delay from now to a safe start; `null` means the current measurements do not support a finite forecast. |
| `bufferedSeconds` | Client buffer reported to the proxy. |
| `reserveSeconds` | Maximum interruption reserve across the required video and selected audio outputs, derived from each output's measured supply waits and next segment duration. |
| `neededSeconds` | Reserve shortfall at the current client buffer. |
| `reason` | Machine-readable result of the forecast. |
| `preparedSegments` | Number of already-produced output segments available across required tracks. |
| `bufferedAtStartSeconds` | Forecast playable buffer at the proposed start time, when a finite delay is available. |

The forecast considers the video output and the selected audio output when audio
is delivered separately. A mixed output can depend on more than one source
file. Repeated source files are counted once; distinct files keep separate
remaining-work estimates and share the measured download rate of their torrent.
The browser reports buffer state and delivery measurements, but does not
calculate or override readiness.

Service work is the integral of a nonnegative measured-rate forecast. The latest
rate relaxes over the observed measurement span toward the lower of its latest
value and the recent mean; the measurement history covers the output look-ahead.
A positive measured rate cannot become permanently zero from an old declining
linear fit. A measured zero remains zero until a new measurement arrives.
The reported loader limit is bounded below by the browser buffer already held.
During startup waiting the browser refreshes stale delivery measurements through
the existing link probe and reports their age to avoid clock-offset errors.

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
