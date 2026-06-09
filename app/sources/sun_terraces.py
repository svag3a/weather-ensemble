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


def orientation_score_deg(sun_azimuth: float, terrace_bearing: float) -> float:
    """Cosine-based score: 100 when sun faces the edge directly, 0 when perpendicular
    or behind. Edges facing away from the sun contribute 0 (not 50)."""
    diff_rad = math.radians(abs((sun_azimuth - terrace_bearing + 180) % 360 - 180))
    return max(0.0, 100.0 * math.cos(diff_rad))


def polygon_orientation_score(sun_azimuth: float, polygon_coords: list) -> float:
    """Score-weighted orientation score for a polygon terrace.

    Formula: sum(score² × edge_length) / sum(score × edge_length)

    This is a score-biased weighted mean that naturally emphasises the
    best-lit faces of the polygon.  Examples:
      • Pure south face, sun due south  → 100
      • Pure west face, sun due south   →  50
      • Rectangle (all 4 sides equal), sun due south → 75
      • L-shape (50% south + 50% west), sun due south or due west → 83

    An L-shaped corner terrace consistently scores ~83 as the sun sweeps
    across its exposed quadrant, instead of the flat 50 that a naive
    perimeter-average would produce.
    """
    if not polygon_coords or len(polygon_coords) < 3:
        return 50.0

    # Area-weighted centroid (Shoelace) — reliable for non-convex (L-shaped) polygons.
    # Simple vertex average fails for L-shapes because it lands on the inner corner.
    n = len(polygon_coords)
    # Translate to origin to avoid catastrophic cancellation.
    # Raw lat/lon values (~57, ~12) are large; the polygon is tiny (~1e-4 deg).
    # Products like lo*la1 - lo1*la cancel to ~0 in float64 without this step.
    ref_la = polygon_coords[0][0]
    ref_lo = polygon_coords[0][1]
    pts = [(c[0] - ref_la, c[1] - ref_lo) for c in polygon_coords]

    area2 = 0.0   # accumulates 2·A (Shoelace without ×0.5)
    cy = cx = 0.0
    for i in range(n):
        la, lo   = pts[i]
        la1, lo1 = pts[(i + 1) % n]
        # Standard 2-D cross product: x=lon, y=lat → cross = x·y' - x'·y
        cross = lo * la1 - lo1 * la
        area2 += cross
        cy += (la + la1) * cross   # lat (y) component
        cx += (lo + lo1) * cross   # lon (x) component
    if abs(area2) < 1e-30:
        # Degenerate polygon — fall back to vertex average
        cent_lat = sum(c[0] for c in polygon_coords) / n
        cent_lon = sum(c[1] for c in polygon_coords) / n
    else:
        # area2 = 2·A, so centroid = Σ / (3 · area2); add back the reference offset
        cent_lat = ref_la + cy / (3.0 * area2)
        cent_lon = ref_lo + cx / (3.0 * area2)

    # Scale factor: 1 degree of longitude is shorter than 1 degree of latitude
    # at high latitudes.  Without correction, east-west edges (south/north faces)
    # appear 1/cos(lat) ≈ 1.87× longer than north-south edges (east/west faces)
    # in Göteborg (lat 57.7°), causing west/east exposure to be heavily under-scored.
    cos_lat = math.cos(math.radians(cent_lat))

    edges = []
    max_len = 0.0
    for i in range(len(polygon_coords)):
        a = polygon_coords[i]
        b = polygon_coords[(i + 1) % len(polygon_coords)]
        dlat = b[0] - a[0]
        dlon = b[1] - a[1]
        # Physical length: scale lon difference by cos(lat) so both components
        # are in comparable units (proportional to metres on the ground).
        dlat_m = dlat
        dlon_m = dlon * cos_lat
        length = math.sqrt(dlat_m * dlat_m + dlon_m * dlon_m)
        if length < 1e-10:
            continue

        mid_lat = (a[0] + b[0]) / 2
        mid_lon = (a[1] + b[1]) / 2

        # Outward normal perpendicular to edge, pointing away from centroid.
        # Use the same cos_lat-scaled components for consistent direction.
        n_lat = -dlon_m / length   # north component
        n_lon =  dlat_m / length   # east component
        dot = n_lat * (cent_lat - mid_lat) + n_lon * (cent_lon - mid_lon) * cos_lat
        if dot > 0:
            n_lat, n_lon = -n_lat, -n_lon

        bearing = (math.degrees(math.atan2(n_lon, n_lat)) + 360) % 360
        edges.append((bearing, length))
        if length > max_len:
            max_len = length

    if max_len < 1e-10:
        return 50.0

    # Formula: min(100, Σ(cosine_score × edge_length) / longest_edge_length)
    #
    # Rationale: each edge contributes proportionally to its length vs. the
    # dominant face.  A corner terrace with two equally long faces facing the
    # sun sums to 200 → capped at 100 (full score).  A terrace with a tiny
    # west edge and a large south face scores ~5 when sun is in the west
    # (correctly reflecting that almost no seating gets direct afternoon sun).
    total = sum(orientation_score_deg(sun_azimuth, bearing) * length
                for bearing, length in edges)
    return min(100.0, total / max_len)


