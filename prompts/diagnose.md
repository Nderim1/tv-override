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
| Scan finds no TV, but the TV is "connected" | `./tvctl find --all`: is the TV's IP in the device list at all? | Not listed: TV off or in standby (network off; TCL: enable Network standby), or on another network. Listed as unknown: debugging off. Listed with wireless debugging: pair first (`tvctl pair IP:PORT CODE`) |
| TV found but "not Android" / "no ADB" | `./tvctl find` kind, `tvctl init` result | Vestel/Roku/LG/Samsung OS: no developer mode exists. Add it as a limited profile (DIAL, guide) and suggest an Android TV stick on HDMI |
| Known TV unreachable after a router/modem restart | `./tvctl find` shows it with "moved from" | DHCP gave it a new IP: `./tvctl find --update` (dashboard: UPDATE ADDRESS) |
| An app or the internet broke after the DNS filter | `./tvctl status <tv>` (dns), `tvctl revert` of that run | Set `[home].dns = "off"` and run `tweaks`, or revert the run; a stricter filter (controld-ads) breaks more – go back to `hagezi-light` |
| Samsung: keys / launching refused | `state/<tv>/samsung-token` exists? | `tvctl pair <tv>` and choose Allow; if Deny was chosen once: TV Settings › General › External Device Manager › Device Connection Manager › Device List |
| Samsung: setup cannot connect to SDB although Developer Mode and Host PC IP are correct | Check the TV API on 8001, TCP 26101, and `sdb version` / `sdb devices` | If 8001 works but 26101 refuses connections, the saved Developer Mode change may still need a full restart. Owner holds Power until the Samsung logo returns (standby is insufficient), then verify 26101 before retrying setup. Confirmed on GU65TU6979UXZG / Tizen 5.5. |
| TizenTubeOld opens but videos show YouTube's generic playback error | Confirm Tizen 3/4/5/5.5, the older build, and Developer Mode Host PC IP | Upstream documents a matching failure: after installation, owner changes Host PC IP to `127.0.0.1` and fully restarts, then tests playback. Confirmed on GU65TU6979UXZG / Tizen 5.5 / TizenTubeOld 2.1.1: owner reported all videos failing before and a successful two-minute test afterward. Restore the computer's IP temporarily for future installs; this is a playback setting, not the installation host. Source: https://github.com/reisxd/TizenTube/blob/main/docs/README.md and issues/555. |
| Android 11+ TV not on port 5555 | `adb mdns services` lists `_adb-tls-connect` | Wireless debugging uses a random port and a pairing code: `tvctl pair`, then init with that port |
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
