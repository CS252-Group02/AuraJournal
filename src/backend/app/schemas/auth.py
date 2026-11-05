from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from email_validator import EmailNotValidError, validate_email


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value):
        try:
            return validate_email(value.strip(), check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            raise ValueError("Enter a valid email address.") from None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: str
