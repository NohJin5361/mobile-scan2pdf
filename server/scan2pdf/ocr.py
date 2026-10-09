"""Optional OCR with the Tesseract command line tool.

Enabled automatically when ``tesseract`` is on PATH (or SCAN2PDF_TESSERACT points to it):
  Ubuntu/Debian: sudo apt install tesseract-ocr tesseract-ocr-kor
  macOS:         brew install tesseract tesseract-lang
  Windows:       https://github.com/UB-Mannheim/tesseract/wiki
"""

from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

from .pdf import PAGE_SIZES, parse_jpeg

LANG_RE = re.compile(r"^[A-Za-z_]{3,20}(\+[A-Za-z_]{3,20}){0,4}$")
PREFERRED = ("kor", "eng")


class OcrError(RuntimeError):
    pass


def tesseract_cmd() -> str | None:
    return shutil.which(os.environ.get("SCAN2PDF_TESSERACT", "tesseract"))


@lru_cache(maxsize=1)
def _languages(cmd: str) -> tuple[str, ...]:
    try:
        out = subprocess.run([cmd, "--list-langs"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return ()
    return tuple(line.strip() for line in out.splitlines()[1:] if line.strip() and line.strip() != "osd")


def languages() -> list[str]:
    cmd = tesseract_cmd()
    return list(_languages(cmd)) if cmd else []


def available() -> bool:
    return bool(languages())


def default_language() -> str:
    langs = languages()
    chosen = [lang for lang in PREFERRED if lang in langs]
    return "+".join(chosen) if chosen else (langs[0] if langs else "eng")


def check_language(lang: str | None) -> str:
    lang = lang or default_language()
    if not LANG_RE.match(lang):
        raise OcrError("invalid language")
    missing = [part for part in lang.split("+") if part not in languages()]
    if missing:
        raise OcrError(f"OCR language not installed: {', '.join(missing)}")
    return lang


def set_jpeg_dpi(jpeg: bytes, dpi: int) -> bytes:
    """Writes the resolution into the JFIF header without re-encoding the image."""
    dpi = max(1, min(65535, int(round(dpi))))
    if jpeg[2:4] == b"\xff\xe0" and jpeg[6:11] == b"JFIF\x00":
        b = bytearray(jpeg)
        b[13] = 1  # units: dots per inch
        b[14:18] = struct.pack(">HH", dpi, dpi)
        return bytes(b)
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x01" + struct.pack(">HH", dpi, dpi) + b"\x00\x00"
    return jpeg[:2] + app0 + jpeg[2:]


def page_dpi(jpeg: bytes) -> int:
    """DPI that gives the page the same size as the 'auto' layout (long side = A4)."""
    w, h, _, _ = parse_jpeg(jpeg)
    return max(72, round(max(w, h) / (PAGE_SIZES["a4"][1] / 72)))


def _run(args: list[str], cwd: str, timeout: int, single_thread: bool = True) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if single_thread:
        env["OMP_THREAD_LIMIT"] = "1"  # pages run in parallel instead
    try:
        res = subprocess.run(args, cwd=cwd, capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        raise OcrError("OCR timed out") from exc
    if res.returncode != 0:
        raise OcrError(f"tesseract failed: {res.stderr.decode(errors='replace')[-300:]}")
    return res


def image_text(jpeg: bytes, lang: str) -> str:
    cmd = tesseract_cmd()
    if not cmd:
        raise OcrError("OCR is not installed on the server")
    with tempfile.TemporaryDirectory(prefix="scan2pdf-ocr-") as tmp:
        path = Path(tmp, "page.jpg")
        path.write_bytes(set_jpeg_dpi(jpeg, page_dpi(jpeg)))
        res = _run([cmd, str(path), "stdout", "-l", lang, "--psm", "3"], tmp, 180)
    text = res.stdout.decode("utf-8", errors="replace")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def texts(jpegs: list[bytes], lang: str) -> list[str]:
    workers = max(1, min(len(jpegs), os.cpu_count() or 2, 4))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda j: image_text(j, lang), jpegs))


def searchable_pdf(jpegs: list[bytes], lang: str, title: str | None = None) -> bytes:
    """PDF with the original JPEGs plus an invisible, selectable text layer."""
    cmd = tesseract_cmd()
    if not cmd:
        raise OcrError("OCR is not installed on the server")
    with tempfile.TemporaryDirectory(prefix="scan2pdf-ocr-") as tmp:
        names = []
        for i, jpeg in enumerate(jpegs):
            name = f"page-{i:04d}.jpg"
            Path(tmp, name).write_bytes(set_jpeg_dpi(jpeg, page_dpi(jpeg)))
            names.append(name)
        Path(tmp, "pages.txt").write_text("\n".join(names) + "\n")
        args = [cmd, "pages.txt", "out", "-l", lang, "--psm", "3"]
        if title:
            args += ["-c", f"document_title={title}"]
        _run(args + ["pdf"], tmp, 120 + 90 * len(jpegs), single_thread=False)
        return Path(tmp, "out.pdf").read_bytes()