def arc_orientation_score(sun_azimuth: float, arc_from: float, arc_to: float) -> float:
    """Score 0–100 based on whether sun azimuth is within the exposure arc.
    The arc goes clockwise from arc_from to arc_to.
    Tapers linearly within 15° of each edge."""
    az = sun_azimuth % 360
    f = arc_from % 360
    t = arc_to % 360
    arc_span = (t - f + 360) % 360
    if arc_span < 1:
        arc_span = 360  # treat 0-span as full circle

    if arc_span >= 359:
        return 100.0  # full circle (rooftop)

    clockwise_dist = (az - f + 360) % 360
    if clockwise_dist > arc_span:
        return 0.0  # outside arc

    TAPER = 15.0
    d_start = clockwise_dist
    d_end   = arc_span - clockwise_dist
    d_min   = min(d_start, d_end)
    if d_min < TAPER:
        return 100.0 * d_min / TAPER
    return 100.0


def arc_from_polygon(polygon_coords: list) -> tuple:
    """Derive (arc_from, arc_to) exposure arc from polygon edge outward normals.
    Returns (None, None) on failure."""
    if not polygon_coords or len(polygon_coords) < 3:
        return None, None

    cos_lat = math.cos(math.radians(
        sum(c[0] for c in polygon_coords) / len(polygon_coords)
    ))

    n = len(polygon_coords)
    ref_la = polygon_coords[0][0]
    ref_lo = polygon_coords[0][1]
    pts = [(c[0] - ref_la, c[1] - ref_lo) for c in polygon_coords]

    area2 = cy = cx = 0.0
    for i in range(n):
        la, lo   = pts[i]
        la1, lo1 = pts[(i + 1) % n]
        cross = lo * la1 - lo1 * la
        area2 += cross
        cy += (la + la1) * cross
        cx += (lo + lo1) * cross

    if abs(area2) < 1e-30:
        return None, None

    cent_lat = ref_la + cy / (3 * area2)
    cent_lon = ref_lo + cx / (3 * area2)

    edge_bearings: list = []
    for i in range(n):
        a = polygon_coords[i]
        b = polygon_coords[(i + 1) % n]
        dlat = b[0] - a[0]
        dlon = b[1] - a[1]
        dlat_m = dlat
        dlon_m = dlon * cos_lat
        length = math.sqrt(dlat_m ** 2 + dlon_m ** 2)
        if length < 1e-10:
            continue
        mid_la = (a[0] + b[0]) / 2
        mid_lo = (a[1] + b[1]) / 2
        n_lat = -dlon_m / length
        n_lon  =  dlat_m / length
        dot = n_lat * (cent_lat - mid_la) + n_lon * (cent_lon - mid_lo) * cos_lat
        if dot > 0:
            n_lat, n_lon = -n_lat, -n_lon
        bearing = (math.degrees(math.atan2(n_lon, n_lat)) + 360) % 360
        edge_bearings.append((bearing, length))

    if not edge_bearings:
        return None, None

    total_w = sum(w for _, w in edge_bearings)

    # Build a 360-slot exposure map
    exposure = [0.0] * 360
    for bearing, weight in edge_bearings:
        w = weight / total_w
        for a in range(360):
            diff = abs((a - bearing + 180) % 360 - 180)
            if diff < 90:
                exposure[a] += w

    threshold = 0.02
    exposed = [e > threshold for e in exposure]

    if all(exposed):
        return 0.0, 360.0
    if not any(exposed):
        return None, None

    # Find first rising edge (unexposed → exposed)
    start = None
    for i in range(360):
        if exposed[i] and not exposed[(i - 1) % 360]:
            start = i
            break
    if start is None:
        start = next(i for i, e in enumerate(exposed) if e)

    # Walk clockwise from start until exposed ends
    end = start
    for i in range(1, 361):
        idx = (start + i) % 360
        if not exposed[idx]:
            end = (start + i - 1) % 360
            break

    return float(start), float(end)


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


