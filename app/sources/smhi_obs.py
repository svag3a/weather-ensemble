"""
SMHI multi-station observations for Göteborg.
Fetches from three stations and computes a composite truth:

  Station       ID     Role          Dist from centre
  Göteborg A   71420  City / primary      ~2 km
  Vinga A      71380  Coastal / exposed  ~23 km west
  Landvetter   72420  Inland / airport   ~19 km east

Composite rules per parameter:
  Temperature  — GöteborgA 80 %, Landvetter 20 % (Vinga excluded: maritime bias)
  Wind speed   — GöteborgA 50 %, Vinga 30 %, Landvetter 20 %  (Vinga captures sea winds)
  Precipitation — weighted average; event threshold applied in _get_truth
"""
from __future__ import annotations

import asyncio
import httpx
from datetime import datetime, timezone
from typing import Optional

_BASE = "https://opendata-download-metobs.smhi.se/api/version/latest"

STATIONS = [
    {"id": 71420, "name": "Göteborg A", "lat": 57.7156, "lon": 11.9924},
    {"id": 71380, "name": "Vinga A",    "lat": 57.6322, "lon": 11.6048},
    {"id": 72420, "name": "Landvetter", "lat": 57.6764, "lon": 12.2919},
]

_PARAM_TEMP   = 1
_PARAM_WIND   = 4
_PARAM_PRECIP = 7

# Composite weights — must sum to ≤ 1.0; missing stations are re-normalised automatically
_TEMP_WEIGHTS   = {71420: 0.80, 72420: 0.20, 71380: 0.00}
_WIND_WEIGHTS   = {71420: 0.50, 71380: 0.30, 72420: 0.20}
_PRECIP_WEIGHTS = {71420: 0.60, 71380: 0.25, 72420: 0.15}


async def _fetch_latest_value(
    client: httpx.AsyncClient, param_id: int, station_id: int
) -> Optional[tuple[datetime, float]]:
    url = f"{_BASE}/parameter/{param_id}/station/{station_id}/period/latest-hour/data.json"
    try:
        resp = await client.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        for entry in reversed(data.get("value", [])):
            val_str = entry.get("value", "")
            if not val_str or val_str == "Riktning saknas":
                continue
            try:
                val = float(val_str)
                dt = datetime.fromtimestamp(entry["date"] / 1000, tz=timezone.utc)
                dt = dt.replace(minute=0, second=0, microsecond=0, tzinfo=None)
                return dt, val
            except (ValueError, KeyError):
                continue
    except Exception:
        pass
    return None


def _weighted_avg(readings: dict[int, float], weights: dict[int, float]) -> Optional[float]:
    """Weighted average of available readings, re-normalising if stations are missing."""
    total_w = 0.0
    total_v = 0.0
    for sid, w in weights.items():
        if w > 0 and sid in readings:
            total_v += readings[sid] * w
            total_w += w
    if total_w == 0:
        return None
    return total_v / total_w


async def fetch(client: httpx.AsyncClient) -> Optional[dict]:
    """
    Fetch observations from all three stations and return a composite truth dict:
      {"valid_for", "temperature", "wind_speed", "precip_mm", "station_ids"}
    Returns None if the primary station (Göteborg A) has no temperature reading.
    """
    station_ids = [s["id"] for s in STATIONS]
    params = [_PARAM_TEMP, _PARAM_WIND, _PARAM_PRECIP]

    # Fetch all (station, param) combinations concurrently
    keys = [(sid, pid) for sid in station_ids for pid in params]
    coros = [_fetch_latest_value(client, pid, sid) for sid, pid in keys]
    raw = dict(zip(keys, await asyncio.gather(*coros)))

    # Separate into per-parameter dicts {station_id: value}
    temp_r:   dict[int, float] = {}
    wind_r:   dict[int, float] = {}
    precip_r: dict[int, float] = {}
    valid_fors: list[datetime] = []

    for sid in station_ids:
        t = raw.get((sid, _PARAM_TEMP))
        w = raw.get((sid, _PARAM_WIND))
        p = raw.get((sid, _PARAM_PRECIP))
        if t:
            valid_fors.append(t[0])
            temp_r[sid] = t[1]
        if w:
            wind_r[sid] = w[1]
        if p:
            precip_r[sid] = p[1]

    # Require at least the primary city station
    if 71420 not in temp_r:
        return None

    return {
        "valid_for":   valid_fors[0],
        "temperature": _weighted_avg(temp_r,   _TEMP_WEIGHTS),
        "wind_speed":  _weighted_avg(wind_r,   _WIND_WEIGHTS),
        "precip_mm":   _weighted_avg(precip_r, _PRECIP_WEIGHTS),
        # Diagnostic: which stations contributed to each parameter
        "station_ids": {
            "temp":   sorted(temp_r.keys()),
            "wind":   sorted(wind_r.keys()),
            "precip": sorted(precip_r.keys()),
        },
    }
