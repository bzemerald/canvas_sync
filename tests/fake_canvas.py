"""An in-memory fake Canvas server, plus helpers shared by the tests."""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path

import httpx

from canvas_sync import CanvasClient, Engine
from canvas_sync.plan import Scope

BASE = "https://canvas.test"
COURSE = "Fall 2026/MATH 221"


class FakeCanvas:
    def __init__(self) -> None:
        self.course = {"id": 1, "name": "Linear Algebra", "course_code": "MATH 221", "term": {"name": "Fall 2026"}}
        self.folders = [{"id": 10, "full_name": "course files"}, {"id": 11, "full_name": "course files/Lectures"}]
        self.files: dict[int, dict] = {}
        self.modules: list[dict] = []
        self.pages: dict[str, dict] = {}
        self.assignments: list[dict] = []
        self.announcements: list[dict] = []
        self.files_tab_hidden = False
        self.media: dict[str, tuple[bytes, str]] = {}  # other paths: (body, content type)
        self.modules_status = 200  # e.g. 400 (a failure) or 404 (modules turned off)
        self.tabs: list[dict] | None = None  # None: the tabs endpoint 404s
        self.tabs_status = 200
        self.launches: list[dict] = []  # sessionless launches asked for
        self.launch_status = 200
        self.launch_url = f"{BASE}/courses/1/external_tools/sessionless_launch?verifier=v"
        self.seen_auth: list[str | None] = []
        self.valid_tokens: set[str] | None = None  # None: any token works

    def put(self, fid: int, name: str, content: bytes, folder: int = 11, version: str = "2026-09-01T00:00:00Z",
            listed: bool = True) -> None:
        """listed=False: not in the Files tab (only reachable from a module or a link)."""
        self.files[fid] = {
            "id": fid, "display_name": name, "folder_id": folder, "size": len(content),
            "modified_at": version, "url": f"{BASE}/files/{fid}/download?verifier=x", "_content": content,
            "_unlisted": not listed,
        }

    def module(self, position: int, name: str, items: list[dict]) -> None:
        self.modules.append({"id": position, "position": position, "name": name, "items": items})

    def handle(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        public = lambda f: {k: v for k, v in f.items() if not k.startswith("_")}  # noqa: E731
        routes = {
            "/api/v1/users/self": lambda: {"id": 42, "name": "Test"},
            "/api/v1/courses": lambda: [self.course],
            "/api/v1/courses/1": lambda: self.course,
            "/api/v1/courses/1/folders": lambda: self.folders,
            "/api/v1/courses/1/modules": lambda: self.modules,
            "/api/v1/courses/1/pages": lambda: [{"url": u} for u in self.pages],
            "/api/v1/courses/1/assignments": lambda: self.assignments,
            "/api/v1/announcements": lambda: self.announcements,
        }
        self.seen_auth.append(req.headers.get("authorization"))
        if self.valid_tokens is not None and req.headers.get("authorization") not in {f"Bearer {t}" for t in self.valid_tokens}:
            return httpx.Response(401, json={"errors": [{"message": "Invalid access token."}]})
        if path == "/api/v1/courses/1/modules" and self.modules_status != 200:
            return httpx.Response(self.modules_status, json={"errors": [{"message": "nope"}]})
        if path == "/api/v1/courses/1/tabs" and self.tabs is not None:
            if self.tabs_status != 200:
                return httpx.Response(self.tabs_status, json={"errors": [{"message": "nope"}]})
            return httpx.Response(200, json=self.tabs)
        if path == "/api/v1/courses/1/external_tools/sessionless_launch":
            self.launches.append(dict(req.url.params))
            if self.launch_status != 200:
                return httpx.Response(self.launch_status, json={"errors": [{"message": "nope"}]})
            return httpx.Response(200, json={"id": 5, "name": "Tool", "url": self.launch_url})
        if path in self.media:
            body, ctype = self.media[path]
            return httpx.Response(200, content=body, headers={"content-type": ctype})
        if path in routes:
            return httpx.Response(200, json=routes[path]())
        if path == "/api/v1/courses/1/files":
            if self.files_tab_hidden:
                return httpx.Response(403, json={"errors": [{"message": "unauthorized"}]})
            return httpx.Response(200, json=[public(f) for f in self.files.values() if not f.get("_unlisted")])
        if (m := re.fullmatch(r"/api/v1/courses/1/files/(\d+)", path)) and int(m[1]) in self.files:
            return httpx.Response(200, json=public(self.files[int(m[1])]))
        if (m := re.fullmatch(r"/api/v1/courses/1/pages/(.+)", path)) and m[1] in self.pages:
            return httpx.Response(200, json=self.pages[m[1]])
        if (m := re.fullmatch(r"/files/(\d+)/download", path)) and int(m[1]) in self.files:
            return httpx.Response(200, content=self.files[int(m[1])]["_content"])
        return httpx.Response(404, json={"errors": [{"message": "not found"}]})


def pull(root: Path, fake: FakeCanvas, scope: Scope | None = None):
    async def go():
        async with CanvasClient(BASE, "t", transport=httpx.MockTransport(fake.handle)) as client:
            with Engine(root, client) as engine:
                plan = await engine.plan(scope=scope)
                errors = await engine.apply(plan)
                assert errors == []
                return plan

    return asyncio.run(go())


def wait_for_sync(c) -> dict:
    """Wait for a sync started through the app's API (a TestClient) to finish."""
    for _ in range(200):
        state = c.get("/api/sync").json()
        if not state["running"]:
            return state
        time.sleep(0.02)
    raise AssertionError("sync did not finish")


def kinds(plan) -> list[tuple[str, str | None]]:
    return sorted((a.kind.value, a.path) for a in plan.actions)


def set_config(root: Path, old: str, new: str) -> None:
    cfg = root / ".canvas" / "config.toml"
    text = cfg.read_text()
    assert old in text
    cfg.write_text(text.replace(old, new))


def make_pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)
