"""AI apps that can use `canvas mcp` (agent.py), and adding it to them: their own config files
(only our entry changed; the old file kept in the app's folder first), or, for Claude Code, its
own command (its ~/.claude.json is rewritten by every running session). VS Code's file may have
comments, which we can't keep: then its own `code --add-mcp` adds it. (Codex's and VS Code's
commands rewrite the other servers in the file too, so they aren't the first choice.)

When the app moves or is reinstalled, an entry whose program is gone is pointed at this one
(`repair`). One whose program is still there is left alone: the dev app and the packed one
would otherwise take it back and forth.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
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
    path: Path      # its config file (Claude Code: ~/.claude.json, only read)
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
        App("claude-code", "Claude Code", home / ".claude.json", "mcpServers", home / ".claude.json", False),
        App("codex", "Codex", home / ".codex" / "config.toml", "mcp_servers", home / ".codex", False),
        App("cursor", "Cursor", home / ".cursor" / "mcp.json", "mcpServers", home / ".cursor", False),
        App("vscode", "VS Code", roaming / "Code" / "User" / "mcp.json", "servers", roaming / "Code" / "User", False),
    ]


class AssistantError(Exception):
    pass


def _read(app: App) -> dict[str, Any]:
    if not app.path.exists():
        return {}
    text = app.path.read_text(encoding="utf-8")
    try:
        data = tomlkit.parse(text) if app.path.suffix == ".toml" else json.loads(text or "{}")
    except Exception:  # (VS Code allows comments in its JSON: not ours to rewrite)
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


def _backup(app: App, backups: Path) -> None:
    if app.path.exists():
        backups.mkdir(parents=True, exist_ok=True)
        shutil.copy2(app.path, backups / f"{app.id}{app.path.suffix}")


def _write(app: App, data: dict[str, Any], backups: Path) -> None:
    """The file as `data`, whole or not at all; what it was, kept in `backups` first."""
    _backup(app, backups)
    app.path.parent.mkdir(parents=True, exist_ok=True)
    text = tomlkit.dumps(data) if app.path.suffix == ".toml" else json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    tmp = app.path.with_name(app.path.name + ".canvas-sync.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, app.path)


def program(app_id: str, home: Path | None = None) -> str | None:
    """An app's command (claude, code), if it has one we use: the app started from Finder
    doesn't have the shell's PATH. With HOME set elsewhere (tests), only programs in that home."""
    mine = HOME is None and home is None
    home = home or HOME or Path.home()
    exe = ".exe" if sys.platform == "win32" else ""
    places: list[Path] = []
    name = ""
    if app_id == "claude-code":
        name = "claude"
        places = [home / ".local" / "bin" / f"claude{exe}", home / ".claude" / "local" / f"claude{exe}"]
        if mine:
            places += [Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude")]
    elif app_id == "vscode" and sys.platform != "win32":  # (code.cmd: cmd.exe would mangle the JSON's quotes)
        name = "code"
        apps_dirs = [home / "Applications"] + ([Path("/Applications")] if mine else [])
        places = [d / "Visual Studio Code.app" / "Contents" / "Resources" / "app" / "bin" / "code"
                  for d in apps_dirs]
    for p in places:
        if p.is_file():
            return str(p)
    return shutil.which(name) if name and mine else None


def _run(app: App, home: Path | None, *args: str) -> None:
    """The app's own command, told to use the config `apps()` reads."""
    exe = program(app.id, home)
    if exe is None:
        raise AssistantError("can't find the claude command: run the command below in a terminal instead")
    if app.id == "vscode":
        args = ("--user-data-dir", str(app.path.parent.parent), *args)
    done = subprocess.run([exe, *args], capture_output=True, text=True, timeout=60)
    if done.returncode != 0:
        raise AssistantError((done.stderr or done.stdout).strip() or f"{Path(exe).name} failed")


def add(app: App, command: str, args: list[str], backups: Path, home: Path | None = None) -> None:
    if app.id == "claude-code":
        if entry(app) is not None:
            _run(app, home, "mcp", "remove", "--scope", "user", NAME)
        _run(app, home, "mcp", "add", "--scope", "user", NAME, "--", command, *args)
        return
    try:
        data = _read(app)
    except AssistantError:
        if app.id != "vscode" or program(app.id, home) is None:
            raise
        _backup(app, backups)
        _run(app, home, "--add-mcp", json.dumps({"name": NAME, "command": command, "args": args}))
        return
    servers = data.get(app.key)
    if not isinstance(servers, dict):
        servers = data[app.key] = tomlkit.table() if app.path.suffix == ".toml" else {}
    servers[NAME] = {"command": command, "args": args}
    _write(app, data, backups)


def remove(app: App, backups: Path, home: Path | None = None) -> None:
    if entry(app) is None:
        return
    if app.id == "claude-code":
        _run(app, home, "mcp", "remove", "--scope", "user", NAME)
        return
    data = _read(app)  # (VS Code has no command to take one away)
    del data[app.key][NAME]
    if not data[app.key]:  # (nothing else there: as before it was added)
        del data[app.key]
    _write(app, data, backups)


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
            add(app, command, args, backups, home)
            changed.append(app.id)
        except (AssistantError, OSError, subprocess.SubprocessError):
            pass  # (shown as not this program in 设置, to add again)
    return changed
