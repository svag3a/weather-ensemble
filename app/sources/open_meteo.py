from datetime import datetime, timezone
import httpx
from app.sources.base import GOTHENBURG_LAT, GOTHENBURG_LON, HourlyForecast

SOURCE_NAME = "open_meteo"
_URL = (
    "https://api.open-meteo.com/v1/forecast"
    f"?latitude={GOTHENBURG_LAT}&longitude={GOTHENBURG_LON}"
    "&hourly=temperature_2m,precipitation_probability,precipitation,windspeed_10m,wind_direction_10m,cloudcover,dew_point_2m"
    "&forecast_days=7&timeformat=iso8601&timezone=UTC&wind_speed_unit=ms"
)


async def fetch(client: httpx.AsyncClient) -> list[HourlyForecast]:
    response = await client.get(_URL, timeout=10)
    response.raise_for_status()
    data = response.json()

    times     = data["hourly"]["time"]
    temps     = data["hourly"]["temperature_2m"]
    precips   = data["hourly"]["precipitation_probability"]
    precip_mms = data["hourly"]["precipitation"]
    winds     = data["hourly"]["windspeed_10m"]
    wind_dirs = data["hourly"]["wind_direction_10m"]
    clouds    = data["hourly"]["cloudcover"]
    dew_points = data["hourly"]["dew_point_2m"]

    results: list[HourlyForecast] = []
    for t, temp, precip, pmm, wind, wdir, cloud, dew in zip(
        times, temps, precips, precip_mms, winds, wind_dirs, clouds, dew_points
    ):
        valid_for = datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
        temp_f = float(temp) if temp is not None else float("nan")
        dew_f = float(dew) if dew is not None else float("nan")
        cloud_f = float(cloud) if cloud is not None else float("nan")
        wind_f = float(wind) if wind is not None else float("nan")
        fog = 1.0 if (temp_f - dew_f < 1.0 and cloud_f > 95.0 and wind_f < 2.0) else 0.0
        results.append(HourlyForecast(
            valid_for=valid_for,
            temperature=temp_f,
            precip_probability=float(precip) if precip is not None else 0.0,
            precip_mm=float(pmm) if pmm is not None else float("nan"),
            wind_speed=wind_f,
            wind_direction=float(wdir) if wdir is not None else float("nan"),
            cloud_cover=cloud_f,
            fog_probability=fog,
        ))

    return results
