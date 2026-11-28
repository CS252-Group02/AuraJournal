import { Link } from 'react-router-dom';

export function sourceDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value;
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

export default function ChatSources({ sources }) {
  if (!sources?.length) return null;
  return <nav className="chat-sources" aria-label="Source journal entries"><span>From your journals</span>
    {sources.map(source => <Link key={source.entry_id} to={`/journal/${encodeURIComponent(source.entry_id)}`}>{sourceDate(source.journal_date)}</Link>)}
  </nav>;
}
