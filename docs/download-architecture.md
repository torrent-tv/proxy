# Download architecture

## Owners and maps

The viewer layer owns source selection, position, playback intent, pause time,
selected tracks and visible files. PriorityOrchestrator builds the per-output
production map and the merged per-file playback map. SourcePreparation owns
metadata and index work derived from those same viewers before an output exists.

DownloadMaps publishes one byte map per file. It combines exact playback input
ranges, native source playback ranges and metadata reads that returned missing
bytes. Only this publication can state download demand. A media read cannot
select a torrent piece, and a storage read cannot create download demand.

The media layer resolves segment input once for both download demand and encoder
admission. It reads available bytes and returns a result, missing ranges, memory
requirements or an explicit terminal refusal. Results belong to the source file;
only outstanding work is withdrawn when viewer demand changes.

## Publication and scheduling

DemandRegister retains windows by claimant and exposes a revision. SwarmSelection
projects them into public WebTorrent selections and storage priorities. Only
the highest missing urgency and priority group with the earliest required time
is selected. When it is satisfied,
the next group becomes eligible. The map retains all lower groups. The registry
applies this ordering across torrents sharing the host. Adjacent and overlapping
ranges in the eligible group are published as a union, matching the library's
public selection merging. Publishing background ranges alongside urgent ranges
would otherwise merge them and lose the urgent interval's independent selection.

A file's zones are resolved to bytes in the order of their deadlines, and the
first pass over a film works out thousands of them. Before that pass works out
a zone of a lower priority than any before it, what it has resolved is
published, with the zones still retained for what it has not reached; the
bytes the swarm is to fetch first never wait for the far end of the film. A
pass over zones already worked out publishes once, at its end. The start
forecast needs the whole pass, so the pass shares the main thread in equal
turns (`utils/take-turns.js`): it hands the thread back once it has run as
long as the rest of the thread took in its own last turn (torrent-tv/meta#178).

WebTorrent chooses peers, protocol blocks, request capacity and reassignment.
The proxy does not replace its methods. Withdrawn selections cancel obsolete
requests; selections shared by remaining demand keep their requests. `critical`
marks missing blocked-read ranges through the public API.

FutureDownload observes outstanding peer queues, advertised pieces and measured
peer rates. Complete queues provide a piece's arrival. For unrequested blocks,
the public map establishes the order between bands, including required times
when priorities tie; every piece in a band uses
the completion time of that whole band, because the native picker determines
the order within it. Service times are summed across torrents instead of spending
the same supply concurrently. A piece without a measured supplier leaves its
band and later bands unknown; observed complete queues remain usable. The estimate
is conditional on continued supply and successful verification. It never issues
requests or replaces WebTorrent's picker.
Concurrent source reports share one forecast; a changed or withdrawn map
invalidates that forecast. Unknown arrival affects the estimate, not download
selection or encoder admission of bytes that have actually arrived.

## Storage and input

Storage owns residence and atomic acquisition of available input. Held pieces
cannot be evicted. Capacity-driven removal follows the published map and announces
changed availability, causing unfinished media reads and input admission to retry.

The encoder receives complete admitted original-file ranges under its memory
allowance, through a loopback-only HTTP address owned by its run. Each response
runs to the end of the retained range the read starts in: FFmpeg 6.1 takes a
shorter answer for the end of the input. Missing positions return
503 immediately; reading never waits for the torrent. FFmpeg demuxes the original
container and selects its tracks. Matroska Cues supply coarse media ranges without
parsing media block headers. An AVI `idx1` or OpenDML index states every
packet's offset, length and keyframe flag, and its decoding position is its time;
the ranges are the header, the index FFmpeg reads at open, the first packet of
each stream and the packets of the interval, from the keyframe two before it.
AVI states no presentation time, so a picture whose codec may reorder is
re-encoded rather than copied (`KeyframeTable.copyable`). Original-source input
is enabled when every selected file can name its ranges this way, for fMP4 and
MPEG-TS output alike. Other layouts and AVI without an index retain their
existing indexed input:
a finite FFprobe interval does not establish addresses for the full future map.
A stopped or superseded request releases its
reservation. Completed segments remain available to every compatible viewer.

An original-input run is given one finite stretch of segments, copied once,
so FFmpeg opens the file once per stretch instead of once per segment
(torrent-tv/meta#158). The run starts once what FFmpeg opens with — the
header, the index, the stream search — is copied; the largest range, the film
itself, is copied after it in one read while FFmpeg opens, and
a read inside it waits for it (torrent-tv/meta#178). `EncodeInputs` ends the
stretch at the largest segment, within the plan's bound for the run, such that:

1. every byte of the stretch is downloaded whole now (storage's held ranges; a
   snapshot, and the copy refuses where a piece has gone since);
2. copying it takes no longer than opening the input: the recent copy rate,
   timed around the reads of real admissions, times this output's recent open,
   which is the time from a run's spawn to the name of its first closed piece
   less that piece's encoding at the run's speed and less the time FFmpeg's
   reads waited for the stretch to be copied. Until both are measured a run
   gets one segment;
3. it fits the memory the budget allows. Only one segment is required of the
   budget; a longer stretch is wanted like any other claim. A stretch over the
   allowance or the policy capacity runs as its longest prefix that fits, and
   only one segment over the capacity is terminal.

The run's end, its coverage claim and its failure identity are that stretch. A
failure inside it is recorded at the run's head under the stretch it was given,
so a retry from the head is a new stretch and the same stretch failing again is
refused. Segments past the stretch are placed by the plan when their bytes
arrive or memory is freed. The next stretch is copied once the run's own
stretch is, and an input prepared or held for a start the last plan of its
output does not place — one it starts or holds back, or the number after a run
it left alive — is withdrawn, and a stretch still being copied is dropped when
its read returns. The torrent thread reads a copy's pieces as many at once as
libuv has file threads (`UV_THREADPOOL_SIZE`, 64 as the proxy starts), each written
straight into the copy; a piece shared by several ranges is read once and
divided. One after another, every read from disk waited for the thread's loop
on its own (torrent-tv/meta#178).

A fully retained source is described by its whole files after its torrent closes.
It continues to answer availability and source facts without rebuilding a torrent.
Open admission reads participate in file ownership before asynchronous reading.

## Pause

A paused viewer retains its priorities until urgent selected input, output and
subtitle work is ready. Its priorities then gradually approach 1 as pause time
increases. They never become zero through attenuation. Competition is counted per
source file, including viewers using different outputs; a sole viewer keeps full
priority. Explicit resume restores full demand and a seek resets pause time.
