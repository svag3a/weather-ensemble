"""
Google Places importer for Solsökaren.

Uses Nearby Search to find restaurants/bars/cafes across Göteborg.
Deduplicates against existing venues by proximity + name matching so
OSM venues are not duplicated.
"""
from __future__ import annotations

import os
import re
import math
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session
from app.models import SunTerrace
from app.database import SessionLocal

logger = logging.getLogger(__name__)

GOOGLE_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")
BASE_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"

def _build_grid() -> list[tuple]:
    """Generate a search grid covering Göteborg.

    Google Nearby Search returns at most 60 results (3 pages × 20).
    A 5 km circle in central Göteborg contains hundreds of venues, so
    most are silently dropped.  We instead use a 1.5 km radius grid so
    each cell holds ≤ 60 venues, covering the full urban area.

    Step size = 2.0 km (≈ 0.018° lat, ≈ 0.033° lon at 57.7°N) gives
    ~33 % overlap between adjacent circles — enough to avoid gaps at
    the cell edges.
    """
    import math as _math

    # Bounding box for the Göteborg urban area
    lat_min, lat_max = 57.61, 57.82
    lon_min, lon_max = 11.78, 12.10

    lat_step = 0.018   # ≈ 2.0 km
    lon_step = 0.033   # ≈ 2.0 km at lat 57.7° (cos-corrected)
    radius_m = 1500

    points = []
    lat = lat_min
    while lat <= lat_max + lat_step / 2:
        lon = lon_min
        while lon <= lon_max + lon_step / 2:
            points.append((round(lat, 4), round(lon, 4), radius_m, f"{lat:.3f},{lon:.3f}"))
            lon += lon_step
        lat += lat_step
    return points


SEARCH_GRID = _build_grid()   # ~120 cells

PLACE_TYPES = ["restaurant", "bar", "cafe"]

# Map Google place types → our amenity_type
_TYPE_MAP = {
    "bar":        "bar",
    "night_club": "bar",
    "cafe":       "cafe",
    "bakery":     "cafe",
    "restaurant": "restaurant",
    "food":       "restaurant",
    "pub":        "pub",
}

# ── State tracking ────────────────────────────────────────────────────────────

_google_state: dict = {
    "running": False, "total": 0, "done": 0, "added": 0, "skipped": 0,
    "started_at": None, "finished_at": None, "error": None,
}


