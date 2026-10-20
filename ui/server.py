"""tv-override control center: a local dashboard that drives tvctl's Workflow engine.

Started by `tvctl ui` (and automatically by workflow commands). Listens on 127.0.0.1 only. Every API call
needs the per-start token (embedded in the page, also written to state/.ui-token for CLI event mirroring),
and the Host header must be localhost, so other web pages cannot drive it.
"""

import json
import queue
import re
import secrets
import socket
import subprocess
import threading
import time
import traceback
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

UI_DIR = Path(__file__).resolve().parent
STATIC = UI_DIR / "static"
CONTENT_TYPES = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html"}


class Bus:
    """Fan-out of workflow events to every connected browser (SSE), with a short replay buffer."""
    def __init__(self):
        self.lock = threading.Lock()
        self.subs = []
        self.history = []

    def publish(self, event):
        with self.lock:
            self.history = (self.history + [event])[-3000:]
            for q in self.subs:
                q.put(event)

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            self.subs.append(q)
            replay = list(self.history)
        return q, replay

    def unsubscribe(self, q):
        with self.lock:
            if q in self.subs:
                self.subs.remove(q)


class Job:
    """A workflow running in a background thread, paused on owner input through threading events."""
    def __init__(self, app, tv_name, mode, reboot, measure, **options):
        self.app, self.tv, self.mode = app, tv_name, mode
        self.run_id = None
        self.state = "starting"
        self.confirm_items, self.waiting_items = None, None
        self._answer = None
        self._event = threading.Event()
        self._stop = False
        self.wf = app.tv.Workflow(tv_name, mode, self, reboot=reboot, measure=measure, source="ui", **options)

    # Hooks interface used by the Workflow
    def emit(self, event):
        self.run_id = event.get("run") or self.run_id
        if event["type"] == "run":
            self.state = event["status"]
        self.app.bus.publish(event)

    def confirm(self, actions):
        self.confirm_items, self.state = actions, "confirm"
        self._publish_job()
        answer = self._block()
        self.confirm_items, self.state = None, "running"
        self._publish_job()
        return set(answer or [])

    def wait(self, waiting):
        self.waiting_items, self.state = waiting, "waiting"
        self._publish_job()
        answer = self._block()
        self.waiting_items, self.state = None, "running"
        self._publish_job()
        return bool(answer)

    def stopped(self):
        return self._stop

    # controls from the browser
    def answer(self, value):
        self._answer = value
        self._event.set()

    def stop(self):
        self._stop = True
        self.answer(None)

    def _block(self):
        self._event.clear()
        while not self._event.wait(1):
            if self._stop:
                return None
        return self._answer

    def _publish_job(self):
        self.app.bus.publish({"type": "job", "tv": self.tv, "run": self.run_id, **self.public()})

    def public(self):
        return {"run": self.run_id, "tv": self.tv, "mode": self.mode, "state": self.state,
                "confirm": self.confirm_items, "waiting": self.waiting_items}

    def start(self):
        def target():
            try:
                self.wf.run()
            except Exception:
                self.app.bus.publish({"type": "log", "tv": self.tv, "run": self.run_id, "level": "error",
                                      "msg": traceback.format_exc(limit=3)})
            finally:
                self.state = "finished" if self.state in ("running", "starting") else self.state
                with self.app.lock:
                    self.app.jobs.pop(self.tv, None)
                self._publish_job()
        threading.Thread(target=target, daemon=True).start()


ASK_KINDS = ("choice", "multi", "confirm", "text", "action")


