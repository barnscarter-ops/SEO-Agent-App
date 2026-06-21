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
const SMTP_FROM = process.env.SMTP_FROM || '';
const SMTP_TO = process.env.SMTP_TO || '';
const SMTP_APP_PASSWORD = process.env.SMTP_APP_PASSWORD || '';

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
// Email alerts
// ─────────────────────────────────────────────

async function sendBridgeAlert(subject, body) {
  if (!SMTP_FROM || !SMTP_TO || !SMTP_APP_PASSWORD) return;
  try {
    const { createTransport } = await import('nodemailer');
    const t = createTransport({ service: 'gmail', auth: { user: SMTP_FROM, pass: SMTP_APP_PASSWORD } });
    await t.sendMail({ from: SMTP_FROM, to: SMTP_TO, subject, text: body });
    console.log(`[mav-bridge] Alert sent: ${subject}`);
  } catch (e) {
    console.error(`[mav-bridge] Alert email failed: ${e.message}`);
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

// ─────────────────────────────────────────────
// GBP Excel + photo archive helpers
// ─────────────────────────────────────────────

function excelDateToIso(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return String(value || '').slice(0, 10);
}

function parseDriverJson(stdout) {
  try {
    const lastLine = (stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    return lastLine ? JSON.parse(lastLine) : {};
  } catch {
    return {};
  }
}

function gbpNeedsVerificationMessage(parsed = {}) {
  const attempts = parsed.verificationAttempts || 5;
  const snapshot = parsed.verificationSnapshot?.textFile || parsed.verificationSnapshot?.screenshot || '';
  const suffix = snapshot ? ` Snapshot: ${snapshot}` : '';
  return `GBP post was submitted but not verified after ${attempts} 60-second snapshot checks. Check manually before retrying.${suffix}`;
}

// Called only after driver.mjs verifies the post is visible.
// exit 0 (verified) → mark Posted=TRUE in Excel + move photo to archive
async function markGbpPostedAndArchive(postDate, exitCode, runId) {
  if (exitCode !== 0) return;
  if (!GBP_WORKBOOK_PATH) {
    console.log('[mav-bridge][gbp] GBP_WORKBOOK_PATH not set — skipping Excel update');
    return;
  }
  if (!fs.existsSync(GBP_WORKBOOK_PATH)) {
    await log(runId, 'gbp', 'warn', `GBP workbook not found: ${GBP_WORKBOOK_PATH}`);
    return;
  }

  try {
    const workbook = xlsx.readFile(GBP_WORKBOOK_PATH);
    const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows.length) return;

    const header = rows[0].map(h => String(h).trim());
    const dateCol = header.findIndex(h => h.toLowerCase() === 'date');
    const postedCol = header.findIndex(h => h.toLowerCase() === 'posted');
    const photoCol = header.findIndex(h =>
      h === 'AssetIdOrDescription' || h === 'Related Picture' || h.toLowerCase().includes('asset')
    );

    if (dateCol === -1) {
      await log(runId, 'gbp', 'warn', 'GBP workbook: Date column not found — check sheet column names');
      return;
    }

    let targetRow = -1;
    let photoPath = '';
    for (let i = 1; i < rows.length; i++) {
      if (excelDateToIso(rows[i][dateCol]) === postDate) {
        targetRow = i;
        if (photoCol >= 0) photoPath = String(rows[i][photoCol] || '').trim();
        break;
      }
    }

    if (targetRow === -1) {
      await log(runId, 'gbp', 'warn', `GBP workbook: no row found for ${postDate}`);
      return;
    }

    if (postedCol >= 0) {
      sheet[xlsx.utils.encode_cell({ r: targetRow, c: postedCol })] = { t: 'b', v: true };
      xlsx.writeFile(workbook, GBP_WORKBOOK_PATH);
      await log(runId, 'gbp', 'info', `Excel Posted=TRUE set for ${postDate}`);
    }

    if (photoPath && fs.existsSync(photoPath)) {
      const monthDir = path.join(GBP_ARCHIVE_FOLDER, postDate.slice(0, 7));
      fs.mkdirSync(monthDir, { recursive: true });
      const dest = path.join(monthDir, path.basename(photoPath));
      fs.renameSync(photoPath, dest);
      await log(runId, 'gbp', 'info', `Photo archived: ${path.basename(photoPath)} → ${monthDir}`);
    }
  } catch (e) {
    await log(runId, 'gbp', 'warn', `markGbpPostedAndArchive error: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// Handle an approved run
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Video prompt helpers
// ─────────────────────────────────────────────

async function generateDay1VideoPrompt(scheduleFile) {
  const text = fs.readFileSync(scheduleFile, 'utf8');
  const blocks = text.split(/\n\s*---\s*\n/).filter(b => b.includes('DAY:'));
  const day1 = blocks[0];
  if (!day1) return null;
  const get = (key) => {
    const m = day1.match(new RegExp(`^\\*{0,2}${key}:\\s*(.*?)\\s*$`, 'm'));
    return m ? (m[1] || '').replace(/\*\*/g, '').trim() : '';
  };
  const service = get('SERVICE');
  const hook = get('HOOK');
  const body = get('BODY');
  const cta = get('CTA');
  const hashtags = get('HASHTAGS');
  const caption = [hook ? `${hook}\n\n` : '', body, hashtags ? `\n\n${hashtags}` : '', cta ? `\n\n${cta}` : ''].join('').trim();

  if (!OPENAI_API_KEY) return get('VIDEO_PROMPT') || null;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: 300,
      messages: [
        { role: 'system', content: `You are a video director writing Veo 3 generation prompts for Grizzly Electrical Solutions, a licensed residential and commercial electrician in DFW, Texas.\n\nWrite a single vivid, cinematic prompt (100-140 words) that:\n- Opens with an establishing shot that sets a relatable scene (home, family, business)\n- Builds tension around an electrical problem (flickering lights, sparking outlet, dead panel, etc.)\n- Includes a dramatic visual moment — arcing breakers, sparks, smoke, worried faces, a professional electrician arriving\n- Feels like a mini movie trailer — emotional, urgent, real\n- Matches the service and caption topic provided\n- Ends with: Photorealistic, cinematic, 4K, dramatic atmosphere, no text overlays.\n\nOutput the prompt only. No explanation, no quotes, no title.` },
        { role: 'user', content: `Service: ${service}\nHook: ${hook}\nCaption:\n${caption}` },
      ],
    }),
  });
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || get('VIDEO_PROMPT') || null;
}

function writePendingPrompt(runId, prompt) {
  fs.mkdirSync(path.join(PROJECT_ROOT, 'outputs'), { recursive: true });
  fs.writeFileSync(PENDING_PROMPT_FILE, JSON.stringify({ runId, prompt, approved: false, approvedPrompt: null }));
}

function readPendingPrompt() {
  if (!fs.existsSync(PENDING_PROMPT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(PENDING_PROMPT_FILE, 'utf8')); } catch { return null; }
}

function clearPendingPrompt() {
  if (fs.existsSync(PENDING_PROMPT_FILE)) fs.unlinkSync(PENDING_PROMPT_FILE);
}

async function waitForPromptApproval(runId) {
  // Poll every 5s for up to 5 minutes, then auto-proceed
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const state = readPendingPrompt();
    if (state?.runId === runId && state?.approved) return state.approvedPrompt;
  }
  return null;
}

async function executeApprovedRun(run) {
  const { id: runId } = run;
  await log(runId, 'bridge', 'info', `Executing approved run ${runId}`);

  // ── Step 0: Generate Day 1 video prompt, surface for approval (5-min window) ──
  const scheduleFile = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
  if (fs.existsSync(scheduleFile)) {
    try {
      await log(runId, 'bridge', 'info', 'Generating Day 1 video prompt via GPT-4o-mini...');
      const prompt = await generateDay1VideoPrompt(scheduleFile);
      if (prompt) {
        writePendingPrompt(runId, prompt);
        await supabase.from('seo_runs').update({ status: 'awaiting_prompt' }).eq('id', runId);
        await log(runId, 'bridge', 'info', 'Video prompt ready — waiting up to 5 minutes for approval in dashboard...');
        const approvedPrompt = await waitForPromptApproval(runId);
        const finalPrompt = approvedPrompt || prompt;
        const text = fs.readFileSync(scheduleFile, 'utf8');
        const updated = text.replace(/^(\*{0,2}VIDEO_PROMPT:\*{0,2})\s*.*?$/m, `VIDEO_PROMPT: ${finalPrompt}`);
        fs.writeFileSync(scheduleFile, updated, 'utf8');
        if (approvedPrompt) {
          await log(runId, 'bridge', 'info', 'Approved prompt written to schedule.');
        } else {
          await log(runId, 'bridge', 'warn', 'Approval timed out — using generated prompt and proceeding.');
        }
        clearPendingPrompt();
      }
    } catch (e) {
      await log(runId, 'bridge', 'warn', `Video prompt generation failed (${e.message.slice(0, 120)}) — continuing without it.`);
    }
  }

  // Mark as executing
  await supabase.from('seo_runs').update({ status: 'executing' }).eq('id', runId);

  let allOk = true;

  // ── 1. Facebook posts ──────────────────────────────────────────
  const { data: fbPosts } = await supabase
    .from('weekly_posts')
    .select('*')
    .eq('run_id', runId)
    .eq('platform', 'facebook')
    .eq('status', 'approved')
    .order('day');

  if (fbPosts?.length) {
    await log(runId, 'facebook', 'info', `Posting ${fbPosts.length} Facebook posts`);
    await supabase.from('weekly_posts')
      .update({ status: 'posting' })
      .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'approved');

    const result = await runPhase(runId, 'facebook', 'node', [
      path.join(PROJECT_ROOT, 'scripts', 'facebook-post-week.mjs'),
      '--schedule-all', '--time', '09:00',
    ], PROJECT_ROOT);

    if (result.ok) {
      // Parse per-post results from JSON output so Day 1 → 'posted', Days 2-7 → 'scheduled'
      try {
        const parsed = JSON.parse((result.stdout || '').trim());
        const postResults = parsed?.results || [];
        const dayMap = new Map(postResults.map(r => [r.day, r]));

        if (parsed?.gemini_credits_depleted) {
          await log(runId, 'facebook', 'warn', 'GEMINI_CREDITS_DEPLETED: Video days posted as photos. Top up at https://aistudio.google.com/');
          await sendBridgeAlert(
            '⚠️ Grizzly SEO: Gemini Credits Depleted — Videos Not Generated',
            `The weekly Facebook video posts (Days 1, 4, 7) could not be generated because your Gemini API prepayment credits are depleted.\n\nPosts were published as photo-only posts.\n\nTo restore video generation:\n1. Go to https://aistudio.google.com/\n2. Add prepayment credits to your Google AI account\n3. Next week's run will automatically generate videos again.\n\nRun ID: ${runId}`,
          );
        }

        for (const fbPost of fbPosts) {
          const r = dayMap.get(fbPost.day);
          if (r) {
            const postStatus = r.status === 'posted' ? 'posted'
              : r.status === 'scheduled' ? 'scheduled'
              : 'error';
            await supabase.from('weekly_posts')
              .update({
                status: postStatus,
                error: r.status === 'error' ? (r.message || 'Unknown error') : null,
                posted_at: new Date().toISOString(),
                platform_post_id: r.id || null,
              })
              .eq('id', fbPost.id);
          }
        }
        // Fallback: catch any still-in-posting rows (unmapped days)
        await supabase.from('weekly_posts')
          .update({ status: 'posted', posted_at: new Date().toISOString() })
          .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'posting');
      } catch (parseErr) {
        await log(runId, 'facebook', 'warn', `Could not parse per-post results: ${parseErr.message} — marking all as posted`);
        await supabase.from('weekly_posts')
          .update({ status: 'posted', posted_at: new Date().toISOString() })
          .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'posting');
      }
    } else {
      await supabase.from('weekly_posts')
        .update({ status: 'error', error: result.error })
        .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'posting');
      allOk = false;
    }
  }

  // ── 2. GBP posts ───────────────────────────────────────────────
  // Writes content to Excel workbook, then posts each date to GBP via Playwright driver.
  const { data: gbpPosts } = await supabase
    .from('weekly_posts')
    .select('*')
    .eq('run_id', runId)
    .eq('platform', 'gbp')
    .eq('status', 'approved');

  if (gbpPosts?.length) {
    await log(runId, 'gbp', 'info', `Scheduling ${gbpPosts.length} GBP posts`);
    await supabase.from('weekly_posts')
      .update({ status: 'posting' })
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');

    // Match photos from Raw pool to post topics before syncing to Excel
    const PHOTO_MATCHER_PATH = path.join(PROJECT_ROOT, 'scripts', 'photo-matcher.mjs');
    if (fs.existsSync(PHOTO_MATCHER_PATH)) {
      const matchResult = await runPhase(runId, 'gbp', 'node', [PHOTO_MATCHER_PATH], PROJECT_ROOT);
      if (!matchResult.ok) {
        await log(runId, 'gbp', 'warn', `photo-matcher failed (continuing): ${matchResult.error}`);
      } else {
        await log(runId, 'gbp', 'info', 'Photo matching complete');
      }
    }

    // Sync posts to Excel workbook (reads updated PHOTO_FILE paths from schedule)
    const syncResult = await runPhase(runId, 'gbp', SEO_AGENTS_EXE, ['sync-gbp-schedule'], PROJECT_ROOT);
    if (!syncResult.ok) {
      await log(runId, 'gbp', 'error', `sync-gbp-schedule failed: ${syncResult.error}`);
      await supabase.from('weekly_posts')
        .update({ status: 'error', error: syncResult.error })
        .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'posting');
      allOk = false;
    } else {
      // Post Day 1 immediately, schedule Days 2-7 for their dates
      const day1Post = gbpPosts.find(p => p.day === 1);

      if (day1Post) {
        await log(runId, 'gbp', 'info', `Posting Day 1 GBP immediately...`);
        const result = await runPhase(runId, 'gbp', 'node', [GBP_POSTER_PATH, '--date', day1Post.post_date], PROJECT_ROOT);
        // Only exit 0 counts as posted: the driver polls verification before
        // returning success. Exit 3 is submitted but unverified and must not
        // update posted state.
        const gbpOk = result.exitCode === 0;
        if (gbpOk) {
          try {
            const parsed = parseDriverJson(result.stdout);
            await supabase.from('weekly_posts')
              .update({ status: 'posted', error: null, posted_at: new Date().toISOString(), platform_post_id: parsed.postUrl || null })
              .eq('id', day1Post.id);
            await log(runId, 'gbp', 'info', `Day 1 GBP posted (exit ${result.exitCode})`);
          } catch {
            await supabase.from('weekly_posts')
              .update({ status: 'posted', posted_at: new Date().toISOString() })
              .eq('id', day1Post.id);
          }
          await markGbpPostedAndArchive(day1Post.post_date, result.exitCode, runId);
        } else if (result.exitCode === 3) {
          const parsed = parseDriverJson(result.stdout);
          const message = gbpNeedsVerificationMessage(parsed);
          await supabase.from('weekly_posts')
            .update({ status: 'needs_verification', error: message })
            .eq('id', day1Post.id);
          await log(runId, 'gbp', 'warn', `Day 1 GBP submitted but unverified after ${parsed.verificationAttempts || 5} snapshot checks. Not marking posted.`);
          allOk = false;
        } else {
          await supabase.from('weekly_posts')
            .update({ status: 'error', error: result.error })
            .eq('id', day1Post.id);
          await log(runId, 'gbp', 'error', `Day 1 GBP failed: ${result.error}`);
          allOk = false;
        }
      }

      // Mark Days 2-7 as scheduled (will be posted by daily cron job)
      const laterPosts = gbpPosts.filter(p => p.day > 1);
      if (laterPosts.length) {
        await supabase.from('weekly_posts')
          .update({ status: 'scheduled' })
          .eq('run_id', runId).eq('platform', 'gbp').gt('day', 1);
        await log(runId, 'gbp', 'info', `Days 2-7 marked scheduled for daily poster`);
      }
    }
  }

  // ── 3. Website tasks ───────────────────────────────────────────
  // website-task command was removed from seo-agents.exe; tasks are reviewed
  // and executed manually through the dashboard action queue.
  const { data: tasks } = await supabase
    .from('website_tasks')
    .select('*')
    .eq('run_id', runId)
    .eq('status', 'approved')
    .order('priority');

  if (tasks?.length) {
    await log(runId, 'website', 'info', `${tasks.length} website task(s) need manual review — use the action queue in the dashboard`);
    // Leave tasks as 'approved' so the dashboard action queue can surface them
  }

  // ── Mark run done ──────────────────────────────────────────────
  await supabase.from('seo_runs').update({
    status: allOk ? 'done' : 'error',
    done_at: new Date().toISOString(),
    error: allOk ? null : 'One or more phases failed — check run_logs',
  }).eq('id', runId);

  await log(runId, 'bridge', allOk ? 'info' : 'warn',
    `Run ${runId} complete — ${allOk ? 'all phases succeeded' : 'some phases failed'}`);
}

