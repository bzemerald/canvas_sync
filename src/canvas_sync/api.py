"""Thin async client for the Canvas REST API."""

from __future__ import annotations

import asyncio
import hashlib
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx

MAX_ATTEMPTS = 5
# Canvas refills a per-token bucket (~700 units). Below this many we start pacing ourselves.
RATE_LIMIT_FLOOR = 150


class CanvasError(Exception):
    def __init__(self, status: int, url: str, message: str = ""):
        super().__init__(f"HTTP {status} for {url}" + (f": {message}" if message else ""))
        self.status = status
        self.url = url


class _Retry(Exception):
    pass


def _is_retryable(resp: httpx.Response) -> bool:
    if resp.status_code == 429 or resp.status_code >= 500:
        return True
    # Canvas signals throttling as 403 with this body rather than 429.
    return resp.status_code == 403 and "rate limit exceeded" in resp.text.lower()


def _raise_for(resp: httpx.Response) -> None:
    if resp.is_success:
        return
    message = ""
    try:
        errors = resp.json().get("errors")
        if isinstance(errors, list) and errors:
            message = errors[0].get("message", "")
        elif isinstance(errors, dict):
            message = str(errors)
    except Exception:
        pass
    raise CanvasError(resp.status_code, str(resp.url), message)


class CanvasClient:
    """Async Canvas client: pagination, bounded concurrency, rate-limit backoff.

    Canvas throttles per token and reports what's left in `X-Rate-Limit-Remaining`;
    when that runs low we pause briefly instead of collecting 403s.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        concurrency: int = 6,
        download_concurrency: int = 4,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            # httpx drops this header when a download redirects to another host (S3 etc.).
            headers={"Authorization": f"Bearer {token}"},
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
        return resp.json()

    async def get_all(self, path: str, params: dict[str, Any] | None = None) -> list[Any]:
        """GET every page of a paginated endpoint (follows the `Link: rel=next` header)."""
        query: dict[str, Any] | None = {"per_page": 100, **(params or {})}
        url: str | None = path
        items: list[Any] = []
        while url:
            resp = await self._request("GET", url, params=query)
            _raise_for(resp)
            items.extend(resp.json())
            url = resp.links.get("next", {}).get("url")
            query = None  # the next link already carries the query string
        return items

    async def download(self, url: str, dest: Path) -> str:
        """Stream `url` into `dest`; returns the sha256 of the content."""
        async with self._download_slots:
            for attempt in range(MAX_ATTEMPTS):
                try:
                    digest = hashlib.sha256()
                    async with self._http.stream("GET", url) as resp:
                        if resp.status_code == 429 or resp.status_code >= 500:
                            raise _Retry()
                        if not resp.is_success:
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
        return await self.get_all(f"/api/v1/courses/{course_id}/assignments")

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
