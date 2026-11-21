"""Éléments communs au serveur et à la carte partagée (évite un import circulaire)."""
from datetime import datetime, timezone

MAX_TEXT = 4000


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_text(value, name, required=False, limit=MAX_TEXT):
    text = (value or "").strip() if isinstance(value, str) or value is None else None
    if text is None:
        raise ApiError(400, f"« {name} » doit être du texte")
    if required and not text:
        raise ApiError(400, f"« {name} » est obligatoire")
    if len(text) > limit:
        raise ApiError(400, f"« {name} » dépasse {limit} caractères")
    return text
