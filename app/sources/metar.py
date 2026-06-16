"""
METAR cloud cover nowcast from Göteborg-Landvetter (ESGG).

Fetches latest METAR via aviationweather.gov and converts sky condition
codes (CLR/FEW/SCT/BKN/OVC) to a cloud cover percentage.

Used in /forecast/local to correct the NWP ensemble's cloud cover for
near-term hours (0–3h), where model bias is largest.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Sync cache (for use in sync FastAPI routes) ───────────────────────────────
_cache_lock  = threading.Lock()
_cache: dict = {}          # {"cloud_cover": float, "fetched_at": datetime}
_CACHE_TTL   = 25 * 60    # 25 minutes — METAR updates every 30 min


def get_cached_metar_cloud() -> Optional[float]:
    """
    Synchronous METAR fetch with 25-minute in-process cache.
    Thread-safe; used from sync FastAPI route handlers.
    Returns stale value on network failure.
    """
    import httpx

    with _cache_lock:
        now = datetime.now(timezone.utc)
        cached = _cache.get("data")
        if cached and (now - cached["fetched_at"]).total_seconds() < _CACHE_TTL:
            return cached["cloud_cover"]

        url = "https://aviationweather.gov/api/data/metar?ids=ESGG&format=geojson&taf=false"
        try:
            with httpx.Client(timeout=6.0) as client:
                resp = client.get(url)
                resp.raise_for_status()
                data = resp.json()
            features = data.get("features") or []
            if not features:
                return (cached or {}).get("cloud_cover")
            props = features[0].get("properties") or {}
            cover = _parse_cover(props.get("clouds") or [])
            if cover is None:
                top = (props.get("cover") or "").upper()
                cover = _COVER_PCT.get(top)
            if cover is not None:
                _cache["data"] = {"cloud_cover": cover, "fetched_at": now}
                logger.debug("METAR ESGG (sync): %s → %.0f%%", props.get("rawOb", ""), cover)
                return cover
        except Exception as exc:
            logger.warning("METAR sync fetch failed: %s", exc)

        return (cached or {}).get("cloud_cover")  # stale fallback


def apply_metar_cloud_correction(forecast_hours: list, now: datetime) -> list:
    """
    Apply METAR-based cloud cover correction to a forecast_hours list of dicts.
    Each dict must have 'cloud_cover' (float|None) and 'valid_for_ts' (epoch float).
    Returns a new list with corrected cloud_cover values for near-term hours.
    """
    metar_cloud = get_cached_metar_cloud()
    if metar_cloud is None:
        return forecast_hours

    now_ts = now.replace(tzinfo=None).timestamp() if now.tzinfo else now.timestamp()
    result = []
    for f in forecast_hours:
        ts = f.get("valid_for_ts")
        if ts is None or f.get("cloud_cover") is None:
            result.append(f)
            continue
        lead = max(1, round((ts - now_ts) / 3600))
        mf = metar_cloud_fraction(lead)
        if mf > 0:
            corrected = round(mf * metar_cloud + (1 - mf) * f["cloud_cover"], 1)
            result.append({**f, "cloud_cover": corrected})
        else:
            result.append(f)
    return result

# Blend weights per lead-hour bucket: fraction of METAR vs ensemble
# Decays linearly — observation is most reliable right now, useless by hour 4.
METAR_CLOUD_WEIGHT: dict[int, float] = {
    1: 0.80,   # 0–1 h
    3: 0.55,   # 1–3 h
    6: 0.25,   # 3–6 h
}

# Sky condition code → cloud cover percentage (midpoint of oktas range)
_COVER_PCT: dict[str, float] = {
    "SKC": 0.0,
    "CLR": 0.0,
    "NSC": 0.0,   # no significant cloud
    "NCD": 0.0,   # no cloud detected
    "CAVOK": 0.0,
    "FEW": 18.75,  # 1–2/8 → mid = 1.5/8
    "SCT": 43.75,  # 3–4/8 → mid = 3.5/8
    "BKN": 81.25,  # 5–7/8 → mid = 6/8 (ceiling)
    "OVC": 100.0,
    "VV":  100.0,  # vertical visibility obscured (fog/smoke)
}


def _parse_cover(clouds: list[dict]) -> Optional[float]:
    """Return total cloud cover % from a list of {'cover': str, 'base': int} dicts."""
    if not clouds:
        return None
    max_pct = 0.0
    found = False
    for layer in clouds:
        code = (layer.get("cover") or "").upper()
        pct = _COVER_PCT.get(code)
        if pct is not None:
            max_pct = max(max_pct, pct)
            found = True
    return round(max_pct, 1) if found else None


async def fetch_metar_cloud(client) -> Optional[dict]:
    """
    Fetch latest METAR for ESGG and return:
      {"cloud_cover": float, "observed_at": datetime, "raw": str}
    Returns None on any error.
    """
    url = "https://aviationweather.gov/api/data/metar?ids=ESGG&format=geojson&taf=false"
    try:
        resp = await client.get(url, timeout=8.0)
        resp.raise_for_status()
        data = resp.json()
        features = data.get("features") or []
        if not features:
            logger.warning("METAR: no features in response")
            return None

        props = features[0].get("properties") or {}
        clouds = props.get("clouds") or []
        cover = _parse_cover(clouds)

        # Also accept the simple top-level 'cover' field as fallback
        if cover is None:
            top = (props.get("cover") or "").upper()
            cover = _COVER_PCT.get(top)

        if cover is None:
            raw = props.get("rawOb", "")
            logger.debug("METAR: could not parse cloud cover from: %s", raw)
            return None

        obs_time = props.get("obsTime")  # ISO string e.g. "2026-06-16T06:20:00.000Z"
        observed_at = None
        if obs_time:
            try:
                observed_at = datetime.fromisoformat(obs_time.replace("Z", "+00:00"))
            except ValueError:
                pass

        raw_ob = props.get("rawOb", "")
        logger.debug("METAR ESGG: %s → cloud_cover=%.0f%%", raw_ob, cover)
        return {
            "cloud_cover": cover,
            "observed_at": observed_at,
            "raw": raw_ob,
        }

    except Exception as exc:
        logger.warning("METAR fetch failed: %s", exc)
        return None


def metar_cloud_fraction(lead_hours: int) -> float:
    """Return blend weight for METAR at the given lead time.
    Uses calibrated weight if available, otherwise falls back to defaults."""
    if lead_hours <= 1:
        bucket = 1
    elif lead_hours <= 3:
        bucket = 3
    elif lead_hours <= 6:
        bucket = 6
    else:
        return 0.0
    return _calibrated_weights.get(bucket, METAR_CLOUD_WEIGHT[bucket])


# ── Calibrated weight cache ───────────────────────────────────────────────────
# Populated from MetarBlendConfig table at startup and after each calibration run.
_calibrated_weights: dict[int, float] = {}


def load_calibrated_weights(db) -> None:
    """Load calibrated blend weights from DB into the module-level cache.
    Safe to call with any SQLAlchemy Session."""
    from app.models import MetarBlendConfig
    try:
        rows = db.query(MetarBlendConfig).all()
        for row in rows:
            _calibrated_weights[row.lead_bucket] = row.weight
        if rows:
            logger.info(
                "METAR blend weights loaded: %s",
                {r.lead_bucket: round(r.weight, 2) for r in rows},
            )
    except Exception as exc:
        logger.warning("Could not load calibrated METAR weights: %s", exc)