class Desk:
    """The agent's desk: questions the agent asks the owner, the owner's requests to the agent, agent notes.

    Agent side (tvctl ask / inbox / notify) long-polls; the dashboard answers. Persisted to state/agent.json.
    """
    def __init__(self, path, bus):
        self.path, self.bus = path, bus
        self.cv = threading.Condition()
        self.items = json.loads(path.read_text()) if path.exists() else []
        self.agent_seen = None
        self._presence_sent = 0

    def _now(self):
        return time.strftime("%Y-%m-%dT%H:%M:%S%z")

    def _save(self):
        self.items = self.items[-300:]
        self.path.write_text(json.dumps(self.items, indent=1))

    def _publish(self, event, item):
        self.bus.publish({"type": "agent", "event": event, "tv": item.get("tv"), "item": item})

    def _find(self, item_id, type_=None):
        for it in self.items:
            if it["id"] == item_id and (type_ is None or it["type"] == type_):
                return it
        raise KeyError(item_id)

    def seen(self):
        self.agent_seen = self._now()
        if time.time() - self._presence_sent > 5:
            self._presence_sent = time.time()
            self.bus.publish({"type": "agent", "event": "presence", "tv": None, "seen": self.agent_seen})

    def snapshot(self):
        with self.cv:
            return {"items": list(self.items), "agent_seen": self.agent_seen}

    # -- agent asks the owner
    def ask(self, body):
        kind = body.get("kind", "choice")
        if kind not in ASK_KINDS:
            raise ValueError(f"kind must be one of {', '.join(ASK_KINDS)}")
        options = body.get("options") or []
        if kind in ("choice", "multi") and not options:
            raise ValueError(f"{kind} needs options")
        item = {"id": secrets.token_hex(4), "type": "ask", "kind": kind, "tv": body.get("tv"),
                "title": str(body.get("title") or "The agent has a question")[:300],
                "body": str(body.get("body") or "")[:4000],
                "options": [{"value": str(o["value"]), "label": str(o.get("label") or o["value"])[:200],
                             "hint": str(o.get("hint") or "")[:300], "checked": bool(o.get("checked"))}
                            for o in options][:300],
                "status": "open", "answer": None, "created": self._now(), "answered": None}
        with self.cv:
            self.items.append(item)
            self._save()
            self.cv.notify_all()
        self._publish("ask", item)
        return item

    def wait_answer(self, item_id, wait):
        with self.cv:
            item = self._find(item_id, "ask")
            self.cv.wait_for(lambda: item["status"] != "open", timeout=wait)
            return item

    def answer(self, item_id, answer):
        with self.cv:
            item = self._find(item_id, "ask")
            if item["status"] != "open":
                raise ValueError(f"already {item['status']}")
            values = [o["value"] for o in item["options"]]
            kind = item["kind"]
            if kind == "choice" and answer not in values:
                raise ValueError("pick one of the options")
            if kind == "multi" and (not isinstance(answer, list) or any(a not in values for a in answer)):
                raise ValueError("answer must be a list of option values")
            if kind == "confirm" and not isinstance(answer, bool):
                raise ValueError("answer must be yes or no")
            if kind == "text" and (not isinstance(answer, str) or len(answer) > 4000):
                raise ValueError("answer must be text (max 4000 chars)")
            if kind == "action":
                answer = "done"
            item.update(status="answered", answer=answer, answered=self._now())
            self._save()
            self.cv.notify_all()
        self._publish("answer", item)
        return item

    def cancel(self, item_id, reason="cancelled"):
        with self.cv:
            item = self._find(item_id, "ask")
            if item["status"] == "open":
                item.update(status="expired" if reason == "timeout" else "cancelled", answered=self._now())
                self._save()
                self.cv.notify_all()
        self._publish("answer", item)
        return item

    # -- owner asks the agent
    def inbox_add(self, body):
        text = str(body.get("text") or "").strip()[:4000]
        topic = str(body.get("topic") or "message")[:40]
        if not text and topic == "message":
            raise ValueError("write a message")
        item = {"id": secrets.token_hex(4), "type": "inbox", "tv": body.get("tv"), "topic": topic, "text": text,
                "status": "open", "reply": None, "created": self._now(), "taken": None}
        with self.cv:
            self.items.append(item)
            self._save()
            self.cv.notify_all()
        self._publish("inbox", item)
        return item

    def inbox_take(self, wait):
        with self.cv:
            self.cv.wait_for(lambda: any(i["type"] == "inbox" and i["status"] == "open" for i in self.items),
                             timeout=wait)
            taken = [i for i in self.items if i["type"] == "inbox" and i["status"] == "open"]
            for i in taken:
                i.update(status="taken", taken=self._now())
            if taken:
                self._save()
        for i in taken:
            self._publish("inbox", i)
        return taken

    def inbox_reply(self, item_id, text, done):
        with self.cv:
            item = self._find(item_id, "inbox")
            item.update(reply=str(text)[:4000], status="done" if done else "taken", replied=self._now())
            self._save()
        self._publish("inbox", item)
        return item

    # -- agent notes / escalations
    def notify(self, body):
        level = body.get("level", "info")
        if level not in ("info", "warn", "need-chat", "done"):
            raise ValueError("level: info | warn | need-chat | done")
        item = {"id": secrets.token_hex(4), "type": "note", "tv": body.get("tv"), "level": level,
                "title": str(body.get("title") or "")[:300], "body": str(body.get("body") or "")[:4000],
                "status": "open" if level == "need-chat" else "info", "created": self._now()}
        with self.cv:
            self.items.append(item)
            self._save()
        self._publish("note", item)
        return item

    def dismiss(self, item_id):
        with self.cv:
            item = self._find(item_id)
            item["status"] = "dismissed"
            self._save()
        self._publish("note", item)
        return item


