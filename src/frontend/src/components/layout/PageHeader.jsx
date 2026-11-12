import { Link } from 'react-router-dom';

export default function PageHeader({ initial }) {
  return (
    <div className="aj-topbar">
      <nav className="aj-breadcrumb" aria-label="Breadcrumb">
        <Link to="/">AuraJournal</Link>
        <span aria-hidden="true">/</span>
        <span>Your private space</span>
      </nav>
      {initial && <span className="aj-avatar" aria-hidden="true">{initial}</span>}
    </div>
  );
}
