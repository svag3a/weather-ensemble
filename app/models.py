from datetime import datetime
from sqlalchemy import Float, Integer, String, DateTime, UniqueConstraint
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

    __table_args__ = (
        UniqueConstraint("source", "issued_at", "valid_for", name="uq_forecast"),
    )


class SourceWeight(Base):
    """Rolling MAE and derived weight per source and lead-time bucket."""
    __tablename__ = "source_weights"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String, index=True)
    lead_hours: Mapped[int] = mapped_column(Integer, index=True)
    mae_temperature: Mapped[float] = mapped_column(Float, default=1.0)
    mae_precip: Mapped[float] = mapped_column(Float, default=1.0)
    mae_wind: Mapped[float] = mapped_column(Float, default=1.0)
    mae_cloud: Mapped[float] = mapped_column(Float, default=1.0)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

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
