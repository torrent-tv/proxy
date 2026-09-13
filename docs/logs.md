# Logs — where to look

No browser console copy-paste is needed: the page forwards its own log. But it
lands in TWO places depending on the phase of the session, and `docker logs` is
only one of them — see "Browser logs are in TWO places" below before concluding
anything from a half-session.

## HA proxy (aarch64, addon `b34a1737_torrent_tv_proxy`)

Image `b34a1737/aarch64-addon-torrent_tv_proxy:<version>` = `@torrent-tv/proxy` `<version>` (see `ha-addon/torrent_tv_proxy/config.yaml`).

- Console + file are the same: the proxy logs to both `stdout` and `/data/proxy.log` on start (`logging to /data/proxy.log as well as the console`).
- **Since 2.71.0 that is true of the torrent thread too, and it was not before.**
  A worker thread loads its own instance of every module, so the logger's file
  handle — set once, on the main thread — was null in the worker for the life of
  the process. Measured over a whole 49 938-line file: zero lines from the piece
  reader (`read "…"`, `supply "…"`, every wait and its cause) and zero from the
  torrent pool, against 52 and 36 of them in `docker logs`, which every release
  destroys. The worker now sends its lines to the main thread, which is the only
  writer; a line from there reads `torrent-worker: …`.
- Via container:
  ```bash
  ssh ha "sudo docker logs app_b34a1737_torrent_tv_proxy --tail 200"
  ssh ha "sudo docker exec app_b34a1737_torrent_tv_proxy cat /data/proxy.log | tail -n 300"
  ```
- Filter by session: every transcode session logs its id, e.g. `003ed2fd-7c9b-4cd5-9d05-ff875ff2be23`, `hold segment-00068.mp4 failed`, `encode-run failed`, `EXITED_*`.
- Host file `/data/proxy.log` survives `docker logs` rotation; `core dumps: 1 present` line shows kept dump under `/data`.

SSH to HA requires `MACs hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com,umac-128-etm@openssh.com` — server `OpenSSH_10.3` on `homeassistant.local` offers only `*-etm` (`Unable to negotiate` / `Corrupted MAC` otherwise). Already in `~/.ssh/config` `Host ha`.

## DO server (webauth.courses, `infra-server-1`)

- Server is `infra-server-1` (`ghcr.io/torrent-tv/server:latest`) on `do` (`206.189.97.152`).
- Frontend logs reach here only in the phases the proxy cannot be reached in — see "Browser logs are in TWO places" below. When they do, the server `console.log`s them with the prefix `[client <tag> <id> sig=<webrtcSessionId>]` (`server/routes/api/client-logs/post.js`), in the same container as its own lines.
- Via container:
  ```bash
  ssh do "docker logs infra-server-1 --tail 200 | cat"
  # filter a single viewing:
  ssh do "docker logs infra-server-1 --tail 500 | grep 003ed2fd"
  ssh do "docker logs infra-server-1 --tail 500 | grep '\[client'"
  ```
- No need to open eruda or copy the browser console on a phone — it is forwarded.

## Browser logs are in TWO places, split by phase — read both

Until 2026-09-13 the page's whole log went to the droplet's standard output,
which every release of the server destroys. A viewer reported a desync and a
frozen picture that day and the analysis ran on half the evidence, so the log
moved to the proxy — beside the proxy's own, on the same durable directory.

The split is by PHASE, and neither half is the whole session:

1. **Before a transport exists** — the page opening, the proxy being chosen, a
   connection failing — there is nowhere else to send it, so it goes to the
   SERVER (`infra-server-1`);
2. **From the moment the data channel is up**, the page's logger is given a
   proxy sink (`loading.js`, `setProxySink`) and every batch goes to the PROXY
   over that channel. This is the bulk of a viewing;
3. **At unload** it goes to the server again: `navigator.sendBeacon` is the only
   thing a page that is going away can use, and a data channel is not;
4. **A batch that cannot reach the proxy** falls back to the server.

So a session that failed while connecting is on the droplet, a session that
failed while playing is on the addon host, and a complete reading of a long
failure needs both.

### The files on the proxy

One file per viewing session, in the proxy log's own directory (`/data` on the
addon host), named so the two halves join without guessing:

```
client-<YYYYMMDD-HHMMSS UTC of the session start>-<sessionId:8>-<torrent name:60>-<infoHash:8>.log
```

A session that has not chosen a torrent yet writes `no-torrent-yet` in that
last part — the file is keyed by the session id, not by the name, so choosing a
torrent later does NOT start a second file. Rotated at 16 MB to `<name>.log.1`.

```bash
ssh ha "sudo docker exec app_b34a1737_torrent_tv_proxy sh -c 'ls -la /data/client-*.log'"
ssh ha "sudo docker exec app_b34a1737_torrent_tv_proxy sh -c 'cat /data/client-20260913-*.log'"
```

Implementation: `utils/client-log-file.js`, route `routes/api/client-logs/post.js`.

## Quick triage

- Rewind/seek bug (hold 0ms → 500): HA `hold ... failed after 0ms → 500` + `encode-run` lines for the same `<sessionId>`, and DO `[client ...] fragLoadError / levelLoadError 500` for same `sn`.
- Cushion / link budget: HA `memory: rss=... anon=...` and `cushion` lines; DO `[eta]` / `[cushion]` from client.
- Update check: `ssh ha "sudo docker exec hassio_cli ha apps info b34a1737_torrent_tv_proxy | grep version"` and `ssh ha "sudo docker ps --filter name=app_b34a1737_torrent_tv_proxy"`.

## Related

- `ha-addon/CLAUDE.md` — addon build/update detour via `hassio_cli`, cache-bust via `config.yaml` version.
- `docs/container-architecture.md` — what container/track classes log and where.
- `routes/api/client-logs/post.js` and `server/routes/api/client-logs/post.js` — the two receivers; both sanitize the same way (control chars → space, `MAX_LINES`, `MAX_MSG_LEN`).
