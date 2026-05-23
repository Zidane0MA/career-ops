#!/usr/bin/env node

/**
 * extract-jd.mjs — Extract Job Description from URL
 *
 * Supports LinkedIn, Lever, Ashby, Greenhouse, and company career pages.
 * For LinkedIn: uses persistent Chrome profile with active session (via Playwright).
 * Fallback: WebFetch for static pages.
 *
 * Usage:
 *   node extract-jd.mjs "https://www.linkedin.com/jobs/view/4398382725/" [chrome_profile]
 *   node extract-jd.mjs <URL1> <URL2>
 *   node extract-jd.mjs --input urls.txt --delay-ms 2500
 *
 * Returns: JSON { success: boolean, jd: string, source: string, error?: string }
 *   node extract-jd.mjs --input urls.txt --output results.json
 */

import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

// ── Constants ───────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const DEFAULT_BATCH_DELAY_MS = 2500;

// LinkedIn markers
const LINKEDIN_JD_START = [
  'Acerca del empleo',
  'About the job',
  'About this position',
];
const LINKEDIN_JD_END = [
  'Establecer una alerta',
  'Set up a job alert',
  'Set up a job alert for similar jobs',
  'Similar jobs',
];

// InfoJobs markers
const INFOJOBS_JD_START = [
  'Requisitos',
  'Descripción',
  'Descripcion',
  'Requirements',
];
const INFOJOBS_JD_END = [
  'Nuestro consejo:',
  'Inscribirme en esta oferta',
  'Inscríbete a la oferta',
  'Inscribete a la oferta',
  'Ofertas similares',
  'Comparte esta oferta',
  'Top Subcategorías',
  'Top Subcategorias',
];

// Generic markers for job portals
const GENERIC_JD_START = [
  'Responsabilidades',
  'Responsibilities',
  'Requisitos',
  'Requirements',
  'What you will do',
  'What you\'ll do',
  'Qualifications',
  'Preferred qualifications',
  'Minimum qualifications',
  'Job description',
  'Descripción del puesto',
  'Descripción',
  'Acerca del empleo',
];
const GENERIC_JD_END = [
  'Aplicar',
  'Apply',
  'Candidatos similares',
  'Similar candidates',
  'Compartir',
  'Share',
];

// ── URL Classification ──────────────────────────────────────────────

function detectPortal(url) {
  const host = new URL(url).hostname;

  if (host.includes('linkedin')) return 'linkedin';
  if (host.includes('lever')) return 'lever';
  if (host.includes('ashby')) return 'ashby';
  if (host.includes('greenhouse')) return 'greenhouse';
  if (host.includes('workday')) return 'workday';
  if (host.includes('infojobs')) return 'infojobs';
  if (host.includes('tecnoempleo')) return 'tecnoempleo';

  return 'generic';
}

// Tecnoempleo headers — required to bypass Cloudflare bot detection
const TECNOEMPLEO_HEADERS = {
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

// InfoJobs headers — required to bypass bot detection (405 without these)
const INFOJOBS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

// ── JD Parsing ──────────────────────────────────────────────────────

function parseLinkedInJD(text) {
  let start = 0;
  for (const marker of LINKEDIN_JD_START) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      start = idx;
      break;
    }
  }

  let end = text.length;
  for (const marker of LINKEDIN_JD_END) {
    const idx = text.indexOf(marker);
    if (idx > start && idx !== -1) {
      end = idx;
      break;
    }
  }

  const jd = text.slice(start, end).trim();
  // Collapse excessive whitespace
  return jd
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n?[.\u2026]\s*m[aá]s\s*$/i, '')
    .replace(/\n?(show more|mostrar más|ver más)\s*$/i, '')
    .trim();
}

function parseGenericJD(text) {
  let start = -1;
  for (const marker of GENERIC_JD_START) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      start = idx;
      break;
    }
  }

  let end = text.length;
  for (const marker of GENERIC_JD_END) {
    const idx = text.indexOf(marker);
    if (idx > start && idx !== -1) {
      end = idx;
      break;
    }
  }

  const jd = start !== -1 ? text.slice(start, end).trim() : text.trim();
  return jd.replace(/\n{3,}/g, '\n\n');
}

