import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./weather.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401
    from sqlalchemy import text
    Base.metadata.create_all(bind=engine)
    # Non-destructive migration: add new columns if they don't exist
    new_cols = [
        ("forecasts", "wind_direction", "FLOAT"),
        ("forecasts", "precip_mm", "FLOAT"),
        ("ensemble_forecasts", "wind_direction", "FLOAT"),
        ("ensemble_forecasts", "precip_mm", "FLOAT"),
    ]
    with engine.connect() as conn:
        for table, col, col_type in new_cols:
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
                conn.commit()
            except Exception:
                pass  # column already exists
