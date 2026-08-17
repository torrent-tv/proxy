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

Codecs other than H.264 (HEVC, AV1, 10-bit) decode dearer per pixel, and the
model fitted here does not describe them. Covering them means a set per codec
family and constants chosen by the source's own codec — roadmap item 3(b).
