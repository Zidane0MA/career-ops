#!/usr/bin/env node
/**
 * fix-pipeline.mjs
 * Repairs applications.md and pipeline.md using reports as source of truth.
 * Implements strategies A–F from modes/integrity.md.
 *
 * Usage:
 *   node fix-pipeline.mjs          → dry-run (shows changes, writes nothing)
 *   node fix-pipeline.mjs --apply  → applies changes (creates backup first)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT     = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const RPT_DIR  = join(ROOT, 'reports');
const PIPELINE = join(DATA_DIR, 'pipeline.md');
const APPS     = join(DATA_DIR, 'applications.md');
const APPLY    = process.argv.includes('--apply');

const R = '\x1b[31m', Y = '\x1b[33m', G = '\x1b[32m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';
const hdr = t => console.log(`\n${B}${C}${'─'.repeat(68)}\n  ${t}\n${'─'.repeat(68)}${X}`);
const ok  = m => console.log(`  ${G}✓${X} ${m}`);
const chg = m => console.log(`  ${Y}→${X} ${m}`);
const err = m => console.log(`  ${R}✗${X} ${m}`);

// ── Parse all reports → Map<id, ReportData> ───────────────────────────────────
// Supports all title formats documented in modes/integrity.md §Strategy B.
function parseReports() {
  const map = new Map();
  if (!existsSync(RPT_DIR)) return map;
  const files = readdirSync(RPT_DIR).filter(f => /^\d{3,}-/.test(f) && f.endsWith('.md'));

  for (const file of files) {
    const id    = parseInt(file.split('-')[0], 10);
    const raw   = readFileSync(join(RPT_DIR, file), 'utf8');
    const lines = raw.split('\n');

    const titleLine = lines.find(l => /^#\s/.test(l)) || '';
    let company = '', role = '';

    // Format 1: "# Evaluaci[oó]n: Company — Role" / "# Evaluation: Company — Role"
    const evalColonMatch = titleLine.match(/^#\s+Evaluaci[oó]n:\s+(.+?)\s+[—–]\s+(.+)$/i)
                        || titleLine.match(/^#\s+Evaluation:\s+(.+?)\s+[—–]\s+(.+)$/i);
    // Format 2: "# Evaluación — Role · Company" (no colon, middle-dot)
    const evalNocolonMatch = titleLine.match(/^#\s+Evaluaci[oó]n\s+[—–]\s+(.+?)\s+[·•]\s+(.+)$/i);

    if (evalColonMatch) {
      company = evalColonMatch[1].trim();
      role    = evalColonMatch[2].trim();
    } else if (evalNocolonMatch) {
      role    = evalNocolonMatch[1].trim();
      company = evalNocolonMatch[2].trim();
    } else {
      // Formats 3+4: strip leading "# NNN — " prefix then apply heuristics
      const stripped = titleLine.replace(/^#\s+#?\d+\s*[—–|·]\s*/, '').replace(/^#\s+/, '');

      if (stripped.includes('·') || stripped.includes('•')) {
        const parts = stripped.split(/\s+[·•]\s+/);
        role    = parts[0].trim();
        company = parts.slice(1).join(' · ').trim();
      } else {
        // Split on last em-dash (handles dashes inside role names)
        const lastDash = Math.max(stripped.lastIndexOf(' — '), stripped.lastIndexOf(' – '));
        if (lastDash > 0) {
          const left  = stripped.substring(0, lastDash).trim();
          const right = stripped.substring(lastDash + 3).trim();
          const rolePrefixLeft = /^(Técnico|Administrador|Ingeniero|Operador|Developer|Support|IT |Cloud|DevOps|Help Desk|Systems|Backend|Helpdesk|Hardware|SysOps|Software)/i;
          if (rolePrefixLeft.test(left)) {
            role = left; company = right;
          } else {
            company = left; role = right;
          }
        } else if (stripped.includes('|')) {
          const parts = stripped.split('|').map(s => s.trim());
          company = parts[0]; role = parts.slice(1).join(' | ').trim();
        } else {
          role = stripped;
          company = file.replace('.md', '').split('-').slice(1, 3).join(' ');
        }
      }
    }

    const get = key => {
      const line = lines.find(l => new RegExp(`\\*\\*${key}:\\*\\*`, 'i').test(l)) || '';
      return line.replace(new RegExp(`.*\\*\\*${key}:\\*\\*\\s*`, 'i'), '').trim();
    };

    const scoreRaw = get('Score');
    const score    = scoreRaw.match(/([\d.]+\/5)/)?.[1] ?? scoreRaw;
    const pdfRaw   = get('PDF');
    const pdf      = pdfRaw.startsWith('✅') || (!pdfRaw.startsWith('❌') && pdfRaw.includes('.pdf'));
    const date     = get('Fecha');

    const body    = raw.toLowerCase();
    const score_n = parseFloat(score);
    let status    = 'Evaluated';
    if ((body.includes('skip') || body.includes('no aplicar') || body.includes('suspicious') || body.includes('scam')) && score_n < 3.5) status = 'SKIP';
    if (score_n < 2.0) status = 'SKIP';

    const noteMatch = raw.match(/\*\*(APLICAR[^*\n]{0,120}|NO APLICAR[^*\n]{0,120}|SKIP[^*\n]{0,120}|BORDERLINE[^*\n]{0,120})\*\*/i);
    const note = noteMatch ? noteMatch[1].replace(/\s+/g, ' ').trim() : '';

    map.set(id, { id, file, company, role, score, pdf, date, status, note });
  }
  return map;
}

