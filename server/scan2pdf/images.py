"""Image validation and re-encoding helpers (Pillow)."""

from __future__ import annotations

import io

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 120_000_000  # phone sensors go up to ~100 MP

ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "HEIF": "image/heif", "MPO": "image/jpeg"}


class InvalidImage(ValueError):
    pass


def inspect(data: bytes) -> tuple[str, int, int]:
    """Returns (mime type, width, height) or raises InvalidImage."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = im.format or ""
            w, h = im.size
            im.verify()
    except Exception as exc:  # Pillow raises many different types
        raise InvalidImage("not a supported image") from exc
    if fmt not in ALLOWED_FORMATS:
        raise InvalidImage(f"unsupported image format {fmt}")
    return ALLOWED_FORMATS[fmt], w, h


def to_jpeg(data: bytes, quality: int = 92, max_dim: int | None = None) -> tuple[bytes, int, int]:
    """Re-encodes any supported image as baseline JPEG (applying EXIF orientation)."""
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            bg = Image.new("RGB", im.size, (255, 255, 255))
            rgba = im.convert("RGBA")
            bg.paste(rgba, mask=rgba.split()[-1])
            im = bg
        if max_dim and max(im.size) > max_dim:
            im.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True)
        return buf.getvalue(), im.size[0], im.size[1]


def thumbnail(data: bytes, size: int = 400) -> bytes:
    return to_jpeg(data, quality=80, max_dim=size)[0]
