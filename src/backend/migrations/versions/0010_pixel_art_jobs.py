"""Durable automatic pixel generation; deliberately no historical job backfill."""
from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("journal_entries", sa.Column("content_version", sa.Integer(), nullable=False, server_default="1"))
    op.create_table(
        "pixel_art_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("entry_id", sa.Uuid(), sa.ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempt_token", sa.Uuid(), nullable=True),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("entry_id", "source_version", name="uq_pixel_art_jobs_version"),
        sa.CheckConstraint("status IN ('pending','processing','ready','failed','unavailable','uncertain','cancelled')",
                           name="ck_pixel_art_jobs_status"),
        sa.CheckConstraint("attempts BETWEEN 0 AND 2", name="ck_pixel_art_jobs_attempts"),
    )
    op.create_index("ix_pixel_art_jobs_due", "pixel_art_jobs", ["status", "available_at"])


def downgrade():
    op.drop_table("pixel_art_jobs")
    op.drop_column("journal_entries", "content_version")
