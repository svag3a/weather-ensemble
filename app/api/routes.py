from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Body
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import EnsembleForecast, Forecast, SourceWeight, SourceWeightHistory, Observation, AiSummary, CityImage

router = APIRouter()


class ForecastOut(BaseModel):
    valid_for: datetime
    lead_hours: int
    temperature: float
    precip_probability: float
    wind_speed: Optional[float] = None
    wind_direction: Optional[float] = None
    cloud_cover: Optional[float] = None
    precip_mm: Optional[float] = None
    confidence: Optional[float] = None


class SourceWeightOut(BaseModel):
    source: str
    lead_hours: int
    mae_temperature: float
    mae_precip: float
    mae_wind: float
    mae_cloud: float
    sample_count: int
    updated_at: datetime


@router.get("/forecast", response_model=list[ForecastOut])
def get_ensemble_forecast(
    hours_ahead: int = Query(default=48, ge=1, le=168),
    db: Session = Depends(get_db),
):
    """Latest ensemble forecast for the next N hours."""
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=hours_ahead)

    latest_run = (
        db.query(EnsembleForecast.computed_at)
        .order_by(EnsembleForecast.computed_at.desc())
        .first()
    )
    if latest_run is None:
        raise HTTPException(status_code=404, detail="No ensemble forecast available yet")

    rows = (
        db.query(EnsembleForecast)
        .filter(
            EnsembleForecast.computed_at == latest_run[0],
            EnsembleForecast.valid_for >= now,
            EnsembleForecast.valid_for <= cutoff,
        )
        .order_by(EnsembleForecast.valid_for)
        .all()
    )
    return [
        ForecastOut(
            valid_for=r.valid_for,
            lead_hours=r.lead_hours,
            temperature=r.temperature,
            precip_probability=r.precip_probability,
            wind_speed=r.wind_speed,
            wind_direction=r.wind_direction,
            cloud_cover=r.cloud_cover,
            precip_mm=r.precip_mm,
            confidence=r.confidence,
        )
        for r in rows
    ]


@router.get("/forecast/sources", response_model=dict[str, list[ForecastOut]])
def get_source_forecasts(
    hours_ahead: int = Query(default=24, ge=1, le=168),
    db: Session = Depends(get_db),
):
    """Latest individual source forecasts for comparison."""
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=hours_ahead)

    # Find the most recent issued_at per source
    from sqlalchemy import func
    latest_per_source = (
        db.query(Forecast.source, func.max(Forecast.issued_at).label("latest"))
        .group_by(Forecast.source)
        .all()
    )

    result: dict[str, list[ForecastOut]] = {}
    for source, latest_issued in latest_per_source:
        rows = (
            db.query(Forecast)
            .filter(
                Forecast.source == source,
                Forecast.issued_at == latest_issued,
                Forecast.valid_for >= now,
                Forecast.valid_for <= cutoff,
            )
            .order_by(Forecast.valid_for)
            .all()
        )
        result[source] = [
            ForecastOut(
                valid_for=r.valid_for,
                lead_hours=r.lead_hours,
                temperature=r.temperature,
                precip_probability=r.precip_probability,
                wind_speed=r.wind_speed,
                cloud_cover=r.cloud_cover,
            )
            for r in rows
        ]
    return result


