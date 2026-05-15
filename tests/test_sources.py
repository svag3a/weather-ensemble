"""
Unit tests for source parsers using mocked HTTP responses.
Tests verify that each source correctly parses its API response format.
"""
import pytest
import pytest_asyncio
import httpx
from pytest_httpx import HTTPXMock
from datetime import datetime, timezone

from app.sources import smhi, yr, open_meteo, openweathermap


SMHI_RESPONSE = {
    "timeSeries": [
        {
            "validTime": "2025-06-01T13:00:00Z",
            "parameters": [
                {"name": "t", "values": [17.3]},
                {"name": "pcat", "values": [0]},
                {"name": "pmean", "values": [0.0]},
            ],
        },
        {
            "validTime": "2025-06-01T14:00:00Z",
            "parameters": [
                {"name": "t", "values": [15.0]},
                {"name": "pcat", "values": [3]},
                {"name": "pmean", "values": [1.5]},
            ],
        },
    ]
}

YR_RESPONSE = {
    "properties": {
        "timeseries": [
            {
                "time": "2025-06-01T13:00:00Z",
                "data": {
                    "instant": {"details": {"air_temperature": 17.3}},
                    "next_1_hours": {"details": {"probability_of_precipitation": 10.0}},
                },
            }
        ]
    }
}

OPEN_METEO_RESPONSE = {
    "hourly": {
        "time": ["2025-06-01T13:00", "2025-06-01T14:00"],
        "temperature_2m": [17.3, 15.0],
        "precipitation_probability": [5, 60],
    }
}

OPENWEATHERMAP_RESPONSE = {
    "list": [
        {
            "dt": 1748782800,  # 2025-06-01T13:00:00Z
            "main": {"temp": 17.3},
            "pop": 0.1,
        }
    ]
}


@pytest.mark.asyncio
async def test_smhi_parses_temperature(httpx_mock: HTTPXMock):
    httpx_mock.add_response(json=SMHI_RESPONSE)
    async with httpx.AsyncClient() as client:
        results = await smhi.fetch(client)
    assert len(results) == 2
    assert results[0].temperature == pytest.approx(17.3)
    assert results[0].precip_probability == pytest.approx(0.0)
    assert results[0].valid_for == datetime(2025, 6, 1, 13, 0, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_smhi_non_zero_precip(httpx_mock: HTTPXMock):
    httpx_mock.add_response(json=SMHI_RESPONSE)
    async with httpx.AsyncClient() as client:
        results = await smhi.fetch(client)
    assert results[1].precip_probability > 0.0


@pytest.mark.asyncio
async def test_yr_parses_response(httpx_mock: HTTPXMock):
    httpx_mock.add_response(json=YR_RESPONSE)
    async with httpx.AsyncClient() as client:
        results = await yr.fetch(client)
    assert len(results) == 1
    assert results[0].temperature == pytest.approx(17.3)
    assert results[0].precip_probability == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_open_meteo_parses_response(httpx_mock: HTTPXMock):
    httpx_mock.add_response(json=OPEN_METEO_RESPONSE)
    async with httpx.AsyncClient() as client:
        results = await open_meteo.fetch(client)
    assert len(results) == 2
    assert results[0].temperature == pytest.approx(17.3)
    assert results[1].precip_probability == pytest.approx(60.0)


@pytest.mark.asyncio
async def test_openweathermap_scales_pop(httpx_mock: HTTPXMock, monkeypatch):
    monkeypatch.setenv("OPENWEATHERMAP_API_KEY", "test_key")
    httpx_mock.add_response(json=OPENWEATHERMAP_RESPONSE)
    async with httpx.AsyncClient() as client:
        results = await openweathermap.fetch(client)
    assert len(results) == 1
    assert results[0].precip_probability == pytest.approx(10.0)  # 0.1 * 100


@pytest.mark.asyncio
async def test_openweathermap_raises_without_api_key(monkeypatch):
    monkeypatch.delenv("OPENWEATHERMAP_API_KEY", raising=False)
    async with httpx.AsyncClient() as client:
        with pytest.raises(ValueError, match="OPENWEATHERMAP_API_KEY"):
            await openweathermap.fetch(client)
