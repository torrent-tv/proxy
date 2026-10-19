# Browser–proxy playback contract

This document records the HTTP contract used by the browser playback code and
implemented by this proxy. The same paths and payloads pass through either the
direct HTTP transport or the WebRTC data channel. It is a description of the
current code. Source registration declares the map playback contract; the page
requires that declaration before using event-driven preparation.

## Source and file discovery

| Request | Required input | Successful answer |
|---|---|---|
| `POST /api/sources` | `{ sourceType, source, consumerId }`; older pages may omit `consumerId` | `{ sourceKey, playbackMapVersion: 1 }` identifies the source and declares source viewer reports and event-driven preparation. The page reports an update requirement if the declaration is missing. |
| `GET /api/sources/:sourceKey/files?consumerId=ID&generation=N&linkMbps=M&linkSampleAgeMs=MS&waitElapsedMs=MS` | Registered `sourceKey`; viewer/action identity, the separately measured client link and age, and monotonic elapsed time since a known original action | Waits for metadata, terminal failure or cancellation without an elapsed deadline. Success returns `{ name, infoHash, files, items, shape }`. `files` carries `fileIndex`, `name`, `relativePath`, `length`, `kind`, exclusion facts and, when a host-matched observation exists, `waitEstimate` for video files. `items` omits samples and release-group promos, maps video indices to audio, subtitle and image indices, and carries filename-derived `episode` metadata. The visible indices are recorded for the viewer. |
| `GET /api/sources/:sourceKey/stats?fileIndex=N&consumer=ID&generation=N&fileName=NAME&fileLength=BYTES&linkMbps=M&linkSampleAgeMs=MS&waitElapsedMs=MS` | Registered source; viewer/action identity, selected file facts when locally known, separately measured client link and age, and monotonic elapsed action time | Current peer, transfer, header, and file progress readings. A reading may not contain every measurement; absent or `null` measurements are unknown. While source or torrent metadata is pending, the response may still carry a host-matched `waitEstimate` when the page supplied the selected file facts; absent history leaves it out. |
| `POST /api/sources/:sourceKey/warm` | Registered source | Compatibility acknowledgement `{ started, swarm, edges: false, fill: false }`. This does not create a download order; present viewers determine preparation. |
| `POST /api/sources/:sourceKey/files/:fileIndex/viewer` | `{ consumerId, positionSeconds, generation, playing, waiting }` and optional seek, buffer and visibility readings | `{ received: true }` records direct playback. An obsolete selection returns `409`, `code: REQUEST_OBSOLETE`, `canRetry: false`. Older generations cannot restore a previous position. |
| `GET /api/sources/:sourceKey/files/:fileIndex/container-metadata` | Registered source; file index | `200` with what the file states about the work: `{ title, otherTitles, segmentTitle, seriesTitle, season, episode, episodeId, episodeTitle, year, itemYear, genres, description, externalIds, trackTitles, chapterTitles, cover, outsideEdges }` (`services/media/container/work-tags.js`). `202 { status: "pending" }` while the first or last piece of the file has not arrived; `404` where the format states nothing this proxy reads. Read only from the edges of the file, which opening it fetches anyway, and from bytes already held; `outsideEdges` says something lay elsewhere and was left out. |
| `GET /api/sources/:sourceKey/files/:fileIndex/cover` | Registered source; file index | `200` with the cover image the file carries (Matroska attachment `cover.*`, MP4 `covr` or QuickTime artwork), typed by its bytes, at most 4 MiB. `202` while it has not arrived; `404` where there is none. Nothing keeps it but the file; the page shows it through a `blob:` address. |
| `GET /api/link-probe?bytes=N` | Positive byte count | A no-store binary body of zero bytes, capped at 2 MiB. The browser measures completed transfer time; an unavailable route leaves link speed unknown. |

The file list waits for metadata instead of returning an elapsed-time pending
answer. Legacy plan responses can still carry `pending: true`, which means
unknown facts rather than no video. File-list answers use proxy file indices;
the browser keeps those indices when opening a file.

