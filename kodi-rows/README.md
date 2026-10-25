# Kodi Rows

Android TV preview channels for Projectivy: movie rows from Kodi add-ons and live TV/radio rows from a profile's
public HTTP(S) streams. Selecting a card starts Kodi and plays it. Build with `bash kodi-rows/build.sh`;
update the catalog app with `./tvctl install <tv> kodi-rows --force`, then `./tvctl kodi push <tv>`.

Movie rows keep their existing `paths`, sorting and filtering settings. Live TV and radio rows use stable channel IDs
and keep their configured order:

```toml
[[kodi.rows]]
id = "kosovo-live"
name = "Kosovo TV"
type = "live"

[[kodi.rows.channels]]
id = "rtk1-sat"
name = "RTK 1 Sat"
resolver = "gjirafa"
url = "https://edge.video.gjirafa.com/client/v1/videos/y46nXNokwa"
logo = "https://g0eylj1rzj.gjirafa.net/storage/images/channel/desktop/rtklive.jpg"
source = "https://video.gjirafa.com/rtk-1-sat"
description = "RTK 1 satellite feed · Kosovo public broadcaster · Live"
```

`source` records where the stream was found. `resolver` defaults to `direct` (a stable HLS URL).
`gjirafa` fetches the current HLS URL from the public player API on every click and respects its region and
subscription flags. `klan` uses `https://klankosova.tv/api/stream/token` and a loopback HLS relay that renews
the signature every 240 seconds, including nested playlists and segments. Each click starts a fresh session.
The relay runs as a foreground service while Kodi plays and stops after five minutes without requests;
switching to another channel closes it. Signed stream URLs are never written into the profile.

Use an image URL for `logo` (PNG/JPEG,
not SVG). Logos are cached and centered on dark 16:9 cards. Live rows publish before Kodi folders are read,
even when Kodi is closed or playing; movie rows keep their cached cards when Kodi cannot refresh them.
`tvctl kodi status <tv>` reports each row's count and errors. `tvctl kodi play <tv> <row-id> <channel-id>`
opens a configured live card for playback checks.

For a radio row use `type = "radio"` with the same `[[kodi.rows.channels]]` structure. Station cards use
Android TV's station type and show `RADIO · Kosovo` in the description. Direct URLs can be MP3/AAC streams
or HLS; Gjirafa stations resolve their current HLS URL on each click, as TV stations do. Kodi handles the
audio playback; the home row refreshes even while Kodi is closed or playing.

Ready-made live and radio rows live in channel packs, `channels/<id>.toml` (`name`, `note`, then `[[rows]]` and
`[[rows.channels]]` in the same format). A profile adds one with `[kodi] packs = ["kosovo"]`; its rows follow the
profile's own rows, and a profile row with the same id wins. `tvctl install <tv> kosovo` does the same in one go.

Enable a new row once in Projectivy: Settings → Edit channels → Kodi Rows → <row> → Visible.
On the home screen, LEFT from its first card reaches the row header. Move left to the up/down reorder
icon (past the gear), then OK starts reordering, UP/DOWN moves the row, and OK saves.
The Android TV `browsable` flag can remain false even when Projectivy's own Visible setting is on.
Projectivy keeps its own Title override, so changing the provider's row name may leave an old displayed
title. In that case edit Title in Projectivy. Activate the input field first; `tvctl type <tv> "Title"
--replace` can enter an ASCII title. Commit using the keyboard's own Enter/Done button; TCL's keyboard
can consume an injected Enter as a keyboard-selection event. Back cancels this editor.

## Kosovo sources checked 2026-10-25

The living-room profile contains thirteen public streams whose HLS playlists and video segments were
reachable from this connection: RTK 1 Sat, RTK 3, KTV, RTV 21, ATV, Arta News, Syri Vision, TV Opoja,
RTV Besa, ZICO TV, Zëri TV, TV Prizreni and Klan Kosova. This is the verified public subset, not every licensed Kosovo TV station.
Each channel's source page is recorded in the profile. Availability can change.

