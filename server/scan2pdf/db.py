"""Database models. Table names are prefixed with ``scan_`` so they can live inside an
existing application database without clashing."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime, ForeignKey, Integer, LargeBinary, String, Text, create_engine, event,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "scan_documents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    pages: Mapped[list["Page"]] = relationship(
        back_populates="document",
        order_by="Page.position",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Page(Base):
    __tablename__ = "scan_pages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("scan_documents.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    original_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    processed_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    original_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    thumb_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    processed_size: Mapped[int] = mapped_column(Integer, default=0)
    original_size: Mapped[int] = mapped_column(Integer, default=0)
    original_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    meta_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    document: Mapped[Document] = relationship(back_populates="pages")

    @property
    def meta(self) -> dict:
        try:
            return json.loads(self.meta_json or "{}")
        except ValueError:
            return {}

    @meta.setter
    def meta(self, value: dict) -> None:
        self.meta_json = json.dumps(value or {}, ensure_ascii=False)


class BlobRow(Base):
    """File contents when SCAN2PDF_STORAGE=db."""

    __tablename__ = "scan_blobs"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    content_type: Mapped[str] = mapped_column(String(100), default="application/octet-stream")
    data: Mapped[bytes] = mapped_column(LargeBinary)


def make_engine(url: str) -> Engine:
    kwargs: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker:
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)
