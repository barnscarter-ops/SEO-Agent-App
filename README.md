# Grizzly SEO Agents

CrewAI is installed in `.venv` and this repo is wired for the Grizzly Electrical Solutions local SEO agent crew.

Imported agents:

- Grizzly Local Presence Agent-Manager
- Grizzly Content and Keyword Agent
- Grizzly Website SEO Agent
- GBP and Local Rankings Agent
- Reviews and Reputation Agent

Imported baseline reports live in `knowledge/baselines/`. Agent prompt files live in `prompts/agents/`.

## Current Role

This repo is the SEO workflow engine behind MCC. It produces research reports, execution queues, owner-approval actions, GBP post schedules, and machine-readable workflow status for the mav-console dashboard.

Primary outputs live in `outputs/`:

- `workflow_status.json` - parsed workflow state for MCC.
- `action_queue.json` - approval/action queue for MCC.
- `action_approvals.json` - owner/MCC approval records.
- `action_runs/` - dry-run and live execution records.
- `gbp_posting_schedule.md` - weekly GBP content schedule.

## Setup

```powershell
.\.venv\Scripts\Activate.ps1
pip install -e .
Copy-Item .env.example .env
```

Add your `OPENAI_API_KEY` to `.env`. Add `SERPER_API_KEY` if you want live Google-style search through Serper.

## Run

Validate the crew without calling an LLM:

```powershell
seo-agents "electrical troubleshooting service page" --dry-run
```

Run the Grizzly local presence crew:

```powershell
seo-agents "electrical troubleshooting service page" --site-url "https://www.grizzlyelectricaltx.com/" --region "DFW, Texas"
```

The crew writes the final manager plan to `outputs/grizzly_local_presence_plan.md`.

## Status And Actions

Generate or inspect the workflow state:

```powershell
$env:PYTHONPATH='src'
.\.venv\Scripts\python.exe -m seo_agents.main status
.\.venv\Scripts\python.exe -m seo_agents.main status --json
.\.venv\Scripts\python.exe -m seo_agents.main validate
```

Inspect and operate the action queue:

```powershell
$env:PYTHONPATH='src'
.\.venv\Scripts\python.exe -m seo_agents.main actions
.\.venv\Scripts\python.exe -m seo_agents.main actions --json
.\.venv\Scripts\python.exe -m seo_agents.main approve-action gbp-post-YYYY-MM-DD --by MCC --note "Approved in MCC"
.\.venv\Scripts\python.exe -m seo_agents.main run-action gbp-post-YYYY-MM-DD
.\.venv\Scripts\python.exe -m seo_agents.main run-action gbp-post-YYYY-MM-DD --live
```

Live actions require approval first. Dry-runs create run records without changing external systems.

## GBP Posting Adapter

GBP live posting currently uses the Playwright browser adapter at:

```text
C:\Users\carte\.claude\skills\gbp-poster\driver.mjs
```

It reads config from:

```text
C:\Users\carte\.codex\plugins\grizzly-gbp-poster\config.local.json
```

The active workbook and photos should stay under shared workspace paths, not OneDrive:

```text
C:\Workspace\Shared\Operations\Grizzly\GBP\Grizzly GBP Schedule.xlsx
C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos
```

One-time browser auth:

```powershell
cd C:\Users\carte\.claude\skills\gbp-poster
node .\driver.mjs --auth
```

The adapter refuses live-posting rows that are not `Approved` or are already marked `Posted`. Successful live runs mark the workbook row as `Posted`.
