"""
Ensemble logic:
  - "Truth" for time T = average of all sources' T+1h forecast for T
  - After each collection run, compare each source's previous forecasts against
    the current consensus 1h value and update rolling MAE per (source, lead_hours)
  - Ensemble forecast = inverse-MAE weighted average across sources
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from math import isnan
from typing import Optional
from sqlalchemy.orm import Session
from app.models import Forecast, SourceWeight, EnsembleForecast

ALPHA = 0.1  # EMA smoothing factor for MAE updates
LEAD_BUCKETS = [1, 3, 6, 12, 24, 48, 72]

# Sources that share model infrastructure are grouped together.
# Each group receives equal total weight regardless of how many members it has,
# preventing correlated models from dominating the ensemble.
# Fraction of total precip weight reserved for radar at each lead-time bucket.
# Beyond 6h radar has no skill; below 6h it dominates.
RADAR_PRECIP_WEIGHT: dict[int, float] = {
    1:  0.90,
    3:  0.70,
    6:  0.50,
    12: 0.10,
    24: 0.0,
    48: 0.0,
    72: 0.0,
}

SOURCE_GROUPS: dict[str, str] = {
    "smhi":               "smhi",
    "yr":                 "yr",
    "openweathermap":     "openweathermap",
    "open_meteo":         "open_meteo_family",
    "open_meteo_icon_eu": "open_meteo_family",
    "open_meteo_ecmwf":   "open_meteo_family",
    "radar_nowcast":      "radar_nowcast",
    "ensemble":           "ensemble",
}


def _lead_bucket(lead_hours: int) -> int:
    """Snap a lead time to the nearest bucket for weight lookup."""
    return min(LEAD_BUCKETS, key=lambda b: abs(b - lead_hours))


def _get_truth(db: Session, valid_for: datetime) -> Optional[dict]:
    """
    Return truth values for valid_for.
    Prefers actual SMHI observations; falls back to 1h model consensus.
    """
    from app.models import Observation
    obs = db.query(Observation).filter(Observation.valid_for == valid_for).first()
    if obs and obs.temperature is not None:
        precip_truth = (
            100.0 if (obs.precip_mm is not None and obs.precip_mm > 0.1)
            else 0.0 if obs.precip_mm is not None
            else None
        )
        return {
            "temperature": obs.temperature,
            "precip_probability": precip_truth,
            "wind_speed": obs.wind_speed,
            "cloud_cover": None,  # not available at this station
        }
    return compute_consensus_1h(db, valid_for)


def compute_consensus_1h(db: Session, valid_for: datetime) -> Optional[dict[str, float]]:
    """Return {temperature, precip_probability} consensus from all sources' 1h forecasts."""
    rows = (
        db.query(Forecast)
        .filter(
            Forecast.valid_for == valid_for,
            Forecast.lead_hours == 1,
        )
        .all()
    )
    temps  = [r.temperature for r in rows if r.temperature is not None and not isnan(r.temperature)]
    precips = [r.precip_probability for r in rows]
    winds  = [r.wind_speed for r in rows if r.wind_speed is not None and not isnan(r.wind_speed)]
    clouds = [r.cloud_cover for r in rows if r.cloud_cover is not None and not isnan(r.cloud_cover)]
    if len(temps) < 2:
        return None
    return {
        "temperature": sum(temps) / len(temps),
        "precip_probability": sum(precips) / len(precips),
        "wind_speed": sum(winds) / len(winds) if winds else None,
        "cloud_cover": sum(clouds) / len(clouds) if clouds else None,
    }


