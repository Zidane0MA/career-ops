#!/usr/bin/env node

/**
 * scan-linkedin.mjs — LinkedIn job scanner via Playwright
 *
 * DISCOVERY ONLY: Finds job URLs on LinkedIn, NO JD extraction.
 * JD extraction happens in /career-ops pipeline via extract-jd.mjs
 *
 * Uses a persistent Chrome profile (with active LinkedIn session).
 * Reads linkedin_searches from portals.yml.
 * Saves URLs to pipeline.md + scan-history.tsv (same format as scan.mjs)
 *
 * Usage:
 *   node scan-linkedin.mjs                   # scan all enabled queries
 *   node scan-linkedin.mjs --dry-run         # preview without writing files
 *   node scan-linkedin.mjs --query "redes"   # single keyword search
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

// ── Constants ───────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// ── Dedup (same logic as scan.mjs) ─────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  const addKey = (key) => {
    if (!key) return;
    seen.add(key);
    // Dual support: if it's a linkedin URL or prefix, add both to cover history/pipeline
    const m = key.match(/\/jobs\/view\/(\d+)/) || key.match(/^linkedin::(\d+)$/);
    if (m) {
      seen.add(`https://www.linkedin.com/jobs/view/${m[1]}`);
      seen.add(`linkedin::${m[1]}`);
    }
  };

  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      addKey(line.split('\t')[0]);
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const m of text.matchAll(/- \[[ x]\][^\n]*?(local:\S+|https?:\/\/\S+)/g)) {
      addKey(m[1]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();

  // scan-history.tsv — the source of truth for dedup (columns: url | first_seen | portal | title | company | status)
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
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
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const m of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const co = m[1].trim().toLowerCase();
      const role = m[2].trim().toLowerCase();
      if (co && role && co !== 'company') seen.add(`${co}::${role}`);
    }
  }

  return seen;
}

// ── Title filter (uses portals.yml title_filter) ────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const ok = positive.length === 0 || positive.some(k => lower.includes(k));
    const bad = negative.some(k => lower.includes(k));
    return ok && !bad;
  };
}

// ── Pipeline / history writers (same contract as scan.mjs) ──────────

function appendToPipeline(offers) {
  if (!offers.length) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block = offers
    .map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`)
    .join('\n') + '\n';

  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const at = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, at) + `\n${marker}\n\n` + block + '\n' + text.slice(at);
  } else {
    const afterMarker = idx + marker.length;
    const insertBlock = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n');
    text = text.slice(0, afterMarker) + insertBlock + text.slice(afterMarker);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers
    .map(o => `linkedin::${o.jobId}\t${date}\tlinkedin-playwright\t${o.title}\t${o.company}\tadded`)
    .join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── LinkedIn page interactions ──────────────────────────────────────

async function waitForJobCards(page, timeoutMs = 10_000) {
  try {
    await page.waitForSelector('a[href*="/jobs/view/"]', { timeout: timeoutMs });
  } catch {
    // Selector never appeared — page may have loaded with no results or a challenge
  }
}

async function navigateWithRetry(page, url, { retries = 2, baseDelay = 3000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForJobCards(page, 8_000);
      return true;
    } catch (err) {
      if (attempt === retries) throw err;
      const backoff = baseDelay * (attempt + 1);
      console.log(`  ⟳ Navigation retry ${attempt + 1}/${retries} (waiting ${backoff}ms)…`);
      await page.waitForTimeout(backoff);
    }
  }
}

async function getJobIds(page, searchUrl, max) {
  await navigateWithRetry(page, searchUrl);

  // Scroll downwards to trigger lazy loading of more jobs
  await page.evaluate(async (maxJobs) => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const getCount = () => document.querySelectorAll('a[href*="/jobs/view/"]').length;

    let retries = 0;
    const MAX_RETRIES = 12;

    while (getCount() < maxJobs && retries < MAX_RETRIES) {
      const prev = getCount();

      // Attempt 1: Scroll the specific LinkedIn list container
      const list = document.querySelector('.jobs-search-results-list') ||
        document.querySelector('.scaffold-layout__list');
      if (list) list.scrollTop = list.scrollHeight;

      // Attempt 2: Scroll the window
      window.scrollTo(0, document.body.scrollHeight);

      // Attempt 3: Scroll the last job card into view
      const cards = document.querySelectorAll('[data-occludable-job-id]');
      if (cards.length > 0) {
        cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
      }

      // Adaptive delay: longer waits after failed scroll attempts
      const scrollDelay = retries < 3 ? 1200 : retries < 6 ? 2000 : 3000;
      await delay(scrollDelay);

      if (getCount() === prev) {
        retries++;
      } else {
        retries = 0;
      }
    }
  }, max);

  const ids = await page.evaluate(() => {
    const found = new Set();
    document.querySelectorAll('a[href*="/jobs/view/"]').forEach(a => {
      const m = a.href.match(/\/jobs\/view\/(\d+)/);
      if (m) found.add(m[1]);
    });
    return [...found];
  });

  return ids.slice(0, max);
}

async function getJobSummaries(page) {
  const results = await page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').replace(/with verification/gi, '').trim();
    const entries = [];
    const seen = new Set();

    document.querySelectorAll('a[href*="/jobs/view/"]').forEach(anchor => {
      const match = anchor.href.match(/\/jobs\/view\/(\d+)/);
      if (!match) return;

      const jobId = match[1];
      if (seen.has(jobId)) return;

      const card =
        anchor.closest('li') ||
        anchor.closest('[data-occludable-job-id]') ||
        anchor.closest('[class*="job-card-container"]') ||
        anchor.parentElement;

      const title =
        normalize(anchor.getAttribute('aria-label')) ||
        normalize(anchor.textContent) ||
        normalize(card?.querySelector('[class*="job-card-list__title"]')?.textContent) ||
        normalize(card?.querySelector('[class*="job-card-container__link"]')?.textContent);

      const company =
        normalize(card?.querySelector('[class*="artdeco-entity-lockup__subtitle"]')?.textContent) ||
        normalize(card?.querySelector('[class*="job-card-container__company-name"]')?.textContent) ||
        normalize(card?.querySelector('[class*="subtitle"]')?.textContent);

      const location =
        normalize(card?.querySelector('[class*="job-card-container__metadata-item"]')?.textContent) ||
        normalize(card?.querySelector('[class*="job-card-container__metadata-wrapper"]')?.textContent);

      entries.push({
        jobId,
        title: title || 'Unknown Role',
        company: company || '',
        location: location || '',
        url: `https://www.linkedin.com/jobs/view/${jobId}`,
      });
      seen.add(jobId);
    });

    return entries;
  });

  return new Map(results.map(result => [result.jobId, result]));
}

// ── Main ────────────────────────────────────────────────────────────

// ── Setup mode ──────────────────────────────────────────────────────

async function runSetup(chromeProfile) {
  const { mkdirSync } = await import('fs');
  mkdirSync(chromeProfile, { recursive: true });
  console.log(`\nAbriendo Chrome con perfil dedicado: ${chromeProfile}`);
  console.log('→ Inicia sesión en LinkedIn en la ventana que se abre.');
  console.log('→ Cierra la ventana cuando hayas iniciado sesión.\n');

  const ctx = await chromium.launchPersistentContext(chromeProfile, {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log('Esperando a que cierres la ventana manualmente...');
  await ctx.waitForEvent('close').catch(() => { });
  console.log('\n✓ Setup completado. Ahora puedes correr: node scan-linkedin.mjs');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const setupMode = args.includes('--setup');
  const queryIdx = args.indexOf('--query');
  const queryFilter = queryIdx !== -1 ? args[queryIdx + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const li = config.linkedin_searches;

  if (!li?.enabled) {
    console.log('LinkedIn scanning disabled (linkedin_searches.enabled: false in portals.yml)');
    return;
  }

  const chromeProfile = li.chrome_profile;

  // ── Guard: catch the common "User Data" root mistake ──────────────
  if (chromeProfile) {
    const normalized = chromeProfile.replace(/\\/g, '/');
    if (/AppData\/Local\/Google\/Chrome\/User Data\/?$/.test(normalized)) {
      console.error('ERROR: chrome_profile apunta al directorio raíz de Chrome ("User Data").');
      console.error('Chrome rechaza remote debugging en el perfil por defecto.');
      console.error('');
      console.error('Solución: cambia chrome_profile en portals.yml a una carpeta dedicada,');
      console.error('  por ejemplo: "C:/perfiles-chrome/playwright-linkedin"');
      console.error('');
      console.error('Luego ejecuta el setup inicial:');
      console.error('  node scan-linkedin.mjs --setup');
      process.exit(1);
    }
  }

  if (setupMode) {
    if (!chromeProfile) {
      console.error('Configura linkedin_searches.chrome_profile en portals.yml primero.');
      process.exit(1);
    }
    await runSetup(chromeProfile);
    return;
  }

  if (!chromeProfile || !existsSync(chromeProfile)) {
    console.error(`Chrome profile no encontrado: "${chromeProfile}"`);
    console.error('Ejecuta el setup inicial: node scan-linkedin.mjs --setup');
    process.exit(1);
  }

  const searches = (li.searches || [])
    .filter(s => s.enabled !== false)
    .filter(s => !queryFilter || s.query.toLowerCase().includes(queryFilter));

  // Fixed extra source: LinkedIn Recommended Jobs collection.
  // Always appended regardless of `searches` config (agnostic to portals.yml queries).
  // Skipped when --query filter is active (user is targeting a specific search).
  const RECOMMENDED_URL = 'https://www.linkedin.com/jobs/collections/recommended/?&discover=recommended&discoveryOrigin=JOBS_HOME_JYMBII';
  const includeRecommended = !queryFilter;

  if (!searches.length && !includeRecommended) {
    console.log('No LinkedIn searches enabled. Check portals.yml → linkedin_searches.searches.');
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();
  const passTitleFilter = buildTitleFilter(config.title_filter);

  const maxPerQuery = li.max_per_query ?? 15;

  console.log(`LinkedIn Scanner — ${date}`);
  console.log(`Queries: ${searches.length}${includeRecommended ? ' + recommended' : ''} | max/query: ${maxPerQuery}`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const browser = await chromium.launchPersistentContext(chromeProfile, {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  const newOffers = [];
  let totalFound = 0, totalFiltered = 0, totalDupes = 0;
  const errors = [];

  // ── Build unified source list ───────────────────────────────────────
  // Each entry: { label, url }
  const sources = [
    ...searches.map(s => {
      const params = new URLSearchParams({
        keywords: s.query,
        geoId: li.geo_id,
        f_TPR: li.date_posted || 'r604800',
        origin: 'JOB_SEARCH_PAGE_LOCATION_AUTOCOMPLETE',
        refresh: 'true',
      });
      return { label: `Query: "${s.query}"`, url: `https://www.linkedin.com/jobs/search/?${params}` };
    }),
    ...(includeRecommended ? [{ label: 'Recommended Jobs (LinkedIn collection)', url: RECOMMENDED_URL }] : []),
  ];

  const interQueryDelay = li.inter_query_delay_ms ?? 4000;

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si];
    console.log(`\n[${si + 1}/${sources.length}] ${source.label}`);
    if (dryRun) console.log(`  URL: ${source.url}`);

    // Pause between queries to avoid LinkedIn rate-limiting
    if (si > 0) {
      const jitter = Math.floor(Math.random() * 2000);
      const pause = interQueryDelay + jitter;
      console.log(`  ⏳ Cooling down ${(pause / 1000).toFixed(1)}s…`);
      await page.waitForTimeout(pause);
    }

    let jobIds;
    let summaries;
    try {
      jobIds = await getJobIds(page, source.url, maxPerQuery);
      summaries = await getJobSummaries(page);
      console.log(`  Found ${jobIds.length} job IDs`);
      totalFound += jobIds.length;
    } catch (err) {
      errors.push({ query: source.label, error: err.message });
      console.log(`  ✗ Error: ${err.message}`);
      continue;
    }

    for (const jobId of jobIds) {
      const liKey = `https://www.linkedin.com/jobs/view/${jobId}`;
      const liPrefix = `linkedin::${jobId}`;
      const legacyLocalKey = `local:jds/linkedin-${jobId}.md`;

      if (seenUrls.has(liKey) || seenUrls.has(liPrefix) || seenUrls.has(legacyLocalKey)) {
        totalDupes++;
        continue;
      }

      const details = summaries.get(jobId) || {
        jobId,
        title: 'Unknown Role',
        company: '',
        location: '',
        url: liKey,
      };

      if (!passTitleFilter(details.title)) {
        console.log(`  - Filtered: ${details.title}`);
        totalFiltered++;
        continue;
      }

      const roleKey = `${details.company.toLowerCase()}::${details.title.toLowerCase()}`;
      if (seenCompanyRoles.has(roleKey)) {
        totalDupes++;
        continue;
      }

      const offer = { ...details, date, jobId, source: 'linkedin-playwright' };
      seenUrls.add(liKey);
      seenCompanyRoles.add(roleKey);
      newOffers.push(offer);

      console.log(`  + ${details.company} | ${details.title}`);
    }
  }

  await browser.close();

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // ── Summary (mirrors scan.mjs format) ──────────────────────────────
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`LinkedIn Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Sources scanned:       ${searches.length} quer${searches.length === 1 ? 'y' : 'ies'}${includeRecommended ? ' + recommended' : ''}`);
  console.log(`Job IDs found:         ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.query ?? `job ${e.jobId}`}: ${e.error}`);
  }

  if (newOffers.length > 0) {
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log('\n→ Run /career-ops pipeline para evaluar las nuevas ofertas.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
