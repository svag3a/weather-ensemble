"""
Two enrichment jobs for sun terraces:

1. OSM road-proximity orientation  — queries Overpass for nearby named roads,
   finds the nearest road segment, and uses the bearing from the venue to that
   segment as the terrace orientation.  Rate-limited to 1 req/s.

2. AI batch enrichment (Claude)    — sends batches of venues to claude-haiku,
   which estimates outdoor_type (terrace/rooftop/none/unknown) and orientation.
   Skips venues where an admin has manually set confidence > 0.7.
"""
from __future__ import annotations

import asyncio
import json
import math
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from app.models import SunTerrace

logger = logging.getLogger(__name__)

# ── Shared helpers ────────────────────────────────────────────────────────────

DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']


def bearing_to_dir(deg: float) -> str:
    return DIRS[round(deg / 45) % 8]


def compute_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Bearing (°, 0=N) from (lat1,lon1) to (lat2,lon2)."""
    cos_lat = math.cos(math.radians((lat1 + lat2) / 2))
    dlat = lat2 - lat1
    dlon = (lon2 - lon1) * cos_lat
    return (math.degrees(math.atan2(dlon, dlat)) + 360) % 360


def nearest_point_on_segment(
    px: float, py: float,
    ax: float, ay: float,
    bx: float, by: float,
) -> tuple[float, float]:
    """Nearest point on segment AB to P, in cos-corrected (lat, lon) space."""
    dx, dy = bx - ax, by - ay
    d2 = dx * dx + dy * dy
    if d2 < 1e-20:
        return ax, ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / d2))
    return ax + t * dx, ay + t * dy


def dist2(lat1: float, lon1: float, lat2: float, lon2: float, cos_lat: float) -> float:
    dlat = lat2 - lat1
    dlon = (lon2 - lon1) * cos_lat
    return dlat * dlat + dlon * dlon


# ── Job 1: OSM road-proximity orientation ────────────────────────────────────

_osm_state: dict = {
    "running": False, "total": 0, "done": 0, "updated": 0, "skipped": 0,
    "started_at": None, "finished_at": None, "error": None,
}


def get_osm_state() -> dict:
    return dict(_osm_state)


# Göteborg bounding box for bulk road fetch
GBG_BBOX = (57.60, 11.70, 57.85, 12.10)
# Grid cell size in degrees for spatial index
GRID_CELL = 0.005  # ~500 m


async def _fetch_all_roads(client: httpx.AsyncClient) -> list[dict]:
    """Fetch ALL named roads in Göteborg in one Overpass query."""
    lat_min, lon_min, lat_max, lon_max = GBG_BBOX
    query = f"""