function parseInfoJobsJD(text) {
  let start = -1;
  for (const marker of INFOJOBS_JD_START) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      start = idx;
      break;
    }
  }

  let end = text.length;
  const searchFrom = start !== -1 ? start : 0;
  for (const marker of INFOJOBS_JD_END) {
    const idx = text.indexOf(marker, searchFrom);
    if (idx !== -1 && idx < end) end = idx;
  }

  const jd = start !== -1 ? text.slice(start, end).trim() : text.trim();
  return jd.replace(/\n{3,}/g, '\n\n');
}

function parseTecnoempleoJD(html) {
  const descStart = html.indexOf('itemprop="description"');
  if (descStart === -1) return null;

  const jdDivStart = html.indexOf('<div class="fs--16 text-gray-800">', descStart);
  if (jdDivStart === -1) return null;

  const jdEnd = html.indexOf('<div class="mt-5">', jdDivStart);
  const jdHtml = jdEnd !== -1
    ? html.slice(jdDivStart, jdEnd)
    : html.slice(jdDivStart, jdDivStart + 8000);

  const text = jdHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '');

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\u2028|\u2029/g, '\n')
    .trim();
}

function sanitizeResult(value) {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeResult);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeResult(nestedValue)])
    );
  }

  return value;
}

function toJsonStringLiteral(value) {
  let out = '"';

  for (const char of value) {
    const code = char.codePointAt(0);

    if (char === '"' || char === '\\') {
      out += `\\${char}`;
      continue;
    }

    if (char === '\b') { out += '\\b'; continue; }
    if (char === '\f') { out += '\\f'; continue; }
    if (char === '\n') { out += '\\n'; continue; }
    if (char === '\r') { out += '\\r'; continue; }
    if (char === '\t') { out += '\\t'; continue; }

    if (code < 0x20 || code === 0x7F) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    if (code <= 0x7E) {
      out += char;
      continue;
    }

    if (code <= 0xFFFF) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    const high = Math.floor((code - 0x10000) / 0x400) + 0xD800;
    const low = ((code - 0x10000) % 0x400) + 0xDC00;
    out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
  }

  out += '"';
  return out;
}

function stringifySafeJson(value) {
  const json = JSON.stringify(sanitizeResult(value), null, 2);
  return json.replace(/"(?:\\.|[^"\\])*"/g, token => {
    try {
      return toJsonStringLiteral(JSON.parse(token));
    } catch {
      return token;
    }
  });
}

function emitJson(value, outputPath = null) {
  const payload = stringifySafeJson(value);

  if (outputPath) {
    writeFileSync(outputPath, payload + '\n', 'utf-8');
  }

  process.stdout.write(payload + '\n', 'utf8');
}

// ── Playwright Mutex ────────────────────────────────────────────────

const PLAYWRIGHT_LOCK = join(tmpdir(), 'career-ops-playwright.lock');
const LOCK_POLL_MS = 300;
const LOCK_TIMEOUT_MS = 120_000;

async function acquirePlaywrightLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(PLAYWRIGHT_LOCK, 'wx'));
      return;
    } catch {
      await sleep(LOCK_POLL_MS);
    }
  }
  throw new Error('Playwright lock timeout — another extract-jd process may be stuck');
}

function releasePlaywrightLock() {
  try { unlinkSync(PLAYWRIGHT_LOCK); } catch { /* already gone */ }
}

// ── Playwright JD Extraction ────────────────────────────────────────

async function createPlaywrightSession(chromeProfile) {
  const context = await chromium.launchPersistentContext(chromeProfile, {
    headless: true,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const page = await context.newPage();
  return { context, page };
}

async function extractWithPlaywrightPage(page, url) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });

  await page.waitForTimeout(3000);

  try {
    const expandBtn = page.locator(
      'button[aria-label*="más"], button[aria-label*="more"], ' +
      'button:has-text("ver más"), button:has-text("show more"), ' +
      'button:has-text("Mostrar más")'
    );

    if ((await expandBtn.count()) > 0) {
      const btn = expandBtn.first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(800);
      }
    }
  } catch {
    // No expand button found — description is already fully visible
  }

  const rawText = sanitizeText(await page.evaluate(() => document.body.innerText));
  const portal = detectPortal(url);
  let jd;

  if (portal === 'linkedin') {
    jd = parseLinkedInJD(rawText);
  } else if (portal === 'infojobs') {
    jd = parseInfoJobsJD(rawText);
  } else {
    jd = parseGenericJD(rawText);
  }

  if (jd.length < 200) {
    jd = rawText.slice(0, 4000);
  }

  return sanitizeResult({ success: true, jd, source: portal });
}

