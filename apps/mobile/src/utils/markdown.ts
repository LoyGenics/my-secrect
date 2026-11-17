/**
 * Tiny Markdown parser for secure notes (React Native).
 * No HTML, no WebView: source text is parsed into plain blocks that
 * MarkdownText.tsx renders with styled <Text>. Links are NOT tappable
 * (no URL opening from a note) — they render as plain text.
 *
 * Supported: # / ## / ### headings, **bold**, *italic*, `code`,
 * ``` fenced code blocks, - / * unordered lists, 1. ordered lists.
 */

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type MarkdownBlock =
  | { kind: 'h1' | 'h2' | 'h3'; segments: InlineSegment[] }
  | { kind: 'p'; segments: InlineSegment[] }
  | { kind: 'li'; ordered: boolean; index: number; segments: InlineSegment[] }
  | { kind: 'code'; text: string };

function parseInline(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let rest = line;
  const push = (text: string, flags?: Partial<InlineSegment>) => {
    if (text) segments.push({ text, ...flags });
  };
  while (rest.length > 0) {
    // Links: render the link TEXT only, no tappable URL.
    const link = /^\[([^\]]+)\]\([^)]+\)/.exec(rest);
    if (link) { push(link[1]); rest = rest.slice(link[0].length); continue; }
    const code = /^`([^`]+)`/.exec(rest);
    if (code) { push(code[1], { code: true }); rest = rest.slice(code[0].length); continue; }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold) { push(bold[1], { bold: true }); rest = rest.slice(bold[0].length); continue; }
    const italic = /^\*([^\s*][^*]*?)\*/.exec(rest);
    if (italic) { push(italic[1], { italic: true }); rest = rest.slice(italic[0].length); continue; }
    // Plain run up to the next markup opener.
    const next = rest.search(/\[[^\]]+\]\([^)]+\)|`|\*\*|\*/);
    if (next === -1) { push(rest); break; }
    if (next === 0) { push(rest[0]); rest = rest.slice(1); continue; }
    push(rest.slice(0, next));
    rest = rest.slice(next);
  }
  return segments.length > 0 ? segments : [{ text: '' }];
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let paraBuf: string[] = [];
  let olIndex = 0;
  const flushPara = () => {
    if (paraBuf.length > 0) {
      blocks.push({ kind: 'p', segments: parseInline(paraBuf.join(' ')) });
      paraBuf = [];
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.push({ kind: 'code', text: codeBuf.join('\n') });
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: heading[1].length === 1 ? 'h1' : heading[1].length === 2 ? 'h2' : 'h3', segments: parseInline(heading[2].trim()) });
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      blocks.push({ kind: 'li', ordered: false, index: 0, segments: parseInline(ul[1]) });
      continue;
    }
    const ol = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      olIndex += 1;
      blocks.push({ kind: 'li', ordered: true, index: olIndex, segments: parseInline(ol[2]) });
      continue;
    }
    if (line.trim() === '') { flushPara(); olIndex = 0; continue; }
    paraBuf.push(line.trim());
  }
  if (inCode) blocks.push({ kind: 'code', text: codeBuf.join('\n') });
  flushPara();
  return blocks;
}
