from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Body
from sqlalchemy.orm import Session
from pydantic import BaseModel

import math as _math

from app.database import get_db
from app.models import EnsembleForecast, Forecast, SourceWeight, SourceWeightHistory, Observation, AiSummary, CityImage, SunTerrace, TerraceReport, Hashtag, TerraceHashtag
from app.api.auth import get_current_user

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
    fog_probability: Optional[float] = None
    pressure: Optional[float] = None


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
            fog_probability=r.fog_probability,
            pressure=r.pressure,
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
            fog_probability=r.fog_probability,
            pressure=r.pressure,
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
            suggestion = f"Temperatur-MAE {mae_t:.2f}°C vs ensemble {ensemble_mae_temp:.2f}°C — {(mae_t - ensemble_mae_temp):.2f}°C sämre"

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
def exclude_source(source: str, db: Session = Depends(get_db), _user: str = Depends(get_current_user)):
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


@router.get("/ensemble/trend")
def get_ensemble_trend(
    days: int = Query(default=14, ge=4, le=60),
    db: Session = Depends(get_db),
):
    """
    Direct forecast accuracy: ensemble 1h-ahead forecasts vs SMHI observations.
    Returns daily MAE for temperature and Brier score for precipitation,
    plus trend comparison between the two halves of the window.
    """
    from datetime import date, timedelta
    from sqlalchemy import func

    now_naive = datetime.utcnow()
    cutoff    = now_naive - timedelta(days=days)

    # Join ensemble 1h forecasts with observations on valid_for
    rows = (
        db.query(
            Forecast.valid_for,
            Forecast.temperature.label("fc_temp"),
            Forecast.precip_probability.label("fc_precip"),
            Observation.temperature.label("obs_temp"),
            Observation.precip_mm.label("obs_precip_mm"),
        )
        .join(Observation, Forecast.valid_for == Observation.valid_for)
        .filter(
            Forecast.source == "ensemble",
            Forecast.lead_hours == 1,
            Forecast.valid_for >= cutoff,
            Forecast.temperature.isnot(None),
            Observation.temperature.isnot(None),
        )
        .order_by(Forecast.valid_for)
        .all()
    )

    if len(rows) < 4:
        return {"daily": [], "trend": None, "message": "Otillräcklig data — behöver fler observationer"}

    # Group by calendar date and compute daily MAE + Brier
    from collections import defaultdict
    by_day: dict = defaultdict(lambda: {"temp_errs": [], "brier": []})
    for r in rows:
        d = r.valid_for.date().isoformat()
        by_day[d]["temp_errs"].append(abs(r.fc_temp - r.obs_temp))
        precip_outcome = 1.0 if (r.obs_precip_mm is not None and r.obs_precip_mm > 0.1) else 0.0
        by_day[d]["brier"].append((r.fc_precip / 100.0 - precip_outcome) ** 2)

    daily = sorted([
        {
            "date":      d,
            "mae_temp":  round(sum(v["temp_errs"]) / len(v["temp_errs"]), 3),
            "brier":     round(sum(v["brier"])     / len(v["brier"]),     4),
            "n":         len(v["temp_errs"]),
        }
        for d, v in by_day.items()
        if v["temp_errs"]
    ], key=lambda x: x["date"])

    # Trend: compare first half vs second half
    mid  = len(daily) // 2
    old  = daily[:mid]
    new  = daily[mid:]
    trend = None
    if old and new:
        old_mae  = sum(d["mae_temp"] for d in old) / len(old)
        new_mae  = sum(d["mae_temp"] for d in new) / len(new)
        old_bs   = sum(d["brier"]    for d in old) / len(old)
        new_bs   = sum(d["brier"]    for d in new) / len(new)
        pct_temp = round((new_mae  - old_mae)  / old_mae  * 100, 1) if old_mae  else None
        pct_bs   = round((new_bs   - old_bs)   / old_bs   * 100, 1) if old_bs   else None
        trend = {
            "temp_mae_old":    round(old_mae, 3),
            "temp_mae_new":    round(new_mae, 3),
            "temp_pct_change": pct_temp,   # negative = improving
            "brier_old":       round(old_bs, 4),
            "brier_new":       round(new_bs, 4),
            "brier_pct_change": pct_bs,
            "direction":       "improving" if (pct_temp or 0) < -2 else "worsening" if (pct_temp or 0) > 2 else "stable",
        }

    return {"daily": daily, "trend": trend, "message": None}


