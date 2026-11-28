import { useEffect, useRef, useState } from 'react';
import { chatApi } from './chatApi.js';
import { safeSupportUrl } from './supportLinks.js';

export default function SupportOptions({ kind, locale }) {
  const [country, setCountry] = useState(''), [state, setState] = useState({});
  const pending = useRef(null);
  useEffect(() => { setState({}); return () => { pending.current?.abort(); pending.current = null; }; }, [locale]);
  function cancel() { pending.current?.abort(); pending.current = null; setState({}); }
  async function lookup(event) {
    event.preventDefault();
    if (!/^[A-Z]{2}$/.test(country)) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setState({ loading: true });
    try {
      const data = await chatApi.support(country, locale, controller.signal);
      if (pending.current === controller && !controller.signal.aborted) setState({ data: data[kind] });
    } catch (error) { if (pending.current === controller && !controller.signal.aborted) setState({ error: error.message }); }
  }
  return <section className="chat-support" aria-label="Support options">
    <form onSubmit={lookup}><label>Country (two-letter code, for example VN)
      <input aria-label="Support country code" value={country} maxLength={2} pattern="[A-Za-z]{2}" required autoComplete="country" onChange={event => { cancel(); setCountry(event.target.value.toUpperCase()); }} />
    </label><button type="submit" className="aj-btn" disabled={state.loading || !/^[A-Z]{2}$/.test(country)}>Find support options</button></form>
    <p>Choose your country to see reviewed support options. Opening a link is your choice. AuraJournal does not contact anyone or send your writing to a support service.</p>
    {state.loading && <p role="status">Loading support options…</p>}
    {state.error && <p role="alert">Could not load support options. You can try again. The guidance above still applies.</p>}
    {state.data && <><p>{state.data.guidance}</p><ul>{state.data.resources.map((resource, index) => {
      const url = safeSupportUrl(resource.url);
      return url ? <li key={index}><a href={url} {...(url.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{resource.label}</a></li> : null;
    })}</ul></>}
  </section>;
}
