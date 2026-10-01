# Audio calibration samples

These files contain deterministic synthetic pink noise, encoded at build time
by `scripts/build-audio-samples.mjs`. They contain no recorded third-party audio.
The manifest records the actual duration, channels, sample rate and byte count
reported by ffprobe. They are distributed under the package's GPL-3.0-or-later
license.

Startup reads each packaged sample once for packet copying and once for AAC
processing. It neither generates input files nor loops them. The operation
timeout is the existing encoder benchmark timeout; it is not an ETA coefficient.

Process startup is measured separately from FFmpeg's reported processing time;
its printed clock precision bounds runtime uncertainty. Input reading is
included in processing. For encoding, the
reference work scales by input audio samples (channels multiplied by sample
rate); for copying, a declared source bitrate scales encoded-byte work. These
are approximate initial rates, replaced by actual per-output progress. Unknown
dimensions retain the measured reference rather than fabricated metadata.
