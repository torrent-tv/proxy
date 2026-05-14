import crypto from "node:crypto";
import chalk from "chalk";
import WebTorrent from "webtorrent";

function decodeTorrentSource(sourceType, source) {
  if (sourceType === "magnet") {
    return source;
  }
  if (sourceType === "torrent") {
    return Buffer.from(source, "base64");
  }
  throw new Error("Unsupported sourceType. Expected magnet or torrent.");
}

export class TorrentPool {
  constructor() {
    this.client = new WebTorrent();
    this.torrents = new Map();
    this.fileUsageByTorrent = new WeakMap();

    this.client.on("error", (error) => {
      console.error(chalk.red(`[proxy-client] WebTorrent client error: ${error.message}`));
    });
  }

  async getTorrent(sourceType, source) {
    const key = `${sourceType}:${crypto.createHash("sha1").update(source).digest("hex")}`;
    const existing = this.torrents.get(key);
    if (existing) {
      return existing;
    }

    const torrentId = decodeTorrentSource(sourceType, source);
    const torrent = await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.client.off("error", onError);
        reject(error);
      };
      this.client.once("error", onError);
      this.client.add(torrentId, (readyTorrent) => {
        this.client.off("error", onError);
        resolve(readyTorrent);
      });
    });

    this.torrents.set(key, torrent);
    return torrent;
  }

  setActiveFile(torrent, fileIndex) {
    if (!torrent || !Array.isArray(torrent.files)) {
      return;
    }
    for (let index = 0; index < torrent.files.length; index += 1) {
      const file = torrent.files[index];
      if (!file) {
        continue;
      }
      if (index === fileIndex) {
        if (typeof file.select === "function") {
          file.select();
        }
        continue;
      }
      if (typeof file.deselect === "function") {
        file.deselect();
      }
    }
  }

  acquireFile(torrent, fileIndex) {
    if (!torrent || !Array.isArray(torrent.files) || !Number.isInteger(fileIndex) || fileIndex < 0) {
      return () => undefined;
    }
    let usage = this.fileUsageByTorrent.get(torrent);
    if (!usage) {
      usage = new Map();
      this.fileUsageByTorrent.set(torrent, usage);
    }
    usage.set(fileIndex, (usage.get(fileIndex) ?? 0) + 1);
    this.#syncSelections(torrent, usage);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const nextCount = (usage.get(fileIndex) ?? 0) - 1;
      if (nextCount > 0) {
        usage.set(fileIndex, nextCount);
      } else {
        usage.delete(fileIndex);
      }
      if (usage.size === 0) {
        this.fileUsageByTorrent.delete(torrent);
      }
      this.#syncSelections(torrent, usage);
    };
  }

  #syncSelections(torrent, usage) {
    if (!torrent || !Array.isArray(torrent.files)) {
      return;
    }
    for (let index = 0; index < torrent.files.length; index += 1) {
      const file = torrent.files[index];
      if (!file) {
        continue;
      }
      const shouldSelect = (usage.get(index) ?? 0) > 0;
      if (shouldSelect) {
        if (typeof file.select === "function") {
          file.select();
        }
        continue;
      }
      if (typeof file.deselect === "function") {
        file.deselect();
      }
    }
  }
}
