import { AudioTrack } from "./tracks/AudioTrack.js";
import { TextSubtitleTrack } from "./tracks/TextSubtitleTrack.js";
import { ContainerTrack } from "./tracks/ContainerTrack.js";

const VIDEO_CODECS = new Map([
  ["V_MPEG4/ISO/AVC", "h264"], ["avc1", "h264"], ["avc3", "h264"],
  ["V_MPEGH/ISO/HEVC", "hevc"], ["hvc1", "hevc"], ["hev1", "hevc"],
  ["V_MPEG1", "mpeg1video"], ["V_MPEG2", "mpeg2video"],
  ["V_MPEG4/ISO/ASP", "mpeg4"], ["V_MPEG4/ISO/SP", "mpeg4"], ["mp4v", "mpeg4"],
  ["V_VP8", "vp8"], ["V_VP9", "vp9"], ["vp09", "vp9"],
  ["V_AV1", "av1"], ["av01", "av1"], ["V_MJPEG", "mjpeg"],
  ["V_FFV1", "ffv1"], ["V_THEORA", "theora"]
]);
const SUBTITLE_CODECS = new Map([
  ["S_TEXT/UTF8", "subrip"], ["S_TEXT/ASS", "ass"], ["S_TEXT/SSA", "ssa"],
  ["S_TEXT/WEBVTT", "webvtt"], ["wvtt", "webvtt"], ["tx3g", "mov_text"],
  ["S_HDMV/PGS", "hdmv_pgs_subtitle"], ["S_VOBSUB", "dvd_subtitle"]
]);
const FOURCC_CODECS = new Map([
  ["mjpg", "mjpeg"], ["jpeg", "mjpeg"], ["xvid", "mpeg4"],
  ["divx", "mpeg4"], ["dx50", "mpeg4"], ["mpg2", "mpeg2video"]
]);

function videoCodecOf(track) {
  let id = track.codecId;
  if (id === "V_MS/VFW/FOURCC" && track.codecPrivateB64) {
    const header = Buffer.from(track.codecPrivateB64, "base64");
    if (header.length >= 20) id = header.toString("ascii", 16, 20);
  }
  return VIDEO_CODECS.get(id) ?? FOURCC_CODECS.get(id.toLowerCase()) ?? id.toLowerCase();
}

/** One playback inventory, taken from the same declarations used for input. */
export function playbackDeclarations({ tracks, media, fileBytes = null }) {
  const ordered = type => tracks.filter(track => track.type === type)
    .sort((a, b) => a.declaredIndex - b.declaredIndex);
  // The picture is the first video track the container marks usable; a
  // disabled one is not played (torrent-tv/meta#49).
  const video = ContainerTrack.firstUsable(tracks, "video") ?? undefined;
  const inventory = type => ordered(type).map((track, index) => ({
    ...track, index, streamIndex: track.declaredIndex,
    codec: type === "audio" ? AudioTrack.codecNameOf(track)
      : SUBTITLE_CODECS.get(track.codecId) ?? track.codecId.toLowerCase(),
    title: track.name ?? "",
    // The browser offers only tracks marked text-based: a picture subtitle
    // cannot become WebVTT. Dropped when the plan moved to these declarations
    // (torrent-tv/meta#95), which emptied every subtitle menu (#8).
    ...(type === "subtitle" ? { textBased: TextSubtitleTrack.isTextCodec(track.codecId) } : {})
  }));
  const audioTracks = inventory("audio"), subtitleTracks = inventory("subtitle");
  return { tracks, video, audioTracks, subtitleTracks,
    // The soundtrack a file opens with is its first usable one.
    audioCodec: ContainerTrack.firstUsable(audioTracks, "audio")?.codec ?? "",
    videoCodec: video ? videoCodecOf(video) : "",
    container: media.format,
    durationSeconds: media.durationSeconds,
    startTimeSeconds: media.startTimeSeconds,
    videoWidth: video?.width ?? 0, videoHeight: video?.height ?? 0,
    fps: video?.fps ?? null, isHdr: video?.isHdr ?? false, bitDepth: video?.bitDepth ?? null,
    // The measured whole-file average prices decoding; it never addresses packets.
    bitrateKbps: Number.isFinite(media.bitrateKbps) ? media.bitrateKbps
      : Number.isSafeInteger(fileBytes) && fileBytes > 0 && media.durationSeconds > 0
        ? fileBytes * 8 / media.durationSeconds / 1000 : null,
    streamCounts: { video: ordered("video").length, audio: audioTracks.length, subtitle: subtitleTracks.length }
  };
}