@router.get("/weights", response_model=list[SourceWeightOut])
def get_weights(db: Session = Depends(get_db)):
    """Current MAE weights per source and lead-time bucket."""
    rows = db.query(SourceWeight).order_by(SourceWeight.source, SourceWeight.lead_hours).all()
    return [
        SourceWeightOut(
            source=r.source,
            lead_hours=r.lead_hours,
            mae_temperature=round(r.mae_temperature, 4),
            mae_precip=round(r.mae_precip, 4),
            mae_wind=round(r.mae_wind, 4),
            mae_cloud=round(r.mae_cloud, 4),
            sample_count=r.sample_count,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


class SourceWeightHistoryOut(BaseModel):
    snapshot_date: str   # ISO date string "2025-06-01"
    source: str
    lead_hours: int
    mae_temperature: float
    mae_precip: float
    mae_wind: float
    mae_cloud: float
    sample_count: int


@router.get("/weights/history", response_model=list[SourceWeightHistoryOut])
def get_weights_history(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
):
    """Daily MAE snapshots for the last N days, for ranking trend visualisation."""
    from datetime import date, timedelta
    cutoff = date.today() - timedelta(days=days)
    rows = (
        db.query(SourceWeightHistory)
        .filter(SourceWeightHistory.snapshot_date >= cutoff)
        .order_by(SourceWeightHistory.snapshot_date, SourceWeightHistory.source)
        .all()
    )
    return [
        SourceWeightHistoryOut(
            snapshot_date=r.snapshot_date.isoformat(),
            source=r.source,
            lead_hours=r.lead_hours,
            mae_temperature=round(r.mae_temperature, 4),
            mae_precip=round(r.mae_precip, 4),
            mae_wind=round(r.mae_wind, 4),
            mae_cloud=round(r.mae_cloud, 4),
            sample_count=r.sample_count,
        )
        for r in rows
    ]


@router.get("/forecast/local", response_model=list[ForecastOut])
async def get_local_forecast(
    lat: float = Query(default=57.7089),
    lon: float = Query(default=11.9746),
    hours_ahead: int = Query(default=48, ge=1, le=168),
    db: Session = Depends(get_db),
):
    """Ensemble forecast with live radar blended at the given lat/lon for near-term hours."""
    import httpx
    from app.sources.radar_nowcast import (
        check_rain_at, _dbz_to_rain_rate, _rain_rate_to_prob, _CONFIDENCE
    )
    from app.ensemble import RADAR_PRECIP_WEIGHT, _lead_bucket

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=hours_ahead)

    latest_run = (
        db.query(EnsembleForecast.computed_at)
        .order_by(EnsembleForecast.computed_at.desc())
        .first()
    )
    if latest_run is None:
        raise HTTPException(status_code=404, detail="No ensemble forecast available yet")

    rows = (
        db.query(EnsembleForecast)
        .filter(
            EnsembleForecast.computed_at == latest_run[0],
            EnsembleForecast.valid_for >= now,
            EnsembleForecast.valid_for <= cutoff,
        )
        .order_by(EnsembleForecast.valid_for)
        .all()
    )

    async with httpx.AsyncClient() as client:
        radar = await check_rain_at(client, lat, lon)

    now_naive = now.replace(tzinfo=None)
    result = []
    for r in rows:
        lead_from_now = max(1, round((r.valid_for - now_naive).total_seconds() / 3600))
        bucket = _lead_bucket(lead_from_now)
        radar_fraction = RADAR_PRECIP_WEIGHT.get(bucket, 0.0)

        precip = r.precip_probability
        if radar_fraction > 0:
            if radar["raining"] and radar["dbz"] is not None:
                confidence = _CONFIDENCE.get(min(lead_from_now, 6), 0.25)
                rate = _dbz_to_rain_rate(radar["dbz"])
                radar_precip = _rain_rate_to_prob(rate, confidence)
            else:
                radar_precip = 0.0
            precip = round(radar_fraction * radar_precip + (1 - radar_fraction) * r.precip_probability, 1)

        result.append(ForecastOut(
            valid_for=r.valid_for,
            lead_hours=lead_from_now,
            temperature=r.temperature,
            precip_probability=precip,
            wind_speed=r.wind_speed,
            wind_direction=r.wind_direction,
            cloud_cover=r.cloud_cover,
            precip_mm=r.precip_mm,
            confidence=r.confidence,
        ))

    return result


@router.get("/radar/now")
async def radar_now(
    lat: float = Query(default=57.7089),
    lon: float = Query(default=11.9746),
):
    """Real-time radar rain check + CAPE instability at an arbitrary lat/lon."""
    import httpx
    import asyncio
    from app.sources.radar_nowcast import check_rain_at, fetch_cape
    async with httpx.AsyncClient() as client:
        radar, cape = await asyncio.gather(
            check_rain_at(client, lat, lon),
            fetch_cape(client, lat, lon),
        )
    return {**radar, "cape": cape}


@router.get("/warnings")
async def get_warnings():
    """Active SMHI weather warnings for Västra Götalands län (covers Göteborg)."""
    import httpx
    from app.sources.smhi_warnings import fetch_warnings
    async with httpx.AsyncClient() as client:
        return await fetch_warnings(client)


@router.get("/summary")
async def get_summary(
    period: str = Query(default="today", regex="^(today|tomorrow)$"),
    db: Session = Depends(get_db),
):
    """AI-generated weather summary for today or tomorrow. Cached 2h."""
    from datetime import date, timedelta
    from zoneinfo import ZoneInfo
    from app.sources.ai_summary import generate_summary

    # Use Stockholm local date so "today/tomorrow" matches what the user sees
    _stockholm = ZoneInfo("Europe/Stockholm")
    now_local = datetime.now(_stockholm)
    target_date = now_local.date() if period == "today" else (now_local + timedelta(days=1)).date()
    result = await generate_summary(db, target_date, period)
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="AI summary unavailable — ANTHROPIC_API_KEY not set or generation failed"
        )
    return result


