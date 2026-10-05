/** HTTP validation without torrent startup or media parsing. */
export class ChapterController {
  constructor({ sourceRegistry, chapters }) { this.sourceRegistry = sourceRegistry; this.chapters = chapters; }
  get({ sourceKey, fileIndex }) {
    if (!this.sourceRegistry.get(sourceKey)) return { status: 404, body: { error: "Source key was not found." } };
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return { status: 400, body: { error: "fileIndex must be a non-negative integer." } };
    return { status: 200, body: this.chapters.get(sourceKey, fileIndex) };
  }
}
