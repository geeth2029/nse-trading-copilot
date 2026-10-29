"""
NSE Trading Copilot — SQLite → PostgreSQL Data Migration Script.

PURPOSE
    Safely copies users, instruments, portfolio_positions, trade_entries, and
    position_exits from a local SQLite database to an already-migrated
    (alembic upgrade head) PostgreSQL database (e.g. Neon Free).

    Auth sessions are intentionally NOT migrated:
    Session tokens are ephemeral random digests tied to client-side cookie jars.
    Excluding auth_sessions avoids transferring obsolete session state across
    networks. Users simply log in once after migration to establish a clean session.

SAFETY GUARANTEES
    • Enforced read-only source access: the source SQLite database is opened
      via a SQLAlchemy SQLite URI configured strictly with `mode=ro&uri=true`.
      All write, insert, update, delete, or schema-creation operations are
      rejected at the SQLite engine and C API level.
    • Consistent backup: uses the SQLite native Backup API (sqlite3.Connection.backup),
      avoiding file-level race conditions or partial WAL captures, while opening
      the source in read-only mode (`?mode=ro`).
    • Strict FK dependency ordering: instruments → users → portfolio_positions →
      trade_entries → position_exits.
    • Ordinary application role permissions: does NOT require superuser privileges
      or `SET session_replication_role = 'replica'`.
    • Safe idempotency with precision-aware conflict verification:
      If a destination row exists with the same ID, its field values are compared.
      Differences caused purely by engine representations (such as SQLite's naive UTC
      datetimes vs PostgreSQL's aware UTC datetimes, or Numeric scale) match correctly.
      Genuine differences (including leading/trailing whitespace in text or microsecond
      discrepancies in timestamps) are preserved and reported as conflicts.
      Any genuine conflict raises MigrationConflictError and triggers an immediate rollback.
    • Atomic destination transaction: all writes across all tables execute inside
      a single database transaction. Any failure triggers a clean ROLLBACK.
    • Credential masking: database URLs containing passwords are masked in all output.

USAGE INSTRUCTIONS

1. Windows PowerShell:
    # A. Source-only dry-run (no credentials needed, no remote connection):
    python scripts/migrate_sqlite_to_postgres.py dry-run

    # B. Create a verified local backup:
    python scripts/migrate_sqlite_to_postgres.py backup

    # C. Run target-aware dry-run or migration with secure interactive prompt
    #    (URL is prompted without echoing and without entering PowerShell history):
    python scripts/migrate_sqlite_to_postgres.py dry-run
    python scripts/migrate_sqlite_to_postgres.py migrate
    python scripts/migrate_sqlite_to_postgres.py verify

    # D. Or set session environment variables (not stored in permanent history):
    $env:SQLITE_DB_PATH = "data/nse_trading_copilot.db"
    $env:NEON_DATABASE_URL = [System.Net.NetworkCredential]::new("", (Read-Host -AsSecureString "Neon URL")).Password
    python scripts/migrate_sqlite_to_postgres.py migrate

2. Unix / Linux / macOS (bash / zsh):
    # A. Source-only dry-run:
    python scripts/migrate_sqlite_to_postgres.py dry-run

    # B. Create local backup:
    python scripts/migrate_sqlite_to_postgres.py backup

    # C. Interactive prompt (no credentials stored in history):
    python scripts/migrate_sqlite_to_postgres.py migrate

    # D. Or pass via secure read:
    export SQLITE_DB_PATH="data/nse_trading_copilot.db"
    read -s -p "Enter Neon Database URL: " NEON_DATABASE_URL; echo; export NEON_DATABASE_URL
    python scripts/migrate_sqlite_to_postgres.py migrate
"""

from __future__ import annotations

from dataclasses import dataclass, field
import datetime
from decimal import Decimal
import getpass
import os
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any
import urllib.parse

from sqlalchemy import create_engine, select
from sqlalchemy.engine import Engine

# Import models for table schema inspection
from app.models import Instrument, PortfolioPosition, PositionExit, TradeEntry, User

