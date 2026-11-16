import { Link } from 'react-router-dom';
import { parseDateKey, toDateKey } from '../../lib/localDate.js';
import { monthCells } from './calendarModel.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function CalendarPreview({ todayKey, byDay, status }) {
  const today = parseDateKey(todayKey);
  const cells = monthCells(new Date(today.getFullYear(), today.getMonth(), 1));
  const ready = status === 'ready';
  return (
    <section className="home-calendar" aria-labelledby="home-calendar-heading" aria-busy={status === 'loading'}>
      <div className="home-section-head">
        <h2 id="home-calendar-heading">{today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        <Link to="/dashboard">Open Dashboard <span aria-hidden="true">↗</span></Link>
      </div>
      <table aria-labelledby="home-calendar-heading">
        <thead><tr>{WEEKDAYS.map(day => <th key={day} scope="col"><abbr title={day}>{day.slice(0, 1)}</abbr></th>)}</tr></thead>
        <tbody>{Array.from({ length: cells.length / 7 }, (_, row) => <tr key={row}>
          {cells.slice(row * 7, row * 7 + 7).map((date, column) => {
            if (!date) return <td key={`empty-${column}`} />;
            const key = toDateKey(date), entries = ready ? byDay.get(key) || [] : [];
            const label = `${date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}, ${ready
              ? `${entries.length} ${entries.length === 1 ? 'journal' : 'journals'}` : 'activity unavailable'}${key === todayKey ? ', today' : ''}`;
            const props = { className: `home-calendar-day${key === todayKey ? ' is-today' : ''}${entries.length ? ' has-entries' : ''}`,
              'aria-current': key === todayKey ? 'date' : undefined, 'aria-label': label };
            const content = <>{date.getDate()}{entries.length > 0 && <span className="home-activity-dot" aria-hidden="true" />}</>;
            return <td key={key}>{entries.length ? <Link {...props} to={entries.length === 1
              ? `/journal/${encodeURIComponent(entries[0].id)}` : `/dashboard?month=${key.slice(0, 7)}&date=${key}`}>{content}</Link>
              : <span {...props}>{content}</span>}</td>;
          })}
        </tr>)}</tbody>
      </table>
      <p className="home-calendar-note">{ready ? <><span className="home-activity-dot" aria-hidden="true" /> A moment you made your own</>
        : status === 'loading' ? 'Gathering your journal activity…' : 'Activity is unavailable until your journals can be loaded.'}</p>
    </section>
  );
}
