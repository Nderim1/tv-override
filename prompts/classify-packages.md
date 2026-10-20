# Prompt: classify unknown packages (new brand or model)

Input: `./tvctl --json inventory <tv> --class unknown --mem`. Output: entries added to the right preset in
`presets/` (an existing brand preset, or a new `presets/<brand>.toml` with a `[match]` section).

## Classes

| Class | Meaning | Effect |
|---|---|---|
| `core` | The TV or Android needs it: picture, inputs/HDMI, tuner, power, remote pairing, firmware updates, keyboards, WebView, settings, platform services | never touched |
| `bloat` | Nobody needs it: ads, recommendations, telemetry/ACR tracking (Samba TV, ACR, "logkit"), store demo, e-manuals, promos, vendor accounts, game bars | disabled on every TV unless the profile keeps it |
| `optional` | Some owners use it: voice, casting, AirPlay, mirroring, USB player, preinstalled streaming apps, screensavers | the owner decides per TV |

## How to decide

1. Use the package name, `dumpsys package <pkg>` (activities, services, permissions, `sharedUserId`) and RAM.
   `android.uid.system` / platform-signed services with no launcher activity lean towards `core`.
2. Live TV pieces (tuner input service, TV player, channel provider/EPG) go into the preset's `[live_tv]` too.
   Anything touching input switching, the tuner, picture/sound, power, CEC, remote pairing or OTA updates is
   `core`, even if it looks like bloat. When unsure: `core`. A wrong `core` costs a little RAM; a wrong `bloat`
   can break the TV.
3. Vendor packages that show ads, push content or report usage are `bloat`.
4. Prefer exact package names. Use a glob (`com.vendor.platform.*`) only for clearly platform-internal families,
   and remember an exact `bloat` entry beats a `core` glob.
5. Write a short note for each entry: what it is, and what stops working without it.

## Projectors and other non-TV Android devices

Same flow, different landmines. Start a new preset from `presets/_template.toml`.

- **Never touch**: keystone / auto-focus / image correction, fan and lamp/LED control, motor, IR remote and
  "projection mode" services, the vendor settings app, HDMI-in. Classify them `core`.
- **Launcher**: these often run plain Android (AOSP) with a vendor home, not Google TV. Find it with
  `cmd package resolve-activity … HOME` and fill `[launcher].stock`. Check whether the vendor home is also what
  draws the keystone/settings overlay before replacing it.
- **No Play Store** is common: catalog apps with `source = "play"` are blocked; add verified APKs instead.
  Leanback apps (Projectivy, SmartTube) still run on non-TV Android, but test the launcher's Home handling.
- **Remotes** are often IR: `tvctl keys capture` works the same (device `*IR*`), scan codes differ per model.
- **ADB** may already be open on 5555 (sometimes as root). Treat that as a security issue to mention to the
  owner, not as a shortcut.

## Verify on the TV before committing

- Disable one candidate at a time with `./tvctl apply` after adding it, then check: Home button, HDMI input
  switching, voice button, volume/CEC, reboot (`./tvctl status <tv> --reboot`).
- If anything breaks: `./tvctl restore <tv> <pkg>`, move the entry to `core` with a note on what broke.
- Mark presets that have only been seen on one model with a comment (`# Verified on …`).
