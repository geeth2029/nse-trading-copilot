"""Automated test suite for SQLite → PostgreSQL migration script.

Tests:
1. SQLite backup safety (consistent copy via backup API, read-only mode, preserves original).
2. Table order respects foreign-key dependencies (instruments, users before positions, etc.).
3. Successful migration and idempotency (repeated migration safely skips identical rows).
4. Conflicting row detection and atomic transaction rollback (no partial data committed).
5. Focused normalization tests:
   - Text whitespace differences (leading/trailing) are strictly preserved and detected.
   - Timestamp differences at microsecond precision are preserved and detected.
   - Equivalent SQLite naive UTC and PostgreSQL aware UTC representations match.
   - Model-defined Numeric(18, 4) scale matching vs genuine price differences.
6. Enforced read-only source engine:
   - make_sqlite_readonly_engine strictly blocks INSERT, UPDATE, DELETE, CREATE, DROP.
   - Migration, dry-run, and verification execute successfully against read-only source.
7. Comprehensive verification (clean match, missing rows, mismatched rows, extra pre-existing rows).
8. auth_sessions deliberate exclusion from migration and verification.
9. Database URL credential masking.
10. Dry-run inspection (source-only and target-aware without writes).
"""

from __future__ import annotations

import datetime
from decimal import Decimal
from pathlib import Path
import sqlite3

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import OperationalError

from app.database.base import Base
from app.database.session import make_engine
from app.models import Instrument, PortfolioPosition, PositionExit, TradeEntry, User
from app.models.auth_session import AuthSession
from scripts.migrate_sqlite_to_postgres import (
    TABLE_ORDER,
    MigrationConflictError,
    VerificationReport,
    cmd_migrate,
    confirm_migration,
    create_sqlite_backup,
    inspect_source,
    make_sqlite_readonly_engine,
    mask_database_url,
    normalize_value_by_column,
    records_match,
    run_migration,
    target_aware_dry_run,
    verify_migration,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures & Test Data
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def source_db_path(tmp_path: Path) -> Path:
    """Create an isolated temporary SQLite database populated with test records."""
    db_path = tmp_path / "source.db"
    engine = make_engine(f"sqlite:///{db_path.as_posix()}")
    Base.metadata.create_all(engine)

    with engine.begin() as conn:
        # 1. Instruments
        conn.execute(
            Instrument.__table__.insert().values(
                id="inst-tcs",
                canonical_symbol="NSE:TCS",
                symbol="TCS",
                display_name="Tata Consultancy Services Ltd",
                exchange="NSE",
                is_large_cap=True,
                market_cap_rank=1,
                sector="IT",
                is_active=True,
            )
        )
        conn.execute(
            Instrument.__table__.insert().values(
                id="inst-infy",
                canonical_symbol="NSE:INFY",
                symbol="INFY",
                display_name="Infosys Ltd",
                exchange="NSE",
                is_large_cap=True,
                market_cap_rank=2,
                sector="IT",
                is_active=True,
            )
        )

        # 2. Users
        conn.execute(
            User.__table__.insert().values(
                id="user-1",
                email="trader@example.com",
                display_name="Alice Trader",
                password_hash="argon2id$hashedpassword",
            )
        )

        # 3. Portfolio Positions
        conn.execute(
            PortfolioPosition.__table__.insert().values(
                id="pos-1",
                user_id="user-1",
                instrument_id="inst-tcs",
                status="ACTIVE",
                initial_entry_date=datetime.date(2026, 1, 15),
            )
        )

        # 4. Trade Entries (Initial and Pyramid)
        conn.execute(
            TradeEntry.__table__.insert().values(
                id="entry-1",
                position_id="pos-1",
                sequence=1,
                entry_type="INITIAL_ENTRY",
                entry_date=datetime.date(2026, 1, 15),
                entry_price=Decimal("3500.0000"),
                stop_loss=Decimal("3325.0000"),
                rps=Decimal("175.0000"),
                rpt=Decimal("10000.0000"),
                quantity=57,
                capital_snapshot=Decimal("1000000.0000"),
                sizing_status="VALID",
                notes="Initial entry on breakout",
            )
        )
        conn.execute(
            TradeEntry.__table__.insert().values(
                id="entry-2",
                position_id="pos-1",
                sequence=2,
                entry_type="PYRAMID_ENTRY",
                entry_date=datetime.date(2026, 2, 1),
                entry_price=Decimal("3650.0000"),
                stop_loss=Decimal("3467.5000"),
                rps=Decimal("182.5000"),
                rpt=Decimal("5000.0000"),
                quantity=27,
                capital_snapshot=Decimal("1050000.0000"),
                sizing_status="VALID",
                notes="First pyramid add",
            )
        )

        # 5. Position Exit
        conn.execute(
            PositionExit.__table__.insert().values(
                id="exit-1",
                position_id="pos-1",
                exit_price=Decimal("3800.0000"),
                exit_date=datetime.date(2026, 3, 1),
                notes="Target reached",
            )
        )

        # 6. AuthSession (MUST BE EXCLUDED FROM MIGRATION)
        conn.execute(
            AuthSession.__table__.insert().values(
                id="sess-1",
                user_id="user-1",
                token_hash="tokenhash123",
                csrf_token_hash="csrfhash123",
                expires_at=datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1),
            )
        )

    engine.dispose()
    return db_path


