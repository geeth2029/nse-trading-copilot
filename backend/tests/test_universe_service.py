"""Automated tests for Phase 5B: Large-Cap Universe Service and Authenticated Endpoints."""

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.schemas.market_data import MarketSnapshotRead
from app.schemas.universe import (
    LargeCapUniverse,
    UniverseConstituent,
    UniverseManifest,
    UniverseMetadata,
    UniverseStatusRead,
)
from app.services.market_data.base import (
    MarketDataProvider,
    MarketQuote,
    WeeklyCandle,
)
from app.services.market_data.service import MarketDataService
from app.services.market_data.universe_ingest import (
    evaluate_universe_status,
    save_universe_artifact,
)
from app.services.market_data.universe_service import (
    UniverseNotAvailableError,
    UniverseService,
)
from tests.conftest import upgrade_database
from tests.factories import add_user


def generate_synthetic_universe(
    effective_from: date = date(2026, 7, 1),
    effective_to: date = date(2026, 12, 31),
    dataset_version: str = "2026-H2-v1",
    classification_period: str = "July - December 2026",
    source_period_label: str = "July - December 2026",
    constituent_count: int = 100,
    start_rank: int = 1,
) -> LargeCapUniverse:
    """Generate a valid synthetic LargeCapUniverse schema instance."""
    constituents: list[UniverseConstituent] = []
    for rank in range(start_rank, start_rank + constituent_count):
        isin = f"INE{rank:09d}"
        symbol = f"SYNTH{rank}"
        constituents.append(
            UniverseConstituent(
                rank=rank,
                isin=isin,
                company_name=f"Synthetic Co {rank} Ltd",
                source_symbol=symbol,
                canonical_nse_symbol=symbol,
                upstox_instrument_key=f"NSE_EQ|{isin}",
            )
        )

    metadata = UniverseMetadata(
        dataset_version=dataset_version,
        source_name="AMFI",
        source_period_label=source_period_label,
        classification_period=classification_period,
        effective_from=effective_from,
        effective_to=effective_to,
        source_reference="synthetic_amfi.csv",
        sha256_checksum="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        verified_at=datetime.now(timezone.utc),
        constituent_count=len(constituents),
    )
    return LargeCapUniverse(metadata=metadata, constituents=constituents)


def write_artifact_with_valid_manifest(
    artifact_path: Path,
    content: str | dict,
    dataset_version: str = "2026-H2-v1",
) -> None:
    """Helper to write artifact content alongside a valid matching sidecar manifest."""
    raw_str = content if isinstance(content, str) else json.dumps(content, indent=2)
    raw_bytes = raw_str.encode("utf-8")
    artifact_path.write_bytes(raw_bytes)
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    manifest_data = {
        "artifactFile": artifact_path.name,
        "artifactSha256": sha256,
        "sourceFileSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "datasetVersion": dataset_version,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    manifest_path = artifact_path.parent / f"{artifact_path.name}.manifest.json"
    manifest_path.write_bytes(json.dumps(manifest_data, indent=2).encode("utf-8"))


from decimal import Decimal


class DummyMarketDataProvider(MarketDataProvider):
    """Stub market data provider for snapshot independence testing."""

    async def get_instrument_identifier(self, symbol: str) -> str:
        return f"NSE_EQ|INE{symbol}"

    async def get_reference_quote(self, symbol: str) -> MarketQuote:
        return MarketQuote(
            symbol=symbol,
            instrument_identifier=f"NSE_EQ|INE{symbol}",
            last_price=Decimal("2500.00"),
            timestamp=datetime(2026, 10, 24, 15, 30, tzinfo=timezone.utc),
            source="UPSTOX",
            is_stale=False,
        )

    async def get_historical_weekly_candles(
        self,
        symbol: str,
        limit_weeks: int = 100,
    ) -> list[WeeklyCandle]:
        candles = []
        for i in range(25):
            c_date = date(2026, 1, 2) + timedelta(days=7 * i)
            candles.append(
                WeeklyCandle(
                    symbol=symbol,
                    candle_date=c_date,
                    open_price=Decimal(str(2000 + i * 10)),
                    high_price=Decimal(str(2100 + i * 10)),
                    low_price=Decimal(str(1950 + i * 10)),
                    close_price=Decimal(str(2050 + i * 10)),
                    volume=100000,
                    is_completed=True,
                )
            )
        return candles


@pytest.fixture
def test_app_and_client(tmp_path):
    """Create test application and client configured with temporary universe path."""
    db_file = tmp_path / "universe_test.db"
    database_url = f"sqlite:///{db_file.as_posix()}"
    upgrade_database(database_url)

    universe_file = tmp_path / "universe" / "nse_largecap_current.json"
    universe_file.parent.mkdir(parents=True, exist_ok=True)

    settings = Settings(
        database_url=database_url,
        registration_enabled=True,
        large_cap_universe_path=str(universe_file),
    )

    dummy_provider = DummyMarketDataProvider()
    md_service = MarketDataService(provider=dummy_provider)
    u_service = UniverseService(
        artifact_path=universe_file,
        clock=lambda: date(2026, 8, 15),
    )

    app = create_app(
        settings=settings,
        market_data_service=md_service,
        universe_service=u_service,
    )

    with TestClient(app, base_url="https://testserver") as client:
        yield client, u_service, universe_file, settings


def authenticate_client(client: TestClient, email: str = "trader@example.com") -> str:
    response = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": email, "password": "super-secure-password-123"},
    )
    assert response.status_code == 201
    return response.json()["id"]