SOURCE_LABELS: dict[str, str] = {
    "smhi": "SMHI",
    "yr": "Yr",
    "openweathermap": "OpenWeatherMap",
    "open_meteo": "Open-Meteo GFS",
    "open_meteo_icon_eu": "Open-Meteo ICON-EU",
    "open_meteo_ecmwf": "Open-Meteo ECMWF",
    "open_meteo_ukmo": "Open-Meteo UKMO",
    "open_meteo_knmi": "Open-Meteo KNMI",
    "radar_nowcast": "Radar Nowcast",
    "ensemble": "Ensemble",
}


@router.get("/ensemble/health")
def get_ensemble_health(db: Session = Depends(get_db)):
    """Source health dashboard based on lead_hours=1 bucket weights."""
    rows = (
        db.query(SourceWeight)
        .filter(SourceWeight.lead_hours == 1, SourceWeight.source != "ensemble")
        .all()
    )

    # Compute ensemble MAE for comparison baseline
    ens_row = db.query(SourceWeight).filter(
        SourceWeight.source == "ensemble", SourceWeight.lead_hours == 1
    ).first()
    ensemble_mae_temp = round(ens_row.mae_temperature, 3) if ens_row else None

    sources_out = []
    for r in rows:
        bias_t = round(r.bias_temperature or 0.0, 2)
        bias_w = round(r.bias_wind or 0.0, 2)
        mae_t = round(r.mae_temperature, 3)
        mae_p = round(r.mae_precip, 4)
        mae_w = round(r.mae_wind, 3)

        # Status determination
        if r.excluded:
            status = "excluded"
        elif (
            abs(bias_t) > 2.0
            or (ensemble_mae_temp is not None and mae_t > ensemble_mae_temp * 2.0)
        ):
            status = "critical"
        elif (
            abs(bias_t) > 0.8
            or (ensemble_mae_temp is not None and mae_t > ensemble_mae_temp * 1.4)
        ):
            status = "warning"
        else:
            status = "ok"

        # Suggestion
        suggestion = None
        if r.excluded:
            since_str = r.excluded_since.strftime("%Y-%m-%d") if r.excluded_since else "?"
            suggestion = f"Exkluderad sedan {since_str}: {r.excluded_reason or ''}"
        elif abs(bias_t) > 1.0:
            suggestion = f"Systematisk temperaturbia {bias_t:+.1f}°C — kompenseras av bias-korrigering"
        elif ensemble_mae_temp is not None and mae_t > ensemble_mae_temp * 1.5:
            pct = round((mae_t / ensemble_mae_temp - 1) * 100)
            suggestion = f"Temperaturträffsäkerheten är {pct}% sämre än ensemblen"

        sources_out.append({
            "source": r.source,
            "label": SOURCE_LABELS.get(r.source, r.source),
            "status": status,
            "bias_temp": bias_t,
            "bias_wind": bias_w,
            "mae_temp": mae_t,
            "mae_precip": mae_p,
            "mae_wind": mae_w,
            "sample_count": r.sample_count,
            "excluded": r.excluded,
            "excluded_reason": r.excluded_reason,
            "excluded_since": r.excluded_since.isoformat() if r.excluded_since else None,
            "manual_override": r.manual_override,
            "suggestion": suggestion,
        })

    sources_out.sort(key=lambda x: x["source"])
    excluded_count = sum(1 for s in sources_out if s["excluded"])

    return {
        "sources": sources_out,
        "ensemble_mae_temp": ensemble_mae_temp,
        "excluded_count": excluded_count,
    }


@router.post("/ensemble/sources/{source}/exclude", status_code=200)
def exclude_source(source: str, db: Session = Depends(get_db)):
    """Manually exclude a source from the ensemble."""
    rows = db.query(SourceWeight).filter(SourceWeight.source == source).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
    now = datetime.now(timezone.utc)
    for row in rows:
        row.excluded = True
        row.manual_override = True
        row.excluded_reason = "Manuellt exkluderad"
        row.excluded_since = now
    db.commit()
    return {"status": "excluded", "source": source}


@router.post("/ensemble/sources/{source}/include", status_code=200)
def include_source(source: str, db: Session = Depends(get_db)):
    """Manually re-include a previously excluded source."""
    rows = db.query(SourceWeight).filter(SourceWeight.source == source).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
    for row in rows:
        row.excluded = False
        row.manual_override = False
        row.excluded_reason = None
        row.excluded_since = None
    db.commit()
    return {"status": "included", "source": source}


