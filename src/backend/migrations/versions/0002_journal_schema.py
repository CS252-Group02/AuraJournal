"""Introduce users, UUID entries, mood records, and journal images.

Original numeric entry IDs are not retained. Restore a pre-migration backup
rather than downgrading this data conversion.
"""
from uuid import UUID

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

DEVELOPMENT_USER_ID = UUID("00000000-0000-4000-8000-000000000001")


def created_at():
    return sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                     server_default=sa.func.now())


def updated_at():
    return sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                     server_default=sa.func.now())


def upgrade():
    users = op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(), nullable=False),
        created_at(), updated_at(),
    )
    op.bulk_insert(users, [{
        "id": DEVELOPMENT_USER_ID,
        "email": "development@aurajournal.local",
        # Not a usable password hash; future authentication must reject it.
        "password_hash": "!disabled",
    }])

    # PostgreSQL 14+ supplies gen_random_uuid() without an extension.
    op.alter_column("journal_entries", "id", server_default=None)
    op.alter_column("journal_entries", "id", type_=sa.Uuid(),
                    postgresql_using="gen_random_uuid()")
    op.alter_column("journal_entries", "content", type_=sa.Text())
    op.add_column("journal_entries", sa.Column("user_id", sa.Uuid(), nullable=True))
    op.add_column("journal_entries", sa.Column(
        "updated_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(sa.text(
        "UPDATE journal_entries SET user_id = '00000000-0000-4000-8000-000000000001', "
        "updated_at = created_at"
    ))
    op.alter_column("journal_entries", "user_id", nullable=False)
    op.alter_column("journal_entries", "updated_at", nullable=False,
                    server_default=sa.func.now())
    op.create_foreign_key("fk_journal_entries_user_id", "journal_entries", "users",
                          ["user_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_journal_entries_user_id", "journal_entries", ["user_id"])

    op.create_table(
        "mood_records",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("entry_id", sa.Uuid(), sa.ForeignKey("journal_entries.id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("valence", sa.Float(), nullable=False),
        sa.Column("arousal", sa.Float(), nullable=False),
        created_at(),
    )
    op.create_table(
        "journal_images",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("entry_id", sa.Uuid(), sa.ForeignKey("journal_entries.id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("image_url", sa.Text(), nullable=False),
        sa.Column("file_format", sa.String(), nullable=False, server_default="png"),
        created_at(),
    )


def downgrade():
    raise RuntimeError(
        "Migration 0002 cannot recover original numeric IDs. Restore the pre-migration backup."
    )
