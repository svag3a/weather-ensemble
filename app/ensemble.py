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

ALPHA = 0.1  # EMA smoothing factor for MAE updates (default/stable)


def _dynamic_alpha(weight_row) -> float:
    """Boost learning rate when source shows significant bias drift."""
    bias = abs(weight_row.bias_temperature or 0.0)
    if bias > 2.0:  return 0.25   # strong drift — adapt quickly
    if bias > 1.0:  return 0.15   # moderate drift
    return ALPHA                   # stable — use default
LEAD_BUCKETS = [1, 3, 6, 12, 24, 48, 72]

# Short-range precip tier: high-res regional models outperform coarse globals
# at 1–6 h. Applied as a multiplier before independence scaling.
# Values based on known NWP resolution/mesoscale skill.
# Buckets 12+ h: no prior — let observed MAE speak.
PRECIP_LEAD_BOOST: dict[int, dict[str, float]] = {
    1: {
        'smhi': 1.30, 'yr': 1.30, 'open_meteo_icon_eu': 1.20,
        'open_meteo': 0.70, 'open_meteo_ecmwf': 0.85,
        'open_meteo_ukmo': 0.85, 'open_meteo_knmi': 0.85,
        'openweathermap': 0.70,
    },
    3: {
        'smhi': 1.30, 'yr': 1.30, 'open_meteo_icon_eu': 1.20,
        'open_meteo': 0.70, 'open_meteo_ecmwf': 0.85,
        'open_meteo_ukmo': 0.85, 'open_meteo_knmi': 0.85,
        'openweathermap': 0.70,
    },
    6: {
        'smhi': 1.15, 'yr': 1.15, 'open_meteo_icon_eu': 1.10,
        'open_meteo': 0.85, 'open_meteo_ecmwf': 0.90,
        'open_meteo_ukmo': 0.90, 'open_meteo_knmi': 0.90,
        'openweathermap': 0.85,
    },
}

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
    "open_meteo_ukmo":    "open_meteo_ukmo",    # UKMO: independent model, own group
    "open_meteo_knmi":    "open_meteo_knmi",    # KNMI: independent model, own group
    "radar_nowcast":      "radar_nowcast",
    "ensemble":           "ensemble",
}


def _weighted_std(pairs: list[tuple[float, float]]) -> Optional[float]:
    """Weighted standard deviation of (value, weight) pairs. Returns None if < 2 sources."""
    if len(pairs) < 2:
        return None
    total_w = sum(w for _, w in pairs)
    if total_w == 0:
        return None
    mean = sum(v * w for v, w in pairs) / total_w
    variance = sum(w * (v - mean) ** 2 for v, w in pairs) / total_w
    return math.sqrt(variance)


def _compute_confidence(temps: list, precips: list) -> float:
    """
    0.0–1.0 confidence based on model spread (weighted std dev).
    High agreement → high confidence.
      temp_std = 0°C  → 1.0,  temp_std ≥ 3°C → 0.0
      precip_std = 0% → 1.0,  precip_std ≥ 30% → 0.0
    """
    temp_std   = _weighted_std(temps)   or 0.0
    precip_std = _weighted_std(precips) or 0.0
    conf_temp   = max(0.0, 1.0 - temp_std   / 3.0)
    conf_precip = max(0.0, 1.0 - precip_std / 30.0)
    return round(0.6 * conf_temp + 0.4 * conf_precip, 3)


def _lead_bucket(lead_hours: int) -> int:
    """Snap a lead time to the nearest bucket for weight lookup."""
    return min(LEAD_BUCKETS, key=lambda b: abs(b - lead_hours))


