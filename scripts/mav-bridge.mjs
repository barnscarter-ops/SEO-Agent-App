#!/usr/bin/env node
/**
 * mav-bridge.mjs
 * Local bridge service — polls Supabase for approved items and executes them.
 * Run via PM2. Survives reboots and restarts automatically.
 *
 * Responsibilities:
 *   - Picks up approved facebook/gbp posts and runs posting scripts
 *   - Picks up approved website tasks and runs the relevant agents
 *   - Writes execution results back to Supabase
 *   - Logs everything to run_logs table
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import xlsx from 'xlsx';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.MAV_BRIDGE_POLL_MS || '30000');
const BRIDGE_PORT = parseInt(process.env.MAV_BRIDGE_PORT || '8790');
const SEO_AGENTS_EXE = process.env.SEO_AGENTS_EXE
  || 'C:\\Users\\carte\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\seo-agents.exe';
const PENDING_PROMPT_FILE = path.join(PROJECT_ROOT, 'outputs', 'pending_prompt.json');
const GBP_POSTER_PATH = 'C:\\Users\\carte\\.claude\\skills\\gbp-poster\\driver.mjs';
const GBP_WORKBOOK_PATH = process.env.GBP_WORKBOOK_PATH || '';
const GBP_ARCHIVE_FOLDER = process.env.GBP_ARCHIVE_FOLDER || 'M:\\backups\\gbp-archive';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[mav-bridge] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────

async function log(runId, phase, level, message) {
  const line = `[mav-bridge][${phase}][${level}] ${message}`;
  console.log(line);
  if (runId) {
    await supabase.from('run_logs').insert({ run_id: runId, phase, level, message });
  }
}

// ─────────────────────────────────────────────
// Run a phase and capture output
// ─────────────────────────────────────────────

async function runPhase(runId, phase, exe, args, cwd) {
  await log(runId, phase, 'info', `Starting: ${exe} ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      cwd: cwd || PROJECT_ROOT,
      timeout: 15 * 60 * 1000,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (stderr) await log(runId, phase, 'info', stderr.slice(0, 2000));
    await log(runId, phase, 'info', `Done: ${stdout.slice(0, 500)}`);
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (e) {
    const stdout = e.stdout || '';
    const stderr = e.stderr || '';
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    const detail = [e.message, stderr, stdout].filter(Boolean).join('\n').slice(0, 1500);
    await log(runId, phase, 'error', detail);
    return { ok: false, stdout, stderr, exitCode, error: detail };
  }
}
