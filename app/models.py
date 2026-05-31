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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
