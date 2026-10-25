"""Automated tests for Phase 5A: Large-Cap Universe ingestion, validation, and temporal evaluation."""

from datetime import date, datetime, timezone
import io
import json
import os
from pathlib import Path
import pytest

from app.schemas.universe import (
    LargeCapUniverse,
    UniverseConstituent,
    UniverseMetadata,
    UniverseStatusRead,
)
from app.services.market_data.universe_ingest import (
    DictInstrumentResolver,
    UniverseFormatError,
    UniverseIngestService,
    UniverseIntegrityError,
    UniverseMappingError,
    evaluate_universe_status,
    save_universe_artifact,
)


def generate_synthetic_rows(
    count: int = 100,
    with_category: bool = False,
    category_val: str = "Large Cap",
    start_rank: int = 1,
) -> list[dict[str, str]]:
    """Helper to generate valid synthetic constituent rows."""
    rows: list[dict[str, str]] = []
    for i in range(start_rank, start_rank + count):
        # Deterministic 12-char ISIN: e.g. INE000000001 to INE000000100
        isin = f"INE{i:09d}"
        symbol = f"SYNTH{i}"
        row = {
            "sr_no": str(i),
            "company_name": f"Synthetic Company {i} Ltd",
            "isin": isin,
            "nse_symbol": symbol,
        }
        if with_category:
            row["category"] = category_val
        rows.append(row)
    return rows


def rows_to_csv_bytes(rows: list[dict[str, str]], custom_headers: list[str] | None = None) -> bytes:
    """Format dictionary rows into CSV byte content."""
    output = io.StringIO()
    if not rows:
        return b""
    headers = custom_headers or list(rows[0].keys())
    # Capitalize headers to simulate real spreadsheet headers
    header_line = ",".join(h.replace("_", " ").title() for h in headers)
    output.write(header_line + "\n")
    for r in rows:
        output.write(",".join(str(r.get(h, "")) for h in headers) + "\n")
    return output.getvalue().encode("utf-8")


def create_synthetic_resolver(count: int = 100, start_rank: int = 1) -> DictInstrumentResolver:
    """Create a mock resolver mapping synthetic ISINs to canonical symbols and Upstox keys."""
    resolver = DictInstrumentResolver()
    for i in range(start_rank, start_rank + count):
        isin = f"INE{i:09d}"
        symbol = f"SYNTH{i}"
        key = f"NSE_EQ|{isin}"
        resolver.register(isin, symbol, key)
    return resolver


# --- Unit & Integration Tests ---


def test_valid_synthetic_100_constituent_dataset():
    """Verify that a compliant 100-constituent synthetic dataset validates and compiles cleanly."""
    rows = generate_synthetic_rows(100)
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    universe = service.validate_and_compile(
        raw_bytes=csv_bytes,
        source_name="AMFI",
        source_period_label="July 2026 - December 2026",
        classification_period="JUL_DEC_2026",
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
        dataset_version="AMFI-2026-H2-V1",
        source_reference="synthetic_test.csv",
    )

    assert isinstance(universe, LargeCapUniverse)
    assert universe.metadata.constituent_count == 100
    assert len(universe.constituents) == 100
    assert universe.metadata.dataset_version == "AMFI-2026-H2-V1"
    assert universe.metadata.classification_period == "JUL_DEC_2026"
    assert universe.metadata.sha256_checksum == service.compute_sha256(csv_bytes)

    # First and last constituents
    assert universe.constituents[0].rank == 1
    assert universe.constituents[0].isin == "INE000000001"
    assert universe.constituents[0].canonical_nse_symbol == "SYNTH1"
    assert universe.constituents[0].upstox_instrument_key == "NSE_EQ|INE000000001"

    assert universe.constituents[99].rank == 100
    assert universe.constituents[99].isin == "INE000000100"
    assert universe.constituents[99].canonical_nse_symbol == "SYNTH100"


