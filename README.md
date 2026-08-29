# Ephemeral Build Kit (ebk)

CI-style disposable VM testing for **Windows** and **Linux** via docker-compose.
Spin up a fresh OS, run your tests inside it, capture screenshots + a screen
recording, collect logs, then tear everything down — like a GitHub Actions
runner that disappears after the job.

- **Windows** images: [`dockurr/windows`](https://github.com/dockur/windows)
- **Linux** images: [`qemus/qemu`](https://github.com/qemus/qemu)
- Screen capture: Playwright driving the built-in noVNC web viewer on port `8006`

## Requirements

- Node.js ≥ 18
- Docker (or Podman) on a Linux host with KVM support
- `/dev/kvm` and `/dev/net/tun` available (check with `ebk probe`)
- Playwright Chromium for screen capture: `npx playwright install chromium`

## Install

```bash
npm install
npx playwright install chromium
```

## Quick start

```bash
# Check the environment
node src/index.js probe

# List supported operating systems
node src/index.js list

# Only generate the compose file (no VM, no network)
node src/index.js generate --os win10 --run-id demo \
  --test-dir ./tests --package-dir ./packages --debug

# Full CI-style run
node src/index.js run --os ubuntu --run-id build \
  --ram 6G --cpu 4 --disk 128G \
  --test-dir ./tests \
  --screenshot-every 30 --web-port 8066 --keep
```

## Commands

| Command | Description |
|---|---|
| `list` | Print the table of supported OS ids and images. |
| `probe` | Verify Docker daemon, `/dev/kvm` and `/dev/net/tun`. |
| `generate` | Generate `compose/<os>-<runId>/docker-compose.yml` only. |
| `run` | Generate → up → wait → test → capture → collect → cleanup. |

## Common options

```
--ram <size>            RAM (default 4G)
--cpu <n>               CPU cores (default 2)
--disk <size>           Disk size (default 64G)
--test-dir <dir>        Host dir mounted as the shared/test folder
--package-dir <dir>     Host dir mounted as package/oem folder
--oem-dir <dir>         Host dir mounted to /oem (Windows install.bat)
--web-port <port>       Host port for the 8006 viewer (default 8006)
--ssh-port <port>       Guest SSH port (Linux)
--rdp-port <port>       Guest RDP port (Windows)
--username/--password   Windows credentials
--language <lang>       Windows display language
--version-url <url>     Custom Windows ISO/version
--boot-url <url>        Custom Linux image
--debug                 Enable DEBUG/TRACE in the guest
```

`run` adds: `--screenshot-every <sec>`, `--no-video`, `--test-timeout <min>`,
`--wait-timeout <min>`, `--boot-settle <sec>`, `--keep`.

## Supported operating systems

**Windows** (`VERSION`):

| id | VERSION | OS |
|---|---|---|
| `win7` | `7u` | Windows 7 Ultimate |
| `win10` | `10` | Windows 10 Pro |
| `win11` | `11` | Windows 11 Pro |
| `win8` | `8e` | Windows 8.1 Enterprise |
| `winxp` | `xp` | Windows XP Professional |
| `win2019` / `win2022` / `win2025` | `2019`/`2022`/`2025` | Windows Server |
| `tiny10` / `tiny11` | `tiny10`/`tiny11` | Tiny |

**Linux** (`BOOT`): `ubuntu`, `ubuntus`, `arch`, `debian`, `fedora`, `centos`,
`kali`, `alpine`, `mint`, `manjaro`, `rocky`, `kubuntu`, `xubuntu`, and more.

Run `node src/index.js list` for the complete table.

## How a run works

1. **Generate** a `docker-compose.yml` with the selected OS and resource settings.
2. **Up** — `docker compose up -d`.
3. **Wait** for the VM to become ready by polling the container logs for a ready
   marker and/or the web viewer port (see wait tuning below).
4. **Test** — your scripts run inside the guest and write a `RESULT_<runId>.*`
   marker (+ logs) back to the shared folder (`/shared` on Linux, Samba `Z:`
   on Windows). The kit polls for that marker.
5. **Capture** — Playwright opens the web viewer, takes periodic PNGs and records
   a video (`.webm`) to `artifacts/<os>-<runId>/`.
6. **Collect** — container logs and guest result/log files are copied into the
   artifact folder.
7. **Cleanup** — `docker compose down -v` and remove the compose + storage
   dirs (GitHub-Actions style). Use `--keep` to retain them for debugging.

### Wait tuning

Readiness is detected when the container is running, the viewer port accepts
connections, **and** a ready marker matches the logs (or an optional probe
passes, or a `--boot-settle` window elapses). Default markers include install
finished / OS ready phrases. For custom guests you can add a probe later; the
kit proceeds once the viewer is reachable, so a missed marker just means it
moves to the test step earlier/later.

### Writing test results

Create a `RESULT_<runId>.log` or `RESULT_<runId>.json` file in the shared folder
(the folder you pass as `--test-dir`). The kit treats the run as **success** when
the content matches `pass|success|ok|0`; otherwise it is a failure. Any `.log`,
`.json` or `.txt` files in the shared folder are collected as artifacts.

## Artifacts

```
artifacts/<os>-<runId>/
├── screenshots/shot-0000.png ...
├── final.png
├── page@<hash>.webm        # session recording
├── container.log           # docker logs
├── RESULT_<runId>.log      # your guest result marker
└── <other guest logs>
```

Disabled by default: change `--no-video` / `--screenshot-every`. Cleanup removes
the container, the generated compose and the VM storage unless `--keep` is set.

## Custom images

Use `--version-url <iso-url>` (Windows) or `--boot-url <image-url>` (Linux) to
bootstrap an image not in the catalog.

## Full Windows in-guest toolchain build (recipe)

The web viewer / SMB channel is enough for basic capture, but to run a **full
Windows build** (e.g. MSYS2 + wxWidgets + Go, like a CI `windows-2022` job) you
need the toolchain installed *inside* the guest. This environment-validated
recipe works even when the guest cannot reach the SMB `host.lan` share and
large downloads stall:

1. **Inject onto the disk instead of `/oem`.** `dockur/windows` caches the
   install media per ISO, so changes to `/oem` are ignored. Mount the guest disk
   `data.img` read-write with ntfs-3g and write your scripts + repo directly
   (e.g. into `C:\OEM`).
2. **Make it reusable.** Put a `.cmd` in
   `C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`
   (or register `schtasks /sc onlogon`) so the build auto-runs at logon. A
   properly prepared `data.img` becomes a golden image → no reinstall per run.
3. **Deliver the toolchain without guest network.** If guest downloads stall,
   download/extract on the host and copy the resulting tree onto the disk
   (MSYS2 base + Go). MSYS2 packages (gcc/cmake/ninja/wxWidgets/freexl) can then
   be pulled by `pacman` inside the guest.
4. **Watch the git worktree:** NTFS does not store the exec bit and re-writes
   line endings, so set `git config core.autocrlf false` and
   `git config core.filemode false`, then re-checkout before the release gate.
5. **Retrieve outputs without SMB.** Have the guest write results to the disk
   and then perform a graceful `shutdown /s`; when the container exits, mount
   `data.img` read-only with ntfs-3g to copy out the artifacts.

## Notes

- Both image families share the **same web viewer on port 8006**, which is why
  Playwright capture is uniform across every OS.
- Screen capture requires Chromium; install it with `npx playwright install chromium`.
- The kit does not distribute Windows itself; you are responsible for licensing
  your use.
