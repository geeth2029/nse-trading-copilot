from pydantic import ConfigDict, EmailStr, Field

from app.schemas.base import APIModel


class AuthRequest(APIModel):
    model_config = ConfigDict(
        alias_generator=APIModel.model_config["alias_generator"],
        populate_by_name=True,
        extra="forbid",
    )


class RegisterRequest(AuthRequest):
    email: EmailStr
    password: str = Field(min_length=12, max_length=1024)
    display_name: str | None = Field(default=None, max_length=120)


class LoginRequest(AuthRequest):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)