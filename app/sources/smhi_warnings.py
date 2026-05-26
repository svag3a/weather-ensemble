"""
SMHI Impact-Based Weather Warnings (IBW) for Västra Götalands län (county id=14).
API docs: https://opendata.smhi.se/apidocs/IBWwarnings/
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import httpx

_URL = "https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json"

# County id for Västra Götalands län
_COUNTY_ID = 14

# Map warning level codes to sortable severity (higher = more severe)
_LEVEL_SEVERITY = {
    "Red":       3,
    "Orange":    2,
    "Yellow":    1,
    "Meddelande": 0,
}

_LEVEL_LABEL = {
    "Red":        "Röd varning",
    "Orange":     "Orange varning",
    "Yellow":     "Gul varning",
    "Meddelande": "Meddelande",
}


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _affects_county(warning: dict, county_id: int) -> bool:
    for wa in warning.get("warningAreas", []):
        for area in wa.get("affectedAreas", []):
            if area.get("id") == county_id:
                return True
    return False


async def fetch_warnings(client: httpx.AsyncClient) -> list[dict]:
    """
    Return active warnings for Västra Götalands län, sorted by severity (highest first).
    Each dict has: event, level_code, level_label, severity, start, end, description
    """
    response = await client.get(_URL, timeout=10)
    response.raise_for_status()
    data = response.json()

    now = datetime.now(timezone.utc)
    results = []

    for warning in data:
        if not _affects_county(warning, _COUNTY_ID):
            continue

        event_sv = warning.get("event", {}).get("sv", "Okänd händelse")

        for wa in warning.get("warningAreas", []):
            # Only include if this specific area covers county 14
            if not any(a.get("id") == _COUNTY_ID for a in wa.get("affectedAreas", [])):
                continue

            start = _parse_dt(wa.get("approximateStart"))
            end   = _parse_dt(wa.get("approximateEnd"))

            # Skip if already expired
            if end and end < now:
                continue

            level_code  = wa.get("warningLevel", {}).get("code", "Meddelande")
            level_label = _LEVEL_LABEL.get(level_code, level_code)
            severity    = _LEVEL_SEVERITY.get(level_code, 0)

            # Pick first non-empty Swedish description
            description = None
            for desc in wa.get("descriptions", []) + warning.get("descriptions", []):
                text = desc.get("text", {}).get("sv") or desc.get("sv", "")
                if text:
                    description = text
                    break

            results.append({
                "event":       event_sv,
                "level_code":  level_code,
                "level_label": level_label,
                "severity":    severity,
                "start":       start.isoformat() if start else None,
                "end":         end.isoformat()   if end   else None,
                "description": description,
            })

    # Highest severity first
    results.sort(key=lambda x: x["severity"], reverse=True)
    return results
