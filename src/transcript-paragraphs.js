const MAX_PAUSE_SECONDS = 2.5;
const MAX_PARAGRAPH_SECONDS = 40;
const MAX_PARAGRAPH_CHARACTERS = 480;
const PREFERRED_PARAGRAPH_SECONDS = 24;
const PREFERRED_PARAGRAPH_CHARACTERS = 280;
const SENTENCE_END = /[.!?。！？…][”’」』)\]]*$/u;
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：）】》」』]$/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（【《「『]/u;
const OPENING_PUNCTUATION = /[(\[{“‘（【《「『]$/u;
const CLOSING_PUNCTUATION = /^[,.;:!?%…)\]}”’，。！？、；：）】》」』]/u;
const UNKNOWN_SPEAKER = /^(?:unassigned|unknown(?:[ -]speaker)?)$/iu;

export function transcriptSegmentSeparator(leftText, rightText) {
  const left = leftText.trimEnd();
  const right = rightText.trimStart();
  if (!left || !right || OPENING_PUNCTUATION.test(left) || CLOSING_PUNCTUATION.test(right)) return '';
  return CJK_END.test(left) && CJK_START.test(right) ? '' : ' ';
}

function hasTiming({ start, end }) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start;
}

function canJoin(paragraph, segment, joinedText) {
  const previous = paragraph.segments.at(-1);
  if (segment.speakerId !== paragraph.speakerId || UNKNOWN_SPEAKER.test(paragraph.speakerId) ||
      !hasTiming(previous) || !hasTiming(segment) || segment.start < previous.start ||
      segment.start - paragraph.end > MAX_PAUSE_SECONDS) return false;

  const duration = Math.max(paragraph.end, segment.end) - paragraph.start;
  if (duration > MAX_PARAGRAPH_SECONDS || joinedText.length > MAX_PARAGRAPH_CHARACTERS) return false;

  // Prefer to break at a sentence boundary once the paragraph is long enough.
  const reachedPreferredSize = paragraph.end - paragraph.start >= PREFERRED_PARAGRAPH_SECONDS ||
    paragraph.text.length >= PREFERRED_PARAGRAPH_CHARACTERS;
  return !(reachedPreferredSize && SENTENCE_END.test(paragraph.text));
}

/** Group adjacent turns for reading without changing source text, timing, or segment identity. */
export function groupTranscriptParagraphs(segments) {
  const paragraphs = [];
  for (const [index, segment] of segments.entries()) {
    const text = String(segment.text ?? '').trim();
    const paragraph = paragraphs.at(-1);
    if (paragraph?.text && text) {
      const joinedText = paragraph.text + transcriptSegmentSeparator(paragraph.text, text) + text;
      if (canJoin(paragraph, segment, joinedText)) {
        paragraph.text = joinedText;
        paragraph.end = Math.max(paragraph.end, segment.end);
        paragraph.segments.push(segment);
        continue;
      }
    }
    paragraphs.push({
      id: segment.id ?? `transcript-paragraph-${index}`,
      start: segment.start,
      end: segment.end,
      speakerId: segment.speakerId || 'unassigned',
      text,
      segments: [segment],
    });
  }
  return paragraphs;
}
