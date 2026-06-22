from dataclasses import dataclass
from datetime import datetime

from app.city_config import CITY

GOTHENBURG_LAT = CITY.lat
GOTHENBURG_LON = CITY.lon


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
    pressure: float = float("nan")