@router.post("/ensemble/sources/{source}/include", status_code=200)
def include_source(source: str, db: Session = Depends(get_db), _user: str = Depends(get_current_user)):
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




@router.post("/collect", status_code=202)
async def trigger_collection(_user: str = Depends(get_current_user)):
    """Manually trigger a collection run (useful during development)."""
    from app.scheduler import collect_and_update
    import asyncio
    asyncio.create_task(collect_and_update())
    return {"status": "collection started"}


@router.get("/sun-terraces/refresh")
async def refresh_sun_terraces_now():
    """Trigger OSM terrace data refresh in the background."""
    import asyncio
    from app.scheduler import refresh_sun_terraces_job, get_refresh_state
    state = get_refresh_state()
    if state["running"]:
        return {"status": "already_running", **state}
    asyncio.create_task(refresh_sun_terraces_job())
    return {"status": "started", "running": True}


@router.get("/sun-terraces/refresh/status")
def refresh_status():
    """Poll status of the background OSM refresh job."""
    from app.scheduler import get_refresh_state
    return get_refresh_state()


@router.post("/sun-terraces/import/google")
async def import_google(_user: str = Depends(get_current_user)):
    """Trigger Google Places import job (background)."""
    import asyncio
    from app.sources.google_places import run_google_import_job, get_google_state
    state = get_google_state()
    if state["running"]:
        return {"status": "already_running", **state}
    asyncio.create_task(run_google_import_job())
    return {"status": "started", "running": True}


@router.get("/sun-terraces/import/google/status")
def import_google_status(_user: str = Depends(get_current_user)):
    """Poll status of the Google Places import job."""
    from app.sources.google_places import get_google_state
    return get_google_state()


@router.post("/sun-terraces/geocode")
async def geocode_sun_terraces(_user: str = Depends(get_current_user)):
    """Trigger reverse geocoding for terraces missing an address (background job)."""
    import asyncio
    from app.sources.geocode_terraces import run_geocode_job, get_state
    from app.database import get_db as _get_db
    state = get_state()
    if state["running"]:
        return {"status": "already_running", **state}
    asyncio.create_task(run_geocode_job(_get_db))
    return {"status": "started", "message": "Geocoding i bakgrunden — poll /sun-terraces/geocode/status"}


@router.get("/sun-terraces/geocode/status")
def geocode_status(_user: str = Depends(get_current_user)):
    """Poll geocoding job progress."""
    from app.sources.geocode_terraces import get_state
    return get_state()


@router.post("/sun-terraces/enrich/osm")
async def enrich_osm(_user: str = Depends(get_current_user)):
    """Trigger OSM road-proximity orientation job (background)."""
    import asyncio
    from app.sources.enrich_terraces import run_osm_orientation_job, get_osm_state
    from app.database import get_db as _get_db
    state = get_osm_state()
    if state["running"]:
        return {"status": "already_running", **state}
    asyncio.create_task(run_osm_orientation_job(_get_db))
    return {"status": "started"}


@router.get("/sun-terraces/enrich/osm/status")
def enrich_osm_status(_user: str = Depends(get_current_user)):
    from app.sources.enrich_terraces import get_osm_state
    return get_osm_state()


@router.post("/sun-terraces/enrich/ai")
async def enrich_ai(_user: str = Depends(get_current_user)):
    """Trigger Claude AI enrichment job (background)."""
    import asyncio
    from app.sources.enrich_terraces import run_ai_enrichment_job, get_ai_state
    from app.database import get_db as _get_db
    state = get_ai_state()
    if state["running"]:
        return {"status": "already_running", **state}
    asyncio.create_task(run_ai_enrichment_job(_get_db))
    return {"status": "started"}


