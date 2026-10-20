package com.nde.tvremap;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.SparseArray;

/**
 * Scan code -> target mapping, stored in SharedPreferences and pushed by tvctl over ADB.
 * Format: "245=app:org.smarttube.stable;233=action:com.spocky.projengmenu/tv.projectivy.SETTINGS"
 */
final class Keymap {
    private static final String PREFS = "keymap";
    private static final String KEY = "map";
    private static volatile SparseArray<Target> cache;

    /** Opens an app (action == null) or sends an intent action to a package. */
    static final class Target {
        final String pkg, action;
        Target(String pkg, String action) { this.pkg = pkg; this.action = action; }
        @Override public String toString() { return action == null ? "app:" + pkg : "action:" + pkg + "/" + action; }
    }

    private Keymap() {}

    static SparseArray<Target> get(Context context) {
        SparseArray<Target> map = cache;
        if (map == null) {
            map = parse(raw(context));
            cache = map;
        }
        return map;
    }

    static String raw(Context context) {
        return prefs(context).getString(KEY, "");
    }

    /** Validates and stores a new mapping; throws IllegalArgumentException on bad input. */
    static void save(Context context, String raw) {
        SparseArray<Target> map = parse(raw);
        prefs(context).edit().putString(KEY, raw).commit();
        cache = map;
    }

    static SparseArray<Target> parse(String raw) {
        SparseArray<Target> map = new SparseArray<>();
        if (raw == null) return map;
        for (String entry : raw.split(";")) {
            entry = entry.trim();
            if (entry.isEmpty()) continue;
            int eq = entry.indexOf('=');
            if (eq < 1) throw new IllegalArgumentException("bad entry: " + entry);
            int scan = Integer.parseInt(entry.substring(0, eq).trim());
            String value = entry.substring(eq + 1).trim();
            if (value.startsWith("app:")) {
                map.put(scan, new Target(value.substring(4), null));
            } else if (value.startsWith("action:")) {
                String spec = value.substring(7);
                int slash = spec.indexOf('/');
                if (slash < 1) throw new IllegalArgumentException("action needs package/action: " + entry);
                map.put(scan, new Target(spec.substring(0, slash), spec.substring(slash + 1)));
            } else {
                throw new IllegalArgumentException("expected app: or action: in " + entry);
            }
        }
        return map;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