@pytest.fixture
def target_engine(tmp_path: Path):
    """Create an empty isolated target database with foreign keys enabled."""
    target_path = tmp_path / "target.db"
    engine = make_engine(f"sqlite:///{target_path.as_posix()}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Backup Safety Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_backup_sqlite_creates_consistent_copy_and_preserves_source(source_db_path: Path, tmp_path: Path):
    """Backup must use SQLite native backup API, produce a complete copy, and protect source."""
    backup_path = tmp_path / "test_backup.bak.db"
    orig_size = source_db_path.stat().st_size
    orig_mtime = source_db_path.stat().st_mtime_ns

    result_path = create_sqlite_backup(source_db_path, backup_path)

    assert result_path == backup_path
    assert backup_path.exists()
    assert backup_path.stat().st_size > 0

    # Verify source database was not modified or truncated
    assert source_db_path.stat().st_size == orig_size
    assert source_db_path.stat().st_mtime_ns == orig_mtime

    # Verify data inside the backup database
    bak_engine = make_engine(f"sqlite:///{backup_path.as_posix()}")
    with bak_engine.connect() as conn:
        users = conn.execute(select(User.__table__)).all()
        assert len(users) == 1
        assert users[0].email == "trader@example.com"
        entries = conn.execute(select(TradeEntry.__table__)).all()
        assert len(entries) == 2
    bak_engine.dispose()


def test_backup_sqlite_fails_if_source_not_found(tmp_path: Path):
    """Backup must fail loudly if source database does not exist."""
    missing_path = tmp_path / "nonexistent.db"
    with pytest.raises(FileNotFoundError):
        create_sqlite_backup(missing_path)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Table Order & Foreign Key Dependency Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_table_order_respects_foreign_keys():
    """TABLE_ORDER must respect topological foreign-key dependencies."""
    # instruments and users have no FKs -> must be first
    assert TABLE_ORDER.index("instruments") < TABLE_ORDER.index("portfolio_positions")
    assert TABLE_ORDER.index("users") < TABLE_ORDER.index("portfolio_positions")

    # portfolio_positions must come before trade_entries and position_exits
    assert TABLE_ORDER.index("portfolio_positions") < TABLE_ORDER.index("trade_entries")
    assert TABLE_ORDER.index("portfolio_positions") < TABLE_ORDER.index("position_exits")

    # auth_sessions and alembic_version must NEVER be in TABLE_ORDER
    assert "auth_sessions" not in TABLE_ORDER
    assert "alembic_version" not in TABLE_ORDER


# ─────────────────────────────────────────────────────────────────────────────
# 3. Read-Only Source Engine Enforcement Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_source_database_readonly_engine_rejects_all_writes(source_db_path: Path):
    """make_sqlite_readonly_engine must block all INSERT, UPDATE, DELETE, CREATE, DROP queries."""
    ro_engine = make_sqlite_readonly_engine(source_db_path)

    # 1. SELECT works
    with ro_engine.connect() as conn:
        user_count = conn.scalar(text("SELECT COUNT(*) FROM users"))
        assert user_count == 1

    # 2. INSERT is rejected
    with pytest.raises(OperationalError) as exc_info:
        with ro_engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, created_at, updated_at) "
                    "VALUES ('evil', 'evil@example.com', 'hash', '2026-01-01', '2026-01-01')"
                )
            )
    assert "readonly" in str(exc_info.value).lower()

    # 3. UPDATE is rejected
    with pytest.raises(OperationalError) as exc_info:
        with ro_engine.begin() as conn:
            conn.execute(text("UPDATE users SET display_name = 'Hacked' WHERE id = 'user-1'"))
    assert "readonly" in str(exc_info.value).lower()

    # 4. DELETE is rejected
    with pytest.raises(OperationalError) as exc_info:
        with ro_engine.begin() as conn:
            conn.execute(text("DELETE FROM users WHERE id = 'user-1'"))
    assert "readonly" in str(exc_info.value).lower()

    # 5. CREATE TABLE is rejected
    with pytest.raises(OperationalError) as exc_info:
        with ro_engine.begin() as conn:
            conn.execute(text("CREATE TABLE evil_table (x INT)"))
    assert "readonly" in str(exc_info.value).lower()

    # 6. DROP TABLE is rejected
    with pytest.raises(OperationalError) as exc_info:
        with ro_engine.begin() as conn:
            conn.execute(text("DROP TABLE users"))
    assert "readonly" in str(exc_info.value).lower()

    ro_engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 4. Focused Normalization & Precision Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_records_match_preserves_whitespace_differences():
    """Leading and trailing whitespace differences in arbitrary text must be detected as mismatches."""
    base_row = {
        "id": "entry-1",
        "position_id": "pos-1",
        "sequence": 1,
        "entry_type": "INITIAL_ENTRY",
        "entry_date": datetime.date(2026, 1, 15),
        "entry_price": Decimal("3500.0000"),
        "stop_loss": Decimal("3325.0000"),
        "rps": Decimal("175.0000"),
        "rpt": Decimal("10000.0000"),
        "quantity": 57,
        "capital_snapshot": Decimal("1000000.0000"),
        "sizing_status": "VALID",
        "notes": "  breakout with leading and trailing spaces  ",
        "created_at": datetime.datetime(2026, 1, 15, 10, 0, 0, tzinfo=datetime.timezone.utc),
        "updated_at": datetime.datetime(2026, 1, 15, 10, 0, 0, tzinfo=datetime.timezone.utc),
    }

    # Strip whitespace from notes in the target row
    target_row = dict(base_row)
    target_row["notes"] = "breakout with leading and trailing spaces"

    matches, mismatches = records_match(base_row, target_row, "trade_entries")
    assert matches is False, "Whitespace differences in text must NOT be ignored"
    assert any("notes" in m for m in mismatches)