// ── WebFetch Fallback ───────────────────────────────────────────────

async function extractWithWebFetch(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    const html = await response.text();

    // Extract text from HTML (simple regex approach)
    const text = sanitizeText(html
      .replace(/<script[^>]*>.*?<\/script>/gi, '')
      .replace(/<style[^>]*>.*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '));

    const portal = detectPortal(url);
    let jd;

    if (portal === 'linkedin') {
      jd = parseLinkedInJD(text);
    } else if (portal === 'infojobs') {
      jd = parseInfoJobsJD(text);
    } else {
      jd = parseGenericJD(text);
    }

    if (jd.length < 200) {
      jd = text.slice(0, 4000);
    }

    return sanitizeResult({ success: true, jd, source: `${portal}-webfetch` });
  } catch (err) {
    return sanitizeResult({
      success: false,
      error: err.name === 'AbortError' ? 'Request timed out after 10000ms' : err.message,
    });
  }
}

// ── Tecnoempleo Extractor ────────────────────────────────────────────

async function extractTecnoempleoJD(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      headers: TECNOEMPLEO_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return sanitizeResult({ success: false, error: `HTTP ${response.status}` });
    }

    const html = await response.text();

    if (html.includes('Performing security verification') || html.includes('Just a moment')) {
      return sanitizeResult({ success: false, error: 'Cloudflare challenge — try again later' });
    }

    const jd = parseTecnoempleoJD(html);
    if (!jd || jd.length < 100) {
      return sanitizeResult({ success: false, error: 'Could not extract JD from page' });
    }

    return sanitizeResult({ success: true, jd, source: 'tecnoempleo' });
  } catch (err) {
    return sanitizeResult({
      success: false,
      error: err.name === 'AbortError' ? 'Request timed out after 10000ms' : err.message,
    });
  }
}

// ── InfoJobs Extractor ───────────────────────────────────────────────

