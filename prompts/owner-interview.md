# Prompt: interview the owner and fill in the profile

Goal: turn what the owner uses into `profiles/<tv>.toml`. Ask in plain language, a few questions at a time,
and offer the recommended answer. Before asking, run `./tvctl --json inventory <tv> --class optional` and
`--class user` so you only ask about things this TV actually has.

## Questions → profile fields

| Ask | Maps to |
|---|---|
| Full makeover, or only some parts? (apps only / cleanup / new home screen / everything) | recipe or `--only` steps for the run; apps only → `[apps].debloat = false` and no `[home].launcher` |
| Which apps do you actually watch with? (streaming, Kodi, YouTube…) | `[apps].install` (catalog ids), `[apps].keep` |
| Kosovo TV and radio channels on the home screen? (RTK, Klan Kosova, KTV, RTV 21, …; free streams, play in Kodi) | yes → `[kodi].packs = ["kosovo"]` (installs Kodi + Kodi Rows; other packs: `channels/`) |
| Do you watch antenna / cable / satellite channels on the TV itself? | yes → pin the brand's live TV player (preset `[live_tv].player`) in the launcher, offer a remote button for it. Live TV packages stay on either way |
| Do you use YouTube? Signed in? Ads bother you? | recommend `smarttube` (ad-free, sign-in keeps subscriptions); stock YouTube goes to `disable` |
| Do you use the voice button on the remote? | yes → keep `com.google.android.katniss` + vendor voice (e.g. `com.tcl.ttvs`); no → disable (saves ~110 MB) |
| Do you cast from your phone? From iPhone/Mac (AirPlay)? Mirror the screen? | keep `com.google.android.apps.mediashell` / AirPlay / Miracast packages, else disable |
| Do you play files from USB drives? | keep or disable the vendor media player |
| The preinstalled streaming apps (list them): which do you use? | used → `keep`, unused → `disable` |
| Apps you installed yourself (list them): keep which? | `user_apps = "remove-others"` + `keep`, or `"keep-others"` |
| A cleaner, faster home screen? | `[home].launcher = "projectivy"` (frees ~170 MB on Google TV) or `"stock"` |
| Screensaver: photos, aerial videos, clock, none? | `[home].screensaver` = `aerialviews` / `backdrop` / `google-ambient` / `basic-colors` |
| Snappier menus? | `[home].animation_scale = 0.5` |
| Block ad and tracking servers for the whole TV? (free, no account; can't block YouTube ads) | `[home].dns = "hagezi-light"` (Android 9+); TVs without ADB: the `dns-filter` prepare step |
| Remote buttons for apps you don't use (Netflix, YouTube, Prime…): what should they open instead? | `[keys]` via prompts/learn-keys.md; add `remote-remap` to install |

## Asking through the dashboard

Turn each row into one `tvctl ask` (prompts/agent-system.md has the syntax). Good shapes:
- "Which apps do you use?" → `--kind multi --options-from optional` (pre-ticked = currently on), then
  `--options-from user` for apps they installed themselves.
- Yes/no topics (voice, casting, USB, live TV) → one `--kind multi` with an option per feature, not five confirms.
- Launcher / screensaver → `--kind choice` with a one-line hint per option.
- Confirm the final plan → `--kind confirm` with the plan summary in `--body`.
Keep each question to one screen; put the why in `--body`.

## Rules

- Low RAM TVs (≤ 2 GB): recommend the launcher swap and disabling the Google ambient screensaver.
- Never guess "keep" vs "disable" for something the owner might use (voice, casting, AirPlay): ask.
- Uninstalling user apps deletes their data and logins: say so and get a clear yes.
- Write the owner's answers as a short comment at the top of the profile ("Uses: Kodi, YouTube, voice…") so
  the next person knows why.
- Finish with `./tvctl plan <tv>` and walk the owner through it before `apply`.
