# Container and track architecture

The media layer owns statements about one source file: container declarations,
tracks, packet byte addresses, presentation and decode times, random-access
positions and subtitle text. Torrent identity, download demand and viewer state
are supplied by callers; container and track classes do not import torrent code.

## Source declarations and indexing

`ContainerFactory` reads exact signature bytes and selects Matroska, MP4, AVI,
MPEG-TS, MPEG-PS or ASF. Other formats use `FfprobeContainer` when a strict probe
reader is supplied. A sidecar audio file uses the same container classes as an
embedded soundtrack. A plain subtitle document uses `SubtitleFileContainer`.

`ContainerOrchestrator` retains one container per file and serializes parser
requests. Requests carry their identity, selected tracks and presentation
interval. Completed callbacks run outside the parser queue so a callback can
request another statement without waiting on itself. Source retirement removes
retained statements and rejects late results.

Every container byte read returns the complete requested range or throws
`BytesUnavailable`. A result, proven absence or explicit terminal refusal may be
retained. Missing bytes and refused memory admission remain pending and retry
only when their respective resource changes. They never become an empty track
list, absent index or unsupported format.

Playback declarations come from this shared reader. If the header omits usable
duration, preparation requests indexed packet timing. Opening playback does not
start an independent ffmpeg URL probe. Additional demuxers supply packet
addresses, PTS/DTS, lengths and SHA-256 hashes; admission verifies that addressed
source bytes match demuxed payloads.

## Memory ownership

`IndexMemory` admits binary packet payload and address blocks before allocation.
Retained MP4 moov bytes and ASF, AVI and Matroska declaration ranges use the same
machine budget. Concurrent retained declaration reads share one owned buffer.
Temporary presentation-time sorting reserves its allocation and releases it
when the calculation ends. Retiring a source disposes all registered owners.

MP4 timing and sample addresses walk compressed tables instead of constructing
whole-track sample arrays. Subtitle samples are views of those tables. Progressive
Matroska, MPEG and AVI parsers retain completed structure and cursor position
across unavailable bytes and allocation refusal. Failed partial records roll
back before another attempt.

Matroska finds its Segment and following elements by their exact EBML headers;
unneeded payloads are skipped. AVI walks RIFF lists and indexed or sequential
media chunks, including AVIX continuations. Packet indexes retain physical
ranges separately from presentation order and decode order.

## Download demand and encoder input

1. `SourcePreparation` registers a selecting viewer before output preparation
   and requests metadata and selected-track intervals.
2. `DownloadMaps` publishes resolved source ranges and their priorities. Only
   the shared demand schedules torrent bytes; reading does not create a private
   read window or speculative download.
3. `PacketIndex.inputFor` selects the required packets, video decode start,
   reordering and audio decoder preparation. AAC includes a preceding frame;
   MP3 includes a preceding synthesis frame and its byte-reservoir dependencies.
   Copy mode does not add transcoder preparation.
4. `EncodeInputs` resolves the same indexed ranges used by download demand.
   `AdmittedInput` reserves and reads their complete bytes before ffmpeg starts.
   Packet hashes, track declarations and exact timing participate in input
   identity. PCM normalization does not modify source bytes.
5. `MatroskaInput` writes the admitted packets with their declarations and
   timestamps through stdin. A subsequent complete interval can append; an
   unavailable interval closes input. ffmpeg does not read a torrent URL or
   wait for source bytes inside an encode run.

ffmpeg produces media and performs machine capability and cost measurements.
ffprobe additionally supplies strict declarations and packet facts for formats
without a native reader. Neither operation establishes independent download
priority. Metadata activity is excluded from learned torrent CPU cost.

## Subtitles

`SubtitleOrchestrator` uses the shared container track and packet declarations.
Selected text subtitle packets request their exact source ranges through viewer
preparation. Held payloads are decoded by their container, published once with
retained delivery cursors, and updated when later timestamps resolve cue ends.
SubRip, ASS, WebVTT and MP4 text framing retain their declared times and text.

External subtitle documents declare their missing ranges through the same
viewer preparation. Cancelled selection withdraws obsolete demand. An incomplete
read never becomes an empty document. Embedded subtitle delivery does not launch
an independent ffmpeg extraction. Image subtitle tracks retain their unsupported
classification rather than silently disappearing from the inventory.

## What a file states about the work

`Container.readWorkTags(mayFetch)` answers what a file states about the work it
carries, in the one shape of `container/work-tags.js`: title, series, season,
episode, episode title, year, genres, description, external ids, track and
chapter titles, and whether it carries a cover. Each container reads its own
format: Matroska `Info/Title`, the `Tags` that name no particular track, edition,
chapter or attachment (`matroska-work-tags.js`, by `TargetTypeValue` level),
`Chapters` and the attachment named `cover.*`; MP4 the iTunes item list,
QuickTime metadata keys and user data text inside the `moov` it already holds
(`mp4-work-tags.js`); AVI `LIST INFO` before `movi`. An episode is recognised by
the numbers the file states, never by a name. The container does not decide
whether a title is a release name; the server's identification does.

`mayFetch` is `edgesOf` in `ContainerOrchestrator`: the pieces that hold the
file's first and last bytes, which opening a file fetches anyway for its hash
and its head. A read elsewhere uses only bytes already held; when they are not,
that element is left out and `outsideEdges` says so, and the reading is not kept
so a later ask can read it. A read inside the edges that has not arrived throws
`BytesUnavailable` like any other read. `readCover` returns the image's bytes,
typed by their signature and bounded by `MAX_COVER_BYTES`.

## Verification

Fragmented MP4 reads native fragment sample tables and preserves each payload
address, decode clock and composition clock. MPEG audio codec identification
uses the first addressed frame header. Regular MP4 reserves the full declared
packet table before expansion. Video cadence is read from sample timing when
codec settings omit it. Source intervals use exact retained cut times rather
than rounded playlist boundaries.

Parser and lifecycle tests use fake byte readers and fake torrent boundaries.
Synthetic media tests use local lavfi sources and pipes, compare declared packet
addresses and timestamps, and decode admitted stdin input. A real torrent must
never start on the development machine; real playback acceptance runs only on
the Home Assistant host.
