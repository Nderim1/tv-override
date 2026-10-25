# tv-override

Make Android / Google TVs (and Android projectors) fast and clean again, the same way every time:
remove bloat and tracking, install the apps the owner actually uses, swap the home screen, set a nice
screensaver and remap the remote's app buttons, while live TV and HDMI inputs keep working.

Each TV is described by a profile. `tvctl` makes the TV match it over ADB, and can be re-run any time
(after vendor updates too). An LLM agent runs the workflow with the owner using the prompts in `prompts/`: it works with any agent
runtime that can run shell commands (Codex, Claude Code, …), see "Agents" below.

## Layout

| Path | What |
|---|---|
| `tvctl` | The CLI (Python 3.11+, stdlib only) |
| `profiles/<tv>.toml` | Desired state of one TV: apps, keep/disable, launcher, screensaver, buttons |
| `presets/*.toml` | Brand/platform knowledge: core / bloat / optional packages, live TV, launcher, quirks, remote keys |
| `apps.toml` | App catalog: Play Store apps and verified APKs, with their roles (home, screensaver, accessibility) |
| `apks/` | Verified APKs (sha256 pinned in `apps.toml`), e.g. SmartTube 32.56 |
| `remote-remap/` | Our 16 KB button remapper app (config pushed by tvctl; `bash build.sh`, no Gradle) |
| `kodi-rows/` | Home screen rows of Kodi movies, live TV and radio, click to play (`[[kodi.rows]]`) |
| `state/<tv>/` | Baseline snapshot + history of every change (used by restore) |
| `ui/` | The control center: `server.py` (stdlib HTTP + SSE) and `static/` (vanilla JS, no build) |
| `prompts/` | Agent prompts: system prompt, owner interview, package classification, keys, diagnosis, APK checks |
| `AGENTS.md`, `prompts/workflow.md` | Agent entry point and workflow, runtime-neutral |
| `.agents/skills/`, `.claude/` | Thin per-runtime wrappers (skill, Claude Code subagents) |
| `agent.toml` | How `tvctl helper` starts helper agents (same model, lowest effort) |
| `legacy/` | The first one-off scripts from the living-room TV |

## Control center (dashboard)

```bash
./tvctl ui            # http://127.0.0.1:8787 – also auto-started by plan/apply/init/status/restore
```

A local web dashboard for the whole workflow: a **live view of the TV screen** (switches on by itself when a
run needs you on the TV), fleet of TVs with online state and run stats, live performance
(RAM, swap, load, top memory users) before vs after each run, a step-by-step pipeline with every action,
**action-required** banners when the owner has to do something on the TV or approve uninstalls, the app list
with keep / disable / uninstall decisions (saved to the profile), a **remote buttons** editor (press a button
on the remote, pick the app it should open, try it, save & push), run history, and a restore-to-defaults button.
Runs started from the terminal or by the agent stream into it live.

It is also the agent's channel to the owner: the agent asks structured questions with `tvctl ask` (choices,
checklists, yes/no, "do this on the TV, then click done") and they appear as cards in the dashboard; the owner
can send requests to the agent ("classify unknown packages", "something broke", …) which it picks up with
`tvctl inbox`; and `tvctl notify --level need-chat` raises a banner when the agent needs a real conversation in
the chat. The AGENT chip shows whether an agent is currently listening. It listens on 127.0.0.1 only and every
API call needs a per-start token. `TVCTL_NO_UI=1` disables the auto-start.

## Quick start (new TV)

On the TV: Settings → System → About → click "Build" 7× → Developer options → USB debugging on.

```bash
./tvctl find                                   # find TVs on the network
./tvctl init kitchen-sony --host 192.168.1.50  # accept the ADB prompt; reads all TV data + builds a prep guide
./tvctl guide show kitchen-sony               # preparation walkthrough (also in the dashboard: [P])
./tvctl inventory kitchen-sony --class optional
# edit profiles/kitchen-sony.toml with the owner (prompts/owner-interview.md)
./tvctl plan kitchen-sony
./tvctl apply kitchen-sony                      # pauses for steps the owner does on the TV
./tvctl keys learn kitchen-sony                 # remap remote buttons
./tvctl status kitchen-sony --reboot            # verify after a reboot
```

Or ask your agent (Codex, Claude Code, …): "set up the TV at 192.168.1.50". It follows `AGENTS.md` →
`prompts/workflow.md` (also available as the `tv-setup` skill).

## TVs without Android

