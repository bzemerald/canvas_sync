"""Links that open things in the app, for an AI assistant to give the student (agent.py).

The app's own scheme, canvas-sync://open?type=doc&course=1&kind=assignment&id=2 (the app's
`thingOfLink`), isn't clickable in AI apps: Claude and Codex show such a link as plain text. So
the assistant is given http://127.0.0.1:<PORT>/open?<the same>, served by `canvas mcp` itself,
which is running whenever its assistant is: it hands the link to the system as canvas-sync://,
which brings the app forward (or starts it) and opens the thing there.

Every `canvas mcp` (one per AI app) tries for the port; one gets it, the rest try again now and
then, in case that one's app quits.
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

from .things import Thing, parse

PORT = 47630
RETRY = 30  # seconds between tries for the port

HANDOFF = 0.5  # seconds: the browser comes forward with the page, then the app over it
# (It closes itself where the browser lets it: a tab with nothing to go back to.)
PAGE = """<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>Canvas Sync</title>
<body style="font: 15px -apple-system, system-ui, sans-serif; color: #888; text-align: center; padding-top: 30vh">
{}<script>setTimeout(() => window.close(), 1000)</script></body>"""


def scheme_link(thing: Thing) -> str | None:
    """canvas-sync://open?... (None for links and searches: those aren't the app's to open)."""
    if thing.type in ("link", "search"):
        return None
    return "canvas-sync://open?" + urlencode(thing.to_dict())


def link(thing: Thing) -> str | None:
    """What the assistant gives the student: a clickable link to `scheme_link`."""
    s = scheme_link(thing)
    return s and f"http://127.0.0.1:{PORT}/open?" + s.split("?", 1)[1]


def thing_of(query: str) -> Thing | None:
    d: dict[str, Any] = dict(parse_qsl(query))
    for k in ("course", "module", "tool"):
        if k in d and d[k].isdigit():
            d[k] = int(d[k])
    return parse(d)


def open_url(url: str) -> None:
    """The system's handler of a URL (here, the app)."""
    if sys.platform == "darwin":
        subprocess.run(["open", url], check=False)
    elif sys.platform == "win32":
        import os
        os.startfile(url)  # type: ignore[attr-defined]
    else:
        subprocess.run(["xdg-open", url], check=False)


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        url = urlsplit(self.path)
        thing = thing_of(url.query) if url.path == "/open" else None
        target = thing and scheme_link(thing)
        body = PAGE.format("Opened in Canvas Sync. You can close this tab." if target else "Not a Canvas Sync link.")
        self.send_response(200 if target else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())
        self.wfile.flush()
        if target:
            time.sleep(HANDOFF)
            open_url(target)

    def log_message(self, *args: Any) -> None:
        pass  # (stderr is the assistant's log)


def serve_in_background() -> None:
    """Serves the links while this process runs, once it has the port."""
    def run() -> None:
        while True:
            try:
                server = ThreadingHTTPServer(("127.0.0.1", PORT), _Handler)
            except OSError:  # another assistant's has it
                time.sleep(RETRY)
                continue
            server.serve_forever()
    threading.Thread(target=run, daemon=True, name="links").start()
