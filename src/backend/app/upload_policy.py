"""The sole HTTP route permitted to receive raw recording bytes."""

AUDIO_UPLOAD_PATH = "/api/transcriptions"


def is_audio_upload(scope) -> bool:
    return scope["type"] == "http" and scope.get("method") == "POST" and scope.get("path") == AUDIO_UPLOAD_PATH
