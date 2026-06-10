"""
Automatic area/neighborhood tagging for sun terraces via Nominatim reverse geocoding.

Each venue is reverse-geocoded; the suburb/quarter/neighbourhood field is extracted,
normalized to lowercase, and stored as a Hashtag + TerraceHashtag.
Nominatim rate limit: max 1 req/s — job sleeps 1.1 s between requests.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.models import Hashtag, SunTerrace, TerraceHashtag

logger = logging.getLogger(__name__)

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
_HEADERS = {"User-Agent": "gbgsol/1.0 (area-tagging)"}

_state: dict = {
    "running": False,
    "total": 0,
    "done": 0,
    "tagged": 0,
    "skipped": 0,
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def get_state() -> dict:
    return dict(_state)


def _extract_area(address: dict) -> str | None:
    """Pick the most granular neighborhood-level name from a Nominatim address dict."""
    for key in ("suburb", "quarter", "neighbourhood", "city_district", "district", "borough"):
        val = address.get(key)
        if val:
            return val.strip().lower()
    return None


async def run_area_tag_job(get_db_func) -> None:
    global _state
    _state.update({
        "running": True,
        "total": 0,
        "done": 0,
        "tagged": 0,
        "skipped": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "error": None,
    })

    try:
        db: Session = next(get_db_func())
        terraces = db.query(SunTerrace).filter(SunTerrace.active == True).all()  # noqa: E712
        _state["total"] = len(terraces)

        # Cache: area name → Hashtag id (created on demand)
        area_to_id: dict[str, int] = {}

        def _get_or_create_hashtag(area_name: str) -> int:
            if area_name in area_to_id:
                return area_to_id[area_name]
            row = db.query(Hashtag).filter(Hashtag.name == area_name).first()
            if row is None:
                row = Hashtag(name=area_name, active=True)
                db.add(row)
                db.flush()
            area_to_id[area_name] = row.id
            return row.id

        now = datetime.now(timezone.utc).replace(tzinfo=None)
        commit_counter = 0

        async with httpx.AsyncClient(timeout=10.0, headers=_HEADERS) as hc:
            for terrace in terraces:
                try:
                    resp = await hc.get(
                        _NOMINATIM_URL,
                        params={"lat": terrace.lat, "lon": terrace.lon, "format": "json"},
                    )
                    data = resp.json()
                    area_name = _extract_area(data.get("address", {}))
                except Exception as exc:
                    logger.warning("area_tag: reverse geocode failed for %s: %s", terrace.id, exc)
                    area_name = None

                if area_name:
                    hashtag_id = _get_or_create_hashtag(area_name)
                    existing = (
                        db.query(TerraceHashtag)
                        .filter(
                            TerraceHashtag.terrace_id == terrace.id,
                            TerraceHashtag.hashtag_id == hashtag_id,
                        )
                        .first()
                    )
                    if existing is None:
                        db.add(TerraceHashtag(
                            terrace_id=terrace.id,
                            hashtag_id=hashtag_id,
                            count=1,
                            updated_at=now,
                        ))
                        _state["tagged"] += 1
                        commit_counter += 1
                else:
                    _state["skipped"] += 1

                _state["done"] += 1

                if commit_counter >= 50:
                    db.commit()
                    commit_counter = 0

                await asyncio.sleep(1.1)  # Nominatim: max 1 req/s

        if commit_counter > 0:
            db.commit()
        db.close()

    except Exception as exc:
        logger.exception("area_tag: job failed")
        _state["error"] = str(exc)
    finally:
        _state["running"] = False
        _state["finished_at"] = datetime.now(timezone.utc).isoformat()
