# Tasks: loopback-forward (#281)

design.md is normative.

## 1. Test plan

Written by the test writer before any test (meta AGENTS.md, "Writing tests").

## 2. Tests (test writer, separate commit)

- [ ] 2.1 Failing tests for AC-1..AC-3 under `test/no-torrent/`, committed
      alone as `test(proxy): …`.

## 3. Implementation (implementer, from the test commit)

- [ ] 3.1 `services/transport/loopback-forward.js` (design §1).
- [ ] 3.2 `data-channel-handler.js` uses it (design §2).
- [ ] 3.3 Delete the tunnel relay in `tunnel-client.js` (design §3).
- [ ] 3.4 Changeset (design §5). `npm test` exits 0.
- [ ] 3.5 Server: delete `relay()` and its dead state (design §4), changelog
      entry; `npm test` exits 0 in server.

## 4. Release and field check

- [ ] 4.1 Proxy released and installed in the add-on, then server released.
- [ ] 4.2 AC-4 on the Home Assistant host.