@router.get("/debug/weights-diag")
def debug_weights_diag(db: Session = Depends(get_db)):
    """Diagnose why update_weights may not be running."""
    from datetime import timedelta
    from sqlalchemy import func
    from app.models import Observation

    now = datetime.now(timezone.utc)
    issued_at = now.replace(minute=0, second=0, microsecond=0)
    truth_time = (issued_at - timedelta(hours=1)).replace(tzinfo=None)

    # Check observation for truth_time
    obs = db.query(Observation).filter(Observation.valid_for == truth_time).first()

    # Recent observations
    recent_obs = db.query(Observation).order_by(Observation.valid_for.desc()).limit(5).all()

    # Forecasts matching truth_time
    from app.models import Forecast
    fc_count = db.query(func.count(Forecast.id)).filter(
        Forecast.valid_for == truth_time,
        Forecast.lead_hours != 1
    ).scalar()

    # Sample forecast valid_for values near truth_time
    sample_fcs = db.query(Forecast.valid_for, Forecast.source, Forecast.lead_hours).filter(
        Forecast.valid_for >= truth_time - timedelta(hours=2),
        Forecast.valid_for <= truth_time + timedelta(hours=2),
        Forecast.lead_hours != 1
    ).limit(10).all()

    return {
        "now_utc": now.isoformat(),
        "truth_time": truth_time.isoformat(),
        "obs_for_truth_time": obs.valid_for.isoformat() if obs else None,
        "obs_temperature": obs.temperature if obs else None,
        "recent_observations": [{"valid_for": o.valid_for.isoformat(), "temp": o.temperature} for o in recent_obs],
        "forecasts_matching_truth_time": fc_count,
        "sample_forecasts_near_truth": [
            {"valid_for": str(f[0]), "source": f[1], "lead_hours": f[2]} for f in sample_fcs
        ],
    }


@router.post("/collect", status_code=202)
async def trigger_collection():
    """Manually trigger a collection run (useful during development)."""
    from app.scheduler import collect_and_update
    import asyncio
    asyncio.create_task(collect_and_update())
    return {"status": "collection started"}


import uuid as _uuid
from pathlib import Path as _Path

IMAGE_DIR = _Path("/data/city_images")


class CityImageOut(BaseModel):
    id: int
    url: str
    filename: str
    label: str
    lat: float
    lon: float
    time_slot: str
    created_at: datetime


class CityImageUpdate(BaseModel):
    label: str
    lat: float
    lon: float
    time_slot: str = "day"


def _img_out(row: CityImage) -> CityImageOut:
    return CityImageOut(
        id=row.id,
        url=f"/city-images/{row.filename}",
        filename=row.filename,
        label=row.label,
        lat=row.lat,
        lon=row.lon,
        time_slot=row.time_slot or "day",
        created_at=row.created_at,
    )


@router.get("/city-images", response_model=list[CityImageOut])
def list_city_images(db: Session = Depends(get_db)):
    rows = db.query(CityImage).order_by(CityImage.label, CityImage.time_slot).all()
    return [_img_out(r) for r in rows]


@router.post("/city-images", response_model=CityImageOut, status_code=201)
async def upload_city_image(
    file: UploadFile = File(...),
    label: str = Form(...),
    lat: float = Form(...),
    lon: float = Form(...),
    time_slot: str = Form(default="day"),
    db: Session = Depends(get_db),
):
    ext = _Path(file.filename).suffix if file.filename else ""
    filename = f"{_uuid.uuid4()}{ext}"
    dest = IMAGE_DIR / filename
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    dest.write_bytes(content)
    row = CityImage(filename=filename, label=label, lat=lat, lon=lon, time_slot=time_slot)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _img_out(row)


