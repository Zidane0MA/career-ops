#!/usr/bin/env node
/**
 * audit-jds.mjs
 * Comprehensive audit for the /jds folder.
 * Detects: duplicates (by title/URL), missing metadata (H1/Apply),
 * true orphans (not referenced anywhere), and soft orphans (linked by URL but not path).
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const JDS_DIR    = resolve(__dirname, "jds");
const PIPELINE   = resolve(__dirname, "data/pipeline.md");
const TRACKER    = resolve(__dirname, "data/applications.md");
const REPORTS_DIR= resolve(__dirname, "reports");

// ANSI colours
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  magenta:"\x1b[35m",
  dim:    "\x1b[2m",
};
const color = (c, text) => `${c}${text}${C.reset}`;

// ── Parse pipeline.md ─────────────────────────────────────────────────────
function parsePipeline(content) {
  const map = new Map(); // basename → { num, line }
  for (const line of content.split("\n")) {
    const m = line.match(/#(\d+)\s*\|\s*local:jds\/([^\s|]+)\s*\|(.+)/);
    if (m) {
      const [, num, file, rest] = m;
      const parts = rest.split("|").map(s => s.trim());
      map.set(file.trim(), { num, company: parts[0], role: parts[1], score: parts[2], pdf: parts[3] });
    }
  }
  return map;
}

// ── Parse applications.md ─────────────────────────────────────────────────
function parseTracker(content) {
  const map = new Map(); // num (string) → { date, company, role, score, status, pdf }
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/);
    if (m) {
      const [, num, date, company, role, score, status, pdf] = m.map(s => s?.trim());
      if (num && !isNaN(num)) {
        map.set(num, { date, company, role, score, status, pdf });
      }
    }
  }
  return map;
}

async function main() {
  const [pipelineContent, trackerContent] = await Promise.all([
    readFile(PIPELINE, "utf-8").catch(() => ""),
    readFile(TRACKER, "utf-8").catch(() => ""),
  ]);

  const pipelineMap = parsePipeline(pipelineContent);
  const trackerMap  = parseTracker(trackerContent);

  // ── 1. Global Reference Extraction ───────────────────────────────────────
  const referencedJds = new Set();
  const referencedUrls = new Set();

  function extractReferences(content) {
    const pathRegex = /local:jds\/([a-zA-Z0-9._-]+)/gi;
    let pathMatch;
    while ((pathMatch = pathRegex.exec(content)) !== null) {
      referencedJds.add(pathMatch[1].toLowerCase());
    }

    const urlRegex = /\*\*URL:\*\* (https?:\/\/[^\s|]+)/gi;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(content)) !== null) {
      referencedUrls.add(urlMatch[1].trim().toLowerCase());
    }
  }

  // Scan pipeline.md
  extractReferences(pipelineContent);
  const genericUrlRegex = /\| (https?:\/\/[^\s|]+) \|/gi;
  let genericUrlMatch;
  while ((genericUrlMatch = genericUrlRegex.exec(pipelineContent)) !== null) {
    referencedUrls.add(genericUrlMatch[1].trim().toLowerCase());
  }

  // Scan applications.md
  extractReferences(trackerContent);

  // Scan all reports
  if (existsSync(REPORTS_DIR)) {
    const reports = (await readdir(REPORTS_DIR)).filter(f => f.endsWith('.md'));
    for (const report of reports) {
      const reportContent = await readFile(join(REPORTS_DIR, report), 'utf-8');
      extractReferences(reportContent);
      
      const batchMatch = reportContent.match(/\*\*Batch ID:\*\* ([a-zA-Z0-9._-]+)/i);
      if (batchMatch) {
        const batchId = batchMatch[1].toLowerCase();
        referencedJds.add(batchId.endsWith('.md') ? batchId : batchId + '.md');
        referencedJds.add(batchId); 
      }
    }
  }

  // ── 2. Scan JDs ──────────────────────────────────────────────────────────
  if (!existsSync(JDS_DIR)) {
    console.error(`Directory ${JDS_DIR} not found.`);
    return;
  }
  
  const files = (await readdir(JDS_DIR)).filter(f => f.endsWith(".md") && f !== ".gitkeep");

  console.log(
    `\n${color(C.bold + C.cyan, "🔍 JD Audit & Duplicate Checker")}\n` +
    color(C.dim, `   ${files.length} JD files · pipeline.md · applications.md · reports/`)
  );

  const titleMap   = new Map(); // title  → [filename, ...]
  const urlMap     = new Map(); // url    → [filename, ...]
  const jdUrlMap   = new Map(); // filename -> url
  const missingUrl   = [];
  const missingTitle = [];

  for (const file of files) {
    const content = await readFile(join(JDS_DIR, file), "utf-8");
    const lines   = content.replace(/^﻿/, "").split(/\r?\n/);

    // Title: first H1 anywhere in first 5 lines (tolerates BOM/blank leading lines)
    const h1Line = lines.slice(0, 5).find(l => /^#\s*.+$/.test(l));
    if (h1Line) {
      const title = h1Line.replace(/^#\s*/, "").trim();
      if (!titleMap.has(title)) titleMap.set(title, []);
      titleMap.get(title).push(file);
    } else {
      missingTitle.push({ file, firstLine: lines[0]?.slice(0, 80) || "(empty)" });
    }

    // Apply URL
    const urlMatch = content.match(/^\*\*Apply:\*\*\s*(.+)$/im);
    if (urlMatch) {
      const url = urlMatch[1].trim().toLowerCase();
      if (!urlMap.has(url)) urlMap.set(url, []);
      urlMap.get(url).push(file);
      jdUrlMap.set(file, url);
    } else {
      missingUrl.push(file);
    }
  }

  // ── Helper: resolve tracker info for a filename ───────────────────────
  function resolveEntries(filename) {
    const pEntry = pipelineMap.get(filename);
    if (!pEntry) return [{ num: null, info: null }];

    const allEntries = [];
    for (const line of pipelineContent.split("\n")) {
      const m = line.match(/#(\d+)\s*\|\s*local:jds\/([^\s|]+)\s*\|(.+)/);
      if (m && m[2].trim() === filename) {
        const num   = m[1];
        const tInfo = trackerMap.get(num);
        allEntries.push({ num, tInfo });
      }
    }
    return allEntries.length ? allEntries : [{ num: pEntry.num, tInfo: trackerMap.get(pEntry.num) }];
  }

  function formatEntry(filename, entries) {
    const lines = [`       • ${color(C.dim, filename)}`];
    if (!entries[0].num) {
      lines.push(`         ${color(C.dim, "No pipeline entry")}`);
    } else {
      for (const { num, tInfo } of entries) {
        if (!tInfo) {
          lines.push(`         ${color(C.magenta, `#${num}`)} ${color(C.yellow, "→ not in applications.md")}`);
        } else {
          const statusColor = tInfo.status?.includes("Applied") ? C.green
            : tInfo.status?.includes("SKIP")    ? C.red
            : C.yellow;
          lines.push(
            `         ${color(C.magenta, `#${num}`)} ` +
            `${color(C.bold, tInfo.company)} — ${tInfo.role} ` +
            `[${tInfo.score}] ${color(statusColor, tInfo.status)} ${tInfo.pdf}`
          );
        }
      }
    }
    return lines.join("\n");
  }

  // ── Report duplicates by title ─────────────────────────────────────────
  const titleDupes = [...titleMap.entries()].filter(([, fs]) => fs.length > 1);
  const urlDupes   = [...urlMap.entries()].filter(([, fs]) => fs.length > 1);

  console.log(color(C.bold, "\n══ Duplicates ═══════════════════════════════════════\n"));
  if (titleDupes.length === 0 && urlDupes.length === 0) {
    console.log(color(C.green, "  ✅ No duplicate titles or URLs found.\n"));
  } else {
    for (const [title, dupeFiles] of titleDupes) {
      console.log(color(C.yellow + C.bold, `  📝 Title: "${title}"`));
      for (const f of dupeFiles) console.log(formatEntry(f, resolveEntries(f)));
      console.log();
    }
    for (const [url, dupeFiles] of urlDupes) {
      console.log(color(C.yellow + C.bold, `  🔗 URL: ${url}`));
      for (const f of dupeFiles) console.log(formatEntry(f, resolveEntries(f)));
      console.log();
    }
  }

  // ── 3. Find Orphans ──────────────────────────────────────────────────────
  const trueOrphans = [];
  const softOrphans = []; // linked by URL but not path

  for (const file of files) {
    const fileLower = file.toLowerCase();
    const hasPathRef = referencedJds.has(fileLower) || referencedJds.has(fileLower.replace('.md', ''));
    
    if (!hasPathRef) {
      const url = jdUrlMap.get(file);
      if (url && referencedUrls.has(url)) {
        softOrphans.push(file);
      } else {
        trueOrphans.push(file);
      }
    }
  }

  console.log(color(C.bold, "══ Orphaned JDs ═════════════════════════════════════\n"));
  
  if (trueOrphans.length === 0 && softOrphans.length === 0) {
    console.log(color(C.green, "  ✅ All JDs are correctly referenced.\n"));
  }

  if (trueOrphans.length > 0) {
    console.log(color(C.red + C.bold, `  ❌ True Orphans (${trueOrphans.length})`));
    console.log(color(C.dim, `  Not found in pipeline.md, applications.md, or reports by path OR url.\n`));
    for (const f of trueOrphans) {
      const title = [...titleMap.entries()].find(([, files]) => files.includes(f))?.[0] || "(no title)";
      console.log(`    • ${f}`);
      console.log(`      ${color(C.dim, `"${title}"`)}`);
    }
    console.log();
  }

  if (softOrphans.length > 0) {
    console.log(color(C.yellow + C.bold, `  ⚠️ Soft Orphans / Unlinked JDs (${softOrphans.length})`));
    console.log(color(C.dim, `  These JDs are on disk and their URL is found in reports/pipeline, but they are NOT linked as local:jds/...`));
    console.log(color(C.dim, `  Fix: Update the reports to use **URL:** local:jds/filename.md\n`));
    for (const f of softOrphans) {
      console.log(`    • ${color(C.cyan, f)}`);
    }
    console.log();
  }

  // ── Warnings ──────────────────────────────────────────────────────────
  if (missingUrl.length > 0 || missingTitle.length > 0) {
    console.log(color(C.bold, "══ Warnings ═════════════════════════════════════════\n"));
    for (const { file, firstLine } of missingTitle) {
      console.log(color(C.yellow, `  ⚠️ ${file} — missing H1 title`));
      console.log(color(C.dim,    `     (line 1: "${firstLine}")`));
    }
    for (const f of missingUrl)   console.log(color(C.yellow, `  ⚠️ ${f} — missing **Apply:** field`));
    console.log();
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(color(C.dim, "─".repeat(54)));
  console.log(
    `${color(C.bold, "Summary:")}  ${files.length} JDs · ` +
    `${color(titleDupes.length > 0 ? C.red : C.green, `${titleDupes.length} title dupes`)} · ` +
    `${color(trueOrphans.length > 0 ? C.red : C.green, `${trueOrphans.length} true orphans`)} · ` +
    `${color(softOrphans.length > 0 ? C.yellow : C.green, `${softOrphans.length} soft orphans`)}\n`
  );
}

main().catch(err => {
  console.error(color(C.red, `\nFatal: ${err.message}`));
  process.exit(1);
});
