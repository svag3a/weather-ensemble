"""
Hourly collection job:
  1. Fetch forecasts from all sources
  2. Persist raw forecasts
  3. Update MAE weights based on new consensus 1h truth
  4. Build and persist ensemble forecasts
"""
import logging
from datetime import datetime, timezone, timedelta
from math import isnan

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import Forecast, Observation, MetarObservation, SourceWeight, SourceWeightHistory, SunTerrace
from app.ensemble import update_weights, build_ensemble
from app.sources import (
    smhi, yr, open_meteo, open_meteo_icon_eu, open_meteo_ecmwf,
    open_meteo_ukmo, open_meteo_knmi, openweathermap, radar_nowcast, smhi_obs,
)
from app.sources.sun_terraces import refresh_terraces

logger = logging.getLogger(__name__)

SOURCES = {
    smhi.SOURCE_NAME:               smhi.fetch,
    yr.SOURCE_NAME:                 yr.fetch,
    open_meteo.SOURCE_NAME:         open_meteo.fetch,
    open_meteo_icon_eu.SOURCE_NAME: open_meteo_icon_eu.fetch,
    open_meteo_ecmwf.SOURCE_NAME:   open_meteo_ecmwf.fetch,
    open_meteo_ukmo.SOURCE_NAME:    open_meteo_ukmo.fetch,
    open_meteo_knmi.SOURCE_NAME:    open_meteo_knmi.fetch,
    openweathermap.SOURCE_NAME:     openweathermap.fetch,
    radar_nowcast.SOURCE_NAME:      radar_nowcast.fetch,
}


def _upsert_forecasts(db: Session, source: str, issued_at: datetime, forecasts) -> None:
    for fc in forecasts:
        lead_hours = max(1, round((fc.valid_for - issued_at).total_seconds() / 3600))
        existing = (
            db.query(Forecast)
            .filter(
                Forecast.source == source,
                Forecast.issued_at == issued_at,
                Forecast.valid_for == fc.valid_for,
            )
            .first()
        )
        if existing is None and not isnan(fc.temperature):
            db.add(Forecast(
                source=source,
                issued_at=issued_at,
                valid_for=fc.valid_for,
                lead_hours=lead_hours,
                temperature=fc.temperature,
                precip_probability=fc.precip_probability,
                wind_speed=None if isnan(fc.wind_speed) else fc.wind_speed,
                wind_direction=None if isnan(fc.wind_direction) else fc.wind_direction,
                cloud_cover=None if isnan(fc.cloud_cover) else fc.cloud_cover,
                precip_mm=None if isnan(fc.precip_mm) else fc.precip_mm,
                fog_probability=None if isnan(fc.fog_probability) else fc.fog_probability,
                pressure=None if isnan(fc.pressure) else fc.pressure,
            ))
    db.commit()


