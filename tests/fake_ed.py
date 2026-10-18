"""An in-memory fake Ed (edstem.org), answering as much of its API as ed.py reads."""

from __future__ import annotations

import httpx

TOKEN = "ed-token"
HOSTS = {"us": "us.edstem.org", "eu": "eu.edstem.org", "au": "edstem.org"}


class FakeEd:
    def __init__(self, region: str = "us") -> None:
        self.region = region  # where the account is: other regions don't know the token
        self.token = TOKEN
        self.user = {"id": 7, "name": "Ann Ed"}
        self.courses: list[dict] = []
        self.status = 200  # e.g. 500, to fail every request
        self.requests: list[str] = []

    def course(self, cid: int, code: str, name: str, session: str = "Fall", year: str = "2026",
               status: str = "active", role: str = "student") -> None:
        self.courses.append({"course": {"id": cid, "code": code, "name": name, "session": session, "year": year,
                                        "status": status}, "role": {"role": role}})

    def handle(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(f"{req.url.host}{req.url.path}")
        if not req.headers.get("user-agent"):
            return httpx.Response(403, text="<html>blocked</html>", headers={"content-type": "text/html"})
        if self.status != 200:
            return httpx.Response(self.status)
        if req.url.host != HOSTS[self.region] or req.headers.get("authorization") != f"Bearer {self.token}":
            return httpx.Response(400, json={"code": "bad_token", "message": "Invalid token"})  # (as Ed says it)
        if req.url.path == "/api/user":
            return httpx.Response(200, json={"user": self.user, "courses": self.courses})
        return httpx.Response(404, json={"code": "not_found"})
