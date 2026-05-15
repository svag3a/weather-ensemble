from datetime import datetime, timezone
import httpx
from app.sources.base import GOTHENBURG_LAT, GOTHENBURG_LON, HourlyForecast

SOURCE_NAME = "open_meteo_ecmwf"
_URL = (
    "https://api.open-meteo.com/v1/forecast"
    f"?latitude={GOTHENBURG_LAT}&longitude={GOTHENBURG_LON}"
    "&hourly=temperature_2m,precipitation_probability,precipitation,windspeed_10m,wind_direction_10m,cloudcover"
    "&forecast_days=7&timeformat=iso8601&timezone=UTC&wind_speed_unit=ms"
    "&models=ecmwf_ifs025"
)


async def fetch(client: httpx.AsyncClient) -> list[HourlyForecast]:
    response = await client.get(_URL, timeout=10)
    response.raise_for_status()
    data = response.json()

    times      = data["hourly"]["time"]
    temps      = data["hourly"]["temperature_2m"]
    precips    = data["hourly"]["precipitation_probability"]
    precip_mms = data["hourly"]["precipitation"]
    winds      = data["hourly"]["windspeed_10m"]
    wind_dirs  = data["hourly"]["wind_direction_10m"]
    clouds     = data["hourly"]["cloudcover"]

    results: list[HourlyForecast] = []
    for t, temp, precip, pmm, wind, wdir, cloud in zip(
        times, temps, precips, precip_mms, winds, wind_dirs, clouds
    ):
        valid_for = datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
        results.append(HourlyForecast(
            valid_for=valid_for,
            temperature=float(temp) if temp is not None else float("nan"),
            precip_probability=float(precip) if precip is not None else 0.0,
            precip_mm=float(pmm) if pmm is not None else float("nan"),
            wind_speed=float(wind) if wind is not None else float("nan"),
            wind_direction=float(wdir) if wdir is not None else float("nan"),
            cloud_cover=float(cloud) if cloud is not None else float("nan"),
        ))

    return results
