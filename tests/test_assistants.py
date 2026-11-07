"""Adding `canvas mcp` to AI apps (assistants.py): their config files, kept as they were apart
from our entry; entries left behind by a moved app."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import tomlkit
from fastapi.testclient import TestClient

from canvas_sync import assistants
from canvas_sync.config import Account
from canvas_sync.server import canvas_command, create_app, mcp_args
from fake_canvas import BASE

CMD, ARGS = "/Applications/Canvas Sync.app/backend/canvas", ["mcp"]


def app(app_id: str) -> assistants.App:
    return next(a for a in assistants.apps() if a.id == app_id)


def test_added_beside_what_was_there(no_real_ai_apps: Path, tmp_path: Path):
    desktop, codex = app("claude-desktop"), app("codex")
    desktop.path.parent.mkdir(parents=True)
    desktop.path.write_text(json.dumps({"mcpServers": {"github": {"command": "gh-mcp"}}, "other": 1}))
    codex.path.parent.mkdir(parents=True)
    codex.path.write_text('model = "o3"  # mine\n\n[projects."/x"]\ntrust_level = "trusted"\n')
    backups = tmp_path / "backups"

    for a in (desktop, codex):
        assistants.add(a, CMD, ARGS, backups)
    assert json.loads(desktop.path.read_text()) == {
        "mcpServers": {"github": {"command": "gh-mcp"}, "canvas-sync": {"command": CMD, "args": ARGS}}, "other": 1}
    text = codex.path.read_text()
    assert 'model = "o3"  # mine' in text and '[projects."/x"]' in text  # (comments and all)
    assert tomlkit.parse(text)["mcp_servers"]["canvas-sync"] == {"command": CMD, "args": ARGS}
    assert json.loads((backups / "claude-desktop.json").read_text())["other"] == 1  # (what it was, kept)

    assistants.remove(desktop, backups)
    assistants.remove(codex, backups)
    assert json.loads(desktop.path.read_text())["mcpServers"] == {"github": {"command": "gh-mcp"}}
    assert "mcp_servers" not in tomlkit.parse(codex.path.read_text())  # (ours was all it had)
    assistants.remove(desktop, backups)  # (not there: nothing to do)


def test_a_file_it_cant_read_is_left_alone(tmp_path: Path):
    desktop = app("claude-desktop")
    desktop.path.parent.mkdir(parents=True)
    desktop.path.write_text('{\n  // my servers\n  "mcpServers": {}\n}\n')
    with pytest.raises(assistants.AssistantError):
        assistants.add(desktop, CMD, ARGS, tmp_path / "backups")
    assert "// my servers" in desktop.path.read_text()


def test_preview_says_what_would_change_and_changes_nothing(tmp_path: Path):
    backups = tmp_path / "backups"
    desktop, codex = app("claude-desktop"), app("codex")

    got = assistants.preview(desktop, CMD, ARGS, backups)  # (no file yet)
    assert (got["action"], got["exists"], got["backup"], got["removed"]) == ("add", False, None, None)
    assert got["path"] == str(desktop.path) and got["key"] == "mcpServers"
    assert not desktop.path.exists() and not backups.exists()

    desktop.path.parent.mkdir(parents=True)
    desktop.path.write_text(json.dumps({"mcpServers": {"github": {"env": {"TOKEN": "secret"}}}}))
    before = desktop.path.read_text()
    got = assistants.preview(desktop, CMD, ARGS, backups)
    assert got["exists"] and got["backup"] == str(backups / "claude-desktop.json")
    assert "secret" not in str(got)  # (others' entries aren't shown)
    assert desktop.path.read_text() == before and not backups.exists()

    # What it shows is what's written.
    assistants.add(desktop, CMD, ARGS, backups)
    assert json.loads("{" + got["added"] + "}")[assistants.NAME] == assistants.entry(desktop)
    assert got["added"].startswith('"canvas-sync": {')
    assert (backups / "claude-desktop.json").read_text() == before  # (and where it said)
    assistants.add(codex, CMD, ARGS, backups)
    shown = assistants.preview(codex, CMD, ARGS, backups)["added"]
    assert shown.startswith("[mcp_servers.canvas-sync]") and shown in codex.path.read_text()

    got = assistants.preview(desktop, "/elsewhere/canvas", ARGS, backups)
    assert got["action"] == "replace" and CMD in got["removed"] and "/elsewhere/canvas" in got["added"]
    got = assistants.preview(codex, CMD, ARGS, backups, remove=True)
    assert got["action"] == "remove" and got["removed"] == shown and got["added"] is None

    desktop.path.write_text("// not JSON")
    with pytest.raises(assistants.AssistantError):
        assistants.preview(desktop, CMD, ARGS, backups)


def test_a_moved_app_is_found_again(tmp_path: Path):
    here = tmp_path / "now" / "canvas"
    here.parent.mkdir()
    here.write_text("")
    other = tmp_path / "dev" / "canvas"  # another copy of the app, still there
    other.parent.mkdir()
    other.write_text("")
    backups = tmp_path / "backups"
    assistants.add(app("claude-desktop"), str(tmp_path / "gone" / "canvas"), ARGS, backups)
    assistants.add(app("codex"), str(other), ARGS, backups)
    assert assistants.repair(str(here), ARGS, backups) == ["claude-desktop"]
    assert assistants.entry(app("claude-desktop"))["command"] == str(here)
    assert assistants.entry(app("codex"))["command"] == str(other)  # (not taken back and forth)


def test_api(no_real_ai_apps: Path, root):
    (no_real_ai_apps / ".codex").mkdir(parents=True)  # (Codex is installed)
    with TestClient(create_app(Account(BASE, root), "s"), headers={"Authorization": "Bearer s"}) as api:
        got = {a["id"]: a for a in api.get("/api/assistants").json()}
        assert set(got) == {"claude-desktop", "codex"}
        assert got["codex"]["installed"] and not got["codex"]["added"] and not got["claude-desktop"]["installed"]
        shown = api.get("/api/assistants/codex/preview").json()
        assert shown["action"] == "add" and shown["path"] == str(app("codex").path)
        assert api.get("/api/assistants/cursor/preview").status_code == 404
        got = {a["id"]: a for a in api.post("/api/assistants/codex").json()}
        assert got["codex"]["added"] and got["codex"]["current"]
        assert assistants.entry(app("codex")) == {"command": canvas_command(), "args": mcp_args()}
        got = {a["id"]: a for a in api.delete("/api/assistants/codex").json()}
        assert not got["codex"]["added"]
        assert api.post("/api/assistants/cursor").status_code == 404
        desktop = app("claude-desktop")
        desktop.path.parent.mkdir(parents=True)
        desktop.path.write_text("// not JSON")
        assert api.get("/api/assistants/claude-desktop/preview").status_code == 400