# ── Day score ────────────────────────────────────────────────────────────────

def compute_day_score(
    lat: float,
    lon: float,
    orientation: Optional[str],
    polygon_coords_json: Optional[str] = None,
    sun_arc_from: Optional[float] = None,
    sun_arc_to: Optional[float] = None,
    is_rooftop: bool = False,
    forecast_hours: Optional[list] = None,
) -> int:
    """Weighted-average sun+weather score from now until the next daylight period.

    Weight = sin(solar_altitude) so high-sun hours count more.
    Samples every 30 min up to 12 h ahead; stops at first sunset.
    Result is 0–100.  A rooftop always scores 100 (sky-facing).

    Normalisation: a terrace with a 360° arc (rooftop) achieves the
    theoretical maximum of 100 for any day, so no additional scaling
    is needed — the formula is already in a 0–100 range.
    """
    now = datetime.now(timezone.utc)

    # Pre-parse polygon once
    poly = None
    if polygon_coords_json:
        try:
            import json as _json
            poly = _json.loads(polygon_coords_json)
        except Exception:
            poly = None

    def _os(az: float, target_ts: float) -> float:
        """Orientation score, optionally blended with weather for this time step."""
        # Pure geometric orientation score
        if is_rooftop:
            geo = 100.0
        elif sun_arc_from is not None and sun_arc_to is not None:
            geo = arc_orientation_score(az, sun_arc_from, sun_arc_to)
        elif poly:
            geo = polygon_orientation_score(az, poly)
        else:
            os_val = orientation_score(az, orientation)
            geo = float(os_val if orientation and orientation != "UNKNOWN" else min(os_val, 60))

        if not forecast_hours:
            return geo

        # Blend with weather: same weights as per-hour total_score
        fc = min(forecast_hours, key=lambda f: abs(f.get("valid_for_ts", 0) - target_ts))
        ws = weather_score(fc)
        combined = 0.55 * geo + 0.30 * ws["cloud"] + 0.10 * ws["temp"] + 0.05 * ws["wind"]
        # Rain kills the score
        if ws["precip"] < 40:
            combined = combined * ws["precip"] / 40
        return max(0.0, min(100.0, combined))

    # Scan up to 50 steps (25 h) to cover nighttime → next sunrise → next sunset.
    # During daytime the loop starts accumulating immediately.
    # During nighttime it skips until the next sunrise, then runs to sunset.
    samples: list = []     # (minutes_from_now, os_value, sin_altitude_weight)
    sunrise_seen = False

    for step in range(0, 50):
        minutes = step * 30
        target  = now + timedelta(minutes=minutes)
        az, alt = solar_position(lat, lon, target)
        if alt <= 0:
            if sunrise_seen:
                break      # sunset reached — stop
            continue       # nighttime before sunrise — skip
        sunrise_seen = True
        samples.append((minutes, _os(az, target.timestamp()), math.sin(math.radians(alt))))

    if not samples:
        return 0, [], False

    # is_upcoming: first sample is not "now" (sun was below horizon when called)
    is_upcoming = samples[0][0] > 0

    # Gradient: frac is 0→1 over the *daylight window* (sunrise to sunset),
    # independent of how far in the future that window is.
    window_start    = samples[0][0]
    window_duration = max(samples[-1][0] - window_start, 1)
    gradient = [
        {"frac": round((m - window_start) / window_duration, 4), "score": int(os)}
        for m, os, _ in samples
    ]

    # Day score: altitude-weighted mean
    total_w = sum(w for _, _, w in samples)
    total_s = sum(os * w for _, os, w in samples)
    day_score = 0 if total_w < 1e-9 else min(100, round(total_s / total_w))

    return day_score, gradient, is_upcoming


