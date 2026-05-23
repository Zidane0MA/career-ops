#!/usr/bin/env node
/**
 * audit-pipeline.mjs
 * Encuentra inconsistencias entre pipeline.md, applications.md y los reportes.
 *
 * Checks (aligned with modes/integrity.md Phase 1 table):
 *  1. Corrupt lines       — ERROR  malformed rows in applications.md (e.g. bare "304 |")
 *  2. Duplicate IDs       — ERROR  same #NNN appears twice in pipeline or applications
 *  3. Pipeline → Apps gap — ERROR  #NNN processed in pipeline but missing from applications
 *  4. Apps → Pipeline gap — WARN   entry in applications without pipeline entry
 *  5. Cross-ref mismatch  — ERROR  applications row #NNN links to report #MMM where N≠M
 *  6. Missing report file — ERROR  report referenced in applications but file missing from reports/
 *  7. Orphan reports      — WARN   report file on disk not referenced by any applications row
 *  8. Missing JD file     — ERROR  pipeline local:jds/xxx.md points to nonexistent file
 *  9. Remote URL info     — INFO   how many remote URLs have local JD copies
 * 10. Score mismatch      — WARN   score differs between pipeline and applications for same ID
 * 11. PDF flag mismatch   — WARN   PDF ✅/❌ differs between pipeline and applications
 * 12. Duplicate reports   — WARN   multiple reports share the same URL
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PIPELINE_FILE = join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_FILE = join(ROOT, 'data', 'applications.md');
const REPORTS_DIR = join(ROOT, 'reports');
const JDS_DIR = join(ROOT, 'jds');

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const R = '\x1b[31m'; // red
const Y = '\x1b[33m'; // yellow
const G = '\x1b[32m'; // green
const C = '\x1b[36m'; // cyan
const B = '\x1b[1m';  // bold
const X = '\x1b[0m';  // reset

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sectionHeader(title) {
  const line = '─'.repeat(70);
  console.log(`\n${B}${C}${line}${X}`);
  console.log(`${B}${C}  ${title}${X}`);
  console.log(`${B}${C}${line}${X}`);
}

function ok(msg)   { console.log(`  ${G}✓${X} ${msg}`); }
function warn(msg) { console.log(`  ${Y}⚠${X}  ${msg}`); }
function err(msg)  { console.log(`  ${R}✗${X} ${msg}`); }
function info(msg) { console.log(`  ${C}ℹ${X}  ${msg}`); }

// ─── Parse pipeline.md ────────────────────────────────────────────────────────
/**
 * Returns Map<id(number), { id, url, company, role, score, pdf, lineNum }>
 */
function parsePipeline(text) {
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  // Pattern: - [x] #NNN | url | Company | Role | score | PDF ✅/❌
  const re = /^\s*-\s+\[.\]\s+#(\d+)\s+\|\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(.+?)\s+\|\s+([\d.]+\/5)\s+\|\s+PDF\s+([✅❌])/;
  lines.forEach((line, i) => {
    const m = line.match(re);
    if (!m) return;
    const id = parseInt(m[1], 10);
    const entry = {
      id,
      url: m[2].trim(),
      company: m[3].trim(),
      role: m[4].trim(),
      score: m[5].trim(),
      pdf: m[6].trim() === '✅',
      lineNum: i + 1,
    };
    if (entries.has(id)) {
      const existing = entries.get(id);
      entry.__duplicates = (existing.__duplicates || 0) + 1;
    }
    entries.set(id, entry);
  });
  return entries;
}

// ─── Parse applications.md ────────────────────────────────────────────────────
/**
 * Returns Map<id(number), { id, date, company, role, score, status, pdf, reportRef, reportPath, notes, lineNum }>
 * Also returns corruptLines: [{lineNum, content}]
 */
