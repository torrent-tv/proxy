import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { ffprobeRecord } from "./container/ffprobe-record.js";

const require = createRequire(import.meta.url);
function bundledProbe() {
  try { return require("@ffprobe-installer/ffprobe").path; }
  catch { return "ffprobe"; }
}

/** Read only the strict available-byte endpoint; missing reads abort through ProbeRequests. */
export function probePackets({ url, statement, signal, onRecord = () => {}, ffprobeBin = bundledProbe(), spawnProcess = spawn }) {
  if (!["streams", "packets"].includes(statement)) throw new TypeError("Unknown ffprobe statement.");
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Probe cancelled."));
  onRecord({ kind: "scan-start" });
  const entries = statement === "streams"
    ? "stream=index,codec_type,codec_name,width,height,sample_rate,channels,bits_per_sample,bits_per_raw_sample,r_frame_rate,has_b_frames,start_time,duration,extradata,extradata_size:stream_tags=language,title:stream_disposition=default,forced:stream_side_data=:format=format_name,start_time,duration"
    : "packet=stream_index,pts_time,dts_time,duration_time,pos,size,flags,data_hash:packet_side_data=";
  const args = ["-v", "error", ...(statement === "streams" ? ["-show_streams", "-show_format", "-show_data"] : ["-show_packets", "-show_data_hash", "sha256"]),
    "-show_entries", entries, "-of", "compact=p=1:nk=0:escape=c", "-i", url];
  return new Promise((resolve, reject) => {
    const records = [];
    let remainder = "", diagnostics = "", failure = null;
    const child = spawnProcess(ffprobeBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const aborted = () => { failure = signal.reason ?? new Error("Probe cancelled."); child.kill(); };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const accept = line => {
      if (!line || failure) return;
      const record = ffprobeRecord(line);
      onRecord(record);
      if (statement === "streams") records.push(record);
    };
    child.stdout.on("data", chunk => {
      if (failure) return;
      remainder += chunk;
      try {
        let newline;
        while ((newline = remainder.indexOf("\n")) >= 0) {
          accept(remainder.slice(0, newline));
          remainder = remainder.slice(newline + 1);
        }
      } catch (error) { failure = error; child.kill(); }
    });
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      signal?.removeEventListener("abort", aborted);
      try {
        if (!failure && remainder) accept(remainder);
        if (!failure && code === 0 && !diagnostics.trim()) onRecord({ kind: "scan-end" });
      }
      catch (error) { failure = error; }
      if (failure) reject(failure);
      else if (code !== 0 || diagnostics.trim()) reject(new Error(`ffprobe refused the input (${code}): ${diagnostics.trim()}`));
      else resolve(records);
    });
  });
}
