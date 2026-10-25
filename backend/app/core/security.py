import hashlib
import secrets

from pwdlib import PasswordHash

password_hasher = PasswordHash.recommended()

# A real Argon2 hash keeps nonexistent-account login attempts on the same expensive
# verification path as incorrect-password attempts.
_dummy_password_hash = password_hasher.hash(secrets.token_urlsafe(32))


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, stored_hash: str | None) -> bool:
    if stored_hash is None:
        password_hasher.verify(password, _dummy_password_hash)
        return False
    try:
        return password_hasher.verify(password, stored_hash)
    except Exception:
        return False


def new_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()