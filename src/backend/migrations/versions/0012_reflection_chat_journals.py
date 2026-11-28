"""Per-conversation journal access and references for grounded replies."""
from alembic import op
import sqlalchemy as sa

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('reflection_chats', sa.Column('use_journals', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('reflection_chats', sa.Column('journal_access_version', sa.Integer(), nullable=False, server_default='0'))
    op.create_check_constraint('ck_reflection_chats_access_version', 'reflection_chats', 'journal_access_version >= 0')
    op.add_column('reflection_chat_messages', sa.Column('journal_context_used', sa.Boolean(), nullable=False, server_default='false'))
    op.create_table(
        'reflection_chat_sources',
        sa.Column('message_id', sa.Uuid(), sa.ForeignKey('reflection_chat_messages.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('entry_id', sa.Uuid(), sa.ForeignKey('journal_entries.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('journal_date', sa.Date(), nullable=False),
        sa.Column('content_version', sa.Integer(), nullable=False),
    )
    op.create_index('ix_reflection_chat_sources_entry', 'reflection_chat_sources', ['entry_id'])


def downgrade():
    op.drop_table('reflection_chat_sources')
    op.drop_column('reflection_chat_messages', 'journal_context_used')
    op.drop_constraint('ck_reflection_chats_access_version', 'reflection_chats', type_='check')
    op.drop_column('reflection_chats', 'journal_access_version')
    op.drop_column('reflection_chats', 'use_journals')
