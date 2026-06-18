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


def _estimate_motion(
    f_new: np.ndarray, f_old: np.ndarray,
    center_row: int, center_col: int,
    window: int = 100,
) -> tuple[float, float]:
    """
    Estimate motion vector (dy, dx) pixels/5-min via FFT phase correlation
    on a window around the user's location.
    Positive dy = southward, positive dx = eastward.
    """
    h, w = f_new.shape
    r0, r1 = max(0, center_row - window), min(h, center_row + window)
    c0, c1 = max(0, center_col - window), min(w, center_col + window)
    w1 = f_new[r0:r1, c0:c1]
    w2 = f_old[r0:r1, c0:c1]
    if w1.sum() < 10 or w2.sum() < 10:
        return 0.0, 0.0
    # Hann window to reduce edge ringing
    hann_r = np.hanning(w1.shape[0])[:, None]
    hann_c = np.hanning(w1.shape[1])[None, :]
    w1 = w1 * hann_r * hann_c
    w2 = w2 * hann_r * hann_c
    f1 = np.fft.fft2(w1)
    f2 = np.fft.fft2(w2)
    cross = f1 * np.conj(f2)
    denom = np.abs(cross)
    denom[denom < 1e-10] = 1e-10
    r = np.fft.ifft2(cross / denom).real
    peak = np.unravel_index(r.argmax(), r.shape)
    dy, dx = float(peak[0]), float(peak[1])
    ph, pw = r.shape
    if dy > ph / 2: dy -= ph
    if dx > pw / 2: dx -= pw
    # Clamp to physically reasonable storm speeds (~150 km/h max ≈ 75 px/step at 2 km/px)
    dy = max(-75.0, min(75.0, dy))
    dx = max(-75.0, min(75.0, dx))
    return dy, dx


def _bilinear_sample(field: np.ndarray, r: float, c: float) -> Optional[float]:
    h, w = field.shape
    r0, c0 = int(np.floor(r)), int(np.floor(c))
    r1, c1 = r0 + 1, c0 + 1
    if not (0 <= r0 < h and 0 <= c0 < w and r1 < h and c1 < w):
        return None
    dr, dc = r - r0, c - c0
    val = (
        field[r0, c0] * (1 - dr) * (1 - dc) +
        field[r0, c1] * (1 - dr) * dc +
        field[r1, c0] * dr * (1 - dc) +
        field[r1, c1] * dr * dc
    )
    return None if np.isnan(val) else round(float(val), 1)


async def nowcast_timeline(
    client: httpx.AsyncClient,
    lat: float,
    lon: float,
    steps: int = 7,
) -> list[dict]:
    """
    Returns 7 dicts (t=0, +5, +10 … +30 min), each:
      {offset_min, dbz, raining}
    Uses Lagrangian persistence: motion vector from FFT phase correlation
    applied to the most recent radar frame.
    """
    now = datetime.now(timezone.utc)
    urls = [_image_url(now - timedelta(minutes=5 * i)) for i in range(_N_IMAGES)]
    raw = await asyncio.gather(*[_fetch_tif(client, u) for u in urls])
    results = [r for r in raw if r is not None]
    if not results:
        return []

    _, transform, crs = results[0]
    row, col = _latlon_to_pixel(lat, lon, transform, crs)

    # Build dbZ fields (NaN where no data or below clutter threshold)
    def to_dbz(frame: np.ndarray) -> np.ndarray:
        out = frame.astype(float) * 0.4 - 30.0
        out[frame == 0] = np.nan
        out[frame == 255] = np.nan
        out[out < _DBZ_MIN] = np.nan
        return out

    dbz_frames = [to_dbz(r[0]) for r in results]

    # Estimate motion from up to 3 consecutive frame pairs, take median
    motion_dy, motion_dx = [], []
    for i in range(min(3, len(dbz_frames) - 1)):
        fn = np.nan_to_num(dbz_frames[i])
        fo = np.nan_to_num(dbz_frames[i + 1])
        dy, dx = _estimate_motion(fn, fo, row, col)
        motion_dy.append(dy)
        motion_dx.append(dx)

    dy = float(np.median(motion_dy)) if motion_dy else 0.0
    dx = float(np.median(motion_dx)) if motion_dx else 0.0

    # Current (newest) dbZ field for sampling
    field = dbz_frames[0]

    timeline = []
    for step in range(steps):
        proj_r = row - step * dy
        proj_c = col - step * dx
        dbz = _bilinear_sample(field, proj_r, proj_c)
        timeline.append({
            "offset_min": step * 5,
            "dbz": dbz,
            "raining": dbz is not None,
        })
    return timeline


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
