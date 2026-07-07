# Proposal: Transcode quality — source fps, realtime budget, HDR, manual quality

## Why

The transcode pipeline was tuned for "make it play at all" and left several
quality/robustness gaps flagged in the project analysis: output was hard-
locked to 24 fps (25/30 fps content played with resampling judder); the
encoder profile could be slower than realtime on weak hosts (stalls instead
of graceful degradation); 10-bit/HDR sources transcoded to 8-bit H.264
without tone mapping (washed-out colours); and the viewer had no way to force
a resolution. This change is the transcode-stage batch (proxy side; the
manual-quality menu also needs the server UI).

## What Changes

- **Source fps** (DONE): the output frame rate is inherited from the source
  (rounded to an integer, capped at 30), replacing the fixed 24. The
  fixed-GOP encoders keep the fps↔GOP relationship exact so keyframes stay on
  the segment grid; time-based-keyframe encoders (nvenc) just use it as the
  rate; VAAPI/QSV already inherited.
- **Realtime budget** (planned): the startup benchmark picks the
  encoder/preset/resolution/fps combination whose predicted throughput stays
  above realtime; a source that would not encode in time is downscaled
  (720/540p) rather than refused, and a sustained runtime `speed<1` triggers
  a restart with a lighter profile. `-maxrate`/`-bufsize` cap bitrate spikes.
- **HDR tone mapping** (planned): detect 10-bit/HDR (pix_fmt,
  color_transfer smpte2084/HLG) and insert a tone-map chain when re-encoding
  to 8-bit H.264, so colours are not washed out. Depends on the ffmpeg build
  having the tonemap filters.
- **Manual quality** (planned): a player Quality menu — Auto (current
  viewport/DPR behaviour) plus forced resolutions — the proxy already
  honours a requested target height.

## Capabilities

### New Capabilities

- `transcode-quality`: output frame rate, realtime encode budget, HDR tone
  mapping, and explicit quality selection.

### Modified Capabilities

<!-- none -->

## Impact

- `services/hwaccel.js` (fps, benchmark, tonemap args),
  `services/hls-session-manager.js` (fps probe, runtime speed watch),
  `services/playback-planner.js` (HDR/fps in the plan);
  server player UI for the Quality menu; ha-addon bump.
- Released as a batch (proxy 2.9.29 + addon) after the pieces land.