# Table insertion & verification order respecting foreign key constraints
TABLE_ORDER: list[str] = [
    "instruments",
    "users",
    "portfolio_positions",
    "trade_entries",
    "position_exits",
]

# Mapping of table names to SQLAlchemy models
TABLE_MODELS: dict[str, Any] = {
    "instruments": Instrument,
    "users": User,
    "portfolio_positions": PortfolioPosition,
    "trade_entries": TradeEntry,
    "position_exits": PositionExit,
}

# auth_sessions is deliberately excluded
EXCLUDED_TABLES: set[str] = {"auth_sessions", "alembic_version"}


# ─────────────────────────────────────────────────────────────────────────────
# Domain Exceptions
# ─────────────────────────────────────────────────────────────────────────────


class MigrationError(Exception):
    """Base exception for data migration errors."""
    pass


class MigrationConflictError(MigrationError):
    """Raised when a target record has the same PK but conflicting data."""
    pass


# ─────────────────────────────────────────────────────────────────────────────
# Reporting Dataclasses
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class TableMigrationResult:
    table: str
    inserted: int = 0
    skipped_identical: int = 0
    conflicts: list[str] = field(default_factory=list)


@dataclass
class MigrationReport:
    success: bool
    results: list[TableMigrationResult] = field(default_factory=list)
    error: str | None = None


@dataclass
class TableVerificationResult:
    table: str
    src_count: int
    dst_count: int
    matched_count: int
    missing_ids: list[str] = field(default_factory=list)
    extra_ids: list[str] = field(default_factory=list)
    mismatches: list[tuple[str, list[str]]] = field(default_factory=list)


@dataclass
class VerificationReport:
    success: bool
    tables: list[TableVerificationResult] = field(default_factory=list)
    has_pre_existing_records: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# Source Database Read-Only Engine
# ─────────────────────────────────────────────────────────────────────────────


def make_sqlite_readonly_engine(sqlite_path: Path) -> Engine:
    """Create a SQLAlchemy engine that opens SQLite strictly in read-only mode.

    Uses a platform-correct SQLite file URI with `?mode=ro&uri=true`, ensuring
    at the SQLite engine and C API level that write operations, schema changes,
    or truncations are impossible.
    """
    resolved = sqlite_path.resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"Source SQLite database not found at: {resolved}")
    posix_path = resolved.as_posix()
    quoted_path = urllib.parse.quote(posix_path)
    url = f"sqlite:///file:///{quoted_path}?mode=ro&uri=true"
    return create_engine(url)


# ─────────────────────────────────────────────────────────────────────────────
# Utility Functions & Column Value Normalization
# ─────────────────────────────────────────────────────────────────────────────


def mask_database_url(url: str) -> str:
    """Mask password and credentials in connection string or error message for safe display."""
    if not url:
        return ""
    try:
        # First try standard URL parsing
        if "://" in url:
            try:
                parsed = urllib.parse.urlsplit(url)
                if "@" in parsed.netloc:
                    userinfo, hostport = parsed.netloc.rsplit("@", 1)
                    if ":" in userinfo:
                        user, _ = userinfo.split(":", 1)
                        masked_netloc = f"{user}:***@{hostport}"
                    else:
                        masked_netloc = f"***@{hostport}"
                    return urllib.parse.urlunsplit(
                        (parsed.scheme, masked_netloc, parsed.path, parsed.query, parsed.fragment)
                    )
            except Exception:
                pass

        # Also apply regex masking for error messages with embedded URLs
        masked = re.sub(r"(://[^:\s]+:)[^@\s]+@([^\s/]+)", r"\1***@\2", url)
        masked = re.sub(r":([^/@:\s]+)@", r":***@", masked)
        return masked
    except Exception:
        return "<masked-database-url>"


def get_sqlite_path(allow_default: bool = True) -> Path:
    """Resolve local SQLite database path from environment or standard default."""
    env_path = os.environ.get("SQLITE_DB_PATH")
    if env_path:
        p = Path(env_path).resolve()
        return p
    if allow_default:
        # Default relative to project backend root or current dir
        default_candidate = Path("data/nse_trading_copilot.db").resolve()
        if default_candidate.exists():
            return default_candidate
        alt_candidate = (Path(__file__).resolve().parents[1] / "data" / "nse_trading_copilot.db").resolve()
        if alt_candidate.exists():
            return alt_candidate
        return default_candidate
    raise ValueError("SQLITE_DB_PATH environment variable is required.")


