from dataclasses import dataclass
from datetime import datetime

GOTHENBURG_LAT = 57.7089
GOTHENBURG_LON = 11.9746


@dataclass
class HourlyForecast:
    valid_for: datetime
    temperature: float
    precip_probability: float
    wind_speed: float = float("nan")
    cloud_cover: float = float("nan")
    wind_direction: float = float("nan")
    precip_mm: float = float("nan")
    fog_probability: float = float("nan")
