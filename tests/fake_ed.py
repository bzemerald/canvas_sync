"""An in-memory fake Ed (edstem.org), answering as much of its API as ed.py reads."""

from __future__ import annotations

import re

import httpx

TOKEN = "ed-token"
HOSTS = {"us": "us.edstem.org", "eu": "eu.edstem.org", "au": "edstem.org"}


class FakeEd:
    def __init__(self, region: str = "us") -> None:
        self.region = region  # where the account is: other regions don't know the token
        self.token = TOKEN
        self.user = {"id": 7, "name": "Ann Ed"}
        self.courses: list[dict] = []
        self.threads: dict[int, list[dict]] = {}  # course -> its threads, newest first
        self.users: dict[int, dict] = {1: {"id": 1, "name": "Prof Ed", "course_role": "admin"},
                                        2: {"id": 2, "name": "Stu Dent", "course_role": "student"}}
        self.status = 200  # e.g. 500, to fail every request
        self.requests: list[str] = []

    def course(self, cid: int, code: str, name: str, session: str = "Fall", year: str = "2026",
               status: str = "active", role: str = "student") -> None:
        self.courses.append({"course": {"id": cid, "code": code, "name": name, "session": session, "year": year,
                                        "status": status}, "role": {"role": role}})

    def thread(self, course: int, tid: int, title: str, body: str = "<document version=\"2.0\"><paragraph>Hi</paragraph></document>",
               type: str = "post", user: int = 2, created: str = "2026-10-15T09:00:00+10:00", **more) -> dict:
        t = {"id": tid, "number": tid % 1000, "type": type, "title": title, "content": body, "created_at": created,
             "updated_at": "2026-10-17T00:00:00+11:00", "user_id": user, "category": "General", "subcategory": "",
             "is_pinned": False, "is_anonymous": False, "is_seen": False, "reply_count": 0, **more}
        self.threads.setdefault(course, []).insert(0, t)
        return t

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
        if m := re.fullmatch(r"/api/courses/(\d+)/threads", req.url.path):
            limit, offset = int(req.url.params.get("limit", 30)), int(req.url.params.get("offset", 0))
            page = self.threads.get(int(m[1]), [])[offset:offset + limit]
            users = [self.users[u] for u in {t["user_id"] for t in page} if u in self.users]
            return httpx.Response(200, json={"threads": page, "users": users, "sort_key": ""})
        return httpx.Response(404, json={"code": "not_found"})
