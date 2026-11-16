"""Add a journal date using the MVP's UTC+7 calendar."""

from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "journal_entries", sa.Column("journal_date", sa.Date(), nullable=True)
    )
    # Existing entries have no separately recorded journal day.
    op.execute(sa.text("""
        UPDATE journal_entries
        SET journal_date = (created_at AT TIME ZONE 'Asia/Bangkok')::date
        WHERE journal_date IS NULL
    """))
    op.alter_column(
        "journal_entries", "journal_date",
        existing_type=sa.Date(), nullable=False,
        server_default=sa.text("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date"),
    )


def downgrade():
    # Restore a backup to recover journal dates selected after this migration.
    op.drop_column("journal_entries", "journal_date")
