/* Apps the dock knows. Each is found on the TV by its Tizen app id (exact), then by a name pattern over the
   installed apps (lower case, "+" read as " plus"). Ids come from Samsung TVs in the field; list a TV's own
   with `sdb shell 0 vd_applist` in Developer Mode and add them here. Unknown keys in a profile are ignored. */
window.OVERRIDE_APPS = {
  tizentube: { label: 'TizenTube', ids: ['xvvl3S1TT1.TizenTubeStandalone'], names: ['^tizentube'] },
  youtube: { label: 'YouTube', ids: ['9Ur5IzDKqV.TizenYouTube', 'com.samsung.tv.cobalt-yt'], names: ['^youtube$'] },
  netflix: { label: 'Netflix', ids: ['org.tizen.netflix-app'], names: ['^netflix$', '\\bnetflix\\b'] },
  prime: { label: 'Prime Video', ids: ['org.tizen.primevideo', 'org.tizen.ignition'], names: ['prime video'] },
  disney: { label: 'Disney+', ids: ['MCmYXNxgcu.DisneyPlus'], names: ['^disney plus', '^disney$'] },
  tvplus: { label: 'Samsung TV Plus', ids: ['com.samsung.tv.tvPlusDeeplinker', 'com.samsung.tv.tvplus'], names: ['tv plus'] },
  appletv: { label: 'Apple TV', ids: [], names: ['^apple tv$'] },
  spotify: { label: 'Spotify', ids: [], names: ['^spotify'] },
  plex: { label: 'Plex', ids: [], names: ['^plex$'] },
  livetv: { label: 'Live TV', ids: [], names: ['^tv$', '^live tv$', '^tv viewer$'] },
  browser: { label: 'Internet', ids: ['org.tizen.browser'], names: ['^internet$', '^browser$'] }
};
