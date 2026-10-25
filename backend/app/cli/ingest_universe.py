"""Operator CLI utility for validating and ingesting an NSE Large-Cap Universe file."""

import argparse
import asyncio
from datetime import date
import logging
from pathlib import Path
import sys

from app.core.config import Settings
from app.services.market_data.tej import TejMarketDataProvider
from app.services.market_data.universe_ingest import (
    UniverseFormatError,
    UniverseIngestError,
    UniverseIngestService,
    UniverseIntegrityError,
    UniverseMappingError,
    save_universe_artifact,
)
from app.services.market_data.upstox import UpstoxMarketDataProvider

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ingest_universe")


def parse_date(date_str: str) -> date:
    """Parse YYYY-MM-DD date string."""
    try:
        return date.fromisoformat(date_str.strip())
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid date format '{date_str}'. Expected YYYY-MM-DD.") from exc


def build_parser() -> argparse.ArgumentParser:
    """Construct command-line argument parser."""
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.ingest_universe",
        description="Validate and compile an official NSE Large-Cap categorization file into a versioned JSON artifact.",
    )
    parser.add_argument(
        "--file",
        required=True,
        type=str,
        help="Path to the operator-supplied categorization CSV file.",
    )
    parser.add_argument(
        "--version",
        dest="dataset_version",
        default="AMFI-2026-H2-V1",
        type=str,
        help="Semantic or period version identifier (e.g. 'AMFI-2026-H2-V1').",
    )
    parser.add_argument(
        "--source-name",
        default="AMFI",
        type=str,
        help="Classification publishing body (default: 'AMFI').",
    )
    parser.add_argument(
        "--source-period",
        dest="source_period_label",
        default="July 2026 - December 2026",
        type=str,
        help="Exact classification period label stated by the source (e.g. 'July 2026 - December 2026').",
    )
    parser.add_argument(
        "--classification-period",
        default="JUL_DEC_2026",
        type=str,
        help="Standardized classification period code (e.g. 'JUL_DEC_2026').",
    )
    parser.add_argument(
        "--effective-from",
        default="2026-07-01",
        type=parse_date,
        help="Effective start date in YYYY-MM-DD format (default: 2026-07-01).",
    )
    parser.add_argument(
        "--effective-to",
        default="2026-12-31",
        type=parse_date,
        help="Effective end date in YYYY-MM-DD format (default: 2026-12-31).",
    )
    parser.add_argument(
        "--source-ref",
        dest="source_reference",
        default=None,
        type=str,
        help="Source file name or circular reference (defaults to input file basename).",
    )
    parser.add_argument(
        "--output",
        default=None,
        type=str,
        help="Path for compiled JSON artifact (defaults to 'backend/data/universe/nse_largecap_current.json').",
    )
    parser.add_argument(
        "--provider",
        dest="market_data_provider",
        default="upstox",
        choices=["upstox", "tej"],
        type=str,
        help="Market data provider for instrument resolution ('upstox' or 'tej', default: 'upstox').",
    )
    return parser


async def run_ingest(args: argparse.Namespace) -> int:
    """Execute the universe ingestion pipeline."""
    file_path = Path(args.file).resolve()
    if not file_path.exists() or not file_path.is_file():
        logger.error("Source file does not exist: %s", file_path)
        return 1

    source_reference = args.source_reference or file_path.name
    output_path = Path(args.output).resolve() if args.output else (Path(__file__).resolve().parents[2] / "data" / "universe" / "nse_largecap_current.json")

    logger.info("Reading source file: %s", file_path)
    try:
        raw_bytes = file_path.read_bytes()
    except Exception as exc:
        logger.error("Failed to read source file bytes: %s", exc)
        return 1

    sha256 = UniverseIngestService.compute_sha256(raw_bytes)
    logger.info("Input file SHA-256: %s", sha256)

    # Resolve provider for instrument resolution
    settings = Settings.from_environment()
    provider_type = (args.market_data_provider or settings.market_data_provider).strip().lower()

    if provider_type == "tej":
        logger.info("Initializing TejHQ provider for instrument resolution...")
        tej_provider = TejMarketDataProvider(settings=settings)
        await tej_provider.sync_partitions_if_needed()
        provider = tej_provider
    else:
        logger.info("Loading Upstox instrument master for instrument resolution...")
        upstox_provider = UpstoxMarketDataProvider(settings=settings)
        try:
            await upstox_provider.ensure_instrument_master_loaded()
        except Exception as exc:
            logger.error("Failed to load Upstox instrument master: %s", exc)
            return 1
        provider = upstox_provider

    ingest_service = UniverseIngestService(resolver=provider)

    try:
        logger.info("Validating format, ranks, ISINs, and instrument mappings...")
        universe = ingest_service.validate_and_compile(
            raw_bytes=raw_bytes,
            source_name=args.source_name,
            source_period_label=args.source_period_label,
            classification_period=args.classification_period,
            effective_from=args.effective_from,
            effective_to=args.effective_to,
            dataset_version=args.dataset_version,
            source_reference=source_reference,
        )
    except UniverseIntegrityError as exc:
        logger.error("Integrity check failed: %s", exc)
        return 1
    except UniverseMappingError as exc:
        logger.error("Instrument mapping failed: %s", exc)
        return 1
    except UniverseFormatError as exc:
        logger.error("Format validation failed: %s", exc)
        return 1
    except UniverseIngestError as exc:
        logger.error("Ingestion failed: %s", exc)
        return 1
    except Exception as exc:
        logger.error("Unexpected error during validation: %s", exc)
        return 1

    try:
        logger.info("Writing validated artifact atomically to %s...", output_path)
        saved_path = save_universe_artifact(universe, output_path)
    except Exception as exc:
        logger.error("Failed to save artifact atomically: %s", exc)
        return 1

    # Report detailed success summary
    print("\n" + "=" * 60)
    print("[SUCCESS] NSE LARGE-CAP UNIVERSE INGESTION SUCCESSFUL")
    print("=" * 60)
    print(f"Dataset Version       : {universe.metadata.dataset_version}")
    print(f"Source Publishing Body: {universe.metadata.source_name}")
    print(f"Source Period Label   : {universe.metadata.source_period_label}")
    print(f"Classification Period : {universe.metadata.classification_period}")
    print(f"Effective Validity    : {universe.metadata.effective_from} to {universe.metadata.effective_to}")
    print(f"Source Reference      : {universe.metadata.source_reference}")
    print(f"Source SHA-256 Checksum: {universe.metadata.sha256_checksum}")
    print(f"Verified At (UTC)     : {universe.metadata.verified_at.isoformat()}")
    print(f"Constituent Count     : {universe.metadata.constituent_count}")
    print(f"Artifact Destination  : {saved_path}")
    print("=" * 60 + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)
    return asyncio.run(run_ingest(args))


if __name__ == "__main__":
    sys.exit(main())