@pytest.mark.parametrize("invalid_count", [99, 101, 50, 1])
def test_reject_non_100_constituent_counts(invalid_count: int):
    """Verify that datasets with anything other than exactly 100 constituents are strictly rejected."""
    rows = generate_synthetic_rows(invalid_count)
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(max(invalid_count, 1))
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseIntegrityError, match=r"Expected exactly 100 large-cap constituents"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="July 2026 - December 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_empty_csv_file():
    """Verify that completely empty or header-only CSV files trigger UniverseFormatError."""
    resolver = create_synthetic_resolver(1)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseFormatError, match=r"Input CSV file is empty"):
        service.validate_and_compile(
            raw_bytes=b"",
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="empty.csv",
        )

    # Header-only CSV
    header_only = b"Sr. No.,Company Name,ISIN,NSE Symbol\n"
    with pytest.raises(UniverseFormatError, match=r"No data rows found in input file"):
        service.validate_and_compile(
            raw_bytes=header_only,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="header_only.csv",
        )


def test_reject_duplicate_ranks():
    """Verify that duplicate ranks trigger UniverseIntegrityError."""
    rows = generate_synthetic_rows(100)
    # Duplicate rank 5 at index 10 (rank 11 becomes rank 5)
    rows[10]["sr_no"] = "5"
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseIntegrityError, match=r"Duplicate rank 5 detected"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_missing_rank_gaps():
    """Verify that gaps in ranks (e.g. 1-99 and 101) trigger UniverseIntegrityError."""
    rows = generate_synthetic_rows(99)
    # Add 101st as the 100th row (missing rank 100)
    rows.append({
        "sr_no": "101",
        "company_name": "Gap Company Ltd",
        "isin": "INE000000101",
        "nse_symbol": "GAP101",
    })
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(102)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseIntegrityError, match=r"Rank 101 is outside the valid 1-100 large-cap range|Missing ranks"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_duplicate_isin():
    """Verify that duplicate ISINs trigger UniverseIntegrityError."""
    rows = generate_synthetic_rows(100)
    # Give row 50 the same ISIN as row 1
    rows[49]["isin"] = rows[0]["isin"]
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseIntegrityError, match=r"Duplicate ISIN 'INE000000001' detected"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_duplicate_canonical_symbol():
    """Verify that multiple constituents resolving to the same canonical NSE symbol trigger UniverseMappingError."""
    rows = generate_synthetic_rows(100)
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    # Map row 2's ISIN to the same symbol as row 1 ("SYNTH1")
    resolver.register("INE000000002", "SYNTH1", "NSE_EQ|INE000000002")
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseMappingError, match=r"Duplicate canonical NSE symbol 'SYNTH1' mapped"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_malformed_isin():
    """Verify that malformed or non-Indian ISINs trigger UniverseIntegrityError."""
    rows = generate_synthetic_rows(100)
    # Invalid ISIN (starts with US and is 11 chars)
    rows[5]["isin"] = "US123456789"
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseIntegrityError, match=r"Malformed ISIN 'US123456789'"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_missing_company_name():
    """Verify that empty company names trigger UniverseIntegrityError."""
    rows = generate_synthetic_rows(100)
    rows[15]["company_name"] = "   "
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseIntegrityError, match=r"Company name cannot be empty"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_reject_ambiguous_or_missing_headers():
    """Verify that missing critical header columns triggers UniverseFormatError."""
    rows = generate_synthetic_rows(100)
    # Custom headers missing ISIN column
    custom_headers = ["sr_no", "company_name", "nse_symbol"]
    csv_bytes = rows_to_csv_bytes(rows, custom_headers=custom_headers)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseFormatError, match=r"Unable to detect required columns.*isin"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_broader_classification_file_filters_exactly_100_large_caps():
    """Verify that a broader file (e.g. 250 stocks with Large, Mid, Small Cap) correctly filters exactly 100 Large Caps."""
    large_caps = generate_synthetic_rows(100, with_category=True, category_val="Large Cap", start_rank=1)
    mid_caps = generate_synthetic_rows(50, with_category=True, category_val="Mid Cap", start_rank=101)
    small_caps = generate_synthetic_rows(50, with_category=True, category_val="Small Cap", start_rank=151)
    all_rows = large_caps + mid_caps + small_caps

    csv_bytes = rows_to_csv_bytes(all_rows)
    resolver = create_synthetic_resolver(200)
    service = UniverseIngestService(resolver)

    universe = service.validate_and_compile(
        raw_bytes=csv_bytes,
        source_name="AMFI",
        source_period_label="July 2026 - December 2026",
        classification_period="JUL_DEC_2026",
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
        dataset_version="AMFI-2026-H2-V1",
        source_reference="broader_classification.csv",
    )

    assert universe.metadata.constituent_count == 100
    assert len(universe.constituents) == 100
    assert universe.constituents[0].rank == 1
    assert universe.constituents[99].rank == 100