The scan recognises the platform of every TV (UPnP/DIAL descriptions + port fingerprints) and a profile has
`[tv].platform`. Only Android TVs (Google TV, Android TV, Fire TV) have ADB and get the full workflow.

| Platform | Examples | What tvctl can do |
|---|---|---|
| `adb` | TCL / Sony / Philips Google TV, Fire TV, Android projectors | everything |
| `vestel` | JVC, Hitachi, Telefunken, Finlux, Toshiba (Vestel OS + Vewd store) | launch/stop YouTube, Netflix, Prime Video (DIAL); remote keys if the TV opens port 4660; guided privacy walkthrough |
| `roku` | Roku TVs | list/launch channels, remote keys (ECP, untested) |
| `tizen` | Samsung | open/close installed apps, TV info; after a one-time Allow on the TV (`tvctl pair <tv>`): remote keys, hold, typing; guided privacy walkthrough |
| `webos` | LG | DIAL app launch, guided walkthrough |

### Samsung: TizenTube and our own home screen

SmartTube and Projectivy are Android apps. On a Samsung TV the equivalents are **TizenTube** (ad-free YouTube with
SponsorBlock, vendored in `apks/`, checksum-pinned) and **Override Home** (`samsung-home/`: your apps, clock,
screensaver). Both install in Samsung's Developer Mode:

```bash
./tvctl tizen status samsung-tv     # what is missing
./tvctl tizen setup samsung-tv      # SDK tools, Samsung's certificate tool, the TV's certificate (stops for the owner)
./tvctl install samsung-tv tizentube
./tvctl install samsung-tv override-home
```

The owner turns on Developer Mode (Host PC IP = this computer), accepts Samsung's SDK licence and signs in to a
Samsung account once. Certificates live in `~/tizen-studio-data` and `~/.tv-override/samsung` (back up
`author-backup.p12`: updates must be signed with it). Samsung's Home button can't be replaced: with *Autorun Last
App* on and *Start with Smart Hub Home* off, the TV starts in Override Home. The dashboard has all of it under
[S] own apps, with a preview of the home screen.

None of these can take screenshots: the control center's **phone camera** ([00] live screen › START PHONE CAMERA)
turns a phone on the same Wi-Fi into the camera, and `tvctl screenshot` returns its newest picture.

```bash
./tvctl init jvc-tv --host 10.165.138.127     # platform detected automatically
./tvctl dial jvc-tv                             # apps and whether they run
./tvctl dial jvc-tv launch YouTube
./tvctl key jvc-tv home                         # where the platform allows network keys
./tvctl pair samsung-tv                         # Samsung: choose Allow on the TV once
./tvctl key samsung-tv 'down*3' ok              # repeats; --hold 1.5 ok holds a key
./tvctl type samsung-tv "76.76.2.37"            # into the TV's on-screen keyboard
```

For the full workflow on such a TV, add an Android / Google TV stick on HDMI as its own profile.

## Pick what a run does

A run is any combination of steps. Each step pulls in what it needs, so nothing half-done can happen
(the original launcher is only switched off as part of "home", after the new one is installed and set up).

| Step | Does | Recipes |
|---|---|---|
| `apps` | install the profile's apps, remove unwanted ones | full, apps-only |
| `debloat` | disable bloat/tracking (presets + your disable list) | full, cleanup |
| `home` | switch to the chosen launcher (or back to `stock`); push `[[kodi.rows]]` | full, home-screen |
| `screensaver` | set the chosen screensaver, installing it if needed | full |
| `tweaks` | animation speed, DNS ad / tracker filter (`[home].dns`) | full, cleanup |
| `buttons` | push the remote button map, installing Remote Remap if needed | full |

```bash
./tvctl apply kitchen-sony --recipe apps-only
./tvctl apply kitchen-sony --only home,screensaver
./tvctl install kitchen-sony smarttube        # one app, nothing else
./tvctl uninstall kitchen-sony com.example.app
```

In the dashboard: ▶ RUN WORKFLOW… opens the step picker (recipes, per-step choices, PREVIEW / RUN), and
[03] app store installs, updates, opens and uninstalls single apps. A profile with `debloat = false` is
"apps only": preset bloat is never disabled, only what its `disable` list names.

## Everyday commands

```bash
./tvctl plan living-room-tcl                    # what would change ("nothing to do" = in sync)
./tvctl apply living-room-tcl                   # re-apply, e.g. after a TCL update
./tvctl restore living-room-tcl com.netflix.ninja   # undo one package (or --all / --defaults)
./tvctl revert living-room-tcl 20261020-111623 --keep  # undo everything one run changed
./tvctl install living-room-tcl smarttube --force   # (re)install a catalog app
./tvctl keys set living-room-tcl 245 --open kodi --label YouTube
./tvctl --json status living-room-tcl            # machine-readable state
```