class App:
    def __init__(self, tv, token):
        self.tv, self.token = tv, token
        self.bus = Bus()
        self.desk = Desk(tv.STATE_DIR / "agent.json", self.bus)
        self.jobs = {}  # tv name -> Job
        self.captures = set()  # tv names currently listening for remote buttons
        self.screens = {}  # (tv, width) -> (time, bytes, content type)
        self.screen_locks = {}
        self.lock = threading.Lock()

    # ---- data

    def profiles(self):
        return sorted(p.stem for p in self.tv.PROFILES_DIR.glob("*.toml"))

    def latest_perf(self, name):
        path = self.tv.STATE_DIR / name / "perf-latest.json"
        return json.loads(path.read_text()) if path.exists() else None

    def save_perf(self, name, data):
        (self.tv.STATE_DIR / name).mkdir(parents=True, exist_ok=True)
        (self.tv.STATE_DIR / name / "perf-latest.json").write_text(json.dumps(data, indent=1))

    def tv_summary(self, name):
        prof = self.tv.load_profile(name)
        t = prof["tv"]
        runs = self.tv.list_runs(name)
        applied = [r for r in runs if r["mode"] == "apply" and r.get("perf_before") and r.get("perf_after")
                   and r.get("summary", {}).get("changed")]  # no-change runs only measure noise
        freed = [r["perf_after"]["mem_available_mb"] - r["perf_before"]["mem_available_mb"] for r in applied]
        last = runs[0] if runs else None
        plat = t.get("platform", "adb")
        return {"name": name, "host": t["host"], "port": t.get("port", 5555), "model": t.get("model", ""),
                "platform": plat, "platform_label": self.tv.PLATFORMS.get(plat, {}).get("label", plat),
                "caps": self.tv.PLATFORMS.get(plat, {}).get("caps", []),
                "presets": t.get("presets", []), "launcher": prof["home"].get("launcher"),
                "runs": len(runs), "last_run": last and {k: last.get(k) for k in
                                                        ("id", "mode", "outcome", "finished", "source")},
                "ram_freed_mb": freed[0] if freed else None, "perf": self.latest_perf(name),
                "job": self.jobs[name].public() if name in self.jobs else None}

    def state(self):
        names = self.profiles()
        with ThreadPoolExecutor(max_workers=8) as pool:
            summaries = list(pool.map(self.tv_summary, names))
            online = list(pool.map(lambda s: _port_open(s["host"], s["port"] or 80) or
                                   (s["platform"] != "adb" and _port_open(s["host"], 7681)), summaries))
        for s, on in zip(summaries, online):
            s["online"] = on
        return {"tvs": summaries, "ui_port": self.tv.UI_PORT, "viewers": len(self.bus.subs),
                "agent_seen": self.desk.agent_seen}

    def tv_detail(self, name):
        prof = self.tv.load_profile(name)
        runs = self.tv.list_runs(name)
        return {"summary": self.tv_summary(name),
                "profile": {k: prof[k] for k in ("tv", "apps", "home", "keys")},
                "profile_text": prof["_path"].read_text(),
                "runs": [_run_brief(r) for r in runs],
                "baseline": (self.tv.STATE_DIR / name / "baseline.json").exists()}

    def ctx(self, name):
        prof = self.tv.load_profile(name)
        if self.tv.platform_of(prof) != "adb":
            raise self.tv.TvError(f"needs ADB; {name} is a {self.tv.PLATFORMS[self.tv.platform_of(prof)]['label']}")
        dev = self.tv.Device(prof["tv"]["host"], prof["tv"].get("port", 5555))
        dev.connect(wait=5)
        ctx = self.tv.Ctx(prof, dev)
        self.tv.check_identity(ctx)
        return ctx

    def measure(self, name):
        ctx = self.ctx(name)
        data = {"perf": self.tv.perf(ctx.dev, ctx.pkgs), "status": self.tv.status_data(ctx)}
        self.save_perf(name, data["perf"])
        return data

    def start_job(self, name, mode, reboot, measure, **options):
        with self.lock:
            if name in self.jobs:
                raise self.tv.TvError(f"a {self.jobs[name].mode} run is already active on {name}")
            job = Job(self, name, mode, reboot, measure, **options)
            self.jobs[name] = job
        job.start()
        return job.public()

    def job_for_run(self, run_id):
        for job in self.jobs.values():
            if job.run_id == run_id:
                return job
        raise self.tv.TvError("no active run with that id (finished, or started from the terminal)")

    # ---- preparation (dossier + guided walkthrough)

    def prepare_view(self, name, build=True):
        dossier = self.tv.load_dossier(name)
        gpath = self.tv.guide_path(name)
        guide = json.loads(gpath.read_text()) if gpath.exists() else None
        prof = self.tv.load_profile(name)
        if build and (guide is None or dossier is None) and self.tv.platform_of(prof) != "adb":
            dossier = dossier or self.tv.discover_network(prof)
            guide = self.tv.network_guide(prof)
        elif build and (guide is None or dossier is None):
            ctx = self.ctx(name)
            dossier = dossier or self.tv.discover(ctx)
            guide = self.tv.load_guide(ctx)
        return {"dossier": dossier, "guide": guide}

    def research(self, name):
        view = self.prepare_view(name)
        d = view["dossier"]
        if d.get("platform", "adb") != "adb":
            facts = (f"{d.get('brand')} {d.get('model') or d.get('name')}, platform {d.get('platform_label')} (no ADB; "
                     f"UPnP: {', '.join(u.get('description') or u.get('type', '') for u in d.get('upnp', []))})")
        else:
            facts = (f"{d['brand']} {d['model']} ({d['props'].get('ro.product.name')}), Android {d['android']}, "
                     f"firmware {d['firmware']}, patch {d['security_patch']}, SoC {d['soc']}, {d['ram_mb']} MB RAM, "
                     f"tuner: {bool(d['live_tv']['tuner_inputs'])}, Play Store: {d['play_store']}")
        text = (f"Research how to prepare this TV for the tv-override workflow and write a model-specific guide "
                f"(prompts/prepare-tv.md, then `./tvctl guide set {name} <file>`). TV: {facts}, presets: "
                f"{', '.join(d.get('presets', []))}. Full data: state/{name}/dossier.json. Current guide: state/{name}/guide.json.")
        item = self.desk.inbox_add({"tv": name, "topic": "prepare", "text": text})
        guide = view["guide"]
        guide["research"] = {"requested": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "inbox": item["id"]}
        self.tv.guide_path(name).write_text(json.dumps(guide, indent=1))
        self.bus.publish({"type": "prepare", "tv": name, "what": "guide"})
        return item

    # ---- live screen

    def screen(self, name, width):
        """Latest screenshot as a small JPEG; one capture at a time per TV, shared by all viewers for ~0.8 s."""
        key = (name, width)
        with self.lock:
            lock = self.screen_locks.setdefault(name, threading.Lock())
        with lock:
            cached = self.screens.get(key)
            if cached and time.time() - cached[0] < 0.8:
                return cached
            prof = self.tv.load_profile(name)
            if self.tv.platform_of(prof) != "adb":
                raise self.tv.TvError("no screenshots on this TV (not Android)")
            dev = self.tv.Device(prof["tv"]["host"], prof["tv"].get("port", 5555))
            started = time.time()
            png = dev.screencap()
            data, ctype = (png, "image/png") if width == 0 else self.tv.to_jpeg(png, width)
            entry = (time.time(), data, ctype, round((time.time() - started) * 1000))
            self.screens[key] = entry
            return entry

    # ---- remote buttons

    def keys_view(self, name):
        ctx = self.ctx(name)
        labels = {int(k): v for k, v in self.tv.merged(ctx.presets, "remote_keys").items()}
        targets = self.tv.launch_targets(ctx)
        by_pkg = {t["package"]: t["label"] for t in targets if t["type"] == "app"}
        by_act = {(t["package"], t["action"]): t["label"] for t in targets if t["type"] == "action"}
        keys = []
        for scan, k in sorted(ctx.prof["keys"].items(), key=lambda kv: int(kv[0])):
            pkg = ctx.resolve_pkg(k.get("open") or k.get("package", ""))
            target = by_act.get((pkg, k.get("action"))) if k.get("action") else by_pkg.get(pkg)
            keys.append({"scan": int(scan), "label": k.get("label", ""), "open": k.get("open"),
                         "action": k.get("action"), "package": k.get("package"),
                         "target_label": target or pkg, "missing": target is None})
        return {"keys": keys, "remote_labels": labels, "protected": self.tv.PROTECTED_KEYS,
                "targets": targets, "remap": self.tv.remap_status(ctx)}

    def capture(self, name, seconds):
        with self.lock:
            if name in self.captures:
                raise self.tv.TvError("already listening for buttons on this TV")
            self.captures.add(name)
        ctx = self.ctx(name)
        labels = {int(k): v for k, v in self.tv.merged(ctx.presets, "remote_keys").items()}
        mapped = {int(k) for k in ctx.prof["keys"]}

        def target():
            self.bus.publish({"type": "keycapture", "tv": name, "state": "listening", "seconds": seconds})
            try:
                for press in self.tv.capture_keys(ctx.dev, seconds):
                    scan = press["scan"]
                    self.bus.publish({"type": "keypress", "tv": name, "scan": scan, "device": press["device"],
                                      "label": labels.get(scan) or self.tv.PROTECTED_KEYS.get(scan, ""),
                                      "protected": scan in self.tv.PROTECTED_KEYS, "mapped": scan in mapped})
            except Exception as e:
                self.bus.publish({"type": "log", "tv": name, "level": "error", "msg": f"key capture: {e}"})
            finally:
                with self.lock:
                    self.captures.discard(name)
                self.bus.publish({"type": "keycapture", "tv": name, "state": "done"})
        threading.Thread(target=target, daemon=True).start()
        return {"listening": seconds}

    def save_key(self, name, scan, entry):
        self.tv.set_key(name, scan, entry)
        pushed, note = False, None
        try:
            ctx = self.ctx(name)
        except self.tv.TvError:
            ctx, note = None, "saved to the profile; the TV is offline – the next RUN WORKFLOW pushes it"
        app = ctx and self.tv.keymap_app(ctx)
        if app and ctx.installed(app["package"]):
            self.tv.push_keymap(ctx, self.tv.keymap_string(ctx))
            pushed = True
        elif ctx:
            note = "saved to the profile; Remote Remap is not installed yet – RUN WORKFLOW installs it"
        self.bus.publish({"type": "log", "tv": name, "level": "info",
                          "msg": f"button {scan} {'unmapped' if entry is None else '→ ' + (entry.get('open') or entry.get('action'))}"
                                 f"{' (pushed to TV)' if pushed else ''}"})
        return {"ok": True, "pushed": pushed, "note": note}

    def ingest(self, event):
        """Events mirrored from CLI runs: shown live, controlled from the terminal."""
        event["source"] = "cli"
        self.bus.publish(event)
        if event.get("type") == "perf" and event.get("which") == "after" and event.get("tv"):
            self.save_perf(event["tv"], event["data"])