# =========================================================================
# Scenario 1: Missing artifact returns UNAVAILABLE
# =========================================================================
def test_missing_artifact_returns_unavailable(tmp_path):
    missing_path = tmp_path / "does_not_exist.json"
    service = UniverseService(
        artifact_path=missing_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "UNAVAILABLE"
    assert status.is_available is False
    assert status.is_valid_for_date is False
    assert "does not exist" in status.status_reason

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "UNAVAILABLE"


# =========================================================================
# Scenario 2: Valid synthetic artifact returns VALID within effective dates
# =========================================================================
def test_valid_synthetic_artifact_returns_valid(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
    )
    save_universe_artifact(universe, artifact_path)

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "VALID"
    assert status.is_available is True
    assert status.is_valid_for_date is True
    assert status.dataset_version == "2026-H2-v1"
    assert status.constituent_count == 100
    assert status.classification_period == "July - December 2026"
    assert status.source_period_label == "July - December 2026"

    loaded_u = service.get_universe()
    assert loaded_u is not None
    assert len(loaded_u.constituents) == 100

    constituents = service.get_constituents()
    assert len(constituents) == 100
    assert constituents[0].rank == 1
    assert constituents[0].canonical_nse_symbol == "SYNTH1"


# =========================================================================
# Scenario 3: An expired artifact returns EXPIRED
# =========================================================================
def test_expired_artifact_returns_expired(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 30),
    )
    save_universe_artifact(universe, artifact_path)

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 7, 1),  # Day after effective_to
    )

    status = service.get_status()
    assert status.status == "EXPIRED"
    assert status.is_available is True
    assert status.is_valid_for_date is False
    assert "has expired" in status.status_reason

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "EXPIRED"


# =========================================================================
# Scenario 4: A future-dated artifact returns NOT_YET_ACTIVE
# =========================================================================
def test_future_dated_artifact_returns_not_yet_active(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 6, 30),
    )
    save_universe_artifact(universe, artifact_path)

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 12, 31),  # Day before effective_from
    )

    status = service.get_status()
    assert status.status == "NOT_YET_ACTIVE"
    assert status.is_available is True
    assert status.is_valid_for_date is False
    assert "not yet active" in status.status_reason

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "NOT_YET_ACTIVE"


# =========================================================================
# Scenario 5: Malformed JSON returns INVALID
# =========================================================================
def test_malformed_json_returns_invalid(tmp_path):
    artifact_path = tmp_path / "universe.json"
    write_artifact_with_valid_manifest(artifact_path, "{ this is not json at all }")

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "INVALID"
    assert status.is_available is False
    assert status.is_valid_for_date is False
    assert "JSON parsing failed" in status.status_reason


