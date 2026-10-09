import io
import json
import zipfile

from PIL import Image
from pypdf import PdfReader

from conftest import jpeg_bytes, make_client


def upload_page(client, doc_id, page_id, version=1, original=True, color=(240, 240, 235), size=(600, 848), **meta):
    files = {"processed": ("p.jpg", jpeg_bytes(*size, color=color), "image/jpeg")}
    if original:
        files["original"] = ("o.jpg", jpeg_bytes(1200, 900), "image/jpeg")
    body = {"version": version, "original_id": f"o-{page_id}", "corners": [[0, 0], [1, 0], [1, 1], [0, 1]], "filter": "auto", **meta}
    return client.put(f"/api/documents/{doc_id}/pages/{page_id}", data={"meta": json.dumps(body)}, files=files)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["auth_required"] is False


def test_document_lifecycle(client):
    r = client.put("/api/documents/doc-1", json={"title": "영수증 묶음"})
    assert r.status_code == 200, r.text
    assert r.json()["page_count"] == 0

    for i, pid in enumerate(["p1", "p2", "p3"]):
        r = upload_page(client, "doc-1", pid, color=(240 - i * 40, 240, 235))
        assert r.status_code == 200, r.text
        assert r.json()["position"] == i
        assert r.json()["has_original"] is True
        assert r.json()["meta"]["filter"] == "auto"

    detail = client.get("/api/documents/doc-1").json()
    assert [p["id"] for p in detail["pages"]] == ["p1", "p2", "p3"]
    assert detail["cover"]["page_id"] == "p1"
    assert detail["size"] > 0

    # Reorder and drop p2 in one call.
    r = client.patch("/api/documents/doc-1", json={"page_order": ["p3", "p1"], "title": "새 제목"})
    assert r.status_code == 200, r.text
    assert [p["id"] for p in r.json()["pages"]] == ["p3", "p1"]
    assert r.json()["title"] == "새 제목"
    assert client.get("/api/documents/doc-1/pages/p2/processed").status_code == 404

    # Listing and search.
    client.put("/api/documents/doc-2", json={"title": "계약서"})
    items = client.get("/api/documents").json()["items"]
    assert {d["id"] for d in items} == {"doc-1", "doc-2"}
    found = client.get("/api/documents", params={"q": "계약"}).json()
    assert found["total"] == 1 and found["items"][0]["id"] == "doc-2"

    # Update a page (new version, keep original).
    r = upload_page(client, "doc-1", "p1", version=2, original=False, filter="bw")
    assert r.json()["version"] == 2 and r.json()["has_original"] is True and r.json()["meta"]["filter"] == "bw"

    r = client.delete("/api/documents/doc-1/pages/p3")
    assert r.status_code == 204
    assert [p["id"] for p in client.get("/api/documents/doc-1").json()["pages"]] == ["p1"]

    assert client.delete("/api/documents/doc-1").status_code == 204
    assert client.get("/api/documents/doc-1").status_code == 404
    assert client.get("/api/documents/doc-1/pages/p1/processed").status_code == 404


def test_images_and_etag(client):
    client.put("/api/documents/d", json={"title": "t"})
    upload_page(client, "d", "p")
    r = client.get("/api/documents/d/pages/p/processed")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    etag = r.headers["etag"]
    assert client.get("/api/documents/d/pages/p/processed", headers={"If-None-Match": etag}).status_code == 304
    thumb = Image.open(io.BytesIO(client.get("/api/documents/d/pages/p/thumb").content))
    assert max(thumb.size) <= 400
    orig = client.get("/api/documents/d/pages/p/original", params={"download": 1})
    assert orig.status_code == 200
    assert "attachment" in orig.headers["content-disposition"]
    assert client.get("/api/documents/d/pages/p/bogus").status_code == 404


