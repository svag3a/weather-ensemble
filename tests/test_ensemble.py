from datetime import datetime, timezone, timedelta
import pytest
from app.models import Forecast, SourceWeight, EnsembleForecast, Observation
from app.ensemble import compute_consensus_1h, update_weights, build_ensemble, ALPHA
from app.sources.base import HourlyForecast

NOW = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
NEXT_HOUR = NOW + timedelta(hours=1)


def _add_forecast(db, source, issued_at, valid_for, lead_hours, temp, precip):
    db.add(Forecast(
        source=source,
        issued_at=issued_at,
        valid_for=valid_for,
        lead_hours=lead_hours,
        temperature=temp,
        precip_probability=precip,
    ))
    db.commit()


class TestConsensus1h:
    def test_returns_none_when_no_data(self, db):
        assert compute_consensus_1h(db, NOW) is None

    def test_returns_none_with_only_one_source(self, db):
        _add_forecast(db, "smhi", NOW - timedelta(hours=1), NOW, 1, 15.0, 10.0)
        assert compute_consensus_1h(db, NOW) is None

    def test_averages_two_sources(self, db):
        _add_forecast(db, "smhi", NOW - timedelta(hours=1), NOW, 1, 14.0, 20.0)
        _add_forecast(db, "yr", NOW - timedelta(hours=1), NOW, 1, 16.0, 40.0)
        result = compute_consensus_1h(db, NOW)
        assert result is not None
        assert result["temperature"] == pytest.approx(15.0)
        assert result["precip_probability"] == pytest.approx(30.0)

    def test_ignores_non_1h_forecasts(self, db):
        _add_forecast(db, "smhi", NOW - timedelta(hours=6), NOW, 6, 14.0, 20.0)
        _add_forecast(db, "yr", NOW - timedelta(hours=6), NOW, 6, 16.0, 40.0)
        assert compute_consensus_1h(db, NOW) is None


def _add_observation(db, valid_for, temperature, wind_speed=None, precip_mm=None):
    db.add(Observation(valid_for=valid_for, temperature=temperature,
                       wind_speed=wind_speed, precip_mm=precip_mm))
    db.commit()


class TestUpdateWeights:
    def test_creates_weight_row_on_first_update(self, db):
        # Real SMHI observation as truth (consensus fallback removed)
        _add_observation(db, NOW, temperature=15.0, precip_mm=0.0)
        # 6h forecast to be evaluated
        _add_forecast(db, "smhi", NOW - timedelta(hours=6), NOW, 6, 13.0, 10.0)

        update_weights(db, NOW)

        row = db.query(SourceWeight).filter_by(source="smhi", lead_hours=6).first()
        assert row is not None
        assert row.sample_count == 1
        expected_mae_t = ALPHA * abs(13.0 - 15.0) + (1 - ALPHA) * 1.0
        assert row.mae_temperature == pytest.approx(expected_mae_t)
        # precip Brier: (10/100 - 0.0)^2 = 0.01
        expected_brier = ALPHA * (10.0 / 100.0 - 0.0) ** 2 + (1 - ALPHA) * 1.0
        assert row.mae_precip == pytest.approx(expected_brier)

    def test_skips_update_without_observation(self, db):
        # No observation → _get_truth returns None → no weight update
        _add_forecast(db, "smhi", NOW - timedelta(hours=6), NOW, 6, 13.0, 10.0)
        update_weights(db, NOW)
        assert db.query(SourceWeight).count() == 0


class TestBuildEnsemble:
    def _make_forecasts(self, sources_data):
        result = {}
        for source, hours, temp, precip in sources_data:
            valid_for = NOW + timedelta(hours=hours)
            result.setdefault(source, []).append(
                HourlyForecast(valid_for=valid_for, temperature=temp, precip_probability=precip)
            )
        return result

    def test_equal_weights_when_no_history(self, db):
        fc = self._make_forecasts([
            ("smhi", 6, 14.0, 20.0),
            ("yr", 6, 16.0, 40.0),
        ])
        build_ensemble(db, NOW, fc)

        row = db.query(EnsembleForecast).first()
        assert row is not None
        assert row.temperature == pytest.approx(15.0)
        assert row.precip_probability == pytest.approx(30.0)

    def test_weighted_by_inverse_mae(self, db):
        # smhi and yr are each in their own SOURCE_GROUP, so independence_scale
        # gives them equal total weight (1/2 each) regardless of individual MAE.
        db.add(SourceWeight(source="smhi", lead_hours=6, mae_temperature=0.5, mae_precip=5.0, sample_count=10))
        db.add(SourceWeight(source="yr", lead_hours=6, mae_temperature=2.0, mae_precip=5.0, sample_count=10))
        db.commit()

        fc = self._make_forecasts([
            ("smhi", 6, 14.0, 20.0),
            ("yr", 6, 18.0, 20.0),
        ])
        build_ensemble(db, NOW, fc)

        row = db.query(EnsembleForecast).first()
        # Two distinct groups → each gets 0.5 weight → equal-weighted average
        expected = 14.0 * 0.5 + 18.0 * 0.5
        assert row.temperature == pytest.approx(expected, rel=0.01)

    def test_does_not_duplicate_on_second_call(self, db):
        fc = self._make_forecasts([("smhi", 6, 14.0, 20.0), ("yr", 6, 16.0, 40.0)])
        build_ensemble(db, NOW, fc)
        build_ensemble(db, NOW, fc)
        assert db.query(EnsembleForecast).count() == 1
