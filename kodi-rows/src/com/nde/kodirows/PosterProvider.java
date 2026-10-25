package com.nde.kodirows;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Set;

/**
 * Posters for the home screen, served from the app's cache. Projectivy loads remote program art only from its
 * own HTTP cache (an https poster fails with "only-if-cached 504" and shows a "!" tile), so the refresh downloads
 * each poster and the programs point at content://com.nde.kodirows.posters/<key>. Read-only, posters only.
 */
public class PosterProvider extends ContentProvider {
    static final String AUTHORITY = "com.nde.kodirows.posters";

    private static File dir(Context context) {
        return new File(context.getCacheDir(), "posters");
    }

    /** The local poster for a movie, downloaded if needed; the remote url when the download fails. */
    static String uri(Context context, String key, String url, boolean live) {
        File f = new File(dir(context), key + ".jpg");
        if (f.length() == 0) {
            if (!download(url, f)) return url;
            if (live) landscape(f);
        }
        return "content://" + AUTHORITY + "/" + key;
    }

    /** Channel logos sit inside a dark 16:9 card instead of being stretched into movie posters. */
    private static void landscape(File file) {
        Bitmap logo = BitmapFactory.decodeFile(file.getPath());
        if (logo == null) return;
        Bitmap card = Bitmap.createBitmap(480, 270, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(card);
        canvas.drawColor(Color.rgb(24, 30, 42));
        float scale = Math.min(400f / logo.getWidth(), 190f / logo.getHeight());
        float w = logo.getWidth() * scale, h = logo.getHeight() * scale;
        canvas.drawBitmap(logo, null, new RectF((480 - w) / 2, (270 - h) / 2, (480 + w) / 2, (270 + h) / 2),
                new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG));
        try (OutputStream out = new FileOutputStream(file)) {
            card.compress(Bitmap.CompressFormat.JPEG, 92, out);
        } catch (IOException e) {
            Log.w(Channels.TAG, "channel logo: " + e);
        } finally {
            logo.recycle();
            card.recycle();
        }
    }

    private static boolean download(String url, File f) {
        f.getParentFile().mkdirs();
        File tmp = new File(f.getPath() + ".part");
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10_000);
            c.setReadTimeout(20_000);
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[16384];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return tmp.renameTo(f);
        } catch (IOException e) {
            Log.w(Channels.TAG, "poster " + url + ": " + e);
            tmp.delete();
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * Lets the home screen apps read the posters. Since Android 11 an app can't see another app's provider
     * ("Failed to find provider info") unless it declares it; a URI grant makes us visible to it. Grants end at
     * reboot, so every refresh (and boot) renews them.
     */
    static void grant(Context context) {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        Uri all = Uri.parse("content://" + AUTHORITY + "/");
        for (ResolveInfo ri : context.getPackageManager().queryIntentActivities(home, 0)) {
            String pkg = ri.activityInfo.packageName;
            if (pkg.equals(context.getPackageName())) continue;
            context.grantUriPermission(pkg, all,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        }
    }

    /** Deletes posters of movies that are no longer in any row. */
    static void prune(Context context, Set<String> keep) {
        File[] files = dir(context).listFiles();
        if (files == null) return;
        for (File f : files) {
            String name = f.getName();
            int dot = name.indexOf('.');
            if (!keep.contains(dot > 0 ? name.substring(0, dot) : name)) f.delete();
        }
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String key = uri.getLastPathSegment();
        if (key == null || !key.matches("[0-9a-f]+") || !"r".equals(mode)) throw new FileNotFoundException(uri.toString());
        return ParcelFileDescriptor.open(new File(dir(getContext()), key + ".jpg"), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