# =========================================================================
# Scenario 6: Tampered artifacts fail integrity verification
# =========================================================================
def test_tampered_artifact_fails_manifest_integrity(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    manifest_path = tmp_path / "universe.json.manifest.json"
    assert manifest_path.exists()

    # Tamper with the artifact content without updating manifest
    content = json.loads(artifact_path.read_text(encoding="utf-8"))
    content["constituents"][0]["company_name"] = "Tampered Corp"
    artifact_path.write_text(json.dumps(content), encoding="utf-8")

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "INVALID"
    assert status.is_available is False
    assert "checksum mismatch" in status.status_reason.lower()

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "INVALID"


def test_artifact_checksum_mismatch(tmp_path):
    """Manifest artifactSha256 does not match compiled JSON artifact bytes."""
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    manifest_path = tmp_path / "universe.json.manifest.json"
    manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    # Corrupt artifactSha256 hash in manifest
    manifest_data["artifactSha256"] = "f" * 64
    manifest_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "INVALID"
    assert status.is_available is False
    assert status.is_valid_for_date is False
    assert "checksum mismatch" in status.status_reason.lower()

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "INVALID"


# =========================================================================
# Sidecar Manifest Verification Tests
# =========================================================================
def test_missing_manifest_returns_invalid(tmp_path):
    """Artifact exists but required sidecar manifest is missing."""
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    # Save artifact directly without manifest
    artifact_path.write_text(universe.model_dump_json(indent=2), encoding="utf-8")

    manifest_path = tmp_path / "universe.json.manifest.json"
    if manifest_path.exists():
        manifest_path.unlink()

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "INVALID"
    assert status.is_available is False
    assert status.is_valid_for_date is False
    assert "Required sidecar manifest does not exist" in status.status_reason
    assert "manifest is required" in status.status_reason.lower()

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "INVALID"


def test_malformed_manifest_returns_invalid(tmp_path):
    """Manifest file is corrupted or not valid JSON."""
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    manifest_path = tmp_path / "universe.json.manifest.json"
    manifest_path.write_text("{ this is broken json manifest", encoding="utf-8")

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "INVALID"
    assert status.is_available is False
    assert status.is_valid_for_date is False
    assert "Failed to read or parse sidecar manifest" in status.status_reason

    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "INVALID"


def test_manifest_missing_required_fields_returns_invalid(tmp_path):
    """Manifest is valid JSON but misses required artifactSha256 or datasetVersion fields."""
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)
    manifest_path = tmp_path / "universe.json.manifest.json"

    # Missing artifactSha256
    manifest_path.write_text(json.dumps({"datasetVersion": "2026-H2-v1"}), encoding="utf-8")
    service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    status = service.get_status()
    assert status.status == "INVALID"
    assert "missing required 'artifactSha256'" in status.status_reason

    # Missing datasetVersion
    sha256 = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps({"artifactSha256": sha256}), encoding="utf-8")
    status = service.get_status()
    assert status.status == "INVALID"
    assert "missing required 'datasetVersion'" in status.status_reason


def test_dataset_version_mismatch_fails_manifest_integrity(tmp_path):
    """Manifest datasetVersion does not match artifact metadata.dataset_version."""
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(dataset_version="2026-H2-v1")
    save_universe_artifact(universe, artifact_path)

    manifest_path = tmp_path / "universe.json.manifest.json"
    manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_data["datasetVersion"] = "2026-H2-DIFFERENT"
    manifest_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )

    status = service.get_status()
    assert status.status == "INVALID"
    assert status.is_available is False
    assert "Dataset version mismatch between sidecar manifest" in status.status_reason
    assert "2026-H2-DIFFERENT" in status.status_reason
    assert "2026-H2-v1" in status.status_reason


# =========================================================================
# Scenario 7: Broken invariants (count, ranks, symbol, ISIN) are rejected
# =========================================================================
def test_broken_invariants_rejected_with_invalid(tmp_path):
    artifact_path = tmp_path / "universe.json"

    # 1. 99 constituents
    raw_payload = generate_synthetic_universe().model_dump(mode="json")
    raw_payload["constituents"] = raw_payload["constituents"][:99]
    raw_payload["metadata"]["constituent_count"] = 99
    write_artifact_with_valid_manifest(artifact_path, raw_payload)

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )
    status = service.get_status()
    assert status.status == "INVALID"
    assert "Expected exactly 100 constituents" in status.status_reason or "greater than or equal to 100" in status.status_reason

    # 2. Duplicate ISIN
    u_dup = generate_synthetic_universe()
    u_dup.constituents[1].isin = u_dup.constituents[0].isin
    write_artifact_with_valid_manifest(artifact_path, u_dup.model_dump(mode="json"))
    status = service.get_status()
    assert status.status == "INVALID"
    assert "Duplicate ISIN" in status.status_reason

    # 3. Invalid Indian ISIN regex
    u_bad_isin = generate_synthetic_universe()
    u_bad_isin.constituents[0].isin = "US0000000001"
    write_artifact_with_valid_manifest(artifact_path, u_bad_isin.model_dump(mode="json"))
    status = service.get_status()
    assert status.status == "INVALID"
    assert "isin" in status.status_reason.lower() or "string_pattern_mismatch" in status.status_reason

    # 4. Empty canonical NSE symbol
    u_empty_sym = generate_synthetic_universe()
    u_empty_sym.constituents[0].canonical_nse_symbol = "   "
    write_artifact_with_valid_manifest(artifact_path, u_empty_sym.model_dump(mode="json"))
    status = service.get_status()
    assert status.status == "INVALID"
    assert "empty canonical NSE symbol" in status.status_reason


