"""
Radar-based nowcasting for 1–6 hour precipitation probability.

Uses persistence only: if it is raining at the point right now (confirmed
in ≥2 of the last 3 images), forecast rain forward with decaying confidence.
NWP models handle approaching rain better than radar extrapolation.
"""
from __future__ import annotations

import io
import asyncio
import numpy as np
import httpx
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.sources.base import GOTHENBURG_LAT, GOTHENBURG_LON, HourlyForecast

SOURCE_NAME = "radar_nowcast"

_API_BASE = (
    "https://opendata-download-radar.smhi.se/api/version/latest/area/sweden/product/comp"
)

_N_IMAGES = 6

_CONFIDENCE = {1: 0.95, 2: 0.85, 3: 0.70, 4: 0.55, 5: 0.40, 6: 0.30}

# Raised from 5 → 15 dBZ to filter ground clutter (~0.3 mm/h threshold)
_DBZ_MIN = 15.0

# Require rain in at least this many of the last N_CONFIRM images to confirm rain
_N_CONFIRM = 3
_MIN_HITS   = 1


def _dbz_to_rain_rate(dbz: float) -> float:
    """Marshall-Palmer Z-R relation: Z = 200 * R^1.6"""
    if dbz < _DBZ_MIN:
        return 0.0
    z = 10 ** (dbz / 10)
    return (z / 200) ** (1 / 1.6)


def _rain_rate_to_prob(rate: float, confidence: float) -> float:
    if rate < 0.05:
        raw = 0.0
    elif rate < 0.2:
        raw = 20.0
    elif rate < 0.5:
        raw = 45.0
    elif rate < 1.5:
        raw = 70.0
    elif rate < 3.0:
        raw = 85.0
    else:
        raw = 95.0
    return raw * confidence + 50.0 * (1 - confidence)


def _pixel_to_dbz(val: int) -> Optional[float]:
    if val == 0 or val == 255:
        return None
    return val * 0.4 - 30.0


def _image_url(dt: datetime) -> str:
    minutes = (dt.minute // 5) * 5
    t = dt.replace(minute=minutes, second=0, microsecond=0)
    filename = f"radar_{t.strftime('%y%m%d%H%M')}.tif"
    return f"{_API_BASE}/{t.year}/{t.month:02d}/{t.day:02d}/{filename}"


async def _fetch_tif(client: httpx.AsyncClient, url: str):
    """Download radar TIF. Returns (ndarray, transform) or None."""
    try:
        resp = await client.get(url, timeout=15)
        resp.raise_for_status()
        import rasterio
        with rasterio.open(io.BytesIO(resp.content)) as ds:
            return ds.read(1), ds.transform, ds.crs
    except Exception:
        return None


def _latlon_to_pixel(lat: float, lon: float, transform, crs) -> tuple[int, int]:
    """Convert WGS84 lat/lon to (row, col) pixel coordinates."""
    from pyproj import Transformer
    import rasterio.transform as rt
    t = Transformer.from_crs("EPSG:4326", str(crs), always_xy=True)
    x, y = t.transform(lon, lat)
    col, row = ~transform * (x, y)
    return int(row), int(col)


def _pixel_raining(images_data: list[np.ndarray], row: int, col: int) -> tuple[bool, Optional[float]]:
    """
    Returns (raining, mean_dbz) using temporal filtering:
    rain is confirmed only if ≥ _MIN_HITS of the last _N_CONFIRM images show
    dBZ ≥ _DBZ_MIN at the given pixel.
    """
    recent = images_data[-_N_CONFIRM:]
    hits = 0
    dbz_sum = 0.0
    for img in recent:
        if 0 <= row < img.shape[0] and 0 <= col < img.shape[1]:
            dbz = _pixel_to_dbz(int(img[row, col]))
            if dbz is not None and dbz >= _DBZ_MIN:
                hits += 1
                dbz_sum += dbz
    if hits >= _MIN_HITS:
        return True, dbz_sum / hits
    return False, None


async def fetch_cape(client: httpx.AsyncClient, lat: float, lon: float) -> Optional[float]:
    """Fetch current hour CAPE (J/kg) from Open-Meteo."""
    try:
        url = (
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            f"&hourly=cape&forecast_days=1&timezone=UTC"
        )
        resp = await client.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        now_hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00")
        times = data["hourly"]["time"]
        capes = data["hourly"]["cape"]
        idx = next((i for i, t in enumerate(times) if t == now_hour), None)
        return float(capes[idx]) if idx is not None and capes[idx] is not None else None
    except Exception:
        return None


async def check_rain_at(client: httpx.AsyncClient, lat: float, lon: float) -> dict:
    """
    Check current radar rain status at an arbitrary lat/lon.
    Returns {raining: bool, dbz: float|None, confirmed_in: int, checked: int}
    """
    now = datetime.now(timezone.utc)
    urls = [_image_url(now - timedelta(minutes=5 * i)) for i in range(_N_CONFIRM)]
    raw = await asyncio.gather(*[_fetch_tif(client, u) for u in urls])
    results = [r for r in raw if r is not None]

    if not results:
        return {"raining": False, "dbz": None, "confirmed_in": 0, "checked": 0}

    _, transform, crs = results[0]
    images_data = [r[0] for r in results]
    row, col = _latlon_to_pixel(lat, lon, transform, crs)

    raining, mean_dbz = _pixel_raining(images_data, row, col)
    hits = sum(
        1 for img in images_data
        if 0 <= row < img.shape[0] and 0 <= col < img.shape[1]
        and (lambda d: d is not None and d >= _DBZ_MIN)(_pixel_to_dbz(int(img[row, col])))
    )
    return {
        "raining": raining,
        "dbz": round(mean_dbz, 1) if mean_dbz is not None else None,
        "confirmed_in": hits,
        "checked": len(images_data),
    }


async def fetch(client: httpx.AsyncClient) -> list[HourlyForecast]:
    now = datetime.now(timezone.utc)

    timestamps = [now - timedelta(minutes=5 * i) for i in range(_N_IMAGES)]
    urls = [_image_url(t) for t in timestamps]

    raw_images = await asyncio.gather(*[_fetch_tif(client, u) for u in urls])
    results = [r for r in raw_images if r is not None]

    if not results:
        return []

    _, transform, crs = results[0]
    images_data = [r[0] for r in results]
    row, col = _latlon_to_pixel(GOTHENBURG_LAT, GOTHENBURG_LON, transform, crs)

    raining_now, current_dbz = _pixel_raining(images_data, row, col)

    forecasts: list[HourlyForecast] = []
    for hour in range(1, 7):
        valid_for = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=hour)
        confidence = _CONFIDENCE.get(hour, 0.25)

        if not raining_now:
            prob = 0.0
        else:
            rate = _dbz_to_rain_rate(current_dbz)
            prob = _rain_rate_to_prob(rate, confidence)

        forecasts.append(HourlyForecast(
            valid_for=valid_for,
            temperature=float("nan"),
            precip_probability=round(prob, 1),
            wind_speed=float("nan"),
            cloud_cover=float("nan"),
        ))

    return forecasts
