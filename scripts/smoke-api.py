"""Verify a deployed AuraJournal API using only disposable data."""

import argparse
from pathlib import Path
import secrets
import sys
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx


DATE = "2024-02-29"
PERIOD_START = "2024-02-26"
CONFIRMATION = {"confirmation": "DELETE"}
SESSION_COOKIE = "aurajournal_session"
MAX_AUDIO_BYTES = 10 * 1024 * 1024


class SmokeFailure(Exception):
    pass


def check(client, step, method, path, expected, **kwargs):
    try:
        response = client.request(method, path, **kwargs)
    except httpx.RequestError as error:
        raise SmokeFailure(f"{step} failed ({type(error).__name__})") from None
    allowed = expected if isinstance(expected, tuple) else (expected,)
    if response.status_code not in allowed:
        raise SmokeFailure(f"{step} returned HTTP {response.status_code}, expected {expected}")
    print(f"{step} · HTTP {response.status_code}", flush=True)
    return response


def require(condition, step):
    if not condition:
        raise SmokeFailure(f"{step} returned an unexpected result")


def document(response, step, expected_type=dict):
    try:
        value = response.json()
    except ValueError:
        raise SmokeFailure(f"{step} returned invalid JSON") from None
    require(isinstance(value, expected_type), step)
    return value


def calendar_count(client, expected):
    response = check(client, "Read calendar", "GET", "/api/calendar", 200,
                     params={"year": 2024, "month": 2})
    days = document(response, "Read calendar").get("days")
    require(isinstance(days, list) and {"date": DATE, "count": expected} in days, "Calendar count")


def run(client, scenario, audio):
    credentials = {
        "email": f"api-smoke-{uuid4().hex}@example.com",
        "password": "Smoke-" + secrets.token_urlsafe(24),
    }
    registered = False
    deleted = False
    try:
        check(client, "Reject anonymous session", "GET", "/api/auth/me", 401)
        try:
            check(client, "Register disposable account", "POST", "/api/auth/register", 201, json=credentials)
        except SmokeFailure:
            # If the response was lost, cleanup can recover the newly created session by logging in.
            if not client.cookies:
                try:
                    check(client, "Recover disposable account", "POST", "/api/auth/login", (200, 401),
                          json=credentials)
                except SmokeFailure:
                    pass
            registered = bool(client.cookies)
            raise
        registered = True
        check(client, "Log out after registration", "POST", "/api/auth/logout", 204, json={})
        check(client, "Log in", "POST", "/api/auth/login", 200, json=credentials)

        original = "I walked around the park. This is a fictional smoke test journal."
        revised = "I walked around the lake. This is a fictional smoke test journal."
        response = check(client, "Create journal", "POST", "/api/entries", 201,
                         json={"content": original, "journal_date": DATE})
        entry = document(response, "Create journal")
        try:
            entry_id = str(UUID(entry.get("id")))
        except (ValueError, TypeError, AttributeError):
            raise SmokeFailure("Create journal returned an invalid entry ID") from None
        path = f"/api/entries/{entry_id}"
        response = check(client, "Read journal", "GET", path, 200)
        actual = document(response, "Read journal")
        require(actual.get("content") == original and actual.get("journal_date") == DATE, "Read journal")
        check(client, "Edit journal", "PATCH", path, 200, json={"content": revised})
        response = check(client, "Read edited journal", "GET", path, 200)
        require(document(response, "Read edited journal").get("content") == revised, "Read edited journal")
        calendar_count(client, 1)

        reflection_path = "/api/weekly-reflections"
        saved_path = f"{reflection_path}/{PERIOD_START}"
        if scenario == "normal":
            response = check(client, "Upload voice recording", "POST", "/api/transcriptions", 200,
                             content=audio, headers={"Content-Type": "audio/webm;codecs=opus"})
            transcript = document(response, "Upload voice recording")
            text = transcript.get("transcript")
            require(transcript.get("outcome") == "transcribed" and isinstance(text, str) and text.strip(),
                    "Upload voice recording")
            response = check(client, "Generate weekly reflection", "POST", reflection_path, 200,
                             json={"period_start": PERIOD_START})
            reflection = document(response, "Generate weekly reflection")
            require(reflection.get("entry_count") == 1 and reflection.get("summary")
                    and reflection.get("questions") and reflection.get("source_dates") == [DATE],
                    "Generate weekly reflection")
            response = check(client, "Read saved weekly reflection", "GET", saved_path, 200)
            saved = document(response, "Read saved weekly reflection")
            require(all(saved.get(key) == reflection[key] for key in ("summary", "questions", "source_dates")),
                    "Read saved weekly reflection")
        else:
            response = check(client, "Handle unavailable reflection provider", "POST", reflection_path, 503,
                             json={"period_start": PERIOD_START})
            require(document(response, "Handle unavailable reflection provider").get("detail") ==
                    "AI weekly reflection service is unavailable. Please try again later.",
                    "Handle unavailable reflection provider")
            check(client, "Verify no reflection was saved", "GET", saved_path, 404)
            response = check(client, "Read journal after AI failure", "GET", path, 200)
            require(document(response, "Read journal after AI failure").get("content") == revised,
                    "Read journal after AI failure")

        response = check(client, "Export journal", "GET", "/api/entries/export", 200)
        require(document(response, "Export journal", list) == [
            {"journal_date": DATE, "title": "I walked around the lake", "content": revised},
        ], "Export journal")
        check(client, "Delete journal", "DELETE", path, 204, headers={"Content-Type": "application/json"})
        check(client, "Verify journal was deleted", "GET", path, 404)
        calendar_count(client, 0)

        previous_cookies = httpx.Cookies(client.cookies)
        check(client, "Delete disposable account", "DELETE", "/api/auth/me", 204, json=CONFIRMATION)
        deleted = True
        require(SESSION_COOKIE not in client.cookies, "Clear session cookie")
        client.cookies.update(previous_cookies)
        check(client, "Verify old cookie was revoked", "GET", "/api/auth/me", 401)
    finally:
        if registered and not deleted:
            cleanup(client, credentials)


