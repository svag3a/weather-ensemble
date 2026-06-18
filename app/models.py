from datetime import datetime, date
from sqlalchemy import Float, Integer, String, DateTime, Date, UniqueConstraint, Text, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from typing import Optional
from app.database import Base


class Forecast(Base):
    """One source's forecast for a specific valid_time, issued at a specific time."""
    __tablename__ = "forecasts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String, index=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    valid_for: Mapped[datetime] = mapped_column(DateTime, index=True)
    lead_hours: Mapped[int] = mapped_column(Integer, index=True)
    temperature: Mapped[float] = mapped_column(Float)
    precip_probability: Mapped[float] = mapped_column(Float)
    wind_speed: Mapped[float] = mapped_column(Float, nullable=True)
    cloud_cover: Mapped[float] = mapped_column(Float, nullable=True)
    wind_direction: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    precip_mm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fog_probability: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pressure: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    __table_args__ = (
        UniqueConstraint("source", "issued_at", "valid_for", name="uq_forecast"),
    )


class SourceWeight(Base):
    """Rolling MAE, bias and derived weight per source and lead-time bucket."""
    __tablename__ = "source_weights"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String, index=True)
    lead_hours: Mapped[int] = mapped_column(Integer, index=True)
    mae_temperature: Mapped[float] = mapped_column(Float, default=1.0)
    mae_precip: Mapped[float] = mapped_column(Float, default=1.0)
    mae_wind: Mapped[float] = mapped_column(Float, default=1.0)
    mae_cloud: Mapped[float] = mapped_column(Float, default=1.0)
    # Signed bias: positive = source runs too warm/fast, negative = too cold/slow
    bias_temperature: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=0.0)
    bias_wind: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=0.0)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Auto-exclusion fields
    excluded: Mapped[bool] = mapped_column(Boolean, default=False)
    excluded_reason: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    excluded_since: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    manual_override: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (
        UniqueConstraint("source", "lead_hours", name="uq_weight"),
    )


class EnsembleForecast(Base):
    """The app's own weighted ensemble forecast."""
    __tablename__ = "ensemble_forecasts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    valid_for: Mapped[datetime] = mapped_column(DateTime, index=True)
    lead_hours: Mapped[int] = mapped_column(Integer)
    temperature: Mapped[float] = mapped_column(Float)
    precip_probability: Mapped[float] = mapped_column(Float)
    wind_speed: Mapped[float] = mapped_column(Float, nullable=True)
    cloud_cover: Mapped[float] = mapped_column(Float, nullable=True)
    wind_direction: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    precip_mm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fog_probability: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pressure: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    __table_args__ = (
        UniqueConstraint("computed_at", "valid_for", name="uq_ensemble"),
    )


class Observation(Base):
    """Actual weather observations from SMHI station Göteborg A (71420)."""
    __tablename__ = "observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    valid_for: Mapped[datetime] = mapped_column(DateTime, unique=True, index=True)
    temperature: Mapped[float] = mapped_column(Float)
    wind_speed: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    precip_mm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)


class MetarObservation(Base):
    """Cloud cover observations from METAR at Göteborg-Landvetter (ESGG).
    Stored hourly for blend-weight calibration."""
    __tablename__ = "metar_observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, unique=True, index=True)
    cloud_cover: Mapped[float] = mapped_column(Float)
    raw_metar: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    stored_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class MetarBlendConfig(Base):
    """Calibrated METAR blend weights per lead-hour bucket (1, 3, 6).
    Updated daily by the calibration job once ≥100 observations exist."""
    __tablename__ = "metar_blend_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lead_bucket: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    weight: Mapped[float] = mapped_column(Float)
    calibrated_at: Mapped[datetime] = mapped_column(DateTime)
    sample_count: Mapped[int] = mapped_column(Integer)
    mae: Mapped[Optional[float]] = mapped_column(Float, nullable=True)


class AiSummary(Base):
    __tablename__ = "ai_summaries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    valid_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    period: Mapped[str] = mapped_column(String, nullable=False)  # "today" or "tomorrow"
    payload: Mapped[str] = mapped_column(Text, nullable=False)   # JSON string

    __table_args__ = (
        UniqueConstraint("valid_date", "period", name="uq_ai_summary"),
    )


class SourceWeightHistory(Base):
    """Daily snapshot of source MAE values for trend visualisation."""
    __tablename__ = "source_weight_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    snapshot_date: Mapped[date] = mapped_column(Date, index=True)
    source: Mapped[str] = mapped_column(String, index=True)
    lead_hours: Mapped[int] = mapped_column(Integer)
    mae_temperature: Mapped[float] = mapped_column(Float)
    mae_precip: Mapped[float] = mapped_column(Float)
    mae_wind: Mapped[float] = mapped_column(Float)
    mae_cloud: Mapped[float] = mapped_column(Float)
    sample_count: Mapped[int] = mapped_column(Integer)

    __table_args__ = (
        UniqueConstraint("snapshot_date", "source", "lead_hours", name="uq_weight_history"),
    )


class CityImage(Base):
    __tablename__ = "city_images"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    filename: Mapped[str] = mapped_column(String, unique=True)
    label: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    time_slot: Mapped[Optional[str]] = mapped_column(String, default="day")  # night|morning|day|evening
    image_type: Mapped[str] = mapped_column(String, default="background")  # background|motif
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SunTerrace(Base):
    __tablename__ = "sun_terraces"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String, default="osm")
    source_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    amenity_type: Mapped[str] = mapped_column(String)  # restaurant/cafe/bar/pub
    address: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    website: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    outdoor_seating: Mapped[bool] = mapped_column(Boolean, default=True)
    outdoor_type: Mapped[str] = mapped_column(String, default="unknown")  # unknown/terrace/rooftop/none
    street_orientation: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # N/NE/E/SE/S/SW/W/NW/UNKNOWN
    orientation_confidence: Mapped[float] = mapped_column(Float, default=0.3)
    polygon_coords: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # JSON [[lat,lon],...]
    sun_arc_from: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sun_arc_to:   Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    shadow_buildings_json: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # JSON [{h,p},...] nearby buildings
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TerraceReport(Base):
    __tablename__ = "terrace_reports"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    terrace_id: Mapped[int] = mapped_column(Integer, index=True)
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    user_lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    user_lon: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    feedback: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # JSON: {issues:[...], comment:""}
    status:   Mapped[str] = mapped_column(String, default="pending")         # pending/in_progress/resolved/dismissed


class Hashtag(Base):
    __tablename__ = "hashtags"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String, unique=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TerraceHashtag(Base):
    __tablename__ = "terrace_hashtags"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    terrace_id: Mapped[int] = mapped_column(Integer, index=True)
    hashtag_id: Mapped[int] = mapped_column(Integer, index=True)
    count: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("terrace_id", "hashtag_id", name="uq_terrace_hashtag"),)
