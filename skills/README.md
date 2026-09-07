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
