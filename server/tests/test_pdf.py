import io

import pytest
from pypdf import PdfReader

from conftest import jpeg_bytes
from scan2pdf.pdf import PAGE_SIZES, build_pdf, page_layout, parse_jpeg


def test_parse_jpeg():
    assert parse_jpeg(jpeg_bytes(321, 123))[:3] == (321, 123, 3)
    with pytest.raises(ValueError):
        parse_jpeg(b"\x89PNG....")


def test_page_layout_matches_js_rules():
    pw, ph, *_ = page_layout(2480, 3508)
    assert (round(pw, 2), round(ph, 2)) == (round(PAGE_SIZES["a4"][0], 2), round(PAGE_SIZES["a4"][1], 2))
    pw, ph, x, y, w, h = page_layout(3000, 2000, "letter", "auto", 10)
    assert pw == 792 and ph == 612
    assert abs(2 * x + w - pw) < 1e-6 and abs(2 * y + h - ph) < 1e-6


def test_build_pdf_reads_back():
    pdf = build_pdf([jpeg_bytes(500, 700), jpeg_bytes(700, 500)], title="문서")
    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) == 2
    assert reader.metadata.title == "문서"
    assert reader.pages[0].images[0].image.size == (500, 700)