def update_weights(db: Session, valid_for: datetime) -> None:
    """Update MAE weights for all sources based on current consensus 1h truth."""
    consensus = _get_truth(db, valid_for)
    if consensus is None:
        return

    all_forecasts = (
        db.query(Forecast)
        .filter(Forecast.valid_for == valid_for, Forecast.lead_hours != 1)
        .all()
    )

    for fc in all_forecasts:
        bucket = _lead_bucket(fc.lead_hours)
        weight_row = (
            db.query(SourceWeight)
            .filter(SourceWeight.source == fc.source, SourceWeight.lead_hours == bucket)
            .first()
        )
        if weight_row is None:
            weight_row = SourceWeight(
                source=fc.source,
                lead_hours=bucket,
                mae_temperature=1.0,
                mae_precip=1.0,
                mae_wind=1.0,
                mae_cloud=1.0,
                sample_count=0,
            )
            db.add(weight_row)

        if fc.temperature is not None and not isnan(fc.temperature):
            err_t = abs(fc.temperature - consensus["temperature"])
            weight_row.mae_temperature = ALPHA * err_t + (1 - ALPHA) * weight_row.mae_temperature
        if consensus["precip_probability"] is not None:
            err_p = abs(fc.precip_probability - consensus["precip_probability"])
            weight_row.mae_precip = ALPHA * err_p + (1 - ALPHA) * weight_row.mae_precip
        if fc.wind_speed is not None and not isnan(fc.wind_speed) and consensus["wind_speed"] is not None:
            err_w = abs(fc.wind_speed - consensus["wind_speed"])
            weight_row.mae_wind = ALPHA * err_w + (1 - ALPHA) * weight_row.mae_wind
        if fc.cloud_cover is not None and not isnan(fc.cloud_cover) and consensus["cloud_cover"] is not None:
            err_c = abs(fc.cloud_cover - consensus["cloud_cover"])
            weight_row.mae_cloud = ALPHA * err_c + (1 - ALPHA) * weight_row.mae_cloud
        weight_row.sample_count += 1
        weight_row.updated_at = datetime.now(timezone.utc)

    db.commit()


def _independence_scale(raw: dict[str, float]) -> dict[str, float]:
    """
    Give each source group equal total weight, then distribute within the group
    by individual inverse-MAE. Prevents a cluster of correlated models from
    dominating the ensemble.
    """
    # Bucket sources into groups
    groups: dict[str, list[tuple[str, float]]] = {}
    for src, w in raw.items():
        group = SOURCE_GROUPS.get(src, src)
        groups.setdefault(group, []).append((src, w))

    n_groups = len(groups)
    scaled: dict[str, float] = {}
    for members in groups.values():
        group_sum = sum(w for _, w in members)
        group_share = 1.0 / n_groups
        for src, w in members:
            scaled[src] = (w / group_sum * group_share) if group_sum > 0 else group_share / len(members)
    return scaled


def _get_weights(db: Session, lead_hours: int) -> dict[str, dict]:
    """Return {source: {w_temp, w_precip, w_wind, w_cloud}} independence-scaled inverse-MAE weights."""
    bucket = _lead_bucket(lead_hours)
    rows = db.query(SourceWeight).filter(SourceWeight.lead_hours == bucket).all()

    if not rows:
        return {}

    raw = {r.source: {
        "temp":  1.0 / max(r.mae_temperature, 0.01),
        "precip": 1.0 / max(r.mae_precip, 0.01),
        "wind":  1.0 / max(r.mae_wind, 0.01),
        "cloud": 1.0 / max(r.mae_cloud, 0.01),
    } for r in rows}

    w_temp  = _independence_scale({s: v["temp"]  for s, v in raw.items()})
    w_wind  = _independence_scale({s: v["wind"]  for s, v in raw.items()})
    w_cloud = _independence_scale({s: v["cloud"] for s, v in raw.items()})

    # Precip: apply radar boost — radar gets a fixed fraction by lead time,
    # NWP sources share the remainder proportionally.
    radar_fraction = RADAR_PRECIP_WEIGHT.get(bucket, 0.0)
    nwp_precip = {s: v["precip"] for s, v in raw.items() if s != "radar_nowcast"}
    nwp_scaled = _independence_scale(nwp_precip) if nwp_precip else {}
    w_precip: dict[str, float] = {}
    if "radar_nowcast" in raw and radar_fraction > 0:
        w_precip["radar_nowcast"] = radar_fraction
        for src, w in nwp_scaled.items():
            w_precip[src] = w * (1.0 - radar_fraction)
    else:
        w_precip = _independence_scale({s: v["precip"] for s, v in raw.items()})

    return {
        src: {
            "w_temp":   w_temp.get(src, 0.0),
            "w_precip": w_precip.get(src, 0.0),
            "w_wind":   w_wind.get(src, 0.0),
            "w_cloud":  w_cloud.get(src, 0.0),
        }
        for src in raw
    }


