"""
City configuration — single source of truth for all city-specific constants.

To add a new city: create a new CityConfig instance and add it to CITIES.
To switch active city: set the CITY_ID environment variable (default: "goteborg").
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class SmhiStation:
    id: int
    name: str
    lat: float
    lon: float


@dataclass
class CityConfig:
    id: str                          # machine key, e.g. "goteborg"
    name: str                        # display name, e.g. "Göteborg"
    lat: float                       # city centre latitude
    lon: float                       # city centre longitude
    bbox: tuple[float, float, float, float]  # (lat_min, lon_min, lat_max, lon_max)
    timezone: str                    # IANA tz, e.g. "Europe/Stockholm"
    language: str                    # BCP-47, e.g. "sv"
    domain: str                      # primary domain, e.g. "gbgsol.se"
    smhi_county_id: int              # SMHI county ID for weather warnings
    metar_code: str                  # ICAO METAR station code
    smhi_stations: list[SmhiStation] = field(default_factory=list)
    # Composite weights per SMHI station ID — missing stations re-normalised automatically
    smhi_temp_weights: dict[int, float]   = field(default_factory=dict)
    smhi_wind_weights: dict[int, float]   = field(default_factory=dict)
    smhi_precip_weights: dict[int, float] = field(default_factory=dict)


CITIES: dict[str, CityConfig] = {
    "goteborg": CityConfig(
        id            = "goteborg",
        name          = "Göteborg",
        lat           = 57.7089,
        lon           = 11.9746,
        bbox          = (57.60, 11.70, 57.85, 12.10),
        timezone      = "Europe/Stockholm",
        language      = "sv",
        domain        = "gbgsol.se",
        smhi_county_id = 14,  # Västra Götalands län
        metar_code    = "ESGG",  # Göteborg-Landvetter
        smhi_stations = [
            SmhiStation(id=71420, name="Göteborg A", lat=57.7156, lon=11.9924),
            SmhiStation(id=71380, name="Vinga A",    lat=57.6322, lon=11.6048),
            SmhiStation(id=72420, name="Landvetter", lat=57.6764, lon=12.2919),
        ],
        # Temperature: city-centre dominant, airport supplement, coastal excluded (maritime bias)
        smhi_temp_weights   = {71420: 0.80, 72420: 0.20, 71380: 0.00},
        # Wind: city-centre + coastal (captures sea winds) + airport
        smhi_wind_weights   = {71420: 0.50, 71380: 0.30, 72420: 0.20},
        # Precipitation: weighted average across all three stations
        smhi_precip_weights = {71420: 0.60, 71380: 0.25, 72420: 0.15},
    ),
}

# Active city — override with CITY_ID env var
CITY: CityConfig = CITIES[os.environ.get("CITY_ID", "goteborg")]
