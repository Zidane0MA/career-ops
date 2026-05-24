#!/usr/bin/env node

/**
 * scan-tecnoempleo.mjs — Tecnoempleo job scraper
 *
 * Uses native Node.js fetch with browser headers (bypasses Cloudflare).
 * Parses HTML listing pages with regex — no Playwright needed.
 * Integrates with career-ops: title filters, dedup, pipeline.md, scan-history.tsv.
 *
 * Selectors/patterns validated 2026-05-09 against live tecnoempleo HTML.
 *
 * Usage:
 *   node scan-tecnoempleo.mjs               # scan all enabled searches
 *   node scan-tecnoempleo.mjs --dry-run     # preview without writing files
 *   node scan-tecnoempleo.mjs --pages 5     # override max pages per search
 *   node scan-tecnoempleo.mjs --search "Redes"  # run a specific search by name
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';

// ── Config ──────────────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS = 'data/applications.md';
const BASE_URL = 'https://www.tecnoempleo.com/ofertas-trabajo/';
const RESULTS_PER_PAGE = 30;

mkdirSync('data', { recursive: true });

// Browser headers to bypass Cloudflare bot detection
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pagesIdx = args.indexOf('--pages');
const searchIdx = args.indexOf('--search');
const pagesOverride = pagesIdx !== -1 ? parseInt(args[pagesIdx + 1], 10) : null;
const searchFilter = searchIdx !== -1 ? args[searchIdx + 1]?.toLowerCase() : null;

// ── Load config ──────────────────────────────────────────────────────────────

if (!existsSync(PORTALS_PATH)) {
  console.error('Error: portals.yml not found.');
  process.exit(1);
}

const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
const techConfig = config.tecnoempleo;

if (!techConfig?.enabled) {
  console.log('Tecnoempleo scanner is disabled in portals.yml (tecnoempleo.enabled: false)');
  process.exit(0);
}

const maxPages = pagesOverride ?? techConfig.max_pages ?? 2;
const delayMs = techConfig.delay_ms ?? 1500;
const defaultMaxAgeDays = Number.isFinite(Number(techConfig.max_age_days))
  ? Number(techConfig.max_age_days)
  : null;
const searches = (techConfig.searches ?? [])
  .filter(s => s.enabled !== false)
  .filter(s => !searchFilter || s.name.toLowerCase().includes(searchFilter));

if (searches.length === 0) {
  console.log('No matching searches found.');
  process.exit(0);
}

// ── Title filter ─────────────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive ?? []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative ?? []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const ok = positive.length === 0 || positive.some(k => lower.includes(k));
    const bad = negative.some(k => lower.includes(k));
    return ok && !bad;
  };
}

const titleFilter = buildTitleFilter(config.title_filter);

// ── Offer age filter ────────────────────────────────────────────────────────

function parseTecnoempleoDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  const [, dd, mm, yyyy] = match;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysOld(dateText, now = new Date()) {
  const posted = parseTecnoempleoDate(dateText);
  if (!posted) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const postedDay = new Date(posted.getFullYear(), posted.getMonth(), posted.getDate());
  return Math.floor((today - postedDay) / 86_400_000);
}

function getMaxAgeDays(search) {
  const value = search.max_age_days ?? defaultMaxAgeDays;
  if (value == null || value === false) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// ── URL normalizer ───────────────────────────────────────────────────────────

function normalizeUrl(url) {
  const rfMatch = url.match(/(rf-[a-z0-9]+)/i);
  return rfMatch ? `https://www.tecnoempleo.com/n/n/${rfMatch[1]}` : url;
}

// ── HTML parser ──────────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&euro;/g, '€')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '');
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseJobsFromHtml(html) {
  const jobs = [];

  // Split HTML into individual job cards
  // Each card starts with: <div class="p-3 border rounded mb-3 bg-white"
  const cardRegex = /<div[^>]+class="[^"]*p-3 border rounded mb-3 bg-white[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*p-3 border rounded mb-3 bg-white|<div[^>]+id="sidebar|<\/main|$)/g;
  const cardMatches = html.match(cardRegex) || [];

  for (const card of cardMatches) {
    // ── Title + URL ───────────────────────────────────────────────────────
    // Pattern: <a href="...rf-..." ... title="JOB TITLE">
    const titleMatch = card.match(/href="(https:\/\/www\.tecnoempleo\.com\/[^"]+\/rf-[^"]+)"[^>]*title="([^"]+)"/);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = decodeHtmlEntities(titleMatch[2].trim());

    // ── Company ───────────────────────────────────────────────────────────
    // Two patterns used by tecnoempleo:
    //   a) href="...re-DIGITS"  → older company pages
    //   b) href="...slug-trabajo" + title="Ofertas de Empleo COMPANY" → newer
    const companyByRe = card.match(/href="https:\/\/www\.tecnoempleo\.com\/[^"]+\/re-\d+[^"]*"[^>]*>([^<]+)<\/a>/);
    const companyByTitle = card.match(/title="Ofertas de Empleo ([^"]+)"/);
    const companyByTrabajo = card.match(/href="https:\/\/www\.tecnoempleo\.com\/[^"]+?-trabajo[^"]*"[^>]*>([^<]{1,60})<\/a>/);
    const company = companyByRe
      ? decodeHtmlEntities(companyByRe[1].trim())
      : companyByTitle
        ? decodeHtmlEntities(companyByTitle[1].trim())
        : companyByTrabajo
          ? decodeHtmlEntities(companyByTrabajo[1].trim())
          : null;

    // ── Location, work mode, date, salary ─────────────────────────────────
    // They appear in: <span class="d-block d-lg-none text-gray-800">
    //   <b>Madrid</b> (Presencial) - 08/05/2026<br>18.000€ - 24.000€ b/a
    const metaSpanMatch = card.match(/<span[^>]+class="[^"]*(?:d-block d-lg-none text-gray-800|text-gray-800)[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const metaText = metaSpanMatch ? stripTags(decodeHtmlEntities(metaSpanMatch[1])) : '';

    // City name in <b>
    const cityMatch = card.match(/<b>([^<]+)<\/b>/);
    const city = cityMatch ? decodeHtmlEntities(cityMatch[1].trim()) : null;

    // Work mode
    let workMode = null, location = null;
    if (metaText.includes('100% remoto') || card.includes('100% remoto')) {
      workMode = '100% remoto';
      location = 'Remoto';
    } else {
      const modeMatch = metaText.match(/\((Presencial|Híbrido|Remoto)\)/);
      if (modeMatch) {
        workMode = modeMatch[1];
        location = city;
      }
    }

    // Date
    const dateMatch = metaText.match(/(\d{2}\/\d{2}\/\d{4})/);
    const date = dateMatch?.[1] ?? null;

    // Salary — pattern: XX.XXX€ - XX.XXX€ b/a  (encoded as &euro;)
    const salaryMatch = metaText.match(/([\d.]+€\s*-\s*[\d.]+€[^-\n]*)/);
    const salary = salaryMatch ? salaryMatch[1].trim() : null;

    // ── Tags ──────────────────────────────────────────────────────────────
    // Tech tags appear as <span> inside <a href="/ofertas-trabajo/..."> links
    const tagMatches = [...card.matchAll(/<a[^>]+href="\/ofertas-trabajo\/[^"]*"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g)];
    const tags = tagMatches
      .map(m => decodeHtmlEntities(m[1].trim()))
      .filter(t => t && t.length < 40);

    // ── Urgent flag ───────────────────────────────────────────────────────
    const urgent = card.includes('badge-success') && card.toLowerCase().includes('urgente');

    jobs.push({ title, url: normalizeUrl(url), company, location, workMode, date, salary, tags, urgent });
  }

  return jobs;
}

// ── Fetch page ────────────────────────────────────────────────────────────────

function normalizeList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function buildCommaWrappedParam(values) {
  const items = normalizeList(values);
  return items.length > 0 ? `,${items.join(',')},` : null;
}

function buildSearchUrl({ location, specialties, experience }, page) {
  const params = [`pr=,${location},`, `es=,${specialties},`];
  const experienceParam = buildCommaWrappedParam(experience);
  if (experienceParam) params.push(`ex=${experienceParam}`);
  if (page > 1) params.push(`pagina=${page}`);
  return `${BASE_URL}?${params.join('&')}`;
}

async function fetchPage(search, page) {
  const url = buildSearchUrl(search, page);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY)) {
    readFileSync(SCAN_HISTORY, 'utf-8').split('\n').slice(1).forEach(line => {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    });
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\][^\n]*?(https?:\/\/\S+)/g))
      seen.add(m[1]);
  }
  if (existsSync(APPLICATIONS)) {
    for (const m of readFileSync(APPLICATIONS, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g))
      seen.add(m[0]);
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();

  // scan-history.tsv — the source of truth for dedup (columns: url | first_seen | portal | title | company | status)
  if (existsSync(SCAN_HISTORY)) {
    const lines = readFileSync(SCAN_HISTORY, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const parts = line.split('\t');
      if (parts.length >= 5) {
        const title = parts[3]?.trim().toLowerCase();
        const company = parts[4]?.trim().toLowerCase();
        if (title && company) {
          seen.add(`${company}::${title}`);
        }
      }
    }
  }

  // Also check applications.md for completeness (in case of offline edits)
  if (existsSync(APPLICATIONS)) {
    const text = readFileSync(APPLICATIONS, 'utf-8');
    for (const m of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const co = m[1].trim().toLowerCase();
      const ro = m[2].trim().toLowerCase();
      if (co && ro && co !== 'company') seen.add(`${co}::${ro}`);
    }
  }

  return seen;
}

// ── Pipeline writer ───────────────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';

  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block = '\n' + offers.map(o =>
    `- [ ] ${o.url} | ${o.company ?? 'N/A'} | ${o.title}`
  ).join('\n');

  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, insertAt) + `\n${marker}\n${block}\n\n` + text.slice(insertAt);
  } else {
    text = text.slice(0, idx + marker.length) + block + text.slice(idx + marker.length);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY))
    writeFileSync(SCAN_HISTORY, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');

  appendFileSync(
    SCAN_HISTORY,
    offers.map(o =>
      `${o.url}\t${date}\ttecnoempleo\t${o.title}\t${o.company ?? ''}\tadded`
    ).join('\n') + '\n',
    'utf-8'
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatLocalDate(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const date = formatLocalDate();
  const seenUrls = loadSeenUrls();
  const seenCR = loadSeenCompanyRoles();
  const newOffers = [];
  const errors = [];

  let totalFetched = 0;
  let totalFiltered = 0;
  let totalTooOld = 0;
  let totalDupes = 0;

  console.log(`🔍 Tecnoempleo Scanner — ${date}`);
  console.log(`   Searches: ${searches.length} | Max pages: ${maxPages} | Max age: ${defaultMaxAgeDays ?? 'off'} days | Dry-run: ${dryRun}`);
  if (dryRun) console.log('   (dry-run — no files will be written)\n');

  for (const search of searches) {
    console.log(`\n📂 ${search.name}`);
    const searchWithDefaults = {
      ...search,
      experience: search.experience ?? techConfig.experience,
    };

    for (let page = 1; page <= maxPages; page++) {
      let html;
      try {
        html = await fetchPage(searchWithDefaults, page);
      } catch (err) {
        errors.push({ search: search.name, page, error: err.message });
        console.log(`   Page ${page}: ❌ ${err.message}`);
        break;
      }

      // Detect Cloudflare challenge
      if (html.includes('Performing security verification') || html.includes('Just a moment')) {
        errors.push({ search: search.name, page, error: 'Cloudflare challenge — try again later' });
        console.log(`   Page ${page}: ⚠️  Cloudflare challenge detected`);
        break;
      }

      const jobs = parseJobsFromHtml(html);
      console.log(`   Page ${page}: ${jobs.length} jobs found`);
      totalFetched += jobs.length;

      if (jobs.length === 0) break;

      for (const job of jobs) {
        if (!titleFilter(job.title)) { totalFiltered++; continue; }

        const maxAgeDays = getMaxAgeDays(search);
        const ageDays = daysOld(job.date);
        if (maxAgeDays != null && ageDays != null && ageDays > maxAgeDays) {
          totalTooOld++;
          continue;
        }

        if (seenUrls.has(job.url)) { totalDupes++; continue; }

        const key = `${(job.company ?? '').toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCR.has(key)) { totalDupes++; continue; }

        seenUrls.add(job.url);
        seenCR.add(key);
        newOffers.push({ ...job, source: 'tecnoempleo' });
      }

      if (jobs.length < RESULTS_PER_PAGE) break;
      if (page < maxPages) await sleep(delayMs);
    }
  }

  // Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // Summary
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Tecnoempleo Scan — ${date}`);
  console.log(`${'━'.repeat(50)}`);
  console.log(`Total fetched:        ${totalFetched}`);
  console.log(`Filtered (title):     ${totalFiltered}`);
  console.log(`Filtered (too old):   ${totalTooOld}`);
  console.log(`Duplicates skipped:   ${totalDupes}`);
  console.log(`New offers added:     ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    errors.forEach(e => console.log(`  ✗ ${e.search} p${e.page}: ${e.error}`));
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    newOffers.forEach(o => {
      const mode = o.workMode ? ` [${o.workMode}]` : '';
      const posted = o.date ? ` — ${o.date}` : '';
      const salary = o.salary ? ` — ${o.salary}` : '';
      const urgent = o.urgent ? ' 🔴' : '';
      console.log(`  + ${o.company ?? '?'} | ${o.title}${mode}${posted}${salary}${urgent}`);
    });
    if (dryRun) {
      console.log('\n(dry-run — run without --dry-run to save)');
    } else {
      console.log(`\n→ Saved to ${PIPELINE_PATH} and ${SCAN_HISTORY}`);
    }
  } else {
    console.log('\nNo new offers found (all filtered or already seen).');
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
