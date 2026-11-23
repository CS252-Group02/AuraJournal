export default function AutomaticArtDisclosure({ id }) {
  return <p id={id} className="automatic-art-disclosure">
    When automatic artwork is enabled, saving or changing this journal sends its text to Groq and a minimized scene to PixelLab.
    {' '}Art may be symbolic or inaccurate; provider processing, retention and charges may apply.
  </p>;
}