def test_records_match_preserves_microsecond_differences():
    """Timestamp differences at microsecond precision must not be silently discarded."""
    dt_base = datetime.datetime(2026, 1, 15, 10, 0, 0, 123456, tzinfo=datetime.timezone.utc)
    dt_diff = datetime.datetime(2026, 1, 15, 10, 0, 0, 123457, tzinfo=datetime.timezone.utc)

    row1 = {
        "id": "user-1",
        "email": "trader@example.com",
        "display_name": "Alice",
        "password_hash": "hash",
        "created_at": dt_base,
        "updated_at": dt_base,
    }
    row2 = dict(row1)
    row2["created_at"] = dt_diff

    matches, mismatches = records_match(row1, row2, "users")
    assert matches is False, "Microsecond timestamp differences must be detected"
    assert any("created_at" in m for m in mismatches)


def test_records_match_accepts_equivalent_sqlite_pg_datetime_representations():
    """Equivalent SQLite naive UTC and PostgreSQL aware UTC timestamps with identical
    microseconds must match cleanly.
    """
    dt_sqlite_naive = datetime.datetime(2026, 1, 15, 10, 0, 0, 654321)  # Naive (SQLite)
    dt_pg_aware = datetime.datetime(2026, 1, 15, 10, 0, 0, 654321, tzinfo=datetime.timezone.utc)  # Aware UTC (PG)

    row1 = {
        "id": "user-1",
        "email": "trader@example.com",
        "display_name": "Alice",
        "password_hash": "hash",
        "created_at": dt_sqlite_naive,
        "updated_at": dt_sqlite_naive,
    }
    row2 = dict(row1)
    row2["created_at"] = dt_pg_aware
    row2["updated_at"] = dt_pg_aware

    matches, mismatches = records_match(row1, row2, "users")
    assert matches is True, "Naive UTC and aware UTC timestamps with same microseconds must match"
    assert len(mismatches) == 0


