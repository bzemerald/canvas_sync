"""Adding `canvas mcp` to AI apps (assistants.py): their config files, kept as they were apart
from our entry; Claude Code through its own command, and VS Code when its file has comments;
entries left behind by a moved app."""

from __future__ import annotations

import json
import stat
import sys
from pathlib import Path

import pytest
import tomlkit
from fastapi.testclient import TestClient

from canvas_sync import assistants
from canvas_sync.config import Account
from canvas_sync.server import canvas_command, create_app
from fake_canvas import BASE

CMD, ARGS = "/Applications/Canvas Sync.app/backend/canvas", ["mcp"]


def app(app_id: str) -> assistants.App:
    return next(a for a in assistants.apps() if a.id == app_id)


def test_added_beside_what_was_there(no_real_ai_apps: Path, tmp_path: Path):
    cursor, codex, desktop = app("cursor"), app("codex"), app("claude-desktop")
    cursor.path.parent.mkdir(parents=True)
    cursor.path.write_text(json.dumps({"mcpServers": {"github": {"command": "gh-mcp"}}, "other": 1}))
    codex.path.parent.mkdir(parents=True)
    codex.path.write_text('model = "o3"  # mine\n\n[projects."/x"]\ntrust_level = "trusted"\n')
    backups = tmp_path / "backups"

    for a in (cursor, codex, desktop):
        assistants.add(a, CMD, ARGS, backups)
    assert json.loads(cursor.path.read_text()) == {
        "mcpServers": {"github": {"command": "gh-mcp"}, "canvas-sync": {"command": CMD, "args": ARGS}}, "other": 1}
    text = codex.path.read_text()
    assert 'model = "o3"  # mine' in text and '[projects."/x"]' in text  # (comments and all)
    assert tomlkit.parse(text)["mcp_servers"]["canvas-sync"] == {"command": CMD, "args": ARGS}
    assert json.loads(desktop.path.read_text()) == {"mcpServers": {"canvas-sync": {"command": CMD, "args": ARGS}}}
    assert json.loads((backups / "cursor.json").read_text())["other"] == 1  # (what it was, kept)

    assistants.remove(cursor, backups)
    assistants.remove(codex, backups)
    assert json.loads(cursor.path.read_text())["mcpServers"] == {"github": {"command": "gh-mcp"}}
    assert "mcp_servers" not in tomlkit.parse(codex.path.read_text())  # (ours was all it had)
    assistants.remove(cursor, backups)  # (not there: nothing to do)


def test_a_file_it_cant_read_is_left_alone(tmp_path: Path):
    vscode = app("vscode")
    vscode.path.parent.mkdir(parents=True)
    vscode.path.write_text('{\n  // my servers\n  "servers": {}\n}\n')  # (VS Code allows comments)
    with pytest.raises(assistants.AssistantError):
        assistants.add(vscode, CMD, ARGS, tmp_path / "backups")
    assert "// my servers" in vscode.path.read_text()


@pytest.mark.skipif(sys.platform == "win32", reason="a shell script stands in for claude")
def test_claude_code_through_its_command(no_real_ai_apps: Path, tmp_path: Path):
    """A stand-in `claude` that writes ~/.claude.json as Claude Code does."""
    log = tmp_path / "claude.log"
    claude = no_real_ai_apps / ".local" / "bin" / "claude"
    claude.parent.mkdir(parents=True)
    claude.write_text(f"""#!{sys.executable}
import json, sys
from pathlib import Path
open({str(log)!r}, "a").write(" ".join(sys.argv[1:]) + "\\n")
p = Path({str(no_real_ai_apps / ".claude.json")!r})
d = json.loads(p.read_text()) if p.exists() else {{}}
args = sys.argv[1:]
if args[:2] == ["mcp", "add"]:
    d.setdefault("mcpServers", {{}})[args[4]] = {{"type": "stdio", "command": args[6], "args": args[7:]}}
elif args[:2] == ["mcp", "remove"]:
    d["mcpServers"].pop(args[4])
p.write_text(json.dumps(d))
""")
    claude.chmod(claude.stat().st_mode | stat.S_IEXEC)
    cc = app("claude-code")
    assistants.add(cc, CMD, ARGS, tmp_path / "backups")
    assert assistants.entry(cc)["command"] == CMD
    assistants.add(cc, "/elsewhere/canvas", ARGS, tmp_path / "backups")  # (again: replaced)
    assistants.remove(cc, tmp_path / "backups")
    assert assistants.entry(cc) is None
    assert log.read_text().splitlines() == [
        f"mcp add --scope user canvas-sync -- {CMD} mcp", "mcp remove --scope user canvas-sync",
        "mcp add --scope user canvas-sync -- /elsewhere/canvas mcp", "mcp remove --scope user canvas-sync"]