function parseApplications(text) {
  const entries = new Map();
  const corruptLines = [];
  const lines = text.split(/\r?\n/);

  // Table row pattern: | NNN | date | ... | [NNN](path) | notes |
  // We need at least 8 pipe-separated columns
  const tableRowRe = /^\|\s*(\d+)\s*\|/;
  const headerOrSepRe = /^\|\s*[-#]\s*\|/;

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return;
    if (headerOrSepRe.test(trimmed)) return;

    // Detect corrupt lines: lines like "304 |" that are leftover fragments
    if (/^\d+\s*\|/.test(trimmed) && !tableRowRe.test(line)) {
      corruptLines.push({ lineNum: i + 1, content: trimmed });
      return;
    }

    const m = line.match(tableRowRe);
    if (!m) return;

    const cols = line.split('|').map(c => c.trim()).filter((_, idx) => idx > 0);
    // cols: [id, date, company, role, score, status, pdf, report, notes]
    if (cols.length < 8) {
      corruptLines.push({ lineNum: i + 1, content: trimmed });
      return;
    }

    const id = parseInt(cols[0], 10);
    const reportCol = cols[7] || '';

    // Extract report link: [NNN](path)
    const reportMatch = reportCol.match(/\[(\d+)\]\(([^)]+)\)/);
    let reportRef = null;
    let reportPath = null;
    if (reportMatch) {
      reportRef = parseInt(reportMatch[1], 10);
      // Path is relative to data/ dir: ../reports/xxx.md
      reportPath = reportMatch[2].replace(/^\.\.\//, '').trim();
    }

    const pdfCol = cols[6] || '';
    const entry = {
      id,
      date: cols[1],
      company: cols[2],
      role: cols[3],
      score: cols[4],
      status: cols[5],
      pdf: pdfCol.includes('✅'),
      reportRef,
      reportPath,
      notes: cols[8] || '',
      lineNum: i + 1,
    };

    if (entries.has(id)) {
      const existing = entries.get(id);
      entry.__duplicates = existing.__duplicates || [];
      entry.__duplicates.push(existing.lineNum);
    }
    entries.set(id, entry);
  });

  return { entries, corruptLines };
}

// ─── Load JD files and their URLs ─────────────────────────────────────────────
/**
 * Returns Map<url, jdFilename>
 */
function loadJdUrls() {
  const map = new Map();
  if (!existsSync(JDS_DIR)) return map;
  const files = readdirSync(JDS_DIR).filter(f => f.endsWith('.md') && f !== '.gitkeep');
  for (const f of files) {
    const content = readFileSync(join(JDS_DIR, f), 'utf8');
    // Look for **Apply:** https://...  or similar
    const applyMatch = content.match(/\*\*Apply:\*\*\s*(https?:\/\/\S+)/i);
    if (applyMatch) {
      map.set(applyMatch[1].trim(), f);
    }
  }
  return map;
}

