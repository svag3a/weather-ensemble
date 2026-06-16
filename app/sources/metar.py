"""
METAR cloud cover nowcast from Göteborg-Landvetter (ESGG).

Fetches latest METAR via aviationweather.gov and converts sky condition
codes (CLR/FEW/SCT/BKN/OVC) to a cloud cover percentage.

Used in /forecast/local to correct the NWP ensemble's cloud cover for
near-term hours (0–3h), where model bias is largest.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

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
    """Return blend weight for METAR at the given lead time (0 = pure ensemble)."""
    if lead_hours <= 1:
        return METAR_CLOUD_WEIGHT[1]
    if lead_hours <= 3:
        return METAR_CLOUD_WEIGHT[3]
    if lead_hours <= 6:
        return METAR_CLOUD_WEIGHT[6]
    return 0.0
