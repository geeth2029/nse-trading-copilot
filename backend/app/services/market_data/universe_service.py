"""Backend service for loading, caching, and serving verified Large-Cap Universe constituents."""

from collections.abc import Callable
from datetime import date, datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import threading
from typing import Any

from app.core.config import Settings
from app.schemas.universe import (
    LargeCapUniverse,
    UniverseConstituent,
    UniverseManifest,
    UniverseStatusRead,
)
from app.services.market_data.universe_ingest import (
    ISIN_PATTERN,
    get_manifest_path,
    verify_artifact_manifest,
)

logger = logging.getLogger(__name__)


class UniverseServiceError(Exception):
    """Base exception for universe service operations."""

    pass


class UniverseNotAvailableError(UniverseServiceError):
    """Raised when universe constituents cannot be served due to missing, expired, or invalid data."""

    def __init__(self, status: UniverseStatusRead) -> None:
        self.status = status
        self.universe_status = status
        super().__init__(f"Large-cap universe is not active ({status.status}): {status.status_reason}")


class UniverseService:
    """Manages loading, integrity verification, in-memory caching, and temporal evaluation of the Large-Cap Universe."""

    def __init__(
        self,
        artifact_path: Path | str | None = None,
        settings: Settings | None = None,
        clock: Callable[[], date] | None = None,
    ) -> None:
        if artifact_path is not None:
            self.artifact_path = Path(artifact_path).resolve()
        else:
            effective_settings = settings or Settings.from_environment()
            self.artifact_path = Path(effective_settings.large_cap_universe_path).resolve()

        self._clock = clock
        self._lock = threading.Lock()

        # In-memory cache
        self._cached_universe: LargeCapUniverse | None = None
        self._cached_mtime: float = 0.0
        self._cached_size: int = 0
        self._cached_manifest_mtime: float = 0.0

    def _get_current_date(self) -> date:
        """Resolve current date using injected clock or UTC date."""
        if self._clock is not None:
            return self._clock()
        return datetime.now(timezone.utc).date()

    @property
    def manifest_path(self) -> Path:
        """Derive standard sidecar manifest path."""
        return get_manifest_path(self.artifact_path)

    def _verify_artifact_integrity(
        self, raw_bytes: bytes
    ) -> tuple[bool, str, dict[str, Any] | None]:
        """Verify artifact SHA-256 checksum against the required sidecar manifest.

        Note: Checksum comparison verifies file integrity against accidental corruption or
        unauthorized tampering on disk. It does not establish licensing permission,
        regulatory authorization, or source authenticity of the underlying classification data.

        Important: metadata.sha256_checksum represents the original input file (e.g. CSV).
        It must not be confused with or used as the checksum of the compiled JSON artifact.
        The compiled JSON artifact SHA-256 is checked exclusively against the sidecar manifest.
        """
        return verify_artifact_manifest(self.artifact_path, raw_bytes)

    def _validate_universe_invariants(self, universe: LargeCapUniverse) -> None:
        """Validate all structural and numerical invariants on a parsed LargeCapUniverse instance."""
        if universe.metadata.constituent_count != 100:
            raise ValueError(f"Metadata constituent_count is {universe.metadata.constituent_count} (must be 100).")
        if len(universe.constituents) != 100:
            raise ValueError(f"Actual constituent list length is {len(universe.constituents)} (must be 100).")

        seen_ranks: set[int] = set()
        seen_isins: set[str] = set()
        seen_symbols: set[str] = set()
        seen_keys: set[str] = set()

        for c in universe.constituents:
            if c.rank < 1 or c.rank > 100:
                raise ValueError(f"Constituent rank {c.rank} is outside the valid 1-100 range.")
            if c.rank in seen_ranks:
                raise ValueError(f"Duplicate rank {c.rank} detected in constituents.")
            seen_ranks.add(c.rank)

            if not ISIN_PATTERN.match(c.isin):
                raise ValueError(f"Constituent ISIN '{c.isin}' does not match Indian ISIN format.")
            if c.isin in seen_isins:
                raise ValueError(f"Duplicate ISIN '{c.isin}' detected in constituents.")
            seen_isins.add(c.isin)

            if not c.canonical_nse_symbol or not c.canonical_nse_symbol.strip():
                raise ValueError(f"Constituent rank {c.rank} has an empty canonical NSE symbol.")
            if c.canonical_nse_symbol in seen_symbols:
                raise ValueError(f"Duplicate canonical NSE symbol '{c.canonical_nse_symbol}' detected.")
            seen_symbols.add(c.canonical_nse_symbol)

            if not c.upstox_instrument_key or not c.upstox_instrument_key.startswith("NSE_EQ|"):
                raise ValueError(f"Constituent rank {c.rank} has an invalid Upstox instrument key '{c.upstox_instrument_key}'.")
            if c.upstox_instrument_key in seen_keys:
                raise ValueError(f"Duplicate Upstox instrument key '{c.upstox_instrument_key}' detected.")
            seen_keys.add(c.upstox_instrument_key)

        expected_ranks = set(range(1, 101))
        if seen_ranks != expected_ranks:
            missing = sorted(expected_ranks - seen_ranks)
            raise ValueError(f"Constituent ranks have missing numbers: {missing}.")

        if universe.metadata.effective_from > universe.metadata.effective_to:
            raise ValueError(f"effective_from ({universe.metadata.effective_from}) is after effective_to ({universe.metadata.effective_to}).")

    def _load_and_validate_file(self) -> tuple[LargeCapUniverse | None, UniverseStatusRead]:
        """Attempt to read and validate the artifact file and its required manifest from disk."""
        if not self.artifact_path.exists() or not self.artifact_path.is_file():
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="UNAVAILABLE",
                status_reason=f"Universe artifact does not exist at path: '{self.artifact_path.name}'.",
            )

        try:
            raw_bytes = self.artifact_path.read_bytes()
        except Exception as exc:
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=f"Failed to read universe artifact bytes: {exc}",
            )

        # 1. Manifest / checksum verification
        integrity_ok, integrity_err, manifest_data = self._verify_artifact_integrity(raw_bytes)
        if not integrity_ok:
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=integrity_err,
            )

        assert manifest_data is not None

        # 2. JSON parsing
        try:
            raw_json = json.loads(raw_bytes.decode("utf-8"))
        except Exception as exc:
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=f"Universe artifact JSON parsing failed: {exc}",
            )

        # 3. Schema validation
        try:
            universe = LargeCapUniverse.model_validate(raw_json)
        except Exception as exc:
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=f"Universe artifact schema validation failed: {exc}",
            )

        # 4. Manifest dataset version consistency check
        manifest_version = str(manifest_data.get("datasetVersion", "")).strip()
        if manifest_version != universe.metadata.dataset_version.strip():
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                dataset_version=universe.metadata.dataset_version,
                source_period_label=universe.metadata.source_period_label,
                classification_period=universe.metadata.classification_period,
                effective_from=universe.metadata.effective_from,
                effective_to=universe.metadata.effective_to,
                constituent_count=len(universe.constituents),
                status_reason=(
                    f"Dataset version mismatch between sidecar manifest ('{manifest_version}') "
                    f"and artifact metadata ('{universe.metadata.dataset_version}')."
                ),
            )

        # 5. Invariants check
        try:
            self._validate_universe_invariants(universe)
        except Exception as exc:
            return None, UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                dataset_version=universe.metadata.dataset_version,
                source_period_label=universe.metadata.source_period_label,
                classification_period=universe.metadata.classification_period,
                effective_from=universe.metadata.effective_from,
                effective_to=universe.metadata.effective_to,
                constituent_count=len(universe.constituents),
                status_reason=f"Universe integrity invariants failed: {exc}",
            )

        return universe, UniverseStatusRead(
            is_available=True,
            is_valid_for_date=True,
            status="VALID",
            dataset_version=universe.metadata.dataset_version,
            source_period_label=universe.metadata.source_period_label,
            classification_period=universe.metadata.classification_period,
            effective_from=universe.metadata.effective_from,
            effective_to=universe.metadata.effective_to,
            constituent_count=100,
            status_reason="Dataset and sidecar manifest are structurally valid and verified.",
        )

    def _sync_cache(self) -> tuple[LargeCapUniverse | None, UniverseStatusRead | None]:
        """Synchronize in-memory cache with the file on disk.

        Safeguard: If a file modification is corrupted or fails integrity, the previous valid
        cached universe is preserved.
        """
        with self._lock:
            if not self.artifact_path.exists():
                self._cached_universe = None
                self._cached_mtime = 0.0
                self._cached_size = 0
                self._cached_manifest_mtime = 0.0
                return None, UniverseStatusRead(
                    is_available=False,
                    is_valid_for_date=False,
                    status="UNAVAILABLE",
                    status_reason=f"Universe artifact does not exist at path: '{self.artifact_path.name}'.",
                )

            try:
                stat = self.artifact_path.stat()
                mtime = stat.st_mtime
                size = stat.st_size
                manifest_mtime = self.manifest_path.stat().st_mtime if self.manifest_path.exists() else 0.0
            except OSError as exc:
                logger.warning("Failed to stat universe artifact (%s); returning current state.", exc)
                return self._cached_universe, None

            # File unchanged: return cached
            if (
                self._cached_universe is not None
                and mtime == self._cached_mtime
                and size == self._cached_size
                and manifest_mtime == self._cached_manifest_mtime
            ):
                return self._cached_universe, None

            # Reload attempted
            loaded_universe, status_read = self._load_and_validate_file()
            if loaded_universe is not None:
                self._cached_universe = loaded_universe
                self._cached_mtime = mtime
                self._cached_size = size
                self._cached_manifest_mtime = manifest_mtime
                return self._cached_universe, None

            # Reload failed
            if self._cached_universe is not None:
                logger.warning(
                    "Reload of universe artifact failed (%s); retaining previously valid cached universe.",
                    status_read.status_reason,
                )
                return self._cached_universe, None

            return None, status_read

    def get_status(self, as_of_date: date | None = None) -> UniverseStatusRead:
        """Evaluate and return runtime availability, integrity, and temporal validity status."""
        eval_date = as_of_date or self._get_current_date()
        universe, initial_status = self._sync_cache()

        if universe is None:
            if initial_status is not None:
                return initial_status
            return UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="UNAVAILABLE",
                status_reason=f"Universe artifact is unavailable at path '{self.artifact_path.name}'.",
            )

        meta = universe.metadata

        # Strict temporal evaluation
        if eval_date < meta.effective_from:
            return UniverseStatusRead(
                is_available=True,
                is_valid_for_date=False,
                status="NOT_YET_ACTIVE",
                dataset_version=meta.dataset_version,
                source_period_label=meta.source_period_label,
                classification_period=meta.classification_period,
                effective_from=meta.effective_from,
                effective_to=meta.effective_to,
                constituent_count=100,
                status_reason=(
                    f"Universe dataset '{meta.dataset_version}' ({meta.classification_period}) is not yet active. "
                    f"Effective dates are {meta.effective_from} to {meta.effective_to}; evaluation date is {eval_date}."
                ),
            )

        if eval_date > meta.effective_to:
            return UniverseStatusRead(
                is_available=True,
                is_valid_for_date=False,
                status="EXPIRED",
                dataset_version=meta.dataset_version,
                source_period_label=meta.source_period_label,
                classification_period=meta.classification_period,
                effective_from=meta.effective_from,
                effective_to=meta.effective_to,
                constituent_count=100,
                status_reason=(
                    f"Universe dataset '{meta.dataset_version}' ({meta.classification_period}) has expired. "
                    f"Effective period ended on {meta.effective_to}; evaluation date is {eval_date}."
                ),
            )

        return UniverseStatusRead(
            is_available=True,
            is_valid_for_date=True,
            status="VALID",
            dataset_version=meta.dataset_version,
            source_period_label=meta.source_period_label,
            classification_period=meta.classification_period,
            effective_from=meta.effective_from,
            effective_to=meta.effective_to,
            constituent_count=100,
            status_reason=f"Universe dataset '{meta.dataset_version}' ({meta.classification_period}) is active and valid for {eval_date}.",
        )

    def get_universe(self, as_of_date: date | None = None) -> LargeCapUniverse | None:
        """Return the active LargeCapUniverse if valid for the supplied date, otherwise None."""
        status = self.get_status(as_of_date)
        if status.status != "VALID":
            return None
        return self._cached_universe

    def get_constituents(self, as_of_date: date | None = None) -> list[UniverseConstituent]:
        """Return exactly 100 validated constituents if active and valid for the supplied date.

        Raises UniverseNotAvailableError if the universe is unavailable, expired, or invalid.
        """
        status = self.get_status(as_of_date)
        if status.status != "VALID":
            raise UniverseNotAvailableError(status)

        assert self._cached_universe is not None
        return list(self._cached_universe.constituents)