def _get_truth(db: Session, valid_for: datetime) -> Optional[dict]:
    """
    Return truth values for valid_for from real SMHI observations only.
    Returns None when no observation is available — no model-consensus fallback.
    precip_outcome is 0.0 or 1.0 (binary) for use with Brier score.
    """
    from app.models import Observation
    # Observations are stored as naive UTC datetimes — strip timezone if present
    valid_for_naive = valid_for.replace(tzinfo=None) if valid_for.tzinfo else valid_for
    obs = db.query(Observation).filter(Observation.valid_for == valid_for_naive).first()
    if obs and obs.temperature is not None:
        precip_outcome = (
            1.0 if (obs.precip_mm is not None and obs.precip_mm > 0.1)
            else 0.0 if obs.precip_mm is not None
            else None
        )
        return {
            "temperature": obs.temperature,
            "precip_outcome": precip_outcome,   # 0.0 / 1.0 — use Brier score
            "wind_speed": obs.wind_speed,
            "cloud_cover": None,  # not available at this station
        }
    return None  # no consensus fallback — only real observations count


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
        # Flush pending rows first so the query below finds newly-created rows
        # (SessionLocal uses autoflush=False, so we must flush manually here)
        db.flush()
        weight_row = (
            db.query(SourceWeight)
            .filter(SourceWeight.source == fc.source, SourceWeight.lead_hours == bucket)
            .first()
        )
        if weight_row is None:
            weight_row = SourceWeight(
                source=fc.source,
                lead_hours=bucket,
                mae_temperature=2.0,   # typical first-guess temp error ≈ 2°C
                mae_precip=0.20,       # climatological Brier baseline for Göteborg
                mae_wind=3.0,          # typical first-guess wind error ≈ 3 m/s
                mae_cloud=20.0,        # typical first-guess cloud error ≈ 20%
                sample_count=0,
            )
            db.add(weight_row)

        alpha = _dynamic_alpha(weight_row)
        if fc.temperature is not None and not isnan(fc.temperature):
            err_t = abs(fc.temperature - consensus["temperature"])
            weight_row.mae_temperature = alpha * err_t + (1 - alpha) * weight_row.mae_temperature
            # Signed bias: positive = source runs too warm
            signed_t = fc.temperature - consensus["temperature"]
            weight_row.bias_temperature = alpha * signed_t + (1 - alpha) * (weight_row.bias_temperature or 0.0)
        # Brier score for precipitation: (p/100 - outcome)² where outcome ∈ {0, 1}
        # Precip uses fixed ALPHA since Brier scale differs from physical units
        if consensus.get("precip_outcome") is not None:
            brier = (fc.precip_probability / 100.0 - consensus["precip_outcome"]) ** 2
            weight_row.mae_precip = ALPHA * brier + (1 - ALPHA) * weight_row.mae_precip
        if fc.wind_speed is not None and not isnan(fc.wind_speed) and consensus["wind_speed"] is not None:
            err_w = abs(fc.wind_speed - consensus["wind_speed"])
            weight_row.mae_wind = alpha * err_w + (1 - alpha) * weight_row.mae_wind
            # Signed bias: positive = source runs too fast
            signed_w = fc.wind_speed - consensus["wind_speed"]
            weight_row.bias_wind = alpha * signed_w + (1 - alpha) * (weight_row.bias_wind or 0.0)
        if fc.cloud_cover is not None and not isnan(fc.cloud_cover) and consensus["cloud_cover"] is not None:
            err_c = abs(fc.cloud_cover - consensus["cloud_cover"])
            weight_row.mae_cloud = ALPHA * err_c + (1 - ALPHA) * weight_row.mae_cloud
        weight_row.sample_count += 1
        weight_row.updated_at = datetime.now(timezone.utc)

        # Auto-exclusion: only after enough samples and not manually overridden
        if not weight_row.manual_override and weight_row.sample_count >= 20:
            bias_t = abs(weight_row.bias_temperature or 0.0)
            excl_t = bool(getattr(weight_row, "excluded_temperature", False))
            if bias_t > 3.0 and not excl_t:
                weight_row.excluded_temperature = True
                weight_row.excluded_reason = f"Auto: temperaturbia {weight_row.bias_temperature:+.1f}°C > 3°C"
                weight_row.excluded_since = datetime.now(timezone.utc)
            elif bias_t < 1.5 and excl_t:
                # Bias has normalized — auto-reinstate temperature
                weight_row.excluded_temperature = False
                if not any([
                    getattr(weight_row, "excluded_wind", False),
                    getattr(weight_row, "excluded_precip", False),
                    getattr(weight_row, "excluded_cloud", False),
                ]):
                    weight_row.excluded_reason = None
                    weight_row.excluded_since = None

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

    # Epsilon values chosen per-parameter to keep weights numerically stable
    # and reflect the natural minimum achievable error for each variable.
    # Precip uses Brier scale (0–1); temp/wind/cloud use physical units.
    raw = {r.source: {
        "temp":   1.0 / (r.mae_temperature + 0.5),   # ±0.5 °C floor
        "precip": 1.0 / (r.mae_precip      + 0.05),  # Brier ≥ 0.05 floor
        "wind":   1.0 / (r.mae_wind        + 0.3),   # ±0.3 m/s floor
        "cloud":  1.0 / (r.mae_cloud       + 5.0),   # ±5 % floor
    } for r in rows}

    # Per-parameter exclusion flags (graceful fallback for pre-migration rows)
    excl = {r.source: {
        "temp":   bool(getattr(r, "excluded_temperature", False)),
        "wind":   bool(getattr(r, "excluded_wind", False)),
        "precip": bool(getattr(r, "excluded_precip", False)),
        "cloud":  bool(getattr(r, "excluded_cloud", False)),
    } for r in rows}

    w_temp  = _independence_scale({s: v["temp"]  for s, v in raw.items() if not excl[s]["temp"]})
    w_wind  = _independence_scale({s: v["wind"]  for s, v in raw.items() if not excl[s]["wind"]})
    w_cloud = _independence_scale({s: v["cloud"] for s, v in raw.items() if not excl[s]["cloud"]})

    # Precip: apply radar boost then short-range tier adjustment on NWP.
    radar_fraction = RADAR_PRECIP_WEIGHT.get(bucket, 0.0)
    tier = PRECIP_LEAD_BOOST.get(bucket, {})  # empty dict = no prior at 12h+
    nwp_precip = {
        s: v["precip"] * tier.get(s, 1.0)
        for s, v in raw.items() if s != "radar_nowcast" and not excl[s]["precip"]
    }
    nwp_scaled = _independence_scale(nwp_precip) if nwp_precip else {}
    w_precip: dict[str, float] = {}
    if "radar_nowcast" in raw and radar_fraction > 0:
        w_precip["radar_nowcast"] = radar_fraction
        for src, w in nwp_scaled.items():
            w_precip[src] = w * (1.0 - radar_fraction)
    else:
        w_precip = _independence_scale({
            s: v["precip"] * tier.get(s, 1.0) for s, v in raw.items()
            if not excl[s]["precip"]
        })

    # Also surface bias values so build_ensemble can apply bias correction
    bias_map = {r.source: r for r in rows}
    return {
        src: {
            "w_temp":   w_temp.get(src, 0.0),
            "w_precip": w_precip.get(src, 0.0),
            "w_wind":   w_wind.get(src, 0.0),
            "w_cloud":  w_cloud.get(src, 0.0),
            "bias_temp": getattr(bias_map.get(src), "bias_temperature", None) or 0.0,
            "bias_wind": getattr(bias_map.get(src), "bias_wind", None) or 0.0,
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

    # Gather excluded sources — use integer comparison for SQLite Boolean compatibility
    try:
        excluded_sources = {
            r.source for r in db.query(SourceWeight).filter(SourceWeight.excluded == 1).all()
        }
    except Exception:
        excluded_sources = set()  # safe fallback if column is missing/broken

    for valid_for in sorted(all_valid):
        lead_hours = max(1, round((valid_for - computed_at).total_seconds() / 3600))
        weights = _get_weights(db, lead_hours)

        temps, precips, winds, clouds, wind_dirs, precip_mms, fog_signals, pressures = [], [], [], [], [], [], [], []
        for source, fcs in forecasts_by_source.items():
            if source in excluded_sources:
                continue
            match = next((f for f in fcs if f.valid_for == valid_for), None)
            if match is None:
                continue
            w = weights.get(source, {"w_temp": 1.0, "w_precip": 1.0, "w_wind": 1.0, "w_cloud": 1.0,
                                      "bias_temp": 0.0, "bias_wind": 0.0})
            # Apply bias correction: subtract the source's systematic error
            if match.temperature is not None and not isnan(match.temperature):
                corrected_temp = match.temperature - w.get("bias_temp", 0.0)
                temps.append((corrected_temp, w["w_temp"]))
            if not isnan(match.precip_probability):
                precips.append((match.precip_probability, w["w_precip"]))
            if match.wind_speed is not None and not isnan(match.wind_speed):
                corrected_wind = max(0.0, match.wind_speed - w.get("bias_wind", 0.0))
                winds.append((corrected_wind, w["w_wind"]))
            if match.cloud_cover is not None and not isnan(match.cloud_cover):
                clouds.append((match.cloud_cover, w["w_cloud"]))
            if match.wind_direction is not None and not isnan(match.wind_direction):
                wind_dirs.append((match.wind_direction, w["w_wind"]))
            if match.precip_mm is not None and not isnan(match.precip_mm):
                precip_mms.append(match.precip_mm)
            if match.fog_probability is not None and not isnan(match.fog_probability):
                fog_signals.append(match.fog_probability)
            match_pressure = getattr(match, 'pressure', float('nan'))
            if match_pressure is not None and not isnan(match_pressure):
                pressures.append(match_pressure)

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
        ens_confidence = _compute_confidence(temps, precips)
        ens_fog = sum(fog_signals) / len(fog_signals) if fog_signals else 0.0
        ens_pressure = sum(pressures) / len(pressures) if pressures else None

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
            pr = round(ens_pressure, 1) if ens_pressure is not None else None
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
                confidence=ens_confidence,
                fog_probability=round(ens_fog, 3),
                pressure=pr,
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
