package com.nde.kodirows;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.tv.TvContract;
import android.net.Uri;
import android.util.Log;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One home screen row per config row: a TvProvider preview channel with a card per movie or live station.
 * Launchers that read TvProvider (Projectivy) show it. Programs are updated in place, so the row doesn't
 * flicker on every refresh.
 */
final class Channels {
    static final String TAG = "KodiRows";
    static final String KODI = "org.xbmc.kodi";

    private Channels() {}

    /** Creates or updates the row's channel and its programs; returns the channel id. */
    static long sync(Context context, Config.Row row, List<Rows.Item> items) {
        ContentResolver cr = context.getContentResolver();
        long channel = channel(context, row);
        Map<String, Long> existing = new HashMap<>();
        try (Cursor c = cr.query(TvContract.buildPreviewProgramsUriForChannel(channel),
                new String[]{TvContract.PreviewPrograms._ID, TvContract.PreviewPrograms.COLUMN_INTERNAL_PROVIDER_ID},
                null, null, null)) {
            while (c != null && c.moveToNext()) existing.put(c.getString(1), c.getLong(0));
        }
        Set<String> keep = new HashSet<>();
        for (int i = 0; i < items.size(); i++) {
            Rows.Item it = items.get(i);
            ContentValues v = program(context, channel, it, items.size() - i);
            Long id = existing.get(it.key);
            if (id != null) {
                cr.update(TvContract.buildPreviewProgramUri(id), v, null, null);
            } else {
                cr.insert(TvContract.PreviewPrograms.CONTENT_URI, v);
            }
            keep.add(it.key);
        }
        for (Map.Entry<String, Long> e : existing.entrySet()) {
            if (!keep.contains(e.getKey())) cr.delete(TvContract.buildPreviewProgramUri(e.getValue()), null, null);
        }
        return channel;
    }

    private static ContentValues program(Context context, long channel, Rows.Item it, int weight) {
        Intent play = new Intent(Intent.ACTION_VIEW, Uri.parse("kodirows://play/" + it.key))
                .setClassName(context, PlayActivity.class.getName());
        ContentValues v = new ContentValues();
        v.put(TvContract.PreviewPrograms.COLUMN_CHANNEL_ID, channel);
        v.put(TvContract.PreviewPrograms.COLUMN_TYPE, it.radio ? TvContract.PreviewPrograms.TYPE_STATION
                : it.live ? TvContract.PreviewPrograms.TYPE_CHANNEL : TvContract.PreviewPrograms.TYPE_MOVIE);
        v.put(TvContract.PreviewPrograms.COLUMN_LIVE, it.live ? 1 : 0);
        v.put(TvContract.PreviewPrograms.COLUMN_TITLE, it.title);
        String info = info(it);
        String plot = it.plot.length() > 600 ? it.plot.substring(0, 597) + "…" : it.plot;
        v.put(TvContract.PreviewPrograms.COLUMN_SHORT_DESCRIPTION, info.isEmpty() ? plot : info + "\n" + plot);
        if (it.imdbRating > 0) {  // launchers that draw ratings get stars (0-5); the 1-10 value is in the text
            v.put(TvContract.PreviewPrograms.COLUMN_REVIEW_RATING_STYLE, TvContract.PreviewPrograms.REVIEW_RATING_STYLE_STARS);
            v.put(TvContract.PreviewPrograms.COLUMN_REVIEW_RATING, String.valueOf(it.imdbRating / 2));
        }
        // No RELEASE_DATE / DURATION: Projectivy would spend a whole line of its 3-line text box on them; year and
        // runtime are in our own info line instead, leaving more room for the plot.
        v.putNull(TvContract.PreviewPrograms.COLUMN_RELEASE_DATE);  // cleared on programs from older versions
        v.putNull(TvContract.PreviewPrograms.COLUMN_DURATION_MILLIS);
        if (it.poster != null) {
            String poster = PosterProvider.uri(context, it.key, it.poster, it.live);
            int aspect = it.live ? TvContract.PreviewPrograms.ASPECT_RATIO_16_9 : TvContract.PreviewPrograms.ASPECT_RATIO_2_3;
            v.put(TvContract.PreviewPrograms.COLUMN_POSTER_ART_URI, poster);
            v.put(TvContract.PreviewPrograms.COLUMN_POSTER_ART_ASPECT_RATIO, aspect);
            // Some launchers (Projectivy) draw cards from the thumbnail, others from the poster.
            v.put(TvContract.PreviewPrograms.COLUMN_THUMBNAIL_URI, poster);
            v.put(TvContract.PreviewPrograms.COLUMN_THUMBNAIL_ASPECT_RATIO, aspect);
        }
        v.put(TvContract.PreviewPrograms.COLUMN_INTENT_URI, play.toUri(Intent.URI_INTENT_SCHEME));
        v.put(TvContract.PreviewPrograms.COLUMN_INTERNAL_PROVIDER_ID, it.key);
        v.put(TvContract.PreviewPrograms.COLUMN_WEIGHT, weight);
        return v;
    }

