---
name: tv-setup
description: Set up, debloat, update or troubleshoot an Android / Google TV with tvctl – new TV onboarding, owner interview, launcher swap, screensaver, remote button remapping, APK updates. Use when the user mentions a TV, tvctl, a profile in profiles/, or remote buttons.
---

# TV setup

Read `prompts/agent-system.md` first: it holds the rules. Run everything from the repo root and use `--json`
when you parse output. tvctl exit code 2 means the owner has to do something on the TV.

## Dashboard first

1. Start (or reuse) the control center: `./tvctl ui --no-open` in the background. Tell the owner once in chat
   to keep http://127.0.0.1:8787 open: questions, steps on the TV and progress will appear there.
2. Collect answers with `./tvctl --json ask …` (see prompts/agent-system.md, "Dashboard first"). Exit 2 → ask
   in chat instead.
3. Between steps and before you finish: `./tvctl --json inbox` for requests the owner sent from the dashboard.
4. Escalate with `./tvctl notify --level need-chat --title "<why>"` and continue in chat.

## New TV

1. **Find it**: `./tvctl find`. Not found → ask the owner for the IP (Settings → Network) and make sure
   Developer options and USB debugging are on (Settings → System → About → click build 7×).
2. **Connect + profile**: `./tvctl init <room>-<brand> --host <ip>`. Tell the owner to accept the ADB prompt on
   the TV. This writes `profiles/<name>.toml` and `state/<name>/baseline.json`.
3. **New brand?** If no brand preset matched or `inventory --class unknown` is not empty, follow
   `prompts/classify-packages.md` before going on.
4. **Interview**: `prompts/owner-interview.md`, asked through `tvctl ask` in the dashboard. Fill in the profile.
5. **Plan**: `./tvctl plan <name>`. Explain it to the owner in plain words; get a yes for any uninstall.
6. **Apply loop**: `./tvctl --json apply <name> [--yes]`. For every `waiting_on_owner` item, tell the owner
   the exact step, wait for "done", re-run apply. Repeat until it exits 0.
7. **Remote buttons**: `prompts/learn-keys.md`.
8. **Verify**: `./tvctl status <name> --reboot`: home is the chosen launcher after boot, services running,
   `pending_changes: 0`, `live_tv.player_enabled: true`. Ask the owner to try Home, Back, voice, the mapped
   buttons, an HDMI input and (if `live_tv.tuner_inputs` is not empty) a live channel opened from the launcher.
9. **Wrap up**: summarise what changed, how much RAM was freed, and how to undo (`./tvctl restore`).

## Existing TV

- Owner wants a change → edit the profile → `plan` → `apply`.
- After a vendor update or a factory reset → `./tvctl apply <name>` re-applies everything (factory reset: redo
  developer options/ADB first; the serial stays the same).
- App update → `prompts/verify-apk.md`, then `./tvctl install <name> <app> --force`.
- Something broke → `prompts/diagnose.md`; quick undo with `./tvctl restore <name> <pkg>`.

## Keep the repo learning

Brand facts → `presets/`, app facts → `apps.toml`, new failure modes → `prompts/diagnose.md`.