# ── Composite score ───────────────────────────────────────────────────────────

def compute_scores(
    lat: float,
    lon: float,
    orientation: Optional[str],
    orientation_conf: float,
    forecast_hours: list,
    outdoor_seating: bool = False,
    is_rooftop: bool = False,
    polygon_coords_json: Optional[str] = None,
    sun_arc_from: Optional[float] = None,
    sun_arc_to:   Optional[float] = None,
) -> dict:
    """Compute now / +1h / +2h scores for a terrace given pre-fetched forecast hours."""
    now = datetime.now(timezone.utc)
    result: dict = {}
    for offset_h, key in [(0, "now"), (1, "1h"), (2, "2h")]:
        target = now + timedelta(hours=offset_h)
        az, alt = solar_position(lat, lon, target)
        if alt <= 0:
            result[key] = {"sun_score": 0, "orientation_score": 0, "total_score": 0}
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

        if is_rooftop:
            total = int(0.50 * ws["cloud"] + 0.35 * ws["precip"] + 0.10 * ws["temp"] + 0.05 * ws["wind"])
            total = min(100, total + 10)
            if ws["precip"] < 40:
                total = int(total * ws["precip"] / 40)
            result[key] = {
                "sun_score": int((alt / 90) * 100),
                "orientation_score": 100,   # rooftop always fully sky-exposed
                "weather_score": ws["combined"],
                "total_score": min(100, total),
                "sun_azimuth": round(az, 1),
                "sun_altitude": round(alt, 1),
            }
            continue

        # Arc takes priority → polygon → single direction
        if sun_arc_from is not None and sun_arc_to is not None:
            eff_os = arc_orientation_score(az, sun_arc_from, sun_arc_to)
        elif polygon_coords_json:
            try:
                import json as _json
                poly = _json.loads(polygon_coords_json)
                eff_os = polygon_orientation_score(az, poly)
            except Exception:
                eff_os = orientation_score(az, orientation)
        else:
            os_val = orientation_score(az, orientation)
            has_known_orientation = orientation and orientation != "UNKNOWN"
            eff_os = os_val if has_known_orientation else min(os_val, 60)

        total = int(0.55 * eff_os + 0.30 * ws["cloud"] + 0.10 * ws["temp"] + 0.05 * ws["wind"])
        if outdoor_seating:
            total = min(100, total + 8)
        if ws["precip"] < 40:
            total = int(total * ws["precip"] / 40)
        result[key] = {
            "sun_score": int((alt / 90) * eff_os),
            "orientation_score": int(eff_os),   # pure directional exposure, 0–100
            "weather_score": ws["combined"],
            "total_score": min(100, total),
            "sun_azimuth": round(az, 1),
            "sun_altitude": round(alt, 1),
        }
    best_time = max(["now", "1h", "2h"], key=lambda k: result[k]["total_score"])
    result["best_time"] = best_time
    if is_rooftop:
        result["confidence"] = 1.0
    elif sun_arc_from is not None:
        result["confidence"] = 1.0
    elif polygon_coords_json:
        result["confidence"] = 1.0
    else:
        result["confidence"] = orientation_conf if orientation and orientation != "UNKNOWN" else 0.3
    # Day score + gradient: weighted sun exposure from now until sunset
    day_score, gradient, gradient_is_upcoming = compute_day_score(
        lat, lon, orientation,
        polygon_coords_json=polygon_coords_json,
        sun_arc_from=sun_arc_from,
        sun_arc_to=sun_arc_to,
        is_rooftop=is_rooftop,
        forecast_hours=forecast_hours,
    )
    result["day_score"]            = day_score
    result["gradient"]             = gradient
    result["gradient_is_upcoming"] = gradient_is_upcoming
    return result


# ── Overpass fetching ─────────────────────────────────────────────────────────