def get_target_database_url(prompt_if_missing: bool = True) -> str:
    """Retrieve target PostgreSQL URL from environment or secure interactive prompt."""
    url = os.environ.get("NEON_DATABASE_URL") or os.environ.get("TARGET_DATABASE_URL")
    if url:
        return url.strip()

    if prompt_if_missing and sys.stdin.isatty():
        print("NEON_DATABASE_URL is not set in environment.")
        entered = getpass.getpass("Enter target PostgreSQL URL (input hidden): ").strip()
        if entered:
            return entered

    raise ValueError(
        "Target database URL is required. Set NEON_DATABASE_URL environment variable "
        "or provide it when prompted."
    )


def normalize_value_by_column(val: Any, column: Any) -> Any:
    """Normalize a field value based on its SQLAlchemy Column type.

    Normalization is applied strictly when the difference is demonstrably
    caused by database engine representation (e.g. SQLite returning naive UTC
    datetimes vs PostgreSQL returning aware UTC datetimes, or Numeric scale).

    Rules:
    - Strings and Text: NEVER stripped of leading/trailing whitespace.
      Preserves genuine textual differences in notes, names, symbols, etc.
    - DateTime: Microseconds are preserved. Naive timestamps are interpreted as UTC
      per application storage convention; aware timestamps are converted to UTC.
    - Date: Normalized to datetime.date object.
    - Numeric: Quantized to the model-defined scale (Numeric(18, 4) -> 4 decimal places).
    - Boolean: Converted to bool (0/1 -> False/True).
    - Integer: Converted to int.
    """
    if val is None:
        return None

    col_type = column.type
    type_name = type(col_type).__name__

    if type_name == "Boolean":
        return bool(val)

    if type_name == "Integer":
        return int(val)

    if type_name == "Numeric":
        scale = getattr(col_type, "scale", 4) or 4
        quantizer = Decimal("10") ** -scale
        return Decimal(str(val)).quantize(quantizer)

    if type_name == "Date":
        if isinstance(val, datetime.date) and not isinstance(val, datetime.datetime):
            return val
        if isinstance(val, datetime.datetime):
            return val.date()
        if isinstance(val, str):
            return datetime.date.fromisoformat(val)
        return val

    if type_name == "DateTime":
        if isinstance(val, str):
            val = datetime.datetime.fromisoformat(val)
        if isinstance(val, datetime.datetime):
            # Application convention: all timestamps represent UTC.
            # SQLite returns naive datetime; PostgreSQL returns timezone-aware UTC datetime.
            if val.tzinfo is None:
                return val.replace(tzinfo=datetime.timezone.utc)
            return val.astimezone(datetime.timezone.utc)
        return val

    # For String, Text, or any other type: NEVER strip whitespace or alter value
    return val


def records_match(src_row: dict[str, Any], dst_row: dict[str, Any], table_name: str) -> tuple[bool, list[str]]:
    """Compare all table columns between source and target rows.

    Returns (is_match, list_of_mismatched_field_descriptions).
    """
    model = TABLE_MODELS[table_name]
    mismatches: list[str] = []

    for col in model.__table__.columns:
        col_name = col.name
        src_v = src_row.get(col_name)
        dst_v = dst_row.get(col_name)
        norm_src = normalize_value_by_column(src_v, col)
        norm_dst = normalize_value_by_column(dst_v, col)
        if norm_src != norm_dst:
            mismatches.append(f"{col_name}: source={src_v!r} vs target={dst_v!r}")

    return len(mismatches) == 0, mismatches


# ─────────────────────────────────────────────────────────────────────────────
# 1. Consistent SQLite Backup
# ─────────────────────────────────────────────────────────────────────────────


