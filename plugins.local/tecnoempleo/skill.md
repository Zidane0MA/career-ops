---
name: career-ops-plugin-tecnoempleo
description: Tecnoempleo.com (Spanish IT job board) scanner with province, specialty, jornada and remote filters.
license: MIT
---

# tecnoempleo

Provider plugin. It runs inside `node scan.mjs` for every `portals.yml → job_boards`
entry with `provider: tecnoempleo`. Nothing to run by hand.

## Entry fields (all optional, comma lists)

| Field | URL param | Values |
|-------|-----------|--------|
| `province` | `pr` | `263` Madrid. Omit for all Spain. |
| `specialties` | `es` | `39` Redes, `43` Técnico Sistemas, `8` Soporte, `19` Helpdesk, `34` DevOps, `12` Programador, `53` IA/ML, `40` Ciberseguridad |
| `experience` | `ex` | `1` sin exp, `2` <1 año, `3` 1 año, `4` 2 años |
| `jornada` | `co` | `1` completa, `2` media jornada, `5` intensiva de tarde |
| `modalidad` | `en_remoto` | `1` 100% remoto, `2` presencial, `3` híbrido |
| `keywords` | `te` | free text |
| `max_pages`, `delay_ms` | | 30 results per page, hard cap 10. Default 2 pages / 1500 ms. |

## What it produces

`Job { title, url, company, location, postedAt?, salary?, description? }`.
`url` is canonical `https://www.tecnoempleo.com/n/n/rf-{hash}` (same key as the old
scan-tecnoempleo.mjs history). `location` carries the modality: `Madrid (Híbrido)`,
`España (Remoto)`.

## If it fails

- "Cloudflare challenge" → retry later.
- After editing `index.mjs`: `node plugins.mjs trust tecnoempleo`.
