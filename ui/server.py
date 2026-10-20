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
    def __init__(self, app, tv_name, mode, reboot, measure):
        self.app, self.tv, self.mode = app, tv_name, mode
        self.run_id = None
        self.state = "starting"
        self.confirm_items, self.waiting_items = None, None
        self._answer = None
        self._event = threading.Event()
        self._stop = False
        self.wf = app.tv.Workflow(tv_name, mode, self, reboot=reboot, measure=measure, source="ui")

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
        return {"name": name, "host": t["host"], "port": t.get("port", 5555), "model": t.get("model", ""),
                "presets": t.get("presets", []), "launcher": prof["home"].get("launcher"),
                "runs": len(runs), "last_run": last and {k: last.get(k) for k in
                                                        ("id", "mode", "outcome", "finished", "source")},
                "ram_freed_mb": freed[0] if freed else None, "perf": self.latest_perf(name),
                "job": self.jobs[name].public() if name in self.jobs else None}

    def state(self):
        names = self.profiles()
        with ThreadPoolExecutor(max_workers=8) as pool:
            summaries = list(pool.map(self.tv_summary, names))
            online = list(pool.map(lambda s: _port_open(s["host"], s["port"]), summaries))
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

    def start_job(self, name, mode, reboot, measure):
        with self.lock:
            if name in self.jobs:
                raise self.tv.TvError(f"a {self.jobs[name].mode} run is already active on {name}")
            job = Job(self, name, mode, reboot, measure)
            self.jobs[name] = job
        job.start()
        return job.public()

    def job_for_run(self, run_id):
        for job in self.jobs.values():
            if job.run_id == run_id:
                return job
        raise self.tv.TvError("no active run with that id (finished, or started from the terminal)")

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
                rm = re.fullmatch(r"/runs/([0-9]{8}-[0-9]{6})", sub or "")
                if name and rm:
                    run_path = tv.STATE_DIR / name / "runs" / f"{rm.group(1)}.json"
                    return json.loads(run_path.read_text())
                if path == "/api/catalog":
                    return tv.load_catalog()
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
                    nets, found = tv.find_tvs(body.get("cidr") or None)
                    known = {s["host"]: s["name"] for s in app.state()["tvs"]}
                    for f in found:
                        f["profile"] = known.get(f["host"])
                    return {"networks": nets, "found": found}
                if path == "/api/init":
                    data = tv.init_tv(body["name"], body["host"], int(body.get("port", 5555)), wait=90)
                    app.bus.publish({"type": "log", "tv": data["name"], "level": "info",
                                     "msg": f"new TV {data['name']}: {data['model']}"})
                    return data
                if name and sub == "/run":
                    mode = body.get("mode", "apply")
                    if mode not in ("apply", "plan", "verify", "restore"):
                        raise tv.TvError("bad mode")
                    return app.start_job(name, mode, bool(body.get("reboot")), body.get("measure", True))
                if name and sub == "/measure":
                    return app.measure(name)
                if name and sub == "/apps":
                    tv.set_app_decision(name, body["package"], body["decision"])
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
