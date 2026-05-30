from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

load_dotenv()

from app.database import init_db
from app.scheduler import create_scheduler
from app.api.routes import router

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
        try:
            conn.execute(text("ALTER TABLE city_images ADD COLUMN time_slot TEXT DEFAULT 'day'"))
            conn.commit()
        except Exception:
            pass  # Column already exists
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

app.include_router(router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}


if CITY_IMAGES_DIR.exists():
    app.mount("/city-images", StaticFiles(directory=str(CITY_IMAGES_DIR), html=False), name="city-images")

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        file = FRONTEND_DIST / full_path
        if file.exists() and file.is_file():
            return FileResponse(str(file))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
