"""
Opening hours enrichment via Google Places API.

Two-step for OSM venues:
  1. Find Place by name + location → get place_id
  2. Place Details with fields=opening_hours → store periods JSON

Google-imported venues (source_id starts with "google_") skip step 1.
"""
from __future__ import annotations

import os
import json
import logging
import asyncio
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

GOOGLE_API_KEY   = os.getenv("GOOGLE_PLACES_API_KEY", "")
_FIND_URL        = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"
_DETAILS_URL     = "https://maps.googleapis.com/maps/api/place/details/json"
_STOCKHOLM       = ZoneInfo("Europe/Stockholm")
BATCH_SIZE       = 10
COMMIT_EVERY     = 50

_opening_hours_state: dict = {
    "running": False, "total": 0, "done": 0, "updated": 0, "skipped": 0,
    "phase": "", "started_at": None, "finished_at": None, "error": None,
}


def get_opening_hours_state() -> dict:
    return dict(_opening_hours_state)


# ── Open-now helper ────────────────────────────────────────────────────────────

def is_open_now(opening_hours_json: str | None) -> bool | None:
    """Return True/False if venue is currently open, None if no data."""
    if not opening_hours_json:
        return None
    try:
        data = json.loads(opening_hours_json)
        periods = data.get("periods")
        if not periods:
            return None

        now = datetime.now(_STOCKHOLM)
        # Google day: 0=Sunday … 6=Saturday
        # Python weekday: 0=Monday … 6=Sunday → convert
        py_day = now.weekday()
        google_day = (py_day + 1) % 7
        now_time = now.hour * 100 + now.minute  # as HHMM int

        for p in periods:
            o = p.get("open", {})
            c = p.get("close")
            if o.get("day") != google_day:
                continue
            open_t = int(o.get("time", "0000"))
            if c is None:
                # open 24h
                return True
            close_t = int(c.get("time", "0000"))
            close_day = c.get("day", google_day)
            if close_day == google_day:
                if open_t <= now_time < close_t:
                    return True
            else:
                # closes next day
                if now_time >= open_t:
                    return True
        return False
    except Exception:
        return None


def opening_hours_today(opening_hours_json: str | None) -> str | None:
    """Return e.g. '11:00–22:00' for today's hours, or None."""
    if not opening_hours_json:
        return None
    try:
        data = json.loads(opening_hours_json)
        periods = data.get("periods")
        if not periods:
            return None
        now = datetime.now(_STOCKHOLM)
        py_day = now.weekday()
        google_day = (py_day + 1) % 7
        for p in periods:
            o = p.get("open", {})
            c = p.get("close")
            if o.get("day") != google_day:
                continue
            open_t = o.get("time", "")
            if len(open_t) == 4:
                open_fmt = f"{open_t[:2]}:{open_t[2:]}"
            else:
                open_fmt = open_t
            if c is None:
                return f"{open_fmt}–"
            close_t = c.get("time", "")
            if len(close_t) == 4:
                close_fmt = f"{close_t[:2]}:{close_t[2:]}"
            else:
                close_fmt = close_t
            return f"{open_fmt}–{close_fmt}"
        return None
    except Exception:
        return None


# ── Sync fetchers (run in threads) ────────────────────────────────────────────

def _find_place_id_sync(name: str, lat: float, lon: float) -> str | None:
    """Find Google place_id for a venue by name + location."""
    import httpx as _httpx
    try:
        with _httpx.Client(timeout=10) as client:
            resp = client.get(_FIND_URL, params={
                "input": name,
                "inputtype": "textquery",
                "locationbias": f"circle:200@{lat},{lon}",
                "fields": "place_id",
                "key": GOOGLE_API_KEY,
            })
        if resp.status_code == 200:
            data = resp.json()
            candidates = data.get("candidates", [])
            if candidates:
                return candidates[0].get("place_id")
    except Exception as exc:
        logger.warning("Find Place failed for %s: %s", name, exc)
    return None