@pytest.mark.skipif(sys.platform == "win32", reason="a shell script stands in for code")
def test_vscode_with_comments_through_its_command(no_real_ai_apps: Path, tmp_path: Path):
    log, backups = tmp_path / "code.log", tmp_path / "backups"
    code = (no_real_ai_apps / "Applications" / "Visual Studio Code.app" / "Contents" / "Resources" / "app"
            / "bin" / "code")
    code.parent.mkdir(parents=True)
    code.write_text(f"""#!{sys.executable}
import sys
open({str(log)!r}, "a").write(" ".join(sys.argv[1:]) + "\\n")
""")
    code.chmod(code.stat().st_mode | stat.S_IEXEC)
    vscode, cursor = app("vscode"), app("cursor")
    vscode.path.parent.mkdir(parents=True)
    vscode.path.write_text('{\n  // my servers\n  "servers": {}\n}\n')

    assistants.add(vscode, CMD, ARGS, backups)
    assistants.add(cursor, CMD, ARGS, backups)  # (Cursor's file: no command needed)
    assert log.read_text().splitlines() == [
        f"--user-data-dir {vscode.path.parent.parent} --add-mcp "
        + json.dumps({"name": "canvas-sync", "command": CMD, "args": ARGS})]
    assert (backups / "vscode.json").read_text().startswith("{\n  // my servers")

    vscode.path.write_text('{"servers": {}}')  # (no comments: its file, as for the others)
    assistants.add(vscode, CMD, ARGS, backups)
    assert len(log.read_text().splitlines()) == 1
    assert assistants.entry(vscode) == {"command": CMD, "args": ARGS}


def test_a_moved_app_is_found_again(tmp_path: Path):
    here = tmp_path / "now" / "canvas"
    here.parent.mkdir()
    here.write_text("")
    other = tmp_path / "dev" / "canvas"  # another copy of the app, still there
    other.parent.mkdir()
    other.write_text("")
    backups = tmp_path / "backups"
    assistants.add(app("cursor"), str(tmp_path / "gone" / "canvas"), ARGS, backups)
    assistants.add(app("codex"), str(other), ARGS, backups)
    assert assistants.repair(str(here), ARGS, backups) == ["cursor"]
    assert assistants.entry(app("cursor"))["command"] == str(here)
    assert assistants.entry(app("codex"))["command"] == str(other)  # (not taken back and forth)


def test_api(no_real_ai_apps: Path, root):
    (no_real_ai_apps / ".cursor").mkdir(parents=True)  # (Cursor is installed)
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as api:
        got = {a["id"]: a for a in api.get("/api/assistants").json()}
        assert set(got) == {"claude-desktop", "claude-code", "codex", "cursor", "vscode"}
        assert got["cursor"]["installed"] and not got["cursor"]["added"] and not got["codex"]["installed"]
        got = {a["id"]: a for a in api.post("/api/assistants/cursor").json()}
        assert got["cursor"]["added"] and got["cursor"]["current"]
        assert assistants.entry(app("cursor")) == {"command": canvas_command(), "args": ["mcp"]}
        got = {a["id"]: a for a in api.delete("/api/assistants/cursor").json()}
        assert not got["cursor"]["added"]
        assert api.post("/api/assistants/chatgpt").status_code == 404
