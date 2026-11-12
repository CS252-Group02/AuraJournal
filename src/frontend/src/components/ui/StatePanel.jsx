export function StatePanel({ icon, title, children, action, tone = 'neutral', role }) {
  return (
    <section className={`aj-state aj-state-${tone}`} role={role}>
      {icon && <div className="aj-state-icon" aria-hidden="true">{icon}</div>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="aj-state-action">{action}</div>}
    </section>
  );
}

export function Skeleton({ count = 3, className = '' }) {
  return (
    <div className={`aj-skeletons ${className}`} role="status" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      {Array.from({ length: count }, (_, index) => <div key={index} className="aj-skeleton" aria-hidden="true" />)}
    </div>
  );
}
