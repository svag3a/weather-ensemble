import os
from datetime import datetime, timezone
import httpx
from app.sources.base import GOTHENBURG_LAT, GOTHENBURG_LON, HourlyForecast

SOURCE_NAME = "openweathermap"
_BASE_URL = "https://api.openweathermap.org/data/2.5/forecast"


def _api_key() -> str:
    key = os.getenv("OPENWEATHERMAP_API_KEY", "")
    if not key:
        raise ValueError("OPENWEATHERMAP_API_KEY is not set")
    return key


async def fetch(client: httpx.AsyncClient) -> list[HourlyForecast]:
    params = {
        "lat": GOTHENBURG_LAT,
        "lon": GOTHENBURG_LON,
        "appid": _api_key(),
        "units": "metric",
        "cnt": 40,  # 5 days × 8 (3h intervals)
    }
    response = await client.get(_BASE_URL, params=params, timeout=10)
    response.raise_for_status()
    data = response.json()

    results: list[HourlyForecast] = []
    for item in data["list"]:
        valid_for = datetime.fromtimestamp(item["dt"], tz=timezone.utc)
        temp = float(item["main"]["temp"])
        precip = float(item.get("pop", 0.0)) * 100.0
        wind_data = item.get("wind", {})
        wind = float(wind_data.get("speed", float("nan")))
        wind_dir = float(wind_data.get("deg", float("nan")))
        cloud = float(item.get("clouds", {}).get("all", float("nan")))
        # OWM gives 3h accumulation — divide by 3 for mm/h equivalent
        precip_mm = float(item.get("rain", {}).get("3h", 0.0)) / 3.0
        results.append(HourlyForecast(
            valid_for=valid_for, temperature=temp, precip_probability=precip,
            wind_speed=wind, wind_direction=wind_dir,
            cloud_cover=cloud, precip_mm=precip_mm,
        ))

    return results
