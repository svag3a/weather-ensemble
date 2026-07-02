from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from fastapi import FastAPI, Cookie, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.responses import RedirectResponse

load_dotenv()

from app.database import init_db
from app.scheduler import create_scheduler
from app.api.routes import router
from app.api.auth import auth_router, verify_session_token
from app.api.apple_auth import apple_auth_router
from app.api.webhooks import webhooks_router

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


CITY_IMAGES_DIR = Path("/data/city_images")


@asynccontextmanager
async def lifespan(app: FastAPI):
    CITY_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    # Add time_slot column to existing databases that predate the feature
    from app.database import engine
    from sqlalchemy import text
    with engine.connect() as conn:
        for stmt in [
            "ALTER TABLE city_images ADD COLUMN time_slot TEXT DEFAULT 'day'",
            "ALTER TABLE city_images ADD COLUMN image_type TEXT DEFAULT 'background'",
            "ALTER TABLE source_weights ADD COLUMN bias_temperature REAL DEFAULT 0.0",
            "ALTER TABLE source_weights ADD COLUMN bias_wind REAL DEFAULT 0.0",
            "ALTER TABLE source_weights ADD COLUMN excluded INTEGER DEFAULT 0",
            "ALTER TABLE source_weights ADD COLUMN excluded_reason TEXT",
            "ALTER TABLE source_weights ADD COLUMN excluded_since DATETIME",
            "ALTER TABLE source_weights ADD COLUMN manual_override INTEGER DEFAULT 0",
            "ALTER TABLE forecasts ADD COLUMN fog_probability FLOAT",
            "ALTER TABLE ensemble_forecasts ADD COLUMN fog_probability FLOAT",
            "ALTER TABLE forecasts ADD COLUMN pressure FLOAT",
            "ALTER TABLE ensemble_forecasts ADD COLUMN pressure FLOAT",
            "ALTER TABLE sun_terraces ADD COLUMN street_orientation TEXT",
            "ALTER TABLE sun_terraces ADD COLUMN outdoor_type TEXT DEFAULT 'unknown'",
            "ALTER TABLE sun_terraces ADD COLUMN polygon_coords TEXT",
            "ALTER TABLE sun_terraces ADD COLUMN sun_arc_from REAL",
            "ALTER TABLE sun_terraces ADD COLUMN sun_arc_to REAL",
            "ALTER TABLE sun_terraces ADD COLUMN shadow_buildings_json TEXT",
            "ALTER TABLE sun_terraces ADD COLUMN google_place_id TEXT",
            "ALTER TABLE sun_terraces ADD COLUMN opening_hours_json TEXT",
            "ALTER TABLE sun_terraces ADD COLUMN score_cache_json TEXT",
            "ALTER TABLE sun_terraces ADD COLUMN score_cache_run DATETIME",
            "ALTER TABLE terrace_votes RENAME TO terrace_reports",
            "ALTER TABLE terrace_reports RENAME COLUMN voted_at TO reported_at",
            """CREATE TABLE IF NOT EXISTS terrace_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                terrace_id INTEGER NOT NULL,
                reported_at DATETIME NOT NULL,
                user_lat REAL,
                user_lon REAL,
                feedback TEXT,
                status TEXT DEFAULT 'pending'
            )""",
            "ALTER TABLE terrace_reports ADD COLUMN feedback TEXT",
            "ALTER TABLE terrace_reports ADD COLUMN status TEXT DEFAULT 'pending'",
            """CREATE TABLE IF NOT EXISTS hashtags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                active INTEGER DEFAULT 1,
                created_at DATETIME NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS terrace_hashtags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                terrace_id INTEGER NOT NULL,
                hashtag_id INTEGER NOT NULL,
                count INTEGER DEFAULT 1,
                updated_at DATETIME NOT NULL,
                UNIQUE (terrace_id, hashtag_id)
            )""",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('öl', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('vin', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('cocktails', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('kaffe', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('fika', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('pizza', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('burgare', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('kebab', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('sushi', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('italienskt', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('brunch', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('lunch', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('middag', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('afterwork', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('utsikt', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('hamnutsikt', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('förmiddagssol', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('eftermiddagssol', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('kvällssol', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('hund', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('vegetariskt', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('vegan', 1, datetime('now'))",
            "INSERT OR IGNORE INTO hashtags (name, active, created_at) VALUES ('livemusik', 1, datetime('now'))",
            "CREATE INDEX IF NOT EXISTS ix_sun_terraces_lat_lon_active ON sun_terraces(lat, lon, active)",
            "ALTER TABLE source_weights ADD COLUMN excluded_temperature INTEGER DEFAULT 0",
            "ALTER TABLE source_weights ADD COLUMN excluded_wind INTEGER DEFAULT 0",
            "ALTER TABLE source_weights ADD COLUMN excluded_precip INTEGER DEFAULT 0",
            "ALTER TABLE source_weights ADD COLUMN excluded_cloud INTEGER DEFAULT 0",
            """CREATE TABLE IF NOT EXISTS app_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                apple_user_id TEXT UNIQUE NOT NULL,
                email TEXT,
                full_name TEXT,
                is_premium INTEGER DEFAULT 0,
                premium_expires_at DATETIME,
                created_at DATETIME NOT NULL,
                last_seen_at DATETIME NOT NULL
            )""",
            "CREATE INDEX IF NOT EXISTS ix_app_users_apple_user_id ON app_users(apple_user_id)",
            "ALTER TABLE app_users ADD COLUMN prefs_json TEXT",
        ]:
            try:
                conn.execute(text(stmt))
                conn.commit()
            except Exception:
                pass  # Column already exists
    # Fix existing rooftop venues that have a non-360 arc
    with engine.connect() as conn:
        try:
            conn.execute(text(
                "UPDATE sun_terraces SET sun_arc_from=0, sun_arc_to=360 "
                "WHERE outdoor_type='rooftop' AND (sun_arc_from != 0 OR sun_arc_to != 360)"
            ))
            conn.commit()
        except Exception:
            pass
    # Load any previously calibrated METAR blend weights
    from app.database import SessionLocal as _SL
    from app.sources.metar import load_calibrated_weights as _load_metar
    _db = _SL()
    try:
        _load_metar(_db)
    finally:
        _db.close()

    # Warm DB score-cache in background so first request is fast
    import threading
    import logging as _logging
    _log = _logging.getLogger(__name__)
    def _startup_precompute():
        try:
            from sqlalchemy import desc as _desc
            from app.database import SessionLocal as _SL
            from app.models import EnsembleForecast as _EF
            from app.scheduler import _precompute_terrace_scores
            _db = _SL()
            try:
                latest = _db.query(_EF.computed_at).order_by(_desc(_EF.computed_at)).first()
                if latest:
                    _precompute_terrace_scores(_db, latest[0])
                    _log.info("startup precompute done")
            finally:
                _db.close()
        except Exception as _exc:
            _log.error("startup precompute failed: %s", _exc, exc_info=True)
    threading.Thread(target=_startup_precompute, daemon=True).start()

    scheduler = create_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(
    title="Weather Ensemble",
    description="Ensemble weather forecast for Gothenburg, Sweden",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=500)

@app.middleware("http")
async def immutable_assets_headers(request: Request, call_next):
    response = await call_next(request)
    p = request.url.path
    if p.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif p.startswith("/city-images/"):
        # UUID-based filenames never reuse; safe to cache aggressively
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif p in ("/lejon.webp", "/lejon.png"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif p == "/" or p.endswith(".html"):
        # index.html must never be cached — it references hashed asset filenames
        # that change on every deploy. A stale index.html loads the wrong JS.
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response

app.include_router(router, prefix="/api/v1")
app.include_router(auth_router)
app.include_router(apple_auth_router)
app.include_router(webhooks_router)


@app.get("/health")
def health():
    return {"status": "ok"}


if CITY_IMAGES_DIR.exists():
    app.mount("/city-images", StaticFiles(directory=str(CITY_IMAGES_DIR), html=False), name="city-images")

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/admin")
    async def admin_page(session: Optional[str] = Cookie(None)):
        email = verify_session_token(session or "")
        if not email:
            return RedirectResponse(url="/auth/google", status_code=302)
        return FileResponse(str(FRONTEND_DIST / "index.html"))

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        file = FRONTEND_DIST / full_path
        if file.exists() and file.is_file():
            return FileResponse(str(file))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