def create_sqlite_backup(sqlite_path: Path, backup_path: Path | None = None) -> Path:
    """Create a consistent snapshot using the SQLite native Backup API.

    The source database is opened in URI read-only mode (`?mode=ro`).
    This guarantees at the C API level that creating a backup cannot modify,
    write to, or truncate the source database file.

    Safeguards:
    - Never overwrites an existing backup file.
    - Prevents specifying the source file as the backup destination.
    - Runs SQLite PRAGMA integrity_check on the generated backup.
    - Safely unlinks incomplete/corrupted backups if backup or integrity check fails.
    """
    sqlite_path = sqlite_path.resolve()
    if not sqlite_path.exists():
        raise FileNotFoundError(f"Source SQLite database not found at: {sqlite_path}")

    if backup_path is None:
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        candidate = sqlite_path.with_suffix(f".{timestamp}.bak.db")
        counter = 1
        while candidate.exists():
            candidate = sqlite_path.with_suffix(f".{timestamp}_{counter}.bak.db")
            counter += 1
        backup_path = candidate
    else:
        backup_path = backup_path.resolve()
        if backup_path == sqlite_path:
            raise ValueError(f"Backup destination cannot be identical to the source database: {backup_path}")
        if backup_path.exists():
            raise FileExistsError(f"Backup destination already exists and will not be overwritten: {backup_path}")

    backup_path.parent.mkdir(parents=True, exist_ok=True)

    # Open source database strictly in read-only mode
    source_uri = f"file:{sqlite_path.as_posix()}?mode=ro"
    src_conn = sqlite3.connect(source_uri, uri=True)
    try:
        dst_conn = sqlite3.connect(backup_path.as_posix())
        try:
            # Native SQLite backup API performs page-by-page atomic copy
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    except Exception:
        if backup_path.exists():
            backup_path.unlink(missing_ok=True)
        raise
    finally:
        src_conn.close()

    if not backup_path.exists() or backup_path.stat().st_size == 0:
        if backup_path.exists():
            backup_path.unlink(missing_ok=True)
        raise RuntimeError(f"Backup verification failed: created backup at {backup_path} is missing or empty.")

    # Integrity check on created backup file
    chk_conn = None
    try:
        chk_conn = sqlite3.connect(backup_path.as_posix())
        cursor = chk_conn.cursor()
        cursor.execute("PRAGMA integrity_check;")
        row = cursor.fetchone()
        if not row or str(row[0]).lower() != "ok":
            raise RuntimeError(f"PRAGMA integrity_check returned: {row}")
    except Exception as exc:
        if chk_conn is not None:
            chk_conn.close()
            chk_conn = None
        if backup_path.exists():
            backup_path.unlink(missing_ok=True)
        raise RuntimeError(f"Backup integrity validation failed for {backup_path}: {exc}") from exc
    finally:
        if chk_conn is not None:
            chk_conn.close()

    return backup_path


# ─────────────────────────────────────────────────────────────────────────────
# 2. Source Inspection & Dry Run
# ─────────────────────────────────────────────────────────────────────────────


def inspect_source(sqlite_engine: Engine, table_order: list[str] = TABLE_ORDER) -> dict[str, int]:
    """Inspect source SQLite database and return row counts for all application tables."""
    counts: dict[str, int] = {}
    with sqlite_engine.connect() as conn:
        for table in table_order:
            model = TABLE_MODELS[table]
            stmt = select(model.__table__)
            rows = conn.execute(stmt).all()
            counts[table] = len(rows)
    return counts


def target_aware_dry_run(
    sqlite_engine: Engine,
    target_engine: Engine,
    table_order: list[str] = TABLE_ORDER,
) -> list[TableMigrationResult]:
    """Perform a read-only comparison against destination to calculate migration impact.

    Does NOT execute any INSERTs or mutations on target.
    """
    results: list[TableMigrationResult] = []

    with sqlite_engine.connect() as src_conn, target_engine.connect() as dst_conn:
        for table in table_order:
            model = TABLE_MODELS[table]
            src_rows = [dict(r) for r in src_conn.execute(select(model.__table__)).mappings()]
            dst_rows_map = {r["id"]: dict(r) for r in dst_conn.execute(select(model.__table__)).mappings()}

            inserted_count = 0
            skipped_count = 0
            conflicts: list[str] = []

            for row in src_rows:
                pk = row["id"]
                if pk in dst_rows_map:
                    matches, mismatches = records_match(row, dst_rows_map[pk], table)
                    if matches:
                        skipped_count += 1
                    else:
                        conflicts.append(f"Row id='{pk}' mismatch: {'; '.join(mismatches)}")
                else:
                    inserted_count += 1

            results.append(
                TableMigrationResult(
                    table=table,
                    inserted=inserted_count,
                    skipped_identical=skipped_count,
                    conflicts=conflicts,
                )
            )

    return results


