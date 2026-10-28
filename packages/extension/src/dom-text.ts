/**
 * Reads a message box as plain text and maps text offsets back to DOM positions,
 * so Veil can replace just the sensitive values in place. Replacing only those values,
 * instead of rewriting the whole box, keeps line breaks and formatting intact and works
 * with editors (ProseMirror, Quill, Lexical) that undo direct DOM changes.
 */

const BLOCKS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR',
]);

interface Segment {
  node: Text;
  start: number;
}

export interface Linear {
  text: string;
  segments: Segment[];
}

export function isTextField(el: Element): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

export function linearize(root: HTMLElement): Linear {
  let text = '';
  const segments: Segment[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      segments.push({ node: t, start: text.length });
      text += t.data;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === 'BR') {
      // ProseMirror and others keep a trailing <br> in empty or last lines; it is not a line break.
      if (!node.classList.contains('ProseMirror-trailingBreak') && node.nextSibling) text += '\n';
      return;
    }
    const block = BLOCKS.has(node.tagName);
    if (block && text.length > 0 && !text.endsWith('\n')) text += '\n';
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block && text.length > 0 && !text.endsWith('\n')) text += '\n';
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return { text, segments };
}

/** Text of a message box, as Veil scans it. */
export function readText(composer: HTMLElement): string {
  return isTextField(composer) ? composer.value : linearize(composer).text;
}

function pointAt(lin: Linear, offset: number, isEnd: boolean): { node: Text; offset: number } | null {
  for (const s of lin.segments) {
    const len = s.node.data.length;
    const inside = isEnd ? offset > s.start && offset <= s.start + len : offset >= s.start && offset < s.start + len;
    if (inside) return { node: s.node, offset: offset - s.start };
  }
  return null;
}

/** DOM range covering text offsets [start, end) of a linearized box. */
export function rangeFor(lin: Linear, start: number, end: number): Range | null {
  const a = pointAt(lin, start, false);
  const b = pointAt(lin, end, true);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}