## Playback plan and transcode session

`POST /api/playback-plan` takes `{ sourceKey, fileIndex, userAgent, consumerId,
positionSeconds, wantsToPlay, waitForReady }`. With `waitForReady: true`, it
subscribes before checking and waits for facts, a terminal refusal or caller
cancellation; it has no production deadline. Its answer
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

Each `audioTracks` entry may carry `bitrateKbps`, the average rate the file
states for the track, and `peakKbps`, the most the track's codec configuration
allows it to carry (AAC-LC with 1024-sample frames, and AC-3; any other
configuration has none). Both may be `null`. The browser does not need them;
the proxy uses them to decide how the track is produced. A late header keeps a
known value and withdraws `peakKbps` only when it contradicts the configuration
it was computed from.

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
`soundtrack`, and `lookaheadSeconds`. `masterPath` and `variantHeight` are
present only when the session has quality variants.

`transcodeAudio` states whether the browser can play the selected track as it
is. The proxy decides the actual mode: it copies a track the browser plays
when the track has a `peakKbps` or a `bitrateKbps`, and otherwise re-encodes it
to stereo AAC at 128 kbit/s, including a track the browser could play.
`soundtrack` is `{ trackIndex, transcode }`, the track this viewer is sent and
whether it is re-encoded. Older proxies omit it.

The browser interprets `409` with `outcome: "output-unavailable"` as a refusal
for this viewer's link and `outcome: "no-capacity"` as a proxy capacity
refusal. Other non-success statuses remain errors; an error body only adds
display detail and is not required for status handling. For
`output-unavailable`, `figures.verdict` is `"no safe bound"` when a part of the
load has no figure; `figures.videoClass` and `figures.audioClass` are
`"unknown"` for that part, and `figures.soundtracks` is the number of
soundtracks the viewer can choose from.

## Separate WebRTC control connection

The media SDP answer advertises `separateControl: 2`. A page that sees this
creates a second `RTCPeerConnection` to the same proxy, carrying only the reliable,
ordered `proxy-control` data channel. Its offers, answers and ICE candidates carry
an opaque `connectionId`, unique for each control connection attempt. Signals
without that field retain their existing media meaning. Control uses its own
browser signalling socket through the existing route and proxy tunnel, so its
next connection can be established even after the media signalling socket has
closed during a server release. Established data channels survive signalling
loss. Version `true` was the earlier capability restricted to the media socket;
pages requiring independent signalling treat that value as legacy.

The proxy addresses transport counters by the media signalling session id or, for
control, `<sessionId>/<connectionId>`. Only one control generation per signalling
session is retained. A replacement closes its predecessor; late candidates and
close events from that predecessor cannot affect the replacement or media peer.

Media paths (`/transcode/`, `/stream`, `/media`), speed samples (`/api/link-probe`,
`/api/delivery-sink`), complete subtitle files (`GET /api/subtitles`), embedded
covers and chunked large request bodies use the media association. Small API
requests, including subtitle selection, and their complete responses use control.
The page identifies the same viewer on both associations, using the existing
many-connections-to-one-viewer presence relation. Closing either association alone
does not release a viewer still present on the other. Probes, counters and silence
decisions are separate for each association.

Once the last connection carrying a viewer closes, their presence ends before
output disposal waits for child processes. Late reports, seeks, media requests
and completed preparations cannot register that viewer again. Reports and seeks
for an absent viewer return `404`; arrival or an explicit source/output opening can
establish a new viewing. An opening already in progress cannot attach to a
different viewing created by a reconnect under the same viewer identifier.

Initial connection preparation waits for both required channels. Established
control loss rejects only requests sent on that channel and starts independent
control connection preparation. Sent actions are never replayed automatically.
Old proxies that omit the capability keep control on the media peer; old pages
continue to work without sending `connectionId`.

## Session control and media files