def _port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def _run_brief(r):
    pb, pa = r.get("perf_before") or {}, r.get("perf_after") or {}
    return {"id": r["id"], "mode": r["mode"], "source": r.get("source"), "outcome": r["outcome"],
            "started": r["started"], "finished": r.get("finished"), "summary": r.get("summary", {}),
            "mem_before": pb.get("mem_available_mb"), "mem_after": pa.get("mem_available_mb"),
            "mem_total": pa.get("mem_total_mb") or pb.get("mem_total_mb"), "note": r.get("note")}


def make_handler(app):
    tv = app.tv
    allowed_hosts = {f"127.0.0.1:{tv.UI_PORT}", f"localhost:{tv.UI_PORT}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "tv-override"

        def log_message(self, fmt, *args):  # quiet; errors still go to stderr via send_error
            pass

        # ---- helpers
        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text") or "json" in ctype else ""))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self, query):
            if self.headers.get("Host") not in allowed_hosts:
                return False
            token = self.headers.get("X-Token") or query.get("token", [None])[0]
            return token is not None and secrets.compare_digest(token, app.token)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def _route(self, method):
            url = urlparse(self.path)
            path, query = url.path, parse_qs(url.query)
            if method == "GET" and path in ("/", "/index.html"):
                if self.headers.get("Host") not in allowed_hosts:
                    return self._send(403, {"error": "forbidden host"})
                html = (UI_DIR / "index.html").read_text().replace("{{TOKEN}}", app.token)
                return self._send(200, html.encode(), "text/html")
            if method == "GET" and path.startswith("/static/"):
                f = (STATIC / path[len("/static/"):]).resolve()
                if STATIC not in f.parents or not f.is_file():
                    return self._send(404, {"error": "not found"})
                return self._send(200, f.read_bytes(), CONTENT_TYPES.get(f.suffix, "application/octet-stream"))
            if not path.startswith("/api/"):
                return self._send(404, {"error": "not found"})
            if not self._authorized(query):
                return self._send(403, {"error": "forbidden"})
            if method == "GET" and path == "/api/events":
                return self._sse()
            sm = re.fullmatch(r"/api/tv/([a-z0-9-]+)/screen", path)
            if method == "GET" and sm:
                if sm.group(1) not in app.profiles():
                    return self._send(404, {"error": "no such TV"})
                try:
                    width = max(0, min(int(query.get("w", ["960"])[0]), 1920))
                    taken, data, ctype, ms = app.screen(sm.group(1), width)
                except (tv.TvError, ValueError) as e:
                    return self._send(503, {"error": str(e)})
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Capture-Ms", str(ms))
                self.send_header("X-Captured", time.strftime("%H:%M:%S", time.localtime(taken)))
                self.end_headers()
                self.wfile.write(data)
                return
            try:
                return self._send(200, self._api(method, path, query))
            except tv.TvError as e:
                return self._send(400, {"error": str(e)})
            except FileNotFoundError as e:
                return self._send(404, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def _api(self, method, path, query):
            m = re.fullmatch(r"/api/tv/([a-z0-9-]+)(/.*)?", path)
            name, sub = (m.group(1), m.group(2) or "") if m else (None, None)
            if name and name not in app.profiles():
                raise tv.TvError(f"no profile {name}")
            desk = app.desk
            am = re.fullmatch(r"/api/(ask|inbox|agent)/([0-9a-f]{8})(?:/(answer|cancel|reply|dismiss))?", path)
            if method == "GET":
                if path == "/api/state":
                    return app.state()
                if path == "/api/agent":
                    return desk.snapshot()
                if am and am.group(1) == "ask" and not am.group(3):  # agent long-polls for the answer
                    desk.seen()
                    wait = min(float(query.get("wait", ["0"])[0]), 30)
                    return desk.wait_answer(am.group(2), wait)
                if path == "/api/inbox":  # agent picks up the owner's requests
                    desk.seen()
                    return {"items": desk.inbox_take(min(float(query.get("wait", ["0"])[0]), 30))}
                if name and sub == "":
                    return app.tv_detail(name)
                if name and sub == "/apps":
                    ctx = app.ctx(name)
                    return {"rows": tv.inventory_rows(ctx, mem=query.get("mem") == ["1"], with_plan=True)}
                rp = re.fullmatch(r"/runs/([0-9]{8}-[0-9]{6})/revert-plan", sub or "")
                if name and rp:
                    ctx = app.ctx(name)
                    acts = tv.revert_plan(ctx, tv.load_run(name, rp.group(1)))
                    return {"actions": tv.public(acts)}
                rm = re.fullmatch(r"/runs/([0-9]{8}-[0-9]{6})", sub or "")
                if name and rm:
                    run_path = tv.STATE_DIR / name / "runs" / f"{rm.group(1)}.json"
                    return json.loads(run_path.read_text())
                if name and sub == "/keys":
                    return app.keys_view(name)
                if name and sub == "/prepare":
                    return app.prepare_view(name, build=query.get("build") != ["0"])
                if name and sub == "/dial":
                    prof = tv.load_profile(name)
                    apps = tv.roku_apps(prof) if tv.platform_of(prof) == "roku" else tv.dial_apps(prof)
                    return {"apps": apps, "caps": tv.platform_caps(prof)}
                if name and sub == "/store":
                    return tv.store_view(app.ctx(name))
                if path == "/api/catalog":
                    return tv.load_catalog()
                if path == "/api/workflow-meta":
                    cat = tv.load_catalog()
                    return {"steps": tv.STEPS, "recipes": tv.RECIPES,
                            "launchers": [{"id": i, "name": a["name"]} for i, a in cat.items() if a.get("home")],
                            "screensavers": [{"id": i, "name": a["name"]} for i, a in cat.items() if a.get("dream")]}
            if method == "POST":
                body = self._body()
                try:
                    if path == "/api/ask":
                        desk.seen()
                        return desk.ask(body)
                    if path == "/api/inbox":
                        return desk.inbox_add(body)
                    if path == "/api/notify":
                        desk.seen()
                        return desk.notify(body)
                    if am and am.group(3) == "answer":
                        return desk.answer(am.group(2), body.get("answer"))
                    if am and am.group(3) == "cancel":
                        return desk.cancel(am.group(2), body.get("reason", "cancelled"))
                    if am and am.group(3) == "reply":
                        desk.seen()
                        return desk.inbox_reply(am.group(2), body.get("text", ""), bool(body.get("done")))
                    if am and am.group(3) == "dismiss":
                        return desk.dismiss(am.group(2))
                except (ValueError, KeyError) as e:
                    raise tv.TvError(f"agent desk: {e}")
                if path == "/api/ingest":
                    app.ingest(body)
                    return {"ok": True}
                if path == "/api/find":
                    cidr = body.get("cidr") or None
                    if cidr and not all(re.fullmatch(r"\d+\.\d+\.\d+\.\d+/(2[4-9]|3[0-2])", c) for c in cidr):
                        raise tv.TvError("networks must look like 192.168.1.0/24 (at most 256 addresses each)")
                    nets, found = tv.find_tvs(cidr)
                    return {"networks": nets, "found": found}
                if path == "/api/pair":
                    return {"output": tv.adb_pair(str(body.get("host", "")), int(body.get("port", 0)), body.get("code", ""))}
                if path == "/api/init":
                    data = tv.init_tv(body["name"], body["host"], int(body.get("port", 5555)), wait=90,
                                      platform=body.get("platform", "auto"))
                    app.bus.publish({"type": "log", "tv": data["name"], "level": "info",
                                     "msg": f"new TV {data['name']}: {data['model']}"})
                    return data
                if name and sub == "/run":
                    mode = body.get("mode", "apply")
                    if mode not in ("apply", "plan", "verify", "restore", "revert", "app"):
                        raise tv.TvError("bad mode")
                    options = {}
                    if mode in ("apply", "plan") and body.get("steps"):
                        options["steps"] = tv.parse_steps(only=",".join(body["steps"]))
                    if mode == "app":
                        if body.get("app_action") not in ("install", "uninstall", "update") or \
                                not re.fullmatch(r"[A-Za-z0-9_.-]+", str(body.get("app", ""))):
                            raise tv.TvError("app run needs app_action install|uninstall and an app id/package")
                        # the dashboard asked "are you sure?" before an uninstall
                        options = {"app_action": body["app_action"], "app": body["app"],
                                   "track": body.get("track", True), "yes": True}
                        body["measure"] = False
                    if mode == "revert":
                        tv.load_run(name, str(body.get("run_id", "")))  # validates the id
                        options = {"revert_run": body["run_id"], "keep_reverted": bool(body.get("keep"))}
                    return app.start_job(name, mode, bool(body.get("reboot")), body.get("measure", True), **options)
                if name and sub == "/keys/capture":
                    return app.capture(name, max(5, min(int(body.get("seconds", 20)), 60)))
                km = re.fullmatch(r"/keys/(\d{1,4})(?:/(delete|try))?", sub or "")
                if name and km:
                    scan = int(km.group(1))
                    if km.group(2) == "delete":
                        return app.save_key(name, scan, None)
                    if km.group(2) == "try":
                        tv.try_target(app.ctx(name), body)
                        return {"ok": True}
                    entry = {"label": str(body.get("label", ""))[:40]}
                    if body.get("action"):
                        entry.update(action=body["action"], package=body.get("package", ""))
                    else:
                        entry["open"] = body.get("open", "")
                    return app.save_key(name, scan, entry)
                if name and sub == "/address":
                    tv.set_tv_address(name, str(body.get("host", "")), int(body.get("port", 5555)))
                    return {"ok": True}
                if name and sub == "/home":
                    tv.set_home_settings(name, {k: body[k] for k in ("launcher", "screensaver", "animation_scale")
                                                if k in body})
                    return {"ok": True}
                if name and sub == "/discover":
                    prof = tv.load_profile(name)
                    d = tv.discover_network(prof) if tv.platform_of(prof) != "adb" else tv.discover(app.ctx(name))
                    app.bus.publish({"type": "prepare", "tv": name, "what": "dossier"})
                    return d
                if name and sub == "/guide/rebuild":
                    prof = tv.load_profile(name)
                    g = (tv.network_guide(prof, rebuild=True) if tv.platform_of(prof) != "adb"
                         else tv.load_guide(app.ctx(name), rebuild=True))
                    app.bus.publish({"type": "prepare", "tv": name, "what": "guide"})
                    return g
                if name and sub == "/guide/research":
                    return app.research(name)
                gm = re.fullmatch(r"/guide/([a-z0-9-]{1,41})/(verify|done|skip|reset|auto)", sub or "")
                if name and gm:
                    if gm.group(2) in ("done", "skip", "reset"):  # no TV needed for these
                        g = json.loads(tv.guide_path(name).read_text())
                        st = next((x for x in g["steps"] if x["id"] == gm.group(1)), None)
                        if not st:
                            raise tv.TvError("no such step")
                        st["status"] = {"done": "done", "skip": "skipped", "reset": "todo"}[gm.group(2)]
                        tv.guide_path(name).write_text(json.dumps(g, indent=1))
                    else:
                        g = tv.guide_step_action(app.ctx(name), gm.group(1), gm.group(2))
                    app.bus.publish({"type": "prepare", "tv": name, "what": "guide"})
                    return g
                dm = re.fullmatch(r"/dial/([A-Za-z0-9+._-]{1,40})/(launch|stop)", sub or "")
                if name and dm:
                    prof = tv.load_profile(name)
                    if tv.platform_of(prof) == "roku":
                        req = urllib.request.Request(f"http://{prof['tv']['host']}:8060/launch/{dm.group(1)}", data=b"", method="POST")
                        urllib.request.urlopen(req, timeout=5).read()
                    else:
                        tv.dial_control(prof, dm.group(1), dm.group(2))
                    return {"ok": True}
                if name and sub == "/key":
                    key = str(body.get("key", ""))
                    if not re.fullmatch(r"[a-z]{2,8}", key):
                        raise tv.TvError("bad key")
                    tv.send_key(tv.load_profile(name), key)
                    return {"ok": True}
                if name and sub == "/measure":
                    return app.measure(name)
                if name and sub == "/apps":
                    tv.set_app_decision(name, body["package"], body["decision"])
                    return {"ok": True}
                if name and sub == "/open":
                    pkg = str(body.get("package", ""))
                    if not re.fullmatch(r"[A-Za-z0-9_.]+", pkg):
                        raise tv.TvError("bad package name")
                    tv.try_target(app.ctx(name), {"open": pkg})
                    return {"ok": True}
                if name and sub == "/open-play":
                    pkg = body["package"]
                    if not re.fullmatch(r"[A-Za-z0-9_.]+", pkg):
                        raise tv.TvError("bad package name")
                    app.ctx(name).dev.sh(f"am start -a android.intent.action.VIEW -d market://details?id={pkg}")
                    return {"ok": True}
                rm = re.fullmatch(r"/api/run/([0-9-]+)/(confirm|continue|stop)", path)
                if rm:
                    job = app.job_for_run(rm.group(1))
                    if rm.group(2) == "confirm":
                        job.answer([int(i) for i in body.get("approved", [])])
                    elif rm.group(2) == "continue":
                        job.answer(True)
                    else:
                        job.stop()
                    return {"ok": True}
            raise tv.TvError(f"unknown endpoint {method} {path}")

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q, replay = app.bus.subscribe()
            try:
                for event in replay:
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.write(b"event: replayed\ndata: {}\n\n")
                self.wfile.flush()
                while True:
                    try:
                        event = q.get(timeout=15)
                        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                app.bus.unsubscribe(q)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return Handler


def serve(tv, port=None, open_browser=True):
    port = port or tv.UI_PORT
    tv.UI_PORT = port
    token = secrets.token_urlsafe(24)
    tv.STATE_DIR.mkdir(exist_ok=True)
    tv.UI_TOKEN_FILE.write_text(token)
    tv.UI_TOKEN_FILE.chmod(0o600)
    app = App(tv, token)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{port}"
    print(f"tv-override control center: {url}", flush=True)
    if open_browser:
        threading.Timer(0.5, lambda: subprocess.Popen(["open", url])).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if tv.UI_TOKEN_FILE.read_text().strip() == token:
                tv.UI_TOKEN_FILE.unlink()
        except OSError:
            pass
