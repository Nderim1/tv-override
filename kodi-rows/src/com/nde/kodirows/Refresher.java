package com.nde.kodirows;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.IOException;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Publishes profile live channels first, then refreshes movie folders through Kodi. When Kodi is closed or
 * playing, movie rows keep their last cards while live rows still update.
 */
final class Refresher {
    private Refresher() {}

    static synchronized void run(Context context) {
        Config cfg = Config.load(context);
        SharedPreferences prefs = Config.prefs(context);
        JSONObject status = new JSONObject();
        try {
            status.put("time", System.currentTimeMillis() / 1000);
            Channels.removeStale(context, cfg);
            PosterProvider.grant(context);
            if (cfg.rows.isEmpty()) {
                status.put("ok", true).put("error", "no rows configured").put("rows", new JSONArray());
            } else {
                status.put("rows", refreshRows(context, cfg, prefs, status));
            }
        } catch (JSONException e) {
            Log.w(Channels.TAG, "status: " + e);
        }
        prefs.edit().putString("status", status.toString()).commit();
    }

    private static JSONArray refreshRows(Context context, Config cfg, SharedPreferences prefs, JSONObject status)
            throws JSONException {
        JSONArray rows = new JSONArray();
        JSONArray previousRows = previousRows(prefs);
        String error = null;
        Map<Long, Boolean> browsable = null;
        Kodi kodi = null;
        boolean checkedKodi = false;
        String kodiError = null;
        try {
            // Publish live rows first: a slow, closed or playing Kodi must never block the live TV row.
            java.util.ArrayList<Config.Row> ordered = new java.util.ArrayList<>();
            for (Config.Row row : cfg.rows) if (row.live) ordered.add(row);
            for (Config.Row row : cfg.rows) if (!row.live) ordered.add(row);
            for (Config.Row row : ordered) {
                JSONObject r = new JSONObject().put("id", row.id).put("name", row.name);
                try {
                    if (!row.live && !checkedKodi) {
                        checkedKodi = true;
                        if (!Kodi.ping(cfg.port)) {
                            kodiError = "Kodi is not running; kept cached movies";
                        } else {
                            try {
                                kodi = new Kodi(cfg.port, 120_000);
                                Object players = kodi.call("Player.GetActivePlayers", null);
                                if (players instanceof JSONArray && ((JSONArray) players).length() > 0) {
                                    kodiError = "Kodi is playing; kept cached movies";
                                }
                            } catch (IOException e) {
                                kodiError = e.getMessage();
                            }
                        }
                    }
                    if (!row.live && kodiError != null) throw new IOException(kodiError);
                    List<Rows.Item> items = row.live ? Rows.live(row) : Rows.fetch(kodi, row);
                    if (!row.live) Imdb.apply(context, items);
                    long channel = Channels.sync(context, row, items);
                    JSONObject cache = new JSONObject();
                    JSONArray titles = new JSONArray();
                    for (Rows.Item it : items) {
                        cache.put(it.key, it.toJson());
                        if (titles.length() < 5) titles.put(it.title + (it.year > 0 ? " (" + it.year + ")" : "")
                                + (it.imdbRating > 0 ? " IMDb " + it.imdbRating : "") + (it.mpaa.isEmpty() ? "" : " " + it.mpaa));
                    }
                    prefs.edit().putString("items." + row.id, cache.toString()).commit();
                    if (browsable == null) browsable = Channels.browsable(context);
                    r.put("count", items.size()).put("channel", channel)
                            .put("browsable", Boolean.TRUE.equals(browsable.get(channel))).put("first", titles)
                            .put("poster", items.isEmpty() ? null : items.get(0).poster);
                    if (row.live) r.put("type", row.radio ? "radio" : "live");
                } catch (IOException | RuntimeException e) {
                    Log.w(Channels.TAG, "row " + row.id + ": " + e);
                    error = row.id + ": " + e.getMessage();
                    for (int i = 0; i < previousRows.length(); i++) {
                        JSONObject previous = previousRows.optJSONObject(i);
                        if (previous != null && row.id.equals(previous.optString("id"))) {
                            r = new JSONObject(previous.toString());
                            break;
                        }
                    }
                    r.put("error", e.getMessage());
                }
                rows.put(r);
            }
        } finally {
            if (kodi != null) {
                try { kodi.close(); } catch (IOException e) { Log.w(Channels.TAG, "close Kodi: " + e); }
            }
        }
        PosterProvider.prune(context, cachedKeys(prefs));
        status.put("ok", error == null);
        if (error != null) status.put("error", error);
        return rows;
    }

    private static Set<String> cachedKeys(SharedPreferences prefs) {
        Set<String> keys = new HashSet<>();
        for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
            if (!e.getKey().startsWith("items.")) continue;
            try {
                for (Iterator<String> it = new JSONObject(String.valueOf(e.getValue())).keys(); it.hasNext(); ) keys.add(it.next());
            } catch (JSONException ignored) {
                // a broken cache only loses that row's posters
            }
        }
        return keys;
    }

    private static JSONArray previousRows(SharedPreferences prefs) {
        try {
            JSONArray rows = new JSONObject(prefs.getString("status", "{}")).optJSONArray("rows");
            return rows != null ? rows : new JSONArray();
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** The play link for a poster key, from the last refresh. */
    static JSONObject itemFor(Context context, String key) {
        for (Map.Entry<String, ?> e : Config.prefs(context).getAll().entrySet()) {
            if (!e.getKey().startsWith("items.")) continue;
            try {
                JSONObject it = new JSONObject(String.valueOf(e.getValue())).optJSONObject(key);
                if (it != null) return it;
            } catch (JSONException ignored) {
                // a broken cache only loses that row
            }
        }
        return null;
    }
}
