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
ends within the retained range and is at most 1 MiB. Missing positions return
503 immediately; reading never waits for the torrent. FFmpeg demuxes the original
container and selects its tracks. Matroska Cues supply coarse media ranges without
parsing media block headers. Original-source input is enabled only when that
complete Cue map exists, the output is fMP4 and all selected tracks share one
source file. Other layouts, MPEG-TS output and combined inputs from separate
files retain their existing indexed input:
a finite FFprobe interval does not establish addresses for the full future map.
A stopped or superseded request releases its
reservation. Completed segments remain available to every compatible viewer.

A fully retained source is described by its whole files after its torrent closes.
It continues to answer availability and source facts without rebuilding a torrent.
Open admission reads participate in file ownership before asynchronous reading.

## Pause

A paused viewer retains its priorities until urgent selected input, output and
subtitle work is ready. Its priorities then gradually approach 1 as pause time
increases. They never become zero through attenuation. Competition is counted per
source file, including viewers using different outputs; a sole viewer keeps full
priority. Explicit resume restores full demand and a seek resets pause time.