[out:json][timeout:120];
way["highway"]["name"]({lat_min},{lon_min},{lat_max},{lon_max});
out geom;
"""
    import urllib.parse
    encoded = urllib.parse.urlencode({"data": query})
    endpoints = [
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass-api.de/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ]
    for url in endpoints:
        try:
            logger.info("Fetching all Göteborg roads from %s …", url)
            r = await client.post(
                url, content=encoded.encode(),
                headers={
                    "User-Agent": "gbgvader.se/1.0 (terrace-orientation; https://gbgvader.se)",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout=150,
            )
            if r.status_code == 200:
                elements = r.json().get("elements", [])
                logger.info("Fetched %d road ways", len(elements))
                return elements
        except Exception as exc:
            logger.warning("Endpoint %s failed: %s", url, exc)
            continue
    raise RuntimeError("All Overpass endpoints failed for bulk road fetch")


def _build_segment_index(ways: list[dict]) -> dict:
    """
    Build a grid index mapping (grid_row, grid_col) → list of segments.
    Each segment is (a_lat, a_lon, b_lat, b_lon).
    """
    index: dict = {}

    def cell(lat: float, lon: float) -> tuple:
        return (int(lat / GRID_CELL), int(lon / GRID_CELL))

    def add(seg: tuple, c: tuple) -> None:
        index.setdefault(c, []).append(seg)

    for way in ways:
        geom = way.get("geometry", [])
        for i in range(len(geom) - 1):
            a, b = geom[i], geom[i + 1]
            seg = (a["lat"], a["lon"], b["lat"], b["lon"])
            # Add segment to all cells it might touch
            lats = sorted([a["lat"], b["lat"]])
            lons = sorted([a["lon"], b["lon"]])
            r0, r1 = int(lats[0] / GRID_CELL), int(lats[1] / GRID_CELL)
            c0, c1 = int(lons[0] / GRID_CELL), int(lons[1] / GRID_CELL)
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    add(seg, (r, c))
    return index


def _orientation_from_index(
    lat: float, lon: float,
    index: dict,
    radius_cells: int = 2,
) -> Optional[str]:
    """Find nearest road segment via grid index and return orientation."""
    cos_lat = math.cos(math.radians(lat))
    base_r = int(lat / GRID_CELL)
    base_c = int(lon / GRID_CELL)

    best_d2 = float("inf")
    best_near_lat = best_near_lon = None

    # Search expanding rings until we find a hit (up to radius_cells)
    for radius in range(0, radius_cells + 1):
        candidates = set()
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                if abs(dr) == radius or abs(dc) == radius:  # only the border ring
                    key = (base_r + dr, base_c + dc)
                    candidates.update(index.get(key, []))

        for a_lat, a_lon, b_lat, b_lon in candidates:
            # Project venue onto segment in cos-corrected space
            px, py = 0.0, 0.0  # venue at origin
            ax = (a_lon - lon) * cos_lat
            ay = a_lat - lat
            bx = (b_lon - lon) * cos_lat
            by = b_lat - lat
            nx, ny = nearest_point_on_segment(px, py, ax, ay, bx, by)
            d2 = nx * nx + ny * ny
            if d2 < best_d2:
                best_d2 = d2
                best_near_lat = lat + ny
                best_near_lon = lon + nx / cos_lat

        if best_near_lat is not None:
            break  # found something in this ring

    if best_near_lat is None:
        return None

    bearing = compute_bearing(lat, lon, best_near_lat, best_near_lon)
    return bearing_to_dir(bearing)


async def run_osm_orientation_job(get_db_func) -> None:
    """
    Background job: assign orientation from nearest named road.

    Strategy: one bulk Overpass query fetches all roads in Göteborg,
    then all venue lookups are done locally via a grid index — no per-venue
    network calls, runs in seconds instead of minutes.
    """
    global _osm_state
    if _osm_state["running"]:
        return
    _osm_state = {
        "running": True, "total": 0, "done": 0, "updated": 0, "skipped": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    logger.info("OSM orientation job started (bulk mode)")
    try:
        db: Session = next(get_db_func())
        terraces = (
            db.query(SunTerrace)
            .filter(
                SunTerrace.active == True,                   # noqa: E712
                SunTerrace.orientation_confidence < 0.7,     # skip manual overrides
            )
            .order_by(SunTerrace.id)
            .all()
        )
        _osm_state["total"] = len(terraces)
        logger.info("OSM orientation: %d terraces to process", len(terraces))

        # ── Step 1: one bulk road fetch ──────────────────────────────────────
        async with httpx.AsyncClient() as client:
            ways = await _fetch_all_roads(client)

        # ── Step 2: build spatial index ──────────────────────────────────────
        index = _build_segment_index(ways)
        logger.info("Road index built: %d cells", len(index))

        # ── Step 3: assign orientation to each terrace ───────────────────────
        COMMIT_EVERY = 100
        for i, t in enumerate(terraces):
            ori = _orientation_from_index(t.lat, t.lon, index)
            _osm_state["done"] += 1
            if ori:
                t.street_orientation = ori
                t.orientation_confidence = 0.55
                t.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                _osm_state["updated"] += 1
            else:
                _osm_state["skipped"] += 1
            if (i + 1) % COMMIT_EVERY == 0:
                db.commit()
                await asyncio.sleep(0)   # yield to event loop

        db.commit()
        logger.info("OSM orientation done: %d updated", _osm_state["updated"])
    except Exception as exc:
        logger.error("OSM orientation job error: %s", exc)
        _osm_state["error"] = str(exc)
    finally:
        _osm_state["running"] = False
        _osm_state["finished_at"] = datetime.now(timezone.utc).isoformat()
        try:
            db.close()
        except Exception:
            pass


# ── Job 2: AI enrichment via Claude ──────────────────────────────────────────

_ai_state: dict = {
    "running": False, "total": 0, "done": 0, "updated": 0, "skipped": 0,
    "started_at": None, "finished_at": None, "error": None,
}

AI_BATCH = 20   # venues per Claude call

AI_SYSTEM = """\
You are a local knowledge expert for Göteborg, Sweden.
Given a list of restaurants, cafés, and bars, estimate two things for each:

