#!/usr/bin/env node
/**
 * seo-monitor.mjs
 * Monitors the weekly SEO agent run end-to-end:
 *   - Watches seo_runs and weekly_posts in Supabase for state transitions
 *   - Monitors mav-bridge and mav-console PM2 process health
 *   - Auto-restarts dead PM2 processes and reconnects the M: drive
 *   - Sends email alerts on failures, with auto-fix results attached
 *   - Logs everything to outputs/monitor-YYYY-MM-DD.jsonl
 *
 * Runs for RUN_DURATION_HOURS (default 14) then exits gracefully.
 * Scheduled alongside the SEO run via Windows Task Scheduler.
 *
 * Usage: node scripts/seo-monitor.mjs [--run-hours 14]
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { execSync, execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL        || '';
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY|| '';
const SMTP_APP_PASSWORD   = process.env.SMTP_APP_PASSWORD   || '';
const SMTP_FROM           = process.env.SMTP_FROM           || 'barnscarter@gmail.com';
const SMTP_TO             = process.env.SMTP_TO             || 'barnscarter@gmail.com';
const MAV_BRIDGE_PORT     = parseInt(process.env.MAV_BRIDGE_PORT || '8790', 10);
const MCC_PORT            = parseInt(process.env.MCC_PORT || '3000', 10);
const POLL_MS             = 30_000;
const GBP_ARCHIVE_FOLDER  = process.env.GBP_ARCHIVE_FOLDER || 'M:\\backups\\gbp-archive';

// Expected weekly run: Task Scheduler launches run-weekly-seo.py at 8:30 local.
// If the wrapper hasn't written its "started" marker by NO_SHOW_DEADLINE (local
// HH:mm) on the expected day-of-week, the run never fired — alert once so a
// no-show is never silent. Defaults: Friday (5), 09:00 local.
const NO_SHOW_DEADLINE_HHMM = process.env.SEO_NO_SHOW_DEADLINE || '09:00';
const EXPECTED_RUN_DOW      = parseInt(process.env.SEO_RUN_DOW ?? '5', 10); // 0=Sun … 5=Fri
const RUNNER_HEALTH_FILE    = path.join(PROJECT_ROOT, 'outputs', 'weekly-runner-health.json');

// Parse --run-hours arg
let RUN_DURATION_HOURS = 14;
const runHoursArg = process.argv.indexOf('--run-hours');
if (runHoursArg !== -1) RUN_DURATION_HOURS = parseInt(process.argv[runHoursArg + 1] || '14', 10);
const RUN_DURATION_MS = RUN_DURATION_HOURS * 60 * 60 * 1000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[seo-monitor] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

// ── Log file ─────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const logDir = path.join(PROJECT_ROOT, 'outputs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `monitor-${today}.jsonl`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(level, message, data = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  const line = JSON.stringify(entry);
  logStream.write(line + '\n');
  const icon = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : level === 'fix' ? '🔧' : '🟢';
  console.log(`${icon} [seo-monitor] ${entry.ts.slice(11, 19)} ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

// ── State ─────────────────────────────────────────────────────────────────────
const alertedErrors = new Set();          // dedup alerts
const processFailCounts = {};             // pm2 process → consecutive down counts
let lastKnownRunStatus = null;
let lastKnownRunId = null;
let bridgeDownCount = 0;
let dashboardDownCount = 0;
let startTime = Date.now();
let resurrectAttempted = false;           // only try `pm2 resurrect` once per monitor run

// ── Supabase helpers ──────────────────────────────────────────────────────────
function sbFetch(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);
    const opts = {
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
    };
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(url, opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getLatestRun() {
  const res = await sbFetch('seo_runs?select=*&order=created_at.desc&limit=1');
  return Array.isArray(res.data) ? res.data[0] : null;
}

async function getPostsForRun(runId) {
  const res = await sbFetch(`weekly_posts?run_id=eq.${runId}&select=*`);
  return Array.isArray(res.data) ? res.data : [];
}

// ── HTTP health checks ────────────────────────────────────────────────────────
function httpGet(port, path, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { req.destroy(); resolve(null); }, timeout);
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// ── PM2 helpers ───────────────────────────────────────────────────────────────
function pm2List() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function pm2Restart(name) {
  try {
    execSync(`pm2 restart "${name}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return true;
  } catch (e) {
    log('error', `pm2 restart failed for ${name}`, { error: e.message });
    return false;
  }
}

// Cold-boot recovery: `pm2 restart` only works on processes the daemon already
// knows about. After a reboot where PM2 never resurrected (the common Windows
// case), the process list is empty and restart is useless — we must reload the
// saved dump with `pm2 resurrect`. Tried at most once per monitor run.
function pm2Resurrect() {
  try {
    execSync('pm2 resurrect', { encoding: 'utf8', timeout: 30000, windowsHide: true });
    return true;
  } catch (e) {
    log('error', 'pm2 resurrect failed', { error: e.message });
    return false;
  }
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
function isMDriveMounted() {
  try {
    const out = execSync('net use M:', { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return out.includes('\\\\') || out.includes('OK') || out.includes('Open');
  } catch {
    return false;
  }
}

function mountMDrive() {
  try {
    execSync('net use M: \\\\192.168.1.12\\Proxmox /persistent:yes', { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return true;
  } catch (e) {
    log('error', 'Failed to remount M: drive', { error: e.message });
    return false;
  }
}

// ── Email alert ───────────────────────────────────────────────────────────────
let _mailerTransport = null;
async function getMailer() {
  if (_mailerTransport) return _mailerTransport;
  try {
    const { createTransport } = await import('nodemailer');
    _mailerTransport = createTransport({
      service: 'gmail',
      auth: { user: SMTP_FROM, pass: SMTP_APP_PASSWORD },
    });
    return _mailerTransport;
  } catch (e) {
    log('warn', 'nodemailer unavailable — emails disabled', { error: e.message });
    return null;
  }
}

async function sendAlert(subject, body) {
  if (!SMTP_APP_PASSWORD) {
    log('warn', 'SMTP_APP_PASSWORD not set — cannot send email alert', { subject });
    return;
  }
  const transport = await getMailer();
  if (!transport) return;
  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: SMTP_TO,
      subject: `[SEO Monitor] ${subject}`,
      text: body,
    });
    log('info', 'Alert email sent', { subject });
  } catch (e) {
    log('warn', 'Alert email failed to send', { subject, error: e.message });
  }
}

async function alertOnce(key, subject, body) {
  if (alertedErrors.has(key)) return;
  alertedErrors.add(key);
  log('error', subject, { alert_key: key });
  await sendAlert(subject, body);
}

// ── Auto-fix routines ─────────────────────────────────────────────────────────
async function fixDeadProcess(name) {
  log('fix', `Auto-restarting dead PM2 process: ${name}`);
  const ok = pm2Restart(name);
  if (ok) {
    log('fix', `${name} restarted successfully`);
    await sendAlert(`Auto-fixed: ${name} restarted`, `The PM2 process "${name}" was found stopped and was automatically restarted.\n\nMonitor: ${logFile}`);
    return true;
  }
  await alertOnce(`pm2-restart-failed-${name}`, `FAILED to restart ${name}`, `PM2 process "${name}" is down and could not be restarted automatically.\n\nPlease check: pm2 logs ${name}\nLog file: ${logFile}`);
  return false;
}

async function fixMDrive() {
  log('fix', 'Attempting to remount M: drive...');
  const ok = mountMDrive();
  if (ok) {
    log('fix', 'M: drive remounted successfully');
    await sendAlert('Auto-fixed: M: drive remounted', `The M: drive (\\\\192.168.1.12\\Proxmox) was disconnected and has been remounted.\n\nGBP photo archiving should resume normally.`);
  }
  return ok;
}

// ── Monitor checks ─────────────────────────────────────────────────────────────

async function checkMavBridge() {
  const result = await httpGet(MAV_BRIDGE_PORT, '/health');
  if (!result || result.status !== 200) {
    bridgeDownCount++;
    // 3 failures = ~90s window before alerting — avoids false positives on brief PM2 restarts
    if (bridgeDownCount >= 3) {
      log('error', `mav-bridge unreachable (${bridgeDownCount} consecutive failures)`);
      const procs = pm2List();
      const bridge = procs.find(p => p.name === 'mav-bridge');
      if (bridge && bridge.pm2_env.status !== 'online') {
        await fixDeadProcess('mav-bridge');
      } else {
        await alertOnce('mav-bridge-down', 'mav-bridge is not responding', `The mav-bridge HTTP health check has failed ${bridgeDownCount} times (~${bridgeDownCount * 30}s).\n\nBridge status in PM2: ${bridge?.pm2_env?.status || 'unknown'}\nCheck logs: pm2 logs mav-bridge\nLog file: ${logFile}`);
      }
    }
  } else {
    if (bridgeDownCount > 0) {
      log('info', 'mav-bridge recovered', { was_down_count: bridgeDownCount });
      // Clear so we can re-alert if it goes down again mid-run
      alertedErrors.delete('mav-bridge-down');
    }
    bridgeDownCount = 0;
  }
  return !result ? false : result.status === 200;
}

async function checkMCCDashboard() {
  const result = await httpGet(MCC_PORT, '/health');
  if (!result || result.status !== 200) {
    dashboardDownCount++;
    if (dashboardDownCount >= 2) {
      log('error', `MCC dashboard unreachable (${dashboardDownCount} consecutive failures)`);
      const procs = pm2List();
      const console_ = procs.find(p => p.name === 'mav-console');
      if (console_ && console_.pm2_env.status !== 'online') {
        await fixDeadProcess('mav-console');
      } else {
        await alertOnce('dashboard-down', 'MCC Dashboard is not responding', `The MCC dashboard health check (port ${MCC_PORT}) has failed ${dashboardDownCount} times.\n\nProcess status: ${console_?.pm2_env?.status || 'unknown'}\nCheck: pm2 logs mav-console\nLog file: ${logFile}`);
      }
    }
  } else {
    if (dashboardDownCount > 0) {
      log('info', 'MCC dashboard recovered', { was_down_count: dashboardDownCount });
      alertedErrors.delete('dashboard-down');
    }
    dashboardDownCount = 0;
  }
}

async function checkPM2Processes() {
  let procs = pm2List();
  const targets = ['mav-bridge', 'mav-console', 'prometheus-sync'];

  // Cold-boot recovery: if core processes are entirely ABSENT from the daemon
  // (not merely stopped), PM2 most likely never resurrected after a reboot — the
  // exact failure that takes MCC down on Friday. `pm2 restart` can't help here;
  // reload the saved dump once with `pm2 resurrect`, then re-read.
  const core = ['mav-bridge', 'mav-console'];
  const missingCore = core.filter(name => !procs.find(p => p.name === name));
  if (missingCore.length && !resurrectAttempted) {
    resurrectAttempted = true;
    log('fix', 'Core PM2 processes missing — attempting cold-boot recovery (pm2 resurrect)', { missing: missingCore });
    const ok = pm2Resurrect();
    procs = pm2List();
    const stillMissing = core.filter(name => !procs.find(p => p.name === name));
    if (ok && stillMissing.length === 0) {
      await sendAlert('Auto-fixed: pm2 resurrect restored processes',
        `Core processes (${missingCore.join(', ')}) were missing from PM2 — likely an un-resurrected reboot — and were restored via "pm2 resurrect".\n\nMonitor log: ${logFile}`);
    } else {
      await alertOnce('pm2-resurrect-failed',
        'FAILED: core PM2 processes missing and pm2 resurrect did not restore them',
        `Still missing after resurrect: ${stillMissing.join(', ') || '(resurrect reported an error)'}\n\n` +
        `This usually means PM2 has no saved dump (run "pm2 save" once after starting everything) or the PM2 daemon is not running.\n\n` +
        `Recover manually on CartersPC:\n  pm2 resurrect\n  # or, if there is no saved dump:\n  pm2 start C:\\Workspace\\Active\\MCC\\ecosystem.config.cjs\n  pm2 save\n\nMonitor log: ${logFile}`);
    }
  }

  for (const name of targets) {
    const proc = procs.find(p => p.name === name);
    if (!proc) { log('warn', `PM2 process not found: ${name}`); continue; }
    if (proc.pm2_env.status !== 'online') {
      processFailCounts[name] = (processFailCounts[name] || 0) + 1;
      log('warn', `PM2 process ${name} is ${proc.pm2_env.status} (restarts: ${proc.pm2_env.restart_time})`);
      if (processFailCounts[name] >= 1 && name !== 'prometheus-sync') {
        await fixDeadProcess(name);
      }
    } else {
      processFailCounts[name] = 0;
    }
  }
}

async function checkMDrive() {
  const archiveNeeded = fs.existsSync(GBP_ARCHIVE_FOLDER.split('\\')[0] + '\\');
  if (!isMDriveMounted()) {
    log('warn', 'M: drive not mounted — GBP photo archiving will fail');
    await fixMDrive();
  }
}

async function checkRunStatus() {
  let run;
  try {
    run = await getLatestRun();
  } catch (e) {
    log('warn', 'Could not query Supabase for latest run', { error: e.message });
    return;
  }

  if (!run) {
    log('info', 'No SEO runs found in Supabase yet');
    return;
  }

  // Only watch runs created today — skip stale runs from prior weeks
  const runDate = run.created_at ? run.created_at.slice(0, 10) : '';
  if (runDate !== today && run.status !== 'pending_approval') {
    log('info', `Latest run is from ${runDate} (status: ${run.status}) — waiting for today's run`);
    return;
  }

  // Track transitions
  if (run.id !== lastKnownRunId || run.status !== lastKnownRunStatus) {
    log('info', `Run status: ${lastKnownRunStatus || '(new)'} → ${run.status}`, {
      run_id: run.id,
      week_of: run.week_of,
      topic: run.topic,
    });
    lastKnownRunId = run.id;
    lastKnownRunStatus = run.status;
  }

  // Alert on error state
  if (run.status === 'error') {
    await alertOnce(`run-error-${run.id}`, `SEO Run FAILED (run_id: ${run.id})`,
      `The SEO agent run for week of ${run.week_of} has failed.\n\nError: ${run.error || '(see run_logs table)'}\nTopic: ${run.topic || 'unknown'}\nRun ID: ${run.id}\n\nCheck the MCC Dashboard or Supabase run_logs table for details.\nMonitor log: ${logFile}`
    );
  }

  // Alert if stuck in executing for >30 minutes
  if (run.status === 'executing' && run.approved_at) {
    const executingSince = Date.now() - new Date(run.approved_at).getTime();
    if (executingSince > 30 * 60 * 1000) {
      await alertOnce(`run-stuck-${run.id}`, `SEO Run may be stuck (executing for ${Math.round(executingSince / 60000)} min)`,
        `The SEO run for week of ${run.week_of} has been in "executing" state for over 30 minutes.\n\nApproved at: ${run.approved_at}\nRun ID: ${run.id}\n\nThis may indicate that mav-bridge froze. Try: pm2 restart mav-bridge\nMonitor log: ${logFile}`
      );
    }
  }

  // Only check posts if we have an active run
  if (['executing', 'done', 'error'].includes(run.status)) {
    await checkPostStatuses(run.id);
  }
}

async function checkPostStatuses(runId) {
  let posts;
  try {
    posts = await getPostsForRun(runId);
  } catch (e) {
    log('warn', 'Could not query weekly_posts', { error: e.message });
    return;
  }

  const byStatus = {};
  for (const p of posts) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }

  // Log summary only when interesting
  const errorPosts = posts.filter(p => p.status === 'error');
  const needsVerification = posts.filter(p => p.status === 'needs_verification');

  if (errorPosts.length > 0) {
    for (const p of errorPosts) {
      const key = `post-error-${p.id}`;
      if (!alertedErrors.has(key)) {
        alertedErrors.add(key);
        log('error', `Post failed: ${p.platform} Day ${p.day} (${p.post_date})`, {
          id: p.id, platform: p.platform, service: p.service, error: p.error,
        });
        sendAlert(
          `Post FAILED: ${p.platform} Day ${p.day} (${p.post_date})`,
          `A ${p.platform} post failed during the SEO run.\n\nPost ID: ${p.id}\nPlatform: ${p.platform}\nDay: ${p.day}\nDate: ${p.post_date}\nService: ${p.service}\nError: ${p.error || '(no error text)'}\n\nCheck the MCC Dashboard to retry manually.\nMonitor log: ${logFile}`
        );
      }
    }
  }

  if (needsVerification.length > 0) {
    for (const p of needsVerification) {
      const key = `post-verify-${p.id}`;
      if (!alertedErrors.has(key)) {
        alertedErrors.add(key);
        log('warn', `GBP post needs manual verification: Day ${p.day} (${p.post_date})`, { id: p.id });
        sendAlert(
          `GBP Post Needs Verification: Day ${p.day} (${p.post_date})`,
          `A GBP post was submitted but could not be verified automatically.\n\nPost ID: ${p.id}\nDate: ${p.post_date}\nService: ${p.service}\n\nPlease verify it appeared in Google Business Profile and mark it as posted in the dashboard.\nMonitor log: ${logFile}`
        );
      }
    }
  }

  log('info', `Posts: ${JSON.stringify(byStatus)}`);
}

// ── No-show detection ───────────────────────────────────────────────────────
function localHHMM(d) {
  // Monitor runs on CartersPC, so getHours() is already local (CST/CDT).
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Alarm if the weekly run never even started. Keys off the wrapper's start marker
// (weekly-runner-health.json), which run-weekly-seo.py writes the instant it
// launches — so this fires even before any Supabase row exists. Fills the gap
// where checkRunStatus() only ever alerts on runs that started and THEN failed.
async function checkRunStarted() {
  const now = new Date();
  if (now.getDay() !== EXPECTED_RUN_DOW) return;          // only on the scheduled day
  if (localHHMM(now) < NO_SHOW_DEADLINE_HHMM) return;     // give the run until the deadline

  let health = null;
  try { health = JSON.parse(fs.readFileSync(RUNNER_HEALTH_FILE, 'utf8')); } catch { /* missing/unreadable */ }

  const startedToday = health && health.date === today &&
    ['started', 'success', 'failed'].includes(health.status);

  if (health && health.date === today && health.status === 'failed') {
    await alertOnce(`runner-failed-${today}`,
      `SEO weekly runner FAILED at launch — ${today}`,
      `run-weekly-seo.py marked the run "failed" before/at crew launch.\n\nError: ${health.error || '(none)'}\nReturn code: ${health.returncode}\nRunner log: ${health.log_file || '(see outputs/)'}\n\nMonitor log: ${logFile}`);
    return;
  }

  if (!startedToday) {
    await alertOnce(`run-no-show-${today}`,
      `SEO weekly run DID NOT START (no-show) — ${today}`,
      `It is past ${NO_SHOW_DEADLINE_HHMM} local on the scheduled run day and run-weekly-seo.py never wrote a start marker (${RUNNER_HEALTH_FILE}).\n\n` +
      `That means the Windows Task Scheduler job never launched the wrapper. Most common causes after a reboot:\n` +
      `  • The task is set to "Run only when user is logged on" and no one logged in\n` +
      `  • "Run task as soon as possible after a scheduled start is missed" is unchecked\n` +
      `  • The machine was asleep and "Wake the computer to run this task" is unchecked\n\n` +
      `Check Task Scheduler → History (Last Run Result), then run scripts/setup-scheduled-tasks.ps1 to re-register with reboot-proof settings.\n\nMonitor log: ${logFile}`);
  }
}