def build_ensemble(db: Session, computed_at: datetime, forecasts_by_source: dict[str, list]) -> None:
    """
    forecasts_by_source: {source_name: [HourlyForecast, ...]}
    Compute and persist ensemble forecasts for each valid_for time.
    """
    from app.sources.base import HourlyForecast

    # Collect all valid_for times
    all_valid: set[datetime] = set()
    for fcs in forecasts_by_source.values():
        for fc in fcs:
            all_valid.add(fc.valid_for)

    for valid_for in sorted(all_valid):
        lead_hours = max(1, round((valid_for - computed_at).total_seconds() / 3600))
        weights = _get_weights(db, lead_hours)

        temps, precips, winds, clouds, wind_dirs, precip_mms = [], [], [], [], [], []
        for source, fcs in forecasts_by_source.items():
            match = next((f for f in fcs if f.valid_for == valid_for), None)
            if match is None:
                continue
            w = weights.get(source, {"w_temp": 1.0, "w_precip": 1.0, "w_wind": 1.0, "w_cloud": 1.0})
            if match.temperature is not None and not isnan(match.temperature):
                temps.append((match.temperature, w["w_temp"]))
            if not isnan(match.precip_probability):
                precips.append((match.precip_probability, w["w_precip"]))
            if match.wind_speed is not None and not isnan(match.wind_speed):
                winds.append((match.wind_speed, w["w_wind"]))
            if match.cloud_cover is not None and not isnan(match.cloud_cover):
                clouds.append((match.cloud_cover, w["w_cloud"]))
            if match.wind_direction is not None and not isnan(match.wind_direction):
                wind_dirs.append((match.wind_direction, w["w_wind"]))
            if match.precip_mm is not None and not isnan(match.precip_mm):
                precip_mms.append(match.precip_mm)

        if not precips:
            continue

        def wavg(pairs):
            if not pairs: return None
            total = sum(w for _, w in pairs)
            return sum(v * w for v, w in pairs) / total

        def eavg(pairs):
            return sum(v for v, _ in pairs) / len(pairs) if pairs else None

        def circular_wavg(angle_weight_pairs):
            if not angle_weight_pairs: return None
            total = sum(w for _, w in angle_weight_pairs)
            sx = sum(math.cos(math.radians(a)) * w for a, w in angle_weight_pairs)
            sy = sum(math.sin(math.radians(a)) * w for a, w in angle_weight_pairs)
            return (math.degrees(math.atan2(sy / total, sx / total)) + 360) % 360

        if weights:
            ens_temp   = wavg(temps)
            ens_precip = wavg(precips)
            ens_wind   = wavg(winds)
            ens_cloud  = wavg(clouds)
        else:
            ens_temp   = eavg(temps)
            ens_precip = eavg(precips)
            ens_wind   = eavg(winds)
            ens_cloud  = eavg(clouds)

        ens_wind_dir = circular_wavg(wind_dirs)
        ens_precip_mm = sum(precip_mms) / len(precip_mms) if precip_mms else None

        # Physical consistency: precipitation requires cloud cover
        if ens_precip is not None and ens_cloud is not None:
            ens_precip = min(ens_precip, ens_cloud)

        existing = (
            db.query(EnsembleForecast)
            .filter(EnsembleForecast.computed_at == computed_at,
                    EnsembleForecast.valid_for == valid_for)
            .first()
        )
        if existing is None:
            t = round(ens_temp, 2) if ens_temp is not None else None
            p = round(ens_precip, 1) if ens_precip is not None else None
            w = round(ens_wind, 2) if ens_wind is not None else None
            c = round(ens_cloud, 1) if ens_cloud is not None else None
            wd = round(ens_wind_dir, 1) if ens_wind_dir is not None else None
            pm = round(ens_precip_mm, 2) if ens_precip_mm is not None else None
            db.add(EnsembleForecast(
                computed_at=computed_at,
                valid_for=valid_for,
                lead_hours=lead_hours,
                temperature=t,
                precip_probability=p,
                wind_speed=w,
                cloud_cover=c,
                wind_direction=wd,
                precip_mm=pm,
            ))
            # Also track ensemble as a source so its MAE is measured in the ranking
            ens_fc_exists = (
                db.query(Forecast)
                .filter(Forecast.source == "ensemble",
                        Forecast.issued_at == computed_at,
                        Forecast.valid_for == valid_for)
                .first()
            )
            if ens_fc_exists is None and t is not None:
                db.add(Forecast(
                    source="ensemble",
                    issued_at=computed_at,
                    valid_for=valid_for,
                    lead_hours=lead_hours,
                    temperature=t,
                    precip_probability=p if p is not None else 0.0,
                    wind_speed=w,
                    cloud_cover=c,
                ))

    db.commit()
