"""Filesystem helpers."""

from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import os
import shutil
import sys
from pathlib import Path

from .state import META_DIR

_clonefile = None
if sys.platform == "darwin":
    _libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    _clonefile = getattr(_libc, "clonefile", None)


def clone_file(src: Path, dst: Path) -> None:
    """Copy src to dst. On APFS this is a copy-on-write clone: no extra disk space
    is used until one of the two copies is modified."""
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    if _clonefile is not None and _clonefile(os.fsencode(src), os.fsencode(dst), 0) == 0:
        return
    shutil.copy2(src, dst)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_regular(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def occupied(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def inode_index(root: Path) -> dict[int, str]:
    """inode -> path (relative to root) for every regular file under root."""
    index: dict[int, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        if dirpath == str(root) and META_DIR in dirnames:
            dirnames.remove(META_DIR)
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if os.path.isfile(full) and not os.path.islink(full):
                index[st.st_ino] = Path(full).relative_to(root).as_posix()
    return index


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
