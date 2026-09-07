# ebk CLI — command reference

Run the CLI from the skill directory with `node src/index.js <subcommand>`
(or `ebk <subcommand>` if installed on PATH after `npm install`).

## `list`

```bash
node src/index.js list
```

Print the table of supported OS ids, image families (`VERSION` for Windows,
`BOOT` for Linux) and labels. Use it to pick a valid `--os` id.

## `probe`

```bash
node src/index.js probe
```

Verify Docker daemon, `/dev/kvm` and `/dev/net/tun`. Exits non-zero if any
check fails. Run before starting a VM.

## `generate`

```bash
node src/index.js generate --os <id> [options]
```

Only emit `compose/<os>-<runId>/docker-compose.yml` (no VM, no network).
Host ports are auto-shifted (后延) to the next free port if occupied.

Common options:

| Option | Default |
|---|---|
| `--run-id <id>` | auto-generated |
| `--os <id>` | **required** |
| `--ram <size>` | `4G` |
| `--cpu <n>` | `2` |
| `--disk <size>` | `64G` |
| `--test-dir <dir>` | — |
| `--package-dir <dir>` | — |
| `--oem-dir <dir>` | — |
| `--web-port <port>` | `8006` |
| `--vnc-port <port>` | `5900` |
| `--ssh-port <port>` | Linux only |
| `--rdp-port <port>` | Windows only |
| `--username / --password / --language` | Windows |
| `--version-url <url>` | Windows ISO |
| `--boot-url <url>` | Linux image |
| `--debug` | off |

## `run`

```bash
node src/index.js run --os <id> [options]
```

Full pipeline: generate → up → wait → test → capture → collect → cleanup →
report `success`/`reason`/`artifacts`. Exits `0` on success.

Adds to `generate` options:

| Option | Default |
|---|---|
| `--screenshot-every <sec>` | `30` |
| `--no-video` | off |
| `--test-timeout <min>` | `20` |
| `--wait-timeout <min>` | `30` |
| `--boot-settle <sec>` | `0` |
| `--keep` | off |

## `browser up`

```bash
node src/index.js browser up [options]
```

Start a disposable Selenium Chrome container (`selenium/standalone-chrome` with
a vendored XFCE desktop build context from `browser/`) and keep it running.
Print `selenium` / `noVNC` / `vnc` endpoints.

## `browser run`

```bash
node src/index.js browser run [options]
```

Start → wait WebDriver/noVNC → capture screenshots/video (optionally wait for a
`RESULT_<runId>.*` marker in `--test-dir`) → collect logs → cleanup.

Browser options:

| Option | Default |
|---|---|
| `--run-id <id>` | auto-generated |
| `--test-dir <dir>` | — |
| `--build-dir <dir>` | `<skill>/browser` |
| `--browser-image <tag>` | build from `browser/` |
| `--selenium-port <port>` | `4444` |
| `--vnc-port <port>` | `5900` |
| `--no-vnc-port <port>` | `7900` |
| `--shm-size <size>` | `2gb` |
| `--vnc-password <pass>` | `secret` |
| `--screenshot-every <sec>` | `30` |
| `--no-video` | off |
| `--duration <sec>` | `60` |
| `--test-timeout <min>` | `20` |
| `--keep` | off |

## `browser status` / `browser down`

```bash
node src/index.js browser status   # is a browser container running? endpoints?
node src/index.js browser down     # stop + remove container, compose, state
```

## Port auto-shift behavior

Host ports are resolved before the service starts. If a requested port is
occupied, `ebk` shifts it to the next free port and prints the resolved mapping
(e.g. `web 8006 -> 8007`). The resolved ports are the ones used by `wait`,
`capture` and the persisted browser state.

## Test result marker

Write `RESULT_<runId>.log` / `RESULT_<runId>.json` in the folder passed as
`--test-dir`. The run is **success** when the content matches
`pass|success|ok|0`; otherwise failure. On Windows the guest writes to the Samba
share `\\host.lan\Data` (mapped to `Z:`); on Linux to `/shared`.
