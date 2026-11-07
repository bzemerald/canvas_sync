"""AI apps that can use `canvas mcp` (agent.py), and adding it to them: their own config files
(only our entry changed; the old file kept in the app's folder first). Other apps are added by
hand.

When the app moves or is reinstalled, an entry whose program is gone is pointed at this one
(`repair`). One whose program is still there is left alone: the dev app and the packed one
would otherwise take it back and forth.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import tomlkit

NAME = "canvas-sync"  # (not "canvas": other Canvas MCP servers are called that)
HOME: Path | None = None  # whose apps (None: yours; tests set it elsewhere)


@dataclass(frozen=True)
class App:
    id: str
    name: str
    path: Path      # its config file
    key: str        # where servers are in it
    found: Path     # there when the app is installed (a folder of its own)
    restart: bool   # needs restarting to see a new server


def _roaming(home: Path) -> Path:
    """Where apps keep their settings: macOS's Application Support, Windows's AppData."""
    if sys.platform == "darwin":
        return home / "Library" / "Application Support"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
    return Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")


def apps(home: Path | None = None) -> list[App]:
    home = home or HOME or Path.home()
    roaming = _roaming(home)
    return [
        App("claude-desktop", "Claude", roaming / "Claude" / "claude_desktop_config.json", "mcpServers",
            roaming / "Claude", True),
        App("codex", "ChatGPT Work / Codex", home / ".codex" / "config.toml", "mcp_servers", home / ".codex", False),
    ]


class AssistantError(Exception):
    pass


def _read(app: App) -> dict[str, Any]:
    if not app.path.exists():
        return {}
    text = app.path.read_text(encoding="utf-8")
    try:
        data = tomlkit.parse(text) if app.path.suffix == ".toml" else json.loads(text or "{}")
    except Exception:  # (not ours to rewrite)
        raise AssistantError(f"can't read {app.path}: add it by hand")
    if not isinstance(data, dict):
        raise AssistantError(f"can't read {app.path}: add it by hand")
    return data


def entry(app: App) -> dict[str, Any] | None:
    """Our server as the app has it (None: not added)."""
    try:
        found = (_read(app).get(app.key) or {}).get(NAME)
    except AssistantError:
        return None
    return dict(found) if isinstance(found, dict) else None


def _dumps(app: App, data: dict[str, Any]) -> str:
    return tomlkit.dumps(data) if app.path.suffix == ".toml" else json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _backup(app: App, backups: Path) -> Path:
    """Where the file is kept before a change (the last one only)."""
    return backups / f"{app.id}{app.path.suffix}"


def _write(app: App, data: dict[str, Any], backups: Path) -> None:
    """The file as `data`, whole or not at all; what it was, kept in `backups` first."""
    if app.path.exists():
        backups.mkdir(parents=True, exist_ok=True)
        shutil.copy2(app.path, _backup(app, backups))
    app.path.parent.mkdir(parents=True, exist_ok=True)
    tmp = app.path.with_name(app.path.name + ".canvas-sync.tmp")
    tmp.write_text(_dumps(app, data), encoding="utf-8")
    os.replace(tmp, app.path)


def _snippet(app: App, e: dict[str, Any]) -> str:
    """Our entry as the file has it: the table, in TOML; in JSON, the key and its value."""
    if app.path.suffix == ".toml":
        doc = tomlkit.document()
        doc[app.key] = tomlkit.table()
        doc[app.key][NAME] = e
        return _dumps(app, doc).strip()
    lines = _dumps(app, {NAME: e}).strip().split("\n")[1:-1]
    return "\n".join(line[2:] for line in lines)


def add(app: App, command: str, args: list[str], backups: Path) -> None:
    data = _read(app)
    servers = data.get(app.key)
    if not isinstance(servers, dict):
        servers = data[app.key] = tomlkit.table() if app.path.suffix == ".toml" else {}
    servers[NAME] = {"command": command, "args": args}
    _write(app, data, backups)


def remove(app: App, backups: Path) -> None:
    if entry(app) is None:
        return
    data = _read(app)
    del data[app.key][NAME]
    if not data[app.key]:  # (nothing else there: as before it was added)
        del data[app.key]
    _write(app, data, backups)


def preview(app: App, command: str, args: list[str], backups: Path, remove: bool = False) -> dict[str, Any]:
    """What `add` or `remove` would do to the file; nothing is written. Only our entry is shown:
    others in the file may hold secrets."""
    _read(app)  # (one it can't read says so here, as `add` would)
    old = entry(app)
    return {
        "path": str(app.path),
        "exists": app.path.exists(),
        "key": app.key,
        "action": "remove" if remove else "replace" if old is not None else "add",
        "removed": _snippet(app, old) if old is not None else None,
        "added": None if remove else _snippet(app, {"command": command, "args": args}),
        "backup": str(_backup(app, backups)) if app.path.exists() else None,
    }


def state(command: str, home: Path | None = None) -> list[dict[str, Any]]:
    """Each app: installed or not, and whether it has us (and is this program)."""
    out = []
    for app in apps(home):
        e = entry(app)
        out.append({"id": app.id, "name": app.name, "installed": app.found.exists(), "added": e is not None,
                    "current": e is not None and e.get("command") == command, "restart": app.restart})
    return out


def repair(command: str, args: list[str], backups: Path, home: Path | None = None) -> list[str]:
    """Entries whose program is gone (the app moved, or was reinstalled), pointed at this one.
    Which apps were changed."""
    changed = []
    for app in apps(home):
        e = entry(app)
        if e is None or e.get("command") == command or Path(str(e.get("command") or "")).exists():
            continue
        try:
            add(app, command, args, backups)
            changed.append(app.id)
        except (AssistantError, OSError):
            pass  # (shown as not this program in 设置, to add again)
    return changed
