export default function NavigationIcon({ name }) {
  const paths = {
    main: <><path d="m3 10 9-7 9 7" /><path d="M5 9v12h5v-7h4v7h5V9" /></>,
    dashboard: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4m8-4v4M8 13h1m6 0h1m-8 4h1m6 0h1" /></>,
    history: <><path d="M5 3h13a1 1 0 0 1 1 1v17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M5 17h14M7 7h8m-8 4h6" /></>,
    memories: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 15h5v-4h4v6h4v-4h5M7 7h2v2H7z" /></>,
    reflection: <><path d="M12 3v5m0 8v5M3 12h5m8 0h5M5.6 5.6l3 3m6.8 6.8 3 3m0-12.8-3 3m-6.8 6.8-3 3" /><circle cx="12" cy="12" r="3" /></>,
    microphone: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    expand: <path d="m8 5 7 7-7 7" />,
  };
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
