# Calibration clips — attribution

The three clips in this folder are excerpts from **"Meridian"**, part of
[Netflix Open Content](https://opencontent.netflix.com/), licensed under the
**Creative Commons Attribution 4.0 International (CC BY 4.0)** licence:
<https://creativecommons.org/licenses/by/4.0/>.

They were cut from `Meridian/Meridian_UHD4k5994_HDR_P3PQ.mp4` and re-encoded to
H.264 High, 24 fps, 5.04 s (121 frames), no audio:

| file | resolution | bitrate |
|---|---|---|
| `cal-1080-hi.mp4` | 1920×1080 | 11.38 Mbit/s |
| `cal-1080-lo.mp4` | 1920×1080 | 0.97 Mbit/s |
| `cal-720.mp4` | 1280×720 | 2.25 Mbit/s |

## Why these three, and why real footage

`services/hwaccel.js` decodes them at startup and solves the host's decode cost,
`a × Mpixel/s + b × Mbit/s + c`, from the three measurements. The first two
clips share a pixel count and differ 11.7× in bitrate; the third changes the
pixel count. Three points, three unknowns.

Real, grainy live action rather than a generated pattern: measured 2026-08-14 on
the addon host, this material decodes 11 % away from the film being served,
where a generated `testsrc2` clip is 158 % away.

Replacing a clip is allowed — the benchmark reads each clip's dimensions, frame
rate and bitrate from ffmpeg's own output rather than from this table — but the
three must keep spanning the two axes, or the fit has nothing to separate.
