"""Pydantic schemas for versioned NSE Large-Cap Universe contracts."""

from datetime import date, datetime
from typing import Annotated

from pydantic import Field, StringConstraints

from app.schemas.base import APIModel

# Strict Indian ISIN: 2-letter country code 'IN' followed by 9 alphanumeric chars and 1 check digit (total 12 chars)
IsinType = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_upper=True,
        pattern=r"^IN[A-Z0-9]{10}$",
        min_length=12,
        max_length=12,
    ),
]


class UniverseConstituent(APIModel):
    """A verified constituent company within the NSE Large-Cap universe."""

    rank: int = Field(
        ...,
        ge=1,
        le=100,
        description="Official rank within the large-cap universe (1 to 100)",
    )
    isin: IsinType = Field(
        ...,
        description="12-character International Securities Identification Number",
    )
    company_name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Official legal name of the issuer company",
    )
    source_symbol: str = Field(
        ...,
        min_length=1,
        max_length=30,
        description="Exchange or classification symbol as stated in the source file",
    )
    canonical_nse_symbol: str = Field(
        ...,
        min_length=1,
        max_length=30,
        description="Canonical NSE equity cash trading symbol verified in instrument master",
    )
    upstox_instrument_key: str = Field(
        ...,
        min_length=5,
        max_length=50,
        description="Upstox-compatible instrument identifier (e.g. 'NSE_EQ|INE002A01018')",
    )
    is_tradable: bool = Field(
        default=True,
        description="Whether the instrument is actively tradable in the NSE cash equity segment",
    )


class UniverseMetadata(APIModel):
    """Cryptographically verified metadata describing the classification source and validity."""

    dataset_version: str = Field(
        ...,
        min_length=3,
        max_length=50,
        description="Version identifier of this universe artifact (e.g. 'AMFI-2026-H2-V1')",
    )
    source_name: str = Field(
        default="AMFI",
        min_length=2,
        max_length=50,
        description="Entity publishing the categorization (e.g. 'AMFI')",
    )
    source_period_label: str = Field(
        ...,
        min_length=2,
        max_length=100,
        description="Exact classification period label as stated by the source (e.g. 'July 2026 - December 2026')",
    )
    classification_period: str = Field(
        ...,
        min_length=2,
        max_length=50,
        description="Standardized classification cycle code (e.g. 'JUL_DEC_2026')",
    )
    effective_from: date = Field(
        ...,
        description="Starting calendar date from which this categorization is valid",
    )
    effective_to: date = Field(
        ...,
        description="Ending calendar date through which this categorization is valid",
    )
    source_reference: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Original source file name, URL, or circular reference",
    )
    sha256_checksum: str = Field(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[a-fA-F0-9]{64}$",
        description="Cryptographic SHA-256 hash of the original input file",
    )
    verified_at: datetime = Field(
        ...,
        description="Timezone-aware UTC timestamp when this dataset was ingested and verified",
    )
    constituent_count: int = Field(
        default=100,
        ge=100,
        le=100,
        description="Total verified constituents in the large-cap universe (must be exactly 100)",
    )


class LargeCapUniverse(APIModel):
    """Complete, self-contained, version-locked NSE Large-Cap Universe dataset."""

    metadata: UniverseMetadata
    constituents: list[UniverseConstituent]


class UniverseStatusRead(APIModel):
    """Runtime availability, temporal validity, and integrity status of the Large-Cap Universe."""

    is_available: bool = Field(
        ...,
        description="True only if a valid large-cap universe dataset is installed and readable",
    )
    is_valid_for_date: bool = Field(
        ...,
        description="True only if the dataset is available, structurally valid, and within its effective dates",
    )
    status: str = Field(
        ...,
        description="High-level lifecycle status: 'VALID', 'EXPIRED', 'NOT_YET_ACTIVE', 'INVALID', or 'UNAVAILABLE'",
    )
    dataset_version: str | None = Field(
        default=None,
        description="Dataset version identifier if available",
    )
    source_period_label: str | None = Field(
        default=None,
        description="Exact source period label if available (e.g. 'July 2026 - December 2026')",
    )
    classification_period: str | None = Field(
        default=None,
        description="Standardized classification period code if available",
    )
    effective_from: date | None = Field(
        default=None,
        description="Start date of classification validity if available",
    )
    effective_to: date | None = Field(
        default=None,
        description="End date of classification validity if available",
    )
    constituent_count: int = Field(
        default=0,
        description="Number of verified constituents in the dataset",
    )
    status_reason: str = Field(
        ...,
        description="Human-readable explanation of the universe status and any warnings",
    )