# ─────────────────────────────────────────────────────────────────────────────
# 3. Transactional Migration
# ─────────────────────────────────────────────────────────────────────────────


def run_migration(
    sqlite_engine: Engine,
    target_engine: Engine,
    table_order: list[str] = TABLE_ORDER,
) -> MigrationReport:
    """Migrate data from SQLite to target PostgreSQL inside a single ACID transaction.

    Features:
    - Normal PostgreSQL constraints enforced throughout (no session_replication_role).
    - Topological insertion order guarantees parent records exist before children.
    - Deterministic ordering (trade entries sorted by sequence).
    - Safe idempotency: matching rows are skipped without error.
    - Conflicting rows raise MigrationConflictError, triggering immediate transaction rollback.
    """
    results: list[TableMigrationResult] = []

    try:
        with sqlite_engine.connect() as src_conn, target_engine.connect() as dst_conn:
            # Wrap all destination writes in an atomic transaction
            with dst_conn.begin():
                for table in table_order:
                    model = TABLE_MODELS[table]
                    src_stmt = select(model.__table__)
                    if table == "trade_entries":
                        src_stmt = src_stmt.order_by(model.__table__.c.position_id, model.__table__.c.sequence)
                    elif table == "portfolio_positions":
                        src_stmt = src_stmt.order_by(model.__table__.c.created_at)

                    src_rows = [dict(r) for r in src_conn.execute(src_stmt).mappings()]

                    # Pre-load existing rows in destination for conflict validation
                    dst_rows_map = {
                        r["id"]: dict(r) for r in dst_conn.execute(select(model.__table__)).mappings()
                    }

                    inserted_count = 0
                    skipped_count = 0

                    for src_row in src_rows:
                        pk = src_row["id"]
                        if pk in dst_rows_map:
                            matches, mismatches = records_match(src_row, dst_rows_map[pk], table)
                            if matches:
                                skipped_count += 1
                            else:
                                err_msg = (
                                    f"Conflict detected in table '{table}' for id='{pk}': "
                                    f"{'; '.join(mismatches)}. Migration aborted to prevent data corruption."
                                )
                                raise MigrationConflictError(err_msg)
                        else:
                            # Insert new record
                            dst_conn.execute(model.__table__.insert().values(**src_row))
                            inserted_count += 1

                    results.append(
                        TableMigrationResult(
                            table=table,
                            inserted=inserted_count,
                            skipped_identical=skipped_count,
                        )
                    )

        return MigrationReport(success=True, results=results)

    except Exception as exc:
        return MigrationReport(success=False, results=results, error=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# 4. Comprehensive Record Verification
# ─────────────────────────────────────────────────────────────────────────────


def verify_migration(
    sqlite_engine: Engine,
    target_engine: Engine,
    table_order: list[str] = TABLE_ORDER,
) -> VerificationReport:
    """Verify data between SQLite and target PostgreSQL beyond simple row counts.

    Validates:
    - Missing rows (in SQLite, missing in target) -> causes failure.
    - Mismatched rows (in both by PK, column values differ) -> causes failure.
    - Extra rows (in target, not in SQLite) -> documented as pre-existing records.
    - Explicitly excludes auth_sessions.
    """
    table_results: list[TableVerificationResult] = []
    overall_success = True
    has_pre_existing = False

    with sqlite_engine.connect() as src_conn, target_engine.connect() as dst_conn:
        for table in table_order:
            model = TABLE_MODELS[table]
            src_map = {r["id"]: dict(r) for r in src_conn.execute(select(model.__table__)).mappings()}
            dst_map = {r["id"]: dict(r) for r in dst_conn.execute(select(model.__table__)).mappings()}

            src_ids = set(src_map.keys())
            dst_ids = set(dst_map.keys())

            missing_in_dst = sorted(src_ids - dst_ids)
            extra_in_dst = sorted(dst_ids - src_ids)
            common_ids = src_ids & dst_ids

            mismatches: list[tuple[str, list[str]]] = []
            matched_count = 0

            for pk in common_ids:
                matches, diffs = records_match(src_map[pk], dst_map[pk], table)
                if matches:
                    matched_count += 1
                else:
                    mismatches.append((pk, diffs))

            if len(missing_in_dst) > 0 or len(mismatches) > 0:
                overall_success = False

            if len(extra_in_dst) > 0:
                has_pre_existing = True

            table_results.append(
                TableVerificationResult(
                    table=table,
                    src_count=len(src_ids),
                    dst_count=len(dst_ids),
                    matched_count=matched_count,
                    missing_ids=missing_in_dst,
                    extra_ids=extra_in_dst,
                    mismatches=mismatches,
                )
            )

    return VerificationReport(
        success=overall_success,
        tables=table_results,
        has_pre_existing_records=has_pre_existing,
    )


# ─────────────────────────────────────────────────────────────────────────────
# CLI Commands
# ─────────────────────────────────────────────────────────────────────────────


def cmd_backup(_args: list[str]) -> None:
    sqlite_path = get_sqlite_path()
    print(f"Creating consistent SQLite backup of {sqlite_path} …")
    try:
        backup_path = create_sqlite_backup(sqlite_path)
        print(f"✓ Backup successfully created: {backup_path}")
        print(f"  Size: {backup_path.stat().st_size:,} bytes")
    except Exception as exc:
        print(f"ERROR: Backup failed: {exc}", file=sys.stderr)
        sys.exit(1)


def cmd_dry_run(_args: list[str]) -> None:
    sqlite_path = get_sqlite_path()
    if not sqlite_path.exists():
        print(f"ERROR: SQLite database not found at {sqlite_path}", file=sys.stderr)
        sys.exit(1)

    sqlite_engine = make_sqlite_readonly_engine(sqlite_path)

    # Check whether target URL is supplied in environment
    target_url = os.environ.get("NEON_DATABASE_URL") or os.environ.get("TARGET_DATABASE_URL")

    if not target_url:
        print("=== DRY RUN (Source-Only Inspection) ===")
        print(f"Source Database: {sqlite_path} (READ-ONLY)")
        print("Target Database: NOT SPECIFIED (To check against target, set NEON_DATABASE_URL)\n")

        counts = inspect_source(sqlite_engine)
        total_rows = 0
        for table in TABLE_ORDER:
            c = counts.get(table, 0)
            total_rows += c
            print(f"  {table:<22} : {c:>5} rows found in source SQLite")

        print(f"\nTotal records to migrate: {total_rows}")
        print("auth_sessions: EXCLUDED (intentional — browser sessions are not migrated)")
        print("\nSource-only inspection complete. No target writes performed.")
        sqlite_engine.dispose()
        return

    # Target-aware dry run
    masked_url = mask_database_url(target_url)
    print("=== DRY RUN (Target-Aware Inspection) ===")
    print(f"Source Database: {sqlite_path} (READ-ONLY)")
    print(f"Target Database: {masked_url}\n")

    target_engine = create_engine(target_url)
    try:
        results = target_aware_dry_run(sqlite_engine, target_engine)
        has_conflicts = False

        for r in results:
            conflict_note = f" [!] {len(r.conflicts)} CONFLICTS" if r.conflicts else ""
            print(
                f"  {r.table:<22} : {r.inserted:>5} to insert, "
                f"{r.skipped_identical:>5} already present{conflict_note}"
            )
            if r.conflicts:
                has_conflicts = True
                for c in r.conflicts[:3]:
                    print(f"      - {c}")
                if len(r.conflicts) > 3:
                    print(f"      ... and {len(r.conflicts) - 3} more conflicts")

        print("\nauth_sessions: EXCLUDED (intentional)")
        if has_conflicts:
            print("\n[WARNING] Conflicting rows detected in target database!")
            print("Running 'migrate' will ABORT and roll back unless conflicts are resolved.")
        else:
            print("\nTarget dry-run complete. Safe to proceed with 'migrate'.")
    finally:
        target_engine.dispose()
        sqlite_engine.dispose()


def confirm_migration(masked_target_url: str, prompt_func: Any = input) -> bool:
    """Prompt user for explicit interactive confirmation before any destination writes.

    Displays the masked destination URL and explains that only the intended
    portfolio tables are migrated, while authentication sessions are excluded.
    Returns True only if user enters 'yes' (case-insensitive).
    Defaults to cancelling if input is empty or unexpected.
    """
    print("\n" + "=" * 60)
    print("MIGRATION CONFIRMATION REQUIRED")
    print("=" * 60)
    print(f"Target Database : {masked_target_url}")
    print("Tables to migrate:")
    for t in TABLE_ORDER:
        print(f"  • {t}")
    print("\nExcluded tables:")
    print("  • auth_sessions (ephemeral browser sessions are NOT migrated)")
    print("=" * 60)
    print("WARNING: This will write migrated records into the target PostgreSQL database.")
    print("To proceed, type 'yes'. Any other input or empty entry will cancel.\n")

    try:
        response = prompt_func("Proceed with migration? [yes/NO]: ").strip().lower()
        return response == "yes"
    except (EOFError, KeyboardInterrupt):
        return False


def cmd_migrate(_args: list[str], prompt_func: Any = input) -> None:
    sqlite_path = get_sqlite_path()
    if not sqlite_path.exists():
        print(f"ERROR: SQLite database not found at {sqlite_path}", file=sys.stderr)
        sys.exit(1)

    try:
        target_url = get_target_database_url()
    except ValueError as exc:
        print(f"ERROR: {mask_database_url(str(exc))}", file=sys.stderr)
        sys.exit(1)

    masked_url = mask_database_url(target_url)

    # 1. Require explicit interactive confirmation BEFORE any destination writes
    if not confirm_migration(masked_url, prompt_func=prompt_func):
        print("\nMigration cancelled by user. No destination writes or backups performed.")
        return

    # 2. Create a consistent, timestamped SQLite backup BEFORE destination writes
    print(f"\n[Step 1/3] Creating consistent SQLite backup of {sqlite_path} …")
    try:
        backup_path = create_sqlite_backup(sqlite_path)
        print(f"✓ Backup successfully created and verified: {backup_path}")
        print(f"  Size: {backup_path.stat().st_size:,} bytes")
    except Exception as exc:
        print(f"ERROR: Backup creation failed: {mask_database_url(str(exc))}", file=sys.stderr)
        print("Migration aborted before connecting to target database.", file=sys.stderr)
        sys.exit(1)

    # 3. Connect to source (read-only) and target
    print(f"\n[Step 2/3] Migrating data: SQLite → PostgreSQL")
    print(f"Source SQLite: {sqlite_path} (READ-ONLY)")
    print(f"Target:        {masked_url}\n")

    sqlite_engine = make_sqlite_readonly_engine(sqlite_path)
    target_engine = create_engine(target_url)

    try:
        report = run_migration(sqlite_engine, target_engine)

        if not report.success:
            print("\n✗ MIGRATION FAILED — TRANSACTION ROLLED BACK", file=sys.stderr)
            print(f"Reason: {mask_database_url(str(report.error))}", file=sys.stderr)
            print("No partial data was committed to the target database.", file=sys.stderr)
            sys.exit(1)

        print("Migration results (applied within single transaction):")
        total_inserted = 0
        total_skipped = 0
        for r in report.results:
            total_inserted += r.inserted
            total_skipped += r.skipped_identical
            print(f"  {r.table:<22} : {r.inserted:>5} inserted, {r.skipped_identical:>5} skipped (already present)")

        print(f"\n✓ Migration transaction committed. Total: {total_inserted} inserted, {total_skipped} skipped.")
        print("Note: auth_sessions was NOT migrated (users must log in once on new environment).")

        # 4. Post-migration verification
        print(f"\n[Step 3/3] Verifying migrated data against destination …")
        v_report = verify_migration(sqlite_engine, target_engine)

        for t in v_report.tables:
            status_symbol = "✓" if (len(t.missing_ids) == 0 and len(t.mismatches) == 0) else "✗"
            extra_note = f" ({len(t.extra_ids)} pre-existing extra)" if t.extra_ids else ""
            print(
                f"  {t.table:<22} : SQLite={t.src_count:>4}, Target={t.dst_count:>4}, "
                f"Matched={t.matched_count:>4} {status_symbol}{extra_note}"
            )
            if t.missing_ids:
                print(f"      - Missing in target ({len(t.missing_ids)} rows): {t.missing_ids[:5]}", file=sys.stderr)
            if t.mismatches:
                print(f"      - Mismatched rows ({len(t.mismatches)} rows):", file=sys.stderr)
                for pk, diffs in t.mismatches[:3]:
                    print(f"          id='{pk}': {'; '.join(diffs)}", file=sys.stderr)

        if not v_report.success:
            print("\n✗ POST-MIGRATION VERIFICATION FAILED: Data mismatch or missing records detected!", file=sys.stderr)
            print("Target database may be in an inconsistent state relative to source SQLite.", file=sys.stderr)
            sys.exit(1)

        print("\n✓ Full migration and verification SUCCEEDED.")
        print("All source records are verified present and identical in the target database.")

    finally:
        target_engine.dispose()
        sqlite_engine.dispose()


def cmd_verify(_args: list[str]) -> None:
    sqlite_path = get_sqlite_path()
    if not sqlite_path.exists():
        print(f"ERROR: SQLite database not found at {sqlite_path}", file=sys.stderr)
        sys.exit(1)

    try:
        target_url = get_target_database_url()
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    masked_url = mask_database_url(target_url)
    print("=== VERIFYING MIGRATED DATA ===")
    print(f"Source SQLite: {sqlite_path} (READ-ONLY)")
    print(f"Target Neon:   {masked_url}\n")

    sqlite_engine = make_sqlite_readonly_engine(sqlite_path)
    target_engine = create_engine(target_url)

    try:
        report = verify_migration(sqlite_engine, target_engine)

        for t in report.tables:
            status_symbol = "✓" if (len(t.missing_ids) == 0 and len(t.mismatches) == 0) else "✗"
            extra_note = f" ({len(t.extra_ids)} pre-existing extra)" if t.extra_ids else ""
            print(
                f"  {t.table:<22} : SQLite={t.src_count:>4}, Target={t.dst_count:>4}, "
                f"Matched={t.matched_count:>4} {status_symbol}{extra_note}"
            )
            if t.missing_ids:
                print(f"      - Missing in target ({len(t.missing_ids)} rows): {t.missing_ids[:5]}")
            if t.mismatches:
                print(f"      - Mismatched rows ({len(t.mismatches)} rows):")
                for pk, diffs in t.mismatches[:3]:
                    print(f"          id='{pk}': {'; '.join(diffs)}")

        print("\nauth_sessions: EXCLUDED from verification (intentional)")

        if report.has_pre_existing_records:
            print("\nNote: Pre-existing target records were detected in destination.")
            print("Pre-existing target rows are preserved and do not cause migration failure if source rows match.")

        if report.success:
            print("\n✓ Verification PASSED: All source records are present and match identically in target.")
        else:
            print("\n✗ Verification FAILED: Missing or mismatched records detected.", file=sys.stderr)
            sys.exit(1)
    finally:
        target_engine.dispose()
        sqlite_engine.dispose()


COMMANDS = {
    "backup": cmd_backup,
    "dry-run": cmd_dry_run,
    "migrate": cmd_migrate,
    "verify": cmd_verify,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"Usage: python {sys.argv[0]} [{' | '.join(COMMANDS)}]")
        sys.exit(1)

    COMMANDS[sys.argv[1]](sys.argv[2:])
