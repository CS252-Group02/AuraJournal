import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import PixelMemories from '../features/pixelMemories/PixelMemories.jsx';
import { useLocalDay } from '../lib/useLocalDay.js';

export default function PixelMemoriesPage() {
  const { user } = useAuth();
  const { todayKey, timezone } = useLocalDay();
  return <main className="aj-page pixel-memories-page">
    <div className="aj-inner">
      <PageHeader />
      <PixelMemories key={user.id} userId={user.id} todayKey={todayKey} timezone={timezone} />
    </div>
  </main>;
}
