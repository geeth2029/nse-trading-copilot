"""Validation service, instrument resolver, and ingestion pipeline for versioned NSE Large-Cap Universe."""

import csv
from datetime import date, datetime, timezone
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
from typing import Any, Protocol, runtime_checkable
import uuid

from app.schemas.universe import (
    LargeCapUniverse,
    UniverseConstituent,
    UniverseManifest,
    UniverseMetadata,
    UniverseStatusRead,
)

logger = logging.getLogger(__name__)

# Strict Indian ISIN regex (IN + 9 alphanumeric characters + 1 check digit)
ISIN_PATTERN = re.compile(r"^IN[A-Z0-9]{10}$")


# --- Custom Ingestion & Validation Exceptions ---


class UniverseIngestError(Exception):
    """Base exception for all universe ingestion and validation errors."""

    pass


class UniverseFormatError(UniverseIngestError):
    """Raised when file format, encoding, or tabular column layout is unknown or malformed."""

    pass


class UniverseIntegrityError(UniverseIngestError):
    """Raised when constituent count, ranking, or identifiers violate strict integrity rules."""

    pass


class UniverseMappingError(UniverseIngestError):
    """Raised when a constituent cannot be mapped or conflicts with existing NSE equity instruments."""

    pass


# --- Instrument Resolver Protocol & Testable Implementations ---


@runtime_checkable
class InstrumentResolver(Protocol):
    """Protocol for resolving ISIN to verified canonical NSE equity trading symbol and instrument key."""

    def resolve_by_isin(self, isin: str) -> tuple[str, str] | None:
        """Resolve an ISIN to (canonical_trading_symbol, instrument_key).

        Returns None if unresolved, unknown, or not an active NSE cash equity instrument.
        """
        ...


class DictInstrumentResolver:
    """Testable in-memory resolver mapping ISIN -> (canonical_symbol, instrument_key)."""

    def __init__(self, mapping: dict[str, tuple[str, str]] | None = None) -> None:
        self._mapping: dict[str, tuple[str, str]] = {}
        if mapping:
            for isin, (sym, key) in mapping.items():
                self.register(isin, sym, key)

    def register(self, isin: str, canonical_symbol: str, instrument_key: str) -> None:
        norm_isin = isin.strip().upper()
        norm_sym = canonical_symbol.strip().upper()
        norm_key = instrument_key.strip()
        self._mapping[norm_isin] = (norm_sym, norm_key)

    def resolve_by_isin(self, isin: str) -> tuple[str, str] | None:
        if not isin or not isin.strip():
            return None
        return self._mapping.get(isin.strip().upper())


# --- Column Header Matchers ---

_HEADER_PATTERNS = {
    "rank": [
        "sr. no.",
        "sr.no.",
        "sr no",
        "sr_no",
        "rank",
        "serial no",
        "serial number",
        "s.no",
        "s no",
    ],
    "company_name": [
        "company name",
        "company",
        "issuer name",
        "name of the company",
        "security name",
        "issuer",
    ],
    "isin": [
        "isin",
        "isin code",
        "isin number",
        "isin_number",
        "isin_code",
    ],
    "source_symbol": [
        "nse symbol",
        "symbol",
        "trading symbol",
        "nse_symbol",
        "tradingsymbol",
        "ticker",
    ],
    "category": [
        "categorisation",
        "categorization",
        "category",
        "market cap category",
        "cap category",
        "segment",
    ],
}


def _normalize_header(header: str) -> str:
    """Clean header text for case-insensitive, punctuation-insensitive matching."""
    cleaned = header.strip().lower()
    cleaned = re.sub(r"[\s_]+", " ", cleaned)
    return cleaned


