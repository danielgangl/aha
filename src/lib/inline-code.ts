// Split a plain-prose string into text / inline-code segments.
//
// The review-judgment fragment fields are plain text, but agents sometimes mark
// a code identifier inline — either as `<code>getMessage</code>` (HTML that
// leaked in from the file-note prompt) or as a `backtick` span. We render both
// as real inline <code> and leave everything else as plain, escaped text. The
// parser returns data (not JSX) so it stays pure and testable; the component
// that maps it to elements lives in components/rich.tsx.

export interface InlineSeg {
  code: boolean;
  text: string;
}

// `<code>…</code>` (non-greedy) or a single-line `backtick` span.
const INLINE_CODE = /<code>([\s\S]*?)<\/code>|`([^`\n]+)`/g;

export function splitInlineCode(text: string): InlineSeg[] {
  const segs: InlineSeg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_CODE.lastIndex = 0;
  while ((m = INLINE_CODE.exec(text)) !== null) {
    if (m.index > last) segs.push({ code: false, text: text.slice(last, m.index) });
    segs.push({ code: true, text: m[1] ?? m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ code: false, text: text.slice(last) });
  return segs;
}