async def fetch_from_overpass(client) -> list[dict]:
    """Query Overpass for restaurants/cafes/bars/pubs/biergardens in Göteborg.

    Fetches nodes, ways AND relations so venues mapped as building polygons
    are included.  Uses `out center` to get centroid coordinates for ways/relations.
    """
    query = """
[out:json][timeout:90];
(
  node["amenity"~"^(restaurant|cafe|bar|pub|biergarten)$"]
    (57.60,11.70,57.85,12.10);
  way["amenity"~"^(restaurant|cafe|bar|pub|biergarten)$"]
    (57.60,11.70,57.85,12.10);
  relation["amenity"~"^(restaurant|cafe|bar|pub|biergarten)$"]
    (57.60,11.70,57.85,12.10);
);
out center;
"""
    import urllib.parse
    encoded = urllib.parse.urlencode({"data": query})
    # Try multiple Overpass endpoints for resilience
    endpoints = [
        "https://overpass.kumi.systems/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass-api.de/api/interpreter",
    ]
    resp = None
    last_exc = None
    for url in endpoints:
        try:
            resp = await client.post(
                url,
                content=encoded.encode(),
                headers={
                    "User-Agent": "gbgvader.se/1.0 (sun-terrace-finder; https://gbgvader.se)",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout=90,
            )
            if resp.status_code == 200:
                break
        except Exception as exc:
            last_exc = exc
            continue
    if resp is None or resp.status_code != 200:
        raise Exception(f"All Overpass endpoints failed. Last: {last_exc or resp.status_code}")
    elements = resp.json().get("elements", [])
    venues = []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue

        # Coordinates: nodes have lat/lon directly; ways/relations get centroid via `out center`
        el_type = el.get("type", "node")
        if el_type == "node":
            lat = el.get("lat")
            lon = el.get("lon")
        else:
            center = el.get("center", {})
            lat = center.get("lat")
            lon = center.get("lon")
        if lat is None or lon is None:
            continue

        amenity = tags.get("amenity", "restaurant")
        # Map biergarten → pub for amenity_type consistency
        if amenity == "biergarten":
            amenity = "pub"

        street = (tags.get("addr:street") or tags.get("contact:street") or "")
        housenr = (tags.get("addr:housenumber") or tags.get("addr:streetnumber") or "")
        full = tags.get("addr:full") or ""
        if full:
            address = full.strip() or None
        else:
            addr_parts = [street, housenr]
            address = " ".join(p for p in addr_parts if p).strip() or None
        # Orientation from OSM tags if available (rare)
        osm_ori = tags.get("terrace:orientation") or tags.get("outdoor:orientation")
        orientation = (
            osm_ori.upper()
            if osm_ori and osm_ori.upper() in ORIENTATION_AZIMUTHS
            else "UNKNOWN"
        )
        ori_conf = 0.8 if orientation != "UNKNOWN" else 0.3
        venues.append({
            "source_id": f"osm_{el_type}_{el['id']}",
            "name": name,
            "lat": lat,
            "lon": lon,
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

    # Log breakdown by element type
    type_counts: dict = {}
    for v in deduped:
        t = v["source_id"].split("_")[1]   # "node" / "way" / "relation"
        type_counts[t] = type_counts.get(t, 0) + 1
    logger.info(
        "Overpass returned %d unique venues: %s",
        len(deduped),
        ", ".join(f"{t}={c}" for t, c in sorted(type_counts.items())),
    )
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
    added = 0
    updated = 0
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
            added += 1
        else:
            # Update mutable fields; preserve manual orientation overrides.
            # Do NOT touch active — a manually deactivated venue should stay
            # inactive even if it still exists in OSM.
            existing.name = v["name"]
            existing.lat = v["lat"]
            existing.lon = v["lon"]
            existing.amenity_type = v["amenity_type"]
            existing.address = v["address"]
            existing.website = v["website"]
            existing.outdoor_seating = v["outdoor_seating"]
            existing.last_seen_at = now
            existing.updated_at = now
            # Only update orientation if it was not manually set (confidence > 0.7)
            if existing.orientation_confidence < 0.7:
                existing.street_orientation = v["street_orientation"]
                existing.orientation_confidence = v["orientation_confidence"]
            updated += 1

    # Mark venues no longer in OSM as inactive
    all_terraces = db.query(SunTerrace).filter(SunTerrace.source == "osm").all()
    deactivated = 0
    for t in all_terraces:
        if t.source_id not in fetched_ids:
            t.active = False
            t.updated_at = now
            deactivated += 1

    db.commit()
    logger.info(
        "Sun terraces refresh done: %d fetched → +%d new, %d updated, %d deactivated",
        len(venues), added, updated, deactivated,
    )
    return {"added": added, "updated": updated, "deactivated": deactivated, "total": len(venues)}
