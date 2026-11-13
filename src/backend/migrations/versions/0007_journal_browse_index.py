"""Index the owner/date filter and deterministic journal browsing order."""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

INDEX = "ix_journal_entries_owner_date"


def upgrade():
    op.create_index(INDEX, "journal_entries", ["user_id", "journal_date", "created_at", "id"])
    # The new index also supports the existing user_id prefix lookup.
    op.drop_index("ix_journal_entries_user_id", table_name="journal_entries")


def downgrade():
    op.create_index("ix_journal_entries_user_id", "journal_entries", ["user_id"])
    op.drop_index(INDEX, table_name="journal_entries")