class UniverseManifest(APIModel):
    """Sidecar manifest schema for cryptographic integrity verification of a universe artifact.

    Note: Checksum comparison verifies file integrity against accidental corruption or
    unauthorized tampering on disk. It does not establish licensing permission,
    regulatory authorization, or source authenticity of the underlying classification data.

    Important: metadata.sha256_checksum represents the original input file (e.g. CSV).
    It must not be confused with or used as the checksum of the compiled JSON artifact.
    The compiled JSON artifact SHA-256 is checked exclusively against this sidecar manifest.
    """

    artifact_file: str = Field(
        ...,
        min_length=1,
        description="File name of the compiled JSON universe artifact",
    )
    artifact_sha256: str = Field(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[a-fA-F0-9]{64}$",
        description="Cryptographic SHA-256 hash of the compiled JSON artifact",
    )
    source_file_sha256: str = Field(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[a-fA-F0-9]{64}$",
        description="Cryptographic SHA-256 hash of original source input file (matches metadata.sha256_checksum)",
    )
    dataset_version: str = Field(
        ...,
        min_length=3,
        max_length=50,
        description="Version identifier of this universe dataset matching universe metadata",
    )
    generated_at: datetime = Field(
        ...,
        description="Timezone-aware UTC timestamp when this artifact and manifest were generated",
    )


class ConstituentScreenResultRead(APIModel):
    """Screening evaluation result for a single large-cap universe constituent."""

    rank: int = Field(..., ge=1, le=100, description="Rank within the large-cap universe (1 to 100)")
    company_name: str = Field(..., description="Official legal name of the issuer company")
    isin: str = Field(..., description="12-character ISIN")
    canonical_nse_symbol: str = Field(..., description="Canonical NSE equity cash trading symbol")
    upstox_instrument_key: str = Field(..., description="Provider instrument identifier (e.g. 'NSE_EQ|INE002A01018')")
    last_price: float | None = Field(default=None, description="Latest reference price if quote available")
    quote_timestamp: datetime | None = Field(default=None, description="Trade execution timestamp of quote")
    twenty_week_sma: float | None = Field(default=None, description="20-week SMA from completed weekly candles")
    weekly_rsi: float | None = Field(default=None, description="14-period Wilder's RSI from completed weekly candles")
    latest_completed_candle_date: date | None = Field(default=None, description="Closing session date of latest completed weekly candle")
    is_stale: bool = Field(default=False, description="Whether the quote is considered stale")
    is_qualified: bool = Field(..., description="True only if weekly RSI > 60 with fresh, valid market data")
    diagnostic_status: str = Field(
        ...,
        description="Status code: 'QUALIFIED', 'NOT_QUALIFIED', 'STALE_QUOTE', 'INSUFFICIENT_HISTORY', 'INDICATORS_UNAVAILABLE', 'QUOTE_UNAVAILABLE', 'PROVIDER_ERROR'",
    )
    diagnostic_reason: str | None = Field(default=None, description="Safe diagnostic explanation without sensitive provider details")


class UniverseScreenResponse(APIModel):
    """Authoritative response schema for bulk universe screening."""

    universe_version: str = Field(..., description="Dataset version of the screened universe")
    classification_period: str = Field(..., description="Classification period code")
    source_period_label: str | None = Field(default=None, description="Source period label")
    evaluated_at: datetime = Field(..., description="Timestamp when screening was evaluated")
    total_constituents: int = Field(..., description="Total constituents evaluated in the universe")
    qualified_count: int = Field(..., description="Count of constituents that qualified (RSI > 60)")
    results: list[ConstituentScreenResultRead] = Field(..., description="Constituent results ordered by rank")
    market_data_source: str = Field(
        default="TEJHQ",
        description="Authoritative market data provider identifier (e.g. 'TEJHQ', 'UPSTOX')",
    )


