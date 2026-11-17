# Proposal: Install the pinned yq instead of reading the runner image's

Issue: torrent-tv/meta#472 (blocks proxy pull request 83, meta#470). License of the tool: yq,
MIT (`gh api repos/mikefarah/yq/license`).

## Why

The workflow checks of `scripts/check.sh` read the workflow files with `yq`, and `yq_pinned()`
compares the `yq` of the GitHub runner image with `YQ_VERSION=4.54.1`. The image changed from
`ubuntu26/20261101.186` to `ubuntu26/20261111.196` and ships yq 4.54.3, so every check that calls
`yq_pinned` fails (`yq is not 4.54.1 ... v4.54.3`), and `Dependencies` runs fail since
2026-11-13. Root cause: the pin is compared with a version another party owns and updates.

## What changes

- `scripts/check.sh` gets `YQ_SHA256` (digest of `yq_linux_amd64` v4.54.1, committed), the function
  `yq_install` and the subcommand `yq-install`: download the release binary of mikefarah/yq at
  `YQ_VERSION`, verify the digest by comparing the first field of the `sha256sum`
  output with the committed one, refuse a mismatch with
  `::error::yq_linux_amd64 v4.54.1 does not match the pinned SHA-256`, install into
  `$YQ_BIN_DIR` (default `$RUNNER_TEMP/yq-bin`) and append that directory to `$GITHUB_PATH`.
  `yq_pinned()` stays and verifies the `yq` on `PATH`.
- `main.yml` job `checks` and `dependencies.yml` job `update` run the step
  `yq is the pinned version` (`bash scripts/check.sh yq-install`) before the first step that
  calls yq. The step holds no token. No workflow names the version.
- `AGENTS.md` and the `main.yml` comment no longer say that yq comes from the runner image.
- `workflow-selftest` gains the proofs of the digest, the missing file and the matching file.

## Out of scope

Moving to yq 4.54.3 or later; `jq`; non-x64 runners; the other three repositories (own pull
requests with the same `check.sh` block).
