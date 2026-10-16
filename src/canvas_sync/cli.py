"""`canvas` command line. Formatting only; all logic lives in Engine."""

from __future__ import annotations

import asyncio
import json
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Optional, TypeVar

import typer
from rich.console import Console
from rich.markup import escape
from rich.progress import Progress
from rich.table import Table

from .api import CanvasClient, CanvasError
from .config import Account, ConfigError, set_course_listed
from .engine import Engine, NotInitialized
from .local import open_path
from .models import Course
from .plan import Kind, Plan, Scope
from .search import Hit
from .state import META_DIR

app = typer.Typer(help="Sync Canvas course files into a local folder.", no_args_is_help=True)
console = Console()
T = TypeVar("T")

STYLE = {
    Kind.DOWNLOAD: ("+", "green"),
    Kind.UPDATE: ("↻", "cyan"),
    Kind.CONFLICT: ("!", "yellow"),
    Kind.MOVE: ("→", "blue"),
    Kind.PIN: ("@", "blue"),
    Kind.IGNORE: ("-", "magenta"),
    Kind.REMOTE_DELETED: ("x", "red"),
    Kind.DELETE: ("x", "red"),
    Kind.SKIP: ("·", "dim"),
}


def fail(message: str) -> typer.Exit:
    console.print(f"[red]error:[/] {message}")
    return typer.Exit(1)


async def _value(x: T) -> T:
    return x


def account() -> Account:
    acc = Account.load()
    if acc is None:
        raise fail("not set up yet; run `canvas init`")
    return acc


def with_engine(online: bool, body: Callable[[Engine], Awaitable[T]]) -> T:
    """Open the engine (and a Canvas connection if needed), run `body`, clean up."""
    acc = account()

    async def go() -> T:
        client = None
        if online:
            token = acc.token()
            if not token:
                raise fail("no access token found; run `canvas init`")
            client = CanvasClient(acc.base_url, token)
        try:
            with Engine(acc.root, client) as engine:
                return await body(engine)
        finally:
            if client:
                await client.aclose()

    try:
        return asyncio.run(go())
    except (NotInitialized, ConfigError, LookupError) as e:
        raise fail(str(e))
    except CanvasError as e:
        hint = " (is the token still valid? `canvas init` to replace it)" if e.status == 401 else ""
        raise fail(f"{e}{hint}")


@app.command()
def init(
    url: Annotated[Optional[str], typer.Option(help="e.g. https://canvas.myschool.edu")] = None,
    root: Annotated[Optional[Path], typer.Option(help="Folder to sync into")] = None,
) -> None:
    """Connect to Canvas and choose the sync folder."""
    existing = Account.load()
    url = url or typer.prompt("Canvas URL", default=existing.base_url if existing else None)
    if not url.startswith("http"):
        url = "https://" + url
    console.print("Create a token in Canvas under Account → Settings → New Access Token.")
    token = typer.prompt("Access token", hide_input=True)
    root = root or Path(typer.prompt("Sync folder", default=str(existing.root) if existing else "~/Canvas"))

    async def check() -> dict:
        async with CanvasClient(url, token) as c:
            return await c.me()

    try:
        me = asyncio.run(check())
    except Exception as e:
        raise fail(f"could not log in to {url}: {e}")
    acc = Account(url.rstrip("/"), root.expanduser())
    acc.root = Engine.init_root(acc.root)
    acc.save()
    acc.set_token(token)
    console.print(f"Logged in as [bold]{me.get('name')}[/]. Syncing into [bold]{acc.root}[/].")
    console.print(f"Settings: {acc.root / META_DIR / 'config.toml'}")
    console.print("Next: `canvas courses` to check the course list, then `canvas pull`.")


@app.command()
def courses(
    sync: Annotated[Optional[list[int]], typer.Option("--sync", help="Always sync this course id")] = None,
    skip: Annotated[Optional[list[int]], typer.Option("--skip", help="Never sync this course id")] = None,
) -> None:
    """List your courses and which ones `pull` syncs."""
    cfg = account().root / META_DIR / "config.toml"
    for cid in sync or []:
        set_course_listed(cfg, cid, sync=True)
    for cid in skip or []:
        set_course_listed(cfg, cid, sync=False)

    async def body(engine: Engine) -> None:
        table = Table("sync", "id", "term", "code", "name", box=None)
        for c in sorted(await engine.courses(), key=lambda c: (c.term or "", c.code)):
            mark = "[green]✓[/]" if engine.is_selected(c) else "[dim]-[/]"
            table.add_row(mark, str(c.id), c.term or "", c.code, c.name)
        console.print(table)
        console.print("[dim]Change with `canvas courses --sync ID` / `--skip ID`.[/]")

    with_engine(True, body)