// ─────────────────────────────────────────────
// Poll loop
// ─────────────────────────────────────────────

let busy = false;
let lastDailyGbpDate = '';

async function poll() {
  if (busy) return;
  busy = true;
  try {
    // Find runs that are approved and not yet executing
    const { data: runs, error } = await supabase
      .from('seo_runs')
      .select('*')
      .eq('status', 'approved')
      .order('created_at')
      .limit(1);

    if (error) {
      console.error('[mav-bridge] Supabase poll error:', error.message);
      return;
    }

    if (runs?.length) {
      await executeApprovedRun(runs[0]);
    }

    // Also pick up awaiting_prompt runs if user already approved the prompt
    const { data: waitingRuns } = await supabase
      .from('seo_runs')
      .select('*')
      .eq('status', 'awaiting_prompt')
      .order('created_at')
      .limit(1);

    if (waitingRuns?.length) {
      const state = readPendingPrompt();
      if (state?.runId === waitingRuns[0].id && state?.approved) {
        // Prompt was approved externally — continue the run
        await executeApprovedRun(waitingRuns[0]);
      }
    }

    // ── Daily GBP poster ─────────────────────────
    // Run once per calendar day after 9 AM CST/CDT.
    // CDT = UTC-5 (summer), CST = UTC-6 (winter). Using -5 for CDT.
    // todayDate uses the same offset so it never rolls to the next UTC day early.
    const nowUtc = new Date();
    const CDT_OFFSET = 5; // hours behind UTC (CDT); change to 6 in winter (CST)
    const cstHour = (nowUtc.getUTCHours() - CDT_OFFSET + 24) % 24;
    const todayDate = new Date(nowUtc.getTime() - CDT_OFFSET * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (cstHour >= 9 && lastDailyGbpDate !== todayDate) {
      lastDailyGbpDate = todayDate;
      const { data: todayGbp } = await supabase
        .from('weekly_posts')
        .select('id, run_id, post_date, photo_file')
        .eq('platform', 'gbp')
        .eq('status', 'scheduled')
        .eq('post_date', todayDate)
        .order('post_date', { ascending: true });

      for (const post of todayGbp || []) {
        console.log(`[mav-bridge][gbp-daily] Posting scheduled GBP for ${post.post_date}`);
        const result = await runPhase(post.run_id, 'gbp', 'node', [GBP_POSTER_PATH, '--date', post.post_date], PROJECT_ROOT);
        const parsed = parseDriverJson(result.stdout);
        const gbpDailyOk = result.exitCode === 0;
        if (gbpDailyOk) {
          await supabase.from('weekly_posts')
            .update({ status: 'posted', posted_at: new Date().toISOString(), platform_post_id: parsed.postUrl || null })
            .eq('id', post.id);
          console.log(`[mav-bridge][gbp-daily] Posted ${post.post_date} (exit ${result.exitCode})`);
          await markGbpPostedAndArchive(post.post_date, result.exitCode, post.run_id);
        } else if (result.exitCode === 3) {
          const message = gbpNeedsVerificationMessage(parsed);
          await supabase.from('weekly_posts')
            .update({ status: 'needs_verification', error: message })
            .eq('id', post.id);
          console.warn(`[mav-bridge][gbp-daily] Submitted but unverified after ${parsed.verificationAttempts || 5} snapshot checks: ${post.post_date}`);
        } else {
          await supabase.from('weekly_posts')
            .update({ status: 'error', error: (result.stderr || result.error || 'GBP poster failed').slice(0, 300) })
            .eq('id', post.id);
          console.error(`[mav-bridge][gbp-daily] Failed ${post.post_date}: ${result.error?.slice(0, 200)}`);
        }
      }
    }
  } catch (e) {
    console.error('[mav-bridge] Poll exception:', e.message);
  } finally {
    busy = false;
  }
}

// ─────────────────────────────────────────────
// HTTP server (MCC dashboard connects here)
// ─────────────────────────────────────────────

function sendJsonHttp(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function handleHttpRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  const { method } = req;

  // ── GET /health ─────────────────────────────
  if (method === 'GET' && url.pathname === '/health') {
    sendJsonHttp(res, 200, { state: 'online', service: 'mav-bridge', uptime: process.uptime() });
    return;
  }

  // ── GET /seo/status ─────────────────────────
  if (method === 'GET' && url.pathname === '/seo/status') {
    const [runsRes, postsRes] = await Promise.all([
      supabase.from('seo_runs').select('*').order('created_at', { ascending: false }).limit(20),
      supabase.from('weekly_posts').select('run_id,platform,status,post_date,error').order('created_at', { ascending: false }).limit(200),
    ]);
    const runs = runsRes.data || [];
    const posts = postsRes.data || [];

    // Group posts by run so we can compute live status from actual post states,
    // not the frozen execution-time status on seo_runs.
    const postsByRun = {};
    for (const p of posts) {
      if (!p.run_id) continue;
      (postsByRun[p.run_id] = postsByRun[p.run_id] || []).push(p);
    }

    // Derive the current real status of a run from its posts.
    // seo_runs.status is only used for states that have no associated posts yet
    // (pending_approval, executing, awaiting_prompt).
    function liveRunStatus(run) {
      const runPosts = postsByRun[run.id] || [];
      // These statuses are in-flight — trust the run record.
      if (['pending_approval', 'executing', 'awaiting_prompt'].includes(run.status)) return run.status;
      // If there are no posts, the run record is the best we have.
      if (!runPosts.length) return run.status;
      const hasCurrentError = runPosts.some(p => ['error', 'needs_verification'].includes(p.status));
      const allDone = runPosts.every(p => ['posted', 'done', 'scheduled'].includes(p.status));
      if (hasCurrentError) return 'error';
      if (allDone) return 'done';
      return 'executing';
    }

    const latest = runs[0] || null;
    const latestLive = latest ? liveRunStatus(latest) : 'idle';

    const statusCounts = { complete: 0, partial: 0, blocked: 0, incomplete: 0 };
    for (const r of runs) {
      const ls = liveRunStatus(r);
      if (ls === 'done') statusCounts.complete++;
      else if (['posting', 'executing'].includes(ls)) statusCounts.partial++;
      else if (ls === 'error') statusCounts.blocked++;
      else statusCounts.incomplete++;
    }

    // Faults: only current post-level errors, not the frozen run-level error field.
    const errorPosts = posts.filter(p => ['error', 'needs_verification'].includes(p.status));
    const faults = errorPosts.slice(0, 3).map(p =>
      `${p.platform} post ${p.post_date} failed: ${(p.error || 'unknown error').slice(0, 120)}`
    );

    const pendingPosts = posts.filter(p => p.status === 'pending_approval');
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const reports = runs
      .filter(r => ['done', 'posted', 'pending_approval', 'approved', 'error'].includes(r.status))
      .map(r => {
        const ls = liveRunStatus(r);
        return {
          id: r.id,
          date: r.created_at,
          updatedAt: r.done_at || r.created_at,
          status: ls === 'pending_approval' ? 'needs_approval' : ls === 'error' ? 'blocked' : 'complete',
          source: 'mav-bridge',
          label: `Run ${r.week_of || r.id?.slice(0, 8) || '?'}`,
        };
      });

    sendJsonHttp(res, 200, {
      state: latestLive,
      reports,
      faults,
      activeWorkflow: {
        name: 'SEO Automation',
        phase: latestLive,
        reportsGenerated: reports.filter(r => new Date(r.date).getTime() > sevenDaysAgo).length,
      },
      statusCounts,
      workflowStatus: {
        actions: {
          actions: [],
          summary: {
            needs_approval: pendingPosts.length,
            blocked_access: errorPosts.length,
          },
        },
      },
      runHealth: null,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // ── GET /seo/actions ────────────────────────
  if (method === 'GET' && url.pathname === '/seo/actions') {
    const [runsRes, postsRes, tasksRes] = await Promise.all([
      supabase.from('seo_runs').select('*').eq('status', 'pending_approval').order('created_at').limit(10),
      supabase.from('weekly_posts').select('*').in('status', ['pending_approval', 'error', 'needs_verification']).order('day').limit(50),
      supabase.from('website_tasks').select('*').eq('status', 'pending_approval').order('priority').limit(20),
    ]);
    const runs = runsRes.data || [];
    const posts = postsRes.data || [];
    const tasks = tasksRes.data || [];

    const actions = [
      ...runs.map(r => ({
        id: r.id,
        type: 'seo_run',
        status: 'needs_approval',
        label: `SEO Run ${r.week_of || r.id?.slice(0, 8)}`,
        approval_required: true,
        approval: null,
        live_adapter: 'mav-bridge',
        posts_count: posts.filter(p => p.run_id === r.id).length,
      })),
      ...tasks.map(t => ({
        id: t.id,
        type: 'website_task',
        status: 'needs_approval',
        label: t.title || `Task ${t.id?.slice(0, 8)}`,
        approval_required: true,
        approval: null,
        live_adapter: 'mav-bridge',
      })),
    ];

    sendJsonHttp(res, 200, {
      actions,
      summary: {
        needs_approval: runs.length + tasks.length,
        blocked_access: posts.filter(p => ['error', 'needs_verification'].includes(p.status)).length,
      },
    });
    return;
  }

  // ── POST /seo/actions/approve ────────────────
  if (method === 'POST' && url.pathname === '/seo/actions/approve') {
    const { actionId, note } = await readBody(req);
    if (!actionId) { sendJsonHttp(res, 400, { error: 'actionId required' }); return; }

    // Try seo_run first
    const { data: run, error: runErr } = await supabase.from('seo_runs')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', actionId).eq('status', 'pending_approval')
      .select().maybeSingle();
    if (runErr) { sendJsonHttp(res, 500, { error: runErr.message }); return; }

    if (run) {
      // Auto-approve all pending weekly_posts for this run so executeApprovedRun finds them
      await supabase.from('weekly_posts')
        .update({ status: 'approved' })
        .eq('run_id', run.id)
        .eq('status', 'pending_approval');
      sendJsonHttp(res, 200, { ok: true, type: 'seo_run', id: run.id });
      return;
    }

    // Try website_task
    const { data: task, error: taskErr } = await supabase.from('website_tasks')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', actionId)
      .select().maybeSingle();
    if (taskErr) { sendJsonHttp(res, 500, { error: taskErr.message }); return; }

    if (task) { sendJsonHttp(res, 200, { ok: true, type: 'website_task', id: task.id }); return; }

    sendJsonHttp(res, 404, { error: 'Action not found or already approved' });
    return;
  }

  // ── POST /seo/actions/run ────────────────────
  if (method === 'POST' && url.pathname === '/seo/actions/run') {
    const { actionId, live } = await readBody(req);
    if (!live) {
      sendJsonHttp(res, 200, { ok: true, mode: 'dry_run', message: 'Dry run — no changes made.' });
      return;
    }
    const { data: run } = await supabase.from('seo_runs')
      .update({ status: 'approved' })
      .eq('id', actionId)
      .eq('status', 'pending_approval')
      .select().maybeSingle();

    if (!run) { sendJsonHttp(res, 404, { error: 'Run not found or already executed' }); return; }

    // Also approve associated weekly_posts
    await supabase.from('weekly_posts')
      .update({ status: 'approved' })
      .eq('run_id', run.id)
      .eq('status', 'pending_approval');
    sendJsonHttp(res, 200, { ok: true, mode: 'live', runId: run.id, message: 'Approved — bridge will execute on next poll.' });
    return;
  }

  // ── GET /seo/facebook/pending-prompt ────────
  if (method === 'GET' && url.pathname === '/seo/facebook/pending-prompt') {
    const state = readPendingPrompt();
    if (!state) { sendJsonHttp(res, 404, { error: 'No pending prompt' }); return; }
    sendJsonHttp(res, 200, { runId: state.runId, prompt: state.prompt, approved: state.approved });
    return;
  }

  // ── POST /seo/facebook/approve-prompt ───────
  if (method === 'POST' && url.pathname === '/seo/facebook/approve-prompt') {
    const { prompt } = await readBody(req);
    if (!prompt) { sendJsonHttp(res, 400, { error: 'prompt required' }); return; }
    const state = readPendingPrompt();
    if (!state) { sendJsonHttp(res, 404, { error: 'No pending prompt' }); return; }
    fs.writeFileSync(PENDING_PROMPT_FILE, JSON.stringify({ ...state, approved: true, approvedPrompt: prompt }));
    sendJsonHttp(res, 200, { ok: true });
    return;
  }

  // ── POST /seo/facebook/new-schedule ─────────
  if (method === 'POST' && url.pathname === '/seo/facebook/new-schedule') {
    const { days = 7, startDate = '' } = await readBody(req);
    const safeDays = Math.max(1, Math.min(14, Number(days) || 7));
    const args = ['facebook-schedule', '--days', String(safeDays)];
    if (startDate) args.push('--start-date', startDate);
    await log(null, 'bridge', 'info', `Kicking off facebook-schedule: days=${safeDays}${startDate ? ` start=${startDate}` : ''}`);
    execFileAsync(SEO_AGENTS_EXE, args, {
      cwd: PROJECT_ROOT,
      timeout: 30 * 60 * 1000,
      encoding: 'utf8',
      windowsHide: true,
    }).then(({ stdout }) => {
      log(null, 'bridge', 'info', `facebook-schedule complete: ${stdout.slice(0, 400)}`);
    }).catch(e => {
      log(null, 'bridge', 'error', `facebook-schedule failed: ${e.message.slice(0, 400)}`);
    });
    sendJsonHttp(res, 200, { ok: true, message: `Schedule generation started (${safeDays} days). Check back in a few minutes.` });
    return;
  }

  // ── GET /seo/posts/week ──────────────────────
  // Returns weekly_posts for the most recent seo_run (any status).
  // Uses run-based anchor so posts are always visible regardless of when
  // approval happened relative to the calendar week.
  if (method === 'GET' && url.pathname === '/seo/posts/week') {
    const { data: latestRun } = await supabase
      .from('seo_runs')
      .select('id, week_of, created_at, status')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestRun) {
      sendJsonHttp(res, 200, { week_start: null, week_end: null, facebook: [], gbp: [] });
      return;
    }

    const { data: posts, error } = await supabase
      .from('weekly_posts')
      .select('id,run_id,platform,day,post_date,type,service,hook,body,cta,photo_file,status,posted_at,platform_post_id,error')
      .eq('run_id', latestRun.id)
      .order('post_date')
      .order('platform');

    if (error) { sendJsonHttp(res, 500, { error: error.message }); return; }

    const allPosts = posts || [];
    const dates = allPosts.map(p => p.post_date).filter(Boolean).sort();
    const facebook = allPosts.filter(p => p.platform === 'facebook');
    const gbp = allPosts.filter(p => p.platform === 'gbp');
    sendJsonHttp(res, 200, {
      run_id: latestRun.id,
      run_status: latestRun.status,
      week_start: dates[0] || null,
      week_end: dates[dates.length - 1] || null,
      facebook,
      gbp,
    });
    return;
  }

  sendJsonHttp(res, 404, { error: 'Not found' });
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

console.log(`[mav-bridge] Starting — polling Supabase every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[mav-bridge] Project root: ${PROJECT_ROOT}`);

const httpServer = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch(e => {
    console.error('[mav-bridge][http] Unhandled error:', e.message);
    try { sendJsonHttp(res, 500, { error: 'Internal server error' }); } catch {}
  });
});
httpServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[mav-bridge] HTTP server listening on http://127.0.0.1:${BRIDGE_PORT}`);
});

poll(); // run immediately on start
setInterval(poll, POLL_INTERVAL_MS);