def test_png_upload_is_converted_to_jpeg(client):
    client.put("/api/documents/d", json={"title": "png"})
    files = {"processed": ("p.png", jpeg_bytes(300, 400, fmt="PNG"), "image/png")}
    r = client.put("/api/documents/d/pages/p", data={"meta": "{}"}, files=files)
    assert r.status_code == 200, r.text
    data = client.get("/api/documents/d/pages/p/processed").content
    assert data[:2] == b"\xff\xd8"


def test_rejects_bad_input(client):
    client.put("/api/documents/d", json={"title": "x"})
    files = {"processed": ("p.jpg", b"not an image", "image/jpeg")}
    assert client.put("/api/documents/d/pages/p", data={"meta": "{}"}, files=files).status_code == 415
    assert client.put("/api/documents/d/pages/p", data={"meta": "{bad"}, files=files).status_code == 422
    assert client.put("/api/documents/..%2Fetc", json={"title": "x"}).status_code in (400, 404)
    assert client.put("/api/documents/bad id", json={"title": "x"}).status_code == 400
    assert upload_page(client, "missing-doc", "p").status_code == 404
    upload_page(client, "d", "p")
    r = client.patch("/api/documents/d", json={"page_order": ["p", "ghost"]})
    assert r.status_code == 409
    client.put("/api/documents/other", json={"title": "y"})
    assert upload_page(client, "other", "p").status_code == 409


def test_pdf_export(client):
    client.put("/api/documents/d", json={"title": "스캔 문서"})
    upload_page(client, "d", "a", size=(2480, 3508))
    upload_page(client, "d", "b", size=(1600, 1000))
    r = client.get("/api/documents/d/export.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert "filename*=UTF-8''" in r.headers["content-disposition"]
    reader = PdfReader(io.BytesIO(r.content))
    assert len(reader.pages) == 2
    assert reader.metadata.title == "스캔 문서"
    a4 = reader.pages[0].mediabox
    assert abs(float(a4.width) - 595.28) < 0.1 and abs(float(a4.height) - 841.89) < 0.1
    assert float(reader.pages[1].mediabox.width) > float(reader.pages[1].mediabox.height)

    letter = PdfReader(io.BytesIO(client.get("/api/documents/d/export.pdf", params={"page_size": "letter", "margin": 10, "quality": "low", "pages": "b"}).content))
    assert len(letter.pages) == 1
    assert float(letter.pages[0].mediabox.width) == 792
    img = letter.pages[0].images[0].image
    assert max(img.size) <= 1400

    assert client.get("/api/documents/d/export.pdf", params={"page_size": "huge"}).status_code == 422
    client.put("/api/documents/empty", json={"title": "e"})
    assert client.get("/api/documents/empty/export.pdf").status_code == 404


def test_zip_export(client):
    client.put("/api/documents/d", json={"title": "사진들"})
    upload_page(client, "d", "a")
    upload_page(client, "d", "b")
    r = client.get("/api/documents/d/export.zip")
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names == ["사진들_01.jpg", "사진들_02.jpg"]


def test_token_auth(tmp_path):
    with make_client(tmp_path, token="s3cret") as c:
        assert c.get("/api/health").json()["auth_required"] is True
        assert c.get("/api/documents").status_code == 401
        assert c.get("/api/documents", headers={"Authorization": "Bearer wrong"}).status_code == 401
        ok = c.get("/api/documents", headers={"Authorization": "Bearer s3cret"})
        assert ok.status_code == 200
        assert c.get("/api/auth/check", headers={"X-Scan2PDF-Token": "s3cret"}).status_code == 200


def test_data_persists_across_restarts(tmp_path):
    with make_client(tmp_path) as c:
        c.put("/api/documents/d", json={"title": "keep"})
        upload_page(c, "d", "p")
    with make_client(tmp_path) as c:
        assert c.get("/api/documents/d").json()["page_count"] == 1
        assert c.get("/api/documents/d/pages/p/processed").status_code == 200
