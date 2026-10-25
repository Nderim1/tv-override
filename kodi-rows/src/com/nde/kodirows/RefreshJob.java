package com.nde.kodirows;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/** Refreshes the rows every refresh_minutes (kept across reboots), and once right away on request. */
public class RefreshJob extends JobService {
    private static final int PERIODIC = 1, NOW = 2;

    static void schedule(Context context, Config cfg) {
        JobScheduler js = context.getSystemService(JobScheduler.class);
        ComponentName me = new ComponentName(context, RefreshJob.class);
        if (cfg.rows.isEmpty()) {
            js.cancel(PERIODIC);
            return;
        }
        js.schedule(new JobInfo.Builder(PERIODIC, me)
                .setPeriodic(cfg.refreshMinutes * 60_000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    static void runNow(Context context) {
        context.getSystemService(JobScheduler.class).schedule(
                new JobInfo.Builder(NOW, new ComponentName(context, RefreshJob.class))
                        .setOverrideDeadline(0)
                        .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            Refresher.run(this);
            jobFinished(params, false);
        }, "kodirows-refresh").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;  // the periodic job comes back on its own
    }
}
