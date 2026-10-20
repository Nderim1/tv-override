# tv-override – agent instructions

Profile-driven setup of Android / Google TVs (and Android projectors) over ADB: prepare, debloat, apps,
launcher, screensaver, remote buttons, live TV kept intact. Works with any agent runtime that can run shell
commands (Codex, Claude Code, …).

## Start here

1. Read `prompts/agent-system.md` (rules, dashboard-first communication, delegation) and follow
   `prompts/workflow.md` for any TV task. The same workflow is packaged as the `tv-setup` skill.
2. Start the control center for the owner: `./tvctl ui --no-open` in the background → http://127.0.0.1:8787.
   Questions go there via `./tvctl ask`; the chat is the fallback.
3. Delegate screenshots, research and log reading to helpers on the same model at the lowest effort
   (`prompts/roles/`): native subagents where the runtime has them, otherwise `./tvctl helper <role> …`.

## Map

- `tvctl` – the CLI (Python 3.11+, stdlib only). `./tvctl --help`; add `--json` when parsing output.
  Exit codes: 0 ok, 1 error, 2 waiting on the owner.
- `profiles/<tv>.toml` – desired state of one TV. `presets/*.toml` – brand/platform knowledge (core / bloat /
  optional packages, live TV, launcher, quirks, remote keys, `[[prepare]]` steps). `apps.toml` – app catalog.
- `state/<tv>/` – baseline, dossier (all TV data), prep guide, run records. Keep it; restore/revert rely on it.
- `apks/` – verified APKs (sha256 pinned in apps.toml). `remote-remap/` – our button remapper.
- `ui/` – control center (live runs, screen, prep walkthrough, apps, buttons, approvals, history).
- `prompts/` – agent prompts; `prompts/roles/` – helper roles. `agent.toml` – how `tvctl helper` runs them.
- `legacy/` – the first, one-off scripts. Reference only.

## Rules that matter most

Change TVs through profiles + `tvctl` (plan → apply, or single steps / single apps), never touch `core` /
`unknown` / live-TV packages, the owner does security and money steps on the TV, helpers are read-only, and
diagnose with logs before retrying.

## Runtime notes

- **Network:** tvctl reaches the TV over the LAN (ADB, port 5555) and helpers research online. In sandboxed
  runtimes enable network access (Codex: `codex -c sandbox_workspace_write.network_access=true`).
- **Long waits:** `tvctl ask` blocks up to 540 s by default (fits common tool-call limits); use `--timeout` if
  your runtime allows longer commands.
