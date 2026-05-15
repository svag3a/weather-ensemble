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
from app.models import Forecast, Observation
from app.ensemble import update_weights, build_ensemble
from app.sources import smhi, yr, open_meteo, open_meteo_icon_eu, open_meteo_ecmwf, openweathermap, radar_nowcast, smhi_obs

logger = logging.getLogger(__name__)

SOURCES = {
    smhi.SOURCE_NAME: smhi.fetch,
    yr.SOURCE_NAME: yr.fetch,
    open_meteo.SOURCE_NAME: open_meteo.fetch,
    open_meteo_icon_eu.SOURCE_NAME: open_meteo_icon_eu.fetch,
    open_meteo_ecmwf.SOURCE_NAME: open_meteo_ecmwf.fetch,
    openweathermap.SOURCE_NAME: openweathermap.fetch,
    radar_nowcast.SOURCE_NAME: radar_nowcast.fetch,
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
                logger.info("  observation: %.1f°C, wind %.1f m/s, precip %.1f mm",
                            obs_data["temperature"],
                            obs_data["wind_speed"] or 0,
                            obs_data["precip_mm"] or 0)
        except Exception as exc:
            logger.warning("  smhi_obs fetch failed: %s", exc)

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

        for source, forecasts in forecasts_by_source.items():
            _upsert_forecasts(db, source, issued_at, forecasts)

        # Update weights using last hour's 1h forecasts as truth
        truth_time = issued_at  # The current time is what was forecasted 1h ago
        update_weights(db, truth_time)

        build_ensemble(db, issued_at, forecasts_by_source)
        logger.info("Collection run complete.")
    finally:
        db.close()


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(collect_and_update, "cron", minute=5)  # run at :05 each hour
    return scheduler
