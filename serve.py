# Serves AIM 3D Studio Web on http://127.0.0.1:8642 (ES modules, workers and WebAssembly need http, not file://).
# Only this folder is served, only to this computer, without directory listings or the server's own scripts.
import errno
import functools
import http.server
import os
import posixpath
import urllib.parse
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8642
ROOT = os.path.dirname(os.path.abspath(__file__))
URL = f'http://127.0.0.1:{PORT}/'  # not "localhost": Windows may try IPv6 first, and the server listens on IPv4
HIDDEN = ('.py', '.bat', '.ps1', '.md')
DEV = '--dev' in sys.argv  # developer runs only: also serves test/ (photos for the browser tests)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json'}

    def send_head(self):
        # decoded and normalised first (%73erve.py, /a/../serve.py), compared in lower case (Windows ignores case)
        path = posixpath.normpath(urllib.parse.unquote(self.path.split('?', 1)[0].split('#', 1)[0])).lower()
        if self.path.split('?', 1)[0].endswith('/') and path != '/':
            path += '/'
        parts = [p for p in path.split('/') if p]
        name = parts[-1].rstrip('. ') if parts else ''  # Windows opens 'serve.py.' and 'serve.py ' as serve.py
        parts = [p.rstrip('. ') or p for p in parts]
        if any(p.startswith('.') for p in parts) or name.endswith(HIDDEN) or ('test' in parts and not DEV) or '\\' in path:
            self.send_error(404)
            return None
        if path.endswith('/') and path != '/':
            self.send_error(404)  # no directory listings
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)  # never list a folder, even / without index.html
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT))
    except OSError as e:
        if e.errno in (errno.EADDRINUSE, 10048):
            print(f'AIM 3D Studio Web is already running: {URL}')
            if '--no-browser' not in sys.argv:
                webbrowser.open(URL)
            sys.exit(0)
        raise
    print(f'AIM 3D Studio Web: {URL}  (Ctrl+C to stop)')
    if '--no-browser' not in sys.argv:
        webbrowser.open(URL)
    server.serve_forever()