async def collect_and_update() -> None:
    issued_at = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    logger.info("Starting collection run for %s", issued_at.isoformat())

    forecasts_by_source: dict = {}

    obs_data = None
    async with httpx.AsyncClient() as client:
        for name, fetch_fn in SOURCES.items():
            try:
                forecasts = await fetch_fn(client)
                forecasts_by_source[name] = forecasts
                logger.info("  %s: %d forecasts fetched", name, len(forecasts))
            except Exception as exc:
                logger.warning("  %s fetch failed: %s", name, exc)
        try:
            obs_data = await smhi_obs.fetch(client)
            if obs_data:
                sids = obs_data.get("station_ids", {})
                logger.info(
                    "  observation: %.1f°C, wind %.1f m/s, precip %.1f mm"
                    "  [temp stations: %s, wind: %s, precip: %s]",
                    obs_data["temperature"] or 0,
                    obs_data["wind_speed"] or 0,
                    obs_data["precip_mm"] or 0,
                    sids.get("temp", []),
                    sids.get("wind", []),
                    sids.get("precip", []),
                )
        except Exception as exc:
            logger.warning("  smhi_obs fetch failed: %s", exc)

        metar_data = None
        try:
            from app.sources.metar import fetch_metar_cloud
            metar_data = await fetch_metar_cloud(client)
            if metar_data:
                logger.info("  metar ESGG: %.0f%% cloud (%s)",
                            metar_data["cloud_cover"], metar_data.get("raw", ""))
        except Exception as exc:
            logger.warning("  metar fetch failed: %s", exc)

    db: Session = SessionLocal()
    try:
        if obs_data:
            existing_obs = db.query(Observation).filter(
                Observation.valid_for == obs_data["valid_for"]
            ).first()
            if existing_obs is None:
                db.add(Observation(
                    valid_for=obs_data["valid_for"],
                    temperature=obs_data["temperature"],
                    wind_speed=obs_data.get("wind_speed"),
                    precip_mm=obs_data.get("precip_mm"),
                ))
                db.commit()

        if metar_data and metar_data.get("observed_at"):
            obs_ts = metar_data["observed_at"].replace(tzinfo=None)
            existing_metar = db.query(MetarObservation).filter(
                MetarObservation.observed_at == obs_ts
            ).first()
            if existing_metar is None:
                db.add(MetarObservation(
                    observed_at=obs_ts,
                    cloud_cover=metar_data["cloud_cover"],
                    raw_metar=metar_data.get("raw", "")[:200],
                    stored_at=datetime.now(timezone.utc).replace(tzinfo=None),
                ))
                db.commit()

        for source, forecasts in forecasts_by_source.items():
            _upsert_forecasts(db, source, issued_at, forecasts)

        # Observations are for the *previous* hour (SMHI publishes completed hours).
        # Pass a naive UTC datetime so it matches how valid_for is stored in the DB.
        truth_time = (issued_at - timedelta(hours=1)).replace(tzinfo=None)
        update_weights(db, truth_time)

        try:
            build_ensemble(db, issued_at, forecasts_by_source)
        except Exception as exc:
            logger.error("build_ensemble failed: %s", exc, exc_info=True)
            db.rollback()
        _maybe_snapshot_weights(db, issued_at.date())
        await _pregen_ai_summaries(db)
        # Seed sun terraces on first run if table is empty
        terrace_count = db.query(SunTerrace).count()
        if terrace_count == 0:
            logger.info("Sun terraces table empty — seeding from Overpass…")
            async with httpx.AsyncClient() as terrace_client:
                await refresh_terraces(db, terrace_client)
        logger.info("Collection run complete.")
    finally:
        db.close()


def _maybe_snapshot_weights(db: Session, today) -> None:
    """Take a daily snapshot of current source weights if not already done today."""
    already = db.query(SourceWeightHistory).filter(
        SourceWeightHistory.snapshot_date == today
    ).first()
    if already is not None:
        return

    rows = db.query(SourceWeight).all()
    for r in rows:
        db.add(SourceWeightHistory(
            snapshot_date=today,
            source=r.source,
            lead_hours=r.lead_hours,
            mae_temperature=r.mae_temperature,
            mae_precip=r.mae_precip,
            mae_wind=r.mae_wind,
            mae_cloud=r.mae_cloud,
            sample_count=r.sample_count,
        ))
    db.commit()
    logger.info("  Daily weight snapshot saved (%d rows)", len(rows))


async def _pregen_ai_summaries(db: Session) -> None:
    """Pre-generate and cache AI summaries for today and tomorrow after each collection run."""
    import os
    if not os.getenv("ANTHROPIC_API_KEY"):
        return
    from datetime import date, timedelta
    from zoneinfo import ZoneInfo
    from app.sources.ai_summary import generate_summary
    _stockholm = ZoneInfo("Europe/Stockholm")
    now_local = datetime.now(_stockholm)
    for period, target_date in [
        ("today",    now_local.date()),
        ("tomorrow", (now_local + timedelta(days=1)).date()),
    ]:
        try:
            await generate_summary(db, target_date, period)
            logger.info("  AI summary ready for %s", period)
        except Exception as exc:
            logger.warning("  AI summary pre-generation failed for %s: %s", period, exc)


