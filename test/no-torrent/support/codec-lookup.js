// The encode layer is handed the Matroska id lookup (torrent-tv/meta#284); it
// has no default. Tests hand it the real table through this one file.
export { matroskaIdOf } from "../../../services/media/tracks/codec-names.js";
