import { Link } from 'react-router-dom';
import NavigationIcon from './NavigationIcon.jsx';

export default function FloatingRecordButton() {
  return <Link className="floating-record" to="/record" aria-label="Start a voice journal" title="Start a voice journal">
    <NavigationIcon name="microphone" />
  </Link>;
}
