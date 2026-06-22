"""
Automatic hashtag tagging for sun terraces — three strategies combined:

1. Name / amenity_type keyword matching (fast, offline)
2. Solar arc → sun timing tags (förmiddagssol / eftermiddagssol / kvällssol)
3. Claude Haiku batch enrichment for venues with < 2 tags after strategy 1+2
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import Hashtag, SunTerrace, TerraceHashtag
from app.city_config import CITY as _CITY

logger = logging.getLogger(__name__)

# ── Strategy 1: keyword rules ─────────────────────────────────────────────────

NAME_RULES: list[tuple[list[str], str]] = [
    (['kebab', 'döner', 'doner', 'shwarma'], 'kebab'),
    (['pizza', 'pizzeria'], 'pizza'),
    (['sushi', 'japansk'], 'sushi'),
    (['burgare', 'burger', 'hamburgare'], 'burgare'),
    (['bryggeri', 'brewery', 'taproom', 'brygghus'], 'öl'),
    (['kaffebar', 'kafebar', 'coffee house'], 'kaffe'),
    (['cocktail', 'speakeasy', 'mixology'], 'cocktails'),
    (['vinbar', 'wine bar', 'vinkrog', 'vinotek', 'wine cellar'], 'vin'),
    (['brunch'], 'brunch'),
    (['trattoria', 'osteria', 'ristorante', 'italiano'], 'italienskt'),
    (['utsikt', 'panorama', 'skybar', 'rooftop'], 'utsikt'),
    (['lunch', 'lunchrestaurang'], 'lunch'),
]

# Conservative amenity_type base tags — restaurant intentionally omitted
AMENITY_RULES: dict[str, list[str]] = {
    'pub': ['öl', 'afterwork'],
    'bar': ['afterwork'],
    'cafe': ['kaffe', 'fika'],
}

ALL_AVAILABLE_TAGS: list[str] = [
    'öl', 'vin', 'cocktails', 'kaffe', 'fika', 'pizza', 'burgare', 'kebab',
    'sushi', 'italienskt', 'brunch', 'lunch', 'middag', 'afterwork',
    'utsikt', 'hamnutsikt', 'förmiddagssol', 'eftermiddagssol', 'kvällssol',
    'hund', 'vegetariskt', 'vegan', 'livemusik',
]


def _name_tags(name: str | None, amenity_type: str | None) -> set[str]:
    """Strategy 1: keyword matching on name + amenity_type rules."""
    tags: set[str] = set()
    name_lower = (name or '').lower()
    for keywords, tag in NAME_RULES:
        if any(kw in name_lower for kw in keywords):
            tags.add(tag)
    base = AMENITY_RULES.get(amenity_type or '', [])
    tags.update(base)
    return tags


# ── Strategy 2: solar arc → timing tags ─────────────────────────────────────

def _arc_covers(arc_from: float, arc_to: float, azimuth: float) -> bool:
    """Return True if the arc meaningfully covers azimuth (> 15° inside both edges)."""
    span = (arc_to - arc_from + 360) % 360 or 360
    if span >= 350:
        return True  # full circle
    dist = (azimuth - arc_from + 360) % 360
    return 15 < dist < span - 15


def _arc_tags(
    outdoor_type: str | None,
    arc_from: float | None,
    arc_to: float | None,
) -> set[str]:
    """Strategy 2: derive sun-timing tags from solar arc."""
    tags: set[str] = set()
    if outdoor_type == 'rooftop':
        return {'förmiddagssol', 'eftermiddagssol', 'kvällssol'}
    if arc_from is None or arc_to is None:
        return tags
    if _arc_covers(arc_from, arc_to, 90):
        tags.add('förmiddagssol')
    if _arc_covers(arc_from, arc_to, 180):
        tags.add('eftermiddagssol')
    if _arc_covers(arc_from, arc_to, 270):
        tags.add('kvällssol')
    return tags


# ── Strategy 3: Claude Haiku batch AI ────────────────────────────────────────

_SYSTEM_PROMPT = (
    f"You are a local expert for {_CITY.name}, Sweden. "
    "Given a venue name, type and address, pick 1–3 hashtags from the provided list "
    "that are CLEARLY AND DISTINCTIVELY associated with this venue. "
    "Do NOT add generic tags that could apply to almost any venue. "
    "Return a JSON array of objects: [{id, hashtags: [string, ...]}]"
)


async def _ai_batch(
    venues: list[dict],
    available_tags: list[str],
) -> dict[int, list[str]]:
    """Call Claude Haiku for a batch of venues. Returns {venue_id: [tag, ...]}."""
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        logger.warning('auto_tag: ANTHROPIC_API_KEY not set — skipping AI batch')
        return {}

    import anthropic  # noqa: PLC0415 — lazy import per spec

    venue_list = json.dumps(
        [{'id': v['id'], 'name': v['name'], 'type': v['type'], 'address': v['address'] or ''} for v in venues],
        ensure_ascii=False,
    )
    user_msg = (
        f"Available hashtags: {', '.join(available_tags)}\n\n"
        f"Venues:\n{venue_list}"
    )

    try:
        client = anthropic.AsyncAnthropic(api_key=api_key)
        msg = await client.messages.create(
            model='claude-haiku-4-5',
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{'role': 'user', 'content': user_msg}],
        )
        raw = msg.content[0].text if msg.content else '[]'
        # Extract JSON array from response (may be wrapped in markdown)
        start = raw.find('[')
        end = raw.rfind(']') + 1
        if start == -1 or end == 0:
            logger.warning('auto_tag: AI response has no JSON array: %s', raw[:200])
            return {}
        parsed: list[dict] = json.loads(raw[start:end])
        return {item['id']: item.get('hashtags', []) for item in parsed if isinstance(item, dict)}
    except Exception as exc:
        logger.warning('auto_tag: AI batch failed: %s', exc)
        return {}


# ── Job state ─────────────────────────────────────────────────────────────────

_state: dict = {
    'running': False,
    'total': 0,
    'done': 0,
    'tagged': 0,
    'ai_tagged': 0,
    'started_at': None,
    'finished_at': None,
    'error': None,
}


def get_state() -> dict:
    return dict(_state)


# ── Main job ──────────────────────────────────────────────────────────────────

async def run_auto_tag_job(get_db_func) -> None:
    global _state
    _state.update({
        'running': True,
        'total': 0,
        'done': 0,
        'tagged': 0,
        'ai_tagged': 0,
        'started_at': datetime.now(timezone.utc).isoformat(),
        'finished_at': None,
        'error': None,
    })

    try:
        db: Session = next(get_db_func())

        # Load all active hashtags: {name: id}
        hashtag_rows = db.query(Hashtag).filter(Hashtag.active == True).all()  # noqa: E712
        name_to_id: dict[str, int] = {h.name: h.id for h in hashtag_rows}

        # Load all active terraces
        terraces = db.query(SunTerrace).filter(SunTerrace.active == True).all()  # noqa: E712
        _state['total'] = len(terraces)

        ai_queue: list[dict] = []

        now = datetime.now(timezone.utc).replace(tzinfo=None)
        commit_counter = 0

        for terrace in terraces:
            # Strategies 1 + 2
            tags: set[str] = set()
            tags |= _name_tags(terrace.name, terrace.amenity_type)
            tags |= _arc_tags(
                terrace.outdoor_type,
                getattr(terrace, 'sun_arc_from', None),
                getattr(terrace, 'sun_arc_to', None),
            )

            # Seed tags from strategies 1+2
            for tag_name in tags:
                hashtag_id = name_to_id.get(tag_name)
                if hashtag_id is None:
                    continue
                existing = (
                    db.query(TerraceHashtag)
                    .filter(
                        TerraceHashtag.terrace_id == terrace.id,
                        TerraceHashtag.hashtag_id == hashtag_id,
                    )
                    .first()
                )
                if existing is None:
                    db.add(TerraceHashtag(
                        terrace_id=terrace.id,
                        hashtag_id=hashtag_id,
                        count=1,
                        updated_at=now,
                    ))
                    _state['tagged'] += 1
                    commit_counter += 1

            # Queue for AI if fewer than 2 tags
            if len(tags) < 2:
                ai_queue.append({
                    'id': terrace.id,
                    'name': terrace.name or '',
                    'type': terrace.amenity_type or '',
                    'address': terrace.address or '',
                })

            _state['done'] += 1

            if commit_counter >= 100:
                db.commit()
                commit_counter = 0

        # Commit remaining strategy 1+2 tags
        if commit_counter > 0:
            db.commit()
            commit_counter = 0

        # Strategy 3: AI batches of 20
        available_tags = [t for t in ALL_AVAILABLE_TAGS if t in name_to_id]

        for i in range(0, len(ai_queue), 20):
            batch = ai_queue[i:i + 20]
            results = await _ai_batch(batch, available_tags)
            for venue_id, suggested_tags in results.items():
                for tag_name in suggested_tags:
                    hashtag_id = name_to_id.get(tag_name)
                    if hashtag_id is None:
                        continue
                    existing = (
                        db.query(TerraceHashtag)
                        .filter(
                            TerraceHashtag.terrace_id == venue_id,
                            TerraceHashtag.hashtag_id == hashtag_id,
                        )
                        .first()
                    )
                    if existing is None:
                        db.add(TerraceHashtag(
                            terrace_id=venue_id,
                            hashtag_id=hashtag_id,
                            count=1,
                            updated_at=now,
                        ))
                        _state['ai_tagged'] += 1
                        commit_counter += 1
            if commit_counter >= 100:
                db.commit()
                commit_counter = 0

        if commit_counter > 0:
            db.commit()

        db.close()

    except Exception as exc:
        logger.exception('auto_tag: job failed')
        _state['error'] = str(exc)
    finally:
        _state['running'] = False
        _state['finished_at'] = datetime.now(timezone.utc).isoformat()
