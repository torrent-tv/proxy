# Calibration clips — attribution

The clips in this folder are excerpts from **"Meridian"**, part of
[Netflix Open Content](https://opencontent.netflix.com/), licensed under the
**Creative Commons Attribution 4.0 International (CC BY 4.0)** licence:
<https://creativecommons.org/licenses/by/4.0/>.

They were cut from `Meridian/Meridian_UHD4k5994_HDR_P3PQ.mp4` and re-encoded to
H.264 High, 24 fps, 2 s each, no audio:

| file | resolution | bitrate |
|---|---|---|
| `cal-h264-1080-hi.mp4` | 1920×1080 | 9.36 Mbit/s |
| `cal-h264-1080-lo.mp4` | 1920×1080 | 1.00 Mbit/s |
| `cal-h264-720-hi.mp4` | 1280×720 | 9.95 Mbit/s |
| `cal-h264-720-lo.mp4` | 1280×720 | 1.04 Mbit/s |
| `cal-h264-480-hi.mp4` | 854×480 | 9.48 Mbit/s |
| `cal-h264-480-lo.mp4` | 854×480 | 1.25 Mbit/s |

## Why six, and why this grid

`services/hwaccel.js` decodes them at startup and fits the host's decode cost,
`a × Mpixel/s + b × Mbit/s + c`, from the measurements
(`services/decode-cost-fit.js`).

The set before this one was three clips for three unknowns — an EXACT system,
with two of the clips sharing a pixel count. Such a system cannot fail visibly:
it returns whatever satisfies its three equations, and on 2026-08-17 it returned
`0.007542 × Mpx/s + 0.000000 × Mbit/s + 0.0000 s/s` — the bitrate term and the
constant exactly zero, so a film's own bitrate never entered its price, and the
prediction built on it was 1.8-2.2x optimistic against the same file measured
while playing.

Six clips are three sizes × two bitrates, with the two axes varied
**independently**. That gives three spare measurements, so the fit has a
residual — something to notice a degeneracy WITH — and lets a term be refused
when the data does not determine it, instead of being published as a zero that
looks measured.

A 480p clip at 9.5 Mbit/s is not content anyone ships; that is the point. The
bitrate has to vary at every size, or it cannot be told apart from the size.

## Why real footage

Grainy live action rather than a generated pattern: measured 2026-08-14 on the
addon host, this material decodes 11 % away from the film being served, where a
generated `testsrc2` clip is 158 % away. It also matches most of what the
product actually plays — a survey of 133 releases (2026-07-10) found ~67 %
H.264 live action, the rest HEVC, XviD and animation.

## Replacing or extending the set

Allowed: the benchmark reads each clip's dimensions, frame rate and bitrate from
ffmpeg's own output rather than from this table. Two rules hold, though:

- **more measurements than terms**, or there is no residual and no way to see a
  degenerate fit;
- **the axes stay independent** — every size at both bitrates. Dropping one cell
  reintroduces the collinearity that produced the zeros above.

## One set per codec family

A video that has to be RE-ENCODED is by definition one the browser could not
play, which is to say HEVC, 10-bit or AV1 — so the model was fitted on the one
codec it is least often asked about. There is now a set per family, and the
source's own codec chooses the constants.

| file | codec | resolution | bitrate |
|---|---|---|---|
| `cal-hevc-1080-hi.mp4` | HEVC Main, 8-bit | 1920×1080 | 5.78 Mbit/s |
| `cal-hevc-1080-lo.mp4` | HEVC Main, 8-bit | 1920×1080 | 0.52 Mbit/s |
| `cal-hevc-480-hi.mp4` | HEVC Main, 8-bit | 854×480 | 7.76 Mbit/s |
| `cal-hevc-480-lo.mp4` | HEVC Main, 8-bit | 854×480 | 0.74 Mbit/s |
| `cal-hevc10-1080-hi.mp4` | HEVC Main 10 | 1920×1080 | 5.82 Mbit/s |
| `cal-hevc10-1080-lo.mp4` | HEVC Main 10 | 1920×1080 | 0.52 Mbit/s |
| `cal-hevc10-480-hi.mp4` | HEVC Main 10 | 854×480 | 6.95 Mbit/s |
| `cal-hevc10-480-lo.mp4` | HEVC Main 10 | 854×480 | 0.68 Mbit/s |

Four per family, not six: two sizes at two bitrates is the smallest grid that
keeps the axes independent and still leaves one spare measurement, and every
clip costs the startup about two seconds. They are one second long rather than
two — the benchmark loops the clip and measures a slope over about a second of
decoding, so length beyond that buys nothing and only makes the package larger.

They were cut from `cal-h264-1080-hi.mp4` rather than from the 4K master, which
is not in this repository. Re-encoding an already-compressed picture softens its
grain slightly; what is being measured is the cost of decoding the new
bitstream, and the grain that survives is the same material in every set, which
is what makes the families comparable to each other.

10-bit is its own family rather than a multiplier on the 8-bit one. Wider
samples mean wider arithmetic, and how much that costs is a property of the
machine — which is the thing being measured. Measured on a desktop 2026-08-20,
1080p at ~5.8 Mbit/s: 7.7x as 8-bit HEVC and 6.3x as 10-bit, so it is a real
difference and not a rounding.

AV1 has no set yet. The release survey of 2026-07-10 found it rare where HEVC
was 18 %, so it is priced as H.264 until it is worth the startup seconds — and
the log says which families were measured and which are falling back, rather
than leaving it to be inferred.