Exit codes: 0 ok, 1 error, 2 waiting on the owner (a step on the TV, or a confirmation).

## How it decides

- Every package is classified by the presets: **core** (never touched), **bloat** (disabled unless the
  profile keeps it), **optional** (owner decides), **unknown** (reported, never touched until classified).
  Exact entries beat globs; among equals core > bloat > optional.
- Packages in a preset's `[live_tv]` (tuner, TV player, channel provider) always stay on.
- Disabling is reversible (`restore`). Uninstalling user apps deletes their data, so it always asks.
- The stock home is only replaced once the new launcher is installed and its accessibility service is on;
  stock launcher and setup wizard are disabled together (otherwise Home lands on a recovery screen).
- The profile's `serial` stops a profile from being applied to the wrong TV.

## Steps only the owner can do

Accepting the ADB prompt, switching on accessibility services (Projectivy, Remote Remap), Play Store
installs and purchases, signing in to apps. `tvctl apply` lists them with exact menu paths and re-checks.

## Remote Remap

One APK for every TV. `tvctl` pushes the `[keys]` table to it over ADB; only the ADB shell can change it
(the receiver requires `android.permission.DUMP`). On TCL, `tvctl apply` also grants the `APP_AUTO_START`
app-op its accessibility service needs. Signing key: `remote-remap/remap.keystore` (keep it, so updates install
over the old version).

## Kodi Rows

Home screen rows of movies from Kodi add-ons (e.g. Umbrella), as Android TV preview channels: Projectivy and
the stock launcher show them, a poster opens Kodi and plays the movie through the add-on (its source picker).
Each `[[kodi.rows]]` in the profile lists add-on folders (`tvctl kodi browse <tv> [PATH]` finds them), how many
"Next page"s to follow, `sort = "year"` (newest first), `exclude_countries` / `exclude_languages` and
`exclude_ratings` (US certificates like `"R"`, `"NC-17"`). The app reads them over Kodi's JSON-RPC (127.0.0.1:9090,
on by default for apps on the same device), every hour while Kodi is running, never during playback. Each movie's
text starts with its IMDb rating (IMDb's free daily `title.ratings.tsv.gz`, fetched once a day), genre and
certificate. Posters are downloaded by the app and served from its cache (`content://com.nde.kodirows.posters/…`),
because Projectivy won't download remote program art itself. `tvctl kodi status|push|refresh <tv>`. Projectivy: switch the new row on
once in Settings › Edit channels › <row> › Visible. Signing key: `kodi-rows/kodirows.keystore`.

Separate live TV and radio rows use `type = "live"` or `type = "radio"` and `[[kodi.rows.channels]]`
entries with station names, logos and playback URLs. Gjirafa streams resolve on entry; Klan links renew
during playback. These rows refresh independently of Kodi. See [Kodi Rows](kodi-rows/README.md) for the
profile format and checked sources.

## Adding knowledge

- New brand or device (e.g. a projector) → `prompts/classify-packages.md`, start from `presets/_template.toml`.
- New app or APK update → `prompts/verify-apk.md`, then `apps.toml`.
- New failure mode → `prompts/diagnose.md`.

## Agents (model-agnostic)

Everything the agent needs is plain Markdown plus the `tvctl` CLI, so any runtime that can run shell commands
works. Entry point: `AGENTS.md` (read by Codex and most agents; `CLAUDE.md` just imports it).

| Piece | Shared source | Runtime wrappers |
|---|---|---|
| Rules | `prompts/agent-system.md` | – |
| Workflow | `prompts/workflow.md` | skill `tv-setup`: `.agents/skills/` (Codex), `.claude/skills/` |
| Helper roles | `prompts/roles/*.md` | Claude Code subagents `.claude/agents/`; others: `./tvctl helper` |
| Talking to the owner | `tvctl ask / inbox / notify` + dashboard | – |

Helpers always run on the same model as the main agent at the lowest effort: Claude Code subagents use
`model: inherit` / `effort: low`; `tvctl helper` starts the runtime's CLI with its default model and the
lowest effort from `agent.toml` (Codex: `codex exec … -c model_reasoning_effort="low"`).

**Codex:** start it in this folder with network access, because tvctl talks to the TV over the LAN and helpers
research online: `codex -c sandbox_workspace_write.network_access=true` (or approve network use when asked).