def cleanup(client, credentials):
    response = check(client, "Clean up disposable account", "DELETE", "/api/auth/me", (204, 401),
                     json=CONFIRMATION)
    if response.status_code == 401:
        client.cookies.clear()
        response = check(client, "Recover session for cleanup", "POST", "/api/auth/login", (200, 401),
                         json=credentials)
        if response.status_code == 200:
            check(client, "Delete disposable account during cleanup", "DELETE", "/api/auth/me", 204,
                  json=CONFIRMATION)


def origin(value):
    parts = urlsplit(value)
    if (not parts.hostname or parts.username is not None or parts.password is not None
            or parts.path not in {"", "/"} or parts.query or parts.fragment
            or (parts.scheme != "https" and (parts.scheme != "http"
                or parts.hostname not in {"localhost", "127.0.0.1", "::1"}))):
        raise ValueError
    return value.rstrip("/")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--scenario", choices=("normal", "reflection-unavailable"), default="normal")
    parser.add_argument("--audio", type=Path, help="Short WebM/Opus recording of fictional speech")
    args = parser.parse_args()
    try:
        base_url, frontend_origin = origin(args.api_url), origin(args.origin)
    except ValueError:
        parser.error("Use HTTPS origins without paths or credentials. HTTP is supported on loopback for rehearsal.")
    audio = None
    if args.scenario == "normal":
        if args.audio is None:
            parser.error("The normal scenario requires --audio.")
        try:
            with args.audio.open("rb") as fixture:
                audio = fixture.read(MAX_AUDIO_BYTES + 1)
        except OSError:
            parser.error("Could not read the audio fixture.")
        if len(audio) > MAX_AUDIO_BYTES or not audio.startswith(b"\x1a\x45\xdf\xa3"):
            parser.error("The fixture must be WebM/Opus and at most 10 MiB.")
    try:
        headers = {"Origin": frontend_origin, "X-AuraJournal-CSRF": "1"}
        with httpx.Client(base_url=base_url, headers=headers, trust_env=False,
                          timeout=httpx.Timeout(100, connect=10)) as client:
            run(client, args.scenario, audio)
    except SmokeFailure as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"Passed · {args.scenario}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