# =========================================================================
# Scenario 8: Expired in-memory cache never continues to present universe as current
# =========================================================================
def test_expired_in_memory_cache_never_presented_as_current(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
    )
    save_universe_artifact(universe, artifact_path)

    current_date = date(2026, 12, 31)
    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: current_date,
    )

    # Initial load on 2026-12-31: VALID
    assert service.get_status().status == "VALID"
    assert len(service.get_constituents()) == 100

    # Clock moves to 2027-01-01 without modifying file
    current_date = date(2027, 1, 1)

    # Status must immediately transition to EXPIRED, never returning cached as current
    status = service.get_status()
    assert status.status == "EXPIRED"
    assert status.is_valid_for_date is False
    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError):
        service.get_constituents()


# =========================================================================
# Scenario 9: A valid artifact reloads safely after permitted file update
# =========================================================================
def test_valid_artifact_reloads_safely_on_file_update(tmp_path):
    artifact_path = tmp_path / "universe.json"

    # Period 1
    u1 = generate_synthetic_universe(
        dataset_version="2026-H2-v1",
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
    )
    save_universe_artifact(u1, artifact_path)

    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: date(2026, 8, 15),
    )
    assert service.get_status().dataset_version == "2026-H2-v1"

    # Period 2 update
    u2 = generate_synthetic_universe(
        dataset_version="2027-H1-v1",
        classification_period="January - June 2027",
        source_period_label="January - June 2027",
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 6, 30),
    )
    save_universe_artifact(u2, artifact_path)

    # Re-evaluate with new clock
    service._clock = lambda: date(2027, 2, 1)
    status2 = service.get_status()
    assert status2.status == "VALID"
    assert status2.dataset_version == "2027-H1-v1"
    assert status2.classification_period == "January - June 2027"


# =========================================================================
# Scenario 10: Failed reloads never replace validated cached data
# =========================================================================
def test_failed_reload_preserves_previously_valid_cached_data(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(
        effective_from=date(2026, 7, 1),
        effective_to=date(2026, 12, 31),
        dataset_version="2026-H2-v1",
    )
    save_universe_artifact(universe, artifact_path)

    clock_date = date(2026, 8, 15)
    service = UniverseService(
        artifact_path=artifact_path,
        clock=lambda: clock_date,
    )
    assert service.get_status().status == "VALID"
    assert len(service.get_constituents()) == 100

    # Overwrite file with corrupt bytes on disk
    artifact_path.write_text("{ corrupted invalid json", encoding="utf-8")

    # 1. Service preserves previous valid cache and does not crash or adopt invalid data
    status = service.get_status()
    assert status.status == "VALID"
    assert status.dataset_version == "2026-H2-v1"
    constituents = service.get_constituents()
    assert len(constituents) == 100
    assert constituents[0].canonical_nse_symbol == "SYNTH1"

    # 2. When clock advances past validity window, expired universe must never be served as current
    clock_date = date(2027, 1, 1)
    expired_status = service.get_status()
    assert expired_status.status == "EXPIRED"
    assert expired_status.is_valid_for_date is False
    assert service.get_universe() is None
    with pytest.raises(UniverseNotAvailableError) as exc_info:
        service.get_constituents()
    assert exc_info.value.universe_status.status == "EXPIRED"

    # 3. Restoring disk with a valid new artifact + manifest reloads safely
    new_universe = generate_synthetic_universe(
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 6, 30),
        dataset_version="2027-H1-v1",
        classification_period="January - June 2027",
        source_period_label="January - June 2027",
    )
    save_universe_artifact(new_universe, artifact_path)

    reloaded_status = service.get_status()
    assert reloaded_status.status == "VALID"
    assert reloaded_status.dataset_version == "2027-H1-v1"
    assert len(service.get_constituents()) == 100


