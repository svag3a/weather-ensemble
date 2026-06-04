"""
AI-generated weather summaries using Claude Haiku.
Pre-computes weather events and model spread before calling the LLM.
Caches summaries for 2 hours to control API costs.
"""
from __future__ import annotations

import json
import os
import logging
from datetime import datetime, timezone, date
from typing import Optional
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_CACHE_TTL_HOURS = 1.1    # 66 min — slightly longer than scheduler interval (60 min)

# Stockholm timezone for correct "today/tomorrow" day boundaries
from zoneinfo import ZoneInfo
_STOCKHOLM = ZoneInfo("Europe/Stockholm")

_SYSTEM_PROMPT = """Du är en meteorolog som skriver vädersammanfattningar för Göteborg på svenska.

REGLER:
1. Beskriv ENDAST mönster som finns i datan — spekulera inte
2. Nämn osäkerhet explicit när confidence är medium eller low
3. Inga exakta klocktider i texten — skriv "tidig eftermiddag", "mot kvällen"
4. Naturligt, levande svenska — inte tabelluppläsning av siffror
5. practical_advice.tips: lägg bara till om det faktiskt är ovanligt eller kräver agerande
6. Returnera EXAKT JSON-strukturen nedan — inget annat, ingen kommentar, inga kodblock
7. Använd ENBART vanliga, korrekta svenska ord — inga påhittade sammansättningar, kontrollera stavning
8. Veckodagsnamnet finns i fältet "weekday" — använd exakt det ordet, räkna aldrig ut veckodagen själv

OUTPUT-SCHEMA:
{
  "summary": {
    "headline": "kortfattad rubrik max 8 ord",
    "short": "1-2 meningar för snabböversikt",
    "detailed": "2-4 meningar med fullständig beskrivning"
  },
  "confidence": {
    "level": "high|medium|low",
    "score": 0.0,
    "reason": "1 mening om varför osäkerheten är som den är",
    "drivers": {
      "temperature": "high|medium|low",
      "precipitation": "high|medium|low",
      "wind": "high|medium|low",
      "clouds": "high|medium|low"
    }
  },
  "key_events": [
    {
      "type": "rain_window|wind_event|clearing|temperature_drop|heat",
      "title": "kort titel",
      "from": "HH:00",
      "to": "HH:00",
      "severity": "low|medium|high",
      "confidence": "low|medium|high",
      "description": "1 mening"
    }
  ],
  "periods": [
    {
      "name": "periodnamn",
      "from": "HH:00",
      "to": "HH:00",
      "description": "1 mening",
      "confidence": "high|medium|low"
    }
  ],
  "insights": [
    {
      "title": "kort titel",
      "description": "1-2 meningar"
    }
  ],
  "practical_advice": {
    "main": "1 konkret mening",
    "tips": []
  },
  "ui": {
    "hero_badge": "2-4 ord",
    "alert_level": "none|watch|warning|alert"
  }
}"""


def _confidence_label(score: float) -> str:
    if score >= 0.75: return "high"
    if score >= 0.50: return "medium"
    return "low"


def _detect_rain_windows(hours: list, threshold: int = 50) -> list:
    windows, start, max_prob = [], None, 0
    for h in hours:
        prob = h["precip_probability"] or 0
        t = h["valid_for"]
        if prob >= threshold:
            if start is None:
                start, max_prob = t, prob
            else:
                max_prob = max(max_prob, prob)
        elif start is not None:
            windows.append({"type": "rain_window", "from": start.strftime("%H:%M"),
                            "to": t.strftime("%H:%M"), "max_probability": round(max_prob)})
            start = None
    if start is not None and hours:
        windows.append({"type": "rain_window", "from": start.strftime("%H:%M"),
                        "to": hours[-1]["valid_for"].strftime("%H:%M"), "max_probability": round(max_prob)})
    return windows


def _detect_wind_events(hours: list, threshold: float = 10.0) -> list:
    events, start, max_wind = [], None, 0.0
    for h in hours:
        w = h["wind_speed"] or 0
        t = h["valid_for"]
        if w >= threshold:
            if start is None:
                start, max_wind = t, w
            else:
                max_wind = max(max_wind, w)
        elif start is not None:
            events.append({"type": "wind_event", "from": start.strftime("%H:%M"),
                           "to": t.strftime("%H:%M"), "max_wind": round(max_wind, 1)})
            start = None
    return events


def _build_periods(hours: list) -> list:
    defs = [("Natt", 0, 6), ("Förmiddag", 6, 12), ("Eftermiddag", 12, 17), ("Kväll", 17, 24)]
    result = []
    for name, hf, ht in defs:
        ph = [h for h in hours if hf <= h["valid_for"].hour < ht]
        if not ph:
            continue
        temps  = [h["temperature"] for h in ph if h["temperature"] is not None]
        precips = [h["precip_probability"] or 0 for h in ph]
        winds  = [h["wind_speed"] or 0 for h in ph]
        confs  = [h["confidence"] or 0.5 for h in ph]
        result.append({
            "name": name,
            "from": f"{hf:02d}:00",
            "to":   f"{ht:02d}:00",
            "temp_min":   round(min(temps)) if temps else None,
            "temp_max":   round(max(temps)) if temps else None,
            "precip_max": round(max(precips)) if precips else 0,
            "wind_max":   round(max(winds), 1) if winds else 0,
        })
    return result


