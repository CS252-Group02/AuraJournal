"""Store a weekly reflection for each owner and seven-day period."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "weekly_reflections",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("period_start", sa.Date(), primary_key=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("questions", JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.CheckConstraint("btrim(summary) <> ''", name="ck_weekly_reflections_summary"),
        sa.CheckConstraint(
            """CASE WHEN jsonb_typeof(questions) = 'array' THEN
                jsonb_array_length(questions) = 2
                AND jsonb_typeof(questions -> 0) = 'string'
                AND jsonb_typeof(questions -> 1) = 'string'
                AND btrim(questions ->> 0) <> '' AND btrim(questions ->> 1) <> ''
            ELSE false END""",
            name="ck_weekly_reflections_questions",
        ),
    )


def downgrade():
    op.drop_table("weekly_reflections")
