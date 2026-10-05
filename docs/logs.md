# Logs — where to look

No browser console copy-paste is needed: the page forwards its own log. But it
lands in TWO places depending on the phase of the session — the registry server
and the proxy — see "Browser logs are in TWO places" below before concluding
anything from a half-session.

## Where the proxy writes its log, by how it is started

The proxy is deployment-agnostic: the Home Assistant addon is one way to run it,
npm and Docker on Linux, macOS or Windows are others. Where its log goes is
decided by one start parameter, `--log-file <path>`, and nothing else:

- **With `--log-file`**: every line goes to the console AND to that file
  (appended, rotated to `<path>.1` past 1 GiB), and the browser's lines go to
  one file per viewing session in the same directory (see "The files on the
  proxy" below). The directory of the file must exist.
- **Without it**: everything goes to the console only, the browser's lines
  included, each prefixed `client <sessionId:8>`. Before torrent-tv/meta#96 the
  browser's lines were dropped in this case. The console is kept by whatever
  started the process, and only as long as that keeps it.

| How it is started | Log | Browser lines | Survives |
|---|---|---|---|
| Home Assistant addon | `/data/proxy.log` (`run.sh` passes `--log-file /data/proxy.log`) | `/data/client-*.log` | restarts and addon updates |
| npm / `npx`, any OS, no `--log-file` | the terminal | the terminal | nothing |
| npm under systemd, no `--log-file` | the unit's journal: `journalctl -u <unit>` | the same journal | restarts, within journald's limits |
| npm with `--log-file`, e.g. `/var/log/torrent-tv-proxy/proxy.log`, `~/Library/Logs/torrent-tv/proxy.log`, `%LOCALAPPDATA%\torrent-tv\proxy.log` | that file | `client-*.log` beside it | restarts and updates |
| Docker, no `--log-file` | `docker logs <container>` | the same | only the container's life: recreating it deletes the log |
| Docker with a volume and `--log-file`, e.g. `-v ttv-proxy-logs:/logs … --log-file /logs/proxy.log` | the file in the volume | `client-*.log` in the volume | recreating the container |

So on any host where the log matters, pass `--log-file` and point it at a
directory that outlives the process — which is what the addon does.

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

- Server is `infra-server-1` (`ghcr.io/torrent-tv/server`) on `do` (`206.189.97.152`).
- Every container there logs to the host journal, and rsyslog writes one file per
  source to `/var/log/torrent-tv/`; the files and the journal survive the
  deployments that recreate the containers (`infra` README, "Logs";
  torrent-tv/meta#96):
  - `server.log` — the server's own lines;
  - `client.log` — browser lines the server received, prefixed
    `[client <tag> <id> sig=<webrtcSessionId>]`
    (`server/routes/api/client-logs/post.js`);
  - `nginx.log`, `doco-cd.log`.
- Frontend logs reach the droplet only in the phases the proxy cannot be reached
  in — see "Browser logs are in TWO places" below.
- Reading:
  ```bash
  ssh do "tail -n 300 /var/log/torrent-tv/client.log"
  # filter a single viewing:
  ssh do "grep 003ed2fd /var/log/torrent-tv/client.log /var/log/torrent-tv/server.log"
  ssh do "journalctl -t torrent-tv-server --since '-1h' -o short-iso-precise"
  ```
- `docker logs infra-server-1` shows only the CURRENT container's lines — a
  deployment gives it a new container. Use the files or `journalctl -t`.
- No need to open eruda or copy the browser console on a phone — it is forwarded.

## Browser logs are in TWO places, split by phase — read both

Until 2026-09-13 the page's whole log went to the droplet's standard output,
which every release of the server destroys. A viewer reported a desync and a
frozen picture that day and the analysis ran on half the evidence, so the log
moved to the proxy — beside the proxy's own, on the same durable directory.

The split is by PHASE, and neither half is the whole session:

1. **Before a transport exists** — the page opening, the proxy being chosen, a
   connection failing — there is nowhere else to send it, so it goes to the
   SERVER (`/var/log/torrent-tv/client.log` on the droplet);
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

When the proxy was started with `--log-file`: one file per viewing session, in
the proxy log's own directory (`/data` on the addon host), named so the two
halves join without guessing. Without `--log-file` the same lines are in the
proxy's console, prefixed `client <sessionId:8>`.

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

- Rewind/seek bug (hold 0ms → 500): HA `hold ... failed after 0ms → 500` + `encode-run` lines for the same `<sessionId>`, and DO `client.log` `[client ...] fragLoadError / levelLoadError 500` for same `sn`.
- Cushion / link budget: HA `memory: rss=... anon=...` and `cushion` lines; DO `[eta]` / `[cushion]` from client.
- Update check: `ssh ha "sudo docker exec hassio_cli ha apps info b34a1737_torrent_tv_proxy | grep version"` and `ssh ha "sudo docker ps --filter name=app_b34a1737_torrent_tv_proxy"`.

## Related

- `ha-addon/CLAUDE.md` — addon build/update detour via `hassio_cli`, cache-bust via `config.yaml` version.
- `docs/container-architecture.md` — what container/track classes log and where.
- `routes/api/client-logs/post.js` and `server/routes/api/client-logs/post.js` — the two receivers; both sanitize the same way (control chars → space, `MAX_LINES`, `MAX_MSG_LEN`).
