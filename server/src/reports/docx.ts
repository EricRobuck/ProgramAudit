import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
  type ILevelsOptions,
} from 'docx';
import type { Block, Run } from '../lib/narrative.js';
import { completenessStatement, modeLabel, nodeStatusLabel, type ReportContent, type ReportNode } from './build.js';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function runs(rs: Run[]): TextRun[] {
  return rs.map((r) => (r.br ? new TextRun({ text: '', break: 1 }) : new TextRun({ text: r.text, bold: r.bold, italics: r.italic })));
}

function listLevels(ordered: boolean): ILevelsOptions[] {
  const bullets = ['•', '–', '·'];
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: ordered ? [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3] : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : bullets[level % 3],
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
}

function blocksToParagraphs(blocks: Block[], indent: number, nextInstance: () => number): Paragraph[] {
  const out: Paragraph[] = [];
  let instance = 0;
  let prev: Block | undefined;
  for (const b of blocks) {
    if (b.type === 'p') {
      out.push(new Paragraph({ children: runs(b.runs), spacing: { after: 160 }, indent: { left: indent } }));
    } else {
      if (!prev || prev.type !== 'li' || (b.level === 0 && b.num === 1)) instance = nextInstance();
      out.push(
        new Paragraph({
          children: runs(b.runs),
          numbering: { reference: b.ordered ? 'pa-ordered' : 'pa-bullet', level: Math.min(b.level, 8), instance },
          spacing: { after: 80 },
        }),
      );
    }
    prev = b;
  }
  return out;
}

function nodeParagraphs(c: ReportContent, n: ReportNode, nextInstance: () => number): Paragraph[] {
  const level = Math.min(n.depth, HEADINGS.length - 1);
  const extraIndent = Math.max(0, n.depth - (HEADINGS.length - 1)) * 360;
  const out: Paragraph[] = [
    new Paragraph({
      heading: HEADINGS[level],
      children: [new TextRun(`${n.outline}  ${n.title}`)],
      indent: { left: extraIndent },
      keepNext: true,
    }),
  ];
  const meta: string[] = [];
  if (c.mode === 'working') meta.push(`Assigned: ${n.assignee ?? 'Unassigned'}`, `Status: ${nodeStatusLabel(n)}`);
  else if (c.options.attribution && n.kind === 'narrative') meta.push(`Contributor: ${n.assignee ?? 'Unassigned'}`);
  if (meta.length) {
    out.push(new Paragraph({ children: [new TextRun({ text: meta.join('   ·   '), italics: true, size: 18, color: '555555' })], spacing: { after: 120 }, keepNext: true }));
  }
  if (n.kind === 'draft') {
    out.push(new Paragraph({ children: [new TextRun({ text: 'DRAFT — not yet marked complete', bold: true, color: '8A4B00', size: 18 })], spacing: { after: 120 } }));
  }
  if (n.kind === 'missing') {
    out.push(new Paragraph({ children: [new TextRun({ text: 'No response yet.', italics: true, color: '8A4B00' })], spacing: { after: 200 } }));
  }
  if (n.kind === 'narrative' || n.kind === 'draft') out.push(...blocksToParagraphs(n.blocks, extraIndent, nextInstance));
  return out;
}

export async function renderDocx(c: ReportContent): Promise<Buffer> {
  let instanceCounter = 0;
  const nextInstance = () => ++instanceCounter;
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(c.title)] }),
    new Paragraph({ children: [new TextRun({ text: `${c.curriculum} — ${c.major}`, size: 28 })], spacing: { after: 120 } }),
  ];
  const facts: [string, string][] = [
    ['Review period', c.period || '—'],
    ['Report type', modeLabel(c.mode)],
    ['Generated', `${c.generatedAtLabel} by ${c.generatedBy}`],
    ['Progress', `${c.progress.completed} of ${c.progress.total} active tasks complete`],
  ];
  for (const [k, v] of facts) {
    children.push(new Paragraph({ children: [new TextRun({ text: `${k}: `, bold: true }), new TextRun(v)], spacing: { after: 60 } }));
  }
  children.push(
    new Paragraph({
      children: [new TextRun({ text: completenessStatement(c), bold: !c.allComplete, color: c.allComplete ? '1B5E20' : '8A4B00' })],
      spacing: { before: 120, after: 200 },
    }),
  );
  if (c.unresolved.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Unresolved work')] }));
    const statusName = { not_started: 'Not started', in_progress: 'In progress', complete: 'Complete' } as const;
    for (const u of c.unresolved) {
      children.push(
        new Paragraph({
          numbering: { reference: 'pa-bullet', level: 0, instance: nextInstance() },
          children: [
            new TextRun({ text: `${u.section[0].toUpperCase()}${u.section.slice(1)} › ${u.path.join(' › ')}` }),
            new TextRun({ text: ` — ${statusName[u.status]}, ${u.assignee ?? 'Unassigned'}`, italics: true }),
          ],
        }),
      );
    }
  }
  for (const s of c.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(s.label)], pageBreakBefore: true }));
    if (!s.nodes.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: 'No content.', italics: true, color: '555555' })] }));
    }
    for (const n of s.nodes) children.push(...nodeParagraphs(c, n, nextInstance));
  }

  const doc = new Document({
    creator: 'ProgramAudit',
    title: `${c.major} — ${c.title}`,
    description: modeLabel(c.mode),
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
    },
    numbering: {
      config: [
        { reference: 'pa-bullet', levels: listLevels(false) },
        { reference: 'pa-ordered', levels: listLevels(true) },
      ],
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${c.major} — ${c.title}   ·   Page `, size: 18, color: '555555' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '555555' }),
                  new TextRun({ text: ' of ', size: 18, color: '555555' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '555555' }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
