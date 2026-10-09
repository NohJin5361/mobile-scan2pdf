"""REST API for scanned documents.

Mount the router returned by :func:`create_router` into any FastAPI application, or use
:func:`scan2pdf.main.create_app` for a ready-made app that also serves the web client.
"""

from __future__ import annotations

import hmac
import io
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from . import __version__
from .config import Settings
from .db import Document, Page, utcnow
from .images import InvalidImage, inspect, thumbnail, to_jpeg
from .pdf import PAGE_SIZES, build_pdf
from .storage import Storage

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VARIANTS = ("processed", "original", "thumb")
QUALITY_PRESETS = {
    "original": None,
    "high": (3000, 85),
    "medium": (2000, 75),
    "low": (1400, 60),
}


@dataclass
class Services:
    settings: Settings
    session_factory: sessionmaker
    storage: Storage


# ---------------------------------------------------------------- schemas


class DocumentIn(BaseModel):
    title: str = Field("", max_length=300)
    created_at: datetime | None = None


class DocumentPatch(BaseModel):
    title: str | None = Field(None, max_length=300)
    page_order: list[str] | None = None


class PageMeta(BaseModel):
    model_config = ConfigDict(extra="allow")

    version: int = Field(1, ge=0)
    original_id: str | None = Field(None, max_length=64)
    position: int | None = Field(None, ge=0)


# ---------------------------------------------------------------- helpers


def _iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.isoformat()


def page_out(p: Page) -> dict:
    return {
        "id": p.id,
        "position": p.position,
        "version": p.version,
        "original_id": p.original_id,
        "has_original": bool(p.original_key),
        "original_type": p.original_type,
        "width": p.width,
        "height": p.height,
        "processed_size": p.processed_size,
        "original_size": p.original_size,
        "meta": p.meta,
        "updated_at": _iso(p.updated_at),
    }


def doc_summary(d: Document) -> dict:
    pages = d.pages
    cover = pages[0] if pages else None
    return {
        "id": d.id,
        "title": d.title,
        "created_at": _iso(d.created_at),
        "updated_at": _iso(d.updated_at),
        "page_count": len(pages),
        "size": sum(p.processed_size + p.original_size for p in pages),
        "cover": {"page_id": cover.id, "version": cover.version} if cover else None,
    }


def doc_detail(d: Document) -> dict:
    return {**doc_summary(d), "pages": [page_out(p) for p in d.pages]}


def safe_filename(title: str, ext: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title or "").strip(" .") or "scan"
    return f"{name[:120]}.{ext}"


def content_disposition(filename: str, attachment: bool = True) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode() or "download"
    ascii_name = ascii_name.replace('"', "")
    kind = "attachment" if attachment else "inline"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def check_id(value: str, what: str = "id") -> str:
    if not ID_RE.match(value):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid {what}")
    return value


def page_key(doc_id: str, page_id: str, variant: str, ext: str = "jpg") -> str:
    return f"docs/{doc_id}/{page_id}/{variant}.{ext}"


EXT_FOR_TYPE = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heif": "heic"}


# ---------------------------------------------------------------- router