def pick_courses(all_courses: list[Course], wanted: list[str]) -> list[Course]:
    """Match each -c value against course id, code or name (case-insensitive substring)."""
    picked: dict[int, Course] = {}
    for w in wanted:
        hits = [c for c in all_courses if w == str(c.id) or w.lower() in f"{c.code} {c.name}".lower()]
        if not hits:
            raise fail(f"no course matches {w!r}; see `canvas courses`")
        picked.update((c.id, c) for c in hits)
    return list(picked.values())


def render_plan(plan: Plan, verbose: bool) -> None:
    names = {s.course.id: f"{s.course.term or ''} / {s.course.code}".strip(" /") for s in plan.snapshots}
    by_course = defaultdict(list)
    for a in plan.actions:
        by_course[a.course_id].append(a)
    for cid, actions in by_course.items():
        shown = [a for a in actions if a.kind in STYLE and (verbose or a.kind != Kind.SKIP)]
        links = sum(a.kind in (Kind.LINK, Kind.UNLINK) for a in actions)
        skipped = sum(a.kind == Kind.SKIP for a in actions)
        if not shown and not links and not skipped:
            continue
        console.print(f"[bold]{names.get(cid, cid)}[/]")
        for a in shown:
            sym, color = STYLE[a.kind]
            line = a.path or a.name
            if a.kind in (Kind.MOVE, Kind.PIN):
                line = f"{a.src} → {a.path}"
            if a.kind == Kind.CONFLICT:
                line += {
                    "rename_local": f"  [dim](your edits → {a.backup})[/]",
                    "rename_remote": f"  [dim](new version beside your copy at {a.src})[/]",
                }.get(a.resolution or "", f"  [dim]({a.reason})[/]")
            elif a.reason and a.kind != Kind.IGNORE:
                line += f"  [dim]({a.reason})[/]"
            console.print(f"  [{color}]{sym}[/] {line}")
        extra = [f"{links} view link change(s)"] * bool(links)
        extra += [f"{skipped} skipped (-v to list)"] * bool(skipped and not verbose)
        if extra:
            console.print(f"  [dim]{', '.join(extra)}[/]")
    for w in plan.warnings:
        console.print(f"[yellow]warning:[/] {w}")


@app.command()
def pull(
    paths: Annotated[Optional[list[Path]], typer.Argument(help="Only these folders or files (in the sync folder)")] = None,
    course: Annotated[Optional[list[str]], typer.Option("-c", "--course", help="Only these courses (id, code or name)")] = None,
    dry_run: Annotated[bool, typer.Option("--dry-run", "-n", help="Show what would happen, change nothing")] = False,
    verbose: Annotated[bool, typer.Option("-v", "--verbose", help="Also list skipped files")] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Print the plan as JSON")] = False,
) -> None:
    """Fetch new and changed files from Canvas."""

    async def body(engine: Engine) -> None:
        chosen = None
        if course:
            chosen = pick_courses(await engine.courses(), course)
        scope = Scope([engine.relative(p) for p in paths]) if paths else None
        if scope and not engine.courses_in(scope):
            raise fail("nothing there that canvas-sync has synced before")
        with console.status("Checking Canvas…"):
            plan = await engine.plan(chosen, scope)
        if as_json:
            print(json.dumps(plan.to_dict(), indent=2))
        else:
            render_plan(plan, verbose)
        work = [a for a in plan.actions if a.kind != Kind.SKIP]
        if not work:
            if not dry_run:
                # No files to fetch, but announcements, assignments, pages and modules may be new.
                await engine.apply(plan)
                reindex(engine)
            if not as_json:
                console.print("Already up to date.")
            return
        if dry_run:
            return
        transfers = sum(a.kind in (Kind.DOWNLOAD, Kind.UPDATE, Kind.CONFLICT) for a in work)
        with Progress(console=console, transient=True) as progress:
            task = progress.add_task("Downloading", total=transfers)

            def on_event(a, error):
                if a.kind in (Kind.DOWNLOAD, Kind.UPDATE, Kind.CONFLICT):
                    progress.advance(task)
                if error:
                    progress.console.print(f"[red]failed:[/] {a.path or a.name}: {error}")

            errors = await engine.apply(plan, on_event)
        reindex(engine)
        counts = Counter(a.kind for a in work)
        summary = ", ".join(f"{n} {k.value.replace('_', ' ')}" for k, n in counts.items() if k not in (Kind.LINK, Kind.UNLINK))
        console.print(f"Done{': ' + summary if summary else ''}." + (f" [red]{len(errors)} failed.[/]" if errors else ""))

    with_engine(True, body)


def reindex(engine: Engine) -> None:
    with console.status("Indexing for search…") as spinner:
        def on_progress(done: int, total: int, title: str) -> None:
            if title:
                spinner.update(f"Indexing for search… {done}/{total} [dim]{title}[/]")

        engine.reindex(on_progress)


