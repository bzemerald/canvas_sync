"""Plain text out of course files and Canvas HTML, for the search index.

Best effort: anything we can't read yields "" and is still findable by name.
"""

from __future__ import annotations

import html
import json
import re
import threading
import zipfile
from html.parser import HTMLParser
from pathlib import Path

MAX_CHARS = 300_000
MAX_PDF_PAGES = 400
MAX_FILE_MB = 80

# PDFium is not thread-safe, and indexing and thumbnails can run at the same time.
PDFIUM_LOCK = threading.Lock()

PLAIN = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".tex", ".bib", ".json", ".yaml", ".yml",
    ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".js", ".ts", ".r", ".m", ".jl", ".rs", ".go",
    ".sql", ".sh", ".scala", ".hs", ".ml", ".rkt", ".lisp", ".asm", ".s",
}
# Office formats are zip files of XML; these members hold the visible text.
OFFICE = {
    ".docx": re.compile(r"word/(document|footnotes|endnotes)\d*\.xml"),
    ".pptx": re.compile(r"ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml"),
    ".xlsx": re.compile(r"xl/sharedStrings\.xml"),
}
_XML_BREAK = re.compile(r"</(?:w:p|a:p|si)>")
_XML_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"[ \t\r\f\v]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")


def normalize(text: str) -> str:
    text = _SPACE.sub(" ", text.replace("\x00", ""))
    return _BLANK_LINES.sub("\n", text).strip()[:MAX_CHARS]


class _HTMLText(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section"}
    SKIP = {"script", "style"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def html_to_text(source: str | None) -> str:
    if not source:
        return ""
    p = _HTMLText()
    try:
        p.feed(source)
        p.close()
    except Exception:
        return normalize(_XML_TAG.sub(" ", source))
    return normalize("".join(p.parts))


def _pdf(path: Path) -> str:
    import pypdfium2 as pdfium  # imported lazily: native library, only needed here

    with PDFIUM_LOCK:
        return _pdf_locked(pdfium, path)


def _pdf_locked(pdfium: object, path: Path) -> str:
    pdf = pdfium.PdfDocument(path)  # type: ignore[attr-defined]
    try:
        out, size = [], 0
        for i in range(min(len(pdf), MAX_PDF_PAGES)):
            page = pdf[i]
            textpage = page.get_textpage()
            text = textpage.get_text_bounded()
            textpage.close()
            page.close()
            out.append(text)
            size += len(text)
            if size > MAX_CHARS:
                break
        return "\n".join(out)
    finally:
        pdf.close()


def _office(path: Path, members: re.Pattern[str]) -> str:
    with zipfile.ZipFile(path) as z:
        names = sorted(
            (n for n in z.namelist() if members.fullmatch(n)),
            key=lambda n: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", n)],
        )
        parts = []
        for n in names:
            xml = z.read(n).decode("utf-8", "ignore")
            parts.append(html.unescape(_XML_TAG.sub(" ", _XML_BREAK.sub("\n", xml))))
    return "\n".join(parts)


def _notebook(path: Path) -> str:
    nb = json.loads(path.read_text("utf-8", "ignore"))
    return "\n".join(
        "".join(c["source"]) if isinstance(c.get("source"), list) else str(c.get("source", ""))
        for c in nb.get("cells", [])
    )


def extract(path: Path) -> str:
    """Text content of a local file, or "" if the format is unknown or unreadable."""
    ext = path.suffix.lower()
    try:
        if path.stat().st_size > MAX_FILE_MB * 1024 * 1024:
            return ""
        if ext == ".pdf":
            text = _pdf(path)
        elif ext in OFFICE:
            text = _office(path, OFFICE[ext])
        elif ext == ".ipynb":
            text = _notebook(path)
        elif ext in (".html", ".htm"):
            return html_to_text(path.read_text("utf-8", "ignore"))
        elif ext in PLAIN:
            text = path.read_text("utf-8", "ignore")[: MAX_CHARS * 2]
        else:
            return ""
    except Exception:
        return ""
    return normalize(text)