_refresh_state: dict = {
    "running": False, "added": 0, "updated": 0, "deactivated": 0,
    "started_at": None, "finished_at": None, "error": None,
}


def get_refresh_state() -> dict:
    return dict(_refresh_state)


async def refresh_sun_terraces_job() -> None:
    """Daily refresh of sun terrace data from Overpass."""
    global _refresh_state
    if _refresh_state["running"]:
        return
    _refresh_state = {
        "running": True, "added": 0, "updated": 0, "deactivated": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    db: Session = SessionLocal()
    try:
        async with httpx.AsyncClient() as client:
            stats = await refresh_terraces(db, client)
        _refresh_state["added"]       = stats.get("added", 0)
        _refresh_state["updated"]     = stats.get("updated", 0)
        _refresh_state["deactivated"] = stats.get("deactivated", 0)
    except Exception as exc:
        _refresh_state["error"] = str(exc)
        logger.error("refresh_sun_terraces_job failed: %s", exc)
    finally:
        db.close()
        _refresh_state["running"]     = False
        _refresh_state["finished_at"] = datetime.now(timezone.utc).isoformat()


async def calibrate_metar_job() -> None:
    """Daily METAR blend-weight calibration (04:30 UTC).
    No-op until ≥100 observations exist (~4 days of hourly data)."""
    from app.sources.metar_calibration import calibrate_metar_weights
    from app.sources.metar import load_calibrated_weights
    db: Session = SessionLocal()
    try:
        results = calibrate_metar_weights(db)
        if results:
            load_calibrated_weights(db)
            logger.info("METAR calibration complete: %s", {
                k: round(v["weight"], 2) for k, v in results.items()
            })
        else:
            logger.info("METAR calibration skipped (not enough data yet)")
    except Exception as exc:
        logger.error("METAR calibration failed: %s", exc)
    finally:
        db.close()


async def nightly_terrace_pipeline() -> None:
    """Nightly pipeline: OSM import → solar arc from roads → auto-hashtag.

    Runs at 03:00 UTC (05:00 CEST).  Each step is independent; a failure
    in one step is logged but does not abort the following steps.
    """
    from app.sources.enrich_terraces import run_osm_orientation_job
    from app.sources.auto_tag import run_auto_tag_job

    logger.info("Nightly terrace pipeline started")

    # 1. Refresh venues from OSM (adds new, deactivates removed)
    try:
        await refresh_sun_terraces_job()
        logger.info("Pipeline step 1/3 done: OSM refresh")
    except Exception as exc:
        logger.error("Pipeline step 1/3 failed (OSM refresh): %s", exc)

    # 2. Assign solar arcs from nearest road bearing
    try:
        await run_osm_orientation_job(SessionLocal)
        logger.info("Pipeline step 2/3 done: OSM orientation")
    except Exception as exc:
        logger.error("Pipeline step 2/3 failed (orientation): %s", exc)

    # 3. Auto-tag hashtags (name/arc/AI)
    try:
        await run_auto_tag_job(SessionLocal)
        logger.info("Pipeline step 3/3 done: auto-tag")
    except Exception as exc:
        logger.error("Pipeline step 3/3 failed (auto-tag): %s", exc)

    logger.info("Nightly terrace pipeline finished")


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(collect_and_update, "cron", minute=5)           # hourly at :05
    scheduler.add_job(nightly_terrace_pipeline, "cron", hour=3, minute=0)   # daily 03:00 UTC
    scheduler.add_job(calibrate_metar_job, "cron", hour=4, minute=30)       # daily 04:30 UTC
    return scheduler
