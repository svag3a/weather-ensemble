"""
Shadow modeling — determine whether a venue is shadowed by nearby buildings.

Algorithm per building vertex P, given solar position (az, alt):
  1. Vector venue→P projected onto sun direction > 0  (P is between venue and sun)
  2. building_height ≥ distance(venue→P) × tan(sun_alt)  (shadow tip reaches venue)

Building data is pre-fetched in bulk from Overpass and cached per venue as JSON.
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

SHADOW_RADIUS_M    = 150     # buildings beyond this can't shadow a ground-level terrace
GRID_DEG           = 0.003   # ~300 m grid cells for spatial index
DEFAULT_HEIGHT_M   = 9.6     # fallback: 3 floors × 3.2 m
MAX_VERTICES       = 8       # simplify polygons to reduce storage
COMMIT_EVERY       = 50

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
    sun_e   = math.sin(az_rad)    # eastward component of sun direction
    sun_n   = math.cos(az_rad)    # northward component
    cos_lat = math.cos(math.radians(venue_lat))
    tan_alt = math.tan(math.radians(sun_alt))

    for bldg in buildings:
        h = bldg.get("h", DEFAULT_HEIGHT_M)
        for pt in bldg.get("p", []):
            # Vector from venue to building vertex, in metres
            dy = (pt[0] - venue_lat) * 111320.0
            dx = (pt[1] - venue_lon) * 111320.0 * cos_lat

            # Is this vertex in the direction of the sun from the venue?
            if dx * sun_e + dy * sun_n <= 0.0:
                continue  # vertex is behind the venue (away from sun)

            d = math.sqrt(dx * dx + dy * dy)
            if d < 1.0:
                continue  # venue is essentially inside the building footprint

            # A building of height h at distance d casts shadow h/tan(alt) long.
            # Venue is in shadow when h >= d * tan(alt).
            if h >= d * tan_alt:
                return True

    return False


# ── Polygon simplification ─────────────────────────────────────────────────────

def _simplify(coords: list, max_pts: int) -> list:
    """Uniform subsample — keeps corners that matter for shadow geometry."""
    if len(coords) <= max_pts:
        return coords
    step = max(1, len(coords) // max_pts)
    result = coords[::step]
    if result[-1] != coords[-1]:
        result.append(coords[-1])
    return result[:max_pts]


# ── Overpass building fetch ────────────────────────────────────────────────────

async def fetch_all_buildings(client) -> list[dict]:
    """One bulk Overpass query: all building polygons in Göteborg.

    Returns list of {"h": float, "p": [[lat,lon],...], "c": [lat,lon]}
    """
    query = """
[out:json][timeout:120];
(
  way["building"](57.60,11.70,57.85,12.10);
);
out body;
>;
out skel qt;
"""
    encoded = urllib.parse.urlencode({"data": query})
    resp = None
    last_exc = None
    for url in OVERPASS_ENDPOINTS:
        try:
            resp = await client.post(
                url,
                content=encoded.encode(),
                headers={
                    "User-Agent": "gbgvader.se/1.0 (shadow-model; https://gbgvader.se)",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout=120,
            )
            if resp.status_code == 200:
                break
        except Exception as exc:
            last_exc = exc
            continue

    if resp is None or resp.status_code != 200:
        raise Exception(f"Overpass shadow fetch failed: {last_exc or resp.status_code}")

    elements = resp.json().get("elements", [])

    # Pass 1: node positions
    nodes: dict = {}
    ways: list = []
    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways.append(el)

    # Pass 2: build polygon objects
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
        clat = sum(c[0] for c in coords) / len(coords)
        clon = sum(c[1] for c in coords) / len(coords)

        buildings.append({
            "h": round(h, 1),
            "p": [[round(c[0], 6), round(c[1], 6)] for c in coords],
            "c": [round(clat, 6), round(clon, 6)],
        })

    logger.info("Shadow model: fetched %d building polygons", len(buildings))
    return buildings


# ── Spatial grid index ─────────────────────────────────────────────────────────

def build_grid(buildings: list) -> dict:
    grid: dict = {}
    for b in buildings:
        clat, clon = b["c"]
        cell = (int(clat / GRID_DEG), int(clon / GRID_DEG))
        grid.setdefault(cell, []).append(b)
    return grid


def nearby_buildings(lat: float, lon: float, grid: dict) -> list:
    """Buildings within SHADOW_RADIUS_M of (lat, lon)."""
    cos_lat = math.cos(math.radians(lat))
    cy = int(lat / GRID_DEG)
    cx = int(lon / GRID_DEG)
    candidates: list = []
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            candidates.extend(grid.get((cy + dy, cx + dx), []))

    result = []
    for b in candidates:
        clat, clon = b["c"]
        dlat = (clat - lat) * 111320.0
        dlon = (clon - lon) * 111320.0 * cos_lat
        if math.sqrt(dlat * dlat + dlon * dlon) <= SHADOW_RADIUS_M:
            result.append(b)
    return result


# ── Background enrichment job ──────────────────────────────────────────────────

async def run_shadow_enrichment_job(get_db_func) -> None:
    """Fetch all buildings once, then store nearby buildings JSON per venue."""
    global _shadow_state
    if _shadow_state["running"]:
        return

    _shadow_state = {
        "running": True, "total": 0, "done": 0, "updated": 0, "skipped": 0,
        "phase": "Hämtar byggnader från Overpass…",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    logger.info("Shadow enrichment job started")
    db: Session | None = None

    try:
        import httpx
        from app.models import SunTerrace

        async with httpx.AsyncClient() as client:
            buildings = await fetch_all_buildings(client)

        _shadow_state["phase"] = f"Bygger index ({len(buildings)} byggnader)…"
        grid = build_grid(buildings)

        db = next(get_db_func())
        terraces = (
            db.query(SunTerrace)
            .filter(SunTerrace.active == True)   # noqa: E712
            .order_by(SunTerrace.id)
            .all()
        )
        _shadow_state["total"] = len(terraces)
        _shadow_state["phase"] = "Beräknar skuggor per venue…"

        for i, t in enumerate(terraces):
            try:
                nearby = nearby_buildings(t.lat, t.lon, grid)
                # Drop centroid key — not needed at query time
                slim = [{"h": b["h"], "p": b["p"]} for b in nearby]
                t.shadow_buildings_json = json.dumps(slim, separators=(",", ":"))
                t.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                _shadow_state["updated"] += 1
            except Exception as exc:
                logger.warning("Shadow enrich failed for terrace %d: %s", t.id, exc)
                _shadow_state["skipped"] += 1

            if (i + 1) % COMMIT_EVERY == 0:
                db.commit()
                _shadow_state["done"] = i + 1
                await asyncio.sleep(0)  # yield to event loop

        db.commit()
        _shadow_state["done"] = len(terraces)
        logger.info("Shadow enrichment done: %d venues updated", _shadow_state["updated"])

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
