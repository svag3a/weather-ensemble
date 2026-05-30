from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import EnsembleForecast, Forecast, SourceWeight, SourceWeightHistory, Observation, AiSummary

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
    from app.sources.ai_summary import generate_summary

    target_date = date.today() if period == "today" else date.today() + timedelta(days=1)
    result = await generate_summary(db, target_date, period)
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="AI summary unavailable — ANTHROPIC_API_KEY not set or generation failed"
        )
    return result


@router.post("/collect", status_code=202)
async def trigger_collection():
    """Manually trigger a collection run (useful during development)."""
    from app.scheduler import collect_and_update
    import asyncio
    asyncio.create_task(collect_and_update())
    return {"status": "collection started"}


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
