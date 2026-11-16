"""Store two reflection questions for each journal entry."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "journal_entries",
        sa.Column("ai_reflection_questions", JSONB(), nullable=True),
    )
    op.execute(
        """UPDATE journal_entries
           SET ai_reflection_questions = jsonb_build_array(ai_reflection_question)
           WHERE ai_reflection_question IS NOT NULL"""
    )
    op.drop_column("journal_entries", "ai_reflection_question")


def downgrade():
    op.add_column(
        "journal_entries",
        sa.Column("ai_reflection_question", sa.Text(), nullable=True),
    )
    op.execute(
        """UPDATE journal_entries
           SET ai_reflection_question = ai_reflection_questions ->> 0
           WHERE ai_reflection_questions IS NOT NULL"""
    )
    op.drop_column("journal_entries", "ai_reflection_questions")
