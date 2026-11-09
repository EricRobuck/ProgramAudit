import { createRequire } from 'node:module';
import path from 'node:path';
import type { Block, Run } from '../lib/narrative.js';
import { completenessStatement, modeLabel, nodeStatusLabel, type ReportContent, type ReportNode } from './build.js';

const require = createRequire(import.meta.url);
// pdfmake's server build is CommonJS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfmake: any = require('pdfmake');
const fontDir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'build', 'fonts', 'Roboto');

pdfmake.setFonts({
  Roboto: {
    normal: path.join(fontDir, 'Roboto-Regular.ttf'),
    bold: path.join(fontDir, 'Roboto-Medium.ttf'),
    italics: path.join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: path.join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});
// Only the bundled font files may be read from disk; document content never references files.
pdfmake.setLocalAccessPolicy((p: string) => path.resolve(p).startsWith(fontDir));
pdfmake.setUrlAccessPolicy?.(() => false);

const HEADING_SIZES = [16, 14, 13, 12, 11.5, 11];

function runs(rs: Run[]) {
  return rs.map((r) => (r.br ? { text: '\n' } : { text: r.text, bold: !!r.bold, italics: !!r.italic }));
}

function blocks(bs: Block[], indent: number) {
  return bs.map((b) => {
    if (b.type === 'p') return { text: runs(b.runs), margin: [indent, 0, 0, 8], lineHeight: 1.25 };
    const marker = b.ordered ? `${b.num}.` : ['•', '–', '·'][b.level % 3];
    return {
      columns: [
        { width: 18, text: marker, alignment: 'right' },
        { width: '*', text: runs(b.runs), lineHeight: 1.25 },
      ],
      columnGap: 6,
      margin: [indent + b.level * 18, 0, 0, 4],
    };
  });
}

function nodeContent(c: ReportContent, n: ReportNode) {
  const size = HEADING_SIZES[Math.min(n.depth, HEADING_SIZES.length - 1)];
  const indent = Math.min(n.depth - 1, 6) * 10;
  const out: unknown[] = [
    { text: `${n.outline}  ${n.title}`, style: 'nodeHeading', fontSize: size, margin: [indent, 10, 0, 4], headlineLevel: n.depth + 1 },
  ];
  const meta: string[] = [];
  if (c.mode === 'working') meta.push(`Assigned: ${n.assignee ?? 'Unassigned'}`, `Status: ${nodeStatusLabel(n)}`);
  else if (c.options.attribution && n.kind === 'narrative') meta.push(`Contributor: ${n.assignee ?? 'Unassigned'}`);
  if (meta.length) out.push({ text: meta.join('   ·   '), style: 'meta', margin: [indent, 0, 0, 6] });
  if (n.kind === 'draft') out.push({ text: 'DRAFT — not yet marked complete', style: 'warn', margin: [indent, 0, 0, 6] });
  if (n.kind === 'missing') out.push({ text: 'No response yet.', italics: true, color: '#8A4B00', margin: [indent, 0, 0, 8] });
  if (n.kind === 'narrative' || n.kind === 'draft') out.push(...blocks(n.blocks, indent));
  return out;
}

export async function renderPdf(c: ReportContent): Promise<Buffer> {
  const statusName = { not_started: 'Not started', in_progress: 'In progress', complete: 'Complete' } as const;
  const content: unknown[] = [
    { text: c.title, style: 'title' },
    { text: `${c.curriculum} — ${c.major}`, style: 'subtitle' },
    {
      table: {
        widths: [100, '*'],
        body: [
          ['Review period', c.period || '—'],
          ['Report type', modeLabel(c.mode)],
          ['Generated', `${c.generatedAtLabel} by ${c.generatedBy}`],
          ['Progress', `${c.progress.completed} of ${c.progress.total} active tasks complete`],
        ].map(([k, v]) => [{ text: k, bold: true }, v]),
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 10],
    },
    { text: completenessStatement(c), bold: !c.allComplete, color: c.allComplete ? '#1B5E20' : '#8A4B00', margin: [0, 0, 0, 12] },
  ];
  if (c.unresolved.length) {
    content.push({ text: 'Unresolved work', style: 'h2', headlineLevel: 2 });
    content.push({
      ul: c.unresolved.map((u) => ({
        text: [
          `${u.section[0].toUpperCase()}${u.section.slice(1)} › ${u.path.join(' › ')}`,
          { text: ` — ${statusName[u.status]}, ${u.assignee ?? 'Unassigned'}`, italics: true },
        ],
      })),
      margin: [0, 0, 0, 8],
    });
  }
  for (const s of c.sections) {
    content.push({ text: s.label, style: 'h1', pageBreak: 'before', headlineLevel: 1 });
    if (!s.nodes.length) content.push({ text: 'No content.', italics: true, color: '#555555' });
    for (const n of s.nodes) content.push(...nodeContent(c, n));
  }

  const doc = {
    info: { title: `${c.major} — ${c.title}`, creator: 'ProgramAudit', subject: modeLabel(c.mode) },
    pageSize: 'LETTER',
    pageMargins: [60, 60, 60, 60],
    defaultStyle: { font: 'Roboto', fontSize: 10.5 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 4] },
      subtitle: { fontSize: 13, color: '#333333', margin: [0, 0, 0, 14] },
      h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
      h2: { fontSize: 13, bold: true, margin: [0, 6, 0, 6] },
      nodeHeading: { bold: true },
      meta: { fontSize: 9, italics: true, color: '#555555' },
      warn: { fontSize: 9, bold: true, color: '#8A4B00' },
    },
    content,
    footer: (currentPage: number, pageCount: number) => ({
      text: `${c.major} — ${c.title}   ·   Page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      fontSize: 8.5,
      color: '#555555',
      margin: [0, 20, 0, 0],
    }),
    // Keep headings with the text that follows them.
    pageBreakBefore: (
      node: { headlineLevel?: number; pageBreak?: string },
      queries: { getFollowingNodesOnPage: () => unknown[] },
    ) => !!node.headlineLevel && node.pageBreak !== 'before' && queries.getFollowingNodesOnPage().length === 0,
  };
  const pdf = pdfmake.createPdf(doc);
  return pdf.getBuffer();
}
