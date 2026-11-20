import { Link } from 'react-router-dom';
import AccountMenu from './AccountMenu.jsx';

export default function PageHeader() {
  return (
    <div className="aj-topbar">
      <nav className="aj-breadcrumb" aria-label="Breadcrumb">
        <Link to="/">AuraJournal</Link>
        <span aria-hidden="true">/</span>
        <span>Your private space</span>
      </nav>
      <AccountMenu />
    </div>
  );
}
