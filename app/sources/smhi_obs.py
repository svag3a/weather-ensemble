"""
SMHI station observations for Göteborg A (station 71420).
Fetches temperature, wind speed, and precipitation for the latest hour.
Used as truth source for weight calibration in place of model consensus.
"""
from __future__ import annotations

import asyncio
import httpx
from datetime import datetime, timezone
from typing import Optional

STATION_ID = 71420  # Göteborg A

_BASE = "https://opendata-download-metobs.smhi.se/api/version/latest"

_PARAMS = {
    "temperature": 1,
    "wind_speed": 4,
    "precip_mm": 7,
}


async def _fetch_latest_value(
    client: httpx.AsyncClient, param_id: int
) -> Optional[tuple[datetime, float]]:
    url = f"{_BASE}/parameter/{param_id}/station/{STATION_ID}/period/latest-hour/data.json"
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


async def fetch(client: httpx.AsyncClient) -> Optional[dict]:
    """
    Returns {"valid_for": datetime, "temperature": float,
             "wind_speed": float|None, "precip_mm": float|None}
    or None if temperature observation is unavailable.
    """
    temp_res, wind_res, precip_res = await asyncio.gather(
        _fetch_latest_value(client, _PARAMS["temperature"]),
        _fetch_latest_value(client, _PARAMS["wind_speed"]),
        _fetch_latest_value(client, _PARAMS["precip_mm"]),
    )
    if temp_res is None:
        return None
    valid_for, temperature = temp_res
    return {
        "valid_for": valid_for,
        "temperature": temperature,
        "wind_speed": wind_res[1] if wind_res else None,
        "precip_mm": precip_res[1] if precip_res else None,
    }
