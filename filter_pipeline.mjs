
import fs from 'fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';

if (!fs.existsSync(PORTALS_PATH) || !fs.existsSync(PIPELINE_PATH)) {
  console.error('Files not found');
  process.exit(1);
}

const config = yaml.load(fs.readFileSync(PORTALS_PATH, 'utf-8'));
const titleFilter = config.title_filter;

const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

function getRejectReason(title) {
  const lower = title.toLowerCase();
  const matched = negative.find(k => lower.includes(k));
  return matched || 'unknown';
}

function passFilter(title) {
  const lower = title.toLowerCase();
  const ok = positive.length === 0 || positive.some(k => lower.includes(k));
  const bad = negative.some(k => lower.includes(k));
  return ok && !bad;
}

let pipelineContent = fs.readFileSync(PIPELINE_PATH, 'utf-8');
const lines = pipelineContent.split('\n');

const newLines = [];
let removedCount = 0;
const removedByReason = {}; // tracks { reason: [titles] }
let inPendientes = false;

for (const line of lines) {
  if (line.startsWith('## Pendientes')) {
    inPendientes = true;
    newLines.push(line);
    continue;
  }
  if (line.startsWith('## Procesadas')) {
    inPendientes = false;
    newLines.push(line);
    continue;
  }

  if (inPendientes && line.startsWith('- [ ] ')) {
    const parts = line.split('|');
    if (parts.length >= 3) {
      const title = parts[2].trim();
      if (passFilter(title)) {
        newLines.push(line);
      } else {
        removedCount++;
        const reason = getRejectReason(title);
        if (!removedByReason[reason]) {
          removedByReason[reason] = [];
        }
        removedByReason[reason].push(title);
      }
    } else {
       newLines.push(line);
    }
  } else {
    newLines.push(line);
  }
}

fs.writeFileSync(PIPELINE_PATH, newLines.join('\n'), 'utf-8');

// Print feedback
console.log(`\n✓ Cleaned pipeline. Removed ${removedCount} entries.\n`);
if (removedCount > 0) {
  console.log('Breakdown by rejection reason:');
  for (const [reason, titles] of Object.entries(removedByReason).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  "${reason}" (${titles.length} entries)`);
    titles.forEach(t => console.log(`    • ${t}`));
  }
}
