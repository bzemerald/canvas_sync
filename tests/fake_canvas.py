"""An in-memory fake Canvas server, plus helpers shared by the tests."""

from __future__ import annotations

import asyncio
import re
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
            "/api/v1/users/self": lambda: {"name": "Test"},
            "/api/v1/courses": lambda: [self.course],
            "/api/v1/courses/1": lambda: self.course,
            "/api/v1/courses/1/folders": lambda: self.folders,
            "/api/v1/courses/1/modules": lambda: self.modules,
            "/api/v1/courses/1/pages": lambda: [{"url": u} for u in self.pages],
            "/api/v1/courses/1/assignments": lambda: self.assignments,
            "/api/v1/announcements": lambda: self.announcements,
        }
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
