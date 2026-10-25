"""Phone camera: a phone on the home Wi-Fi pointed at the TV stands in for screenshots on TVs that can't take
them (everything without ADB: Samsung, Vestel/JVC, LG, Roku).

The dashboard starts it on demand: a small HTTPS server on the LAN (phones only allow the camera on secure
pages, so it uses a self-signed certificate made with openssl). The page lives at a random path that changes
every start, answers only private-network addresses, and only accepts JPEG frames. The newest frame is kept in
state/<tv>/phonecam/latest.jpg, where the live screen and `tvctl screenshot` read it. It stops after 20 minutes
without frames. Idea from github.com/victaphu/glass-home-samsung-tv (tools/phonecam.py).
"""

import ipaddress
import os
import secrets
import socket
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("TVCTL_PHONECAM_PORT", "8443"))
IDLE_STOP = 20 * 60
MAX_FRAME = 8 * 1024 * 1024

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>TV camera</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#000;color:#d7ffe4;font:16px/1.4 ui-monospace,Menlo,monospace}
 video{width:100vw;height:100vh;object-fit:contain;display:block}
 #bar{position:fixed;left:0;right:0;bottom:0;padding:14px 16px calc(14px + env(safe-area-inset-bottom));background:rgba(0,0,0,.72)}
 button{font:700 18px ui-monospace,Menlo,monospace;padding:12px 20px;border-radius:10px;border:1px solid #3ddc84;background:#0b1f12;color:#3ddc84}
 b{color:#3ddc84}
</style></head><body>
<video id="v" playsinline muted autoplay></video>
<div id="bar"><button id="go">START CAMERA</button>
 <div id="s">Point the back camera at the TV, then tap start. <b>__TV__</b></div></div>
<script>
const v = document.getElementById('v'), s = document.getElementById('s'), go = document.getElementById('go');
let sent = 0, lock = null;
async function awake() { try { lock = await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') awake(); });
go.onclick = async () => {
  go.disabled = true;
  try {
    v.srcObject = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    await v.play(); await awake(); go.hidden = true; loop();
  } catch (e) { s.textContent = 'Camera error: ' + e.name + ' ' + e.message; go.disabled = false; }
};
async function loop() {
  const c = document.createElement('canvas');
  for (;;) {
    if (v.videoWidth && document.visibilityState === 'visible') {
      const k = Math.min(1, 1280 / v.videoWidth);
      c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.78));
      try {
        const res = await fetch(location.pathname + '/frame', { method: 'POST', body: blob });
        if (res.status === 403 || res.status === 404) { s.textContent = 'This camera link has ended. Open the new one from the control center.'; return; }
        sent++;
        s.innerHTML = 'Sending to the control center: <b>' + sent + '</b> frames. Keep this page open and the phone still.';
      } catch (e) { s.textContent = 'Connection lost, retrying… ' + e.message; }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}
</script></body></html>"""


def lan_ip(toward):
    """This computer's address on the network that reaches `toward` (the phone is on the same Wi-Fi)."""
    for host in (toward, "1.1.1.1"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((host, 9))
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    return ip
        except OSError:
            continue
    return "127.0.0.1"


class PhoneCam:
    def __init__(self, tv, bus):
        self.tv, self.bus = tv, bus
        self.server, self.name, self.path, self.url = None, None, None, None
        self.frames, self.last, self.started = 0, 0.0, 0.0
        self.lock = threading.Lock()
        self.cert_dir = tv.STATE_DIR / ".phonecam"

    def frame_file(self, name):
        return self.tv.STATE_DIR / name / "phonecam" / "latest.jpg"

    def latest(self, name):
        """(taken, jpeg bytes) of the newest phone frame of this TV, or None."""
        f = self.frame_file(name)
        try:
            return f.stat().st_mtime, f.read_bytes()
        except OSError:
            return None

    def status(self):
        return {"running": bool(self.server), "tv": self.name, "url": self.url, "frames": self.frames,
                "last": self.last or None, "port": PORT}

    def _cert(self):
        cert, key = self.cert_dir / "cert.pem", self.cert_dir / "key.pem"
        if not (cert.exists() and key.exists()):
            self.cert_dir.mkdir(parents=True, exist_ok=True)
            r = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
                                "-subj", "/CN=tv-override phone camera", "-keyout", str(key), "-out", str(cert)],
                               capture_output=True, text=True, timeout=60)
            if r.returncode:
                raise self.tv.TvError(f"could not make the camera certificate (openssl): {r.stderr.strip()[-200:]}")
            key.chmod(0o600)
        return cert, key

    def start(self, name):
        with self.lock:
            prof = self.tv.load_profile(name)
            if self.server:
                self.name = name  # same page, now feeding this TV
                self._publish()
                return self.status()
            cert, key = self._cert()
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            try:
                server = ThreadingHTTPServer(("0.0.0.0", PORT), self._handler())
            except OSError as e:
                raise self.tv.TvError(f"port {PORT} is busy ({e}); set TVCTL_PHONECAM_PORT to another port")
            server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
            server.daemon_threads = True
            self.server, self.name = server, name
            self.path = "/cam/" + secrets.token_urlsafe(6)
            self.url = f"https://{lan_ip(prof['tv']['host'])}:{PORT}{self.path}"
            self.frames, self.last, self.started = 0, 0.0, time.time()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            threading.Thread(target=self._watchdog, args=(server,), daemon=True).start()
        self._publish()
        return self.status()

    def stop(self):
        with self.lock:
            server, self.server, self.url, self.path = self.server, None, None, None
        if server:
            server.shutdown()
            server.server_close()
        self._publish()
        return self.status()

    def _watchdog(self, server):
        while self.server is server:
            time.sleep(30)
            if self.server is server and time.time() - max(self.last, self.started) > IDLE_STOP:
                self.stop()

    def _publish(self):
        self.bus.publish({"type": "phonecam", **self.status()})

    def _save(self, data):
        name = self.name
        f = self.frame_file(name)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, f)
        first = not self.frames
        self.frames += 1
        self.last = time.time()
        if first:
            self._publish()

    def _handler(self):
        cam = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "tv-override-camera"
            timeout = 20

            def log_message(self, fmt, *args):
                pass

            def _send(self, code, body, ctype="text/plain"):
                data = body.encode() if isinstance(body, str) else body
                self.send_response(code)
                self.send_header("Content-Type", ctype + "; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(data)

            def _allowed(self):
                addr = ipaddress.ip_address(self.client_address[0])
                return (addr.is_private or addr.is_loopback) and cam.path is not None

            def do_GET(self):
                if not self._allowed():
                    return self._send(403, "forbidden")
                if cam.path and secrets.compare_digest(self.path.split("?")[0], cam.path):
                    tv = cam.name or ""
                    return self._send(200, PAGE.replace("__TV__", tv.replace("<", "")), "text/html")
                return self._send(404, "not found")

            def do_POST(self):
                if not self._allowed():
                    return self._send(403, "forbidden")
                if not (cam.path and secrets.compare_digest(self.path.split("?")[0], cam.path + "/frame")):
                    return self._send(404, "not found")
                n = int(self.headers.get("Content-Length") or 0)
                if not 0 < n <= MAX_FRAME:
                    return self._send(413, "frame too large")
                data = self.rfile.read(n)
                if not data.startswith(b"\xff\xd8"):
                    return self._send(415, "JPEG only")
                cam._save(data)
                return self._send(204, b"")

        return Handler