def test_evaluate_universe_status_manifest_validation(tmp_path):
    """evaluate_universe_status requires valid sidecar manifest for artifact files."""
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    # 1. Valid with matching manifest
    status = evaluate_universe_status(artifact_path, as_of_date=date(2026, 8, 15))
    assert status.status == "VALID"
    assert status.is_available is True
    assert status.is_valid_for_date is True

    # 2. Missing manifest -> INVALID
    manifest_path = tmp_path / "universe.json.manifest.json"
    manifest_backup = manifest_path.read_bytes()
    manifest_path.unlink()
    status_no_mf = evaluate_universe_status(artifact_path, as_of_date=date(2026, 8, 15))
    assert status_no_mf.status == "INVALID"
    assert "Required sidecar manifest does not exist" in status_no_mf.status_reason

    # 3. Malformed manifest -> INVALID
    manifest_path.write_text("{ not json", encoding="utf-8")
    status_malformed = evaluate_universe_status(artifact_path, as_of_date=date(2026, 8, 15))
    assert status_malformed.status == "INVALID"
    assert "Failed to read or parse sidecar manifest" in status_malformed.status_reason

    # 4. Checksum mismatch -> INVALID
    manifest_path.write_bytes(manifest_backup)
    manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_data["artifactSha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")
    status_mismatch = evaluate_universe_status(artifact_path, as_of_date=date(2026, 8, 15))
    assert status_mismatch.status == "INVALID"
    assert "checksum mismatch" in status_mismatch.status_reason.lower()


def test_universe_manifest_schema_model():
    """UniverseManifest schema validates fields and separates source hash from artifact hash."""
    manifest = UniverseManifest(
        artifact_file="nse_largecap_current.json",
        artifact_sha256="a" * 64,
        source_file_sha256="b" * 64,
        dataset_version="2026-H2-v1",
        generated_at=datetime.now(timezone.utc),
    )
    assert manifest.artifact_sha256 != manifest.source_file_sha256
    dump = manifest.model_dump(by_alias=True)
    assert "artifactSha256" in dump
    assert "sourceFileSha256" in dump
    assert dump["artifactSha256"] == "a" * 64
    assert dump["sourceFileSha256"] == "b" * 64


# =========================================================================
# Scenario 11: Status endpoint returns each relevant status correctly
# =========================================================================
def test_status_endpoint_returns_all_status_states(test_app_and_client):
    client, u_service, universe_file, _ = test_app_and_client
    authenticate_client(client, "status_user@example.com")

    # 1. UNAVAILABLE
    if universe_file.exists():
        universe_file.unlink()
    res = client.get("/api/v1/market-data/universe/largecap/status")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "UNAVAILABLE"
    assert data["isAvailable"] is False
    assert data["isValidForDate"] is False

    # 2. VALID
    u_valid = generate_synthetic_universe()
    save_universe_artifact(u_valid, universe_file)
    res = client.get("/api/v1/market-data/universe/largecap/status")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "VALID"
    assert data["isAvailable"] is True
    assert data["isValidForDate"] is True
    assert data["constituentCount"] == 100
    assert data["datasetVersion"] == "2026-H2-v1"

    # 3. EXPIRED
    u_service._clock = lambda: date(2027, 1, 15)
    res = client.get("/api/v1/market-data/universe/largecap/status")
    assert res.status_code == 200
    assert res.json()["status"] == "EXPIRED"

    # 4. NOT_YET_ACTIVE
    u_service._clock = lambda: date(2026, 5, 1)
    res = client.get("/api/v1/market-data/universe/largecap/status")
    assert res.status_code == 200
    assert res.json()["status"] == "NOT_YET_ACTIVE"

    # 5. INVALID
    u_service._cached_universe = None  # Clear cache to force reload of invalid file
    universe_file.write_text("invalid json", encoding="utf-8")
    res = client.get("/api/v1/market-data/universe/largecap/status")
    assert res.status_code == 200
    assert res.json()["status"] == "INVALID"


