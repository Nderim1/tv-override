package com.nde.kodirows;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;

import java.io.IOException;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * A poster on the home screen opens this with kodirows://play/<key>. It brings Kodi to the front (starting it
 * if needed) and asks it to play the item. Movies use the add-on's source picker; live stations play a URL.
 */
public class PlayActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Uri data = getIntent().getData();
        String key = data != null ? data.getLastPathSegment() : null;
        JSONObject item = key != null ? Refresher.itemFor(this, key) : null;
        String file = item != null ? item.optString("file") : null;
        String resolver = item != null ? item.optString("resolver", "direct") : "direct";
        Intent kodi = getPackageManager().getLeanbackLaunchIntentForPackage(Channels.KODI);
        if (kodi == null) kodi = getPackageManager().getLaunchIntentForPackage(Channels.KODI);
        if (file == null || kodi == null) {
            Toast.makeText(this, kodi == null ? "Kodi is not installed" : "This item is no longer in the list",
                    Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        int port = Config.load(this).port;
        String session = java.util.UUID.randomUUID().toString();
        if (resolver.equals("klan")) {
            startForegroundService(new Intent(this, LiveService.class).putExtra("key", session).putExtra("url", file));
        } else {
            stopService(new Intent(this, LiveService.class));
        }
        startActivity(kodi);
        new Thread(() -> play(port, session, file, resolver), "kodirows-play").start();
        finish();
    }

    private void play(int port, String key, String file, String resolver) {
        android.content.Context app = getApplicationContext();
        try {
            file = resolver.equals("klan") ? LiveService.awaitUrl(key) : LiveStreams.resolve(file, resolver);
        } catch (IOException e) {
            showError(app, e.getMessage());
            return;
        }
        if (!Kodi.ping(port)) {  // Kodi was closed: a refused local connection fails at once
            long until = SystemClock.elapsedRealtime() + 45_000;
            while (!Kodi.ping(port) && SystemClock.elapsedRealtime() < until) SystemClock.sleep(1000);
            SystemClock.sleep(3000);  // let Kodi finish loading its home screen and add-ons
        }
        String error = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try (Kodi k = new Kodi(port, 15_000)) {
                k.call("Player.Open", new JSONObject().put("item", new JSONObject().put("file", file)));
                error = null;
                break;
            } catch (IOException | JSONException e) {
                error = e.getMessage();
                SystemClock.sleep(2000);
            }
        }
        if (error != null) {
            showError(app, error);
        }
    }

    private static void showError(android.content.Context app, String msg) {
        Log.w(Channels.TAG, "play: " + msg);
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                Toast.makeText(app, "Could not start channel: " + msg, Toast.LENGTH_LONG).show());
    }
}
