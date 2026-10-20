# Prompt: diagnose a failure

Look before you retry. Read the logs around the failure, find the cause, fix that, then re-run `tvctl apply`.

```bash
adb -s <ip>:5555 logcat -c          # clear, then reproduce the problem
adb -s <ip>:5555 logcat -d | grep -iE '<package>|denied|forbid|fail|exception' | tail -40
```

## Known symptoms

| Symptom | Check | Cause → fix |
|---|---|---|
| `tvctl find` sees nothing | Is the computer on the same network? `ifconfig` | TV behind another router/modem: ADB from the LAN side usually still works if you know the TV's IP (Settings → Network) |
| `connection refused` on 5555 | TV answers ping/8008 | USB debugging is off (Developer options ≠ USB debugging) |
| `unauthorized` | `adb devices` | Owner must accept "Allow USB debugging?" on the TV, tick "Always allow" |
| Home button shows a setup/"recovery" screen | `cmd package resolve-activity … HOME` → `setupwraith/.RecoveryActivity` | Stock launcher disabled without the setup wizard: tvctl disables both together; `tvctl restore <tv> com.google.android.apps.tv.launcherx` to undo |
| `set-home-activity` has no effect | home still resolves to stock | Google TV ignores the preference while the stock launcher is enabled → launcher replacement step |
| Accessibility service on, nothing happens | `logcat | grep TclAppBoot` → `forbid bind service … OP_AUTO_START` | TCL autostart blocker: `appops set <pkg> APP_AUTO_START allow`, then owner toggles the service off/on |
| App update from inside an app fails | `appops get <pkg> REQUEST_INSTALL_PACKAGES` → deny | Owner allows "Install unknown apps" for that app, or install with `tvctl install` |
| `component state` SecurityException | `pm disable <pkg>/<component>` | Shell cannot disable components of system apps; only whole packages (`disable-user`) |
| Key capture empty | `getevent -lt` shows only arrows | Timing: start capture first, then "go"; wake the BT remote with an arrow key |
| Laptop cannot reach GitHub | `curl -m 10 https://api.github.com` | Network/firewall: use the vendored APK in `apks/`, or the app's own updater on the TV |
| Broadcast to Remote Remap returns result=0 | app installed? autostart allowed? | Install/upgrade to Remote Remap ≥ 2.0 and run `tvctl apply` (grants autostart first) |
| `dumpsys` prints "Broken pipe" | — | Harmless: output was cut by `head`/`grep -m` |
| Screenshot is black | `tvctl screenshot` while a video plays | Copy-protected (DRM) video is blanked in screenshots; menus and launchers are captured normally |

## When you find a new one

Add a row here, and if it is brand-specific, a `[quirks]` entry or a comment in the brand preset. If tvctl
could handle it automatically, propose that change.
