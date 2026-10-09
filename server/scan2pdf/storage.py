"""Blob storage backends: local directory, database table, or S3-compatible bucket."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Protocol

from sqlalchemy import delete, select
from sqlalchemy.orm import sessionmaker

from .db import BlobRow

_KEY_RE = re.compile(r"^[A-Za-z0-9_.\-/]{1,255}$")


def check_key(key: str) -> str:
    if not _KEY_RE.match(key) or ".." in key or key.startswith("/"):
        raise ValueError(f"invalid storage key: {key!r}")
    return key


class Storage(Protocol):
    name: str

    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    def get(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...

    def delete_prefix(self, prefix: str) -> None: ...


class LocalStorage:
    name = "local"

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self.root / check_key(key)

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)  # atomic: readers never see a partial file
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def get(self, key: str) -> bytes:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError as exc:
            raise KeyError(key) from exc

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink()
        except FileNotFoundError:
            pass

    def delete_prefix(self, prefix: str) -> None:
        base = self._path(prefix.rstrip("/"))
        if base.is_dir():
            for p in sorted(base.rglob("*"), reverse=True):
                p.unlink() if p.is_file() else p.rmdir()
            base.rmdir()


class DatabaseStorage:
    name = "db"

    def __init__(self, session_factory: sessionmaker):
        self.sf = session_factory

    def put(self, key: str, data: bytes, content_type: str) -> None:
        check_key(key)
        with self.sf.begin() as s:
            row = s.get(BlobRow, key)
            if row is None:
                s.add(BlobRow(key=key, content_type=content_type, data=data))
            else:
                row.data = data
                row.content_type = content_type

    def get(self, key: str) -> bytes:
        with self.sf() as s:
            row = s.get(BlobRow, check_key(key))
            if row is None:
                raise KeyError(key)
            return row.data

    def delete(self, key: str) -> None:
        with self.sf.begin() as s:
            s.execute(delete(BlobRow).where(BlobRow.key == check_key(key)))

    def delete_prefix(self, prefix: str) -> None:
        check_key(prefix)
        with self.sf.begin() as s:
            keys = s.scalars(select(BlobRow.key).where(BlobRow.key.startswith(prefix))).all()
            if keys:
                s.execute(delete(BlobRow).where(BlobRow.key.in_(keys)))


class S3Storage:
    name = "s3"

    def __init__(self, bucket: str, prefix: str = "", endpoint_url: str | None = None, region: str | None = None):
        try:
            import boto3  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("SCAN2PDF_STORAGE=s3 requires 'pip install boto3'") from exc
        self.bucket = bucket
        self.prefix = prefix
        self.client = boto3.client("s3", endpoint_url=endpoint_url, region_name=region)

    def _k(self, key: str) -> str:
        return self.prefix + check_key(key)

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=self._k(key), Body=data, ContentType=content_type)

    def get(self, key: str) -> bytes:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self._k(key))["Body"].read()
        except self.client.exceptions.NoSuchKey as exc:
            raise KeyError(key) from exc

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._k(key))

    def delete_prefix(self, prefix: str) -> None:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self._k(prefix)):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objs})


def make_storage(settings, session_factory: sessionmaker) -> Storage:
    kind = (settings.storage or "local").lower()
    if kind == "db":
        return DatabaseStorage(session_factory)
    if kind == "s3":
        if not settings.s3_bucket:
            raise RuntimeError("SCAN2PDF_S3_BUCKET is required for S3 storage")
        return S3Storage(settings.s3_bucket, settings.s3_prefix, settings.s3_endpoint_url, settings.s3_region)
    return LocalStorage(settings.data_dir / "files")