// ─── Load existing report files ───────────────────────────────────────────────
function loadReportFiles() {
  if (!existsSync(REPORTS_DIR)) return new Set();
  return new Set(readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')));
}

// ─── Main audit ───────────────────────────────────────────────────────────────
function audit() {
  console.log(`\n${B}Career-Ops Pipeline Audit${X}`);
  console.log(`Root: ${ROOT}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const pipelineText = readFileSync(PIPELINE_FILE, 'utf8');
  const applicationsText = readFileSync(APPLICATIONS_FILE, 'utf8');

  const pipeline = parsePipeline(pipelineText);
  const { entries: apps, corruptLines } = parseApplications(applicationsText);
  const jdUrls = loadJdUrls();
  const reportFiles = loadReportFiles();

  const issueCount = { errors: 0, warnings: 0 };
  function E(msg) { err(msg); issueCount.errors++; }
  function W(msg) { warn(msg); issueCount.warnings++; }

  // ── 1. Corrupt / malformed lines in applications.md ──────────────────────
  sectionHeader('1. Líneas corruptas / malformadas en applications.md');
  if (corruptLines.length === 0) {
    ok('No se encontraron líneas malformadas.');
  } else {
    for (const cl of corruptLines) {
      E(`Línea ${cl.lineNum}: "${cl.content}"`);
    }
  }

  // ── 2. Duplicate IDs ─────────────────────────────────────────────────────
  sectionHeader('2. IDs duplicados');

  let dupFound = false;
  for (const [id, entry] of pipeline) {
    if (entry.__duplicates) {
      E(`pipeline.md: ID #${id} aparece ${entry.__duplicates + 1} veces`);
      dupFound = true;
    }
  }
  for (const [id, entry] of apps) {
    if (entry.__duplicates) {
      E(`applications.md: ID #${id} aparece ${entry.__duplicates.length + 1} veces (líneas: ${entry.lineNum}, ${entry.__duplicates.join(', ')})`);
      dupFound = true;
    }
  }
  if (!dupFound) ok('No se encontraron IDs duplicados.');

  // ── 3. IDs en pipeline pero no en applications ────────────────────────────
  sectionHeader('3. IDs en pipeline.md sin entrada en applications.md');
  const pipelineOnly = [...pipeline.keys()].filter(id => !apps.has(id)).sort((a, b) => b - a);
  if (pipelineOnly.length === 0) {
    ok('Todos los IDs del pipeline están en applications.md');
  } else {
    for (const id of pipelineOnly) {
      const e = pipeline.get(id);
      E(`#${id} | ${e.company} | ${e.role} (pipeline línea ${e.lineNum})`);
    }
  }

  // ── 4. IDs en applications pero no en pipeline ────────────────────────────
  sectionHeader('4. IDs en applications.md sin entrada en pipeline.md');
  const appsOnly = [...apps.keys()].filter(id => !pipeline.has(id)).sort((a, b) => b - a);
  if (appsOnly.length === 0) {
    ok('Todos los IDs de applications.md están en pipeline.md');
  } else {
    const SHOW_LIMIT = 3;
    const shown = appsOnly.slice(0, SHOW_LIMIT);
    for (const id of shown) {
      const e = apps.get(id);
      W(`#${id} | ${e.company} | ${e.role} (applications línea ${e.lineNum})`);
    }
    if (appsOnly.length > SHOW_LIMIT) {
      console.log(`  ${Y}⚠${X}  … y ${appsOnly.length - SHOW_LIMIT} más (evaluaciones directas sin pipeline — normal)`);
      issueCount.warnings += appsOnly.length - SHOW_LIMIT;
    }
  }

  // ── 5. Report ref ≠ ID (cross-reference mismatch) ─────────────────────────
  sectionHeader('5. Reporte referenciado ≠ ID de la entrada (cross-ref mismatch)');
  let crossRefOk = true;
  for (const [id, app] of apps) {
    if (app.reportRef !== null && app.reportRef !== id) {
      E(`#${id} (${app.company}) apunta a reporte ${app.reportRef} → ${app.reportPath} (línea ${app.lineNum})`);
      crossRefOk = false;
    }
  }
  if (crossRefOk) ok('Todos los cross-references son coherentes (reportRef == ID).');

  // ── 6. Reporte referenciado no existe en disco ─────────────────────────────
  sectionHeader('6. Archivos de reporte referenciados que no existen en disco');
  let missingReports = 0;
  for (const [id, app] of apps) {
    if (!app.reportPath) {
      W(`#${id} (${app.company}): sin link de reporte en applications.md (línea ${app.lineNum})`);
      missingReports++;
      continue;
    }
    const filename = basename(app.reportPath);
    if (!reportFiles.has(filename)) {
      E(`#${id} (${app.company}): reporte "${filename}" no existe en /reports/ (línea ${app.lineNum})`);
      missingReports++;
    }
  }
  if (missingReports === 0) ok('Todos los reportes referenciados existen en disco.');

  // ── 7. Reportes en disco sin ninguna referencia en applications.md ─────────
  sectionHeader('7. Reportes en disco sin referencia en applications.md');
  const referencedReportFiles = new Set(
    [...apps.values()]
      .filter(a => a.reportPath)
      .map(a => basename(a.reportPath))
  );
  // Exclude non-app files
  const ignoredReports = f => /^pattern-analysis-/.test(f) || f === '.gitkeep';
  const orphanReports = [...reportFiles].filter(f => !referencedReportFiles.has(f) && !ignoredReports(f));
  if (orphanReports.length === 0) {
    ok('Ningún reporte huérfano encontrado.');
  } else {
    for (const f of orphanReports.sort()) {
      W(`Reporte huérfano (no referenciado): ${f}`);
    }
  }

  // ── 8. URLs locales: JD no existe en disco ─────────────────────────────────
  sectionHeader('8. URLs locales (local:jds/xxx.md) cuyo JD no existe en disco');
  let missingJds = 0;
  for (const [id, entry] of pipeline) {
    if (entry.url.startsWith('local:')) {
      const jdPath = entry.url.replace(/^local:/, '');
      const jdFile = join(ROOT, jdPath);
      if (!existsSync(jdFile)) {
        E(`#${id} (${entry.company}): JD "${jdPath}" no existe en disco (pipeline línea ${entry.lineNum})`);
        missingJds++;
      }
    }
  }
  if (missingJds === 0) ok('Todos los JDs locales existen en disco.');

  // ── 9. URLs remotas: buscar URL en los JDs (info) ────────────────────────
  sectionHeader('9. URLs remotas: JD correspondiente en /jds/');
  let remoteFound = 0, remoteNotFound = 0;
  for (const [id, entry] of pipeline) {
    if (!entry.url.startsWith('local:') && entry.url.startsWith('http')) {
      const jdFile = jdUrls.get(entry.url);
      if (jdFile) {
        remoteFound++;
        // info(`#${id}: ${entry.url} → ${jdFile}`);
      } else {
        // Not necessarily an error — many remote-only jobs have no local JD copy
        remoteNotFound++;
        // info(`#${id} (${entry.company}): sin JD local para URL remota`);
      }
    }
  }
  info(`${remoteFound} URLs remotas tienen JD local; ${remoteNotFound} no tienen copia local (normal para LinkedIn/InfoJobs directos).`);

  // ── 10. Score mismatch pipeline vs applications ───────────────────────────
  sectionHeader('10. Score mismatch (pipeline.md vs applications.md)');
  let scoreMismatch = 0;
  for (const [id, pEntry] of pipeline) {
    const aEntry = apps.get(id);
    if (!aEntry) continue;
    // Normalize: "3.80/5" → "3.8/5", "4.10/5" → "4.1/5"
    const normalize = s => {
      const parts = s.split('/');
      return parseFloat(parts[0]).toString() + '/5';
    };
    if (normalize(pEntry.score) !== normalize(aEntry.score)) {
      W(`#${id} (${pEntry.company}): score pipeline="${pEntry.score}" vs applications="${aEntry.score}"`);
      scoreMismatch++;
    }
  }
  if (scoreMismatch === 0) ok('Todos los scores coinciden entre pipeline y applications.');

  // ── 11. PDF flag mismatch ─────────────────────────────────────────────────
  sectionHeader('11. PDF flag mismatch (pipeline.md vs applications.md)');
  let pdfMismatch = 0;
  for (const [id, pEntry] of pipeline) {
    const aEntry = apps.get(id);
    if (!aEntry) continue;
    if (pEntry.pdf !== aEntry.pdf) {
      W(`#${id} (${pEntry.company}): PDF pipeline=${pEntry.pdf ? '✅' : '❌'} vs applications=${aEntry.pdf ? '✅' : '❌'}`);
      pdfMismatch++;
    }
  }
  if (pdfMismatch === 0) ok('Todos los flags PDF coinciden entre pipeline y applications.');

  // ── 12. Duplicate reports by URL ──────────────────────────────────────────
  sectionHeader('12. Reportes duplicados por URL');
  let duplicateReportsCount = 0;
  const urlMap = new Map();
  for (const f of reportFiles) {
    if (f === '.gitkeep' || /^pattern-analysis-/.test(f)) continue;
    try {
      const content = readFileSync(join(REPORTS_DIR, f), 'utf8');
      const urlMatch = content.match(/\*\*URL:\*\*\s*(.+)/);
      if (urlMatch) {
        const url = urlMatch[1].trim();
        if (urlMap.has(url)) {
          urlMap.get(url).push(f);
        } else {
          urlMap.set(url, [f]);
        }
      }
    } catch (e) {
      // ignore file read errors
    }
  }
  for (const [url, files] of urlMap.entries()) {
    if (files.length > 1) {
      W(`Múltiples reportes apuntan a la misma URL:\n      URL: ${url}\n      Reportes: ${files.join(', ')}`);
      duplicateReportsCount++;
    }
  }
  if (duplicateReportsCount === 0) ok('No se encontraron reportes duplicados por URL.');

  // ── Summary ───────────────────────────────────────────────────────────────
  sectionHeader('RESUMEN');
  const normalWarnings = appsOnly.length; // check 4: always expected
  const actionableWarnings = issueCount.warnings - normalWarnings;
  const totalIssues = issueCount.errors + issueCount.warnings;

  if (issueCount.errors > 0) {
    console.log(`  ${R}${B}Errores:    ${issueCount.errors}${X}`);
  } else {
    console.log(`  ${G}${B}Errores:    0${X}`);
  }
  if (actionableWarnings > 0) {
    console.log(`  ${Y}${B}Avisos:     ${actionableWarnings} accionables + ${normalWarnings} normales (evals directas)${X}`);
  } else if (normalWarnings > 0) {
    console.log(`  ${G}${B}Avisos:     0 accionables${X} ${Y}+ ${normalWarnings} normales (evals directas sin pipeline)${X}`);
  } else {
    console.log(`  ${G}${B}Avisos:     0${X}`);
  }

  if (issueCount.errors === 0 && actionableWarnings === 0) {
    console.log(`\n  ${G}${B}✓ Pipeline íntegro — no hay issues que requieran acción.${X}\n`);
  } else {
    console.log(`\n  ${B}Total: ${totalIssues} issues (${issueCount.errors} errores + ${issueCount.warnings} avisos)${X}\n`);
  }
}

audit();
