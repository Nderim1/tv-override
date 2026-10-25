/* Override Home – dock, clock, screensaver. ES5 only: Tizen 3 (2017) runs an old Chromium.
   On a desktop browser (no window.tizen) it runs as a preview with made-up apps. */
(function () {
  'use strict';
  var cfg = window.OVERRIDE_HOME || {};
  var defs = window.OVERRIDE_APPS || {};
  var tz = typeof window.tizen !== 'undefined' ? window.tizen : null;
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };

  var dock = [];      // [{key, label, id, icon}]
  var focus = 0;
  var lastInput = Date.now();
  var saverOn = false;

  function $(id) { return document.getElementById(id); }
  function norm(s) { return String(s || '').toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, ''); }

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // ---- apps

  function iconUrl(path) {
    if (!path) return null;
    return /^(file|https?|data):/i.test(path) ? path : (path.charAt(0) === '/' ? 'file://' + path : path);
  }

  function byName(list, def, taken) {
    for (var p = 0; p < def.names.length; p++) {
      var re = new RegExp(def.names[p]);
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a && a.id && a.show !== false && !taken[a.id] && re.test(norm(a.name))) return a;
      }
    }
    return null;
  }

  function resolve(done) {
    var keys = cfg.dock || [];
    if (!tz) {
      done(keys.filter(function (k) { return defs[k]; }).map(function (k) {
        return { key: k, label: defs[k].label, id: 'preview.' + k, icon: null };
      }));
      return;
    }
    var found = {}, taken = {};
    keys.forEach(function (k) {
      var def = defs[k];
      if (!def) return;
      for (var i = 0; i < def.ids.length && !found[k]; i++) {
        try {
          var info = tz.application.getAppInfo(def.ids[i]);
          if (info && info.id) { found[k] = info; taken[info.id] = true; }
        } catch (e) { /* not installed: next id */ }
      }
    });
    var finish = function (list) {
      keys.forEach(function (k) {
        if (!found[k] && defs[k]) {
          var a = byName(list || [], defs[k], taken);
          if (a) { found[k] = a; taken[a.id] = true; }
        }
      });
      done(keys.filter(function (k) { return found[k]; }).map(function (k) {
        return { key: k, label: defs[k].label, id: found[k].id, icon: iconUrl(found[k].iconPath) };
      }));
    };
    var settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; finish([]); } }, 4000);
    try {
      tz.application.getAppsInfo(function (list) {
        if (settled) return;
        settled = true; clearTimeout(timer); finish(list);
      }, function () {
        if (settled) return;
        settled = true; clearTimeout(timer); finish([]);
      });
    } catch (e) { settled = true; clearTimeout(timer); finish([]); }
  }

  function launch(app) {
    if (!tz) { toast('preview: would open ' + app.label); return; }
    var viaControl = function () {
      try {
        tz.application.launchAppControl(
          new tz.ApplicationControl('http://tizen.org/appcontrol/operation/default', null, null, null, null),
          app.id, function () {}, function () { toast(app.label + " didn't open"); });
      } catch (e) { toast(app.label + " didn't open"); }
    };
    try { tz.application.launch(app.id, function () {}, viaControl); } catch (e) { viaControl(); }
  }

  // ---- rendering

  function monogram(label) {
    var words = label.replace(/\+/g, '').split(/\s+/);
    return (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : label.charAt(0)).toUpperCase();
  }

  function renderDock() {
    var el = $('dock');
    el.innerHTML = '';
    if (!dock.length) {
      el.innerHTML = '<div class="empty">no apps found · add them to [home].dock in the profile</div>';
      $('prompt-text').textContent = 'ready';
      return;
    }
    dock.forEach(function (app, i) {
      var tile = document.createElement('div');
      tile.className = 'tile' + (i === focus ? ' focus' : '');
      tile.setAttribute('role', 'option');
      tile.setAttribute('aria-selected', i === focus ? 'true' : 'false');
      var art = document.createElement('div');
      art.className = 'art';
      if (app.icon) {
        var img = document.createElement('img');
        img.src = app.icon;
        img.alt = '';
        img.onerror = function () { art.removeChild(img); art.textContent = monogram(app.label); };
        art.appendChild(img);
      } else {
        art.textContent = monogram(app.label);
      }
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = app.label;
      tile.appendChild(art);
      tile.appendChild(name);
      tile.onclick = function () { focus = i; renderDock(); launch(app); };
      el.appendChild(tile);
    });
    $('prompt-text').textContent = 'open ' + dock[focus].label.toLowerCase().replace(/\s+/g, '-');
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function tick() {
    var d = new Date();
    var h = d.getHours();
    var time = cfg.hour12 ? ((h % 12) || 12) + ':' + pad(d.getMinutes()) : pad(h) + ':' + pad(d.getMinutes());
    $('time').textContent = time;
    $('saver-clock').textContent = time;
    var date;
    try { date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { date = d.toDateString(); }
    $('date').textContent = date;
    if (!saverOn && cfg.saverMinutes > 0 && Date.now() - lastInput > cfg.saverMinutes * 60000) startSaver();
  }

  // ---- screensaver: only a dim clock that moves every minute (no burn-in)

  function moveSaverClock() {
    var c = $('saver-clock');
    c.style.left = Math.round(8 + Math.random() * 62) + '%';
    c.style.top = Math.round(10 + Math.random() * 65) + '%';
  }

  function startSaver() {
    saverOn = true;
    moveSaverClock();
    $('saver').hidden = false;
    startSaver.timer = setInterval(moveSaverClock, 60000);
  }

  function stopSaver() {
    saverOn = false;
    $('saver').hidden = true;
    clearInterval(startSaver.timer);
  }

  // ---- input

  function onKey(e) {
    var k = e.keyCode;
    lastInput = Date.now();
    if (saverOn) { stopSaver(); e.preventDefault(); return; }  // the first press only wakes the screen
    if (k === KEY.BACK || k === KEY.ESC) { e.preventDefault(); return; }  // this is home: Back goes nowhere
    if (!dock.length) return;
    if (k === KEY.LEFT || k === KEY.UP) focus = (focus - 1 + dock.length) % dock.length;
    else if (k === KEY.RIGHT || k === KEY.DOWN) focus = (focus + 1) % dock.length;
    else if (k === KEY.ENTER) { launch(dock[focus]); return; }
    else return;
    e.preventDefault();
    renderDock();
  }

  function refresh() {
    resolve(function (apps) {
      var current = dock[focus] && dock[focus].key;
      dock = apps;
      focus = Math.max(0, apps.map(function (a) { return a.key; }).indexOf(current));
      renderDock();
    });
  }

  if (!tz) {  // preview in a desktop browser: fit the 1920×1080 TV canvas into the window
    var fit = function () {
      var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      document.body.style.transformOrigin = '0 0';
      document.body.style.transform = 'scale(' + k + ')';
    };
    window.addEventListener('resize', fit);
    fit();
  }
  $('tv-name').textContent = cfg.tv || '';
  $('status').textContent = tz ? '' : 'PREVIEW';
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousemove', function () { lastInput = Date.now(); if (saverOn) stopSaver(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { lastInput = Date.now(); stopSaver(); refresh(); }  // back from an app: apps may have changed
  });
  tick();
  setInterval(tick, 5000);
  refresh();
}());
