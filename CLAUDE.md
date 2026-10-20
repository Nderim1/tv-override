@AGENTS.md

## Claude Code specifics

- The workflow is also the `tv-setup` skill (`.claude/skills/tv-setup/`, a wrapper around `prompts/workflow.md`).
- Helper roles are native subagents in `.claude/agents/` (`tv-screen`, `tv-research`, `tv-diagnose`), preset to
  `model: inherit` and `effort: low`: spawn them by name instead of `tvctl helper`.
