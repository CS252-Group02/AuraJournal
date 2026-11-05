import outerHalo from './assets/record-outer-halo.svg';
import innerHalo from './assets/record-inner-halo.svg';
import recordCircle from './assets/record-circle.svg';
import recordIcon from './assets/record-icon.svg';
import mascotFace from './assets/record-mascot-face.svg';
import mascotEye from './assets/record-mascot-eye.svg';
import mascotBlush from './assets/record-mascot-blush.svg';
import mascotLeaf from './assets/record-mascot-leaf.svg';
import './record.css';

// Static Ready state. The background source can be supplied independently of the UI.
export default function Record({ backgroundImage }) {
  return (
    <main className="record-page" aria-label="Record journal">
      <div className="record-background" aria-hidden="true">
        {backgroundImage && <img className="record-background-image" src={backgroundImage} alt="" />}
        <div className="record-background-ambiance" />
        <div className="record-background-light" />
      </div>

      <button className="record-sidebar-toggle" type="button" aria-label="Open sidebar" disabled>
        <span aria-hidden="true">»</span>
      </button>

      <header className="record-brand">
        <h1>{'✦  AuraJournal'}</h1>
        <p>YOUR PRIVATE VOICE JOURNAL</p>
      </header>

      <div className="record-content">
        <div className="record-primary">
          <img className="record-outer-halo" src={outerHalo} alt="" />
          <img className="record-inner-halo" src={innerHalo} alt="" />
          <button className="record-trigger" type="button" aria-labelledby="record-label" disabled>
            <img src={recordCircle} alt="" />
            <img className="record-icon" src={recordIcon} alt="" />
          </button>
          <p className="record-label" id="record-label">Record</p>
        </div>

        <section className="record-transcript" aria-labelledby="record-transcript-heading">
          <h2 id="record-transcript-heading">YOUR WORDS WILL APPEAR HERE</h2>
          <p>Your voice will become words here as you speak.</p>
        </section>
      </div>

      <aside className="record-mascot" aria-label="Your journal companion">
        <p className="record-mascot-speech">Whenever you are ready, I am here.</p>
        <div aria-hidden="true">
          <img className="record-mascot-face" src={mascotFace} alt="" />
          <img className="record-mascot-eye-left" src={mascotEye} alt="" />
          <img className="record-mascot-eye-right" src={mascotEye} alt="" />
          <img className="record-mascot-blush-left" src={mascotBlush} alt="" />
          <img className="record-mascot-blush-right" src={mascotBlush} alt="" />
          <img className="record-mascot-leaf" src={mascotLeaf} alt="" />
        </div>
      </aside>

      <span className="record-back">{'←  Back to Main'}</span>
    </main>
  );
}
