import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scan2pdf.config import Settings  # noqa: E402
from scan2pdf.main import create_app  # noqa: E402


def jpeg_bytes(w=600, h=848, color=(240, 240, 235), fmt="JPEG"):
    im = Image.new("RGB", (w, h), color)
    for x in range(50, w - 50):
        for y in range(80, 90):
            im.putpixel((x, y), (20, 20, 20))
    buf = io.BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


def make_client(tmp_path, storage="local", token=None):
    settings = Settings(data_dir=tmp_path, storage=storage, token=token, web_dir=None, database_url=None)
    return TestClient(create_app(settings))


@pytest.fixture(params=["local", "db"])
def client(request, tmp_path):
    with make_client(tmp_path, storage=request.param) as c:
        yield c