| Request | Meaning |
|---|---|
| `POST /api/transcode-sessions/:id/seek` | `{ positionSeconds, consumerId, generation }` reports the viewer's seek. A successful answer is `204`; the proxy handles the seek server side. |
| `GET /api/transcode-sessions/:id/progress?consumer=:id` | Reads current session progress and also keeps the viewer's session alive. `playbackReadiness` is the proxy's versioned forecast used to release the startup wait; missing or unsupported versions do not authorize playback. An unreadable or failed answer does not imply that playback has ended. |
| `POST /api/transcode-sessions/:id/net-report` | `{ consumerId, bufferedAheadSec, ... }` reports the viewer's buffer and optional state/link measurements. `consumerId` and non-negative `bufferedAheadSec` are required. `linkMbps` is the smoothed estimate used by the quality budget; `linkSampleMbps` and `linkSampleAt` carry the newest raw delivery measurement and its sample time for the readiness forecast. `bufferLimitSeconds` states the browser's accepted forward-buffer ceiling. Missing optional values do not reject the report or erase the last known value. Missing `playing` becomes `false`; missing `waiting` is derived from the playback and buffer state. Missing `positionSeconds` leaves the position unchanged, missing `qualityMode` leaves the prior mode, `onScreen` defaults to `true`, and `inPictureInPicture` defaults to `false`. Success is `204`. |
| `POST /api/transcode-sessions/:id/fragment-far` | Diagnostic fragment and buffer positions; does not change encoding. Best effort, success `204`. |
| `POST /api/transcode-sessions/:id/release` | `{ consumerId, reason }` releases this viewer's session assignment. |
| `GET /transcode/:id/:fileName` | HLS playlist, init, or media segment. A file that is still being produced is answered with retryable `503`, not `202`. |
| `GET /transcode/:id/v/:height/warm` and `/transcode/:id/a/:track/warm` | Prepare the requested video height or audio track at a position. `204` means ready. Audio warm-up `404` means the proxy does not support this operation for that session. Audio warm-up takes an optional `transcode=0\|1`: whether the browser cannot play THAT track's codec as it is. The proxy decides the track's mode by the rule used when a file is opened; without the parameter it assumes the browser needs what it needed for its current track. Audio warm-up `503` with `{ warming: true }` means the track and its mode are recorded for this viewer and its segment is still being made; any other `503`, and `500`, recorded nothing. |
| `GET /stream?sourceKey=…&fileIndex=N` | Direct file bytes with HTTP range support. |

### Playback readiness forecast

The file list may carry an initial `waitEstimate` before a transcode session
exists, so the browser can start its countdown at file selection without a new
round trip. The source statistics response may revise that estimate as current
source readings arrive. The optional viewer and `generation` query fields scope
both responses to one viewer action. Before a transcode session exists, the
page supplies its separately measured client-link rate and the age of its
newest sample; this does not combine client delivery with peer-to-proxy
download. The proxy compares all measurements shared with its closest saved
first-frame outcome on the current encoder configuration. Older saved outcomes
may not have a link reading, so that dimension cannot affect their match. When
the original action time is known, the page sends elapsed time measured by its
monotonic clock and the proxy subtracts it from the saved full wait. The page
also measures request round-trip time and applies it once as response age. Later
source-statistics requests carry the current action age, so a new reading does
not restart a full-wait countdown. Older pages without this input use the
proxy's monotonic time since its first reading. After output creation, the same
wait identity is revised with the selected per-track copy or encode path and
its measured processing rates. This value is an initial point estimate; it
does not authorize playback and does not replace the full readiness
calculation.

| Field | Meaning |
|---|---|
| `version` | Initial-estimate contract version (`1`). |
| `waitId` | Source, file and viewer-action identity; a different action starts a separate countdown. |
| `revision` | Increases when a new merged measurement updates the same wait. |
| `remainingSeconds` | Host-matched full first-frame observation minus elapsed action time, floored at zero, in seconds. |
| `ageMs` | Request round-trip age measured by the page and subtracted once when the countdown starts. |

If the current encoder configuration has no saved first-frame observation for
the same file suffix, this field is omitted. A first-frame observation is
learned only when the browser reports that the required audio range covers the
presented frame. This does not meet the one-second availability requirement
for an action without a matching observation; do not substitute the time to
read the container header for the time to present the first frame.

