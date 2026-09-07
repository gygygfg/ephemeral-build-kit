---
name: ebk
description: CI-style disposable VM testing for Windows/Linux via docker-compose (dockur/windows, qemus/qemu). Use when you need to boot a fresh throwaway OS, run an install/test script inside it, capture screenshots and a screen recording, collect logs, then tear it all down (GitHub-Actions style). Keywords: docker, vm, ci, test, windows, linux, compose, screenshot, ephemeral, browser, selenium.
---

# ebk — Ephemeral Build Kit

`ebk` boots a **disposable** Windows or Linux VM (or a disposable Selenium
Chrome browser container) via `docker compose`, runs your install/test script
inside the guest, captures screenshots + a screen recording through the built-in
noVNC viewer on host port `8006` (browser container: noVNC `7900`), collects
logs, then tears everything down — like a GitHub Actions runner that disappears
after the job.

This skill package is **self-contained**: it ships the runnable CLI under
`src/` plus the `browser/` build context. `node_modules` is **not** bundled, so
run `npm install` (and `npx playwright install chromium` for capture) once from
this skill directory before first use.

## When to use

Use `ebk` when you need to:

- Test a build / install / end-to-end flow against a **real** Windows or Linux
  OS (not a container).
- Capture a **screenshot / screen recording** of a running GUI or installer.
- Run a **disposable** CI-style verification and then -clean up- (GitHub-Actions
  style).
- Spin up a **browser container** for Selenium/noVNC browser work without a
  full VM.

Do **not** use `ebk` for plain Linux container work (use `docker run`), or when
you need to talk to an actual running VM over SSH/RDP afterward (use `--keep`).

## Prerequisites

- Node.js >= 18
- Docker (or Podman) on a Linux host with KVM support
- `/dev/kvm` and `/dev/net/tun` (check with `ebk probe`)
- Playwright Chromium for screen capture: `npx playwright install chromium`

## Quick start (from this skill dir)

```bash
# 1) install runtime deps once (node_modules are NOT bundled)
npm install --no-audit --no-fund
npx playwright install chromium

# 2) run the CLI (this skill directory is the project root)
node src/index.js probe
node src/index.js list
```

The CLI `bin` is `ebk` (declared in `package.json`). You can invoke it directly
as `node src/index.js ...`, or after `npm install` as
`exec bin/ebk` / `npx ebk` if on PATH.

## Core workflow

```bash
# discover a valid --os id first
node src/index.js list

# verify the environment (docker daemon + /dev/kvm + /dev/net/tun)
node src/index.js probe

# dry-run: only emit the docker-compose.yml (no VM, no network)
node src/index.js generate --os ubuntu --run-id demo \
  --test-dir ./tests --package-dir ./packages --debug

# full CI-style run
node src/index.js run --os ubuntu --run-id build \
  --ram 6G --cpu 4 --disk 128G \
  --test-dir ./tests \
  --screenshot-every 30 --web-port 8066 --keep
```

## Commands

| Command | Purpose |
|---|---|
| `list` | Print supported OS ids and images. |
| `probe` | Verify docker daemon, `/dev/kvm`, `/dev/net/tun`. |
| `generate` | Emit `compose/<os>-<runId>/docker-compose.yml` only. |
| `run` | Generate → up → wait → test → capture → collect → cleanup. |
| `browser up` | Start a disposable Selenium Chrome container, keep running. |
| `browser run` | Start → wait WebDriver/noVNC → capture → cleanup. |
| `browser status` | Show whether a browser container is running. |
| `browser down` | Stop and remove the browser container. |

## Workflow details

1. **Generate** a `docker-compose.yml` for the selected OS and resources.
2. **Up** — `docker compose up -d`.
3. **Wait** — poll container logs / the viewer port for a ready marker (or use
   `--boot-settle`, or a probe).
4. **Test** — your scripts run **inside the guest** and write a
   `RESULT_<runId>.*` marker back to the shared folder (`--test-dir`). On Linux
   this is `/shared`; on Windows it is the dockur Samba share mapped to drive
   `Z:`. The kit polls for that marker; content matching `pass|success|ok|0`
   is success.
5. **Capture** — Playwright opens the web viewer, takes periodic PNGs and
   records a `.webm` to `artifacts/<os>-<runId>/`.
6. **Collect** — container logs + guest result/log files copied into artifacts.
7. **Cleanup** — `docker compose down -v` and remove compose + storage dirs.

## Key options

| Option | Meaning |
|---|---|
| `--os <id>` | OS id from `list` (e.g. `win10`, `ubuntu`). Required for `generate`/`run`. |
| `--ram / --cpu / --disk` | Resources (default 4G / 2 / 64G). |
| `--test-dir <dir>` | Host dir mounted as shared/test folder; watched for `RESULT_<runId>.*`. |
| `--package-dir <dir>` | Host dir mounted as package/oem folder. |
| `--oem-dir <dir>` | Host dir mounted to `/oem` (Windows `install.bat`). |
| `--web-port <port>` | Host port for the `8006` noVNC viewer (default 8006). |
| `--vnc-port <port>` | Host port for the native `5900` VNC server (default 5900). |
| `--ssh-port / --rdp-port` | Guest SSH (Linux) / RDP (Windows) ports. |
| `--username/--password/--language` | Windows credentials / display language. |
| `--version-url <url>` | Custom Windows ISO/version. |
| `--boot-url <url>` | Custom Linux image. |
| `--debug` | Enable DEBUG/TRACE in the guest. |
| `run` extras | `--screenshot-every`, `--no-video`, `--test-timeout`, `--wait-timeout`, `--boot-settle`, `--keep`. |

## Browser container (`ebk browser`)

For when you only need browser operations (web tests, scraping, UI acceptance)
without a full VM. Build context is vendored in this skill under `browser/`.

```bash
node src/index.js browser up        # start, keep running, print endpoints
#   selenium: http://127.0.0.1:4444/wd/hub
#   noVNC:    http://127.0.0.1:7900
#   vnc:      127.0.0.1:5900  (password: secret)

node src/index.js browser run --duration 60 --screenshot-every 10   # full pipeline
node src/index.js browser status
node src/index.js browser down
```

## Port auto-shift (后延)

Every host port `ebk` publishes is resolved before start. If a requested port is
already in use on the host, `ebk` **auto-shifts** it to the next free port (e.g.
`8006` → `8007`) instead of failing. The resolved mapping is printed and is the
one actually used by `wait`, `capture` and the persisted browser state.

## Artifacts

```
artifacts/<os>-<runId>/
├── screenshots/shot-0000.png ...
├── final.png
├── page@<hash>.webm        # session recording
├── container.log           # docker logs
└── RESULT_<runId>.log      # your guest result marker
```

## Custom images

`--version-url <iso-url>` (Windows) or `--boot-url <image-url>` (Linux) to
bootstrap an image not in the catalog.

## Tool schemas

`ebk.skills.json` in this directory exposes the same CLI as structured
tool-calling (function-calling) `name` / `description` / `parameters` (JSON
Schema) definitions covering `list`, `probe`, `generate`, `run` and the
`browser` subcommands. Map its args to the `ebk` process; use the `--help`
output for unknown options.

## Notes

- Windows and Linux images share the **same web viewer on port 8006**, so
  Playwright capture is uniform across OSes. They also expose a **native VNC
  server on port 5900**.
- The kit does not distribute Windows itself; you are responsible for licensing
  your use.
- See `references/README.md` for the full project README and
  `references/commands.md` for a compact command reference.