1. outdoor_type — one of:
   "terrace"  = has regular outdoor seating (patio/terrace on street level)
   "rooftop"  = rooftop bar or roof terrace
   "none"     = no outdoor seating at all (only if you're quite confident)
   "unknown"  = you don't know

2. orientation — which compass direction the outdoor seating primarily faces:
   N / NE / E / SE / S / SW / W / NW  or  "UNKNOWN"

Respond with a JSON array, one object per venue, in the same order as the input.
Each object: {"id": <int>, "outdoor_type": "...", "orientation": "..."}
No other text — only the JSON array.
"""

AI_USER_TMPL = """\
Venues (Göteborg, Sweden):
{venues_text}
"""


def get_ai_state() -> dict:
    return dict(_ai_state)


async def run_ai_enrichment_job(get_db_func) -> None:
    """Background job: use Claude to estimate outdoor_type and orientation."""
    global _ai_state
    if _ai_state["running"]:
        return
    _ai_state = {
        "running": True, "total": 0, "done": 0, "updated": 0, "skipped": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    logger.info("AI enrichment job started")
    try:
        import anthropic as _anthropic
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        ai = _anthropic.Anthropic(api_key=api_key)

        db: Session = next(get_db_func())
        terraces = (
            db.query(SunTerrace)
            .filter(
                SunTerrace.active == True,           # noqa: E712
                SunTerrace.orientation_confidence < 0.7,
            )
            .order_by(SunTerrace.id)
            .all()
        )
        _ai_state["total"] = len(terraces)
        logger.info("AI enrichment: %d terraces to process", len(terraces))

        for batch_start in range(0, len(terraces), AI_BATCH):
            batch = terraces[batch_start: batch_start + AI_BATCH]
            lines = []
            for t in batch:
                addr = f", {t.address}" if t.address else ""
                lines.append(
                    f"- id={t.id} name=\"{t.name}\" type={t.amenity_type}{addr}"
                    f" lat={t.lat:.4f} lon={t.lon:.4f}"
                )
            venues_text = "\n".join(lines)

            try:
                msg = ai.messages.create(
                    model="claude-haiku-4-5",
                    max_tokens=1024,
                    system=AI_SYSTEM,
                    messages=[{"role": "user", "content": AI_USER_TMPL.format(venues_text=venues_text)}],
                )
                raw = msg.content[0].text.strip()
                # Strip markdown code fences if present
                if raw.startswith("```"):
                    raw = "\n".join(raw.split("\n")[1:])
                    raw = raw.rstrip("`").strip()
                results = json.loads(raw)

                for rec in results:
                    tid = rec.get("id")
                    t = next((x for x in batch if x.id == tid), None)
                    if t is None:
                        continue
                    ot = rec.get("outdoor_type", "unknown")
                    ori = rec.get("orientation", "UNKNOWN")

                    changed = False
                    if ot in ("terrace", "rooftop", "none", "unknown"):
                        if not t.outdoor_type or t.outdoor_type == "unknown":
                            t.outdoor_type = ot
                            changed = True
                    valid_dirs = {"N","NE","E","SE","S","SW","W","NW","UNKNOWN"}
                    if ori in valid_dirs and ori != "UNKNOWN":
                        if not t.street_orientation or t.street_orientation == "UNKNOWN":
                            t.street_orientation = ori
                            t.orientation_confidence = 0.45  # AI-estimated
                            changed = True
                    if changed:
                        t.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                        _ai_state["updated"] += 1
                    else:
                        _ai_state["skipped"] += 1

                db.commit()
            except Exception as exc:
                logger.warning("AI batch %d failed: %s", batch_start, exc)
                _ai_state["skipped"] += len(batch)

            _ai_state["done"] = min(batch_start + AI_BATCH, len(terraces))
            await asyncio.sleep(0.5)   # gentle rate-limit

        logger.info("AI enrichment done: %d updated", _ai_state["updated"])
    except Exception as exc:
        logger.error("AI enrichment job error: %s", exc)
        _ai_state["error"] = str(exc)
    finally:
        _ai_state["running"] = False
        _ai_state["finished_at"] = datetime.now(timezone.utc).isoformat()
        try:
            db.close()
        except Exception:
            pass
