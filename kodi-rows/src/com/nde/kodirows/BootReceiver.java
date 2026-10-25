package com.nde.kodirows;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a reboot: the launcher's poster access is gone until the next refresh, so refresh now. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        PosterProvider.grant(context);
        RefreshJob.schedule(context, Config.load(context));
        RefreshJob.runNow(context);
    }
}
