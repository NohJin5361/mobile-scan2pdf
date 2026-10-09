import io
import json

import pytest
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader

from conftest import make_client
from scan2pdf import ocr

pytestmark = pytest.mark.skipif(not ocr.available(), reason="tesseract is not installed")

LINES = ["Invoice number 4821", "Total amount due 120 dollars", "Thank you for your business"]


def text_page() -> bytes:
    im = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 48)
    except OSError:
        font = ImageFont.load_default(size=48)
    for i, line in enumerate(LINES):
        d.text((120, 200 + i * 110), line, fill="black", font=font)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def setup_doc(client):
    client.put("/api/documents/d", json={"title": "OCR test"})
    files = {"processed": ("p.jpg", text_page(), "image/jpeg")}
    r = client.put("/api/documents/d/pages/p", data={"meta": json.dumps({"version": 1})}, files=files)
    assert r.status_code == 200


def test_set_jpeg_dpi_keeps_image_data():
    data = text_page()
    patched = ocr.set_jpeg_dpi(data, 150)
    assert len(patched) == len(data) or len(patched) == len(data) + 18
    assert Image.open(io.BytesIO(patched)).info.get("dpi") == (150, 150)


def test_health_reports_ocr(tmp_path):
    with make_client(tmp_path) as c:
        info = c.get("/api/health").json()["ocr"]
        assert info["available"] is True
        assert "eng" in info["languages"]


def test_text_extraction_and_cache(tmp_path):
    with make_client(tmp_path) as c:
        setup_doc(c)
        r = c.get("/api/documents/d/text", params={"lang": "eng"})
        assert r.status_code == 200, r.text
        text = r.json()["text"]
        assert "Invoice" in text and "4821" in text and "business" in text
        assert (tmp_path / "files" / "docs" / "d" / "p" / "ocr-1-eng.txt").exists()
        assert c.get("/api/documents/d/text", params={"lang": "xx;rm"}).status_code == 400
        assert c.get("/api/documents/d/text", params={"lang": "zzz"}).status_code == 400


def test_searchable_pdf(tmp_path):
    with make_client(tmp_path) as c:
        setup_doc(c)
        r = c.get("/api/documents/d/export.pdf", params={"ocr": 1, "lang": "eng"})
        assert r.status_code == 200, r.text
        reader = PdfReader(io.BytesIO(r.content))
        assert len(reader.pages) == 1
        extracted = reader.pages[0].extract_text()
        assert "Invoice" in extracted and "4821" in extracted
        # Same page size as the regular "auto" layout (A4 for an A4-shaped scan).
        box = reader.pages[0].mediabox
        assert abs(float(box.height) - 841.89) < 2