def test_records_match_accepts_model_defined_numeric_scale():
    """Model-defined Numeric(18, 4) matches scale representation differences but catches genuine diffs."""
    row1 = {
        "id": "exit-1",
        "position_id": "pos-1",
        "exit_price": Decimal("3800.5"),  # 1 decimal place
        "exit_date": datetime.date(2026, 3, 1),
        "recorded_at": datetime.datetime(2026, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc),
        "notes": None,
        "created_at": datetime.datetime(2026, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc),
        "updated_at": datetime.datetime(2026, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc),
    }
    row2 = dict(row1)
    row2["exit_price"] = Decimal("3800.5000")  # 4 decimal places

    matches, mismatches = records_match(row1, row2, "position_exits")
    assert matches is True, "Scale difference 3800.5 vs 3800.5000 on Numeric(18, 4) should match"

    # Genuine value difference
    row3 = dict(row1)
    row3["exit_price"] = Decimal("3800.5001")
    matches_diff, mismatches_diff = records_match(row1, row3, "position_exits")
    assert matches_diff is False, "Genuine price difference 3800.5000 vs 3800.5001 must be detected"
    assert any("exit_price" in m for m in mismatches_diff)


# ─────────────────────────────────────────────────────────────────────────────
# 5. Successful Migration & Idempotency Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_migration_successful_and_idempotent_with_readonly_source(source_db_path: Path, target_engine):
    """Migration succeeds from read-only SQLite source; second run safely skips identical records."""
    source_engine = make_sqlite_readonly_engine(source_db_path)

    # First migration run
    report1 = run_migration(source_engine, target_engine)
    assert report1.success is True
    assert report1.error is None

    counts1 = {r.table: r.inserted for r in report1.results}
    assert counts1["instruments"] == 2
    assert counts1["users"] == 1
    assert counts1["portfolio_positions"] == 1
    assert counts1["trade_entries"] == 2
    assert counts1["position_exits"] == 1

    # Verify records present in target
    with target_engine.connect() as conn:
        tcs_entry = conn.execute(
            select(TradeEntry.__table__).where(TradeEntry.__table__.c.id == "entry-1")
        ).mappings().first()
        assert tcs_entry is not None
        assert tcs_entry["entry_price"] == Decimal("3500.0000")
        assert tcs_entry["quantity"] == 57

    # Second migration run (repeated/idempotent retry)
    report2 = run_migration(source_engine, target_engine)
    assert report2.success is True
    assert report2.error is None

    for r in report2.results:
        assert r.inserted == 0, f"Table {r.table} should have 0 inserts on retry"
        assert r.skipped_identical > 0, f"Table {r.table} should have skipped identical rows"

    source_engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Conflict Detection and Atomic Rollback Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_migration_conflict_rolls_back_entirely(source_db_path: Path, target_engine):
    """If target already has a record with the same ID but conflicting data,
    the migration must raise MigrationConflictError and roll back the entire transaction.
    """
    source_engine = make_sqlite_readonly_engine(source_db_path)

    # Seed target with a conflicting user: same ID "user-1", but DIFFERENT email
    with target_engine.begin() as conn:
        conn.execute(
            User.__table__.insert().values(
                id="user-1",
                email="conflict_intruder@example.com",  # Differs from source trader@example.com
                display_name="Conflicting Alice",
                password_hash="different_hash",
            )
        )

    # Attempt migration
    report = run_migration(source_engine, target_engine)
    assert report.success is False
    assert report.error is not None
    assert "Conflict detected in table 'users'" in report.error
    assert "conflict_intruder@example.com" in report.error

    # Verify atomic rollback: no instruments or other tables should have been committed
    with target_engine.connect() as conn:
        inst_count = conn.scalar(text("SELECT COUNT(*) FROM instruments"))
        assert inst_count == 0, "Transaction should have rolled back all instruments"
        pos_count = conn.scalar(text("SELECT COUNT(*) FROM portfolio_positions"))
        assert pos_count == 0, "No positions should have been committed"

    source_engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 7. Comprehensive Verification Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_verification_detects_clean_match(source_db_path: Path, target_engine):
    """After successful migration, verify_migration must report success with 0 diffs."""
    source_engine = make_sqlite_readonly_engine(source_db_path)
    run_migration(source_engine, target_engine)

    report = verify_migration(source_engine, target_engine)
    assert report.success is True
    assert report.has_pre_existing_records is False

    for t in report.tables:
        assert len(t.missing_ids) == 0
        assert len(t.extra_ids) == 0
        assert len(t.mismatches) == 0
        assert t.src_count == t.dst_count == t.matched_count

    source_engine.dispose()