async function extractInfoJobsJD(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(url, {
      headers: INFOJOBS_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return sanitizeResult({ success: false, error: `HTTP ${response.status}` });
    }

    const html = await response.text();

    const text = sanitizeText(html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, '\n'));

    const jd = parseInfoJobsJD(text);

    if (!jd || jd.length < 100) {
      return sanitizeResult({ success: false, error: 'Could not extract JD from InfoJobs page' });
    }

    return sanitizeResult({ success: true, jd, source: 'infojobs' });
  } catch (err) {
    return sanitizeResult({
      success: false,
      error: err.name === 'AbortError' ? 'Request timed out after 15000ms' : err.message,
    });
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function extractJD(url, chromeProfile, playwrightPage = null) {
  const portal = detectPortal(url);

  // LinkedIn: ALWAYS use Playwright (requires persistent session)
  if (portal === 'linkedin') {
    if (!chromeProfile) {
      return sanitizeResult({
        success: false,
        error:
          'LinkedIn URLs require a Chrome profile. Run: node scan-linkedin.mjs --setup',
      });
    }

    try {
      if (playwrightPage) {
        return await extractWithPlaywrightPage(playwrightPage, url);
      }

      await acquirePlaywrightLock();
      const session = await createPlaywrightSession(chromeProfile);
      try {
        return await extractWithPlaywrightPage(session.page, url);
      } finally {
        await session.context.close();
        releasePlaywrightLock();
      }
    } catch (err) {
      releasePlaywrightLock();
      return sanitizeResult({
        success: false,
        error: `Playwright failed for LinkedIn: ${err.message}`,
      });
    }
  }

  // Tecnoempleo: native fetch with Cloudflare-bypass headers, no Playwright needed
  if (portal === 'tecnoempleo') {
    return await extractTecnoempleoJD(url);
  }

  // InfoJobs: Playwright preferred (JS challenge), fetch fallback
  if (portal === 'infojobs') {
    if (chromeProfile) {
      try {
        if (playwrightPage) {
          return await extractWithPlaywrightPage(playwrightPage, url);
        }
        await acquirePlaywrightLock();
        const session = await createPlaywrightSession(chromeProfile);
        try {
          return await extractWithPlaywrightPage(session.page, url);
        } finally {
          await session.context.close();
          releasePlaywrightLock();
        }
      } catch (err) {
        releasePlaywrightLock();
        console.warn(`Playwright failed for InfoJobs: ${err.message}. Falling back to fetch.`);
      }
    }
    return await extractInfoJobsJD(url);
  }

  // Other portals: try Playwright first (for SPA rendering)
  if (['lever', 'ashby', 'greenhouse', 'workday'].includes(portal)) {
    if (chromeProfile) {
      try {
        if (playwrightPage) {
          return await extractWithPlaywrightPage(playwrightPage, url);
        }

        await acquirePlaywrightLock();
        const session = await createPlaywrightSession(chromeProfile);
        try {
          return await extractWithPlaywrightPage(session.page, url);
        } finally {
          await session.context.close();
          releasePlaywrightLock();
        }
      } catch (err) {
        releasePlaywrightLock();
        console.warn(`Playwright failed for ${portal}: ${err.message}. Falling back to WebFetch.`);
      }
    }
  }

  // Generic/static pages or fallback: use WebFetch
  return await extractWithWebFetch(url);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isLikelyUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

function parseCliArgs(argv) {
  const options = {
    urls: [],
    inputPath: null,
    outputPath: null,
    chromeProfile: null,
    delayMs: DEFAULT_BATCH_DELAY_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--input') {
      options.inputPath = argv[++i] || null;
      continue;
    }

    if (arg === '--chrome-profile') {
      options.chromeProfile = argv[++i] || null;
      continue;
    }

    if (arg === '--output') {
      options.outputPath = argv[++i] || null;
      continue;
    }

    if (arg === '--delay-ms') {
      options.delayMs = Number(argv[++i] || DEFAULT_BATCH_DELAY_MS);
      continue;
    }

    options.urls.push(arg);
  }

  // Backward compatibility: node extract-jd.mjs <URL> <chrome_profile>
  if (
    options.urls.length === 2 &&
    isLikelyUrl(options.urls[0]) &&
    !isLikelyUrl(options.urls[1]) &&
    !options.chromeProfile &&
    !options.inputPath
  ) {
    options.chromeProfile = options.urls[1];
    options.urls = [options.urls[0]];
  }

  return options;
}

function loadUrlsFromFile(inputPath) {
  return readFileSync(inputPath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function loadDefaultChromeProfile() {
  try {
    const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    return config.linkedin_searches?.chrome_profile || null;
  } catch {
    return null;
  }
}

async function extractBatch(urls, chromeProfile, delayMs) {
  const results = [];
  const needsPlaywright = urls.some(url => {
    const portal = detectPortal(url);
    return portal === 'linkedin' || (
      chromeProfile && ['lever', 'ashby', 'greenhouse', 'workday', 'infojobs'].includes(portal)
    );
  });

  let session = null;
  let linkedInCount = 0;

  try {
    if (needsPlaywright && chromeProfile) {
      await acquirePlaywrightLock();
      session = await createPlaywrightSession(chromeProfile);
    }

    for (const url of urls) {
      const portal = detectPortal(url);

      if (portal === 'linkedin' && linkedInCount > 0 && delayMs > 0) {
        await sleep(delayMs);
      }

      const result = await extractJD(url, chromeProfile, session?.page ?? null);
      results.push({ url, ...result });

      if (portal === 'linkedin') {
        linkedInCount++;
      }
    }
  } finally {
    if (session) {
      await session.context.close();
      releasePlaywrightLock();
    }
  }

  return {
    success: results.every(result => result.success),
    count: results.length,
    delay_ms: delayMs,
    results,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const fileUrls = options.inputPath ? loadUrlsFromFile(options.inputPath) : [];
  const urls = [...options.urls, ...fileUrls];

  if (urls.length === 0) {
    console.error('Usage: node extract-jd.mjs <URL> [chrome_profile]');
    console.error('   or: node extract-jd.mjs <URL1> <URL2> --chrome-profile <path> [--delay-ms 2500]');
    console.error('   or: node extract-jd.mjs --input urls.txt [--chrome-profile <path>] [--delay-ms 2500] [--output results.json]');
    process.exit(1);
  }

  const chromeProfile = options.chromeProfile || loadDefaultChromeProfile();

  if (urls.length === 1) {
    const result = await extractJD(urls[0], chromeProfile);
    emitJson(result, options.outputPath);
    process.exit(result.success ? 0 : 1);
  }

  const batchResult = await extractBatch(urls, chromeProfile, options.delayMs);
  emitJson(batchResult, options.outputPath);
  process.exit(batchResult.success ? 0 : 1);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      success: false,
      error: err.message,
    })
  );
  process.exit(1);
});
