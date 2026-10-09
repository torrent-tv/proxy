/**
 * How far into a file FFmpeg reads, at open, to learn its streams
 * (`avformat_find_stream_info`): until a stream has given it this much media
 * time (`-analyzeduration`), unless every stream is known sooner.
 *
 * A container that names the bytes of an original-source run names this
 * stretch from the first media too, and the run gives FFmpeg the same figure,
 * so the read and the bytes held agree whatever FFmpeg's own default is. A
 * read past the bytes held is refused, and from 7.1 on FFmpeg does not recover
 * from that refusal: the run ends with nothing made (torrent-tv/meta#165).
 *
 * Five seconds is FFmpeg's own default for these containers
 * (`5*AV_TIME_BASE` in avformat_find_stream_info), stated rather than chosen.
 */
export const FFMPEG_STREAM_SEARCH_SECONDS = 5;
