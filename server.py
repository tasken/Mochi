"""Dev HTTPS server for Mochi local development.

Usage (via invoke):
    inv serve

Direct usage:
    python3 server.py [--bind 0.0.0.0] [--port 8443] [--cert F] [--key F] [--host DISPLAY] [--directory DIR]
"""

import argparse
import errno
import functools
import http.server
import ssl
import subprocess


class _NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that disables client caching.

    Without this, Chrome heuristically caches HTML and CSS, so edits to
    `index.html` (or anything else) only show up after a hard reload. In
    dev that's confusing — clobber every cached response so a normal
    refresh always picks up the latest file.
    """

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def _port_owner(port):
    try:
        out = subprocess.check_output(
            ["ss", "-tlnp", f"sport = :{port}"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        for line in out.splitlines():
            if f":{port}" in line and "users:" in line:
                return line.strip()
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            ["lsof", "-nP", "-iTCP", f"-i:{port}", "-sTCP:LISTEN"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        lines = [l for l in out.splitlines() if l and not l.startswith("COMMAND")]
        if lines:
            return lines[0]
    except Exception:
        pass
    return None


def run(bind, port, certfile=None, keyfile=None, display_host=None, directory="app"):
    handler = functools.partial(_NoCacheHandler, directory=directory)
    try:
        httpd = http.server.ThreadingHTTPServer((bind, port), handler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            info = _port_owner(port)
            msg = f"error: port {port} is already in use."
            if info:
                msg += f"\n  {info}"
            raise SystemExit(msg) from None
        raise
    if certfile and keyfile:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(certfile, keyfile)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    else:
        scheme = "http"
    host = display_host or (bind if bind != "0.0.0.0" else "localhost")
    print(f"Serving {scheme}://{host}:{port}/ from {directory}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print("\nServer stopped.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--cert", default=None)
    ap.add_argument("--key", default=None)
    ap.add_argument("--host", default=None, help="Display hostname in the startup URL")
    ap.add_argument(
        "--directory", default="app", help="Directory to serve (default: app)"
    )
    args = ap.parse_args()
    run(args.bind, args.port, args.cert, args.key, args.host, args.directory)
