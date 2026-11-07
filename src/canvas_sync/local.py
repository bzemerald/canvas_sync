"""Filesystem helpers."""

from __future__ import annotations

import ctypes
import ctypes.util
import errno
import functools
import hashlib
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

from .state import META_DIR

_clonefile = None
if sys.platform == "darwin":
    _libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    _clonefile = getattr(_libc, "clonefile", None)


def inside(root: Path, rel: str) -> Path:
    """root/rel, refusing (ValueError) anything that resolves outside the sync folder or into .canvas."""
    top = root.resolve()
    target = (root / rel).resolve()
    if target != top and top not in target.parents:
        raise ValueError("path is outside the sync folder")
    if (top / META_DIR) in [target, *target.parents]:
        raise ValueError("that's canvas-sync's own folder")
    return root / rel


def clone_file(src: Path, dst: Path) -> None:
    """Copy src to dst. On APFS this is a copy-on-write clone: no extra disk space
    is used until one of the two copies is modified."""
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    if _clonefile is not None and _clonefile(os.fsencode(src), os.fsencode(dst), 0) == 0:
        return
    shutil.copy2(src, dst)


class MoveError(Exception):
    pass


_NOT_CONTENT = {".DS_Store", "Thumbs.db", "desktop.ini"}  # (what file managers leave in a folder)
_TRIES = 3  # putting a file back: what has it open (Spotlight, an antivirus) lets go in a moment


def move_sync_folder(src: Path, dst: Path, use: Callable[[], None]) -> str | None:
    """Everything in the sync folder `src` moved into `dst`, an empty folder (made if it isn't
    there), then `use()` to start using it there. On the same disk it's renamed; on another,
    copied, and `src` deleted once it's in use. A MoveError: `src` is as it was, or, "partly
    moved", what couldn't go back is in `dst`. Returns `src` if it couldn't all be deleted."""
    if dst == src or dst.is_relative_to(src):
        raise MoveError("can't move into itself")
    if dst.exists() and not dst.is_dir():
        raise MoveError("not a folder")
    there = list(dst.iterdir()) if dst.exists() else []
    if any(p.name not in _NOT_CONTENT for p in there):
        raise MoveError("move target not empty")
    made = not dst.exists()
    items = list(src.iterdir())
    try:
        for p in there:
            p.unlink()
        dst.mkdir(parents=True, exist_ok=True)
        copied = _move_into(src, items, dst)
    except OSError as err:
        _drop(dst, made)
        raise MoveError(f"could not move: {err}") from err
    except MoveError:
        _drop(dst, made)
        raise
    try:
        use()
    except Exception as err:
        _clear(dst) if copied else _back(items, dst)
        _drop(dst, made)
        raise MoveError(f"could not move: {err}") from err
    try:
        (shutil.rmtree if copied else os.rmdir)(src)
    except OSError:
        return str(src) if copied else None
    return None


def _move_into(src: Path, items: list[Path], dst: Path) -> bool:
    """True: copied (another disk)."""
    if src.stat().st_dev == dst.stat().st_dev:
        try:
            _rename_into(items, dst)
            return False
        except OSError as err:
            if err.errno != errno.EXDEV:
                raise
    _copy_into(src, items, dst)
    return True


def _drop(dst: Path, made: bool) -> None:
    """`dst` gone again, if it was made for this and nothing was left in it."""
    if made:
        try:
            dst.rmdir()
        except OSError:
            pass


def _rename_into(items: list[Path], dst: Path) -> None:
    moved: list[Path] = []
    try:
        for p in items:
            os.rename(p, dst / p.name)
            moved.append(p)
    except OSError:
        _back(moved, dst)
        raise


def _back(items: list[Path], dst: Path) -> None:
    """What was renamed into `dst`, back where it was; what won't go back: MoveError."""
    stuck = []
    for p in reversed(items):
        for i in range(_TRIES):
            try:
                os.rename(dst / p.name, p)
                break
            except OSError:
                if i + 1 < _TRIES:
                    time.sleep(0.5)
        else:
            stuck.append(p)
    if stuck:
        raise MoveError(f"partly moved\n{stuck[0].parent}\n{dst}")


def _copy_into(src: Path, items: list[Path], dst: Path) -> None:
    sizes, links = 0, False
    for folder, dirs, files in os.walk(src):
        sizes += sum(os.lstat(os.path.join(folder, f)).st_size for f in files)
        links = links or any(os.path.islink(os.path.join(folder, n)) for n in dirs + files)
    if links and not _holds_links(dst):  # (exFAT, FAT: a view's links can't go there)
        raise MoveError("links not supported there")
    if shutil.disk_usage(dst).free < sizes:
        raise MoveError("not enough room")
    try:
        for p in items:
            if p.is_dir() and not p.is_symlink():
                shutil.copytree(p, dst / p.name, symlinks=True)
            else:
                shutil.copy2(p, dst / p.name, follow_symlinks=False)
    except OSError:
        _clear(dst)
        raise


def _clear(dst: Path) -> None:
    """What was copied into `dst` (it was empty: all of it), gone."""
    for p in dst.iterdir():
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() and not p.is_symlink() else p.unlink(missing_ok=True)


def open_path(path: Path, reveal: bool = False, preview: bool = False) -> None:
    """Open with the default app, or with `reveal` show it in Finder / Explorer / the file
    manager, or with `preview` show it in Quick Look (macOS; elsewhere it just opens)."""
    if preview and sys.platform == "darwin":
        subprocess.Popen(["qlmanage", "-p", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif sys.platform == "darwin":
        subprocess.run(["open", *(["-R"] if reveal else []), str(path)], check=False)
    elif sys.platform == "win32":
        if reveal:
            # (A string: as a list, a path with spaces quotes the whole "/select,...", and Explorer
            # then opens Documents.)
            subprocess.run(f'explorer /select,"{path}"', check=False)
        else:
            os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.run(["xdg-open", str(path.parent if reveal else path)], check=False)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@functools.cache
def can_symlink(folder: Path) -> bool:
    """Whether symlinks can be made in `folder`. Windows allows them only to admins or
    with Developer Mode on."""
    return sys.platform != "win32" or _holds_links(folder)


def _holds_links(folder: Path) -> bool:
    """Whether a symlink can be made in `folder` (not on exFAT or FAT, say)."""
    probe = folder / f".symlink-probe-{os.getpid()}"
    try:
        os.symlink("target", probe)
    except OSError:
        return False
    probe.unlink()
    return True


def is_regular(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def occupied(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def sibling(path: str, label: str, root: Path) -> str:
    """'a/b.pdf' -> 'a/b (label).pdf', adding a counter if that is taken too."""
    p = Path(path)
    candidate = p.with_name(f"{p.stem} ({label}){p.suffix}")
    n = 2
    while occupied(root / candidate):
        candidate = p.with_name(f"{p.stem} ({label} {n}){p.suffix}")
        n += 1
    return candidate.as_posix()


def prune_empty_dirs(start: Path, stop: Path) -> None:
    """Remove `start` and its parents while they are empty (ignoring .DS_Store), up to `stop`."""
    d = start
    while d != stop and stop in d.parents:
        try:
            entries = os.listdir(d)
        except OSError:
            return
        if entries == [".DS_Store"]:
            os.unlink(d / ".DS_Store")
        elif entries:
            return
        try:
            d.rmdir()
        except OSError:
            return
        d = d.parent