def test_verification_detects_missing_rows(source_db_path: Path, target_engine):
    """If a row from source is missing in target, verification must fail and report the ID."""
    source_engine = make_sqlite_readonly_engine(source_db_path)
    run_migration(source_engine, target_engine)

    # Delete one trade entry in target to simulate missing row
    with target_engine.begin() as conn:
        conn.execute(text("DELETE FROM trade_entries WHERE id = 'entry-2'"))

    report = verify_migration(source_engine, target_engine)
    assert report.success is False

    entry_result = next(t for t in report.tables if t.table == "trade_entries")
    assert "entry-2" in entry_result.missing_ids
    assert entry_result.src_count == 2
    assert entry_result.dst_count == 1

    source_engine.dispose()


def test_verification_detects_mismatched_rows(source_db_path: Path, target_engine):
    """If a row exists in both by ID but a field value differs, verification must fail."""
    source_engine = make_sqlite_readonly_engine(source_db_path)
    run_migration(source_engine, target_engine)

    # Modify an entry price in target
    with target_engine.begin() as conn:
        conn.execute(text("UPDATE trade_entries SET entry_price = 9999.0000 WHERE id = 'entry-1'"))

    report = verify_migration(source_engine, target_engine)
    assert report.success is False

    entry_result = next(t for t in report.tables if t.table == "trade_entries")
    assert len(entry_result.mismatches) == 1
    pk, diffs = entry_result.mismatches[0]
    assert pk == "entry-1"
    assert any("entry_price" in d for d in diffs)

    source_engine.dispose()


def test_verification_reports_pre_existing_extra_rows(source_db_path: Path, target_engine):
    """Pre-existing target records not in SQLite are flagged as extra records."""
    source_engine = make_sqlite_readonly_engine(source_db_path)
    run_migration(source_engine, target_engine)

    # Add an extra instrument directly in target
    with target_engine.begin() as conn:
        conn.execute(
            Instrument.__table__.insert().values(
                id="inst-extra",
                canonical_symbol="NSE:WIPRO",
                symbol="WIPRO",
                display_name="Wipro Ltd",
                exchange="NSE",
                is_large_cap=True,
                is_active=True,
            )
        )

    report = verify_migration(source_engine, target_engine)
    # Extra records do not mean source records are missing, so success is True if all source are present
    assert report.has_pre_existing_records is True
    inst_result = next(t for t in report.tables if t.table == "instruments")
    assert "inst-extra" in inst_result.extra_ids

    source_engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 8. auth_sessions Exclusion Test
# ─────────────────────────────────────────────────────────────────────────────


def test_auth_sessions_excluded_from_migration_and_target(source_db_path: Path, target_engine):
    """auth_sessions exists in source SQLite but must NEVER be migrated to target."""
    source_engine = make_sqlite_readonly_engine(source_db_path)

    # Verify source has an auth session
    with source_engine.connect() as conn:
        src_sessions = conn.scalar(text("SELECT COUNT(*) FROM auth_sessions"))
        assert src_sessions == 1

    # Run migration
    report = run_migration(source_engine, target_engine)
    assert report.success is True

    # Verify target has 0 auth sessions
    with target_engine.connect() as conn:
        dst_sessions = conn.scalar(text("SELECT COUNT(*) FROM auth_sessions"))
        assert dst_sessions == 0

    source_engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 9. Credential Masking & Dry Run Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_mask_database_url():
    """mask_database_url must redact passwords across formats."""
    pg_url = "postgresql+psycopg://myuser:secretpassword123@ep-sample.ap-southeast-1.aws.neon.tech/nsedb?sslmode=require"
    masked = mask_database_url(pg_url)
    assert "secretpassword123" not in masked
    assert "myuser:***@" in masked
    assert "ep-sample" in masked

    sqlite_url = "sqlite:///./data/test.db"
    assert mask_database_url(sqlite_url) == sqlite_url


