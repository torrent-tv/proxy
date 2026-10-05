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
projects them into WebTorrent selections and storage priorities. Registry batches
selection changes before one global DeadlineScheduler pass. Reentrant library
wire updates cannot rescan a partly published map.

DeadlineScheduler orders missing pieces by deadline, priority, list order and
piece number across all live torrents. Each peer retains its protocol request
capacity and piece verification. A faster peer can replace a block request whose
predicted completion misses its deadline. Compiled piece demand is reused until
the register changes; actual piece availability is read again on every pass.

FutureDownload uses the same ordering and request-capacity rules against an
isolated copy of peer state. A piece becomes available only after every block is
received. Unmeasured completion remains unknown. Concurrent source reports share
one forecast; a changed or withdrawn map invalidates that forecast.

## Storage and input

Storage owns residence and atomic acquisition of available input. Held pieces
cannot be evicted. Capacity-driven removal follows the published map and announces
changed availability, causing unfinished media reads and input admission to retry.

The encoder receives complete admitted input under its memory allowance. It never
reads a source URL or waits for the torrent to fill an incomplete input. A stopped
or superseded request releases its reservation. Completed segments remain facts
available to every compatible viewer.

A fully retained source is described by its whole files after its torrent closes.
It continues to answer availability and source facts without rebuilding a torrent.
Open admission reads participate in file ownership before asynchronous reading.

## Pause

A paused viewer retains its priorities until urgent selected input, output and
subtitle work is ready. Its priorities then gradually approach 1 as pause time
increases. They never become zero through attenuation. Competition is counted per
source file, including viewers using different outputs; a sole viewer keeps full
priority. Explicit resume restores full demand and a seek resets pause time.