def test_failed_instrument_resolution():
    """Verify that unresolvable constituents raise UniverseMappingError without inventing IDs."""
    rows = generate_synthetic_rows(100)
    csv_bytes = rows_to_csv_bytes(rows)
    # Resolver is only aware of 99 constituents
    resolver = create_synthetic_resolver(99)
    service = UniverseIngestService(resolver)

    with pytest.raises(UniverseMappingError, match=r"could not be resolved in the Upstox NSE equity instrument master"):
        service.validate_and_compile(
            raw_bytes=csv_bytes,
            source_name="AMFI",
            source_period_label="H2 2026",
            classification_period="JUL_DEC_2026",
            effective_from=date(2026, 7, 1),
            effective_to=date(2026, 12, 31),
            dataset_version="TEST-V1",
            source_reference="test.csv",
        )


def test_checksum_calculation_and_verification():
    """Verify that SHA-256 calculation is deterministic and matches expected file digest."""
    rows = generate_synthetic_rows(100)
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    universe = service.validate_and_compile(
        raw_bytes=csv_bytes,
        source_name="AMFI",
        source_period_label="H2 2026",
        classification_period="JUL_DEC_2026",
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
        dataset_version="TEST-V1",
        source_reference="test.csv",
    )

    import hashlib
    expected_hash = hashlib.sha256(csv_bytes).hexdigest()
    assert universe.metadata.sha256_checksum == expected_hash


def test_temporal_validity_evaluation(tmp_path: Path):
    """Verify that evaluate_universe_status correctly evaluates UNAVAILABLE, NOT_YET_ACTIVE, VALID, EXPIRED, and INVALID states."""
    rows = generate_synthetic_rows(100)
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)

    universe = service.validate_and_compile(
        raw_bytes=csv_bytes,
        source_name="AMFI",
        source_period_label="July 2026 - December 2026",
        classification_period="JUL_DEC_2026",
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
        dataset_version="AMFI-2026-H2-V1",
        source_reference="test.csv",
    )

    artifact_file = tmp_path / "nse_largecap_current.json"
    save_universe_artifact(universe, artifact_file)

    # 1. Missing dataset -> UNAVAILABLE
    missing_status = evaluate_universe_status(tmp_path / "non_existent.json", as_of_date=date(2026, 10, 25))
    assert missing_status.status == "UNAVAILABLE"
    assert not missing_status.is_available
    assert not missing_status.is_valid_for_date

    # 2. Evaluation before effective_from -> NOT_YET_ACTIVE
    early_status = evaluate_universe_status(artifact_file, as_of_date=date(2026, 6, 15))
    assert early_status.status == "NOT_YET_ACTIVE"
    assert early_status.is_available is True
    assert early_status.is_valid_for_date is False
    assert "not yet active" in early_status.status_reason

    # 3. Evaluation within effective window -> VALID
    valid_status = evaluate_universe_status(artifact_file, as_of_date=date(2026, 10, 25))
    assert valid_status.status == "VALID"
    assert valid_status.is_available is True
    assert valid_status.is_valid_for_date is True
    assert valid_status.constituent_count == 100

    # 4. Evaluation after effective_to -> EXPIRED
    expired_status = evaluate_universe_status(artifact_file, as_of_date=date(2027, 1, 15))
    assert expired_status.status == "EXPIRED"
    assert expired_status.is_available is True
    assert expired_status.is_valid_for_date is False
    assert "expired" in expired_status.status_reason

    # 5. Corrupted/invalid JSON artifact -> INVALID
    corrupted_file = tmp_path / "corrupted.json"
    corrupted_file.write_text("{ broken_json: [", encoding="utf-8")
    invalid_status = evaluate_universe_status(corrupted_file, as_of_date=date(2026, 10, 25))
    assert invalid_status.status == "INVALID"
    assert invalid_status.is_available is False
    assert invalid_status.is_valid_for_date is False