def _detect_column_mapping(headers: list[str]) -> dict[str, int]:
    """Identify the zero-based indices of required and optional columns.

    Raises UniverseFormatError if required columns cannot be found unambiguously.
    """
    mapping: dict[str, int] = {}
    normalized_headers = [_normalize_header(h) for h in headers]

    for col_key, candidates in _HEADER_PATTERNS.items():
        found_idx = None
        for idx, h in enumerate(normalized_headers):
            if any(h == c or h.startswith(c) for c in candidates):
                found_idx = idx
                break
        if found_idx is not None:
            mapping[col_key] = found_idx

    # Verify essential columns
    missing = [col for col in ["rank", "company_name", "isin", "source_symbol"] if col not in mapping]
    if missing:
        raise UniverseFormatError(
            f"Unable to detect required columns {missing} from headers: {headers}. "
            "Headers must unambiguously identify Rank, Company Name, ISIN, and Symbol."
        )

    return mapping


# --- Universe Ingestion Pipeline ---


class UniverseIngestService:
    """Validates raw source datasets and compiles authenticated LargeCapUniverse artifacts."""

    def __init__(self, resolver: InstrumentResolver) -> None:
        self.resolver = resolver

    @staticmethod
    def compute_sha256(raw_bytes: bytes) -> str:
        """Compute standard SHA-256 hex digest for cryptographic artifact verification."""
        return hashlib.sha256(raw_bytes).hexdigest()

    def parse_csv_content(self, content_str: str) -> list[dict[str, str]]:
        """Parse raw CSV text, identify headers, and return normalized rows."""
        lines = [line for line in content_str.splitlines() if line.strip()]
        if not lines:
            raise UniverseFormatError("Input CSV file is empty.")

        reader = csv.reader(lines)
        try:
            raw_headers = next(reader)
        except StopIteration as exc:
            raise UniverseFormatError("CSV has no header row.") from exc

        col_mapping = _detect_column_mapping(raw_headers)
        rows: list[dict[str, str]] = []

        for row_num, row in enumerate(reader, start=2):
            if not row or all(not cell.strip() for cell in row):
                continue

            # Extract fields
            def get_col(field_key: str) -> str:
                idx = col_mapping.get(field_key)
                if idx is not None and idx < len(row):
                    return row[idx].strip()
                return ""

            extracted = {
                "rank": get_col("rank"),
                "company_name": get_col("company_name"),
                "isin": get_col("isin"),
                "source_symbol": get_col("source_symbol"),
                "category": get_col("category"),
            }
            rows.append(extracted)

        return rows

    def filter_large_cap_rows(self, raw_rows: list[dict[str, str]]) -> list[dict[str, str]]:
        """Filter the exact large-cap constituents from the dataset.

        Supports both dedicated 100-stock files and broader classification files.
        """
        if not raw_rows:
            raise UniverseFormatError("No data rows found in input file.")

        has_category_data = any(bool(r.get("category")) for r in raw_rows)

        if has_category_data:
            # Filter explicit 'Large Cap' categorization
            large_cap_rows = [
                r for r in raw_rows
                if r.get("category", "").strip().lower() in ("large cap", "largecap", "large-cap")
            ]
            if not large_cap_rows:
                raise UniverseIntegrityError(
                    "Broader classification file contains category column but zero 'Large Cap' records were matched."
                )
            return large_cap_rows

        # Pure constituent file: return all non-empty rows
        return raw_rows

    def validate_and_compile(
        self,
        raw_bytes: bytes,
        source_name: str,
        source_period_label: str,
        classification_period: str,
        effective_from: date,
        effective_to: date,
        dataset_version: str,
        source_reference: str,
    ) -> LargeCapUniverse:
        """Validate input data and compile the authoritative LargeCapUniverse object.

        Enforces all structural, numerical, identifier, and instrument-mapping invariants.
        """
        if effective_from > effective_to:
            raise UniverseIntegrityError(
                f"Invalid validity range: effective_from ({effective_from}) cannot be after effective_to ({effective_to})."
            )

        sha256_checksum = self.compute_sha256(raw_bytes)

        # Decode content with UTF-8 / UTF-8-sig / Latin-1 fallbacks
        try:
            content_str = raw_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                content_str = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    content_str = raw_bytes.decode("latin-1")
                except Exception as exc:
                    raise UniverseFormatError(f"Unable to decode input file text: {exc}") from exc

        # 1. Parse CSV
        raw_rows = self.parse_csv_content(content_str)

        # 2. Filter Large Cap records
        filtered_rows = self.filter_large_cap_rows(raw_rows)

        # 3. Exact 100-constituent count rule
        if len(filtered_rows) != 100:
            raise UniverseIntegrityError(
                f"Expected exactly 100 large-cap constituents, found {len(filtered_rows)}."
            )

        # 4. Invariants checking
        constituents: list[UniverseConstituent] = []
        seen_ranks: set[int] = set()
        seen_isins: set[str] = set()
        seen_canonical_symbols: set[str] = set()
        seen_instrument_keys: set[str] = set()

        for idx, row in enumerate(filtered_rows, start=1):
            rank_str = row.get("rank", "")
            company_name = row.get("company_name", "").strip()
            isin_str = row.get("isin", "").strip().upper()
            source_symbol = row.get("source_symbol", "").strip().upper()

            # Company name and source symbol non-empty
            if not company_name:
                raise UniverseIntegrityError(f"Row {idx}: Company name cannot be empty.")
            if not source_symbol:
                raise UniverseIntegrityError(f"Row {idx} ({company_name}): Source symbol cannot be empty.")

            # Rank parsing and range
            try:
                rank = int(rank_str)
            except (ValueError, TypeError) as exc:
                raise UniverseIntegrityError(
                    f"Row {idx} ({company_name}): Invalid non-integer rank '{rank_str}'."
                ) from exc

            if rank < 1 or rank > 100:
                raise UniverseIntegrityError(
                    f"Row {idx} ({company_name}): Rank {rank} is outside the valid 1-100 large-cap range."
                )

            if rank in seen_ranks:
                raise UniverseIntegrityError(
                    f"Duplicate rank {rank} detected for '{company_name}'. Ranks 1 to 100 must be unique."
                )
            seen_ranks.add(rank)

            # ISIN validation
            if not ISIN_PATTERN.match(isin_str):
                raise UniverseIntegrityError(
                    f"Row {idx} ({company_name}): Malformed ISIN '{isin_str}'. Expected 12-char Indian ISIN (e.g. 'INE002A01018')."
                )

            if isin_str in seen_isins:
                raise UniverseIntegrityError(
                    f"Duplicate ISIN '{isin_str}' detected for '{company_name}'. All constituents must have unique ISINs."
                )
            seen_isins.add(isin_str)

            # Instrument mapping resolution
            resolved = self.resolver.resolve_by_isin(isin_str)
            if not resolved:
                raise UniverseMappingError(
                    f"Constituent rank {rank} ('{company_name}', ISIN '{isin_str}') could not be resolved "
                    "in the Upstox NSE equity instrument master."
                )

            canonical_symbol, instrument_key = resolved
            canonical_symbol = canonical_symbol.strip().upper()
            instrument_key = instrument_key.strip()

            if not canonical_symbol:
                raise UniverseMappingError(
                    f"Constituent ISIN '{isin_str}' resolved to an empty canonical trading symbol."
                )
            if not instrument_key.startswith("NSE_EQ|"):
                raise UniverseMappingError(
                    f"Constituent ISIN '{isin_str}' mapped to invalid instrument key '{instrument_key}'. Must be in NSE_EQ segment."
                )

            if canonical_symbol in seen_canonical_symbols:
                raise UniverseMappingError(
                    f"Duplicate canonical NSE symbol '{canonical_symbol}' mapped for ISIN '{isin_str}'. "
                    "Multiple constituents cannot share the same canonical trading symbol."
                )
            seen_canonical_symbols.add(canonical_symbol)

            if instrument_key in seen_instrument_keys:
                raise UniverseMappingError(
                    f"Duplicate instrument key '{instrument_key}' mapped for ISIN '{isin_str}'."
                )
            seen_instrument_keys.add(instrument_key)

            constituent = UniverseConstituent(
                rank=rank,
                isin=isin_str,
                company_name=company_name,
                source_symbol=source_symbol,
                canonical_nse_symbol=canonical_symbol,
                upstox_instrument_key=instrument_key,
                is_tradable=True,
            )
            constituents.append(constituent)

        # Contiguous rank completeness: 1 to 100 with zero gaps
        expected_ranks = set(range(1, 101))
        if seen_ranks != expected_ranks:
            missing = sorted(expected_ranks - seen_ranks)
            raise UniverseIntegrityError(
                f"Missing ranks in large-cap universe: {missing}. Ranks 1 to 100 must be completely contiguous."
            )

        # Sort constituents strictly by rank ascending
        constituents.sort(key=lambda c: c.rank)

        metadata = UniverseMetadata(
            dataset_version=dataset_version,
            source_name=source_name,
            source_period_label=source_period_label,
            classification_period=classification_period,
            effective_from=effective_from,
            effective_to=effective_to,
            source_reference=source_reference,
            sha256_checksum=sha256_checksum,
            verified_at=datetime.now(timezone.utc),
            constituent_count=100,
        )

        return LargeCapUniverse(metadata=metadata, constituents=constituents)


