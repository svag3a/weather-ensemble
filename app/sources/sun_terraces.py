"""
Solsökaren — Sun Terrace scoring and OSM data fetching.

Solar position uses the Spencer formula (pure Python, no external libs).
Scores are computed on-the-fly at query time; only venue metadata is stored.
"""
from __future__ import annotations

import math
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.models import SunTerrace

logger = logging.getLogger(__name__)

# ── Solar position ────────────────────────────────────────────────────────────

def solar_position(lat: float, lon: float, dt: datetime) -> tuple[float, float]:
    """
    Compute solar azimuth (°, 0=N, 90=E, 180=S, 270=W) and altitude (°)
    for the given lat/lon at UTC datetime dt.
    Returns (0.0, altitude) when sun is below horizon.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    doy = dt.timetuple().tm_yday
    declination = 23.45 * math.sin(math.radians((360 / 365) * (doy - 81)))
    B = math.radians((360 / 365) * (doy - 81))
    eot = 9.87 * math.sin(2 * B) - 7.53 * math.cos(B) - 1.5 * math.sin(B)
    solar_noon = 12 - lon / 15 - eot / 60
    utc_h = dt.hour + dt.minute / 60 + dt.second / 3600
    hour_angle = 15 * (utc_h - solar_noon)
    lat_r = math.radians(lat)
    dec_r = math.radians(declination)
    ha_r = math.radians(hour_angle)
    sin_alt = (math.sin(lat_r) * math.sin(dec_r)
               + math.cos(lat_r) * math.cos(dec_r) * math.cos(ha_r))
    altitude = math.degrees(math.asin(max(-1.0, min(1.0, sin_alt))))
    if altitude <= 0:
        return 0.0, altitude
    cos_az = ((math.sin(dec_r) - math.sin(lat_r) * sin_alt)
              / (math.cos(lat_r) * math.cos(math.radians(altitude))))
    azimuth = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
    if hour_angle > 0:
        azimuth = 360 - azimuth
    return azimuth, altitude


# ── Orientation scoring ───────────────────────────────────────────────────────

ORIENTATION_AZIMUTHS = {
    "N": 0, "NE": 45, "E": 90, "SE": 135,
    "S": 180, "SW": 225, "W": 270, "NW": 315,
}


def orientation_score(sun_azimuth: float, terrace_orientation: Optional[str]) -> int:
    """How much sun hits a terrace facing `terrace_orientation` when sun is at `sun_azimuth`.
    Returns 0–100."""
    if not terrace_orientation or terrace_orientation == "UNKNOWN":
        return 50  # neutral when unknown
    terrace_az = ORIENTATION_AZIMUTHS.get(terrace_orientation)
    if terrace_az is None:
        return 50
    diff = abs((sun_azimuth - terrace_az + 180) % 360 - 180)
    return max(0, int(100 * (1 - diff / 180)))


# ── Weather scoring ───────────────────────────────────────────────────────────

def weather_score(fc: dict) -> dict:
    """Compute sub-scores from a forecast dict."""
    temp = fc.get("temperature", 15) or 15
    precip = fc.get("precip_probability", 0) or 0
    wind = fc.get("wind_speed", 3) or 3
    cloud = fc.get("cloud_cover", 30) or 30
    temp_s = max(0, min(100, int((temp - 8) / 20 * 100)))   # 8°C=0, 28°C=100
    wind_s = max(0, min(100, int((12 - wind) / 10 * 100)))   # 12 m/s=0, 2 m/s=100
    cloud_s = max(0, min(100, int(100 - cloud)))              # 0% cloud=100
    precip_s = max(0, min(100, int(100 - precip * 1.5)))     # 0%=100, 67%+=0
    combined = int(0.4 * cloud_s + 0.35 * precip_s + 0.15 * temp_s + 0.1 * wind_s)
    return {
        "temp": temp_s, "wind": wind_s, "cloud": cloud_s,
        "precip": precip_s, "combined": combined,
    }


# ── Composite score ───────────────────────────────────────────────────────────

def compute_scores(
    lat: float,
    lon: float,
    orientation: Optional[str],
    orientation_conf: float,
    forecast_hours: list,
) -> dict:
    """Compute now / +1h / +2h scores for a terrace given pre-fetched forecast hours."""
    now = datetime.now(timezone.utc)
    result: dict = {}
    for offset_h, key in [(0, "now"), (1, "1h"), (2, "2h")]:
        target = now + timedelta(hours=offset_h)
        az, alt = solar_position(lat, lon, target)
        if alt <= 0:
            result[key] = {"sun_score": 0, "total_score": 0}
            continue
        # Find closest forecast entry
        if forecast_hours:
            fc = min(
                forecast_hours,
                key=lambda f: abs((f.get("valid_for_ts", 0)) - target.timestamp()),
            )
        else:
            fc = {}
        ws = weather_score(fc)
        os_val = orientation_score(az, orientation)
        # If orientation unknown, cap orientation contribution
        eff_os = os_val if orientation and orientation != "UNKNOWN" else min(os_val, 60)
        total = int(0.55 * eff_os + 0.30 * ws["cloud"] + 0.10 * ws["temp"] + 0.05 * ws["wind"])
        # Rain kills the score
        if ws["precip"] < 40:
            total = int(total * ws["precip"] / 40)
        result[key] = {
            "sun_score": int((alt / 90) * eff_os),
            "weather_score": ws["combined"],
            "total_score": min(100, total),
            "sun_azimuth": round(az, 1),
            "sun_altitude": round(alt, 1),
        }
    best_time = max(["now", "1h", "2h"], key=lambda k: result[k]["total_score"])
    result["best_time"] = best_time
    result["confidence"] = orientation_conf if orientation and orientation != "UNKNOWN" else 0.3
    return result


# ── Overpass fetching ─────────────────────────────────────────────────────────

async def fetch_from_overpass(client) -> list[dict]:
    """Query Overpass for restaurants/cafes/bars/pubs in Göteborg bounding box."""
    query = """
