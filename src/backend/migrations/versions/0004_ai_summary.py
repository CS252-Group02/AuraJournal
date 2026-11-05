"""Store the latest AI summary for each journal entry."""

from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("journal_entries", sa.Column("ai_summary", sa.Text(), nullable=True))
    op.add_column(
        "journal_entries",
        sa.Column("ai_reflection_question", sa.Text(), nullable=True),
    )
    op.add_column(
        "journal_entries",
        sa.Column("ai_summarized_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    op.drop_column("journal_entries", "ai_summarized_at")
    op.drop_column("journal_entries", "ai_reflection_question")
    op.drop_column("journal_entries", "ai_summary")
