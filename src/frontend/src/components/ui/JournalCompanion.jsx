// Reuses the CSS-drawn companion from Main and Record without a new asset.
export default function JournalCompanion({ message, children }) {
  return <aside className="journal-companion" aria-label="Your journal companion">
    <div className="journal-companion-art" aria-hidden="true">
      <span className="journal-companion-face"><span className="journal-companion-eyes" /><span className="journal-companion-blush" /></span>
    </div>
    <div><span className="aj-kicker">A little space for you</span><p>{message}</p>{children}</div>
  </aside>;
}