# =========================================================================
# Scenario 12: Constituents endpoint serves exactly 100 entries when valid
# =========================================================================
def test_constituents_endpoint_serves_100_entries_when_valid(test_app_and_client):
    client, u_service, universe_file, _ = test_app_and_client
    authenticate_client(client, "constituents_user@example.com")

    universe = generate_synthetic_universe()
    save_universe_artifact(universe, universe_file)
    u_service._clock = lambda: date(2026, 8, 15)

    res = client.get("/api/v1/market-data/universe/largecap/constituents")
    assert res.status_code == 200
    constituents = res.json()
    assert isinstance(constituents, list)
    assert len(constituents) == 100
    assert constituents[0]["rank"] == 1
    assert constituents[0]["canonicalNseSymbol"] == "SYNTH1"
    assert constituents[99]["rank"] == 100
    assert constituents[99]["canonicalNseSymbol"] == "SYNTH100"


# =========================================================================
# Scenario 13: Non-valid states reject constituent requests safely
# =========================================================================
def test_constituents_endpoint_rejects_non_valid_states(test_app_and_client):
    client, u_service, universe_file, _ = test_app_and_client
    authenticate_client(client, "reject_user@example.com")

    # 1. Missing -> HTTP 503
    if universe_file.exists():
        universe_file.unlink()
    manifest = Path(f"{universe_file}.manifest.json")
    if manifest.exists():
        manifest.unlink()
    u_service._cached_universe = None

    res = client.get("/api/v1/market-data/universe/largecap/constituents")
    assert res.status_code == 503
    assert res.headers.get("X-Universe-Status") == "UNAVAILABLE"
    assert "UNAVAILABLE" in res.json()["detail"]

    # 2. Expired -> HTTP 422
    u_expired = generate_synthetic_universe(
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 30),
    )
    save_universe_artifact(u_expired, universe_file)
    u_service._clock = lambda: date(2026, 8, 15)

    res = client.get("/api/v1/market-data/universe/largecap/constituents")
    assert res.status_code == 422
    assert res.headers.get("X-Universe-Status") == "EXPIRED"
    assert "EXPIRED" in res.json()["detail"]

    # 3. Not yet active -> HTTP 422
    u_future = generate_synthetic_universe(
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 6, 30),
    )
    save_universe_artifact(u_future, universe_file)
    u_service._clock = lambda: date(2026, 8, 15)

    res = client.get("/api/v1/market-data/universe/largecap/constituents")
    assert res.status_code == 422
    assert res.headers.get("X-Universe-Status") == "NOT_YET_ACTIVE"
    assert "NOT_YET_ACTIVE" in res.json()["detail"]

    # 4. Invalid -> HTTP 503
    u_service._cached_universe = None
    universe_file.write_text("bad data", encoding="utf-8")
    if manifest.exists():
        manifest.unlink()

    res = client.get("/api/v1/market-data/universe/largecap/constituents")
    assert res.status_code == 503
    assert res.headers.get("X-Universe-Status") == "INVALID"
    assert "INVALID" in res.json()["detail"]


# =========================================================================
# Scenario 14: Unauthenticated API requests are rejected
# =========================================================================
def test_unauthenticated_requests_are_rejected(test_app_and_client):
    client, _, _, _ = test_app_and_client

    # No auth cookies / headers
    res_status = client.get("/api/v1/market-data/universe/largecap/status")
    assert res_status.status_code == 401

    res_const = client.get("/api/v1/market-data/universe/largecap/constituents")
    assert res_const.status_code == 401


# =========================================================================
# Scenario 15: Individual-symbol market-data lookup remains independent
# =========================================================================
def test_individual_symbol_lookup_independent_of_universe(test_app_and_client):
    client, u_service, universe_file, _ = test_app_and_client
    authenticate_client(client, "lookup_user@example.com")

    # Universe artifact is missing
    if universe_file.exists():
        universe_file.unlink()
    u_service._cached_universe = None

    # Status shows UNAVAILABLE
    status_res = client.get("/api/v1/market-data/universe/largecap/status")
    assert status_res.status_code == 200
    assert status_res.json()["status"] == "UNAVAILABLE"

    # But /snapshot/{symbol} lookup remains operational
    snap_res = client.get("/api/v1/market-data/snapshot/RELIANCE")
    assert snap_res.status_code == 200
    snap_data = snap_res.json()
    assert snap_data["symbol"] == "RELIANCE"
    assert snap_data["lastPrice"] == 2500.0
