# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Workflow

1. **Leer** `data/pipeline.md` → items `- [ ]` en "Pendientes".
2. **Separar SPAs y otras**: No son procesables por subagentes — Chrome MCP. Requiere chat sin subagentes / contexto limpio.
3. **Reservar REPORT_NUM**: `NEXT=$(node next-report.mjs)`. Asigna `[NEXT, NEXT+1, ...]` en orden a cada URL. **Pasa los números FIJOS al subagente**.
4. **Agrupar en buckets de 4 URLs** (2 si modelos open-source pequeños). Mezclar tipos libremente. Lanzar todos en **paralelo** (máx 4 simultáneos, Agent tool):
   - Inyectar `batch/batch-prompt.md` + lista de `{URL, REPORT_NUM, DATE, ID}` por cada oferta del bucket.
   - **REPORT_NUM como números FIJOS** — el subagente NO los calcula.
   - **NO pre-extraer JDs** - El subagente/worker RESUELVE sus propias fuentes de JD (ver `batch/batch-prompt.md` Paso 1).
   - **Ejecutar auto-pipeline completo**: Evaluación A-G → Report .md → PDF (si score ≥ 3.0) → Tracker.
   - **Cada subagente genera su TSV** en `batch/tracker-additions/`.
   - Error en una URL → marcar `- [!]` con nota y continuar con las demás del bucket.
5. **SPAs y otras (contexto principal)**: extraer JD con Chrome MCP → A-G + PDF (si score ≥ 3.0) + TSV.
6. **Al terminar**: `node merge-tracker.mjs`, mover completadas a "Procesadas" (orden descendente al principio), mostrar tabla resumen:
7. **Sin procesar**: mostrar al final como lista plana — sin reservar números, sin procesar:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [ ] local:jds/indeed-*.md | Company | Role
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Extracción de JD

| Fuente | Método |
|--------|--------|
| LinkedIn / Tecnoempleo / InfoJobs | `extract-jd.mjs` |
| Estáticas / genéricas | Subagente directo — WebFetch |
| `local:jds/...` | Lectura directa del `.md` |
| SPA | Playwright / Chrome MCP |
| PDF | URL points to a PDF, read it directly with the Read tool |

Batch: `node extract-jd.mjs "{URL1}" "{URL2}" --delay-ms 2500`. Returns JSON to stdout
IF LinkedIn error → verify `node scan-linkedin.mjs --setup`. IF Tecnoempleo error `Cloudflare challenge` → retry later. ELSE mark as `[!]` and continue.

## Automatic numbering

   ```bash
   NEXT=$(node next-report.mjs)
   ```

## Source synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.