@router.get("/sun-terraces/enrich/ai/status")
def enrich_ai_status(_user: str = Depends(get_current_user)):
    from app.sources.enrich_terraces import get_ai_state
    return get_ai_state()


@router.post("/sun-terraces/auto-arc", status_code=200)
def auto_arc_terraces(
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Derive sun_arc_from/to for all terraces that have a compass orientation
    but no arc yet.  Each 8-point direction becomes a 180° arc (center ± 90°).
    This is mathematically equivalent to the old cosine orientation_score model."""
    from app.sources.sun_terraces import ORIENTATION_AZIMUTHS
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = (
        db.query(SunTerrace)
        .filter(
            SunTerrace.active == True,            # noqa: E712
            SunTerrace.sun_arc_from == None,      # noqa: E711  — no arc yet
            SunTerrace.street_orientation != None, # noqa: E711
            SunTerrace.street_orientation != "UNKNOWN",
        )
        .all()
    )
    updated = 0
    for t in rows:
        center = ORIENTATION_AZIMUTHS.get(t.street_orientation)
        if center is None:
            continue
        t.sun_arc_from = (center - 90 + 360) % 360
        t.sun_arc_to   = (center + 90) % 360
        t.updated_at   = now
        updated += 1
    if updated:
        db.commit()
    return {"updated": updated, "total": len(rows)}


@router.post("/sun-terraces/fix-addresses", status_code=200)
def fix_terrace_addresses(
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Fix addresses stored as 'housenr street' → 'street housenr'."""
    from app.sources.geocode_terraces import normalize_address
    rows = db.query(SunTerrace).filter(SunTerrace.address.isnot(None)).all()
    fixed = 0
    for t in rows:
        corrected = normalize_address(t.address)
        if corrected != t.address:
            t.address = corrected
            fixed += 1
    if fixed:
        db.commit()
    return {"fixed": fixed, "total": len(rows)}


@router.post("/collect/sync")
async def trigger_collection_sync(_user: str = Depends(get_current_user)):
    """Run collection synchronously and return any errors — for debugging."""
    from app.scheduler import collect_and_update
    import traceback
    try:
        await collect_and_update()
        return {"status": "completed"}
    except Exception as e:
        return {"status": "error", "error": traceback.format_exc(limit=15)}


@router.post("/debug/ensemble-test-cleanup", status_code=200)
def cleanup_test_ensemble_rows(db: Session = Depends(get_db), _user: str = Depends(get_current_user)):
    """Delete partial ensemble rows created by test endpoint."""
    from sqlalchemy import func
    # Find computed_at values that have very few rows (test artifacts)
    counts = db.query(
        EnsembleForecast.computed_at,
        func.count(EnsembleForecast.id).label("cnt")
    ).group_by(EnsembleForecast.computed_at).all()
    deleted_times = []
    for computed_at, cnt in counts:
        if cnt < 20:  # full collect creates 100+ rows
            db.query(EnsembleForecast).filter(
                EnsembleForecast.computed_at == computed_at
            ).delete()
            deleted_times.append({"computed_at": str(computed_at), "rows": cnt})
    db.commit()
    return {"deleted": deleted_times}


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
    image_type: str
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
        image_type=row.image_type or "background",
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
    image_type: str = Form(default="background"),
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    ext = _Path(file.filename).suffix if file.filename else ""
    filename = f"{_uuid.uuid4()}{ext}"
    dest = IMAGE_DIR / filename
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    dest.write_bytes(content)
    row = CityImage(filename=filename, label=label, lat=lat, lon=lon, time_slot=time_slot, image_type=image_type)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _img_out(row)


@router.put("/city-images/{image_id}", response_model=CityImageOut)
def update_city_image(
    image_id: int,
    body: CityImageUpdate,
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
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
def delete_city_image(image_id: int, db: Session = Depends(get_db), _user: str = Depends(get_current_user)):
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


# ── Sun Terraces ──────────────────────────────────────────────────────────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371
    phi1, phi2 = _math.radians(lat1), _math.radians(lat2)
    dphi = _math.radians(lat2 - lat1)
    dlambda = _math.radians(lon2 - lon1)
    a = (_math.sin(dphi / 2) ** 2
         + _math.cos(phi1) * _math.cos(phi2) * _math.sin(dlambda / 2) ** 2)
    return R * 2 * _math.atan2(_math.sqrt(a), _math.sqrt(1 - a))


def _build_explanation(scores: dict, orientation: Optional[str], confidence: float) -> str:
    if scores.get("now", {}).get("total_score", 0) >= 70:
        timing = "Bra solläge just nu"
    elif scores.get("1h", {}).get("total_score", 0) >= 70:
        timing = "Bra solläge om en timme"
    elif scores.get("2h", {}).get("total_score", 0) >= 70:
        timing = "Bra solläge om två timmar"
    else:
        timing = "Begränsat solläge kommande timmarna"
    conf_str = "hög" if confidence > 0.6 else "medel" if confidence > 0.4 else "låg"
    return f"{timing} · {conf_str} säkerhet"


@router.get("/hashtags")
def get_hashtags(db: Session = Depends(get_db)):
    """Return all active hashtags."""
    rows = db.query(Hashtag).filter(Hashtag.active == True).order_by(Hashtag.name).all()  # noqa: E712
    return [{"id": h.id, "name": h.name} for h in rows]


@router.get("/sun-terraces/{terrace_id}/hashtags")
def get_terrace_hashtags(terrace_id: int, db: Session = Depends(get_db)):
    """Return hashtags for a specific venue sorted by count desc."""
    rows = (
        db.query(TerraceHashtag, Hashtag)
        .join(Hashtag, TerraceHashtag.hashtag_id == Hashtag.id)
        .filter(TerraceHashtag.terrace_id == terrace_id)
        .order_by(TerraceHashtag.count.desc())
        .all()
    )
    return [{"id": h.id, "name": h.name, "count": th.count} for th, h in rows]


@router.post("/sun-terraces/{terrace_id}/hashtags/{hashtag_id}")
def add_terrace_hashtag(terrace_id: int, hashtag_id: int, db: Session = Depends(get_db)):
    """Increment hashtag count for a venue (or create with count=1)."""
    row = (
        db.query(TerraceHashtag)
        .filter(TerraceHashtag.terrace_id == terrace_id, TerraceHashtag.hashtag_id == hashtag_id)
        .first()
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if row is None:
        row = TerraceHashtag(terrace_id=terrace_id, hashtag_id=hashtag_id, count=1, updated_at=now)
        db.add(row)
    else:
        row.count += 1
        row.updated_at = now
    db.commit()
    db.refresh(row)
    return {"terrace_id": row.terrace_id, "hashtag_id": row.hashtag_id, "count": row.count}


@router.delete("/sun-terraces/{terrace_id}/hashtags/{hashtag_id}")
def remove_terrace_hashtag(terrace_id: int, hashtag_id: int, db: Session = Depends(get_db)):
    """Decrement hashtag count. Delete row if count reaches 0."""
    row = (
        db.query(TerraceHashtag)
        .filter(TerraceHashtag.terrace_id == terrace_id, TerraceHashtag.hashtag_id == hashtag_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Hashtag not found for this venue")
    if row.count <= 1:
        db.delete(row)
        db.commit()
        return {"terrace_id": terrace_id, "hashtag_id": hashtag_id, "count": 0}
    row.count -= 1
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(row)
    return {"terrace_id": row.terrace_id, "hashtag_id": row.hashtag_id, "count": row.count}


class HashtagBody(BaseModel):
    name: str


@router.post("/admin/hashtags", status_code=201)
def create_hashtag(body: HashtagBody, db: Session = Depends(get_db), _user: str = Depends(get_current_user)):
    """Create a new hashtag (admin only)."""
    name = body.name.strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    existing = db.query(Hashtag).filter(Hashtag.name == name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Hashtag already exists")
    h = Hashtag(name=name, active=True, created_at=datetime.now(timezone.utc).replace(tzinfo=None))
    db.add(h)
    db.commit()
    db.refresh(h)
    return {"id": h.id, "name": h.name, "active": h.active}


@router.post("/sun-terraces/auto-tag")
async def trigger_auto_tag(_user: str = Depends(get_current_user)):
    """Trigger automatic hashtag tagging job (background)."""
    import asyncio
    from app.sources.auto_tag import run_auto_tag_job, get_state
    from app.database import get_db as _get_db
    state = get_state()
    if state["running"]:
        return {"status": "already_running", **state}
    asyncio.create_task(run_auto_tag_job(_get_db))
    return {"status": "started", "message": "Auto-taggning i bakgrunden — poll /sun-terraces/auto-tag/status"}


@router.get("/sun-terraces/auto-tag/status")
def auto_tag_status(_user: str = Depends(get_current_user)):
    """Poll auto-tag job progress."""
    from app.sources.auto_tag import get_state
    return get_state()


@router.get("/sun-terraces")
def get_sun_terraces(
    lat: float = Query(default=57.7089),
    lon: float = Query(default=11.9746),
    radius: float = Query(default=2.0, ge=0.1, le=20.0),
    type: str = Query(default="all"),
    min_score: int = Query(default=0, ge=0, le=100),
    include_low_confidence: bool = Query(default=True),
    name: str = Query(default=""),
    tags: str = Query(default=""),
    db: Session = Depends(get_db),
):
    """Get sun terraces within radius, scored by current solar conditions.
    When `name` is provided, radius is ignored and all active terraces matching
    the name are returned (sorted by distance).
    When `tags` (comma-separated hashtag names) is provided, only venues with
    any of those tags are returned."""
    from app.sources.sun_terraces import compute_scores

    all_terraces = db.query(SunTerrace).filter(SunTerrace.active == True).all()  # noqa: E712

    # Build hashtag lookup: terrace_id -> [{id, name, count}]
    all_th = (
        db.query(TerraceHashtag, Hashtag)
        .join(Hashtag, TerraceHashtag.hashtag_id == Hashtag.id)
        .all()
    )
    terrace_hashtags: dict = {}
    for th, h in all_th:
        terrace_hashtags.setdefault(th.terrace_id, []).append({"id": h.id, "name": h.name, "count": th.count})
    for tid in terrace_hashtags:
        terrace_hashtags[tid].sort(key=lambda x: -x["count"])

    # Tag filter: terrace must have at least one matching tag
    tag_names: set = set()
    if tags.strip():
        tag_names = {t.strip().lower() for t in tags.split(",") if t.strip()}

    if name.strip():
        # Name search: ignore radius, match anywhere in name, address, or hashtag
        q = name.strip().lower()
        nearby = [
            t for t in all_terraces
            if q in (t.name or "").lower()
            or q in (t.address or "").lower()
            or any(q in ht["name"] for ht in terrace_hashtags.get(t.id, []))
        ]
    else:
        nearby = [
            t for t in all_terraces
            if _haversine_km(lat, lon, t.lat, t.lon) <= radius
        ]

    # Filter by amenity type (supports comma-separated values, e.g. "cafe,bar")
    if type and type != "all":
        type_set = {t.strip() for t in type.split(",")}
        nearby = [t for t in nearby if t.amenity_type in type_set]

    # Filter by hashtag tags
    if tag_names:
        nearby = [
            t for t in nearby
            if any(ht["name"] in tag_names for ht in terrace_hashtags.get(t.id, []))
        ]

    # Get latest ensemble forecast hours for next 3h
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=18)   # extend to cover full remaining day
    latest_run = (
        db.query(EnsembleForecast.computed_at)
        .order_by(EnsembleForecast.computed_at.desc())
        .first()
    )
    forecast_hours: list = []
    if latest_run:
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
        forecast_hours = [
            {
                "temperature": r.temperature,
                "precip_probability": r.precip_probability,
                "wind_speed": r.wind_speed,
                "cloud_cover": r.cloud_cover,
                "valid_for_ts": r.valid_for.replace(tzinfo=timezone.utc).timestamp()
                if r.valid_for.tzinfo is None
                else r.valid_for.timestamp(),
            }
            for r in rows
        ]

    results = []
    for t in nearby:
        outdoor_type = t.outdoor_type or "unknown"
        # Skip venues explicitly marked as having no outdoor seating
        if outdoor_type == "none":
            continue
        scores = compute_scores(
            t.lat, t.lon,
            t.street_orientation,
            t.orientation_confidence,
            forecast_hours,
            outdoor_seating=t.outdoor_seating,
            is_rooftop=(outdoor_type == "rooftop"),
            polygon_coords_json=t.polygon_coords,
            sun_arc_from=getattr(t, 'sun_arc_from', None),
            sun_arc_to=getattr(t, 'sun_arc_to', None),
        )
        now_score = scores.get("now", {}).get("total_score", 0)
        best_score = max(
            scores.get("now", {}).get("total_score", 0),
            scores.get("1h", {}).get("total_score", 0),
            scores.get("2h", {}).get("total_score", 0),
        )
        if best_score < min_score:
            continue
        if not include_low_confidence and scores["confidence"] < 0.4:
            continue
        results.append({
            "id": t.id,
            "name": t.name,
            "lat": t.lat,
            "lon": t.lon,
            "amenity_type": t.amenity_type,
            "address": t.address,
            "website": t.website,
            "outdoor_seating": t.outdoor_seating,
            "outdoor_type": outdoor_type,
            "street_orientation": t.street_orientation,
            "orientation_confidence": t.orientation_confidence,
            "sun_arc_from": t.sun_arc_from,
            "sun_arc_to": t.sun_arc_to,
            "distance_km": round(_haversine_km(lat, lon, t.lat, t.lon), 2),
            "scores": scores,
            "now_score": now_score,
            "best_score": best_score,
            "day_score": scores.get("day_score", 0),
            "explanation": _build_explanation(scores, t.street_orientation, scores["confidence"]),
            "hashtags": terrace_hashtags.get(t.id, []),
        })

    # Sort: day_score desc (rest-of-day sun exposure), then distance asc on tie
    results.sort(key=lambda x: (-x["day_score"], x["distance_km"]))
    return results


@router.get("/sun-terraces/admin")
def get_sun_terraces_admin(db: Session = Depends(get_db)):
    """Return all terraces (active + inactive) for admin debugging."""
    rows = (
        db.query(SunTerrace)
        .order_by(SunTerrace.name)
        .all()
    )
    return [
        {
            "id": t.id,
            "source": t.source,
            "source_id": t.source_id,
            "name": t.name,
            "lat": t.lat,
            "lon": t.lon,
            "amenity_type": t.amenity_type,
            "address": t.address,
            "website": t.website,
            "outdoor_seating": t.outdoor_seating,
            "outdoor_type": t.outdoor_type or "unknown",
            "street_orientation": t.street_orientation,
            "orientation_confidence": t.orientation_confidence,
            "polygon_coords": t.polygon_coords,
            "sun_arc_from": t.sun_arc_from,
            "sun_arc_to":   t.sun_arc_to,
            "active": t.active,
            "last_seen_at": t.last_seen_at.isoformat() if t.last_seen_at else None,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        }
        for t in rows
    ]


class SunTerraceOverride(BaseModel):
    orientation: str
    orientation_confidence: float
    amenity_type: Optional[str] = None
    active: Optional[bool] = None
    outdoor_type: Optional[str] = None
    polygon_coords: Optional[str] = None  # JSON string "[[lat,lon],...]" or null to clear
    name: Optional[str] = None
    address: Optional[str] = None
    sun_arc_from: Optional[float] = None
    sun_arc_to:   Optional[float] = None


@router.post("/sun-terraces/{terrace_id}/override", status_code=200)
def override_sun_terrace(
    terrace_id: int,
    body: SunTerraceOverride,
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Override orientation, outdoor type, polygon, and active status for a terrace."""
    terrace = db.query(SunTerrace).filter(SunTerrace.id == terrace_id).first()
    if terrace is None:
        raise HTTPException(status_code=404, detail="Terrace not found")
    valid_orientations = {"N", "NE", "E", "SE", "S", "SW", "W", "NW", "UNKNOWN"}
    if body.orientation not in valid_orientations:
        raise HTTPException(status_code=400, detail=f"Invalid orientation. Must be one of {valid_orientations}")
    valid_amenity_types = {"restaurant", "cafe", "bar", "pub"}
    if body.amenity_type is not None and body.amenity_type not in valid_amenity_types:
        raise HTTPException(status_code=400, detail=f"Invalid amenity_type. Must be one of {valid_amenity_types}")
    valid_outdoor_types = {"unknown", "terrace", "rooftop", "none"}
    if body.outdoor_type is not None and body.outdoor_type not in valid_outdoor_types:
        raise HTTPException(status_code=400, detail=f"Invalid outdoor_type. Must be one of {valid_outdoor_types}")
    terrace.street_orientation = body.orientation
    terrace.orientation_confidence = body.orientation_confidence
    if body.amenity_type is not None:
        terrace.amenity_type = body.amenity_type
    if body.active is not None:
        terrace.active = body.active
    if body.outdoor_type is not None:
        terrace.outdoor_type = body.outdoor_type
    if body.polygon_coords is not None:
        terrace.polygon_coords = body.polygon_coords if body.polygon_coords != "" else None
    if body.sun_arc_from is not None or body.sun_arc_to is not None:
        terrace.sun_arc_from = body.sun_arc_from
        terrace.sun_arc_to   = body.sun_arc_to
    if body.name is not None and body.name.strip():
        terrace.name = body.name.strip()
    if body.address is not None:
        terrace.address = body.address.strip() or None
    terrace.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(terrace)
    return {
        "id": terrace.id,
        "street_orientation": terrace.street_orientation,
        "orientation_confidence": terrace.orientation_confidence,
        "amenity_type": terrace.amenity_type,
        "active": terrace.active,
    }


@router.post("/sun-terraces/{terrace_id}/derive-arc", status_code=200)
def derive_arc(
    terrace_id: int,
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Derive sun_arc_from/to from the stored polygon and save."""
    import json as _json
    from app.sources.sun_terraces import arc_from_polygon as _arc_from_poly
    terrace = db.query(SunTerrace).filter(SunTerrace.id == terrace_id).first()
    if terrace is None:
        raise HTTPException(status_code=404, detail="Terrace not found")
    if not terrace.polygon_coords:
        raise HTTPException(status_code=400, detail="No polygon stored for this terrace")
    poly = _json.loads(terrace.polygon_coords)
    arc_f, arc_t = _arc_from_poly(poly)
    if arc_f is None:
        raise HTTPException(status_code=400, detail="Could not derive arc from polygon")
    terrace.sun_arc_from = arc_f
    terrace.sun_arc_to   = arc_t
    terrace.orientation_confidence = 1.0
    terrace.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return {"sun_arc_from": arc_f, "sun_arc_to": arc_t}


class TerraceReportBody(BaseModel):
    user_lat: Optional[float] = None
    user_lon: Optional[float] = None
    feedback: Optional[str] = None   # JSON string: {"issues": [...], "comment": "..."}


@router.post("/sun-terraces/{terrace_id}/report", status_code=201)
def report_terrace(
    terrace_id: int,
    body: TerraceReportBody,
    db: Session = Depends(get_db),
):
    """Submit a data-quality report for a terrace."""
    terrace = db.query(SunTerrace).filter(SunTerrace.id == terrace_id).first()
    if terrace is None:
        raise HTTPException(status_code=404, detail="Terrace not found")
    row = TerraceReport(
        terrace_id=terrace_id,
        reported_at=datetime.now(timezone.utc).replace(tzinfo=None),
        user_lat=body.user_lat,
        user_lon=body.user_lon,
        feedback=body.feedback,
    )
    db.add(row)
    db.commit()
    return {"status": "ok", "terrace_id": terrace_id}


class CreateTerraceBody(BaseModel):
    name: str
    lat: float
    lon: float
    amenity_type: str = "restaurant"
    address: Optional[str] = None
    outdoor_type: str = "unknown"
    orientation: Optional[str] = None
    orientation_confidence: float = 0.3


@router.post("/sun-terraces/create", status_code=201)
def create_terrace(body: CreateTerraceBody, db: Session = Depends(get_db)):
    """Manually create a terrace not in OSM. No auth required — open for user suggestions."""
    import uuid as _uuid
    valid_types = {"restaurant", "cafe", "bar", "pub"}
    if body.amenity_type not in valid_types:
        raise HTTPException(status_code=400, detail="Invalid amenity_type")
    valid_ori = {"N", "NE", "E", "SE", "S", "SW", "W", "NW", "UNKNOWN", None}
    if body.orientation not in valid_ori:
        raise HTTPException(status_code=400, detail="Invalid orientation")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    t = SunTerrace(
        source="manual",
        source_id=f"manual_{_uuid.uuid4().hex[:12]}",
        name=body.name.strip(),
        lat=body.lat,
        lon=body.lon,
        amenity_type=body.amenity_type,
        address=body.address,
        outdoor_seating=True,
        outdoor_type=body.outdoor_type,
        street_orientation=body.orientation or "UNKNOWN",
        orientation_confidence=body.orientation_confidence,
        active=True,
        last_seen_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id, "name": t.name, "source_id": t.source_id}


# ── Feedback admin ────────────────────────────────────────────────────────────

@router.get("/votes/admin")
def get_votes_admin(
    status_filter: str = Query(default="all"),
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Return all reports with feedback, for admin review."""
    import json as _json
    q = db.query(TerraceReport).filter(TerraceReport.feedback.isnot(None))
    if status_filter != "all":
        q = q.filter(TerraceReport.status == status_filter)
    rows = q.order_by(TerraceReport.reported_at.desc()).all()

    result = []
    for v in rows:
        terrace = db.query(SunTerrace).filter(SunTerrace.id == v.terrace_id).first()
        fb = {}
        try:
            fb = _json.loads(v.feedback) if v.feedback else {}
        except Exception:
            pass
        result.append({
            "id": v.id,
            "terrace_id": v.terrace_id,
            "terrace_name": terrace.name if terrace else f"#{v.terrace_id}",
            "terrace_address": terrace.address if terrace else None,
            "reported_at": v.reported_at.isoformat() if v.reported_at else None,
            "issues": fb.get("issues", []),
            "comment": fb.get("comment", ""),
            "status": v.status or "pending",
            "user_lat": v.user_lat,
            "user_lon": v.user_lon,
        })
    return result


class ReportStatusBody(BaseModel):
    status: str   # pending / in_progress / resolved / dismissed


@router.patch("/reports/{report_id}/status", status_code=200)
def update_report_status(
    report_id: int,
    body: ReportStatusBody,
    db: Session = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    valid = {"pending", "in_progress", "resolved", "dismissed"}
    if body.status not in valid:
        raise HTTPException(status_code=400, detail=f"status must be one of {valid}")
    v = db.query(TerraceReport).filter(TerraceReport.id == report_id).first()
    if v is None:
        raise HTTPException(status_code=404, detail="Report not found")
    v.status = body.status
    db.commit()
    return {"id": report_id, "status": body.status}