- Gjirafa's public player metadata: `https://edge.video.gjirafa.com/client/v1/videos/{id}`; inspect
  `geoBlockConfig.isGeoBlocked`, `payToViewConfig.isLocked`, `playerConfig.playbackUrls[].file` and
  `channel.image`. The [Live TV page](https://video.gjirafa.com/drejteperdrejt) uses
  `https://edge.video.gjirafa.com/client/v1/videos/live?livestreamCategory=2&status=12&pageSize=12&page=1`.
  Increment `page` until `totalCount` entries have been read. Requests with `pageSize=100` are silently
  capped at 15, which missed TV Prizreni. A browser User-Agent may be needed. Its current 16-channel list
  includes three foreign stations and two region-blocked domestic feeds, leaving eleven available Kosovo
  stations; Opoja and Klan come from their own official players.
- [ATV's official player](https://atvlive.tv/stream) declares the same Gjirafa HLS stream in its web app.
- [RTV 21](https://rtv21.tv/) provides its own player and logo.
- [TV Opoja's official player](https://opoja.tv/tv-live/) embeds the HTTPS Streamlock URL in the profile.
- [ZICO's official site](https://zico.tv/) embeds Gjirafa's `zico-tv-live` player.
- [TV Prizreni](https://tvprizreni.net/live) embeds `tv-prizreni-live` on Gjirafa.
- [Klan Kosova](https://klankosova.tv/tv) uses its official `/api/stream/token`. The token expires after
  300 seconds; both its own player and our relay renew every 240 seconds.
- [Zëri's own TV article](https://zeri.info/sport/311058/shikon-ndeshjen-live-arberia-ndash-prishtina-ne-zeri-tv/)
  and the [Kosovo regulator's strategy, appendix 4](https://www.kpm-ks.org/assets/cms/uploads/files/Strategjia%20p%C3%ABr%20kalim%20n%C3%AB%20transmetim%20digjital%20tok%C3%ABsor_%20dhjetor%202019.pdf)
  confirm Zëri TV and ZICO TV as Kosovo channels.
- [British Council Kosovo](https://kosovo.britishcouncil.org/programmes/society/media/news/media-outlets-diversify-attract-new-audiences-home-and-abroad)
  identifies RTV Besa in Prizren.

Excluded at this check:

- RTK 1's domestic feed, RTK 2 and RTK 4: Gjirafa reports a region restriction from this connection.
  RTK 1 Sat is the available international feed.
- T7: official player metadata exists, but the stream returned HTTP 404.
- [Dukagjini](https://www.dukagjini.com/tv/), rechecked 2026-10-25: the page's actual player `data-url`
  points to [its official YouTube channel's live endpoint](https://www.youtube.com/channel/UCL3nrPOUK0MCcm5nFk800xQ/live).
  It currently shows past broadcasts, with no active continuous live feed. Its stale JSON-LD still names
  the `rtv-dukagjini-live` Gjirafa embed, which returns 404. Gjirafa channel `MbN6LnmkGg` has only Radio
  Dukagjini in its live list. A radio feed or a recorded program must not be labelled as the live TV station.
- Dielli: playlists responded but video segments returned 404. Arberia's listed streams failed TLS
  hostname verification. TV News is based in North Macedonia and was excluded by country.
- Kanal10: its official player's proxy hostname failed DNS; its direct upstream returned 404.
  RTI/Iliria's official upstream was unreachable. No working full-channel public player was verified for
  Teve1, TV Mitrovica or First Channel.

## Kosovo radio checked 2026-10-25

`Kosovo Radios` is a separate `type = "radio"` row. Its first ten stations come from Gjirafa's
[Radio Live catalog](https://edge.video.gjirafa.com/client/v1/videos/live?livestreamCategory=3&status=12&pageSize=12&page=1):
Radio Dukagjini, Radio Kosova 1 and 2, Club FM Kosova, Glam Radio, Glam Radio Café, Glam Radio Gold,
Paper Radio, Radio K4 Shqip and Radio K4 Srpski. All ten HLS feeds contained AAC audio in fetched media
segments. They also carry a visual station presentation, which Kodi can display while the radio plays.
The catalog's ClubFM Albania and Top Albania Radio entries are outside Kosovo and were excluded.

The profile records each station's source, image and public player metadata URL. Stream links are fetched
fresh on selection. [Dukagjini's owner](https://dukagjinigroup.com/kompanite/radio-tv-dukagjini),
[Glam Radio](https://glamradio.fm/), [Club FM](https://clubfm.al/) and [KFOR Radio](https://radiokfor.com/1/)
provide origin/service context. K4's Albanian and Serbian services both operate from Kosovo.
The eleventh station, [Radio Plus](http://radioplus.fm/online.php), uses its official player's direct MP3
stream. Audio bytes and `audio/mpeg` were checked; its PNG logo comes from Shkabaj's radio image catalog.

## Checks

```sh
python3 -m unittest discover -s tests -v
mkdir -p /tmp/tv-override-hls-tests
javac -d /tmp/tv-override-hls-tests kodi-rows/src/com/nde/kodirows/HlsProxy.java tests/HlsProxyTest.java
java -cp /tmp/tv-override-hls-tests com.nde.kodirows.HlsProxyTest
bash kodi-rows/build.sh
```

The relay check uses a local HTTP origin and simulates an expired signature during the same playback
session; it covers master/media playlists, relative segment links, KEY/MAP attributes, Range and HEAD.

The living-room homepage keeps only Favourites, Kodi Movies, Kosovo TV and Kosovo Radios, in that order.
The other Projectivy categories and channels are hidden in its menus; installed apps and TV inputs remain available.
