# Proposal: Proxy as a single binary + service registration (research, queued)

## Why

Bare-npm installation assumes Node.js on the host — a real barrier for the
non-technical proxy owners the pool model targets. Node's Single Executable
Applications (SEA, stable-ish since Node 20/21) allow shipping the proxy as
one self-contained binary per platform (win/linux/macOS, x64/arm64): download,
run, done. A binary can also offer — with the user's explicit consent — to
register itself as an auto-starting service, closing the "survives reboot"
gap that the HA addon solves today.

## What Changes (research scope first)

- **SEA build pipeline**: `node --experimental-sea-config` + postject-injected
  blob, one artifact per platform/arch, published as GitHub release assets
  alongside the npm package.
- **Known hard parts to resolve in research**:
  - Native addons (`node-datachannel`, `utp-native`) cannot live inside the
    SEA blob — they must ship next to the binary or self-extract on first
    run to a data dir.
  - `ffmpeg-static`'s binary likewise ships alongside (or the system ffmpeg
    is required, as the HA addon already does with `--ffmpeg-bin`).
- **Service registration (opt-in, explicit user action)**:
  - Linux: `proxy install-service` writes a systemd unit and runs
    `systemctl enable --now` (requires sudo — the consent step).
  - Windows: register via `sc create` / a service wrapper (admin prompt =
    consent).
  - macOS: launchd plist in `~/Library/LaunchAgents` (user-level, no admin).
  - Uninstall counterpart mandatory (`proxy uninstall-service`).
- Stays deployment-agnostic: the binary is a fourth distribution channel
  next to HA addon, bare npm and Docker; no code paths may assume it.

## Capabilities

### New Capabilities

- `distribution`: how the proxy is packaged and installed on bare hosts.

### Modified Capabilities

<!-- none -->

## Impact

- Build/release tooling in this repo; a `service` CLI subcommand.
- No changes to runtime behaviour for existing channels.

## Priority

Queued (research). Prerequisite thinking for the "pool of non-technical
owners" product goal; not blocking any current stage.