def _fetch_opening_hours_sync(place_id: str) -> dict | None:
    """Fetch opening_hours periods from Place Details API."""
    import httpx as _httpx
    try:
        with _httpx.Client(timeout=10) as client:
            resp = client.get(_DETAILS_URL, params={
                "place_id": place_id,
                "fields": "opening_hours",
                "key": GOOGLE_API_KEY,
            })
        if resp.status_code == 200:
            result = resp.json().get("result", {})
            oh = result.get("opening_hours", {})
            periods = oh.get("periods")
            if periods is not None:
                return {"periods": periods}
    except Exception as exc:
        logger.warning("Place Details failed for %s: %s", place_id, exc)
    return None


# ── Background enrichment job ──────────────────────────────────────────────────

async def run_opening_hours_job(get_db_func) -> None:
    """Enrich all active venues with opening hours from Google Places."""
    global _opening_hours_state
    if _opening_hours_state["running"]:
        return

    _opening_hours_state = {
        "running": True, "total": 0, "done": 0, "updated": 0, "skipped": 0,
        "phase": "Hämtar venues…",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    logger.info("Opening hours enrichment job started")
    db: Session | None = None

    try:
        from app.models import SunTerrace

        db = next(get_db_func())
        terraces = (
            db.query(SunTerrace)
            .filter(SunTerrace.active == True)   # noqa: E712
            .order_by(SunTerrace.id)
            .all()
        )
        _opening_hours_state["total"] = len(terraces)
        _opening_hours_state["phase"] = "Hämtar öppettider…"

        for i in range(0, len(terraces), BATCH_SIZE):
            batch = terraces[i : i + BATCH_SIZE]

            # Step 1: resolve place_ids for venues that lack them
            find_tasks = []
            for t in batch:
                if t.source_id.startswith("google_"):
                    find_tasks.append(asyncio.sleep(0))  # no-op placeholder
                elif t.google_place_id:
                    find_tasks.append(asyncio.sleep(0))
                else:
                    find_tasks.append(
                        asyncio.wait_for(
                            asyncio.to_thread(_find_place_id_sync, t.name, t.lat, t.lon),
                            timeout=12,
                        )
                    )

            find_results = await asyncio.gather(*find_tasks, return_exceptions=True)

            for t, res in zip(batch, find_results):
                if t.source_id.startswith("google_"):
                    if not t.google_place_id:
                        t.google_place_id = t.source_id[len("google_"):]
                elif not isinstance(res, Exception) and res is not None and res is not True:
                    # res is the place_id string from _find_place_id_sync
                    if isinstance(res, str):
                        t.google_place_id = res

            # Step 2: fetch opening hours for venues with a place_id
            details_tasks = []
            for t in batch:
                if t.google_place_id:
                    details_tasks.append(
                        asyncio.wait_for(
                            asyncio.to_thread(_fetch_opening_hours_sync, t.google_place_id),
                            timeout=12,
                        )
                    )
                else:
                    details_tasks.append(asyncio.sleep(0))

            details_results = await asyncio.gather(*details_tasks, return_exceptions=True)

            for t, res in zip(batch, details_results):
                if isinstance(res, Exception) or res is None or res is True:
                    _opening_hours_state["skipped"] += 1
                    continue
                if isinstance(res, dict) and "periods" in res:
                    t.opening_hours_json = json.dumps(res, separators=(",", ":"))
                    t.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    _opening_hours_state["updated"] += 1
                else:
                    _opening_hours_state["skipped"] += 1

            db.commit()
            _opening_hours_state["done"] = min(i + BATCH_SIZE, len(terraces))
            await asyncio.sleep(0.1)

        logger.info("Opening hours enrichment done: %d updated, %d skipped",
                    _opening_hours_state["updated"], _opening_hours_state["skipped"])

    except Exception as exc:
        logger.error("Opening hours enrichment job error: %s", exc)
        _opening_hours_state["error"] = str(exc)
    finally:
        _opening_hours_state["running"] = False
        _opening_hours_state["finished_at"] = datetime.now(timezone.utc).isoformat()
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
