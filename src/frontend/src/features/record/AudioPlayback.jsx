import { useEffect, useRef, useState } from 'react';

export default function AudioPlayback({ url }) {
  const audio = useRef(null);
  const active = useRef(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = audio.current;
    active.current = true;
    element.src = url;
    return () => {
      active.current = false;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [url]);

  async function replay() {
    setError('');
    try {
      audio.current.currentTime = 0;
      await audio.current.play();
    } catch {
      if (active.current) setError('Playback could not start. Try the audio controls again or reset your recording.');
    }
  }

  return (
    <div className="record-playback">
      <audio
        ref={audio}
        src={url}
        controls
        preload="metadata"
        aria-label="Your recorded audio"
        onPlay={() => { setPlaying(true); setError(''); }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => { setPlaying(false); setError('This audio could not be played. Try replaying it or reset to record again.'); }}
      />
      <button type="button" className="record-action" onClick={replay} disabled={playing}>Replay recording</button>
      {error && <p className="record-feedback record-error" role="alert">{error}</p>}
    </div>
  );
}

