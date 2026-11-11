"""Thin async client for the Canvas REST API."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx

MAX_ATTEMPTS = 5
# Canvas refills a per-token bucket (~700 units). Below this many we start pacing ourselves.
RATE_LIMIT_FLOOR = 150


class CanvasError(Exception):
    def __init__(self, status: int, url: str, message: str = "", signed_out: bool = False):
        super().__init__(f"HTTP {status} for {url}" + (f": {message}" if message else ""))
        self.status = status
        self.url = url
        # Canvas no longer takes the token or sign-in (not: a course turned something off,
        # which is a 401 too). Nothing fetched after it means anything.
        self.signed_out = signed_out


@dataclass(frozen=True)
class Auth:
    """How we sign in to Canvas: an access token, or the cookies of a sign-in in a browser window
    (for schools that don't let students make tokens). Kept in the keychain as one string."""

    token: str | None = None
    cookies: dict[str, str] | None = None

    @property
    def kind(self) -> str:
        return "session" if self.cookies is not None else "token"

    def secret(self) -> str:
        return json.dumps({"cookies": self.cookies}) if self.cookies is not None else self.token or ""

    @classmethod
    def parse(cls, secret: str) -> Auth:
        if secret.startswith("{"):  # (a token never does)
            return cls(cookies=dict(json.loads(secret).get("cookies") or {}))
        return cls(token=secret)

    def client_args(self, base_url: str) -> dict[str, Any]:
        """For an httpx client of that Canvas: the token as a header, or the cookies, for its
        host only (so they don't follow a download to file storage)."""
        if self.cookies is None:
            return {"headers": {"Authorization": f"Bearer {self.token}"}}
        jar = httpx.Cookies()
        host = httpx.URL(base_url).host
        for name, value in self.cookies.items():
            jar.set(name, value, domain=host)
        return {"cookies": jar}


def signed_out(resp: httpx.Response) -> bool:
    """Sent to the sign-in page: a browser sign-in that has expired."""
    return resp.url.path.startswith("/login")


def parse_json(resp: httpx.Response) -> Any:
    """Canvas starts JSON with `while(1);` for requests signed in with cookies."""
    text = resp.text
    return json.loads(text[len("while(1);"):] if text.startswith("while(1);") else text)


class _Retry(Exception):
    pass


def _is_retryable(resp: httpx.Response) -> bool:
    if resp.status_code == 429 or resp.status_code >= 500:
        return True
    # Canvas signals throttling as 403 with this body rather than 429.
    return resp.status_code == 403 and "rate limit exceeded" in resp.text.lower()


def _raise_for(resp: httpx.Response) -> None:
    if signed_out(resp):
        raise CanvasError(401, str(resp.url), "signed out", signed_out=True)
    if resp.is_success:
        return
    message, status = "", None
    try:
        body = parse_json(resp)
        status, errors = body.get("status"), body.get("errors")
        if isinstance(errors, list) and errors:
            message = errors[0].get("message", "")
        elif isinstance(errors, dict):
            message = str(errors)
    except Exception:
        pass
    gone = resp.status_code == 401 and (status == "unauthenticated" or "invalid access token" in message.lower())
    raise CanvasError(resp.status_code, str(resp.url), message, signed_out=gone)


class CanvasClient:
    """Async Canvas client: pagination, bounded concurrency, rate-limit backoff.

    Canvas throttles per token and reports what's left in `X-Rate-Limit-Remaining`;
    when that runs low we pause briefly instead of collecting 403s.
    """

    def __init__(
        self,
        base_url: str,
        auth: Auth | str,  # (a str: a token)
        *,
        concurrency: int = 6,
        download_concurrency: int = 4,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.auth = Auth(token=auth) if isinstance(auth, str) else auth
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            # httpx drops the token's header when a download redirects to another host (S3 etc.).
            **self.auth.client_args(self.base_url),
            follow_redirects=True,
            timeout=httpx.Timeout(60, connect=15),
            transport=transport,
        )
        self._api_slots = asyncio.Semaphore(concurrency)
        self._download_slots = asyncio.Semaphore(download_concurrency)
        self._resume_at = 0.0

    async def __aenter__(self) -> CanvasClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    def cookies(self) -> dict[str, str] | None:
        """A browser sign-in's cookies as they are now (Canvas may have renewed them)."""
        if self.auth.cookies is None:
            return None
        host = httpx.URL(self.base_url).host
        return {c.name: c.value or "" for c in self._http.cookies.jar if c.domain.lstrip(".") == host}

    # -- plumbing ---------------------------------------------------------------

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        for attempt in range(MAX_ATTEMPTS):
            resp = None
            async with self._api_slots:
                pause = self._resume_at - time.monotonic()
                if pause > 0:
                    await asyncio.sleep(pause)
                try:
                    resp = await self._http.request(method, url, **kwargs)
                except httpx.TransportError:
                    if attempt == MAX_ATTEMPTS - 1:
                        raise
            if resp is not None:
                self._note_rate_limit(resp)
                if not _is_retryable(resp) or attempt == MAX_ATTEMPTS - 1:
                    return resp
            await asyncio.sleep(min(2**attempt, 30))
        raise AssertionError("unreachable")

    def _note_rate_limit(self, resp: httpx.Response) -> None:
        remaining = resp.headers.get("X-Rate-Limit-Remaining")
        if remaining is None:
            return
        try:
            if float(remaining) < RATE_LIMIT_FLOOR:
                self._resume_at = max(self._resume_at, time.monotonic() + 1.0)
        except ValueError:
            pass

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        resp = await self._request("GET", path, params=params)
        _raise_for(resp)
        return parse_json(resp)

    async def get_all(self, path: str, params: dict[str, Any] | None = None) -> list[Any]:
        """GET every page of a paginated endpoint (follows the `Link: rel=next` header)."""
        query: dict[str, Any] | None = {"per_page": 100, **(params or {})}
        url: str | None = path
        items: list[Any] = []
        while url:
            resp = await self._request("GET", url, params=query)
            _raise_for(resp)
            items.extend(parse_json(resp))
            url = resp.links.get("next", {}).get("url")
            query = None  # the next link already carries the query string
        return items

    async def fetch(self, url: str, max_bytes: int) -> tuple[bytes, str]:
        """GET a Canvas resource (an image in a page, say): its bytes and content type.
        Follows redirects to file storage; refuses anything over `max_bytes`."""
        async with self._api_slots:
            async with self._http.stream("GET", url) as resp:
                if not resp.is_success or signed_out(resp):
                    await resp.aread()
                    _raise_for(resp)
                body = bytearray()
                async for chunk in resp.aiter_bytes(1 << 16):
                    body += chunk
                    if len(body) > max_bytes:
                        raise CanvasError(413, url, "too large")
                return bytes(body), resp.headers.get("content-type", "application/octet-stream")

    async def download(self, url: str, dest: Path) -> str:
        """Stream `url` into `dest`; returns the sha256 of the content."""
        async with self._download_slots:
            for attempt in range(MAX_ATTEMPTS):
                try:
                    digest = hashlib.sha256()
                    async with self._http.stream("GET", url) as resp:
                        if resp.status_code == 429 or resp.status_code >= 500:
                            raise _Retry()
                        if not resp.is_success or signed_out(resp):  # (not the sign-in page, saved as the file)
                            await resp.aread()
                            _raise_for(resp)
                        with dest.open("wb") as fh:
                            async for chunk in resp.aiter_bytes(1 << 16):
                                fh.write(chunk)
                                digest.update(chunk)
                    return digest.hexdigest()
                except (httpx.TransportError, _Retry):
                    if attempt == MAX_ATTEMPTS - 1:
                        raise CanvasError(0, url, "download failed after retries")
                    await asyncio.sleep(min(2**attempt, 30))
        raise AssertionError("unreachable")

    # -- endpoints --------------------------------------------------------------

    async def me(self) -> dict[str, Any]:
        return await self.get("/api/v1/users/self")

    async def courses(self) -> list[dict[str, Any]]:
        return await self.get_all(
            "/api/v1/courses",
            {"enrollment_state": "active", "include[]": ["term", "favorites"]},
        )

    async def course(self, course_id: int, include: list[str] | None = None) -> dict[str, Any]:
        params = {"include[]": include} if include else None
        return await self.get(f"/api/v1/courses/{course_id}", params)

    async def folders(self, course_id: int) -> list[dict[str, Any]]:
        return await self.get_all(f"/api/v1/courses/{course_id}/folders")

    async def files(self, course_id: int) -> list[dict[str, Any]]:
        return await self.get_all(f"/api/v1/courses/{course_id}/files")

    async def file(self, course_id: int, file_id: int) -> dict[str, Any]:
        return await self.get(f"/api/v1/courses/{course_id}/files/{file_id}")

    async def modules(self, course_id: int) -> list[dict[str, Any]]:
        modules = await self.get_all(
            f"/api/v1/courses/{course_id}/modules", {"include[]": ["items"]}
        )
        # Canvas omits `items` for modules with too many; fetch those separately.
        missing = [m for m in modules if "items" not in m and m.get("items_url")]
        fetched = await asyncio.gather(*(self.get_all(m["items_url"]) for m in missing))
        for m, items in zip(missing, fetched):
            m["items"] = items
        return modules

    async def pages(self, course_id: int) -> list[dict[str, Any]]:
        return await self.get_all(f"/api/v1/courses/{course_id}/pages")

    async def page(self, course_id: int, url: str) -> dict[str, Any]:
        return await self.get(f"/api/v1/courses/{course_id}/pages/{url}")

    async def assignments(self, course_id: int) -> list[dict[str, Any]]:
        # With your submission: whether you handed it in, and its grade once posted.
        return await self.get_all(f"/api/v1/courses/{course_id}/assignments", {"include[]": ["submission"]})

    async def tabs(self, course_id: int) -> list[dict[str, Any]]:
        """The course's navigation menu as you see it, external tools (Gradescope, Ed...) included."""
        return await self.get(f"/api/v1/courses/{course_id}/tabs")

    async def sessionless_launch(self, course_id: int, params: dict[str, Any]) -> dict[str, Any]:
        """A one-time link that opens an external tool already signed in, without a Canvas
        login in the browser. params: id (+ launch_type), url, or launch_type=assessment with
        assignment_id / launch_type=module_item with module_item_id."""
        return await self.get(f"/api/v1/courses/{course_id}/external_tools/sessionless_launch", params)

    async def announcements(self, course_id: int) -> list[dict[str, Any]]:
        # Without explicit dates Canvas only returns the last two weeks.
        return await self.get_all(
            "/api/v1/announcements",
            {
                "context_codes[]": f"course_{course_id}",
                "start_date": "2000-01-01",
                "end_date": (date.today() + timedelta(days=366)).isoformat(),
            },
        )