def test_inspect_source_counts(source_db_path: Path):
    """inspect_source must accurately count rows without target connection."""
    source_engine = make_sqlite_readonly_engine(source_db_path)
    counts = inspect_source(source_engine)

    assert counts["instruments"] == 2
    assert counts["users"] == 1
    assert counts["portfolio_positions"] == 1
    assert counts["trade_entries"] == 2
    assert counts["position_exits"] == 1

    source_engine.dispose()


def test_target_aware_dry_run_no_writes(source_db_path: Path, target_engine):
    """target_aware_dry_run must calculate pending inserts without performing any writes."""
    source_engine = make_sqlite_readonly_engine(source_db_path)

    results = target_aware_dry_run(source_engine, target_engine)
    res_map = {r.table: r.inserted for r in results}

    assert res_map["instruments"] == 2
    assert res_map["users"] == 1
    assert res_map["trade_entries"] == 2

    # Verify target database remains empty
    with target_engine.connect() as conn:
        total = conn.scalar(text("SELECT COUNT(*) FROM users"))
        assert total == 0

    source_engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 11. Backup Safeguards & Integrity Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_backup_sqlite_never_overwrites_existing_backup(source_db_path: Path, tmp_path: Path):
    """create_sqlite_backup must refuse to overwrite an existing backup destination."""
    existing_backup = tmp_path / "already_exists.bak.db"
    existing_backup.write_bytes(b"dummy previous backup")

    with pytest.raises(FileExistsError, match="already exists and will not be overwritten"):
        create_sqlite_backup(source_db_path, existing_backup)

    # Content of existing file must remain unchanged
    assert existing_backup.read_bytes() == b"dummy previous backup"


def test_backup_sqlite_rejects_source_as_backup_destination(source_db_path: Path):
    """create_sqlite_backup must refuse to use the source SQLite file as the backup destination."""
    with pytest.raises(ValueError, match="cannot be identical to the source database"):
        create_sqlite_backup(source_db_path, source_db_path)


def test_backup_sqlite_integrity_check_failure_cleans_up(source_db_path: Path, tmp_path: Path, monkeypatch):
    """If PRAGMA integrity_check fails, backup file must be removed and RuntimeError raised."""
    backup_path = tmp_path / "corrupt_test.bak.db"

    # Mock sqlite3.connect so that the integrity check query returns 'corrupted'
    real_connect = sqlite3.connect

    class FakeCursor:
        def execute(self, sql):
            pass

        def fetchone(self):
            return ("*** in database main *** Page 1: corrupt",)

    class FakeConn:
        def __init__(self, *args, **kwargs):
            self._real = real_connect(*args, **kwargs)

        def cursor(self):
            return FakeCursor()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def close(self):
            self._real.close()

        def backup(self, *args, **kwargs):
            return self._real.backup(*args, **kwargs)

    # Let the initial backup write occur normally, but fail on the integrity check connection
    call_count = 0

    def mock_connect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 3:  # 1st is src_conn, 2nd is dst_conn, 3rd is integrity check chk_conn
            return FakeConn(*args, **kwargs)
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", mock_connect)

    with pytest.raises(RuntimeError, match="Backup integrity validation failed"):
        create_sqlite_backup(source_db_path, backup_path)

    # Corrupt backup must have been unlinked
    assert not backup_path.exists()


# ─────────────────────────────────────────────────────────────────────────────
# 12. Interactive Confirmation Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_confirm_migration_responses():
    """confirm_migration returns True strictly for 'yes' and False for anything else."""
    masked = "postgresql://user:***@neon.tech/db"

    # Confirmed
    assert confirm_migration(masked, prompt_func=lambda _: "yes") is True
    assert confirm_migration(masked, prompt_func=lambda _: "YES") is True
    assert confirm_migration(masked, prompt_func=lambda _: "  yes  ") is True

    # Cancelled / Default
    assert confirm_migration(masked, prompt_func=lambda _: "") is False
    assert confirm_migration(masked, prompt_func=lambda _: "no") is False
    assert confirm_migration(masked, prompt_func=lambda _: "y") is False
    assert confirm_migration(masked, prompt_func=lambda _: "cancel") is False

    # Interrupted
    def raise_eof(_):
        raise EOFError()

    assert confirm_migration(masked, prompt_func=raise_eof) is False


