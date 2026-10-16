# Original input storage (#ttv-181)

The container states `commonRanges` and `intervalRanges` before merging them
into `ranges`. Only that merged admission bounds FFmpeg's reads. Common parts
cannot be recovered by comparing merged ranges: near the start of a file the
stream-search prefix and the interval are often contiguous.

`OriginalInputStore`, owned by `EncodeInputs`, keeps disjoint copied parts per
source and file. Admission reserves only missing parts synchronously, before
an asynchronous read can start. A concurrent input joins the pending read.
Reads use the available-only source reader and never request a download.
Splitting new allocations at common-part boundaries prevents a retained prefix
from retaining a large media allocation. A partially referenced allocation
remains charged in full until its last reference leaves.

Runs and unfinished HTTP responses own references. Packet learning explicitly
retains its input until its asynchronous walk ends. Its prefetch is bounded by
the current stored part; HTTP streams existing slices through the end of the
admitted range, preserving compatibility with FFmpeg versions that do not
continue a shorter response. Unused common parts survive seeks while an output
of the file exists. They are wanted memory, not required memory, and can be
reclaimed by an allowance reduction or another input's reservation.

Three sizes have different meanings. `input.bytes` is the complete admitted
input and still bounds FFmpeg's on-disk `cache:` file. Reservations cover only
additional memory. Copy-rate readings use only actually copied bytes and their
copy time; shared bytes and offset reads from completed files do not inflate
the rate. The target used by the download map retains its full-input meaning.

Completed files are leased from their existing worker-side store without
opening a torrent. The main thread opens the leased file, checks its length,
and streams requested offsets in bounded portions. The disk budget counts the
whole file once as required while any lease exists, and eviction skips it.
Closing a run leaves its HTTP reads alive; the last response closes the file
descriptor, releases the worker lease and reapplies the last disk allowance.
Full FFmpeg cache accounting is unchanged. An unavailable file releases its
lease and uses ordinary source admission instead.

The final `encode input storage of run` line reports full input bytes, copied
bytes, shared bytes and actual bytes read from disk after the input closes.