[out:json][timeout:60];
(
  node["amenity"~"^(restaurant|cafe|bar|pub)$"]["outdoor_seating"="yes"]
    (57.60,11.70,57.85,12.10);
  node["amenity"~"^(restaurant|cafe|bar|pub)$"]
    (57.60,11.70,57.85,12.10);
);
out body;
"""
    resp = await client.post(
        "https://overpass-api.de/api/interpreter",
        data={"data": query},
        headers={"User-Agent": "gbgvader.se/1.0 sun-terrace-finder (https://gbgvader.se)"},
        timeout=90,
    )
    resp.raise_for_status()
    elements = resp.json().get("elements", [])
    venues = []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        amenity = tags.get("amenity", "restaurant")
        addr_parts = [tags.get("addr:housenumber", ""), tags.get("addr:street", "")]
        address = " ".join(p for p in addr_parts if p) or None
        # Orientation from OSM tags if available (rare)
        osm_ori = tags.get("terrace:orientation") or tags.get("outdoor:orientation")
        orientation = (
            osm_ori.upper()
            if osm_ori and osm_ori.upper() in ORIENTATION_AZIMUTHS
            else "UNKNOWN"
        )
        ori_conf = 0.8 if orientation != "UNKNOWN" else 0.3
        venues.append({
            "source_id": f"osm_node_{el['id']}",
            "name": name,
            "lat": el["lat"],
            "lon": el["lon"],
            "amenity_type": amenity,
            "address": address,
            "website": tags.get("website") or tags.get("contact:website"),
            "outdoor_seating": tags.get("outdoor_seating") == "yes",
            "street_orientation": orientation,
            "orientation_confidence": ori_conf,
        })
    # Deduplicate by source_id (Overpass may return duplicates)
    seen: set = set()
    deduped = []
    for v in venues:
        if v["source_id"] not in seen:
            seen.add(v["source_id"])
            deduped.append(v)
    return deduped


async def refresh_terraces(db: Session, client) -> None:
    """Fetch venues from Overpass and upsert into sun_terraces table."""
    logger.info("Refreshing sun terraces from Overpass…")
    try:
        venues = await fetch_from_overpass(client)
    except Exception as exc:
        logger.warning("Overpass fetch failed: %s", exc)
        return

    now = datetime.utcnow()
    fetched_ids = set()
    for v in venues:
        fetched_ids.add(v["source_id"])
        existing = (
            db.query(SunTerrace)
            .filter(SunTerrace.source_id == v["source_id"])
            .first()
        )
        if existing is None:
            db.add(SunTerrace(
                source="osm",
                source_id=v["source_id"],
                name=v["name"],
                lat=v["lat"],
                lon=v["lon"],
                amenity_type=v["amenity_type"],
                address=v["address"],
                website=v["website"],
                outdoor_seating=v["outdoor_seating"],
                street_orientation=v["street_orientation"],
                orientation_confidence=v["orientation_confidence"],
                active=True,
                last_seen_at=now,
                created_at=now,
                updated_at=now,
            ))
        else:
            # Update mutable fields; preserve manual orientation overrides
            existing.name = v["name"]
            existing.lat = v["lat"]
            existing.lon = v["lon"]
            existing.amenity_type = v["amenity_type"]
            existing.address = v["address"]
            existing.website = v["website"]
            existing.outdoor_seating = v["outdoor_seating"]
            existing.active = True
            existing.last_seen_at = now
            existing.updated_at = now
            # Only update orientation if it was not manually set (confidence > 0.7)
            if existing.orientation_confidence < 0.7:
                existing.street_orientation = v["street_orientation"]
                existing.orientation_confidence = v["orientation_confidence"]

    # Mark venues no longer in OSM as inactive
    all_terraces = db.query(SunTerrace).filter(SunTerrace.source == "osm").all()
    for t in all_terraces:
        if t.source_id not in fetched_ids:
            t.active = False
            t.updated_at = now

    db.commit()
    logger.info("Sun terraces refresh done: %d venues upserted", len(venues))
