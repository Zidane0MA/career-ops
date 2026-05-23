# InfoJobs Scan — Chrome MCP Reference

## Requisitos

- MCP `mcp__Claude_in_Chrome` o similar disponible
- `portals.yml → infojobs_searches.enabled: true`
- Sesión activa en InfoJobs en el browser (si redirige a login → detener, avisar al usuario)

## Procedimiento

Para cada URL en `portals.yml → infojobs_searches.searches`:

### 1. Scroll completo de la página

Ejecutar `browser_batch` con exactamente estas acciones (10 scrolls de 5 ticks — validado para cubrir ~20 ofertas):

```javascript
[
  {"name": "navigate", "input": {"url": "{search_url}", "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "wait", "duration": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "scroll", "coordinate": [784, 400], "scroll_direction": "down", "scroll_amount": 5, "tabId": {tabId}}},
  {"name": "computer", "input": {"action": "screenshot", "tabId": {tabId}, "save_to_disk": false}}
]
```

### 2. Extraer ofertas

Ejecutar con `mcp__Claude_in_Chrome__javascript_tool` o similar:

```javascript
const ofertas = [];
const cards = document.querySelectorAll('.ij-OfferCard');

cards.forEach((card) => {
  const titleElement = card.querySelector('h2.ij-OfferCardContent-description-title a');
  const titulo = titleElement?.textContent.trim();
  const url = titleElement?.href;
  const companyElement = card.querySelector('h3.ij-OfferCardContent-description-subtitle a');
  const empresa = companyElement?.textContent.trim();

  if (titulo && url && empresa) {
    ofertas.push({
      titulo,
      empresa,
      url: url.split('?')[0],
    });
  }
});

ofertas.slice(0, 23);
```

Devuelve `[{titulo, empresa, url}]`.

### 3. Dedup + pipeline

- **Dedup por URL limpia** (sin query params) — clave `infojobs::{path}` en `scan-history.tsv`
- Para cada URL nueva: añadir a pipeline → `- [ ] {url} | {empresa} | {titulo}`
- Registrar en `scan-history.tsv`: `infojobs::{path}\t{date}\tinfojobs-mcp\t{titulo}\t{empresa}\tadded`

## Restricciones

- No navegar a ofertas individuales
- No tomar capturas extras
- No extraer JD

Las URLs añadidas al pipeline serán clasificadas como **Tier B** en `modes/pipeline.md` y procesadas por el usuario en un chat separado con Chrome MCP activo.
