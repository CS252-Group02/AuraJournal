"""Add revocable sessions, login throttling, and normalized emails."""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    if connection.execute(sa.text(
        "SELECT 1 FROM users GROUP BY lower(btrim(email)) HAVING count(*) > 1 LIMIT 1"
    )).first():
        raise RuntimeError("Existing user emails collide after normalization; resolve duplicates before migration.")
    op.execute("UPDATE users SET email = lower(btrim(email))")
    op.create_check_constraint("ck_users_normalized_email", "users", "email = lower(btrim(email))")
    op.create_table(
        "auth_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    op.create_table(
        "login_attempts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("ip", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_login_attempts_identity", "login_attempts", ["email", "ip", "created_at"])


def downgrade():
    op.drop_table("login_attempts")
    op.drop_table("auth_sessions")
    op.drop_constraint("ck_users_normalized_email", "users", type_="check")