@router.put("/city-images/{image_id}", response_model=CityImageOut)
def update_city_image(
    image_id: int,
    body: CityImageUpdate,
    db: Session = Depends(get_db),
):
    row = db.query(CityImage).filter(CityImage.id == image_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Image not found")
    row.label = body.label
    row.lat = body.lat
    row.lon = body.lon
    row.time_slot = body.time_slot
    db.commit()
    db.refresh(row)
    return _img_out(row)


@router.delete("/city-images/{image_id}", status_code=204)
def delete_city_image(image_id: int, db: Session = Depends(get_db)):
    row = db.query(CityImage).filter(CityImage.id == image_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Image not found")
    file_path = IMAGE_DIR / row.filename
    if file_path.exists():
        file_path.unlink()
    db.delete(row)
    db.commit()


@router.get("/status")
def get_system_status(db: Session = Depends(get_db)):
    """System health dashboard: fetch freshness, observation status, weight updates, ensemble."""
    from sqlalchemy import func

    now_naive = datetime.utcnow()

    def age_min(dt) -> Optional[int]:
        if dt is None:
            return None
        d = dt.replace(tzinfo=None) if getattr(dt, "tzinfo", None) else dt
        return max(0, round((now_naive - d).total_seconds() / 60))

    def status(age: Optional[int], warn_min: int, error_min: int) -> str:
        if age is None:
            return "missing"
        if age <= warn_min:
            return "ok"
        if age <= error_min:
            return "stale"
        return "missing"

    # ── Forecast sources ──────────────────────────────────────────────────────
    source_rows = (
        db.query(
            Forecast.source,
            func.max(Forecast.issued_at).label("latest"),
            func.count(Forecast.id).label("total"),
        )
        .group_by(Forecast.source)
        .all()
    )
    # Count forecast hours in latest run per source
    forecast_sources = []
    for src, latest, _ in source_rows:
        if src == "ensemble":
            continue
        hrs = (
            db.query(func.count(Forecast.id))
            .filter(Forecast.source == src, Forecast.issued_at == latest)
            .scalar()
        ) or 0
        age = age_min(latest)
        forecast_sources.append({
            "source":         src,
            "issued_at":      latest.isoformat() if latest else None,
            "age_minutes":    age,
            "forecast_hours": hrs,
            "status":         status(age, 90, 240),
        })
    forecast_sources.sort(key=lambda x: x["source"])

    # ── Observations ──────────────────────────────────────────────────────────
    obs = db.query(Observation).order_by(Observation.valid_for.desc()).first()
    obs_age = age_min(obs.valid_for) if obs else None
    observation = {
        "valid_for":   obs.valid_for.isoformat() if obs else None,
        "age_minutes": obs_age,
        "temperature": round(obs.temperature, 1) if obs and obs.temperature is not None else None,
        "wind_speed":  round(obs.wind_speed, 1)  if obs and obs.wind_speed  is not None else None,
        "precip_mm":   round(obs.precip_mm, 1)   if obs and obs.precip_mm   is not None else None,
        "status":      status(obs_age, 90, 180),
    }

    # ── Weight updates ────────────────────────────────────────────────────────
    weight_rows = db.query(SourceWeight).all()
    latest_weight_update = max((r.updated_at for r in weight_rows), default=None)
    min_samples = min((r.sample_count for r in weight_rows), default=0)
    max_samples = max((r.sample_count for r in weight_rows), default=0)
    w_age = age_min(latest_weight_update)
    weights_status = {
        "last_updated": latest_weight_update.isoformat() if latest_weight_update else None,
        "age_minutes":  w_age,
        "min_samples":  min_samples,
        "max_samples":  max_samples,
        "source_count": len(set(r.source for r in weight_rows)),
        "status":       status(w_age, 90, 240),
    }

    # ── Ensemble ──────────────────────────────────────────────────────────────
    ens_row = (
        db.query(EnsembleForecast.computed_at, func.count(EnsembleForecast.id).label("cnt"))
        .group_by(EnsembleForecast.computed_at)
        .order_by(EnsembleForecast.computed_at.desc())
        .first()
    )
    ens_age = age_min(ens_row[0]) if ens_row else None
    ensemble = {
        "computed_at":    ens_row[0].isoformat() if ens_row else None,
        "age_minutes":    ens_age,
        "forecast_hours": ens_row[1] if ens_row else 0,
        "status":         status(ens_age, 90, 240),
    }

    # ── AI summaries ─────────────────────────────────────────────────────────
    ai_rows = db.query(AiSummary).order_by(AiSummary.generated_at.desc()).all()
    ai_by_period: dict = {}
    for row in ai_rows:
        p = row.period
        if p not in ai_by_period:
            a = age_min(row.generated_at)
            ai_by_period[p] = {
                "period":       p,
                "valid_date":   row.valid_date.isoformat(),
                "generated_at": row.generated_at.isoformat(),
                "age_minutes":  a,
                "status":       status(a, 130, 300),  # 2h cache + 10min buffer
            }

    return {
        "forecast_sources": forecast_sources,
        "observation":      observation,
        "weights":          weights_status,
        "ensemble":         ensemble,
        "ai_summaries":     list(ai_by_period.values()),
        "server_time":      now_naive.isoformat(),
    }
