// @ts-check
// tecnoempleo — Tecnoempleo.com (Spanish IT job board) listing scanner.
//
// Port of the old standalone scan-tecnoempleo.mjs to the plugin provider
// contract: this module only fetches + parses result pages and returns Job[];
// scan.mjs owns title/location filtering, dedup and the pipeline write.
//
// Search URL params (all comma-wrapped lists, e.g. `,263,`):
//   pr         province id (263 = Madrid). Omit for all Spain.
//   es         specialty ids (39 Redes, 43 Técnico Sistemas, 8 Soporte, …)
//   ex         experience buckets (1 sin exp, 2 <1 año, 3 1 año, 4 2 años)
//   co         jornada (1 completa, 2 media jornada, 5 intensiva tarde)
//   en_remoto  modalidad (1 100% remoto, 2 presencial, 3 híbrido)
//   te         free-text keywords
//
// Canonical URL is https://www.tecnoempleo.com/n/n/rf-{hash} — the key the old
// scanner wrote to scan-history.tsv, so history dedup carries over.

const BASE_URL = 'https://www.tecnoempleo.com/ofertas-trabajo/';
const PAGE_CEILING = 10;
const DEFAULT_PAGES = 2;
const DEFAULT_DELAY_MS = 1500;

// Tecnoempleo sits behind Cloudflare; a plain browser header set passes.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

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
    .replace(/&#39;/g, "'")
    .replace(/&euro;/g, '€')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** dd/mm/yyyy → epoch ms (noon UTC), or undefined */
function parseDate(text) {
  const m = String(text ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return undefined;
  const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T12:00:00Z`);
  return Number.isFinite(t) ? t : undefined;
}

/** "18.000€ - 24.000€ b/a" → { min, max, currency } */
function parseSalary(text) {
  const m = String(text ?? '').match(/([\d.]+)\s*€\s*-\s*([\d.]+)\s*€/);
  if (!m) return undefined;
  const min = Number(m[1].replace(/\./g, ''));
  const max = Number(m[2].replace(/\./g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) return undefined;
  return { min, max, currency: 'EUR' };
}

/** @param {string} html */
export function parseJobs(html) {
  const jobs = [];
  const cardRe = /<div[^>]+class="[^"]*p-3 border rounded mb-3 bg-white[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*p-3 border rounded mb-3 bg-white|<div[^>]+id="sidebar|<\/main|$)/g;
  for (const card of html.match(cardRe) || []) {
    const t = card.match(/href="(https:\/\/www\.tecnoempleo\.com\/[^"]+\/rf-[^"]+)"[^>]*title="([^"]+)"/);
    if (!t) continue;
    const rf = t[1].match(/(rf-[a-z0-9]+)/i)?.[1];
    const url = rf ? `https://www.tecnoempleo.com/n/n/${rf}` : t[1];
    const title = decode(t[2].trim());

    const company = decode((
      card.match(/href="https:\/\/www\.tecnoempleo\.com\/[^"]+\/re-\d+[^"]*"[^>]*>([^<]+)<\/a>/)?.[1]
      ?? card.match(/title="Ofertas de Empleo ([^"]+)"/)?.[1]
      ?? card.match(/href="https:\/\/www\.tecnoempleo\.com\/[^"]+?-trabajo[^"]*"[^>]*>([^<]{1,60})<\/a>/)?.[1]
      ?? ''
    ).trim());

    const meta = stripTags(decode(card.match(/<span[^>]+class="[^"]*text-gray-800[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? ''));
    const rawCity = decode(card.match(/<b>([^<]+)<\/b>/)?.[1]?.trim() ?? '');
    const city = /remoto/i.test(rawCity) ? 'España' : rawCity;
    let location = city;
    if (/100% remoto/i.test(meta) || /100% remoto/i.test(card)) location = city ? `${city} (Remoto)` : 'España (Remoto)';
    else {
      const mode = meta.match(/\((Presencial|Híbrido|Remoto)\)/)?.[1];
      if (mode) location = city ? `${city} (${mode})` : mode;
    }

    const tags = [...card.matchAll(/<a[^>]+href="\/ofertas-trabajo\/[^"]*"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g)]
      .map((m) => decode(m[1].trim()))
      .filter((x) => x && x.length < 40);

    const postedAt = parseDate(meta);
    const salary = parseSalary(meta);
    jobs.push({
      title,
      url,
      company,
      location,
      ...(postedAt ? { postedAt } : {}),
      ...(salary ? { salary } : {}),
      ...(tags.length ? { description: `Tags: ${tags.join(', ')}. ${meta}` } : meta ? { description: meta } : {}),
    });
  }
  return jobs;
}

const wrap = (v) => {
  const items = (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((x) => String(x).trim())
    .filter(Boolean);
  return items.length ? `,${items.join(',')},` : null;
};

/** @param {Record<string, any>} entry @param {number} page */
export function buildSearchUrl(entry, page) {
  const params = [];
  for (const [key, field] of [['pr', 'province'], ['es', 'specialties'], ['ex', 'experience'], ['co', 'jornada'], ['en_remoto', 'modalidad']]) {
    const w = wrap(entry[field]);
    if (w) params.push(`${key}=${w}`);
  }
  if (entry.keywords) params.push(`te=${encodeURIComponent(String(entry.keywords))}`);
  if (page > 1) params.push(`pagina=${page}`);
  return `${BASE_URL}?${params.join('&')}`;
}

export default {
  provider: {
    id: 'tecnoempleo',
    /**
     * @param {Record<string, any>} entry  portals.yml job_boards entry
     * @param {any} ctx                    plugin ctx (guarded fetch)
     */
    async fetch(entry, ctx) {
      const pages = Math.min(Math.max(1, Number(entry.max_pages) || DEFAULT_PAGES), PAGE_CEILING);
      const delayMs = Number(entry.delay_ms) || DEFAULT_DELAY_MS;
      const seen = new Set();
      const out = [];
      for (let page = 1; page <= pages; page++) {
        let html;
        try {
          html = await serialized(async () => {
            const res = await ctx.fetch(buildSearchUrl(entry, page), { headers: HEADERS, timeoutMs: 15_000 });
            const text = await res.text();
            await sleep(delayMs);
            return text;
          });
        } catch (err) {
          if (page === 1) throw err;
          // Tecnoempleo answers 404 for a page past the last one — that's the end, not an error.
          if (/** @type {any} */ (err).status === 404) break;
          ctx.log?.(`tecnoempleo: "${entry.name}" stopped at page ${page}: ${/** @type {Error} */ (err).message}`);
          break;
        }
        if (/cf-challenge|challenge-platform|Just a moment\.\.\./i.test(html) && !/rf-[a-z0-9]+/i.test(html)) {
          throw new Error('Cloudflare challenge — retry later');
        }
        const jobs = parseJobs(html);
        if (jobs.length === 0) break;
        let fresh = 0;
        for (const job of jobs) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          fresh++;
          out.push(job);
        }
        if (fresh === 0) break;
      }
      return out;
    },
  },
};
