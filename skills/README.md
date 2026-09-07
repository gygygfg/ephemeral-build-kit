# ebk Skills (tool-calling schemas)

`ebk.skills.json` exposes the `ephemeral-build-kit` CLI as a set of structured
**tool-calling / function-calling** definitions so an LLM agent can invoke
`ebk` reliably. Each entry follows the standard shape:

```json
{
  "name": "ebk_generate",
  "description": "...",
  "parameters": {
    "type": "object",
    "properties": { "...": { "type": "...", "description": "..." } },
    "required": ["os"]
  }
}
```

## Available skills

| name | CLI | purpose |
|---|---|---|
| `ebk_list` | `ebk list` | discover supported OS ids |
| `ebk_probe` | `ebk probe` | check Docker / KVM / TUN readiness |
| `ebk_generate` | `ebk generate` | emit a docker-compose.yml only |
| `ebk_run` | `ebk run` | full disposable VM pipeline |
| `ebk_browser_up` | `ebk browser up` | start a disposable Selenium Chrome container |
| `ebk_browser_run` | `ebk browser run` | browser pipeline: up -> wait -> capture -> cleanup |
| `ebk_browser_status` | `ebk browser status` | report browser container status |
| `ebk_browser_down` | `ebk browser down` | stop/remove the browser container |

## Notes

- `os` is required for `ebk_generate` / `ebk_run`; call `ebk_list` first to pick a
  valid id.
- Host ports are resolved before start and auto-shift (后延) to the next free
  port if the requested one is occupied; the resolved mapping is printed.
- The consuming agent should map the returned CLI-style args (e.g. `--web-port`,
  `--test-dir`) to the `ebk` process and pass `--help` output back for unknown
  options.

## Anthropic Skill package (self-contained)

Besides the function-calling schemas above, `ebk` is also provided as a
self-contained **Anthropic Skill** (`SKILL.md`-based) bundle in
[`ebk/`](ebk/). It ships the runnable CLI under `src/` (plus `browser/`,
`package.json`, `package-lock.json`) and the schemas as `ebk.skills.json`.
`node_modules` is **not** bundled.

Build the skill zip with [`tools/package-skill.sh`](../tools/package-skill.sh):

```bash
# self-contained: copy src/ + browser/ + package*.json + authored docs, then zip
tools/package-skill.sh --project . -o ebk.skill.zip

# validate only (frontmatter + SKILL.md checks, no zip written)
tools/package-skill.sh --check skills/ebk
```

Once installed, the skill folder IS the project root; run the CLI from it:

```bash
npm install --no-audit --no-fund
npx playwright install chromium
node src/index.js list
```

`package-skill.sh --project` copies the project runtime plus `skills/ebk/`'s
authored docs into a temp staging dir, then zips it into the Anthropic layout
(first layer = `ebk/`, `SKILL.md` at its root). See
[`skills/ebk/SKILL.md`](ebk/SKILL.md) for the agent-facing instructions.
