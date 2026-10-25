package com.nde.kodirows;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * tvctl talks to the app over ADB:
 *   am broadcast -f 32 -n com.nde.kodirows/.ConfigReceiver -a com.nde.kodirows.SET_CONFIG --es config '<json>'
 * Result code 1 = ok (data: the stored config or status JSON), 0 = refused (data: why).
 */
public class ConfigReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = String.valueOf(intent.getAction());
        switch (action) {
            case "com.nde.kodirows.SET_CONFIG":
                try {
                    Config cfg = Config.save(context, intent.getStringExtra("config"));
                    RefreshJob.schedule(context, cfg);
                    RefreshJob.runNow(context);
                    setResult(1, Config.raw(context), null);
                } catch (IllegalArgumentException e) {
                    setResult(0, "bad config: " + e.getMessage(), null);
                }
                break;
            case "com.nde.kodirows.GET_CONFIG":
                setResult(1, Config.raw(context), null);
                break;
            case "com.nde.kodirows.GET_STATUS":
                setResult(1, Config.prefs(context).getString("status", "{}"), null);
                break;
            case "com.nde.kodirows.REFRESH":
                RefreshJob.schedule(context, Config.load(context));
                RefreshJob.runNow(context);
                setResult(1, "refresh started", null);
                break;
            default:
                setResult(0, "unknown action " + action, null);
        }
    }
}
