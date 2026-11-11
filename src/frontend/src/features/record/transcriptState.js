export const contentLength = (text) => Array.from(text).length;
export const validContent = (text) => typeof text === 'string' && Boolean(text.trim()) && contentLength(text) <= 5000;

export function createTranscript() { return { segments: {} }; }

export function mergeSegment(state, event) {
  if (!event || typeof event.segment_id !== 'string' || !event.segment_id ||
      !Number.isSafeInteger(event.order) || event.order < 0 ||
      !Number.isSafeInteger(event.revision) || event.revision < 0 ||
      typeof event.is_final !== 'boolean' || typeof event.text !== 'string') {
    throw new Error('The transcription service returned an invalid result.');
  }
  const previous = state.segments[event.segment_id];
  // Finalized text is immutable; repetitions of actual words in different segments are valid.
  if (previous?.is_final || (previous && event.revision <= previous.revision)) return state;
  const duplicateOrder = Object.values(state.segments).some(segment => segment.segment_id !== event.segment_id && segment.order === event.order);
  if (duplicateOrder) throw new Error('The transcription service returned conflicting segments.');
  return { segments: { ...state.segments, [event.segment_id]: { ...event } } };
}

export function transcriptText(state) {
  const ordered = Object.values(state.segments).sort((a, b) => a.order - b.order);
  const finals = ordered.filter(segment => segment.is_final);
  const lastFinalOrder = finals.at(-1)?.order ?? -1;
  const interim = ordered.filter(segment => !segment.is_final && segment.order > lastFinalOrder).at(-1);
  return {
    finalizedTranscript: finals.map(segment => segment.text.trim()).filter(Boolean).join(' '),
    interimTranscript: interim?.text || '',
    finalCount: finals.length,
  };
}
