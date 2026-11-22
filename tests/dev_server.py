# -*- coding: utf-8 -*-
"""Runs the UI in a desktop browser against the real Python bridge (no Android needed):
    python3 -I tests/dev_server.py [port] [zip]    ->  http://127.0.0.1:8765/
The page gets a small shim that fakes the native side (file picker, export)."""
import http.server, json, os, sys, shutil, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'app', 'src', 'main', 'python'))
sys.path.insert(0, HERE)
import bridge, make_test_save

WWW = os.path.join(HERE, '..', 'app', 'src', 'main', 'assets', 'www')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
WORK = tempfile.mkdtemp()
ZIP = sys.argv[2] if len(sys.argv) > 2 else make_test_save.make_zip(os.path.join(WORK, 'save.zip'))
SHIM = """<script>
window.Android = {
  call(id, m, a) { fetch('/api/' + m, {method: 'POST', body: a}).then(r => r.text()).then(t => window.__resolve(id, t)); },
  pickZip() { setTimeout(() => window.onNative('picked', JSON.stringify({path: %s, name: 'save.zip'})), 50); },
  exportZip() { setTimeout(() => window.onNative('exported', JSON.stringify({ok: true, msg: 'Exportiert (dev)', final: true})), 50); },
  writeBack() { setTimeout(() => window.onNative('writeback', JSON.stringify({ok: true, msg: 'Original ersetzt (dev)', final: true})), 50); },
};
</script>""" % json.dumps(ZIP)

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WWW, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path in ('/', '/index.html'):
            body = open(os.path.join(WWW, 'index.html'), encoding='utf-8').read().replace('<script src="app.js">', SHIM + '<script src="app.js">').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            super().do_GET()
    def do_POST(self):
        method = self.path[len('/api/'):]
        args = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        out = bridge.call(method, args).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)

if __name__ == '__main__':
    print('serving', ZIP, 'on port', PORT, flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