def test_atomic_write_preserves_existing_artifact_on_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Verify that failure during writing leaves the original artifact completely intact."""
    artifact_path = tmp_path / "universe.json"
    artifact_path.write_text('{"original": "unmodified"}', encoding="utf-8")

    rows = generate_synthetic_rows(100)
    csv_bytes = rows_to_csv_bytes(rows)
    resolver = create_synthetic_resolver(100)
    service = UniverseIngestService(resolver)
    universe = service.validate_and_compile(
        raw_bytes=csv_bytes,
        source_name="AMFI",
        source_period_label="H2 2026",
        classification_period="JUL_DEC_2026",
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
        dataset_version="TEST-V1",
        source_reference="test.csv",
    )

    def mock_replace(src, dst):
        raise OSError("Simulated disk replacement failure")

    monkeypatch.setattr(os, "replace", mock_replace)

    with pytest.raises(OSError, match=r"Simulated disk replacement failure"):
        save_universe_artifact(universe, artifact_path)

    # The existing artifact must remain completely unchanged
    assert artifact_path.read_text(encoding="utf-8") == '{"original": "unmodified"}'


def test_gitignore_excludes_operator_supplied_data():
    """Verify that root and backend .gitignore files exclude operator-supplied universe artifacts and spreadsheets."""
    root_gitignore = Path(__file__).resolve().parents[2] / ".gitignore"
    assert root_gitignore.exists(), "Root .gitignore must exist"

    content = root_gitignore.read_text(encoding="utf-8")
    assert "backend/data/" in content or "data/" in content
    assert "*.xlsx" in content
    assert "*.xls" in content

    backend_gitignore = Path(__file__).resolve().parents[1] / ".gitignore"
    if backend_gitignore.exists():
        backend_content = backend_gitignore.read_text(encoding="utf-8")
        assert "data/" in backend_content


def test_cli_ingest_universe_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Verify that the operator CLI command compiles a valid artifact and reports exit code 0."""
    from app.cli.ingest_universe import main
    from app.services.market_data.upstox import UpstoxMarketDataProvider

    rows = generate_synthetic_rows(100)
    input_csv = tmp_path / "synthetic_universe.csv"
    input_csv.write_bytes(rows_to_csv_bytes(rows))

    output_json = tmp_path / "compiled_universe.json"

    # Mock UpstoxMarketDataProvider to avoid network calls during CLI test
    async def mock_ensure_master(self):
        self._isin_to_instrument = {f"INE{i:09d}": f"NSE_EQ|INE{i:09d}" for i in range(1, 101)}
        self._instrument_to_symbol = {f"NSE_EQ|INE{i:09d}": f"SYNTH{i}" for i in range(1, 101)}
        self._instruments_loaded = True

    monkeypatch.setattr(UpstoxMarketDataProvider, "ensure_instrument_master_loaded", mock_ensure_master)

    exit_code = main([
        "--file", str(input_csv),
        "--version", "AMFI-2026-H2-V1",
        "--source-period", "July 2026 - December 2026",
        "--classification-period", "JUL_DEC_2026",
        "--effective-from", "2026-07-01",
        "--effective-to", "2026-12-31",
        "--output", str(output_json),
    ])

    assert exit_code == 0
    assert output_json.exists()
    data = json.loads(output_json.read_text(encoding="utf-8"))
    assert data["metadata"]["datasetVersion"] == "AMFI-2026-H2-V1"
    assert len(data["constituents"]) == 100
    assert data["constituents"][0]["canonicalNseSymbol"] == "SYNTH1"
