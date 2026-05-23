#!/usr/bin/env node

/**
 * next-report.mjs
 *
 * Calcula el siguiente número de reporte disponible leyendo:
 * 1. El directorio reports/ (prefijo en nombre de archivo)
 * 2. data/applications.md (columna # de la tabla)
 * 3. data/pipeline.md (prefijo #ID)
 * 4. batch/batch-state.tsv (columna report_num)
 *
 * Elige el máximo entre los tres y suma 1.
 *
 * Output: número entero (stdout)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getNextAvailableNumber() {
  const foundIds = new Set();

  // 1. Escanear directorio reports/
  const reportsDir = path.join(__dirname, 'reports');
  if (fs.existsSync(reportsDir)) {
    try {
      const files = fs.readdirSync(reportsDir);
      for (const f of files) {
        const match = f.match(/^(\d+)/);
        if (match) foundIds.add(parseInt(match[1], 10));
      }
    } catch (e) { /* Silencioso */ }
  }

  // 2. Escanear data/applications.md
  const appsFile = path.join(__dirname, 'data', 'applications.md');
  if (fs.existsSync(appsFile)) {
    try {
      const content = fs.readFileSync(appsFile, 'utf8');
      // Busca números entre pipes: | 335 |
      const matches = content.matchAll(/\|\s*(\d+)\s*\|/g);
      for (const match of matches) {
        foundIds.add(parseInt(match[1], 10));
      }
    } catch (e) { /* Silencioso */ }
  }

  // 3. Escanear data/pipeline.md
  const pipelineFile = path.join(__dirname, 'data', 'pipeline.md');
  if (fs.existsSync(pipelineFile)) {
    try {
      const content = fs.readFileSync(pipelineFile, 'utf8');
      // Busca números con prefijo hash: #335
      const matches = content.matchAll(/#(\d+)\b/g);
      for (const match of matches) {
        foundIds.add(parseInt(match[1], 10));
      }
    } catch (e) { /* Silencioso */ }
  }

  // 4. Escanear batch/batch-state.tsv (columna report_num, índice 5)
  const batchStateFile = path.join(__dirname, 'batch', 'batch-state.tsv');
  if (fs.existsSync(batchStateFile)) {
    try {
      const lines = fs.readFileSync(batchStateFile, 'utf8').split('\n');
      for (const line of lines.slice(1)) { // saltar cabecera
        const cols = line.split('\t');
        const reportNum = cols[5]?.trim();
        if (reportNum && reportNum !== '-' && /^\d+$/.test(reportNum)) {
          foundIds.add(parseInt(reportNum, 10));
        }
      }
    } catch (e) { /* Silencioso */ }
  }

  if (foundIds.size === 0) return 1;
  return Math.max(...foundIds) + 1;
}

try {
  console.log(getNextAvailableNumber());
} catch (err) {
  // Fallback absoluto
  console.log(1);
}