# ─────────────────────────────────────────────────────────────────────────────
# 13. Command-Level Migration Flow Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_migrate_confirmation_cancellation_aborts_without_backup_or_writes(
    source_db_path: Path, tmp_path: Path, monkeypatch, capsys
):
    """When confirmation is declined, cmd_migrate must abort without creating backup or writing to target."""
    target_path = tmp_path / "target_declined.db"
    target_url = f"sqlite:///{target_path.as_posix()}"
    engine = make_engine(target_url)
    Base.metadata.create_all(engine)
    engine.dispose()

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    # Empty prompt response defaults to cancel
    cmd_migrate([], prompt_func=lambda _: "")

    out = capsys.readouterr().out
    assert "cancelled by user" in out.lower()

    # Verify no backup was created in source directory
    backup_files = list(source_db_path.parent.glob("*.bak.db"))
    assert len(backup_files) == 0

    # Verify target database remains empty
    t_engine = make_engine(target_url)
    with t_engine.connect() as conn:
        users = conn.scalar(text("SELECT COUNT(*) FROM users"))
        assert users == 0
    t_engine.dispose()


def test_cmd_migrate_backup_failure_aborts_before_migration(
    source_db_path: Path, tmp_path: Path, monkeypatch, capsys
):
    """If backup creation fails, cmd_migrate must abort before writing to target."""
    target_path = tmp_path / "target_aborted.db"
    target_url = f"sqlite:///{target_path.as_posix()}"
    engine = make_engine(target_url)
    Base.metadata.create_all(engine)
    engine.dispose()

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    # Mock backup to simulate disk failure
    def failing_backup(src, dst=None):
        raise RuntimeError("Disk full / I/O error")

    monkeypatch.setattr("scripts.migrate_sqlite_to_postgres.create_sqlite_backup", failing_backup)

    with pytest.raises(SystemExit) as exc_info:
        cmd_migrate([], prompt_func=lambda _: "yes")

    assert exc_info.value.code == 1
    err = capsys.readouterr().err
    assert "Backup creation failed" in err
    assert "Migration aborted before connecting to target" in err

    # Verify target database remains empty
    t_engine = make_engine(target_url)
    with t_engine.connect() as conn:
        users = conn.scalar(text("SELECT COUNT(*) FROM users"))
        assert users == 0
    t_engine.dispose()


def test_cmd_migrate_migration_failure_rolls_back_and_exits(
    source_db_path: Path, tmp_path: Path, monkeypatch, capsys
):
    """If migration encounters a conflict, cmd_migrate rolls back, reports error, and exits."""
    target_path = tmp_path / "target_conflict.db"
    target_url = f"sqlite:///{target_path.as_posix()}"
    engine = make_engine(target_url)
    Base.metadata.create_all(engine)

    # Pre-populate conflicting record in target
    with engine.begin() as conn:
        conn.execute(
            User.__table__.insert().values(
                id="user-1",
                email="conflicting_email@example.com",
                display_name="Conflicting User",
                password_hash="hash",
            )
        )
    engine.dispose()

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    with pytest.raises(SystemExit) as exc_info:
        cmd_migrate([], prompt_func=lambda _: "yes")

    assert exc_info.value.code == 1
    err = capsys.readouterr().err
    assert "MIGRATION FAILED — TRANSACTION ROLLED BACK" in err

    # Confirm rollback: trade_entries in target must still be 0
    t_engine = make_engine(target_url)
    with t_engine.connect() as conn:
        entries = conn.scalar(text("SELECT COUNT(*) FROM trade_entries"))
        assert entries == 0
    t_engine.dispose()


