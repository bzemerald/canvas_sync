"""Small preview images for the app's icon view: first page of a PDF, or the image itself.

Cached in <root>/.canvas/thumbs, keyed by path, size and mtime, so an edited file gets
a fresh thumbnail.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .state import META_DIR
from .text import PDFIUM_LOCK

IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
SUPPORTED = IMAGES | {".pdf"}
MAX_PX = 512


def thumbnail(root: Path, rel: str, px: int = 256) -> Path | None:
    """A JPEG thumbnail of root/rel at most `px` wide/high, or None if we can't make one."""
    src = root / rel
    if src.suffix.lower() not in SUPPORTED or not src.is_file():
        return None
    px = max(32, min(px, MAX_PX))
    st = src.stat()
    key = hashlib.sha1(f"{src.resolve()}|{st.st_size}|{st.st_mtime_ns}|{px}".encode()).hexdigest()
    out = root / META_DIR / "thumbs" / key[:2] / f"{key}.jpg"
    if out.exists():
        return out
    try:
        img = _render(src, px)
    except Exception:
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
