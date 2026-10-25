package com.nde.kodirows;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Resolves the broadcaster's current public player metadata when a channel is selected. */
final class LiveStreams {
    private LiveStreams() {}

    static String resolve(String url, String resolver) throws IOException {
        if (resolver.equals("direct")) return url;
        if (!resolver.equals("gjirafa")) throw new IOException("Unknown live stream resolver");
        JSONObject data = json(url);
        JSONObject geo = data.optJSONObject("geoBlockConfig"), pay = data.optJSONObject("payToViewConfig");
        if (geo != null && geo.optBoolean("isGeoBlocked")) throw new IOException("Channel is unavailable in your region");
        if (pay != null && pay.optBoolean("isLocked")) throw new IOException("Channel requires a subscription");
        JSONObject config = data.optJSONObject("playerConfig");
        JSONArray streams = config == null ? null : config.optJSONArray("playbackUrls");
        for (int i = 0; streams != null && i < streams.length(); i++) {
            JSONObject stream = streams.optJSONObject(i);
            String file = stream == null ? "" : stream.optString("file");
            if (file.matches("https?://.+") && file.contains(".m3u8")) return file;
        }
        throw new IOException("Channel currently has no live HLS stream");
    }

    static JSONObject json(String url) throws IOException {
        try { return new JSONObject(text(url, 2_000_000)); }
        catch (JSONException e) { throw new IOException("Invalid live player metadata", e); }
    }

    private static String text(String url, int limit) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setRequestProperty("User-Agent", "Mozilla/5.0");
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("Accept-Encoding", "identity");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Live source returned HTTP " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream()) { return new String(HlsProxy.read(in, limit), StandardCharsets.UTF_8); }
        } finally { connection.disconnect(); }
    }

    /** Klan signs every manifest and segment. Renew at four minutes, before its five-minute expiry. */
    static final class Klan implements HlsProxy.Source {
        private static final Pattern TOKEN = Pattern.compile("(?:^|&)t=([^&]+)");
        private static final Pattern PATH_SIGNATURE = Pattern.compile("spntl=[^/\\s]+(?=/)");
        private final String endpoint;
        private String master, token, signature;
        private long renewed;

        Klan(String endpoint) { this.endpoint = endpoint; }

        @Override public synchronized String resolve(String url, boolean force) throws IOException {
            if (master == null || force || System.currentTimeMillis() - renewed >= 240_000) {
                String next = json(endpoint).optString("url");
                URL parsed = new URL(next);
                if (!parsed.getProtocol().equals("https") || !parsed.getHost().equals("stream.klankosova.tv")) {
                    throw new IOException("Invalid Klan player stream URL");
                }
                Matcher query = TOKEN.matcher(parsed.getQuery() == null ? "" : parsed.getQuery());
                if (!query.find()) throw new IOException("Klan player did not supply a stream token");
                String nextToken = query.group(1);
                // Refresh the nested path signature too; old Kodi resource URLs are mapped to this new path.
                String playlist = text(next, 1_000_000);
                Matcher path = PATH_SIGNATURE.matcher(playlist);
                String nextSignature = path.find() ? path.group() : null;
                master = next;
                token = nextToken;
                signature = nextSignature;
                renewed = System.currentTimeMillis();
                android.util.Log.i(Channels.TAG, "Klan stream token renewed");
            }
            if (url == null) return master;
            URL parsed = new URL(url);
            if (!parsed.getHost().equals(new URL(master).getHost())) return url;
            String resource = url;
            if (signature != null) resource = PATH_SIGNATURE.matcher(resource).replaceAll(Matcher.quoteReplacement(signature));
            if (resource.matches(".*[?&]t=[^&]*.*")) return resource.replaceAll("([?&]t=)[^&]*", "$1" + Matcher.quoteReplacement(token));
            return resource + (resource.contains("?") ? "&" : "?") + "t=" + token;
        }
    }
}
