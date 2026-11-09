## 1. Test plan

Written by the test writer before any test (meta AGENTS.md, "Writing tests:
the test plan comes first"). Covers AC-1 to AC-4 of `design.md`.

## 2. Tests (failing, one commit)

- [ ] 2.1 Tests from the plan, committed failing: `test(proxy): …`

## 3. Implementation (one or more commits, tests untouched)

- [ ] 3.1 `scripts/install-native.sh` as in design Decision 1
- [ ] 3.2 `package.json` `files` gains `scripts/install-native.sh`
- [ ] 3.3 `Dockerfile` runs the script after `npm ci`, `--help` in the final stage
- [ ] 3.4 CI `build` job builds only; release keeps needing it
- [ ] 3.5 `.changeset/build-ttv-302-native-build-script.md`
- [ ] 3.6 `npm test` exits 0

## 4. After merge (coordinator)

- [ ] 4.1 Throwaway PR with a broken Dockerfile fails `Image build` (AC-4)
- [ ] 4.2 Proxy release published; add-on `PROXY_VERSION` points at it
- [ ] 4.3 Add-on PR: Dockerfile runs the script, `run.sh` drops `UV_THREADPOOL_SIZE` (AC-1, AC-7)
- [ ] 4.4 Add-on released; HA update log shows the provenance line, proxy starts (AC-6)
