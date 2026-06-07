"""
Reverse-geocode sun terraces that lack an address using Nominatim.
Rate-limited to 1 req/s per Nominatim usage policy.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.models import SunTerrace

logger = logging.getLogger(__name__)

# In-memory job state (single-worker — one geocode run at a time)
_state: dict = {
    "running": False,
    "total": 0,
    "done": 0,
    "updated": 0,
    "skipped": 0,
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def get_state() -> dict:
    return dict(_state)


async def _reverse_geocode(client: httpx.AsyncClient, lat: float, lon: float) -> str | None:
    """Call Nominatim reverse geocoding. Returns 'Street Housenr' or None."""
    try:
        r = await client.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "json", "lat": lat, "lon": lon, "zoom": 18, "addressdetails": 1},
            headers={"User-Agent": "gbgvader.se/1.0 (sun-terrace-geocoder; https://gbgvader.se)"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        addr = data.get("address", {})
        road = addr.get("road") or addr.get("pedestrian") or addr.get("path") or ""
        housenr = addr.get("house_number") or ""
        parts = [p for p in [road, housenr] if p]
        return " ".join(parts) or None
    except Exception as exc:
        logger.debug("Nominatim error for (%s, %s): %s", lat, lon, exc)
        return None


async def run_geocode_job(get_db_func) -> None:
    """Background task: reverse-geocode terraces missing an address."""
    global _state
    if _state["running"]:
        logger.info("Geocode job already running — skipping")
        return

    _state = {
        "running": True,
        "total": 0,
        "done": 0,
        "updated": 0,
        "skipped": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "error": None,
    }
    logger.info("Geocode job started")

    try:
        db: Session = next(get_db_func())
        terraces = (
            db.query(SunTerrace)
            .filter(SunTerrace.active == True, SunTerrace.address == None)  # noqa: E711,E712
            .order_by(SunTerrace.id)
            .all()
        )
        _state["total"] = len(terraces)
        logger.info("Geocoding %d terraces without address", len(terraces))

        async with httpx.AsyncClient() as client:
            for t in terraces:
                address = await _reverse_geocode(client, t.lat, t.lon)
                _state["done"] += 1
                if address:
                    t.address = address
                    t.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    db.commit()
                    _state["updated"] += 1
                    logger.debug("Geocoded %s → %s", t.name, address)
                else:
                    _state["skipped"] += 1

                # Nominatim policy: max 1 req/s
                await asyncio.sleep(1.1)

        logger.info(
            "Geocode job done: %d updated, %d skipped",
            _state["updated"], _state["skipped"],
        )
    except Exception as exc:
        logger.error("Geocode job error: %s", exc)
        _state["error"] = str(exc)
    finally:
        _state["running"] = False
        _state["finished_at"] = datetime.now(timezone.utc).isoformat()
        try:
            db.close()
        except Exception:
            pass
