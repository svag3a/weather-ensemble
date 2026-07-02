from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import json
import os
import time
from typing import Optional

import httpx
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AppUser

APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys"
APPLE_ISSUER = "https://appleid.apple.com"
APPLE_AUDIENCE = "se.gbgsol.app"

APP_TOKEN_MAX_AGE = 86400 * 90  # 90 days


def _app_signing_key() -> bytes:
    base = os.environ.get("GOOGLE_CLIENT_SECRET", "gbgsol-app-fallback")
    return hashlib.sha256(f"app_user_jwt:{base}".encode()).hexdigest().encode()


def create_app_token(user_id: int) -> str:
    exp = int(time.time()) + APP_TOKEN_MAX_AGE
    payload = json.dumps({"user_id": user_id, "exp": exp}, separators=(",", ":"))
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(_app_signing_key(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_app_token(token: str) -> Optional[int]:
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig = token.rsplit(".", 1)
    except ValueError:
        return None
    expected = hmac.new(_app_signing_key(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "==").decode())
    except Exception:
        return None
    if payload.get("exp", 0) < int(time.time()):
        return None
    return payload.get("user_id")


def get_app_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> AppUser:
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    user_id = verify_app_token(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.query(AppUser).filter(AppUser.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def _verify_apple_identity_token(identity_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(APPLE_KEYS_URL)
        resp.raise_for_status()
        keys_data = resp.json()

    header = jwt.get_unverified_header(identity_token)
    kid = header.get("kid")
    key_data = next((k for k in keys_data["keys"] if k["kid"] == kid), None)
    if not key_data:
        raise HTTPException(status_code=400, detail="Apple key not found")

    from jwt.algorithms import RSAAlgorithm
    public_key = RSAAlgorithm.from_jwk(json.dumps(key_data))

    try:
        payload = jwt.decode(
            identity_token,
            public_key,
            algorithms=["RS256"],
            audience=APPLE_AUDIENCE,
            issuer=APPLE_ISSUER,
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail="Apple token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=400, detail=f"Invalid Apple token: {e}")

    return payload


class AppleSignInRequest(BaseModel):
    identity_token: str
    full_name: Optional[str] = None


class UserPrefsRequest(BaseModel):
    radius: Optional[float] = None
    uvThreshold: Optional[int] = None
    activities: Optional[list] = None
    favourites: Optional[list] = None
    favouritesData: Optional[dict] = None
    badges: Optional[list] = None
    timePref: Optional[list] = None


apple_auth_router = APIRouter()


@apple_auth_router.post("/api/v1/auth/apple-signin")
async def apple_signin(body: AppleSignInRequest, db: Session = Depends(get_db)):
    payload = await _verify_apple_identity_token(body.identity_token)

    apple_user_id = payload["sub"]
    email = payload.get("email")

    user = db.query(AppUser).filter(AppUser.apple_user_id == apple_user_id).first()
    now = datetime.datetime.utcnow()
    if user:
        user.last_seen_at = now
        if email and not user.email:
            user.email = email
        if body.full_name and not user.full_name:
            user.full_name = body.full_name
    else:
        user = AppUser(
            apple_user_id=apple_user_id,
            email=email,
            full_name=body.full_name,
            created_at=now,
            last_seen_at=now,
        )
        db.add(user)

    db.commit()
    db.refresh(user)

    token = create_app_token(user.id)
    display_name = user.full_name or (user.email.split("@")[0] if user.email else "Användare")
    return {
        "token": token,
        "user_id": user.id,
        "is_premium": user.is_premium,
        "display_name": display_name,
    }


@apple_auth_router.get("/api/v1/user/prefs")
def get_user_prefs(user: AppUser = Depends(get_app_user)):
    prefs = json.loads(user.prefs_json) if user.prefs_json else {}
    return prefs


@apple_auth_router.put("/api/v1/user/prefs")
def put_user_prefs(
    body: UserPrefsRequest,
    user: AppUser = Depends(get_app_user),
    db: Session = Depends(get_db),
):
    existing = json.loads(user.prefs_json) if user.prefs_json else {}
    update = body.model_dump(exclude_none=True)
    existing.update(update)
    user.prefs_json = json.dumps(existing)
    db.commit()
    return {"ok": True}


@apple_auth_router.get("/api/v1/auth/app-me")
def app_me(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    token = authorization[7:] if (authorization or "").startswith("Bearer ") else ""
    user_id = verify_app_token(token)
    if not user_id:
        return {"authenticated": False}
    user = db.query(AppUser).filter(AppUser.id == user_id).first()
    if not user:
        return {"authenticated": False}
    display_name = user.full_name or (user.email.split("@")[0] if user.email else "Användare")
    return {
        "authenticated": True,
        "user_id": user.id,
        "is_premium": user.is_premium,
        "display_name": display_name,
    }