// ── Main poll loop ─────────────────────────────────────────────────────────────
async function poll() {
  try {
    await Promise.all([
      checkMavBridge(),
      checkMCCDashboard(),
      checkPM2Processes(),
    ]);
    await checkMDrive();
    await checkRunStarted();
    await checkRunStatus();
  } catch (e) {
    log('error', 'Unhandled poll exception', { error: e.message, stack: e.stack?.slice(0, 500) });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  log('info', `SEO Monitor starting — will run for ${RUN_DURATION_HOURS} hours`, {
    log_file: logFile,
    poll_interval_sec: POLL_MS / 1000,
    mav_bridge_port: MAV_BRIDGE_PORT,
    mcc_port: MCC_PORT,
  });

  sendAlert(
    `SEO Monitor Started (${today})`,
    `The SEO Monitor is active for today's run.\n\nMonitor log: ${logFile}\nRun duration: ${RUN_DURATION_HOURS} hours\n\nYou will receive alerts if:\n- The SEO pipeline fails at any phase\n- Any post fails to publish\n- GBP posts need manual verification\n- mav-bridge or MCC dashboard goes offline\n\nAuto-fixes enabled: PM2 process restart, M: drive reconnect.`
  );

  // Initial check immediately
  await poll();

  // Schedule recurring polls
  const interval = setInterval(poll, POLL_MS);

  // Graceful shutdown after RUN_DURATION_MS
  setTimeout(async () => {
    clearInterval(interval);
    log('info', `Monitor shutting down after ${RUN_DURATION_HOURS}h`, {
      elapsed_min: Math.round((Date.now() - startTime) / 60000),
    });

    // Final run state check
    try {
      const run = await getLatestRun();
      if (run) {
        const posts = ['done', 'error'].includes(run.status) ? await getPostsForRun(run.id) : [];
        const summary = run ? {
          run_status: run.status,
          week_of: run.week_of,
          posted: posts.filter(p => p.status === 'posted').length,
          scheduled: posts.filter(p => p.status === 'scheduled').length,
          errored: posts.filter(p => p.status === 'error').length,
          needs_verification: posts.filter(p => p.status === 'needs_verification').length,
        } : {};
        log('info', 'Final run summary', summary);
        sendAlert(
          `SEO Monitor Done — ${run.status.toUpperCase()} (${today})`,
          `The SEO Monitor has completed its watch window.\n\nRun status: ${run.status}\nWeek of: ${run.week_of}\nPosts posted: ${summary.posted || 0}\nPosts scheduled: ${summary.scheduled || 0}\nPost errors: ${summary.errored || 0}\nNeeds verification: ${summary.needs_verification || 0}\n\nFull log: ${logFile}`
        );
      }
    } catch { /* best-effort */ }

    logStream.end(() => process.exit(0));
  }, RUN_DURATION_MS);

  process.on('SIGINT', () => {
    log('info', 'Monitor stopped by SIGINT');
    clearInterval(interval);
    logStream.end(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    log('info', 'Monitor stopped by SIGTERM');
    clearInterval(interval);
    logStream.end(() => process.exit(0));
  });
}

main().catch(e => {
  console.error('[seo-monitor] Fatal error:', e);
  process.exit(1);
});