// ── Parse pipeline.md preserving line structure ───────────────────────────────
function parsePipelineLines(text) {
  return text.split('\n').map(raw => {
    const m = raw.match(/^(\s*-\s+\[.\]\s+#)(\d+)(\s+\|\s+)(.+?)(\s+\|\s+)(.+?)(\s+\|\s+)(.+?)(\s+\|\s+)([\d.]+\/5)(\s+\|\s+PDF\s+)([✅❌])(.*)/);
    if (!m) return { raw, entry: null };
    return {
      raw,
      entry: {
        prefix: m[1], id: parseInt(m[2], 10), sep1: m[3], url: m[4],
        sep2: m[5], company: m[6], sep3: m[7], role: m[8],
        sep4: m[9], score: m[10], sep5: m[11], pdf: m[12] === '✅', suffix: m[13],
      },
    };
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
console.log(`\n${B}fix-pipeline.mjs${X}  ${APPLY ? `${Y}[APPLY MODE]${X}` : `${C}[DRY RUN — usa --apply para escribir]${X}`}`);

const reports = parseReports();
console.log(`Reportes cargados: ${reports.size}`);

// ── Strategy C: normalize scores in pipeline.md ───────────────────────────────
hdr('pipeline.md — Strategy C: normalizar scores');

const pipelineLines = parsePipelineLines(readFileSync(PIPELINE, 'utf8'));
let pipelineChanges = 0;

const newPipelineLines = pipelineLines.map(({ raw, entry }) => {
  if (!entry) return raw;
  const rpt = reports.get(entry.id);
  if (!rpt || parseFloat(entry.score) === parseFloat(rpt.score)) return raw;

  pipelineChanges++;
  chg(`#${entry.id} score: ${entry.score} → ${rpt.score}`);
  return `${entry.prefix}${entry.id}${entry.sep1}${entry.url}${entry.sep2}${entry.company}${entry.sep3}${entry.role}${entry.sep4}${rpt.score}${entry.sep5}PDF ${entry.pdf ? '✅' : '❌'}${entry.suffix}`;
});

if (pipelineChanges === 0) ok('Sin cambios necesarios en pipeline.md');

// ── Strategies A, B, C, F: fix applications.md ───────────────────────────────
hdr('applications.md — Strategies A B C F');

let appsChanges = 0;
let corruptRemoved = 0;

const newAppsLines = readFileSync(APPS, 'utf8').split('\n').flatMap((raw, i) => {
  const trimmed = raw.trim();

  // Strategy F: remove corrupt fragment lines (e.g. bare "304 |")
  if (/^\d+\s*\|/.test(trimmed) && !/^\|\s*\d+\s*\|/.test(trimmed)) {
    corruptRemoved++;
    err(`Línea ${i + 1} corrupta eliminada: "${trimmed}"`);
    return [];
  }

  if (!trimmed.startsWith('|')) return [raw];
  if (/^\|\s*[-#]\s*\|/.test(trimmed)) return [raw];

  const idMatch = raw.match(/^\|\s*(\d+)\s*\|/);
  if (!idMatch) return [raw];

  const id   = parseInt(idMatch[1], 10);
  const cols = raw.split('|').map(c => c.trim());
  if (cols.length < 9) return [raw];

  // cols: ['', id, date, company, role, score, status, pdf, report, notes, '']
  const company   = cols[3] || '';
  const role      = cols[4] || '';
  const score     = cols[5] || '';
  const status    = cols[6] || '';
  const pdfFlag   = cols[7] || '';
  const reportCol = cols[8] || '';
  const notes     = cols[9] || '';

  const refMatch  = reportCol.match(/\[(\d+)\]\(([^)]+)\)/);
  const reportRef = refMatch ? parseInt(refMatch[1], 10) : null;

  const rpt = reports.get(id);
  if (!rpt) return [raw];

  const rptLink = `[${id}](../reports/${rpt.file})`;
  const rowChanges = [];

  let newCompany   = company;
  let newRole      = role;
  let newScore     = score;
  let newStatus    = status;
  let newPdf       = pdfFlag;
  let newReportCol = reportCol;
  let newNotes     = notes;

  // Strategy A: data-shift — full rebuild from report data
  if (reportRef !== null && reportRef !== id) {
    rowChanges.push(`[A] data-shift: era reporte #${reportRef} → #${id}`);
    newCompany   = rpt.company;
    newRole      = rpt.role;
    newScore     = rpt.score;
    newStatus    = rpt.status;
    newPdf       = rpt.pdf ? '✅' : '❌';
    newReportCol = rptLink;
    if (!notes.trim()) newNotes = rpt.note;
  } else {
    // Strategy B: fill empty fields from report
    if (!company.trim() && rpt.company) { newCompany = rpt.company; rowChanges.push('[B] company filled'); }
    if (!role.trim()    && rpt.role)    { newRole    = rpt.role;    rowChanges.push('[B] role filled'); }
    if (!notes.trim()   && rpt.note)    { newNotes   = rpt.note;    rowChanges.push('[B] notes filled'); }

    // Missing report link
    if (reportRef === null) {
      newReportCol = rptLink;
      rowChanges.push('[B] report link added');
    }

    // Strategy C: score normalization
    if (parseFloat(score) !== parseFloat(rpt.score)) {
      newScore = rpt.score;
      rowChanges.push(`[C] score: ${score} → ${rpt.score}`);
    }
  }

  if (rowChanges.length === 0) return [raw];

  appsChanges++;
  chg(`#${id} (línea ${i + 1}): ${rowChanges.join(', ')}`);
  const date = rpt.date || cols[2];
  return [`| ${id} | ${date} | ${newCompany} | ${newRole} | ${newScore} | ${newStatus} | ${newPdf} | ${newReportCol} | ${newNotes} |`];
});

if (appsChanges === 0 && corruptRemoved === 0) ok('Sin cambios necesarios en applications.md');

// ── Summary ───────────────────────────────────────────────────────────────────
hdr('RESUMEN');
console.log(`  pipeline.md:     ${pipelineChanges} líneas corregidas`);
console.log(`  applications.md: ${appsChanges} filas corregidas, ${corruptRemoved} líneas corruptas eliminadas`);

if (!APPLY) {
  console.log(`\n${Y}  Dry-run. Usa --apply para aplicar.${X}\n`);
  process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
copyFileSync(PIPELINE, join(DATA_DIR, `pipeline.backup-${ts}.md`));
copyFileSync(APPS,     join(DATA_DIR, `applications.backup-${ts}.md`));
console.log(`\n  ${G}Backups creados: *-backup-${ts}.md${X}`);

writeFileSync(PIPELINE, newPipelineLines.join('\n'), 'utf8');
writeFileSync(APPS, newAppsLines.join('\n'), 'utf8');
console.log(`  ${G}${B}✓ pipeline.md actualizado${X}`);
console.log(`  ${G}${B}✓ applications.md actualizado${X}\n`);
