"""Settings read from environment variables (all prefixed with SCAN2PDF_)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_WEB_DIR = PACKAGE_DIR.parent.parent / "web"


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(f"SCAN2PDF_{name}")
    return value if value not in (None, "") else default


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "data")).resolve())
    database_url: str | None = field(default_factory=lambda: _env("DATABASE_URL"))
    # local | db | s3
    storage: str = field(default_factory=lambda: _env("STORAGE", "local"))
    s3_bucket: str | None = field(default_factory=lambda: _env("S3_BUCKET"))
    s3_prefix: str = field(default_factory=lambda: _env("S3_PREFIX", "scan2pdf/"))
    s3_endpoint_url: str | None = field(default_factory=lambda: _env("S3_ENDPOINT_URL"))
    s3_region: str | None = field(default_factory=lambda: _env("S3_REGION"))
    # Shared secret required by the API when set (Authorization: Bearer <token>).
    token: str | None = field(default_factory=lambda: _env("TOKEN"))
    cors_origins: list[str] = field(
        default_factory=lambda: [o.strip() for o in (_env("CORS_ORIGINS", "") or "").split(",") if o.strip()]
    )
    max_upload_mb: int = field(default_factory=lambda: int(_env("MAX_UPLOAD_MB", "50")))
    web_dir: Path | None = field(
        default_factory=lambda: Path(_env("WEB_DIR")).resolve() if _env("WEB_DIR") else DEFAULT_WEB_DIR
    )

    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'scan2pdf.db'}"