def create_router(services: Services) -> APIRouter:
    settings = services.settings
    storage = services.storage
    max_bytes = settings.max_upload_mb * 1024 * 1024

    def get_session():
        with services.session_factory() as session:
            yield session

    def require_auth(request: Request) -> None:
        token = settings.token
        if not token:
            return
        header = request.headers.get("authorization", "")
        given = header[7:] if header.lower().startswith("bearer ") else request.headers.get("x-scan2pdf-token", "")
        if not given or not hmac.compare_digest(given.encode(), token.encode()):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or missing token",
                                headers={"WWW-Authenticate": "Bearer"})

    public = APIRouter()
    router = APIRouter(dependencies=[Depends(require_auth)])

    @public.get("/health")
    def health():
        return {"ok": True, "version": __version__, "auth_required": bool(settings.token), "storage": storage.name}

    @router.get("/auth/check")
    def auth_check():
        return {"ok": True}

    def load_doc(session: Session, doc_id: str) -> Document:
        doc = session.get(Document, check_id(doc_id, "document id"))
        if doc is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
        return doc

    def load_page(session: Session, doc_id: str, page_id: str) -> Page:
        page = session.get(Page, check_id(page_id, "page id"))
        if page is None or page.document_id != doc_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "page not found")
        return page

    def delete_page_blobs(page: Page) -> None:
        for key in (page.processed_key, page.original_key, page.thumb_key):
            if key:
                storage.delete(key)

    def read_upload(upload: UploadFile | None, what: str) -> bytes | None:
        if upload is None:
            return None
        data = upload.file.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"{what} is larger than {settings.max_upload_mb} MB")
        if not data:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{what} is empty")
        return data

    # -------------------------------------------------------- documents

    @router.get("/documents")
    def list_documents(
        q: str | None = Query(None, max_length=200),
        limit: int = Query(100, ge=1, le=500),
        offset: int = Query(0, ge=0),
        session: Session = Depends(get_session),
    ):
        stmt = select(Document)
        count = select(func.count()).select_from(Document)
        if q:
            cond = or_(*[Document.title.ilike(f"%{part}%") for part in q.split()])
            stmt = stmt.where(cond)
            count = count.where(cond)
        docs = session.scalars(stmt.order_by(Document.updated_at.desc()).limit(limit).offset(offset)).all()
        return {"items": [doc_summary(d) for d in docs], "total": session.scalar(count)}

    @router.get("/documents/{doc_id}")
    def get_document(doc_id: str, session: Session = Depends(get_session)):
        return doc_detail(load_doc(session, doc_id))

    @router.put("/documents/{doc_id}")
    def put_document(doc_id: str, body: DocumentIn, session: Session = Depends(get_session)):
        check_id(doc_id, "document id")
        doc = session.get(Document, doc_id)
        if doc is None:
            doc = Document(id=doc_id, title=body.title, created_at=body.created_at or utcnow(), updated_at=utcnow())
            session.add(doc)
        else:
            doc.title = body.title
            doc.updated_at = utcnow()
        session.commit()
        session.refresh(doc)
        return doc_detail(doc)

    @router.patch("/documents/{doc_id}")
    def patch_document(doc_id: str, body: DocumentPatch, session: Session = Depends(get_session)):
        doc = load_doc(session, doc_id)
        removed: list[Page] = []
        if body.title is not None:
            doc.title = body.title
        if body.page_order is not None:
            order = [check_id(pid, "page id") for pid in body.page_order]
            if len(set(order)) != len(order):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "duplicate page id in page_order")
            by_id = {p.id: p for p in doc.pages}
            missing = [pid for pid in order if pid not in by_id]
            if missing:
                raise HTTPException(status.HTTP_409_CONFLICT, {"message": "unknown pages", "missing": missing})
            for pos, pid in enumerate(order):
                by_id[pid].position = pos
            removed = [p for p in doc.pages if p.id not in set(order)]
            for p in removed:
                session.delete(p)
        doc.updated_at = utcnow()
        session.commit()
        for p in removed:
            delete_page_blobs(p)
        session.expire(doc)
        return doc_detail(load_doc(session, doc_id))

    @router.delete("/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_document(doc_id: str, session: Session = Depends(get_session)):
        doc = load_doc(session, doc_id)
        session.delete(doc)
        session.commit()
        storage.delete_prefix(f"docs/{doc_id}/")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # -------------------------------------------------------- pages

    @router.put("/documents/{doc_id}/pages/{page_id}")
    def put_page(
        doc_id: str,
        page_id: str,
        meta: str = Form("{}"),
        processed: UploadFile = File(...),
        original: UploadFile | None = File(None),
        thumb: UploadFile | None = File(None),
        session: Session = Depends(get_session),
    ):
        doc = load_doc(session, doc_id)
        check_id(page_id, "page id")
        try:
            info = PageMeta.model_validate_json(meta)
        except ValueError as exc:
            raise HTTPException(422, f"invalid meta: {exc}") from exc
        if info.original_id is not None:
            check_id(info.original_id, "original id")

        processed_data = read_upload(processed, "processed image")
        original_data = read_upload(original, "original image")
        thumb_data = read_upload(thumb, "thumbnail")
        try:
            ptype, pw, ph = inspect(processed_data)
            if ptype != "image/jpeg":
                processed_data, pw, ph = to_jpeg(processed_data)
            otype = inspect(original_data)[0] if original_data else None
            if thumb_data:
                if inspect(thumb_data)[0] != "image/jpeg":
                    thumb_data = thumbnail(thumb_data)
            else:
                thumb_data = thumbnail(processed_data)
        except InvalidImage as exc:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from exc

        page = session.get(Page, page_id)
        if page is not None and page.document_id != doc_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "page id belongs to another document")
        last = session.scalar(select(func.max(Page.position)).where(Page.document_id == doc_id))
        # End the read transaction before writing files: with database storage on SQLite
        # (WAL) a stale read snapshot could not be upgraded to a write afterwards.
        session.commit()

        processed_key = page_key(doc_id, page_id, "processed")
        thumb_key = page_key(doc_id, page_id, "thumb")
        storage.put(processed_key, processed_data, "image/jpeg")
        storage.put(thumb_key, thumb_data, "image/jpeg")
        original_key = None
        if original_data:
            original_key = page_key(doc_id, page_id, "original", EXT_FOR_TYPE.get(otype, "bin"))
            storage.put(original_key, original_data, otype)

        if page is None:
            page = Page(id=page_id, document_id=doc_id, position=(last + 1) if last is not None else 0)
            session.add(page)
        page.processed_key, page.thumb_key = processed_key, thumb_key
        stale_original = None
        if original_key:
            if page.original_key and page.original_key != original_key:
                stale_original = page.original_key
            page.original_key, page.original_type, page.original_size = original_key, otype, len(original_data)

        extra = info.model_dump(exclude={"version", "original_id", "position"})
        page.meta = extra
        page.version = info.version
        page.original_id = info.original_id
        page.width, page.height = pw, ph
        page.processed_size = len(processed_data)
        if info.position is not None:
            page.position = info.position
        page.updated_at = utcnow()
        doc.updated_at = page.updated_at
        session.commit()
        if stale_original:
            storage.delete(stale_original)
        return page_out(page)

    @router.delete("/documents/{doc_id}/pages/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_page(doc_id: str, page_id: str, session: Session = Depends(get_session)):
        doc = load_doc(session, doc_id)
        page = load_page(session, doc_id, page_id)
        session.delete(page)
        doc.updated_at = utcnow()
        session.commit()
        delete_page_blobs(page)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.get("/documents/{doc_id}/pages/{page_id}/{variant}")
    def get_page_image(
        doc_id: str,
        page_id: str,
        variant: str,
        request: Request,
        download: bool = False,
        session: Session = Depends(get_session),
    ):
        if variant not in VARIANTS:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown variant")
        doc = load_doc(session, doc_id)
        page = load_page(session, doc_id, page_id)
        key = {"processed": page.processed_key, "original": page.original_key, "thumb": page.thumb_key}[variant]
        if not key:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"no {variant} image")
        tag = page.original_id if variant == "original" else page.version
        etag = f'"{page.id}-{variant}-{tag}"'
        headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
        try:
            data = storage.get(key)
        except KeyError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "file missing from storage") from exc
        media = page.original_type if variant == "original" else "image/jpeg"
        if download:
            ext = key.rsplit(".", 1)[-1]
            headers["Content-Disposition"] = content_disposition(
                safe_filename(f"{doc.title or 'scan'}_{page.position + 1:02d}", ext)
            )
        return Response(content=data, media_type=media or "application/octet-stream", headers=headers)

    # -------------------------------------------------------- exports

    def selected_pages(doc: Document, pages: str | None) -> list[Page]:
        if not pages:
            chosen = list(doc.pages)
        else:
            wanted = [p for p in pages.split(",") if p]
            by_id = {p.id: p for p in doc.pages}
            chosen = [by_id[w] for w in wanted if w in by_id]
        if not chosen:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document has no pages")
        return chosen

    def page_jpeg(page: Page, quality: str) -> bytes:
        try:
            data = storage.get(page.processed_key)
        except KeyError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"image of page {page.id} is missing") from exc
        preset = QUALITY_PRESETS.get(quality)
        if preset:
            max_dim, q = preset
            data = to_jpeg(data, quality=q, max_dim=max_dim)[0]
        return data

    @router.get("/documents/{doc_id}/export.pdf")
    def export_pdf(
        doc_id: str,
        page_size: str = Query("auto", pattern="^(auto|" + "|".join(PAGE_SIZES) + ")$"),
        orientation: str = Query("auto", pattern="^(auto|portrait|landscape)$"),
        margin: float = Query(0, ge=0, le=50),
        quality: str = Query("original", pattern="^(" + "|".join(QUALITY_PRESETS) + ")$"),
        pages: str | None = None,
        inline: bool = False,
        session: Session = Depends(get_session),
    ):
        doc = load_doc(session, doc_id)
        jpegs = [page_jpeg(p, quality) for p in selected_pages(doc, pages)]
        pdf = build_pdf(jpegs, page_size=page_size, orientation=orientation, margin_mm=margin, title=doc.title)
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": content_disposition(safe_filename(doc.title, "pdf"), not inline)},
        )

    @router.get("/documents/{doc_id}/export.zip")
    def export_zip(
        doc_id: str,
        quality: str = Query("original", pattern="^(" + "|".join(QUALITY_PRESETS) + ")$"),
        pages: str | None = None,
        session: Session = Depends(get_session),
    ):
        doc = load_doc(session, doc_id)
        buf = io.BytesIO()
        base = safe_filename(doc.title, "x")[:-2]
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for i, p in enumerate(selected_pages(doc, pages), start=1):
                zf.writestr(f"{base}_{i:02d}.jpg", page_jpeg(p, quality))
        return Response(
            content=buf.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": content_disposition(safe_filename(doc.title, "zip"))},
        )

    combined = APIRouter()
    combined.include_router(public)
    combined.include_router(router)
    return combined
