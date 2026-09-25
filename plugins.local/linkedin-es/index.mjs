// @ts-check
// linkedin-es — LinkedIn job search for the Spanish market via the public
// guest endpoint (no login, no browser, no cookies).
//
// Replaces the old scan-linkedin.mjs (Playwright + logged-in Chrome profile):
// the guest endpoint returns the same result cards as the logged-out search
// page, so there is no account at risk and nothing to keep signed in.
//
//   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//       ?keywords=…&location=…&geoId=…&f_TPR=…&f_JT=…&f_WT=…&f_E=…&start=N
//
// Each portals.yml `job_boards` entry with `provider: linkedin-es` is one
// search. The engine (scan.mjs) applies title_filter / location_filter, dedups
// against scan-history.tsv + pipeline.md + applications.md and writes the
// pipeline — this plugin only returns Job[].
//
// Canonical URL is https://www.linkedin.com/jobs/view/{id} — the same key the
// old scanner wrote to scan-history.tsv, so history dedup carries over.

//
// The guest search IGNORES f_JT / f_WT / f_E (verified 2026-09-25: identical
// results with and without them). So an entry that needs a jornada filter sets
// `employment_types:` and the plugin reads each posting's detail page
// (/jobs-guest/jobs/api/jobPosting/{id}) for its "Tipo de empleo", keeping a
// posting when the type matches OR the description mentions part-time hours
// (`description_rescue:`). Verdicts are cached in data/linkedin-es-cache.json
// so a posting's detail is fetched once, not on every scan.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const PAGE_CEILING = 10; // absolute cap per entry, whatever the config says
const DEFAULT_PAGES = 2;
const DEFAULT_DELAY_MS = 2500;
const DEFAULT_DETAIL_DELAY_MS = 1200;
const DEFAULT_MAX_DETAILS = 60;
const CACHE_TTL_MS = 60 * 86_400_000;

const DEFAULT_RESCUE = [
  'media jornada', 'jornada parcial', 'tiempo parcial', 'jornada reducida',
  'part-time', 'part time', '20 horas', '25 horas', '30 horas',
  '20h semanales', '25h semanales', '30h semanales', 'horario de tarde',
  'working student', 'werkstudent',
];

// LinkedIn's employment types in the two UI languages it serves.
const TYPE_ALIASES = {
  'part-time': 'media jornada',
  'internship': 'prácticas',
  'full-time': 'jornada completa',
  'contract': 'contrato por obra',
  'temporary': 'temporal',
};

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
const canonType = (s) => fold(TYPE_ALIASES[fold(s)] ?? s);

