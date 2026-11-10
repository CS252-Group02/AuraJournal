"""Shared request budgets and independent login lookup indexes."""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "rate_limit_buckets",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("attempts > 0", name="ck_rate_limit_positive"),
    )
    op.create_index("ix_rate_limit_buckets_expires_at", "rate_limit_buckets", ["expires_at"])
    op.create_index("ix_login_attempts_email_time", "login_attempts", ["email", "created_at"])
    op.create_index("ix_login_attempts_ip_time", "login_attempts", ["ip", "created_at"])


def downgrade():
    op.drop_index("ix_login_attempts_ip_time", table_name="login_attempts")
    op.drop_index("ix_login_attempts_email_time", table_name="login_attempts")
    op.drop_table("rate_limit_buckets")
