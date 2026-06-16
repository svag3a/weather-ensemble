"""
Daily calibration of METAR cloud cover blend weights.

For each lead-hour bucket (0–1h, 1–3h, 3–6h) we find the blend weight w
that minimises MAE over a rolling 30-day window:

    blended = w * metar_at_issue + (1-w) * ensemble_cloud
    target  = metar_at_valid_for   (the actual cloud cover at that time)

Grid-searches w ∈ {0.00, 0.05, …, 1.00} and writes the best value to
MetarBlendConfig.  Falls back to hard-coded defaults when fewer than
MIN_SAMPLES pairs are available (bootstrap period ≈ first 30 days).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

MIN_SAMPLES     = 100     # don't calibrate until we have this many pairs per bucket
WINDOW_DAYS     = 30
GRID_STEPS      = 20      # weight resolution: 0, 0.05, 0.10 … 1.00
LEAD_BUCKETS    = [1, 3, 6]   # hours — must match METAR_CLOUD_WEIGHT keys

# Tolerance for matching METAR timestamps to EnsembleForecast valid_for (seconds)
_MATCH_TOL = 45 * 60


def _round_to_hour(dt: datetime) -> datetime:
    """Round a naive UTC datetime to the nearest hour."""
    if dt.minute >= 30:
        return dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return dt.replace(minute=0, second=0, microsecond=0)


def _grid_search_weight(pairs: list[tuple[float, float, float]]) -> tuple[float, float]:
    """
    Find w ∈ [0,1] minimising MAE(w*m + (1-w)*e, actual).
    Returns (best_weight, best_mae).
    pairs: [(metar_at_issue, ensemble_cloud, actual_metar), ...]
    """
    best_w, best_mae = 0.5, float("inf")
    for i in range(GRID_STEPS + 1):
        w = i / GRID_STEPS
        mae = sum(abs(w * m + (1 - w) * e - a) for m, e, a in pairs) / len(pairs)
        if mae < best_mae:
            best_mae, best_w = mae, w
    return best_w, best_mae


def calibrate_metar_weights(db: Session) -> Optional[dict[int, dict]]:
    """
    Run calibration over the last WINDOW_DAYS days.
    Returns dict {lead_bucket: {weight, sample_count, mae}} or None if not enough data.
    Writes results to MetarBlendConfig table.
    """
    from app.models import MetarObservation, EnsembleForecast, MetarBlendConfig

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    since = now - timedelta(days=WINDOW_DAYS)

    # Load all METAR observations in the window — these are both "truths" and "inputs"
    metar_rows = (
        db.query(MetarObservation)
        .filter(MetarObservation.observed_at >= since)
        .order_by(MetarObservation.observed_at)
        .all()
    )
    if len(metar_rows) < MIN_SAMPLES:
        logger.info("METAR calibration skipped: only %d observations (need %d)",
                    len(metar_rows), MIN_SAMPLES)
        return None

    # Index METAR by rounded hour for fast lookup
    metar_by_hour: dict[datetime, float] = {}
    for row in metar_rows:
        h = _round_to_hour(row.observed_at)
        metar_by_hour[h] = row.cloud_cover  # last value wins on collision

    # Load ensemble forecasts in the window — group by valid_for, keep latest computed_at
    ens_rows = (
        db.query(EnsembleForecast)
        .filter(
            EnsembleForecast.valid_for >= since,
            EnsembleForecast.cloud_cover.isnot(None),
        )
        .order_by(EnsembleForecast.valid_for, EnsembleForecast.computed_at.desc())
        .all()
    )
    # Keep only the most-recently-computed forecast per valid_for hour
    ens_by_hour: dict[datetime, float] = {}
    for row in ens_rows:
        h = _round_to_hour(row.valid_for)
        if h not in ens_by_hour:
            ens_by_hour[h] = row.cloud_cover

    results = {}
    for lead in LEAD_BUCKETS:
        pairs: list[tuple[float, float, float]] = []

        for obs_hour, actual_cloud in metar_by_hour.items():
            # The METAR that was available when we issued the forecast
            issue_hour = obs_hour - timedelta(hours=lead)
            metar_at_issue = metar_by_hour.get(issue_hour)
            ensemble_cloud = ens_by_hour.get(obs_hour)

            if metar_at_issue is None or ensemble_cloud is None:
                continue
            pairs.append((metar_at_issue, ensemble_cloud, actual_cloud))

        if len(pairs) < MIN_SAMPLES:
            logger.info("METAR calibration: bucket %dh has %d pairs (need %d), keeping default",
                        lead, len(pairs), MIN_SAMPLES)
            continue

        best_w, best_mae = _grid_search_weight(pairs)
        results[lead] = {"weight": best_w, "sample_count": len(pairs), "mae": best_mae}

        # Upsert into MetarBlendConfig
        existing = db.query(MetarBlendConfig).filter(
            MetarBlendConfig.lead_bucket == lead
        ).first()
        if existing:
            existing.weight       = best_w
            existing.calibrated_at = now
            existing.sample_count = len(pairs)
            existing.mae          = best_mae
        else:
            db.add(MetarBlendConfig(
                lead_bucket=lead,
                weight=best_w,
                calibrated_at=now,
                sample_count=len(pairs),
                mae=best_mae,
            ))
        db.commit()

        logger.info(
            "METAR calibration: bucket %dh → w=%.2f (MAE=%.1f%%, n=%d)",
            lead, best_w, best_mae, len(pairs),
        )

    return results or None
