from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Cookie, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse

from app.city_config import CITY as _CITY

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get("REDIRECT_URI", f"https://{_CITY.domain}/auth/callback")

SESSION_COOKIE = "session"
SESSION_MAX_AGE = 86400 * 7  # 7 days in seconds

# Derive a stable signing key from the Google client secret via sha256
def _signing_key() -> bytes:
    return hashlib.sha256(GOOGLE_CLIENT_SECRET.encode()).hexdigest().encode()


def create_session_token(email: str) -> str:
    """Sign {"email": email, "exp": timestamp+7days} and return base64payload.hexsig."""
    exp = int(time.time()) + SESSION_MAX_AGE
    payload = json.dumps({"email": email, "exp": exp}, separators=(",", ":"))
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(_signing_key(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_session_token(token: str) -> Optional[str]:
    """Return the email from a valid token, or None if invalid/expired."""
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig = token.rsplit(".", 1)
    except ValueError:
        return None

    expected_sig = hmac.new(_signing_key(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_sig, sig):
        return None

    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "==").decode())
    except Exception:
        return None

    if payload.get("exp", 0) < int(time.time()):
        return None

    return payload.get("email")


def get_current_user(session: Optional[str] = Cookie(None)) -> str:
    """FastAPI dependency — returns email or raises 401."""
    email = verify_session_token(session or "")
    if not email:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return email


auth_router = APIRouter()


@auth_router.get("/auth/google")
def google_login():
    """Redirect the browser to Google's OAuth consent screen."""
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
    })
    return RedirectResponse(url=f"https://accounts.google.com/o/oauth2/v2/auth?{params}")


@auth_router.get("/auth/callback")
async def google_callback(code: str):
    """Exchange the OAuth code for a token, set a session cookie, redirect to /admin."""
    async with httpx.AsyncClient() as client:
        # Exchange code for tokens
        token_resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to exchange code for token")

        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise HTTPException(status_code=400, detail="No access token in response")

        # Fetch user info
        userinfo_resp = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to fetch user info")

        email = userinfo_resp.json().get("email")
        if not email:
            raise HTTPException(status_code=400, detail="No email in user info")

    token = create_session_token(email)
    response = RedirectResponse(url="/admin", status_code=302)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=SESSION_MAX_AGE,
    )
    return response


@auth_router.get("/auth/me")
def auth_me(session: Optional[str] = Cookie(None)):
    """Return the current user's email, or 401 if not authenticated."""
    email = verify_session_token(session or "")
    if not email:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"email": email}


@auth_router.post("/auth/logout")
def auth_logout():
    """Clear the session cookie and redirect to /."""
    response = RedirectResponse(url="/", status_code=302)
    response.delete_cookie(key=SESSION_COOKIE, httponly=True, secure=True, samesite="lax")
    return response
