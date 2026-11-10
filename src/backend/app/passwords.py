"""Policy for new credentials; existing accounts can still authenticate."""
from pathlib import Path

BLOCKED = frozenset(
    line.strip().casefold() for line in
    Path(__file__).with_name("common-passwords.txt").read_text().splitlines()
    if line.strip() and not line.startswith("#")
)


def validate_new_password(password: str) -> None:
    if not 15 <= len(password) <= 128:
        raise ValueError("Use 15–128 characters for your password.")
    if password.strip().casefold() in BLOCKED or len(set(password)) == 1:
        raise ValueError("Choose a less common password or a unique passphrase.")
