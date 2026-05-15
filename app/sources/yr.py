from datetime import datetime
import httpx
from app.sources.base import GOTHENBURG_LAT, GOTHENBURG_LON, HourlyForecast

SOURCE_NAME = "yr"
_URL = (
    f"https://api.met.no/weatherapi/locationforecast/2.0/compact"
    f"?lat={GOTHENBURG_LAT}&lon={GOTHENBURG_LON}"
)
_HEADERS = {"User-Agent": "weather-ensemble/0.1 github.com/your-repo"}


async def fetch(client: httpx.AsyncClient) -> list[HourlyForecast]:
    response = await client.get(_URL, headers=_HEADERS, timeout=10)
    response.raise_for_status()
    data = response.json()

    results: list[HourlyForecast] = []
    for ts in data["properties"]["timeseries"]:
        valid_for = datetime.fromisoformat(ts["time"].replace("Z", "+00:00"))
        instant = ts["data"]["instant"]["details"]
        temp = float(instant.get("air_temperature", float("nan")))
        wind = float(instant.get("wind_speed", float("nan")))
        wind_dir = float(instant.get("wind_from_direction", float("nan")))
        cloud = float(instant.get("cloud_area_fraction", float("nan")))

        next_block = (
            ts["data"].get("next_1_hours")
            or ts["data"].get("next_6_hours")
            or ts["data"].get("next_12_hours")
            or {}
        )
        details = next_block.get("details", {})
        precip_mm_val = float(details.get("precipitation_amount", 0.0))
        if "probability_of_precipitation" in details:
            precip = float(details["probability_of_precipitation"])
        else:
            import math
            precip = round(100 * (1 - math.exp(-precip_mm_val)), 1)

        results.append(HourlyForecast(
            valid_for=valid_for, temperature=temp, precip_probability=precip,
            wind_speed=wind, cloud_cover=cloud,
            wind_direction=wind_dir, precip_mm=precip_mm_val,
        ))

    return results
