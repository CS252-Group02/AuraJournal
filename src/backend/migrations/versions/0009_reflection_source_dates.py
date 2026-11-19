"""Preserve weekly reflection evidence without inventing historical sources."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("weekly_reflections", sa.Column("source_dates", JSONB(none_as_null=True), nullable=True))
    op.create_check_constraint(
        "ck_weekly_reflections_source_dates", "weekly_reflections",
        """source_dates IS NULL OR CASE WHEN jsonb_typeof(source_dates) = 'array' THEN
            jsonb_array_length(source_dates) BETWEEN 1 AND 7
            AND NOT jsonb_path_exists(source_dates, '$[*] ? (@.type() != "string")')
        ELSE false END""",
    )


def downgrade():
    op.drop_constraint("ck_weekly_reflections_source_dates", "weekly_reflections", type_="check")
    op.drop_column("weekly_reflections", "source_dates")