    /** Characters that fit on one line of Projectivy's description box (800 px, 3 lines). */
    private static final int INFO_MAX = 50;

    /**
     * "IMDb 7.2 · 2026 · 1h46 · Horror · PG-13" above the plot. Kept to one line (one genre, none if it would
     * still wrap) so the plot gets the other two lines of the launcher's text box.
     */
    static String info(Rows.Item it) {
        if (it.radio) return "RADIO · Kosovo";
        if (it.live) return "LIVE · Kosovo";
        String runtime = it.runtime > 0 ? (it.runtime / 3600) + "h" + String.format(java.util.Locale.ROOT, "%02d", it.runtime / 60 % 60) : "";
        String rating = it.imdbRating > 0 ? "IMDb " + String.format(java.util.Locale.ROOT, "%.1f", it.imdbRating) : "";
        String year = it.year > 0 ? String.valueOf(it.year) : "";
        String genre = it.genre.split(" / ")[0];
        String line = join(rating, year, runtime, genre, it.mpaa);
        return line.length() <= INFO_MAX ? line : join(rating, year, runtime, it.mpaa);
    }

    private static String join(String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            if (part.isEmpty()) continue;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(part);
        }
        return sb.toString();
    }

    private static long channel(Context context, Config.Row row) {
        ContentResolver cr = context.getContentResolver();
        SharedPreferences prefs = Config.prefs(context);
        long id = prefs.getLong("channel." + row.id, -1);
        ContentValues v = new ContentValues();
        v.put(TvContract.Channels.COLUMN_TYPE, TvContract.Channels.TYPE_PREVIEW);
        v.put(TvContract.Channels.COLUMN_DISPLAY_NAME, row.name);
        v.put(TvContract.Channels.COLUMN_INTERNAL_PROVIDER_ID, row.id);
        Intent kodi = context.getPackageManager().getLeanbackLaunchIntentForPackage(KODI);
        if (kodi != null) v.put(TvContract.Channels.COLUMN_APP_LINK_INTENT_URI, kodi.toUri(Intent.URI_INTENT_SCHEME));
        if (id >= 0 && cr.update(TvContract.buildChannelUri(id), v, null, null) > 0) return id;
        Uri uri = cr.insert(TvContract.Channels.CONTENT_URI, v);
        id = ContentUris.parseId(uri);
        prefs.edit().putLong("channel." + row.id, id).commit();
        try (InputStream logo = context.getResources().openRawResource(R.drawable.logo);
             OutputStream out = cr.openOutputStream(TvContract.buildChannelLogoUri(id))) {
            byte[] buf = new byte[8192];
            for (int n; (n = logo.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (Exception e) {
            Log.w(TAG, "channel logo: " + e);
        }
        try {
            TvContract.requestChannelBrowsable(context, id);  // the stock launcher asks; others may ignore it
        } catch (Exception e) {
            Log.w(TAG, "requestChannelBrowsable: " + e);
        }
        return id;
    }

    /** Removes channels of rows that are no longer in the config. */
    static void removeStale(Context context, Config cfg) {
        Set<String> ids = new HashSet<>();
        for (Config.Row r : cfg.rows) ids.add(r.id);
        SharedPreferences prefs = Config.prefs(context);
        SharedPreferences.Editor ed = prefs.edit();
        for (String k : prefs.getAll().keySet()) {
            if (k.startsWith("channel.") && !ids.contains(k.substring(8))) {
                context.getContentResolver().delete(TvContract.buildChannelUri(prefs.getLong(k, -1)), null, null);
                ed.remove(k).remove("items." + k.substring(8));
            }
        }
        ed.commit();
    }

    /** Channel ids with their browsable flag, for status. */
    static Map<Long, Boolean> browsable(Context context) {
        Map<Long, Boolean> out = new HashMap<>();
        try (Cursor c = context.getContentResolver().query(TvContract.Channels.CONTENT_URI,
                new String[]{TvContract.Channels._ID, TvContract.Channels.COLUMN_BROWSABLE}, null, null, null)) {
            while (c != null && c.moveToNext()) out.put(c.getLong(0), c.getInt(1) == 1);
        } catch (Exception e) {
            Log.w(TAG, "channels: " + e);
        }
        return out;
    }
}
