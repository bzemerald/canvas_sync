"""Small preview images for the app's file views: first page of a PDF, or the image itself;
on macOS, what Quick Look draws for the rest (Office and iWork documents, videos...).

Cached in <root>/.canvas/thumbnails, keyed by the path in the sync folder, size and mtime, so an
edited file gets a fresh thumbnail and a moved sync folder keeps them.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .state import META_DIR
from .text import PDFIUM_LOCK

IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
# The system's Quick Look draws these (macOS only).
QUICK_LOOK = {".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".key", ".pages", ".numbers", ".rtf",
              ".heic", ".svg", ".mp4", ".mov", ".m4v"}
SUPPORTED = IMAGES | {".pdf"} | (QUICK_LOOK if sys.platform == "darwin" else set())
MAX_PX = 512
QUICK_LOOK_TIMEOUT = 8  # seconds; it can hang on a broken file (good ones take a fraction of one)
CACHE = "thumbnails"


def forget_old_thumbnails(root: Path) -> None:
    """.canvas/thumbs: thumbnails keyed by where the sync folder was, from older versions."""
    shutil.rmtree(root / META_DIR / "thumbs", ignore_errors=True)


def thumbnail(root: Path, rel: str, px: int = 256) -> Path | None:
    """A JPEG thumbnail of root/rel at most `px` wide/high, or None if we can't make one."""
    src = root / rel
    if src.suffix.lower() not in SUPPORTED or not src.is_file():
        return None
    px = max(32, min(px, MAX_PX))
    st = src.stat()
    real = src.resolve()  # (a view's link and its file: one thumbnail)
    where = real.relative_to(root.resolve()).as_posix() if real.is_relative_to(root.resolve()) else str(real)
    key = hashlib.sha1(f"{where}|{st.st_size}|{st.st_mtime_ns}|{px}".encode()).hexdigest()
    out = root / META_DIR / CACHE / key[:2] / f"{key}.jpg"
    if out.exists():
        return out
    failed = out.with_suffix(".none")  # tried before, and couldn't: not again (Quick Look is slow to fail)
    if failed.exists():
        return None
    try:
        img = _render(src, px)
    except Exception:
        failed.parent.mkdir(parents=True, exist_ok=True)
        failed.touch()
        return None
    from PIL import Image

    if img.mode != "RGB":  # flatten transparency onto white
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.convert("RGBA").getchannel("A"))
        img = bg
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    img.save(tmp, "JPEG", quality=82)
    tmp.replace(out)
    return out


def _render(src: Path, px: int):  # -> PIL.Image.Image
    from PIL import Image, ImageOps

    if src.suffix.lower() in QUICK_LOOK:
        return _quick_look(src, px)
    if src.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium

        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(src)
            try:
                page = pdf[0]
                width, height = page.get_size()
                img = page.render(scale=px / max(width, height, 1)).to_pil()
                page.close()
            finally:
                pdf.close()
        return img
    with Image.open(src) as im:
        im.seek(0)  # first frame of a GIF
        img = ImageOps.exif_transpose(im)
        img.thumbnail((px, px))
        return img.copy()


def _quick_look(src: Path, px: int):  # -> PIL.Image.Image
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp:
        # The real file, not a link to it: Office's Quick Look hangs on a link.
        subprocess.run(["qlmanage", "-t", "-s", str(px), "-o", tmp, str(src.resolve())], capture_output=True, timeout=QUICK_LOOK_TIMEOUT)
        made = next(Path(tmp).glob("*.png"))  # none: StopIteration, so no thumbnail
        with Image.open(made) as im:
            im.thumbnail((px, px))
            return im.copy()
