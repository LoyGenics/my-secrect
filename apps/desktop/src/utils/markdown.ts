/**
 * Tiny Markdown renderer for secure notes — no dependency, no raw HTML.
 *
 * Safety: ALL user text is HTML-escaped FIRST; only the markup this
 * file generates (<strong>, <em>, <code>, <a>, headings, lists) is ever
 * emitted. Links are limited to http(s) — anything else renders as plain
 * text. The result is rendered with dangerouslySetInnerHTML by callers,
 * which is safe only because of the escaping done here.
 *
 * Supported: # / ## / ### headings, **bold**, *italic*, `code`,
 * ``` fenced code blocks, - / * unordered lists, 1. ordered lists,
 * [text](https://…) links, paragraphs, line breaks.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(escaped: string): string {
  let out = escaped;
  // Links first: [text](http(s)://…) — anything else stays literal text.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^\s*][^*]*?)\*/g, '$1<em>$2</em>');
  return out;
}

export function renderMarkdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let paraBuf: string[] = [];

  const closeList = () => {
    if (listTag) { html.push(`</${listTag}>`); listTag = null; }
  };
  const flushPara = () => {
    if (paraBuf.length > 0) {
      html.push(`<p>${paraBuf.map(renderInline).join('<br />')}</p>`);
      paraBuf = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (listTag !== tag) { closeList(); html.push(`<${tag}>`); listTag = tag; }
      html.push(`<li>${renderInline(escapeHtml((ul ?? ol)![1]))}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      closeList();
      continue;
    }
    closeList();
    paraBuf.push(escapeHtml(line));
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  flushPara();
  closeList();
  return html.join('\n');
}
