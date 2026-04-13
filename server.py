"""Dev HTTPS server for MochiNest local development.

Usage (via invoke):
    inv serve

Direct usage:
    python3 server.py [--bind 0.0.0.0] [--port 8443] [--cert F] [--key F] [--host DISPLAY]
"""
import argparse
import http.server
import os
import ssl
import subprocess


def _port_owner(port):
    """Return a human-readable description of what is using *port*, or None."""
    try:
        out = subprocess.check_output(
            ["ss", "-tlnp", f"sport = :{port}"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        # ss output: State  Recv-Q  Send-Q  Local Address:Port  ...  users:(("name",pid=N,...))
        for line in out.splitlines():
            if f":{port}" in line and "users:" in line:
                return line.strip()
    except Exception:
        pass
    # Fallback: lsof
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


def run(bind, port, certfile=None, keyfile=None, display_host=None):
    try:
        httpd = http.server.ThreadingHTTPServer((bind, port), http.server.SimpleHTTPRequestHandler)
    except OSError as exc:
        if exc.errno == 98:  # Address already in use
            info = _port_owner(port)
            msg = f"error: port {port} is already in use."
            if info:
                msg += f"\n  {info}"
            raise SystemExit(msg) from None
        raise
    if certfile and keyfile:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile, keyfile)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    else:
        scheme = "http"
    host = display_host or (bind if bind != "0.0.0.0" else "localhost")
    print(f"Serving {scheme}://{host}:{port}/")
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
    args = ap.parse_args()
    run(args.bind, args.port, args.cert, args.key, args.host)
