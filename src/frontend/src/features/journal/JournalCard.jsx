import { Link } from 'react-router-dom';

import { entryPreview, entryTitle, entryTone, readMinutes } from './entryText.js';

export function longDate(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${date.toLocaleDateString(undefined, { weekday: 'long' })}`;
}

export function entryTime(value) {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function JournalCard({ entry }) {
  const preview = entryPreview(entry.content);
  return (
    <Link to={`/journal/${entry.id}`} className={`journal-card tone-${entryTone(entry.id)}`}>
      <div className="journal-card-top">
        <span className="aj-kicker">{entryTime(entry.created_at)}</span>
        <h3>{entryTitle(entry.content)}</h3>
      </div>
      <div className="journal-card-body">
        <time className="aj-kicker" dateTime={entry.created_at}>{longDate(entry.created_at)}</time>
        {preview && <p>{preview}</p>}
        <div className="journal-card-meta">
          <span>{readMinutes(entry.content)} min read</span>
          {entry.ai_summary && <span className="aj-ai-badge">✦ AI reflection</span>}
        </div>
      </div>
    </Link>
  );
}
