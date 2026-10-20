# Prompt: remap remote buttons

Remote Remap (`remote-remap/`, catalog id `remote-remap`) is an accessibility service that opens an app or
sends an intent when a mapped button is pressed and swallows that press. The mapping lives in the profile's
`[keys]` table and is pushed with `./tvctl keys push`.

## Flow

The owner can do all of this themselves in the dashboard (section "remote buttons": LEARN A BUTTON → press it
→ pick the app → SAVE & PUSH). Point them there first; use the CLI flow below when you drive it yourself.

1. Make sure `remote-remap` is in `[apps].install` and `./tvctl apply <tv>` has run (installs it, grants the
   vendor autostart app-op, asks the owner to switch on its accessibility service).
2. Ask which buttons the owner wants changed and what each should open.
3. Capture codes. Start listening **before** asking for presses, and tell the owner to press an arrow key
   first: Bluetooth remotes go to sleep and the first press may only wake them.
   - Run `./tvctl --json keys capture <tv> --seconds 40` in the background.
   - Then tell the owner: "Go: press YOUTUBE, wait two seconds, press NETFLIX, then both again", in the
     dashboard via `./tvctl ask --kind action --title "Go: press YOUTUBE, then NETFLIX" --timeout 40`.
   - Repeated presses of the same scan code confirm the button. Arrow/OK keys are noise.
   - Nothing captured? The owner pressed before or after the window: retry with a clear "ready?" → "go".
4. Map: `./tvctl keys set <tv> <scan> --open <catalog-id|package> --label "<Button>"`, or for an intent:
   `--action <ACTION> --package <pkg>` (e.g. Projectivy's sidebar: `tv.projectivy.SETTINGS`). This edits the
   profile and pushes in one go.
5. Ask the owner to press each mapped button and confirm. Check `adb logcat -s TvRemap` if one does nothing.
6. Add newly learned buttons for this remote model to the brand preset's `[remote_keys]` so the next TV of that
   brand shows labels during capture.

## Finding intent actions

An app's public actions: `adb shell dumpsys package <pkg>` → look for activities with `Action:` lines and
`Category: android.intent.category.DEFAULT`. Only exported ones work.

## Known quirks

- TCL handles YouTube/Netflix keys in the system (`TclPhoneWindowManagerEx` → `com.tcl.partnercustomizer`).
  With Remote Remap active the press is swallowed and the vendor handler did not fire on the G10. If a
  vendor page still pops up on another model, disabling the partner customizer is the next step to test.
- If the accessibility service is enabled but does not react, see prompts/diagnose.md ("service not bound").
