package com.nde.kodirows;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Movie, live TV and radio rows from tvctl ([[kodi.rows]] in the profile), stored as the JSON tvctl sent:
 * {"port":9090,"refresh_minutes":60,"rows":[{"id":"new-movies","name":"New movies","paths":["plugin://…"],
 *  "pages":3,"max":40,"sort":"year","exclude_countries":["IN"],"exclude_languages":["hi","ta"],"exclude_ratings":["R","NC-17"]}]}
 * Live rows use type:"live" or "radio" and channels:[{id,name,url,logo,description}] instead of paths.
 */
final class Config {
    static final String PREFS = "kodirows";
    private static final String KEY = "config";

    static final class Row {
        String id, name, sort;
        boolean live, radio;
        List<LiveChannel> channels = new ArrayList<>();
        List<String> paths = new ArrayList<>();
        int pages, max;
        Set<String> excludeCountries = new HashSet<>(), excludeLanguages = new HashSet<>(), excludeRatings = new HashSet<>();
    }

    static final class LiveChannel {
        String id, name, url, logo, description, resolver;
    }

    int port = 9090;
    int refreshMinutes = 60;
    final List<Row> rows = new ArrayList<>();

    static Config load(Context context) {
        try {
            return parse(raw(context));
        } catch (IllegalArgumentException e) {
            return new Config();
        }
    }

    static String raw(Context context) {
        return prefs(context).getString(KEY, "");
    }

    /** Validates and stores; throws IllegalArgumentException on bad input. */
    static Config save(Context context, String raw) {
        Config cfg = parse(raw);
        prefs(context).edit().putString(KEY, raw).commit();
        return cfg;
    }

    static Config parse(String raw) {
        Config cfg = new Config();
        if (raw == null || raw.isEmpty()) return cfg;
        try {
            JSONObject o = new JSONObject(raw);
            cfg.port = o.optInt("port", 9090);
            cfg.refreshMinutes = Math.max(15, o.optInt("refresh_minutes", 60));
            JSONArray rows = o.optJSONArray("rows");
            Set<String> ids = new HashSet<>();
            for (int i = 0; rows != null && i < rows.length(); i++) {
                JSONObject r = rows.getJSONObject(i);
                Row row = new Row();
                row.id = r.getString("id");
                row.name = r.getString("name");
                if (!row.id.matches("[a-z0-9-]{1,40}") || !ids.add(row.id)) throw new IllegalArgumentException("bad or duplicate row id: " + row.id);
                if (row.name.trim().isEmpty()) throw new IllegalArgumentException("row " + row.id + " has no name");
                String type = r.optString("type", "movies");
                if (!type.equals("movies") && !type.equals("live") && !type.equals("radio")) {
                    throw new IllegalArgumentException("type is movies, live or radio");
                }
                row.radio = type.equals("radio");
                row.live = type.equals("live") || row.radio;
                if (row.live) {
                    JSONArray channels = r.getJSONArray("channels");
                    Set<String> channelIds = new HashSet<>();
                    for (int c = 0; c < channels.length(); c++) {
                        JSONObject ch = channels.getJSONObject(c);
                        LiveChannel channel = new LiveChannel();
                        channel.id = ch.getString("id");
                        channel.name = ch.getString("name");
                        channel.url = ch.getString("url");
                        channel.resolver = ch.optString("resolver", "direct");
                        channel.logo = ch.optString("logo");
                        channel.description = ch.optString("description", row.radio ? "Radio from Kosovo" : "Live TV from Kosovo");
                        if (!channel.id.matches("[a-z0-9-]{1,60}") || !channelIds.add(channel.id)
                                || channel.name.trim().isEmpty() || !channel.url.matches("https?://.+")
                                || !(channel.resolver.equals("direct") || channel.resolver.equals("gjirafa") || channel.resolver.equals("klan"))) {
                            throw new IllegalArgumentException("bad or duplicate live channel: " + channel.id);
                        }
                        row.channels.add(channel);
                    }
                    if (row.channels.isEmpty()) throw new IllegalArgumentException("live row has no channels");
                    cfg.rows.add(row);
                    continue;
                }
                JSONArray paths = r.getJSONArray("paths");
                for (int p = 0; p < paths.length(); p++) row.paths.add(paths.getString(p));
                if (row.paths.isEmpty()) throw new IllegalArgumentException("row " + row.id + " has no paths");
                row.pages = Math.max(1, Math.min(10, r.optInt("pages", 1)));
                row.max = Math.max(1, Math.min(100, r.optInt("max", 40)));
                row.sort = r.optString("sort", "year");
                if (!row.sort.equals("year") && !row.sort.equals("none")) throw new IllegalArgumentException("sort is year or none");
                lower(r.optJSONArray("exclude_countries"), row.excludeCountries);
                lower(r.optJSONArray("exclude_languages"), row.excludeLanguages);
                lower(r.optJSONArray("exclude_ratings"), row.excludeRatings);
                cfg.rows.add(row);
            }
        } catch (JSONException e) {
            throw new IllegalArgumentException(e.getMessage());
        }
        return cfg;
    }

    private static void lower(JSONArray a, Set<String> into) throws JSONException {
        for (int i = 0; a != null && i < a.length(); i++) into.add(a.getString(i).toLowerCase(Locale.ROOT));
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
