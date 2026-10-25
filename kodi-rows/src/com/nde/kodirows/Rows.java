package com.nde.kodirows;

import android.net.Uri;

import java.io.IOException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Reads a row's Kodi folders, drops excluded movies and sorts them. */
final class Rows {
    private static final String[] PROPS = {"title", "year", "premiered", "country", "originaltitle", "art", "plot",
            "runtime", "mpaa", "rating", "genre", "uniqueid"};
    private static final Pattern TAGS = Pattern.compile("\\[/?[A-Z]+[^\\]]*\\]");
    private static final Pattern NEXT = Pattern.compile("(?i)next\\s*page");

    static final class Item {
        String key, file, title, plot, poster, premiered = "", language = "", mpaa = "", imdb = "", genre = "";
        int year, runtime;
        double tmdbRating, imdbRating;
        boolean live, radio;
        String resolver = "direct";
        final Set<String> countries = new HashSet<>();

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("file", file).put("title", title)
                    .put("info", Channels.info(this)).put("plot", plot).put("resolver", resolver);
        }
    }

    private Rows() {}

    /** Live rows are profile data, so refreshing them never needs a running Kodi or an add-on. */
    static List<Item> live(Config.Row row) {
        List<Item> items = new ArrayList<>();
        for (Config.LiveChannel channel : row.channels) {
            Item it = new Item();
            it.key = hash("live:" + row.id + ":" + channel.id);
            it.live = true;
            it.radio = row.radio;
            it.file = channel.url;
            it.resolver = channel.resolver;
            it.title = channel.name;
            it.plot = channel.description;
            it.poster = imageUrl(channel.logo);
            items.add(it);
        }
        return items;
    }

    static List<Item> fetch(Kodi kodi, Config.Row row) throws IOException {
        List<Item> items = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String start : row.paths) {
            String path = start;
            for (int page = 0; page < row.pages && path != null; page++) {
                JSONArray files = list(kodi, path);
                path = null;
                for (int i = 0; files != null && i < files.length(); i++) {
                    JSONObject f = files.optJSONObject(i);
                    if (f == null) continue;
                    String label = TAGS.matcher(f.optString("label")).replaceAll("");
                    if ("directory".equals(f.optString("filetype"))) {
                        if (path == null && NEXT.matcher(label).find()) path = f.optString("file");
                        continue;
                    }
                    Item it = item(f, label);
                    if (it.file.isEmpty() || !seen.add(it.key) || excluded(it, row)) continue;
                    items.add(it);
                }
            }
        }
        if ("year".equals(row.sort)) {  // newest first; stable, so the add-on's order breaks ties
            Collections.sort(items, (a, b) -> a.year != b.year ? b.year - a.year : b.premiered.compareTo(a.premiered));
        }
        return new ArrayList<>(items.subList(0, Math.min(row.max, items.size())));
    }

    private static JSONArray list(Kodi kodi, String path) throws IOException {
        try {
            JSONObject params = new JSONObject().put("directory", path).put("media", "video")
                    .put("properties", new JSONArray(PROPS));
            Object res = kodi.call("Files.GetDirectory", params);
            return res instanceof JSONObject ? ((JSONObject) res).optJSONArray("files") : null;
        } catch (JSONException e) {
            throw new IOException(e.getMessage());
        }
    }

    static Item item(JSONObject f, String label) {
        Item it = new Item();
        it.file = f.optString("file");
        it.title = f.optString("title", label);
        if (it.title.isEmpty()) it.title = label;
        it.year = f.optInt("year");
        it.premiered = f.optString("premiered");
        it.plot = f.optString("plot");
        it.runtime = f.optInt("runtime");
        it.mpaa = certification(f.optString("mpaa"));
        it.tmdbRating = f.optDouble("rating", 0);
        JSONArray genre = f.optJSONArray("genre");
        if (genre != null && genre.length() > 0) it.genre = genre.optString(0);
        JSONObject ids = f.optJSONObject("uniqueid");
        if (ids != null) it.imdb = ids.optString("imdb");
        JSONArray country = f.optJSONArray("country");
        for (int i = 0; country != null && i < country.length(); i++) it.countries.add(country.optString(i).toLowerCase(Locale.ROOT));
        JSONObject art = f.optJSONObject("art");
        if (art != null) it.poster = imageUrl(art.optString("poster", art.optString("thumb")));
        // Add-ons like Umbrella pack TMDb metadata into the play link; Kodi leaves country empty for them.
        String key = it.file;
        try {
            String meta = Uri.parse(it.file).getQueryParameter("meta");
            if (meta != null) {
                JSONObject m = new JSONObject(meta);
                it.language = m.optString("original_language").toLowerCase(Locale.ROOT);
                JSONArray codes = m.optJSONArray("country_codes");
                for (int i = 0; codes != null && i < codes.length(); i++) it.countries.add(codes.optString(i).toLowerCase(Locale.ROOT));
                if (it.premiered.isEmpty()) it.premiered = m.optString("premiered");
                if (it.year == 0) it.year = m.optInt("year");
                if (it.imdb.isEmpty()) it.imdb = m.optString("imdb");
                if (it.mpaa.isEmpty()) it.mpaa = certification(m.optString("mpaa"));
                if (!m.optString("tmdb").isEmpty()) key = "tmdb:" + m.optString("tmdb");
            }
        } catch (JSONException | UnsupportedOperationException e) {
            // no usable metadata: keep what Kodi gave
        }
        if (it.year == 0 && it.premiered.length() >= 4) {
            try { it.year = Integer.parseInt(it.premiered.substring(0, 4)); } catch (NumberFormatException ignored) { }
        }
        it.key = hash(key);
        return it;
    }

    static boolean excluded(Item it, Config.Row row) {
        for (String c : it.countries) if (row.excludeCountries.contains(c)) return true;
        if (!it.mpaa.isEmpty() && row.excludeRatings.contains(it.mpaa.toLowerCase(Locale.ROOT))) return true;
        return !it.language.isEmpty() && row.excludeLanguages.contains(it.language);
    }

    /** "Rated R", "US:R", "r" -> "R". */
    static String certification(String s) {
        s = s.trim();
        if (s.regionMatches(true, 0, "Rated ", 0, 6)) s = s.substring(6);
        int colon = s.lastIndexOf(':');
        if (colon >= 0) s = s.substring(colon + 1);
        return s.trim().toUpperCase(Locale.ROOT);
    }

    /** Kodi wraps art as image://<url-encoded url>/; the home screen needs the plain https URL. */
    static String imageUrl(String art) {
        if (art == null || art.isEmpty()) return null;
        String s = art;
        if (s.startsWith("image://")) {
            s = s.substring(8);
            if (s.endsWith("/")) s = s.substring(0, s.length() - 1);
            s = Uri.decode(s);
        }
        return s.startsWith("https://") || s.startsWith("http://") ? s : null;
    }

    private static String hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