The initial value is an empirical estimate, not the playback permission. The
proxy keeps up to 20 measured first-frame outcomes for the same current set of
proxy encoder configurations. Each outcome records the original wait duration
with the file size, suffix, source download rate, remaining container-header
bytes, connected peer count, and browser-proxy link rate available at the file
list and latest source-statistics readings. Missing readings stay missing;
measured zero rates and zero peers stay zero. Outcomes from another available
encoder-configuration set are discarded, because its proxy work is not known to
match this one. Later snapshots also retain the measured video and audio copy or
encode paths and their processing rates, keeping the two tracks as separate
inputs to the model; these are already reported in the active `playbackReadiness`
operations and do not add fields to `waitEstimate`.

For a prediction, outcomes with another file suffix are excluded. Each available
numeric input is transformed as `ln(1 + x / s)`, where `s` is the median
positive value for that input in the candidate observations. The proxy chooses
the observation with the smallest mean squared difference over inputs present
in both the current readings and that observation; ties choose the newer
observation. The measured outcome includes the proxy's actual work, rather than
adding a second estimate for proxy work. This closest-observation model has no
measured 90th-percentile error result yet and cannot return a value before the
proxy has at least one usable outcome. The full readiness forecast later
replaces this initial value when it has a finite delay.

The progress response may include `playbackReadiness`:

| Field | Meaning |
|---|---|
| `version` | Forecast contract version. The browser releases its startup wait only for version `1` with `ready: true`. |
| `ready` | The measured service model meets the remaining presentation deadlines and real client tracks cover the current position. Browser capacity is not an admission condition. |
| `delaySeconds` | When `ready` is false, the predicted minimum delay from now to a safe start; `null` means the current measurements do not support a finite forecast. |
| `measuredAt`, `predictedStartAt` | Proxy-clock observation and conditional start time, in milliseconds. The UI counts down using its own elapsed clock, without comparing clocks across machines. |
| `operations` | Required video/audio operations, their source/output codecs, current speed and processed position. |
| `preparedUntilSeconds` | Continuous proxy media predicted to be available at the forecast start. |
| `bufferedSeconds` | Client buffer reported to the proxy. |
| `reserveSeconds` | Maximum interruption reserve across the required video and selected audio outputs, derived from each output's measured supply waits and next segment duration. |
| `neededSeconds` | Reserve shortfall at the current client buffer. |
| `reason` | Machine-readable result of the forecast. |
| `unavailableSource` | Optional diagnostic for unavailable source service or input ranges. Missing-range reports identify `sourceId`, `trackId`, `segmentIndex` and `phase` (`near` or `tail`); these facts explain the unavailable forecast and do not authorize playback. |
| `preparedSegments` | Number of already-produced output segments available across required tracks. |
| `bufferedAtStartSeconds` | Forecast playable buffer at the proposed start time, when a finite delay is available. |
| `subtitles` | The subtitle this viewer chose for the file, as `{ fileIndex, trackIndex, ready }`, or `null` when none is chosen. Always present, so the browser can tell a proxy that weighed the choice from one that predates it. While the chosen track has not been read at the viewer's position, `ready` is false with reason `subtitles-pending` and `delaySeconds: null`. |

The forecast considers the video output and the selected audio output when audio
is delivered separately. A mixed output can depend on more than one source
file. Repeated source files are counted once; distinct files keep separate
remaining-work estimates and share the measured download rate of their torrent.
The browser reports buffer state and delivery measurements, but does not
calculate or override readiness.

The subtitle the viewer chose (`POST /api/subtitles`) is the last input the
forecast waits for: one segment of that track at the viewer's position, read at
the picture's urgency. The wait ends with its cues or with the proxy's refusal
to read the track, at any of the reads before them (track table, media info,
packet index, cues). The browser does not decide readiness for subtitles; it
only does not release the startup wait on a forecast taken before its own
start choice reached the proxy (torrent-tv/meta#8).

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
