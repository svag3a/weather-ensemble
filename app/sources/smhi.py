from datetime import datetime
import httpx
from app.sources.base import GOTHENBURG_LAT, GOTHENBURG_LON, HourlyForecast

SOURCE_NAME = "smhi"
# pmp3g v2 was retired 2026-03-31, replaced by snow1g v1
_URL = (
    "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1"
    f"/geotype/point/lon/{GOTHENBURG_LON}/lat/{GOTHENBURG_LAT}/data.json"
)

_SENTINEL = 9999


def _val(data: dict, key: str, fallback=float("nan")):
    v = data.get(key, fallback)
    return fallback if v == _SENTINEL else v


async def fetch(client: httpx.AsyncClient) -> list[HourlyForecast]:
    response = await client.get(_URL, timeout=10)
    response.raise_for_status()
    data = response.json()

    results: list[HourlyForecast] = []
    for ts in data["timeSeries"]:
        valid_for = datetime.fromisoformat(ts["time"].replace("Z", "+00:00"))
        d = ts["data"]
        temp = _val(d, "air_temperature")
        precip = float(_val(d, "probability_of_precipitation", 0.0))
        wind = _val(d, "wind_speed")
        wind_dir = _val(d, "wind_from_direction")
        cloud = _val(d, "cloud_area_fraction")
        precip_mm = _val(d, "precipitation_amount_mean")
        # Fog detection: explicit symbol_code=7 OR visibility < 1 km (met. definition)
        wsymb = int(_val(d, "symbol_code", 0))
        vis   = _val(d, "visibility_in_air", float("nan"))
        import math
        fog_symbol = 1.0 if wsymb == 7 else 0.0
        fog_vis    = (1.0 if (not math.isnan(vis) and vis < 1.0) else
                      0.6 if (not math.isnan(vis) and vis < 5.0) else 0.0)
        fog = max(fog_symbol, fog_vis)

        results.append(HourlyForecast(
            valid_for=valid_for, temperature=temp, precip_probability=precip,
            wind_speed=wind, cloud_cover=cloud,
            wind_direction=wind_dir, precip_mm=precip_mm,
            fog_probability=fog,
        ))

    return results
