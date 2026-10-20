package com.nde.tvremap;

import android.accessibilityservice.AccessibilityService;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/** Launches the mapped target when a remote button is pressed and swallows the key. */
public class RemapService extends AccessibilityService {
    static final String TAG = "TvRemap";

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        Keymap.Target target = Keymap.get(this).get(event.getScanCode());
        if (target == null) return false;
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            Log.i(TAG, "scan " + event.getScanCode() + " -> " + target);
            launch(target);
        }
        return true;
    }

    private void launch(Keymap.Target target) {
        Intent intent;
        if (target.action != null) {
            intent = new Intent(target.action).setPackage(target.pkg);
        } else {
            PackageManager pm = getPackageManager();
            intent = pm.getLeanbackLaunchIntentForPackage(target.pkg);
            if (intent == null) intent = pm.getLaunchIntentForPackage(target.pkg);
            if (intent == null) {
                Log.w(TAG, "not installed: " + target.pkg);
                return;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "launch failed: " + target, e);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}
}
