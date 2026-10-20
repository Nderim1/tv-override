package com.nde.tvremap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Receives the key mapping from tvctl. Protected by android.permission.DUMP in the manifest,
 * so only ADB (shell) can send it, not other apps on the TV.
 *
 *   am broadcast -n com.nde.tvremap/.ConfigReceiver -a com.nde.tvremap.SET_KEYMAP --es keymap "245=app:..."
 *   am broadcast -n com.nde.tvremap/.ConfigReceiver -a com.nde.tvremap.GET_KEYMAP
 */
public class ConfigReceiver extends BroadcastReceiver {
    static final String SET = "com.nde.tvremap.SET_KEYMAP";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (SET.equals(intent.getAction())) {
            String raw = intent.getStringExtra("keymap");
            try {
                Keymap.save(context, raw == null ? "" : raw);
                Log.i(RemapService.TAG, "keymap set: " + raw);
            } catch (IllegalArgumentException e) {
                setResultCode(0);
                setResultData("error: " + e.getMessage());
                return;
            }
        }
        setResultCode(1);
        setResultData(Keymap.raw(context));
    }
}
