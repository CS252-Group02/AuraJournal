import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, toDateKey } from '../../lib/localDate.js';
import { dateInMonth, HEATMAP, heatLevel, moodPresentation, MOODS, monthCells, monthKey, parseMonthKey, shiftMonth } from './calendarModel.js';

const EMPTY_MOODS = new Map();
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function Calendar({ month, todayKey, selectedKey, mode, byDay, status,
  onMonthChange, onToday, onModeChange, onSelectDate, moodsByDay = EMPTY_MOODS }) {
  const displayedMonth = monthKey(month);
  const cells = useMemo(() => monthCells(month), [displayedMonth]);
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const preferredFocus = selectedKey || (todayKey.startsWith(`${displayedMonth}-`) ? todayKey : toDateKey(cells.find(Boolean)));
  const [focusedKey, setFocusedKey] = useState(preferredFocus);
  const controls = useRef(new Map());
  const pendingFocus = useRef(null);
  const ready = status === 'ready';
  const tabKey = focusedKey.startsWith(`${displayedMonth}-`) ? focusedKey : preferredFocus;

  useEffect(() => {
    if (pendingFocus.current && controls.current.has(pendingFocus.current)) {
      controls.current.get(pendingFocus.current).focus();
      pendingFocus.current = null;
    }
  }, [focusedKey, displayedMonth, ready]);

  function moveFocus(event, date) {
    let next;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(offsets, event.key)) next = addDays(date, offsets[event.key]);
    else if (event.key === 'Home') {
      next = dateInMonth(month, Math.max(1, date.getDate() - ((date.getDay() + 6) % 7)));
    } else if (event.key === 'End') {
      next = dateInMonth(month, date.getDate() + 6 - ((date.getDay() + 6) % 7));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      next = dateInMonth(shiftMonth(month, event.key === 'PageUp' ? -1 : 1), date.getDate());
    } else return;
    event.preventDefault();
    if (!parseMonthKey(monthKey(next))) return;
    const key = toDateKey(next);
    pendingFocus.current = key;
    setFocusedKey(key);
    if (monthKey(next) !== displayedMonth) onMonthChange(next);
    // Home/End can point to the already focused day and need no rerender.
    else if (key === focusedKey) { controls.current.get(key)?.focus(); pendingFocus.current = null; }
  }

  const previous = shiftMonth(month, -1), next = shiftMonth(month, 1);
  const legend = mode === 'heatmap' ? HEATMAP
    : [...Object.values(MOODS), { label: 'Mood unavailable', color: HEATMAP[0].color }];

  return (
    <section className="calendar" aria-label="Journal calendar">
      <div className="calendar-heading">
        <h2 id="calendar-month" aria-live="polite" aria-atomic="true">{monthLabel}</h2>
        <div className="calendar-mode" role="group" aria-label="Calendar display">
          <button type="button" aria-pressed={mode === 'mood'} onClick={() => onModeChange('mood')}>Mood</button>
          <button type="button" aria-pressed={mode === 'heatmap'} onClick={() => onModeChange('heatmap')}>Heatmap</button>
        </div>
      </div>
      <div className="calendar-navigation">
        <div role="group" aria-label="Calendar month navigation">
          <button type="button" aria-label="Previous month" disabled={monthKey(previous) === displayedMonth}
            onClick={() => onMonthChange(previous)}>←</button>
          <button type="button" onClick={onToday}>Today</button>
          <button type="button" aria-label="Next month" disabled={monthKey(next) === displayedMonth}
            onClick={() => onMonthChange(next)}>→</button>
        </div>
        <p id="calendar-help">Select a date to open its journal or choose an entry.</p>
      </div>
      <table className="calendar-grid" role="grid" aria-labelledby="calendar-month" aria-describedby="calendar-help"
        aria-busy={status === 'loading'}>
        <thead><tr role="row">{WEEKDAYS.map(day => (
          <th key={day} scope="col" role="columnheader"><abbr title={day}>{day.slice(0, 3)}</abbr></th>
        ))}</tr></thead>
        <tbody>{Array.from({ length: cells.length / 7 }, (_, row) => (
          <tr key={row} role="row">{cells.slice(row * 7, row * 7 + 7).map((date, column) => {
            if (!date) return <td key={`empty-${column}`} role="gridcell" className="calendar-empty" />;
            const key = toDateKey(date);
            const entries = ready ? byDay.get(key) || [] : [];
            const count = entries.length;
            const mood = moodPresentation(moodsByDay.get(key));
            const color = mode === 'heatmap' ? HEATMAP[heatLevel(count)].color : count && mood ? mood.color : HEATMAP[0].color;
            const label = `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, ${ready
              ? `${count} ${count === 1 ? 'journal' : 'journals'}${mode === 'mood' && count ? `, ${mood?.label || 'mood unavailable'}` : ''}`
              : 'journal activity unavailable'}${key === todayKey ? ', today' : ''}`;
            const properties = {
              className: `calendar-day${key === todayKey ? ' is-today' : ''}${key === selectedKey ? ' is-selected' : ''}`,
              style: { '--calendar-day-color': color },
              'aria-label': label,
              'aria-current': key === todayKey ? 'date' : undefined,
              tabIndex: ready && key === tabKey ? 0 : -1,
              ref: element => { if (element) controls.current.set(key, element); else controls.current.delete(key); },
              onFocus: () => setFocusedKey(key),
              onKeyDown: event => moveFocus(event, date),
              'data-date': key,
            };
            const content = <><span>{date.getDate()}</span>{count > 0 && <span className="calendar-entry-dot" aria-hidden="true" />}</>;
            return (
              <td key={key} role="gridcell" aria-selected={key === selectedKey}>
                {count === 1
                  ? <Link {...properties} to={`/journal/${encodeURIComponent(entries[0].id)}`}>{content}</Link>
                  : <button {...properties} type="button" disabled={!ready} onClick={() => onSelectDate(key)}>{content}</button>}
              </td>
            );
          })}</tr>
        ))}</tbody>
      </table>
      <ul className="calendar-legend" aria-label={mode === 'heatmap' ? 'Entries per day' : 'Mood color legend'}>
        {legend.map(item => <li key={item.label}><span style={{ background: item.color }} aria-hidden="true" />{item.label}</li>)}
      </ul>
      {mode === 'mood' && moodsByDay.size === 0 && <p className="calendar-mood-note">
        Mood information is not available for these entries yet. Dots mark dates with journals.
      </p>}
      <p className="visually-hidden">Use arrow keys to move between dates, Home and End within a row, and Page Up or Page Down to change months.</p>
    </section>
  );
}
