from __future__ import annotations

import datetime
import os
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AppUser

webhooks_router = APIRouter()

REVENUECAT_WEBHOOK_SECRET = os.environ.get("REVENUECAT_WEBHOOK_SECRET", "")

# Event types that mean the user has active premium
_ACTIVE_EVENTS = {
    "INITIAL_PURCHASE",
    "RENEWAL",
    "PRODUCT_CHANGE",
    "UNCANCELLATION",
    "TRANSFER",
    "SUBSCRIBER_ALIAS",
}
# Event types that mean premium should be revoked
_REVOKE_EVENTS = {
    "CANCELLATION",
    "EXPIRATION",
    "BILLING_ISSUE",
    "SUBSCRIBER_DELETED",
}


@webhooks_router.post("/api/v1/webhooks/revenuecat")
async def revenuecat_webhook(
    request: Request,
    authorization: str = Header(""),
    db: Session = Depends(get_db),
):
    if REVENUECAT_WEBHOOK_SECRET:
        expected = f"Bearer {REVENUECAT_WEBHOOK_SECRET}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="Invalid webhook secret")

    body: dict[str, Any] = await request.json()
    event: dict[str, Any] = body.get("event", {})

    event_type: str = event.get("type", "")
    app_user_id: str = event.get("app_user_id", "")
    expiration_ms: int | None = event.get("expiration_at_ms")

    if not app_user_id:
        return {"status": "ignored", "reason": "no app_user_id"}

    try:
        user_id = int(app_user_id)
    except (ValueError, TypeError):
        return {"status": "ignored", "reason": "non-integer app_user_id"}

    user = db.query(AppUser).filter(AppUser.id == user_id).first()
    if not user:
        return {"status": "ignored", "reason": "user not found"}

    if event_type in _ACTIVE_EVENTS:
        user.is_premium = True
        if expiration_ms:
            user.premium_expires_at = datetime.datetime.utcfromtimestamp(expiration_ms / 1000)
        db.commit()
        return {"status": "ok", "action": "premium_granted"}

    if event_type in _REVOKE_EVENTS:
        user.is_premium = False
        db.commit()
        return {"status": "ok", "action": "premium_revoked"}

    return {"status": "ignored", "reason": f"unhandled event type: {event_type}"}