const cachePath = () => path.join(
  process.env.CAREER_OPS_ROOT?.trim() || process.env.CAREER_OPS_DATA_DIR?.trim() || process.cwd(),
  'data', 'linkedin-es-cache.json',
);
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(cachePath(), 'utf8')); } catch { cache = {}; }
  const now = Date.now();
  for (const [id, v] of Object.entries(cache)) if (!v?.at || now - v.at > CACHE_TTL_MS) delete cache[id];
  return cache;
}
function saveCache() {
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch { /* cache is an optimisation only */ }
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

// scan.mjs fetches up to 10 entries in parallel. LinkedIn rate-limits the
// guest endpoint hard (429), so every request from every entry goes through
// one module-level queue with a delay between calls.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Some employers' titles arrive double-encoded ("ProgramaciÃ³n"). Undo the
// latin1 round-trip only when the tell-tale sequence is present.
function fixMojibake(s) {
  if (!/Ã[\u0080-¿]/.test(s)) return s;
  try { return Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
}

const clean = (s) => fixMojibake(decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());

/** @param {string} html  jobPosting detail page → { type, text } */
export function parseDetail(html) {
  let type = '';
  for (const m of html.matchAll(/description__job-criteria-subheader">([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)) {
    if (/tipo de empleo|employment type/i.test(m[1])) type = clean(m[2]);
  }
  const body = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  return { type, text: clean(body.replace(/<br\s*\/?>|<\/(p|li)>/gi, '\n')) };
}

/** @param {string} html */
export function parseCards(html) {
  const jobs = [];
  const parts = html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
  for (const part of parts) {
    const id = part.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const title = clean(part.match(/base-search-card__title">([\s\S]*?)<\/h3>/)?.[1] ?? '');
    if (!title) continue;
    const company = clean(part.match(/base-search-card__subtitle">([\s\S]*?)<\/h4>/)?.[1] ?? '');
    const location = clean(part.match(/job-search-card__location">([\s\S]*?)<\/span>/)?.[1] ?? '');
    const date = part.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const postedAt = date ? Date.parse(`${date}T12:00:00Z`) : undefined;
    const salary = clean(part.match(/job-search-card__salary-info">([\s\S]*?)<\/span>/)?.[1] ?? '');
    jobs.push({
      id,
      title,
      company,
      location,
      url: `https://www.linkedin.com/jobs/view/${id}`,
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
      ...(salary ? { description: `Salario publicado: ${salary}` } : {}),
    });
  }
  return jobs;
}

/** @param {Record<string, any>} entry @param {number} start */
export function buildSearchUrl(entry, start) {
  const p = new URLSearchParams();
  if (entry.keywords) p.set('keywords', String(entry.keywords));
  p.set('location', String(entry.location ?? 'España'));
  if (entry.geo_id) p.set('geoId', String(entry.geo_id));
  p.set('f_TPR', String(entry.date_posted ?? 'r604800'));
  if (entry.sort_by) p.set('sortBy', String(entry.sort_by));
  p.set('start', String(start));
  return `${SEARCH_URL}?${p.toString()}`;
}

const REMOTE_RE = /100\s*%\s*(en\s+)?(remoto|teletrabajo|remote)|full[\s-]?remote|fully remote|totalmente (en )?remoto|teletrabajo (total|completo)|remote[\s-]first|trabajo (100\s*%\s*)?en remoto/i;
const HYBRID_RE = /h[ií]brid[oa]|hybrid/i;

/** Workplace tag from the description — LinkedIn's card never says it. */
export function workplaceTag(text) {
  if (REMOTE_RE.test(text)) return 'Remoto';
  if (HYBRID_RE.test(text)) return 'Híbrido';
  return '';
}

/**
 * Verdict for one posting against the entry's detail requirements.
 * @param {{type: string, text: string}} detail
 * @param {Record<string, any>} entry
 */
export function passesDetail(detail, entry) {
  const wanted = (entry.employment_types ?? []).map(canonType);
  if (wanted.length) {
    const typeOk = wanted.includes(canonType(detail.type));
    const rescue = (entry.description_rescue ?? DEFAULT_RESCUE).map(fold);
    const text = fold(detail.text);
    if (!typeOk && !rescue.some((k) => text.includes(k))) return false;
  }
  if (entry.remote_only && workplaceTag(detail.text) !== 'Remoto') return false;
  return true;
}

const needsDetail = (entry) => (entry.employment_types ?? []).length > 0 || entry.remote_only === true;

export default {
  provider: {
    id: 'linkedin-es',
    /**
     * @param {Record<string, any>} entry  portals.yml job_boards entry
     * @param {any} ctx                    plugin ctx (guarded fetch)
     */
    async fetch(entry, ctx) {
      const pages = Math.min(Math.max(1, Number(entry.max_pages) || DEFAULT_PAGES), PAGE_CEILING);
      const delayMs = Number(entry.delay_ms) || DEFAULT_DELAY_MS;
      const seen = new Set();
      const cards = [];
      let start = 0;

      for (let page = 0; page < pages; page++) {
        let html;
        try {
          html = await serialized(async () => {
            const res = await ctx.fetch(buildSearchUrl(entry, start), { headers: HEADERS, timeoutMs: 15_000 });
            const text = await res.text();
            await sleep(delayMs);
            return text;
          });
        } catch (err) {
          // First page failing is a real failure the scan should report;
          // a later page failing (usually 429) keeps what we already have.
          if (page === 0) throw err;
          ctx.log?.(`linkedin-es: "${entry.name}" stopped at page ${page + 1}: ${/** @type {Error} */ (err).message}`);
          break;
        }
        const batch = parseCards(html);
        if (batch.length === 0) break;
        let fresh = 0;
        for (const card of batch) {
          if (seen.has(card.id)) continue;
          seen.add(card.id);
          fresh++;
          cards.push(card);
        }
        if (fresh === 0) break;
        start += batch.length;
      }

      if (!needsDetail(entry)) return cards.map(({ id, ...job }) => job);

      // Detail pass: bounded, serialized, cached.
      const c = loadCache();
      const detailDelay = Number(entry.detail_delay_ms) || DEFAULT_DETAIL_DELAY_MS;
      const maxDetails = Math.max(0, Number(entry.max_details) || DEFAULT_MAX_DETAILS);
      let fetched = 0;
      const out = [];
      for (const { id, ...job } of cards) {
        let d = c[id];
        if (!d) {
          if (fetched >= maxDetails) continue;
          try {
            d = await serialized(async () => {
              const res = await ctx.fetch(DETAIL_URL + id, { headers: HEADERS, timeoutMs: 15_000 });
              const parsed = parseDetail(await res.text());
              await sleep(detailDelay);
              return parsed;
            });
          } catch (err) {
            ctx.log?.(`linkedin-es: detail ${id} failed: ${/** @type {Error} */ (err).message} — stopping detail pass`);
            break; // almost always a 429: stop hammering, keep what we have
          }
          fetched++;
          d = { type: d.type, work: workplaceTag(d.text), rescue: DEFAULT_RESCUE.some((k) => fold(d.text).includes(fold(k))), text: d.text.slice(0, 6000), at: Date.now() };
          c[id] = d;
        }
        if (!passesDetail(d, entry)) continue;
        const bits = [d.type && `Tipo de empleo: ${d.type}`, d.work && `Modalidad: ${d.work}`].filter(Boolean).join(' · ');
        out.push({
          ...job,
          location: d.work && job.location ? `${job.location} (${d.work})` : job.location || d.work,
          description: [bits, job.description, d.text].filter(Boolean).join('\n'),
        });
      }
      saveCache();
      return out;
    },
  },
};
