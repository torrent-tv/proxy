/** Build-time only. No sample generation runs when the proxy starts. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../assets/calibration/audio/", import.meta.url));
const formats = [
  ["aac", "aac", "m4a"], ["ac3", "ac3", "ac3"], ["eac3", "eac3", "eac3"],
  ["dts", "dca", "dts"], ["flac", "flac", "flac"], ["opus", "libopus", "opus"],
  ["vorbis", "libvorbis", "ogg"], ["truehd", "truehd", "thd"], ["mp3", "libmp3lame", "mp3"],
  ["mp2", "mp2", "mp2"], ["alac", "alac", "m4a"], ["pcm", "pcm_s16le", "wav"]
];
mkdirSync(directory, { recursive: true });
const manifest = [];
for (const [codec, encoder, extension] of formats) {
  const file = `${codec}.${extension}`;
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=1:sample_rate=48000",
    "-t", "4", "-ac", "2", "-strict", "-2", "-c:a", encoder, path.join(directory, file)],
  { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${codec}: ${result.stderr}`);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json",
    path.join(directory, file)], { encoding: "utf8", windowsHide: true });
  if (probe.status !== 0) throw new Error(`${codec}: ${probe.stderr}`);
  const { streams, format } = JSON.parse(probe.stdout);
  const stream = streams.find(({ codec_type }) => codec_type === "audio");
  manifest.push({ codec, file, durationSeconds: Number(format.duration), channels: stream.channels,
    samplingFrequency: Number(stream.sample_rate), bytes: Number(format.size) });
}
writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
