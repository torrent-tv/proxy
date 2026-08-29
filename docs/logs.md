# Logs — where to look

All logs are visible via container `docker logs`, no browser console copy-paste needed.

## HA proxy (aarch64, addon `b34a1737_torrent_tv_proxy`)

Image `b34a1737/aarch64-addon-torrent_tv_proxy:<version>` = `@torrent-tv/proxy` `<version>` (see `ha-addon/torrent_tv_proxy/config.yaml`).

- Console + file are the same: the proxy logs to both `stdout` and `/data/proxy.log` on start (`logging to /data/proxy.log as well as the console`).
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
- Frontend logs are forwarded: browser batches `{sessionId, tag, signalSessionId, lines: [{level,ts,msg}]}` and `POST`s to `https://webauth.courses/api/client-logs` (`server/routes/api/client-logs/post.js:56`), server does `console.log` with prefix `[client <tag> <id> sig=<webrtcSessionId>]`. They appear together with backend logs in the same container.
- Via container:
  ```bash
  ssh do "docker logs infra-server-1 --tail 200 | cat"
  # filter a single viewing:
  ssh do "docker logs infra-server-1 --tail 500 | grep 003ed2fd"
  ssh do "docker logs infra-server-1 --tail 500 | grep '\[client'"
  ```
- No need to open eruda or copy browser console on phone — it is already in `infra-server-1` logs.

## Quick triage

- Rewind/seek bug (hold 0ms → 500): HA `hold ... failed after 0ms → 500` + `encode-run` lines for the same `<sessionId>`, and DO `[client ...] fragLoadError / levelLoadError 500` for same `sn`.
- Cushion / link budget: HA `memory: rss=... anon=...` and `cushion` lines; DO `[eta]` / `[cushion]` from client.
- Update check: `ssh ha "sudo docker exec hassio_cli ha apps info b34a1737_torrent_tv_proxy | grep version"` and `ssh ha "sudo docker ps --filter name=app_b34a1737_torrent_tv_proxy"`.

## Related

- `ha-addon/CLAUDE.md` — addon build/update detour via `hassio_cli`, cache-bust via `config.yaml` version.
- `docs/container-architecture.md` — what container/track classes log and where.
- `server/routes/api/client-logs/post.js:1` — sanitization (control chars → space, `MAX_LINES 50`, `MAX_MSG_LEN 2000`).
