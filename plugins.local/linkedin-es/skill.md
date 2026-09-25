---
name: career-ops-plugin-linkedin-es
description: LinkedIn job search for Spain (guest endpoint, no login) with per-posting jornada and remote verification.
license: MIT
---

# linkedin-es

Provider plugin. It runs inside `node scan.mjs` for every `portals.yml → job_boards`
entry with `provider: linkedin-es`. Nothing to run by hand.

## Entry fields

| Field | Meaning |
|-------|---------|
| `keywords` | LinkedIn boolean search (`OR`, `AND`, quotes, parentheses). The public search matches the description too, so `AND ("media jornada" OR "part time")` narrows toward part-time roles. |
| `location`, `geo_id` | Madrid = `103374081`, España = `105646813`. |
| `date_posted` | `r86400` (24 h), `r604800` (7 d), `r1209600` (14 d), `r2592000` (30 d). |
| `max_pages` | 10 results per page, hard cap 10 pages. |
| `employment_types` | e.g. `["Media jornada"]`, `["Prácticas"]`. Triggers a detail fetch per posting; a posting passes when its "Tipo de empleo" matches OR its description mentions part-time hours (`description_rescue`, defaults cover "media jornada", "20/25/30 horas", "working student"...). |
| `remote_only` | `true` → keeps only postings whose description says 100% remoto / full remote. Tags location `(Remoto)`. |
| `max_details`, `detail_delay_ms`, `delay_ms` | Rate-limit knobs. Defaults 60 / 1200 ms / 2500 ms. |

The public search IGNORES LinkedIn's own `f_JT` / `f_WT` / `f_E` filters (verified
2026-09-25), which is why jornada and remote are verified on the detail page.

## What it produces

`Job { title, url, company, location, postedAt?, description? }`.
`url` is canonical `https://www.linkedin.com/jobs/view/{id}` (same key as the old
scan-linkedin.mjs history, so dedup carries over). With a detail pass, `description`
starts with `Tipo de empleo: … · Modalidad: …` followed by the JD text.

## Cache

`data/linkedin-es-cache.json` stores the detail verdict per posting id for 60 days.
Safe to delete.

## If it fails

- HTTP 429 → LinkedIn rate limit. The plugin stops the detail pass and keeps what it has; re-run later.
- After editing `index.mjs`: `node plugins.mjs trust linkedin-es` (integrity pin).
