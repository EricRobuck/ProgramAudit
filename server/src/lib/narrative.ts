import sanitizeHtml from 'sanitize-html';
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';

/**
 * Narrative content is stored as a strict HTML subset: paragraphs, line
 * breaks, bold, italic and (nested) lists. Everything else is stripped on the
 * server before storage, so stored content is always safe to render.
 */
const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li'];

export const MAX_NARRATIVE_LENGTH = 500_000;

export function sanitizeNarrative(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {},
    transformTags: { b: 'strong', i: 'em', div: 'p', h1: 'p', h2: 'p', h3: 'p', h4: 'p', h5: 'p', h6: 'p' },
    disallowedTagsMode: 'discard',
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
  });
  return clean.trim();
}

export type Run = { text: string; bold?: boolean; italic?: boolean; br?: boolean };
export type Block =
  | { type: 'p'; runs: Run[] }
  | { type: 'li'; ordered: boolean; level: number; num: number; runs: Run[] };

const INVISIBLE = /[\s ​-‍⁠﻿]/g;

function isElement(n: ChildNode): n is Element {
  return n.type === 'tag';
}

/** Convert sanitized narrative HTML into a flat list of paragraph and list-item blocks. */
export function parseNarrative(html: string): Block[] {
  const doc = parseDocument(html, { decodeEntities: true });
  const blocks: Block[] = [];

  const collectRuns = (nodes: ChildNode[], fmt: { bold: boolean; italic: boolean }, out: Run[]) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        const text = (n as unknown as { data: string }).data;
        if (text) out.push({ text, ...(fmt.bold && { bold: true }), ...(fmt.italic && { italic: true }) });
      } else if (isElement(n)) {
        const tag = n.name;
        if (tag === 'br') out.push({ text: '', br: true });
        else if (tag === 'strong') collectRuns(n.children, { ...fmt, bold: true }, out);
        else if (tag === 'em') collectRuns(n.children, { ...fmt, italic: true }, out);
        else if (tag === 'p') {
          if (out.length) out.push({ text: '', br: true });
          collectRuns(n.children, fmt, out);
        } else if (tag !== 'ul' && tag !== 'ol') collectRuns(n.children, fmt, out);
      }
    }
  };

  const walkList = (list: Element, level: number) => {
    const ordered = list.name === 'ol';
    let num = 0;
    for (const item of list.children) {
      if (!isElement(item) || item.name !== 'li') continue;
      num += 1;
      const runs: Run[] = [];
      collectRuns(item.children, { bold: false, italic: false }, runs);
      blocks.push({ type: 'li', ordered, level, num, runs: trimRuns(runs) });
      for (const child of item.children) {
        if (isElement(child) && (child.name === 'ul' || child.name === 'ol')) walkList(child, level + 1);
      }
    }
  };

  let loose: Run[] = [];
  const flushLoose = () => {
    const runs = trimRuns(loose);
    if (runs.length) blocks.push({ type: 'p', runs });
    loose = [];
  };

  for (const n of doc.children) {
    if (isElement(n) && n.name === 'p') {
      flushLoose();
      const runs: Run[] = [];
      collectRuns(n.children, { bold: false, italic: false }, runs);
      blocks.push({ type: 'p', runs: trimRuns(runs) });
    } else if (isElement(n) && (n.name === 'ul' || n.name === 'ol')) {
      flushLoose();
      walkList(n, 0);
    } else {
      collectRuns([n], { bold: false, italic: false }, loose);
    }
  }
  flushLoose();
  return blocks;
}

function trimRuns(runs: Run[]): Run[] {
  const out = [...runs];
  while (out.length && out[0].br) out.shift();
  while (out.length && out[out.length - 1].br) out.pop();
  return out;
}

export function blockText(b: Block): string {
  return b.runs.map((r) => (r.br ? '\n' : r.text)).join('');
}

/** Plain text used for search indexing and word counts. Paragraph breaks are preserved. */
export function narrativePlainText(html: string): string {
  return parseNarrative(html)
    .map((b) => (b.type === 'li' ? `${'  '.repeat(b.level)}${b.ordered ? `${b.num}.` : '-'} ${blockText(b)}` : blockText(b)))
    .join('\n\n')
    .trim();
}

/** True only when the narrative contains visible, non-whitespace text. */
export function hasSubstantiveText(html: string): boolean {
  return parseNarrative(html).some((b) => blockText(b).replace(INVISIBLE, '').length > 0);
}

export function wordCount(html: string): number {
  return parseNarrative(html).reduce((sum, b) => {
    const words = blockText(b).replace(/[​-‍⁠﻿]/g, '').match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu);
    return sum + (words?.length ?? 0);
  }, 0);
}
