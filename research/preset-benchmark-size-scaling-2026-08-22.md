# Does the preset benchmark's pixels/sec figure hold at a different size? (2026-08-22)

Roadmap item 4(e): the software-preset benchmark (`benchmarkSoftwarePresets`,
`services/hwaccel.js`) measures encoder throughput at one fixed reference size —
640×360 — and every later use of that figure (deciding which quality rungs this
host can sustain) scales it by pixel count, assuming cost per pixel is constant
regardless of frame size. This was never checked against a second size.

## Measurement

Same clip (`cal-h264-1080-hi.mp4`), same `libx264` presets, same measurement
method as the shipped benchmark (slope between two `-progress` reports,
excluding startup) — run once at the existing 640×360 reference and once at
1280×720 (4× the pixel count), on the developer's desktop:

| preset    | 640×360        | 1280×720       | ratio (should be ~1.0) |
|-----------|----------------|----------------|-------------------------|
| ultrafast | 1322.8 Mpx/s   | 588.6 Mpx/s    | 0.445                   |
| fast      | 176.6 Mpx/s    | 128.1 Mpx/s    | 0.725                   |

Script: ad-hoc, not committed (reused the benchmark's own ffmpeg arguments at a
second `-vf scale=`/`-s` size; available on request if this needs re-running).

## Reading

The assumption does not hold. Cost per pixel RISES with frame size on this
host — by 2.25× for `ultrafast`, 1.38× for `fast`, at 4× the pixel count — and
the effect is preset-dependent, not a single constant. A quality ladder priced
from the 640×360 figure alone over-states what this host can sustain at 1080p,
worse for the faster presets that the ladder falls back to under load.

## Why this does not become a code change yet

One host, one clip, two sizes. [[feedback_pool_diversity]] — a correction fitted
to this desktop and applied to every proxy in the pool would be exactly the
mistake that memory exists to prevent: the pool spans ARM boards (HA Yellow /
CM4) with different cache sizes and memory bandwidth, where a size penalty of
this shape could be smaller, larger, or absent. [[feedback_no_fudged_numbers]] —
publishing 0.445/0.725 as universal constants is fabricating a number for hosts
that were never measured.

The benchmark already measures per-host (item 4(f), 4(h)); a size-scaling
correction belongs there too — the benchmark itself gains a second, cheap
measurement point (one preset, one second size) and derives its own exponent
from that host's two readings, the same way `fitDecodeCost` derives its terms
from clips rather than from a stated formula. That is the remaining work under
item 4(e); this note is the measurement that justifies doing it, not the fix
itself.

## What is verified

The measurement method matches the shipped benchmark exactly (real footage,
raw frames decoded once, slope between two progress reports) — the only
variable changed was the target size, so this is not comparing two different
methodologies.
