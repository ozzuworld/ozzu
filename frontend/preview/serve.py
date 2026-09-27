#!/usr/bin/env python3
"""Preview server: static harness (index.html + dist/bundle.js) plus a proxy
of bridge API paths to the LOCAL bridge (127.0.0.1:3333 — loopback is keyless
by the bridge trust model). Single origin => no CORS in the headless browser,
and screens render against REAL live data.

Usage: python3 serve.py [port]   (default 8791)
"""
import http.server
import os
import socketserver
import sys
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
BRIDGE = "http://127.0.0.1:3333"
ROOT = os.path.dirname(os.path.abspath(__file__))

PROXY_PREFIXES = (
    "/soc", "/directives", "/business", "/ventures", "/infra", "/status",
    "/heartbeat", "/api", "/jobs", "/secop", "/health", "/mcp", "/files",
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith(PROXY_PREFIXES):
            try:
                with urllib.request.urlopen(BRIDGE + self.path, timeout=20) as r:
                    body = r.read()
                    ctype = r.headers.get("Content-Type", "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:  # noqa: BLE001 — preview tooling
                msg = f"proxy error: {exc}".encode()
                self.send_response(502)
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            return
        return super().do_GET()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"preview server listening on 127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
