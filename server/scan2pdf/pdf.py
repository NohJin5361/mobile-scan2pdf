"""Minimal PDF writer embedding JPEG data directly (mirrors web/js/core/pdf.js)."""

from __future__ import annotations

import os
from datetime import datetime, timezone

PT_PER_MM = 72 / 25.4

PAGE_SIZES = {
    "a4": (210 * PT_PER_MM, 297 * PT_PER_MM),
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
    "a5": (148 * PT_PER_MM, 210 * PT_PER_MM),
    "b5": (176 * PT_PER_MM, 250 * PT_PER_MM),
    "a3": (297 * PT_PER_MM, 420 * PT_PER_MM),
}


def parse_jpeg(data: bytes) -> tuple[int, int, int, bool]:
    """Returns (width, height, components, adobe_marker)."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    i, adobe = 2, False
    n = len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01, 0xFF) or 0xD0 <= marker <= 0xD7:
            i += 1 if marker == 0xFF else 2
            continue
        length = (data[i + 2] << 8) | data[i + 3]
        if marker == 0xEE and data[i + 4 : i + 9] == b"Adobe":
            adobe = True
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h = (data[i + 5] << 8) | data[i + 6]
            w = (data[i + 7] << 8) | data[i + 8]
            return w, h, data[i + 9], adobe
        i += 2 + length
    raise ValueError("JPEG size not found")


def page_layout(img_w: int, img_h: int, page_size: str = "auto", orientation: str = "auto", margin_mm: float = 0):
    ratio = img_w / img_h
    margin = max(0.0, margin_mm) * PT_PER_MM
    if page_size not in PAGE_SIZES:
        match = None
        for key in ("a4", "letter", "legal"):
            w, h = PAGE_SIZES[key]
            r = ratio if ratio < 1 else 1 / ratio
            if abs(r / (w / h) - 1) < 0.02:
                match = key
                break
        if match:
            pw, ph = PAGE_SIZES[match]
            if ratio > 1:
                pw, ph = ph, pw
        else:
            long = PAGE_SIZES["a4"][1]
            pw, ph = (long, long / ratio) if ratio >= 1 else (long * ratio, long)
        pw += 2 * margin
        ph += 2 * margin
    else:
        pw, ph = PAGE_SIZES[page_size]
        landscape = orientation == "landscape" or (orientation == "auto" and ratio > 1)
        if landscape:
            pw, ph = ph, pw
    aw, ah = max(1.0, pw - 2 * margin), max(1.0, ph - 2 * margin)
    scale = min(aw / img_w, ah / img_h)
    dw, dh = img_w * scale, img_h * scale
    return pw, ph, (pw - dw) / 2, (ph - dh) / 2, dw, dh


def _pdf_text(s: str) -> str:
    return "<FEFF" + s.encode("utf-16-be").hex().upper() + ">"


def _pdf_date(d: datetime) -> str:
    return d.strftime("(D:%Y%m%d%H%M%SZ)")


def _num(v: float) -> str:
    return f"{round(v, 3):g}" if abs(v) < 1e6 else str(round(v, 3))


def build_pdf(
    jpegs: list[bytes],
    page_size: str = "auto",
    orientation: str = "auto",
    margin_mm: float = 0,
    title: str | None = None,
) -> bytes:
    if not jpegs:
        raise ValueError("no pages")
    out = bytearray()
    offsets: dict[int, int] = {}

    def obj(oid: int, body: bytes | str) -> None:
        offsets[oid] = len(out)
        out.extend(f"{oid} 0 obj\n".encode())
        out.extend(body.encode() if isinstance(body, str) else body)
        out.extend(b"\nendobj\n")

    out.extend(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    n = len(jpegs)
    kids = " ".join(f"{4 + i * 3} 0 R" for i in range(n))
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
    obj(2, f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    now = _pdf_date(datetime.now(timezone.utc))
    info = f"/Producer {_pdf_text('Scan2PDF')} /Creator {_pdf_text('Scan2PDF')} /CreationDate {now} /ModDate {now}"
    if title:
        info += f" /Title {_pdf_text(title)}"
    obj(3, f"<< {info} >>")

    for i, jpeg in enumerate(jpegs):
        w, h, comps, adobe = parse_jpeg(jpeg)
        pw, ph, x, y, dw, dh = page_layout(w, h, page_size, orientation, margin_mm)
        pid = 4 + i * 3
        cid, iid = pid + 1, pid + 2
        obj(
            pid,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_num(pw)} {_num(ph)}] "
            f"/Resources << /XObject << /Im0 {iid} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> /Contents {cid} 0 R >>",
        )
        content = f"q {_num(dw)} 0 0 {_num(dh)} {_num(x)} {_num(y)} cm /Im0 Do Q\n"
        obj(cid, f"<< /Length {len(content)} >>\nstream\n{content}endstream")
        cs, extra = "/DeviceRGB", ""
        if comps == 1:
            cs = "/DeviceGray"
        elif comps == 4:
            cs = "/DeviceCMYK"
            if adobe:
                extra = " /Decode [1 0 1 0 1 0 1 0]"
        head = (
            f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace {cs} "
            f"/BitsPerComponent 8 /Filter /DCTDecode{extra} /Length {len(jpeg)} >>\nstream\n"
        ).encode()
        obj(iid, head + jpeg + b"\nendstream")

    size = 4 + n * 3
    xref = len(out)
    out.extend(f"xref\n0 {size}\n0000000000 65535 f \n".encode())
    for oid in range(1, size):
        out.extend(f"{offsets[oid]:010d} 00000 n \n".encode())
    doc_id = os.urandom(16).hex()
    out.extend(
        f"trailer\n<< /Size {size} /Root 1 0 R /Info 3 0 R /ID [<{doc_id}> <{doc_id}>] >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)
