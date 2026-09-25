# Mode: clean (alias: free, space)

Libera espacio y tokens eliminando entradas obsoletas del pipeline de forma segura.

**Activación:** `/career-ops clean [ID1 ID2 ...]`

---

## Routing de entrada

- **Sin IDs** → modo interactivo: escanear y presentar candidatos con acción propuesta
- **Con IDs** → ejecutar directamente acción `eliminar todo` sobre esos IDs

---

## Modo interactivo (sin IDs)

### Candidatos a `eliminar todo` (borrar de pipeline + applications + reporte + JD)
- Duplicados exactos (misma empresa+rol) — conservar el más reciente
- Entradas con score < 2.0 en estado `SKIP` o `Discarded` sin notas de aprendizaje relevantes en el reporte
- Reportes marcados como `suspicious` o `fake` en el campo Legitimacy del header

### Candidatos a `limpiar archivos` (borrar reporte + JD, conservar fila en applications.md)
- Entradas con score 2.0–3.4 en estado `SKIP` o `Discarded` — tienen señal útil sobre qué evitar
- Cualquier entrada con score < 2.0 que tenga notas relevantes en el reporte (red flags aprendidas)

> `limpiar archivos` elimina los archivos pesados (reporte `.md` y JD local) para liberar espacio,
> pero la fila en `applications.md` permanece intacta como registro de feedback.
> Actualizar el campo PDF a ❌ si el reporte se elimina.

### Cómo escanear

1. Leer `data/applications.md` completo
2. Para cada entrada `SKIP` o `Discarded`, determinar la acción propuesta según score y notas
3. Para duplicados: comparar empresa+rol y marcar el más antiguo para `eliminar todo`
4. Para `suspicious`/`fake`: buscar `**Legitimacy:** suspicious` o `**Legitimacy:** fake` en los reportes correspondientes

### Presentación

Mostrar tabla con los candidatos encontrados:

```
| ID  | Empresa | Rol    | Score | Estado    | Reporte | JD  | Acción propuesta  |
|-----|---------|--------|-------|-----------|---------|-----|-------------------|
| 231 | Acme    | SRE    | 1.4   | SKIP      | ✅      | ✅  | eliminar todo     |
| 104 | Globex  | DevOps | 2.8   | Discarded | ✅      | ❌  | limpiar archivos  |
```

Si no hay candidatos: `No hay entradas candidatas a limpieza.`

### Confirmación

Preguntar:
```
¿Confirmar acciones propuestas? (enter = sí, o ajusta: "delete 104", "clean 231", "skip 231")
```

Aceptar ajustes individuales antes de ejecutar:
- `delete {ID}` → forzar acción `eliminar todo` para ese ID
- `clean {ID}` → forzar acción `limpiar archivos` para ese ID
- `skip {ID}` → excluir ese ID de la limpieza

---

## Modo directo (con IDs)

Ejecutar acción `eliminar todo` sobre cada ID proporcionado, siguiendo los pasos de abajo.

---

## Pasos de procesamiento por ID

### Paso 1: Verificar existencia

Leer `data/applications.md`, `data/pipeline.md` y listar `reports/` para confirmar que el ID existe.
Si no existe en ninguno de los tres, reportar y saltar.

### Paso 2: Bloqueo de seguridad

Si el estado en `applications.md` es `Applied`, `Interview`, `Offer` o `Responded`:
- Mostrar advertencia: `⚠️  ID {N} está en estado {estado}. ¿Confirmar eliminación? (escribe: "yes, delete {N}")`
- NO continuar hasta recibir confirmación explícita.

### Paso 3: Comprobar estado en scan-history.tsv

Obtener el campo URL de la entrada desde `data/pipeline.md` (línea que contiene el ID).

Si no hay URL o está marcada como `-`, omitir este paso para ese ID.

**Si la URL es local** (`local:jds/{slug}.md`):
- Usar `local:jds/{slug}.md` como clave de dedup (igual que hace el scanner)
- Comprobar si ya existe: comando de búsqueda sobre `data/scan-history.tsv`
- **Solo si no existe**, añadir al inicio:
  ```
  local:jds/{slug}.md\t{YYYY-MM-DD}\t{portal}\t{role}\t{company}
  ```

**Si la URL es remota** (`https://...`):
- Usar la URL directamente como clave
- Comprobar si ya existe: Usa comando de búsqueda sobre `data/scan-history.tsv`
- **Solo si no existe**, añadir al inicio:
  ```
  {url}\t{YYYY-MM-DD}\t{portal}\t{role}\t{company}
  ```

**Inferir `portal`** desde el slug o URL:
- Empieza por `indeed-` → `indeed-mcp`
- Empieza por `linkedin-` → `linkedin`
- Empieza por `greenhouse-` → `greenhouse`
- Empieza por `ashby-` → `ashby`
- Empieza por `lever-` → `lever`
- No se puede inferir → `clean`

### Paso 4a: Eliminar todo

1. Borrar la línea del ID en `data/pipeline.md`
2. Borrar la fila del ID en `data/applications.md`
3. Borrar `reports/{NNN}-*.md` si existe (buscar por prefijo numérico)
4. Borrar el JD local `jds/...` si está referenciado en pipeline o en el reporte

### Paso 4b: Limpiar archivos

1. Borrar la línea del ID en `data/pipeline.md`
2. **NO tocar** la fila en `data/applications.md` — se conserva como feedback
3. Actualizar el campo PDF de esa fila a ❌
4. Borrar `reports/{NNN}-*.md` si existe
5. Borrar el JD local `jds/...` si está referenciado

### Paso 5: Verificación post-clean obligatoria

Después de procesar todos los IDs, comprobar explícitamente las postcondiciones antes de dar el trabajo por terminado.

Para cada ID procesado con acción `eliminar todo`:
- No debe existir una fila `| {ID} |` en `data/applications.md`
- No debe existir una línea `# {ID}` o `#{ID}` en `data/pipeline.md`
- No debe existir ningún archivo `reports/{NNN}-*.md`
- No debe existir ningún JD local referenciado por pipeline o reporte, salvo que otro ID activo lo referencie

Para cada ID procesado con acción `limpiar archivos`:
- Debe conservarse la fila `| {ID} |` en `data/applications.md`
- La columna PDF de esa fila debe quedar en `❌`
- No debe existir una línea `# {ID}` o `#{ID}` en `data/pipeline.md`
- No debe existir ningún archivo `reports/{NNN}-*.md`

Ejecutar también `node verify-pipeline.mjs`.

Si cualquier postcondición falla:
1. Reportar `Clean verification failed` con la lista exacta de IDs y referencias restantes
2. Corregir los restos encontrados
3. Repetir la verificación
4. Solo mostrar el resumen final cuando todas las postcondiciones pasen

---

## Output final

```
=== Clean Summary ===
Eliminados:         {N} entradas (borrado completo)
Archivos limpiados: {M} entradas (fila conservada en applications.md como feedback)
Espacio liberado:   ~{X} KB en reportes + {Y} KB en JDs
```

Si no se procesó nada: `No se realizaron cambios.`
