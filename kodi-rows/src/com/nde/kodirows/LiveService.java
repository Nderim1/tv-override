package com.nde.kodirows;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.io.IOException;

/** Keeps the renewing HLS relay alive while Kodi plays. Stops after five minutes without requests. */
public class LiveService extends Service {
    private static final Object LOCK = new Object();
    private static String key, readyUrl, error;
    private HlsProxy proxy;
    private int generation;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable checkIdle = new Runnable() {
        @Override public void run() {
            if (proxy != null && proxy.idleMillis() > 300_000) stopSelf();
            else handler.postDelayed(this, 30_000);
        }
    };

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("live-stream", "Live TV playback", NotificationManager.IMPORTANCE_LOW));
        startForeground(10, new Notification.Builder(this, "live-stream").setSmallIcon(R.drawable.logo)
                .setContentTitle("Klan Kosova live").setContentText("Keeping the live stream connected")
                .setOngoing(true).build());
        int current = ++generation;
        if (proxy != null) { proxy.close(); proxy = null; }
        synchronized (LOCK) { key = intent.getStringExtra("key"); readyUrl = null; error = null; }
        String endpoint = intent.getStringExtra("url");
        new Thread(() -> {
            HlsProxy next = null;
            String failure = null;
            try {
                LiveStreams.Klan source = new LiveStreams.Klan(endpoint);
                source.resolve(null, false);
                next = new HlsProxy(source);
            } catch (IOException | RuntimeException e) { failure = e.getMessage(); }
            final HlsProxy prepared = next;
            final String message = failure;
            handler.post(() -> {
                if (current != generation) { if (prepared != null) prepared.close(); return; }
                proxy = prepared;
                synchronized (LOCK) {
                    readyUrl = proxy == null ? null : proxy.url();
                    error = message;
                    LOCK.notifyAll();
                }
                if (proxy == null) { Log.w(Channels.TAG, "live relay: " + message); stopSelf(); }
            });
        }, "kodirows-live-start").start();
        handler.removeCallbacks(checkIdle);
        handler.postDelayed(checkIdle, 30_000);
        return START_NOT_STICKY;
    }

    static String awaitUrl(String expected) throws IOException {
        long until = SystemClock.elapsedRealtime() + 45_000;
        synchronized (LOCK) {
            while (SystemClock.elapsedRealtime() < until) {
                if (expected.equals(key)) {
                    if (readyUrl != null) return readyUrl;
                    if (error != null) throw new IOException(error);
                }
                try { LOCK.wait(500); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Live playback interrupted", e); }
            }
        }
        throw new IOException("Live player did not start in time");
    }

    @Override public void onDestroy() {
        generation++;
        handler.removeCallbacksAndMessages(null);
        if (proxy != null) proxy.close();
        synchronized (LOCK) { readyUrl = null; error = "Live playback stopped"; LOCK.notifyAll(); }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