# --- Atomic Artifact Storage ---


def save_universe_artifact(
    universe: LargeCapUniverse,
    target_path: Path | str,
    create_manifest: bool = True,
) -> Path:
    """Save LargeCapUniverse to JSON atomically with an optional sidecar manifest.

    Guarantees that an existing valid artifact is never corrupted or partially overwritten on failure.
    """
    path = Path(target_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Temporary file in the same directory to ensure atomic cross-device rename
    temp_path = path.parent / f"{path.name}.tmp.{uuid.uuid4().hex[:8]}"

    try:
        # Pydantic JSON dump with camelCase aliases for interoperability
        json_data = universe.model_dump_json(by_alias=True, indent=2)
        json_bytes = json_data.encode("utf-8")
        with open(temp_path, "wb") as f:
            f.write(json_bytes)
            f.flush()
            os.fsync(f.fileno())

        # Atomic replacement
        os.replace(temp_path, path)
        logger.info("Atomically saved validated universe artifact to %s", path)

        if create_manifest:
            artifact_sha256 = hashlib.sha256(json_bytes).hexdigest()
            manifest_data = {
                "artifactFile": path.name,
                "artifactSha256": artifact_sha256,
                "sourceFileSha256": universe.metadata.sha256_checksum,
                "datasetVersion": universe.metadata.dataset_version,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            }
            manifest_path = path.parent / f"{path.name}.manifest.json"
            temp_manifest = path.parent / f"{manifest_path.name}.tmp.{uuid.uuid4().hex[:8]}"
            with open(temp_manifest, "w", encoding="utf-8") as mf:
                json.dump(manifest_data, mf, indent=2)
                mf.flush()
                os.fsync(mf.fileno())
            os.replace(temp_manifest, manifest_path)

        return path
    except Exception:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass
        raise


# --- Sidecar Manifest Utilities ---


def get_manifest_path(artifact_path: Path | str) -> Path:
    """Derive standard sidecar manifest path for a given universe artifact path."""
    p = Path(artifact_path).resolve()
    return p.parent / f"{p.name}.manifest.json"


def verify_artifact_manifest(
    artifact_path: Path | str,
    raw_bytes: bytes,
) -> tuple[bool, str, dict[str, Any] | None]:
    """Verify artifact SHA-256 checksum against the required sidecar manifest.

    Note: Checksum comparison verifies file integrity against accidental corruption or
    unauthorized tampering on disk. It does not establish licensing permission,
    regulatory authorization, or source authenticity of the underlying classification data.

    Important: metadata.sha256_checksum represents the original input file (e.g. CSV).
    It must not be confused with or used as the checksum of the compiled JSON artifact.
    The compiled JSON artifact SHA-256 is checked exclusively against the sidecar manifest.
    """
    manifest_file = get_manifest_path(artifact_path)

    if not manifest_file.exists() or not manifest_file.is_file():
        return (
            False,
            f"Required sidecar manifest does not exist at path: '{manifest_file.name}'. "
            "A sidecar manifest is required for universe integrity verification.",
            None,
        )

    try:
        with open(manifest_file, "r", encoding="utf-8") as mf:
            manifest_data = json.load(mf)
    except Exception as exc:
        return False, f"Failed to read or parse sidecar manifest: {exc}", None

    if not isinstance(manifest_data, dict):
        return False, "Sidecar manifest must be a valid JSON object.", None

    expected_sha256 = manifest_data.get("artifactSha256")
    if not expected_sha256 or not isinstance(expected_sha256, str):
        return False, "Sidecar manifest missing required 'artifactSha256' field.", None

    manifest_version = manifest_data.get("datasetVersion")
    if not manifest_version or not isinstance(manifest_version, str):
        return False, "Sidecar manifest missing required 'datasetVersion' field.", None

    actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    if actual_sha256.lower() != expected_sha256.lower():
        return (
            False,
            f"Artifact checksum mismatch against sidecar manifest (expected {expected_sha256[:12]}..., got {actual_sha256[:12]}...). "
            "File on disk may have been tampered with or corrupted.",
            None,
        )

    return True, "", manifest_data


# --- Reusable Temporal Validity Evaluator ---


def evaluate_universe_status(
    universe_source: LargeCapUniverse | Path | str | None,
    as_of_date: date | None = None,
) -> UniverseStatusRead:
    """Evaluate whether a universe dataset is available, structurally sound, and temporally valid.

    Accepts an injected as_of_date to enable deterministic testing across date boundaries.
    """
    eval_date = as_of_date or datetime.now(timezone.utc).date()

    if universe_source is None:
        return UniverseStatusRead(
            is_available=False,
            is_valid_for_date=False,
            status="UNAVAILABLE",
            status_reason="Large-cap universe dataset is not configured or provided.",
        )

    universe: LargeCapUniverse

    if isinstance(universe_source, (Path, str)):
        file_path = Path(universe_source).resolve()
        if not file_path.exists() or not file_path.is_file():
            return UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="UNAVAILABLE",
                status_reason=f"Universe artifact does not exist at path: '{file_path.name}'.",
            )

        try:
            raw_bytes = file_path.read_bytes()
        except Exception as exc:
            return UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=f"Failed to read universe artifact bytes: {exc}",
            )

        # 1. Manifest / checksum verification
        integrity_ok, integrity_err, manifest_data = verify_artifact_manifest(file_path, raw_bytes)
        if not integrity_ok:
            return UniverseStatusRead(
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
            return UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=f"Universe artifact JSON parsing failed: {exc}",
            )

        # 3. Schema validation
        try:
            universe = LargeCapUniverse.model_validate(raw_json)
        except Exception as exc:
            return UniverseStatusRead(
                is_available=False,
                is_valid_for_date=False,
                status="INVALID",
                status_reason=f"Universe artifact schema validation failed: {exc}",
            )

        # 4. Manifest dataset version consistency check
        manifest_version = str(manifest_data.get("datasetVersion", "")).strip()
        if manifest_version != universe.metadata.dataset_version.strip():
            return UniverseStatusRead(
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
    elif isinstance(universe_source, LargeCapUniverse):
        universe = universe_source
    else:
        return UniverseStatusRead(
            is_available=False,
            is_valid_for_date=False,
            status="INVALID",
            status_reason="Unknown universe source type provided.",
        )

    # Integrity verification
    if universe.metadata.constituent_count != 100 or len(universe.constituents) != 100:
        return UniverseStatusRead(
            is_available=False,
            is_valid_for_date=False,
            status="INVALID",
            dataset_version=universe.metadata.dataset_version,
            classification_period=universe.metadata.classification_period,
            effective_from=universe.metadata.effective_from,
            effective_to=universe.metadata.effective_to,
            constituent_count=len(universe.constituents),
            status_reason=f"Corrupt constituent count: {len(universe.constituents)} (expected 100).",
        )

    meta = universe.metadata

    # Temporal boundary check
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
        status_reason=(
            f"Universe dataset '{meta.dataset_version}' ({meta.classification_period}) is active and valid for {eval_date}."
        ),
    )
