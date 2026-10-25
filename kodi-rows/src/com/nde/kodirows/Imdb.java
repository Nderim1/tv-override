package com.nde.kodirows;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * IMDb ratings (1-10) from IMDb's own daily dataset (title.ratings.tsv.gz, ~9 MB, free for personal use).
 * Add-ons like Umbrella only carry TMDb's rating. The file is downloaded at most once a day and kept in the
 * cache; a failed download keeps the previous one.
 */
final class Imdb {
    private static final String URL_RATINGS = "https://datasets.imdbws.com/title.ratings.tsv.gz";
    private static final long MAX_AGE_MS = 24 * 3600_000L;

    private Imdb() {}

    /** Sets imdbRating on every item that has an IMDb id and a rating in the dataset. */
    static void apply(Context context, List<Rows.Item> items) {
        Map<String, Rows.Item> byId = new HashMap<>();
        for (Rows.Item it : items) if (!it.imdb.isEmpty()) byId.put(it.imdb, it);
        if (byId.isEmpty()) return;
        File f = new File(context.getCacheDir(), "title.ratings.tsv.gz");
        if (System.currentTimeMillis() - f.lastModified() > MAX_AGE_MS) download(f);
        if (f.length() == 0) return;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                new GZIPInputStream(new FileInputStream(f), 65536), StandardCharsets.UTF_8))) {
            int left = byId.size();
            for (String line; left > 0 && (line = r.readLine()) != null; ) {
                int tab = line.indexOf('\t');
                if (tab < 0) continue;
                Rows.Item it = byId.get(line.substring(0, tab));
                if (it == null) continue;
                int tab2 = line.indexOf('\t', tab + 1);
                try {
                    it.imdbRating = Double.parseDouble(line.substring(tab + 1, tab2 > 0 ? tab2 : line.length()));
                } catch (NumberFormatException ignored) {
                    // a broken line only loses that rating
                }
                left--;
            }
        } catch (IOException e) {
            Log.w(Channels.TAG, "imdb ratings: " + e);
        }
    }

    private static void download(File f) {
        File tmp = new File(f.getPath() + ".part");
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(URL_RATINGS).openConnection();
            c.setConnectTimeout(15_000);
            c.setReadTimeout(60_000);
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            if (!tmp.renameTo(f)) throw new IOException("rename failed");
        } catch (IOException e) {
            Log.w(Channels.TAG, "imdb download: " + e);
            tmp.delete();
            f.setLastModified(System.currentTimeMillis() - MAX_AGE_MS + 3600_000L);  // retry in an hour
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
