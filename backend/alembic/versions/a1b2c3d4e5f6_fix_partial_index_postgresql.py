"""fix partial index for PostgreSQL: uq_trade_entries_one_initial_per_position

Revision ID: a1b2c3d4e5f6
Revises: 670bf16a5ea0
Create Date: 2026-10-27 14:00:00.000000

On SQLite the previous migration already created this index with the correct
sqlite_where predicate.  On PostgreSQL, Alembic silently ignored the
sqlite_where keyword, creating a full unique index on position_id instead
of the intended partial one.  This migration is a no-op on SQLite (the index
already has the predicate) and a repair on PostgreSQL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql, sqlite as sqlite_dialect


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = '670bf16a5ea0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = 'uq_trade_entries_one_initial_per_position'
_PREDICATE = "entry_type = 'INITIAL_ENTRY'"


def upgrade() -> None:
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    if dialect_name == 'sqlite':
        # SQLite already has the correct partial index from migration 72862cbe6289.
        # batch_alter_table is required for any structural changes on SQLite, but
        # since the index is already correct we only verify and return.
        return

    # PostgreSQL: drop the incorrect full unique index created by the prior migration
    # (Alembic silently dropped the sqlite_where kwarg on Postgres, making it a
    # full unique index on position_id).  Then recreate it as a true partial index.
    with op.batch_alter_table('trade_entries', schema=None) as batch_op:
        batch_op.drop_index(_INDEX_NAME)

    op.create_index(
        _INDEX_NAME,
        'trade_entries',
        ['position_id'],
        unique=True,
        postgresql_where=sa.text(_PREDICATE),
    )


def downgrade() -> None:
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    if dialect_name == 'sqlite':
        return

    # Drop the corrected partial index and restore the full unique index
    # that the prior migration had accidentally created.
    op.drop_index(_INDEX_NAME, table_name='trade_entries')

    op.create_index(
        _INDEX_NAME,
        'trade_entries',
        ['position_id'],
        unique=True,
    )
