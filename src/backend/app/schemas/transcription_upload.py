from typing import Literal

from pydantic import BaseModel


class UploadedTranscript(BaseModel):
    transcript: str
    outcome: Literal["transcribed", "no_speech"]
