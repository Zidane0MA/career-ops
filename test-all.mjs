#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const QUICK = process.argv.includes('--quick');

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }
function hashFile(path) { return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'); }

// Run a script and return its exit code (null if it never ran). Needed because
// run() collapses every failure to null, which hides the exit code.
function runExit(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : null;
  }
}

// Fingerprint the user's real data BEFORE anything runs. Section 2 executes the
// pipeline scripts for real, and section 12 asserts they changed nothing.
const USER_DATA = ['data/applications.md', 'data/pipeline.md', 'data/scan-history.tsv'];
const userDataBefore = new Map();
for (const f of USER_DATA) if (fileExists(f)) userDataBefore.set(f, hashFile(f));

// A .bak is a mutating script's own pre-write backup. One appearing during the
// run is proof the suite wrote to real data; pre-existing ones aren't ours.
const BAK_FILES = ['data/applications.md.bak', 'applications.md.bak'];
const baksBefore = new Set(BAK_FILES.filter(fileExists));

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run('node', ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

// normalize-statuses, dedup-tracker and merge-tracker rewrite applications.md
// in place. Without --dry-run this "test" performed a real dedup against the
// user's tracker and silently pruned rows. Every write in all three is guarded
// by their DRY_RUN flag, so the flag makes the suite read-only; section 12
// enforces that. Add --dry-run to any future script that writes.
const scripts = [
  // 0 when a cv.md is present, 1 without one (normal in a bare checkout).
  { name: 'cv-sync-check.mjs', okExits: [0, 1] },
  { name: 'verify-pipeline.mjs', okExits: [0] },
  { name: 'normalize-statuses.mjs', args: ['--dry-run'], okExits: [0] },
  { name: 'dedup-tracker.mjs', args: ['--dry-run'], okExits: [0] },
  { name: 'merge-tracker.mjs', args: ['--dry-run'], okExits: [0] },
  { name: 'update-system.mjs', args: ['check'], okExits: [0] },
];

for (const { name, args = [], okExits } of scripts) {
  const label = [name, ...args].join(' ');
  const code = runExit('node', [name, ...args]);
  if (code === null) {
    fail(`${label} never ran (spawn error or timeout)`);
  } else if (okExits.includes(code)) {
    pass(`${label} exits ${code}`);
  } else {
    fail(`${label} exited ${code}, expected ${okExits.join(' or ')}`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const goBuild = run('cd dashboard && go build -o /tmp/career-dashboard-test . 2>&1');
  if (goBuild !== null) {
    pass('Dashboard compiles');
  } else {
    fail('Dashboard build failed');
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md', 'README.cn.md', 'README.zh-TW.md',
  'TRADEMARK.md', 'CHANGELOG.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'AGENTS.md', 'go.mod', 'test-all.mjs',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Plugin manifests
  '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
  'dashboard/internal/ui/screens/progress.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `*.${e}`);

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run('git', [
    'grep', '-n', pattern, '--', ...grepPathspec
  ]);
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
// Same git grep approach: only scans tracked files.
const absPathResult = run('git', [
  'grep', '-n', '/Users/', '--', '*.mjs', '*.sh', '*.md', '*.go', '*.yml'
]);

if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  const ignoredFiles = ['README.md', 'LICENSE', 'CLAUDE.md', 'test-all.mjs'];
  const filteredLines = absPathResult.split('\n').filter(line => {
    if (!line) return false;
    const file = line.split(':')[0];
    return !ignoredFiles.some(ignored => file.includes(ignored));
  });

  if (filteredLines.length === 0) {
    pass('No absolute paths in code files');
  } else {
    for (const line of filteredLines) {
      fail(`Absolute path: ${line.slice(0, 100)}`);
    }
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. AGENTS.md INTEGRITY ──────────────────────────────────────

console.log('\n9. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 10. VERSION FILE ─────────────────────────────────────────────

console.log('\n10. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 11. REPORT LINK PATHS ────────────────────────────────────────

console.log('\n11. Report link paths');

// The tracker lives in data/, so its report links resolve from data/. A bare
// `reports/...` prefix silently points at data/reports/ and makes
// verify-pipeline report "Report not found" for a report that exists.

// Spec guard — runs in CI, where the tracker itself is gitignored and absent.
const specFiles = ['AGENTS.md', 'modes/ru/oferta.md'];
let badSpecs = 0;
for (const f of specFiles) {
  if (!fileExists(f)) continue;
  if (/\]\((?:\.\/)?reports\//.test(readFile(f))) {
    fail(`${f}: report link spec uses bare "reports/" (should be "../reports/")`);
    badSpecs++;
  }
}
if (badSpecs === 0) pass('Docs spec report links as ../reports/');

// Data guard — every link in the tracker must resolve from the tracker's dir.
const APPS = 'data/applications.md';
if (!fileExists(APPS)) {
  pass('No tracker yet — report link resolution not applicable');
} else {
  const appsDir = dirname(join(ROOT, APPS));
  let brokenLinks = 0;
  let checkedLinks = 0;
  for (const line of readFile(APPS).split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 9) continue;
    const num = parseInt(parts[1]);
    if (isNaN(num)) continue;
    const link = parts[8].match(/\]\(([^)]+)\)/);
    if (!link) continue;
    checkedLinks++;
    if (!existsSync(join(appsDir, link[1]))) {
      fail(`#${num}: report link does not resolve from ${APPS}: ${link[1]}`);
      brokenLinks++;
    }
  }
  if (brokenLinks === 0) pass(`All ${checkedLinks} report links resolve from ${APPS}`);
}

// ── 12. USER DATA IMMUTABILITY ──────────────────────────────────

console.log('\n12. User data immutability');

// Regression guard for a real data-loss bug: section 2 ran the pipeline scripts
// without --dry-run, so `node test-all.mjs` — the command AGENTS.md tells
// contributors to run before pushing — silently deleted 23 rows from a live
// 440-row tracker. Running the tests must never change the user's data.
if (userDataBefore.size === 0) {
  pass('No user data present — nothing the suite could mutate');
} else {
  let mutated = 0;
  for (const [f, before] of userDataBefore) {
    if (!fileExists(f)) {
      fail(`Suite DELETED ${f}`);
      mutated++;
    } else if (hashFile(f) !== before) {
      fail(`Suite MUTATED ${f} — a pipeline script in section 2 is missing --dry-run`);
      mutated++;
    }
  }
  if (mutated === 0) pass(`Suite left ${userDataBefore.size} user data file(s) byte-identical`);
}

let newBaks = 0;
for (const f of BAK_FILES) {
  if (fileExists(f) && !baksBefore.has(f)) {
    fail(`Suite created ${f} — a pipeline script wrote to real data`);
    newBaks++;
  }
}
if (newBaks === 0) pass('Suite left no .bak artifacts behind');

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
