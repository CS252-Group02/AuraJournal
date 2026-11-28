import { useEffect, useState } from 'react';
import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import SlidingPill from '../components/ui/SlidingPill.jsx';
import AppearanceToggle from '../theme/AppearanceToggle.jsx';
import { clearLastOpened, getLastOpened } from '../features/journal/recentlyOpened.js';
import { usePreferences } from '../features/settings/usePreferences.js';

export function microphoneOptions(devices, saved) {
  const inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default');
  const options = inputs.map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
  if (saved && !options.some(option => option.id === saved)) options.push({ id: saved, label: 'Saved microphone (not connected)' });
  return options;
}

function useMicrophones(saved) {
  const [devices, setDevices] = useState([]);
  useEffect(() => {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.enumerateDevices) return undefined;
    let active = true;
    const load = () => media.enumerateDevices().then(list => { if (active) setDevices(list); }).catch(() => {});
    load();
    media.addEventListener?.('devicechange', load);
    return () => { active = false; media.removeEventListener?.('devicechange', load); };
  }, []);
  return microphoneOptions(devices, saved);
}

function Choice({ label, value, options, onChange }) {
  return <div className="appearance-toggle has-pill" role="group" aria-label={label}>
    <SlidingPill active={value} />
    {options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key}
      onClick={() => onChange(key)}>{text}</button>)}
  </div>;
}

function Switch({ id, checked, onChange }) {
  return <button type="button" role="switch" className="settings-switch" aria-labelledby={id} aria-checked={checked}
    onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>;
}

function Row({ title, titleId, htmlFor, hint, children }) {
  return <div className="settings-row">
    <div className="settings-row-text">
      {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span id={titleId}>{title}</span>}
      {hint && <p>{hint}</p>}
    </div>
    {children}
  </div>;
}

function Section({ id, title, children }) {
  return <section className="settings-section" aria-labelledby={id}>
    <h2 id={id} className="aj-kicker">{title}</h2>
    <div className="settings-card">{children}</div>
  </section>;
}

function SettingsContent({ user }) {
  const [preferences, update] = usePreferences();
  const microphones = useMicrophones(preferences.microphone);
  const [remembered, setRemembered] = useState(() => Boolean(getLastOpened(user.id)));
  const unnamed = microphones.some(option => /^Microphone \d+$/.test(option.label));

  function forget() {
    clearLastOpened(user.id);
    setRemembered(false);
  }

  return (
    <main className="aj-page settings-page">
      <div className="aj-inner">
        <PageHeader />
        <header className="aj-title"><div><h1>Settings</h1><p>Saved on this device.</p></div></header>

        <Section id="settings-look" title="Look and feel">
          <Row title="Appearance" titleId="settings-appearance"><AppearanceToggle /></Row>
          <Row title="Animations" titleId="settings-motion" hint="System follows your device’s reduced-motion setting.">
            <Choice label="Animations" value={preferences.motion} onChange={motion => update({ motion })}
              options={[['system', 'System'], ['reduced', 'Reduced']]} />
          </Row>
        </Section>

        <Section id="settings-journaling" title="Journaling">
          <Row title="Start journaling with" titleId="settings-start" hint="The main button on the home page.">
            <Choice label="Start journaling with" value={preferences.startWith} onChange={startWith => update({ startWith })}
              options={[['voice', 'Voice'], ['writing', 'Writing']]} />
          </Row>
          <Row title="Microphone" htmlFor="settings-microphone" hint={unnamed ? 'Names appear after you allow microphone access.' : ''}>
            <select id="settings-microphone" className="settings-select" value={preferences.microphone}
              onChange={event => update({ microphone: event.target.value })}>
              <option value="">Default microphone</option>
              {microphones.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </Row>
          <Row title="AI proofreading" titleId="settings-proofread" hint="Tidy the transcript before you review it.">
            <Switch id="settings-proofread" checked={preferences.proofread} onChange={proofread => update({ proofread })} />
          </Row>
        </Section>

        <Section id="settings-home" title="Home page">
          <Row title="Quote of the day" titleId="settings-quote">
            <Switch id="settings-quote" checked={preferences.showQuote} onChange={showQuote => update({ showQuote })} />
          </Row>
          <Row title="Show streak" titleId="settings-streak" hint="The dashboard always shows it.">
            <Switch id="settings-streak" checked={preferences.showStreak} onChange={showStreak => update({ showStreak })} />
          </Row>
        </Section>

        <Section id="settings-device" title="This device">
          <Row title="Last opened journal" titleId="settings-recent">
            <div className="settings-action">
              <span role="status">{remembered ? 'Remembered' : 'Nothing saved'}</span>
              <button type="button" className="aj-btn aj-btn-outline" disabled={!remembered} onClick={forget}>Forget</button>
            </div>
          </Row>
        </Section>
      </div>
    </main>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  return <SettingsContent key={user.id} user={user} />;
}
