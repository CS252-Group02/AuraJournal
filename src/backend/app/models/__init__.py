"""Import all models so SQLAlchemy can resolve relationships and collect metadata."""

from app.models.base import Base
from app.models.user import User
from app.models.journal_entry import JournalEntry
from app.models.mood_record import MoodRecord
from app.models.journal_image import JournalImage
from app.models.auth import AuthSession, LoginAttempt, RateLimitBucket
from app.models.weekly_reflection import WeeklyReflection
from app.models.pixel_art_job import PixelArtJob
from app.models.reflection_chat import ReflectionChat, ReflectionChatMessage, ReflectionChatSource

__all__ = [
    "Base", "User", "JournalEntry", "MoodRecord", "JournalImage", "AuthSession",
    "LoginAttempt", "RateLimitBucket", "WeeklyReflection", "PixelArtJob",
    "ReflectionChat", "ReflectionChatMessage", "ReflectionChatSource",
]
