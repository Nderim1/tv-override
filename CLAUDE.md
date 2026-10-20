# tv-override

Profile-driven setup of Android / Google TVs over ADB: debloat, apps, launcher, screensaver, remote buttons.

- `tvctl` – the CLI (Python 3.11+, stdlib only). `./tvctl --help`; add `--json` when parsing output.
- `profiles/<tv>.toml` – desired state of one TV. `presets/*.toml` – brand/platform knowledge (core / bloat /
  optional packages, launcher, quirks, remote keys). `apps.toml` – installable apps and their roles.
- `state/<tv>/` – baseline snapshot and history of applied changes. Keep it; restore relies on it.
- `apks/` – verified APKs (sha256 pinned in apps.toml). `remote-remap/` – our button remapper
  (`bash remote-remap/build.sh`, no Gradle).
- `ui/` – control center (`./tvctl ui`, http://127.0.0.1:8787): live runs, performance, approvals, apps, restore.
- `prompts/` – agent prompts; start with `prompts/agent-system.md`. Workflow: `.claude/skills/tv-setup/SKILL.md`.
- `.claude/agents/` – read-only helper subagents (same model as the main agent, `effort: low`): `tv-screen`
  (screenshots), `tv-research` (web research), `tv-diagnose` (logs). Delegate that work to them.
- `legacy/` – the first, one-off scripts from the living-room TV. Reference only.

Rules that matter most: change TVs through profiles + `tvctl apply`, never touch `core`/`unknown` packages,
the owner does security/money steps on the TV, diagnose with logs before retrying.
