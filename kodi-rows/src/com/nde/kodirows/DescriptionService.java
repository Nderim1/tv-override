package com.nde.kodirows;

import android.accessibilityservice.AccessibilityService;
import android.animation.ObjectAnimator;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.Layout;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The whole plot of the focused movie, readable on the home screen. Launchers draw a program's description in a
 * fixed box (Projectivy: 800 px, 3 lines) that cuts long plots. When one of our movies is focused, this lays a
 * panel over that box, as wide as the screen allows, and scrolls the full text slowly a line at a time. It reads
 * only the launcher's focused card and where its description box is; when the box can't be found it shows nothing.
 */
public class DescriptionService extends AccessibilityService {
    private static final long SETTLE_MS = 350;        // the launcher animates rows and updates its box first
    private static final long FIRST_STEP_MS = 4000;   // time to read the lines shown before scrolling starts
    private static final long LINE_MS = 3200;         // one line (~150 characters) per step
    private static final long STEP_ANIM_MS = 600;
    private static final long END_PAUSE_MS = 5000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<String> launchers = new HashSet<>();
    private Map<String, String[]> movies = new HashMap<>();  // title → {info, plot}
    private String moviesFrom;
    private WindowManager wm;
    private ScrollView scroll;
    private TextView text;
    private boolean attached;
    private String[] pending;
    private int visibleLines;

    @Override
    protected void onServiceConnected() {
        wm = getSystemService(WindowManager.class);
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        for (ResolveInfo ri : getPackageManager().queryIntentActivities(home, 0)) launchers.add(ri.activityInfo.packageName);
        launchers.remove(getPackageName());
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent e) {
        CharSequence pkg = e.getPackageName();
        if (pkg == null || getPackageName().contentEquals(pkg)) return;
        if (e.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            handler.post(this::hideUnlessLauncher);  // toasts don't take the active window, apps do
            return;
        }
        if (e.getEventType() != AccessibilityEvent.TYPE_VIEW_FOCUSED || !launchers.contains(pkg.toString())) return;
        AccessibilityNodeInfo node = e.getSource();
        CharSequence label = node == null ? null : node.getContentDescription() != null ? node.getContentDescription() : node.getText();
        String[] movie = label == null ? null : movies().get(label.toString());
        handler.removeCallbacksAndMessages(null);
        if (movie == null) {
            hide();
            return;
        }
        pending = movie;
        if (attached) setText(movie);  // same row: the box doesn't move, so answer at once
        handler.postDelayed(this::place, SETTLE_MS);
    }

    @Override
    public void onInterrupt() {
        hide();
    }

    @Override
    public void onDestroy() {
        hide();
        super.onDestroy();
    }

    /** Covers the launcher's description box (found by our info line in it) with the scrolling panel. */
    private void place() {
        String[] movie = pending;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (movie == null || root == null) return;
        String probe = !movie[0].isEmpty() ? movie[0] : movie[1].substring(0, Math.min(40, movie[1].length()));
        AccessibilityNodeInfo box = null;
        for (AccessibilityNodeInfo n : root.findAccessibilityNodeInfosByText(probe)) {
            if (n.getText() != null && n.getText().toString().startsWith(probe)) box = n;
        }
        if (box == null) {
            hide();
            return;
        }
        Rect r = new Rect();
        box.getBoundsInScreen(r);
        float size = textSize(box, r);
        ensureViews();
        text.setTextSize(TypedValue.COMPLEX_UNIT_PX, size);
        visibleLines = Math.max(2, Math.round(r.height() / (size * 1.17f)));
        int pad = Math.round(size * 0.5f);
        int screen = getResources().getDisplayMetrics().widthPixels;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                screen - 2 * r.left + 2 * pad, text.getLineHeight() * visibleLines + 2 * pad,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.LEFT;
        lp.x = r.left - pad;
        lp.y = r.top - pad;
        scroll.setPadding(pad, pad, pad, pad);
        if (attached) {
            wm.updateViewLayout(scroll, lp);
        } else {
            wm.addView(scroll, lp);
            attached = true;
        }
        setText(movie);
    }

    /** The launcher's own text size (Android 11+), else what fits its box: 3 lines. */
    private static float textSize(AccessibilityNodeInfo box, Rect r) {
        if (Build.VERSION.SDK_INT >= 30) {
            box.refreshWithExtraData(AccessibilityNodeInfo.EXTRA_DATA_RENDERING_INFO_KEY, null);
            AccessibilityNodeInfo.ExtraRenderingInfo info = box.getExtraRenderingInfo();
            if (info != null && info.getTextSizeInPx() > 0) return info.getTextSizeInPx();
        }
        return r.height() / 3f / 1.17f;
    }

    private void ensureViews() {
        if (scroll != null) return;
        text = new TextView(this);
        text.setTypeface(Typeface.create("sans-serif-condensed", Typeface.NORMAL));
        text.setTextColor(0xFFD0D0D0);
        scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFocusable(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF0141014);
        bg.setCornerRadius(24);
        scroll.setBackground(bg);
        scroll.addView(text);
    }

    private void setText(String[] movie) {
        handler.removeCallbacks(step);
        text.setText(movie[0].isEmpty() ? movie[1] : movie[0] + "\n" + movie[1]);
        scroll.scrollTo(0, 0);
        line = 0;
        handler.postDelayed(step, FIRST_STEP_MS);
    }

    private int line;

    /** Moves the text up one line; at the end waits, then starts over from the top. */
    private final Runnable step = new Runnable() {
        @Override
        public void run() {
            Layout layout = text.getLayout();
            if (!attached || layout == null) return;
            int last = layout.getLineCount() - visibleLines;  // first line of the last screenful
            if (last <= 0) return;  // everything fits
            if (line >= last) {
                line = 0;
                scroll.scrollTo(0, 0);
                handler.postDelayed(this, FIRST_STEP_MS);
                return;
            }
            line++;
            ObjectAnimator.ofInt(scroll, "scrollY", layout.getLineTop(line)).setDuration(STEP_ANIM_MS).start();
            handler.postDelayed(this, line >= last ? END_PAUSE_MS : LINE_MS);
        }
    };

    private void hideUnlessLauncher() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null || !launchers.contains(root.getPackageName().toString())) hide();
    }

    private void hide() {
        handler.removeCallbacksAndMessages(null);
        pending = null;
        if (attached) {
            wm.removeView(scroll);
            attached = false;
        }
    }

    /** Our movies by title, from the last refresh (re-read when a refresh has run since). */
    private Map<String, String[]> movies() {
        SharedPreferences prefs = Config.prefs(this);
        String status = prefs.getString("status", "");
        if (status.equals(moviesFrom)) return movies;
        Map<String, String[]> out = new HashMap<>();
        for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
            if (!e.getKey().startsWith("items.")) continue;
            try {
                JSONObject items = new JSONObject(String.valueOf(e.getValue()));
                for (Iterator<String> it = items.keys(); it.hasNext(); ) {
                    JSONObject m = items.getJSONObject(it.next());
                    out.put(m.optString("title"), new String[]{m.optString("info"), m.optString("plot")});
                }
            } catch (JSONException ignored) {
                // a broken cache only loses that row's plots
            }
        }
        movies = out;
        moviesFrom = status;
        return out;
    }
}