def _hours_for_date(db: Session, target_date: date) -> list:
    from app.models import EnsembleForecast
    latest_run = (
        db.query(EnsembleForecast.computed_at)
        .order_by(EnsembleForecast.computed_at.desc())
        .first()
    )
    if not latest_run:
        return []
    rows = db.query(EnsembleForecast).filter(
        EnsembleForecast.computed_at == latest_run[0]
    ).all()
    return [
        {"valid_for": r.valid_for, "temperature": r.temperature,
         "precip_probability": r.precip_probability, "wind_speed": r.wind_speed,
         "cloud_cover": r.cloud_cover, "precip_mm": r.precip_mm, "confidence": r.confidence}
        for r in rows
        # valid_for is stored as naive UTC — convert to Stockholm local time before comparing dates
        if r.valid_for.replace(tzinfo=timezone.utc).astimezone(_STOCKHOLM).date() == target_date
    ]


def _source_spread_for_date(db: Session, target_date: date) -> dict:
    from app.models import Forecast
    from sqlalchemy import func
    latest_per_source = (
        db.query(Forecast.source, func.max(Forecast.issued_at).label("latest"))
        .filter(Forecast.source.not_in(["ensemble", "radar_nowcast"]))
        .group_by(Forecast.source)
        .all()
    )
    all_temps, all_precips, all_winds = [], [], []
    for source, latest in latest_per_source:
        rows = db.query(Forecast).filter(
            Forecast.source == source, Forecast.issued_at == latest
        ).all()
        day_rows = [r for r in rows if r.valid_for.date() == target_date]
        all_temps.extend([r.temperature for r in day_rows if r.temperature is not None])
        all_precips.extend([r.precip_probability for r in day_rows])
        all_winds.extend([r.wind_speed for r in day_rows if r.wind_speed is not None])

    def spread(vals):
        return round(max(vals) - min(vals), 1) if len(vals) >= 2 else 0.0

    temp_s = spread(all_temps)
    def spread_conf(val, hi, lo):
        return "high" if val <= hi else ("medium" if val <= lo else "low")

    return {
        "temperature": temp_s,
        "precipitation": spread(all_precips),
        "wind": spread(all_winds),
        "temperature_confidence": spread_conf(temp_s, 1.5, 3.0),
        "precipitation_confidence": spread_conf(spread(all_precips), 20, 40),
        "wind_confidence": spread_conf(spread(all_winds), 2.0, 5.0),
    }


async def generate_summary(db: Session, target_date: date, period: str) -> Optional[dict]:
    """Return cached or freshly generated AI summary for target_date."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    from app.models import AiSummary
    now = datetime.now(timezone.utc)

    # Check cache
    cached = db.query(AiSummary).filter(
        AiSummary.valid_date == target_date,
        AiSummary.period == period,
    ).first()
    if cached:
        age_h = (now - cached.generated_at.replace(tzinfo=timezone.utc)).total_seconds() / 3600
        if age_h < _CACHE_TTL_HOURS:
            data = json.loads(cached.payload)
            data["_generated_at"] = cached.generated_at.isoformat()
            return data

    # Build input
    hours = _hours_for_date(db, target_date)
    if not hours:
        return None

    spread = _source_spread_for_date(db, target_date)
    temps = [h["temperature"] for h in hours if h["temperature"] is not None]
    confs = [h["confidence"] or 0.5 for h in hours]

    _WEEKDAYS_SV = ["måndag","tisdag","onsdag","torsdag","fredag","lördag","söndag"]
    weekday_sv = _WEEKDAYS_SV[target_date.weekday()]

    input_data = {
        "location": "Göteborg",
        "date": target_date.isoformat(),
        "weekday": weekday_sv,   # explicit — do not infer day name from the date
        "confidence_score": round(sum(confs) / len(confs), 2) if confs else 0.5,
        "confidence_per_parameter": {
            "temperature": spread["temperature_confidence"],
            "precipitation": spread["precipitation_confidence"],
            "wind": spread["wind_confidence"],
            "clouds": "medium",
        },
        "temperature": {
            "min": round(min(temps)) if temps else None,
            "max": round(max(temps)) if temps else None,
        },
        "detected_events": _detect_rain_windows(hours) + _detect_wind_events(hours),
        "periods": _build_periods(hours),
        "source_spread": {
            "temperature_deg": spread["temperature"],
            "precipitation_pct": spread["precipitation"],
            "wind_ms": spread["wind"],
        },
    }

    # Call Claude Haiku
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=api_key)
        message = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1500,
            temperature=0.2,
            system=_SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": (
                    f"Generera vädersammanfattning för denna data:\n\n"
                    f"{json.dumps(input_data, ensure_ascii=False, indent=2)}"
                ),
            }],
        )
        raw = message.content[0].text.strip()
        # Strip markdown fences if model adds them
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
            if raw.endswith("```"):
                raw = raw[:-3]
        payload = json.loads(raw)
    except Exception as exc:
        logger.warning("AI summary generation failed: %s", exc)
        return None

    # Cache
    generated_at = now.replace(tzinfo=None)
    if cached:
        cached.generated_at = generated_at
        cached.payload = json.dumps(payload, ensure_ascii=False)
    else:
        db.add(AiSummary(
            generated_at=generated_at,
            valid_date=target_date,
            period=period,
            payload=json.dumps(payload, ensure_ascii=False),
        ))
    db.commit()
    payload["_generated_at"] = generated_at.isoformat()
    return payload