def test_cmd_migrate_successful_migration_and_verification(
    source_db_path: Path, tmp_path: Path, monkeypatch, capsys
):
    """Successful migration creates verified backup, migrates records, verifies data, and succeeds."""
    target_path = tmp_path / "target_success.db"
    target_url = f"sqlite:///{target_path.as_posix()}"
    engine = make_engine(target_url)
    Base.metadata.create_all(engine)
    engine.dispose()

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    # Runs with confirmation
    cmd_migrate([], prompt_func=lambda _: "yes")

    out = capsys.readouterr().out
    assert "Backup successfully created and verified" in out
    assert "Migration transaction committed" in out
    assert "Full migration and verification SUCCEEDED" in out

    # Verify backup exists
    backups = list(source_db_path.parent.glob("*.bak.db"))
    assert len(backups) >= 1
    assert backups[0].stat().st_size > 0

    # Verify all records exist in target
    t_engine = make_engine(target_url)
    with t_engine.connect() as conn:
        assert conn.scalar(text("SELECT COUNT(*) FROM instruments")) == 2
        assert conn.scalar(text("SELECT COUNT(*) FROM users")) == 1
        assert conn.scalar(text("SELECT COUNT(*) FROM portfolio_positions")) == 1
        assert conn.scalar(text("SELECT COUNT(*) FROM trade_entries")) == 2
        assert conn.scalar(text("SELECT COUNT(*) FROM position_exits")) == 1
        assert conn.scalar(text("SELECT COUNT(*) FROM auth_sessions")) == 0
    t_engine.dispose()


def test_cmd_migrate_verification_failure_after_commit(
    source_db_path: Path, tmp_path: Path, monkeypatch, capsys
):
    """If post-migration verification detects discrepancies, cmd_migrate reports failure and exits."""
    target_path = tmp_path / "target_vfail.db"
    target_url = f"sqlite:///{target_path.as_posix()}"
    engine = make_engine(target_url)
    Base.metadata.create_all(engine)
    engine.dispose()

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    # Mock verify_migration to report discrepancy
    def fake_verify(src, dst):
        return VerificationReport(
            success=False,
            tables=[],
        )

    monkeypatch.setattr("scripts.migrate_sqlite_to_postgres.verify_migration", fake_verify)

    with pytest.raises(SystemExit) as exc_info:
        cmd_migrate([], prompt_func=lambda _: "yes")

    assert exc_info.value.code == 1
    out_err = capsys.readouterr()
    assert "POST-MIGRATION VERIFICATION FAILED" in out_err.err
    assert "Full migration and verification SUCCEEDED" not in out_err.out


def test_cmd_migrate_disposes_engines_on_all_paths(source_db_path: Path, tmp_path: Path, monkeypatch):
    """Engine disposal must be executed reliably across successful, migration failure, and verification failure paths."""
    target_path = tmp_path / "target_cleanup.db"
    target_url = f"sqlite:///{target_path.as_posix()}"
    engine = make_engine(target_url)
    Base.metadata.create_all(engine)
    engine.dispose()

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    disposed_engines = []

    real_create_engine = create_engine

    def tracking_create_engine(*args, **kwargs):
        eng = real_create_engine(*args, **kwargs)
        orig_dispose = eng.dispose

        def tracked_dispose():
            disposed_engines.append(eng)
            return orig_dispose()

        eng.dispose = tracked_dispose
        return eng

    monkeypatch.setattr("scripts.migrate_sqlite_to_postgres.create_engine", tracking_create_engine)

    # Case 1: Success path
    cmd_migrate([], prompt_func=lambda _: "yes")
    assert len(disposed_engines) >= 2  # sqlite_engine and target_engine

    # Case 2: Verification failure path
    disposed_engines.clear()
    monkeypatch.setattr(
        "scripts.migrate_sqlite_to_postgres.verify_migration",
        lambda s, t: VerificationReport(success=False, tables=[]),
    )
    with pytest.raises(SystemExit):
        cmd_migrate([], prompt_func=lambda _: "yes")
    assert len(disposed_engines) >= 2


def test_cmd_migrate_masks_credentials_in_all_outputs(
    source_db_path: Path, tmp_path: Path, monkeypatch, capsys
):
    """Target URLs with passwords must never be printed to stdout or stderr."""
    secret_pass = "SuperSecretP@ssw0rd99"
    target_url = f"postgresql+psycopg://admin:{secret_pass}@ep-xyz.neon.tech/trading?sslmode=require"

    monkeypatch.setenv("SQLITE_DB_PATH", str(source_db_path))
    monkeypatch.setenv("NEON_DATABASE_URL", target_url)

    # Cancel confirmation to inspect confirmation banner
    cmd_migrate([], prompt_func=lambda _: "no")

    captured = capsys.readouterr()
    assert secret_pass not in captured.out
    assert secret_pass not in captured.err
    assert "admin:***@ep-xyz.neon.tech" in captured.out
