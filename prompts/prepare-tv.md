# Prompt: research a TV and write its preparation guide

Triggered by the dashboard's "◆ RESEARCH THIS MODEL" button (inbox topic `prepare`) or right after `tvctl init`.
The owner then walks through your guide step by step in the dashboard ([P] prepare this TV), with the live
screen on. Your job: turn generic steps into exact, model-specific ones.

## TVs without ADB

For `platform` other than `adb` there is no ADB: no checks or "auto" steps, the owner does every step with the
remote and ticks it off. The dossier has the UPnP / DIAL facts instead of Android properties. Research the
vendor OS menus (Vestel OS, webOS, Tizen, Roku) for privacy/ACR, HbbTV tracking, network standby and CEC.

## Inputs

- `state/<tv>/dossier.json`: everything read from the TV (brand, model, product name, Android, firmware,
  security patch, SoC, RAM, storage, Play Store / accounts, tuner + channels, inputs, remotes, settings, presets).
- `state/<tv>/guide.json`: the current guide (built-in steps from the presets' `[[prepare]]` tables, with the
  owner's progress).
- `./tvctl screenshot <tv>`: look at the real menus when a path is uncertain (ask the owner to open Settings
  first if needed).

## Research

Delegate: send `tv-research` one question per topic (system update, channel scan, motion smoothing, CEC,
network standby, tracking opt-outs, anything model-specific), in parallel and in the background, then merge
the answers into one guide yourself. Use `tv-screen` to confirm menu names on the real TV.

1. Identify the exact model and platform: product name (e.g. `G10_4K_GB`), marketing name, Google TV vs Android
   TV vs plain Android, firmware generation.
2. Sources, in this order: the vendor's support page / e-manual for this model, the vendor's official forum,
   then reputable reviews (rtings.com, flatpanelshd) for picture settings. Avoid content farms. Note the URL of
   each fact you use.
3. For each step find the **exact menu path on this model** and anything model-specific: where channel scan
   lives and whether it can skip scrambled/pay channels, the name of motion smoothing (MEMC, Motion clarity,
   TruMotion…), network standby / Wake-on-LAN, HDMI-CEC name (T-Link, Anynet+, Bravia Sync…), known firmware
   issues, settings that re-enable ads or tracking after updates, ACR/"viewing information" opt-outs.
4. Add steps the built-in guide lacks when they matter for this model (e.g. vendor ACR consent, vendor account
   prompts, "instant on"), and drop steps that don't exist on it.

## Guide format (`./tvctl guide set <tv> guide.json`)

```json
{
  "source": "agent",
  "summary": "TCL C645 (Google TV 12): channel scan lives in the TV app; MEMC is called Motion Clarity.",
  "steps": [
    {
      "id": "channel-scan",
      "title": "Scan antenna channels (free only)",
      "why": "Only if you watch antenna TV. 'Free channels only' keeps pay channels out.",
      "path": ["TV app", "Settings", "Channel", "Channel scan", "Antenna"],
      "how": "Set Scan mode to 'Free'. Press Start, wait ~5 minutes.",
      "check": {"type": "channels", "min": 1},
      "required": false,
      "source": "https://support.tcl.com/…"
    }
  ]
}
```

- `id`: lowercase slug, unique. Keep the built-in ids (`update`, `account`, `privacy`, `cec`, `channel-scan`,
  `motion`, `network-standby`) for the same topics so the owner's progress is kept.
- `check` (optional, verified over ADB): `{"type":"adb"}`, `{"type":"accounts","min":1}`,
  `{"type":"channels","min":1}`, `{"type":"setting","ns":"global","key":"…","equals":"1"}`,
  `{"type":"package","pkg":"…","enabled":true}`, `{"type":"a11y","component":"pkg/cls"}`.
- `auto` (optional, "let the app do it"): only `{"ns","key","value"}` for HDMI-CEC and sleep/screen timeouts
  (tvctl refuses anything else). Never automate sign-ins, security or purchases.
- Keep `how` to 1–3 sentences the owner can follow with the remote. Put the reason in `why`.
- Order: system update → account → privacy → model specifics → picture/sound → channels.

## Finish

`./tvctl guide set <tv> guide.json`, then reply to the inbox request (`./tvctl inbox --reply <id> "…" --done`)
with a two-line summary of what is model-specific, and add durable facts (menu names, quirks) to the brand
preset's `[[prepare]]` steps so the next TV of this brand starts with them.
