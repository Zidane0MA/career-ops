# Setup Guide

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and configured
- Node.js 18+ (for PDF generation and utility scripts)
- (Optional) Go 1.21+ (for the dashboard TUI)

## Quick Start (5 steps)

### 1. Clone and install

```bash
git clone https://github.com/santifer/career-ops.git
cd career-ops
npm install
npx playwright install chromium   # Required for PDF generation
```

### 2. Configure your profile

```bash
cp config/profile.example.yml config/profile.yml
```

Edit `config/profile.yml` with your personal details: name, email, target roles, narrative, proof points.

### 3. Add your CV

Create `cv.md` in the project root with your full CV in markdown format. This is the source of truth for all evaluations and PDFs.

(Optional) Create `article-digest.md` with proof points from your portfolio projects/articles.

### 4. Configure portals

```bash
cp templates/portals.example.yml portals.yml
```

Edit `portals.yml`:
- Update `title_filter.positive` with keywords matching your target roles
- Add companies you want to track in `tracked_companies`
- Customize `search_queries` for your preferred job boards

For optional scanners (LinkedIn, Indeed, Tecnoempleo, InfoJobs) see the dedicated sections below.

### 5. Start using

Open Claude Code in this directory:

```bash
claude
```

Then paste a job offer URL or description. Career-ops will automatically evaluate it, generate a report, create a tailored PDF, and track it.

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-ops scan` |
| Process pending URLs | `/career-ops pipeline` |
| Generate a PDF | `/career-ops pdf` |
| Batch evaluate | `/career-ops batch` |
| Check tracker status | `/career-ops tracker` |
| Fill application form | `/career-ops apply` |

## Verify Setup

```bash
node cv-sync-check.mjs      # Check configuration
node verify-pipeline.mjs     # Check pipeline integrity
```

## Build Dashboard (Optional)

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..  # Opens TUI pipeline viewer
```

---

## Optional Scanners

Four extra scanners can be enabled by editing `portals.yml`. Each block in `portals.yml` is self-documenting — read the comments above the block for the full list of IDs, parameters, and examples.

### LinkedIn (global, opt-in)

Requires a one-time Chrome profile setup:

1. Pick a folder path for a **dedicated** Chrome profile (don't use your daily one).
2. Run `node scan-linkedin.mjs --setup` → log into LinkedIn in the window that opens, then close it.
3. Fill `chrome_profile`, `geo_id` and `searches` in the `linkedin_searches` block.
4. Set `enabled: true`.

### Indeed (global, opt-in)

Requires the official Indeed MCP connected to your AI CLI.

**Install the MCP:**
- **Claude Code:** open the `/connectors` menu (or Customize → Connectors), search for "Indeed", and click Install.
- **Other CLIs (Codex, Gemini, OpenCode, Qwen, Copilot, Kimi):** ask the agent to websearch "indeed mcp install" and follow the official instructions for your environment.

Once the MCP is connected, fill `location`, `country_code` and `searches` in the `indeed_queries` block of `portals.yml`, then set `enabled: true`.

### Tecnoempleo (Spain only, opt-in)

Pick your region IDs and specialty IDs from the comments in `portals.yml`, fill the `tecnoempleo.searches` block, set `enabled: true`, and run `node scan-tecnoempleo.mjs`.

### Infojobs (Spain only, opt-in)

Uses Chrome MCP (no dedicated script). Run a search on infojobs.net with your filters, copy the full URL, paste it into `infojobs_searches.searches`, and set `enabled: true`.

**Tip:** include `sinceDate=_7_DAYS` in the URL to avoid stale listings.
