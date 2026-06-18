"""
Shadow modeling — determine whether a venue is shadowed by nearby buildings.

Algorithm per building vertex P, given solar position (az, alt):
  1. Vector venue→P projected onto sun direction > 0  (P is between venue and sun)
  2. building_height ≥ distance(venue→P) × tan(sun_alt)  (shadow tip reaches venue)

Building data is fetched per-venue from Overpass (small around-query) during enrichment.
"""
from __future__ import annotations

import json
import math
import logging
import asyncio
import urllib.parse
from datetime import datetime, timezone

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

SHADOW_RADIUS_M  = 150    # buildings beyond this can't shadow a ground-level terrace
DEFAULT_HEIGHT_M = 9.6    # fallback: 3 floors × 3.2 m
MAX_VERTICES     = 8      # simplify polygons to reduce storage
COMMIT_EVERY     = 50
BATCH_SIZE       = 5      # concurrent Overpass requests

OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

_shadow_state: dict = {
    "running": False, "total": 0, "done": 0, "updated": 0, "skipped": 0,
    "phase": "", "started_at": None, "finished_at": None, "error": None,
}


def get_shadow_state() -> dict:
    return dict(_shadow_state)


# ── Shadow check ───────────────────────────────────────────────────────────────

def is_shadowed(
    venue_lat: float,
    venue_lon: float,
    sun_az: float,
    sun_alt: float,
    buildings: list,
) -> bool:
    """Return True if any nearby building casts shadow over (venue_lat, venue_lon).

    sun_az  — solar azimuth 0–360° (0=N, 90=E, 180=S, 270=W)
    sun_alt — solar altitude in degrees above horizon
    buildings — list of {"h": height_m, "p": [[lat, lon], ...]}
    """
    if sun_alt <= 5.0 or not buildings:
        return False

    az_rad  = math.radians(sun_az)
    sun_e   = math.sin(az_rad)
    sun_n   = math.cos(az_rad)
    cos_lat = math.cos(math.radians(venue_lat))
    tan_alt = math.tan(math.radians(sun_alt))

    for bldg in buildings:
        h = bldg.get("h", DEFAULT_HEIGHT_M)
        for pt in bldg.get("p", []):
            dy = (pt[0] - venue_lat) * 111320.0
            dx = (pt[1] - venue_lon) * 111320.0 * cos_lat

            if dx * sun_e + dy * sun_n <= 0.0:
                continue

            d = math.sqrt(dx * dx + dy * dy)
            if d < 1.0:
                continue

            if h >= d * tan_alt:
                return True

    return False


# ── Polygon simplification ─────────────────────────────────────────────────────

def _simplify(coords: list, max_pts: int) -> list:
    if len(coords) <= max_pts:
        return coords
    step = max(1, len(coords) // max_pts)
    result = coords[::step]
    if result[-1] != coords[-1]:
        result.append(coords[-1])
    return result[:max_pts]


# ── Per-venue Overpass fetch ───────────────────────────────────────────────────

def _parse_elements(elements: list) -> list:
    """Parse Overpass elements into building dicts."""
    nodes: dict = {}
    ways: list = []
    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways.append(el)

    buildings: list = []
    for way in ways:
        tags = way.get("tags", {})
        h = DEFAULT_HEIGHT_M
        if "building:height" in tags:
            try:
                h = float(tags["building:height"].replace(" m", "").replace(",", "."))
            except (ValueError, AttributeError):
                pass
        elif "building:levels" in tags:
            try:
                h = int(tags["building:levels"]) * 3.2
            except (ValueError, TypeError):
                pass

        nds = way.get("nodes", [])
        coords = [nodes[n] for n in nds if n in nodes]
        if len(coords) < 3:
            continue

        coords = _simplify(coords, MAX_VERTICES)
        buildings.append({
            "h": round(h, 1),
            "p": [[round(c[0], 6), round(c[1], 6)] for c in coords],
        })
    return buildings


def _fetch_venue_buildings_sync(lat: float, lon: float) -> list:
    """Fetch buildings within SHADOW_RADIUS_M+50m of (lat, lon). Runs in a thread."""
    import httpx as _httpx
    radius = SHADOW_RADIUS_M + 50
    query = f"""[out:json][timeout:15];
(
  way["building"](around:{radius},{lat},{lon});
);
out body;
>;
out skel qt;
"""
    encoded = urllib.parse.urlencode({"data": query})
    timeout = _httpx.Timeout(connect=8.0, read=20.0, write=5.0, pool=5.0)
    last_exc = None
    for url in OVERPASS_ENDPOINTS:
        try:
            with _httpx.Client() as client:
                resp = client.post(
                    url,
                    content=encoded.encode(),
                    headers={
                        "User-Agent": "gbgvader.se/1.0 (shadow-model; https://gbgvader.se)",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    timeout=timeout,
                )
            if resp.status_code == 200:
                return _parse_elements(resp.json().get("elements", []))
            last_exc = Exception(f"HTTP {resp.status_code}")
        except Exception as exc:
            last_exc = exc
            continue
    raise Exception(f"Overpass venue fetch failed: {last_exc}")


# ── Background enrichment job ──────────────────────────────────────────────────

async def run_shadow_enrichment_job(get_db_func) -> None:
    """For each active venue, fetch nearby buildings from Overpass and store as JSON."""
    global _shadow_state
    if _shadow_state["running"]:
        return

    _shadow_state = {
        "running": True, "total": 0, "done": 0, "updated": 0, "skipped": 0,
        "phase": "Hämtar venues…",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    logger.info("Shadow enrichment job started (per-venue mode)")
    db: Session | None = None

    try:
        from app.models import SunTerrace

        db = next(get_db_func())
        terraces = (
            db.query(SunTerrace)
            .filter(SunTerrace.active == True)   # noqa: E712
            .order_by(SunTerrace.id)
            .all()
        )
        _shadow_state["total"] = len(terraces)
        _shadow_state["phase"] = "Hämtar byggnader per venue…"
        logger.info("Shadow enrichment: %d venues to process", len(terraces))

        for i in range(0, len(terraces), BATCH_SIZE):
            batch = terraces[i : i + BATCH_SIZE]
            tasks = [
                asyncio.wait_for(
                    asyncio.to_thread(_fetch_venue_buildings_sync, t.lat, t.lon),
                    timeout=30,
                )
                for t in batch
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for t, result in zip(batch, results):
                if isinstance(result, Exception):
                    logger.warning("Shadow enrich skipped terrace %d: %s", t.id, result)
                    _shadow_state["skipped"] += 1
                else:
                    slim = result  # already in {"h", "p"} format
                    t.shadow_buildings_json = json.dumps(slim, separators=(",", ":"))
                    t.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    _shadow_state["updated"] += 1

            db.commit()
            _shadow_state["done"] = min(i + BATCH_SIZE, len(terraces))
            await asyncio.sleep(0.2)  # brief pause between batches

        logger.info("Shadow enrichment done: %d updated, %d skipped",
                    _shadow_state["updated"], _shadow_state["skipped"])

    except Exception as exc:
        logger.error("Shadow enrichment job error: %s", exc)
        _shadow_state["error"] = str(exc)
    finally:
        _shadow_state["running"] = False
        _shadow_state["finished_at"] = datetime.now(timezone.utc).isoformat()
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