def get_google_state() -> dict:
    return dict(_google_state)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalize(name: str) -> str:
    """Lowercase, strip everything except letters and digits."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def _is_duplicate(name: str, lat: float, lon: float, existing: list) -> bool:
    """True if an existing venue is close enough to be the same physical place."""
    n1 = _normalize(name)
    for ev in existing:
        d = _haversine_m(lat, lon, ev.lat, ev.lon)
        if d < 25:
            return True          # same coordinates → definitely duplicate
        if d < 120:
            n2 = _normalize(ev.name or "")
            if n1 and n2 and (n1 in n2 or n2 in n1):
                return True      # same name nearby → duplicate
    return False


def _amenity_type(google_types: list) -> str:
    for t in google_types:
        if t in _TYPE_MAP:
            return _TYPE_MAP[t]
    return "restaurant"


# ── Fetch ─────────────────────────────────────────────────────────────────────

async def fetch_nearby(client, lat: float, lon: float, radius: int, place_type: str) -> list[dict]:
    """Fetch up to 60 results (3 pages) from Google Nearby Search."""
    import asyncio
    params: dict = {
        "location": f"{lat},{lon}",
        "radius":   radius,
        "type":     place_type,
        "language": "sv",
        "key":      GOOGLE_API_KEY,
    }
    venues: list = []
    for page in range(3):
        if page > 0:
            await asyncio.sleep(2)   # Google requires a short delay before pagetoken

        try:
            resp = await client.get(BASE_URL, params=params, timeout=15)
            data = resp.json()
        except Exception as exc:
            logger.warning("Google Places HTTP error: %s", exc)
            break

        status = data.get("status")
        if status == "ZERO_RESULTS":
            break
        if status != "OK":
            logger.warning("Google Places API status=%s", status)
            break

        for r in data.get("results", []):
            name = r.get("name", "").strip()
            if not name:
                continue
            loc = r.get("geometry", {}).get("location", {})
            rlat, rlon = loc.get("lat"), loc.get("lng")
            if rlat is None or rlon is None:
                continue
            venues.append({
                "source_id":             f"google_{r['place_id']}",
                "name":                  name,
                "lat":                   rlat,
                "lon":                   rlon,
                "amenity_type":          _amenity_type(r.get("types", [])),
                "address":               r.get("vicinity"),
                "outdoor_seating":       False,
                "street_orientation":    "UNKNOWN",
                "orientation_confidence": 0.3,
            })

        token = data.get("next_page_token")
        if not token:
            break
        params = {"pagetoken": token, "key": GOOGLE_API_KEY}

    return venues


# ── Import job ────────────────────────────────────────────────────────────────

async def run_google_import_job() -> None:
    """Fetch all grid cells × types from Google Places and upsert into DB."""
    global _google_state
    if _google_state["running"]:
        return
    if not GOOGLE_API_KEY:
        _google_state = {**_google_state, "error": "GOOGLE_PLACES_API_KEY saknas i miljön"}
        return

    combos = [(lat, lon, r, lbl, t) for lat, lon, r, lbl in SEARCH_GRID for t in PLACE_TYPES]
    _google_state = {
        "running": True, "total": len(combos), "done": 0, "added": 0, "skipped": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }

    import httpx
    try:
        all_venues: list = []
        seen_source_ids: set = set()

        async with httpx.AsyncClient() as client:
            for lat, lon, radius, label, place_type in combos:
                results = await fetch_nearby(client, lat, lon, radius, place_type)
                for v in results:
                    if v["source_id"] not in seen_source_ids:
                        seen_source_ids.add(v["source_id"])
                        all_venues.append(v)
                _google_state["done"] += 1
                logger.info(
                    "Google Places: %s @ %s → %d venues (total so far: %d)",
                    place_type, label, len(results), len(all_venues),
                )

        # Write to DB
        db: Session = SessionLocal()
        try:
            now = datetime.utcnow()
            # Load all existing venues once for dedup
            existing_all = db.query(SunTerrace).all()
            added = skipped = 0

            for v in all_venues:
                # 1. Already imported from Google → update data, keep active status
                existing = next(
                    (e for e in existing_all if e.source_id == v["source_id"]), None
                )
                if existing is not None:
                    existing.name        = v["name"]
                    existing.lat         = v["lat"]
                    existing.lon         = v["lon"]
                    existing.address     = v["address"]
                    existing.last_seen_at = now
                    existing.updated_at  = now
                    skipped += 1
                    continue

                # 2. Same physical venue already exists from OSM → skip
                if _is_duplicate(v["name"], v["lat"], v["lon"], existing_all):
                    skipped += 1
                    continue

                # 3. Genuinely new venue
                new_t = SunTerrace(
                    source="google",
                    source_id=v["source_id"],
                    name=v["name"],
                    lat=v["lat"],
                    lon=v["lon"],
                    amenity_type=v["amenity_type"],
                    address=v["address"],
                    outdoor_seating=False,
                    street_orientation="UNKNOWN",
                    orientation_confidence=0.3,
                    active=True,
                    last_seen_at=now,
                    created_at=now,
                    updated_at=now,
                )
                db.add(new_t)
                existing_all.append(new_t)   # include in dedup for subsequent venues
                added += 1

            db.commit()
            _google_state["added"]   = added
            _google_state["skipped"] = skipped
            logger.info(
                "Google Places import done: +%d new, %d skipped (dupes/updates)",
                added, skipped,
            )
        finally:
            db.close()

    except Exception as exc:
        _google_state["error"] = str(exc)
        logger.error("Google Places import failed: %s", exc, exc_info=True)
    finally:
        _google_state["running"]     = False
        _google_state["finished_at"] = datetime.now(timezone.utc).isoformat()
