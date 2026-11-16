import { useState } from 'react';

// Decorative presentation only. A parent supplies images/status; no generation or capture dependencies.
export default function RecordBackground({ imageUrl, status = 'ready' }) {
  const [imageState, setImageState] = useState('loading');
  const state = !imageUrl ? 'fallback' : status === 'ready' ? imageState : status;
  return (
    <div className="record-background" aria-hidden="true" data-background-state={state}>
      {imageUrl && status === 'ready' && (
        <img
          className="record-background-image"
          src={imageUrl}
          alt=""
          style={{ visibility: state === 'ready' ? 'visible' : 'hidden' }}
          onLoad={() => setImageState('ready')}
          onError={() => setImageState('error')}
        />
      )}
    </div>
  );
}
