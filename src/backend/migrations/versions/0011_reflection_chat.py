"""Private reflection conversations and their completed turns."""
from alembic import op
import sqlalchemy as sa

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'reflection_chats',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('title', sa.String(60), nullable=False, server_default='New reflection'),
        sa.Column('revision', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint('revision >= 0', name='ck_reflection_chats_revision'),
    )
    op.create_index('ix_reflection_chats_owner_activity', 'reflection_chats', ['user_id', 'updated_at', 'id'])
    op.create_table(
        'reflection_chat_messages',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('chat_id', sa.Uuid(), sa.ForeignKey('reflection_chats.id', ondelete='CASCADE'), nullable=False),
        sa.Column('turn_id', sa.Uuid(), nullable=False),
        sa.Column('revision', sa.Integer(), nullable=False),
        sa.Column('role', sa.String(9), nullable=False),
        sa.Column('text', sa.String(2000), nullable=False),
        sa.Column('outcome', sa.String(20)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint('chat_id', 'revision', 'role', name='uq_reflection_chat_revision_role'),
        sa.UniqueConstraint('chat_id', 'turn_id', 'role', name='uq_reflection_chat_turn_role'),
        sa.CheckConstraint('revision > 0', name='ck_reflection_chat_messages_revision'),
        sa.CheckConstraint(
            "(role = 'user' AND outcome IS NULL) OR "
            "(role = 'assistant' AND outcome IS NOT NULL AND outcome IN "
            "('reflection','out_of_scope','mood_boundary','professional_support','urgent_support'))",
            name='ck_reflection_chat_message_role_outcome',
        ),
    )


def downgrade():
    op.drop_table('reflection_chat_messages')
    op.drop_table('reflection_chats')
