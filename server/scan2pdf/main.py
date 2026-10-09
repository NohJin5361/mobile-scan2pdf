"""FastAPI application: REST API under /api and the web client at /.

Integration options:
  * run standalone:            python -m scan2pdf
  * mount inside another app:  parent.mount("/scan", create_app())
  * API only in your app:      parent.include_router(create_api_router(), prefix="/scan/api")
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import __version__
from .api import Services, create_router
from .config import Settings
from .db import make_engine, make_session_factory
from .storage import make_storage


def create_services(settings: Settings | None = None) -> Services:
    settings = settings or Settings()
    engine = make_engine(settings.resolved_database_url())
    session_factory = make_session_factory(engine)
    return Services(settings=settings, session_factory=session_factory, storage=make_storage(settings, session_factory))


def create_api_router(settings: Settings | None = None):
    return create_router(create_services(settings))


class _WebFiles(StaticFiles):
    """Static files with headers suited to the PWA (service worker must revalidate)."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path in ("", ".", "index.html", "sw.js", "manifest.webmanifest"):
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    services = create_services(settings)
    settings = services.settings
    app = FastAPI(title="Scan2PDF", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.services = services
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["Content-Disposition"],
        )
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.include_router(create_router(services), prefix="/api")
    if settings.web_dir and settings.web_dir.is_dir():
        app.mount("/", _WebFiles(directory=settings.web_dir, html=True), name="web")
    return app