@app.command("index")
def index_() -> None:
    """Update the search index (runs automatically after `pull`)."""

    async def body(engine: Engine) -> None:
        reindex(engine)
        console.print("Search index up to date.")

    with_engine(False, body)


KIND_LABEL = {"file": "file", "page": "page", "assignment": "hw", "announcement": "news", "syllabus": "syll"}


def render_hit(n: int, h: Hit, base_url: str) -> None:
    date = f"  [dim]{h.date[:10]}[/]" if h.date else ""
    console.print(f"[dim]{n:>2}[/] [cyan]{KIND_LABEL.get(h.kind, h.kind):<4}[/] [bold]{escape(h.course)}[/]  {escape(h.title)}{date}")
    where = h.path or (base_url + h.url if h.url else "")
    if where:
        console.print(f"        [dim]{escape(where)}[/]")
    if h.snippet:
        text = "".join(f"[yellow]{escape(t)}[/]" if m else escape(t) for t, m in h.snippet)
        console.print(f"        {text}", highlight=False)


@app.command()
def search(
    query: Annotated[list[str], typer.Argument(help='e.g. "221 mt", "cs61a hw3 sol"')],
    limit: Annotated[int, typer.Option("-n", "--limit")] = 20,
    open_: Annotated[Optional[int], typer.Option("--open", "-o", help="Open result N")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Search files, pages, assignments and announcements (offline)."""
    acc = account()
    hits = with_engine(False, lambda engine: _value(engine.search(" ".join(query), limit)))
    if as_json:
        print(json.dumps([h.to_dict() for h in hits], indent=2, ensure_ascii=False))
        return
    if open_ is not None:
        if not 1 <= open_ <= len(hits):
            raise fail(f"no result {open_}")
        h = hits[open_ - 1]
        target = str(acc.root / h.path) if h.path else acc.base_url + (h.url or "")
        if h.path:
            open_path(acc.root / h.path)
        else:
            typer.launch(target)
        console.print(f"opened {target}")
        return
    if not hits:
        console.print("No results. [dim](`canvas index` if you haven't pulled since installing search)[/]")
        return
    for n, h in enumerate(hits, 1):
        render_hit(n, h, acc.base_url)
    console.print("[dim]`--open N` to open one.[/]")


@app.command()
def status(as_json: Annotated[bool, typer.Option("--json")] = False) -> None:
    """Show local changes since the last pull (offline)."""

    entries = with_engine(False, lambda engine: _value(engine.status()))
    if as_json:
        print(json.dumps([e.__dict__ for e in entries], indent=2))
        return
    if not entries:
        console.print("No local changes.")
        return
    labels = {
        "modified": ("M", "yellow", "edited by you"),
        "moved": ("R", "blue", "moved by you (recorded on next pull)"),
        "missing": ("D", "magenta", "deleted by you (won't be re-downloaded)"),
        "ignored": ("I", "dim", "ignored"),
        "remote_deleted": ("X", "red", "removed from Canvas"),
    }
    for e in sorted(entries, key=lambda e: e.path or ""):
        tags = " ".join(f"[{labels[s][1]}]{labels[s][0]}[/]" for s in e.states)
        console.print(f"{tags:>2} {e.path}")
    used = {s for e in entries for s in e.states}
    console.print("[dim]" + "  ".join(f"{v[0]}={v[2]}" for k, v in labels.items() if k in used) + "[/]")


@app.command()
def restore(paths: Annotated[list[Path], typer.Argument(help="Files, or folders to restore everything changed in")]) -> None:
    """Put back the original Canvas version of files (your versions go to the Trash)."""

    async def body(engine: Engine) -> None:
        for p in paths:
            restored = engine.restore(p)
            for r in restored:
                console.print(f"restored {r}")
            if not restored:
                console.print(f"[dim]nothing to restore in {p}[/]")

    with_engine(False, body)


@app.command()
def serve(
    port: Annotated[int, typer.Option(help="0 = pick a free port")] = 0,
    exit_with_stdin: Annotated[bool, typer.Option(help="Stop when stdin closes (how the app makes sure it doesn't outlive it)")] = False,
) -> None:
    """Run the local API the desktop app talks to. Prints {"port", "token"} as the first line."""
    from .server import serve as run

    run(Account.load(), port, exit_with_stdin=exit_with_stdin)  # not set up yet: the app signs you in


@app.command("open")
def open_(course: Annotated[Optional[str], typer.Argument(help="Course id, code or name")] = None) -> None:
    """Open the sync folder (or one course's folder) in the file manager."""
    acc = account()
    target = acc.root
    if course:
        async def body(engine: Engine) -> Path:
            known = engine.state.courses()
            c = pick_courses(known, [course])[0]
            return engine.root / engine.layout.course_dir(c)

        target = with_engine(False, body)
    open_path(target)


if __name__ == "__main__":
    app()
