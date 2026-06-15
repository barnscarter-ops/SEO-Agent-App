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
  // Poll every 5s for up to 30 minutes
  for (let i = 0; i < 360; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const state = readPendingPrompt();
    if (state?.runId === runId && state?.approved) return state.approvedPrompt;
  }
  return null;
}

async function executeApprovedRun(run) {
  const { id: runId } = run;
  await log(runId, 'bridge', 'info', `Executing approved run ${runId}`);

  // ── Step 0: Generate Day 1 video prompt and wait for user approval ──
  const scheduleFile = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
  if (fs.existsSync(scheduleFile)) {
    await log(runId, 'bridge', 'info', 'Generating Day 1 video prompt via GPT-4o-mini...');
    const prompt = await generateDay1VideoPrompt(scheduleFile);
    if (prompt) {
      writePendingPrompt(runId, prompt);
      await supabase.from('seo_runs').update({ status: 'awaiting_prompt' }).eq('id', runId);
      await log(runId, 'bridge', 'info', 'Waiting for video prompt approval in dashboard...');
      const approvedPrompt = await waitForPromptApproval(runId);
      if (approvedPrompt) {
        // Write approved prompt back to markdown
        const text = fs.readFileSync(scheduleFile, 'utf8');
        const updated = text.replace(/^(\*{0,2}VIDEO_PROMPT:\*{0,2})\s*.*?$/m, `VIDEO_PROMPT: ${approvedPrompt}`);
        fs.writeFileSync(scheduleFile, updated, 'utf8');
        await log(runId, 'bridge', 'info', 'Prompt approved and written to schedule.');
      } else {
        await log(runId, 'bridge', 'warn', 'Prompt approval timed out — using pre-generated prompt.');
      }
      clearPendingPrompt();
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
    ], PROJECT_ROOT);

    if (result.ok) {
      // Parse per-post results from JSON output so Day 1 → 'posted', Days 2-7 → 'scheduled'
      try {
        const parsed = JSON.parse((result.stdout || '').trim());
        const postResults = parsed?.results || [];
        const dayMap = new Map(postResults.map(r => [r.day, r]));

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

    // First, sync posts to Excel workbook
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
        // exit 0 = posted+verified, exit 3 = posted but unverified — both count as success
        const gbpOk = result.exitCode === 0 || result.exitCode === 3;
        if (gbpOk) {
          try {
            const lastLine = (result.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
            const parsed = lastLine ? JSON.parse(lastLine) : {};
            await supabase.from('weekly_posts')
              .update({ status: 'posted', error: null, posted_at: new Date().toISOString(), platform_post_id: parsed.postUrl || null })
              .eq('id', day1Post.id);
            await log(runId, 'gbp', 'info', `Day 1 GBP posted (exit ${result.exitCode})`);
          } catch {
            await supabase.from('weekly_posts')
              .update({ status: 'posted', posted_at: new Date().toISOString() })
              .eq('id', day1Post.id);
          }
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
    // Run once per calendar day after 9 AM CST (UTC-5/UTC-6).
    // Posts any weekly_posts rows with platform=gbp, status=scheduled, post_date=today.
    const nowUtc = new Date();
    const cstHour = (nowUtc.getUTCHours() - 6 + 24) % 24; // CDT offset; switch to -5 for CST winter
    const todayDate = nowUtc.toISOString().slice(0, 10);
    if (cstHour >= 9 && lastDailyGbpDate !== todayDate) {
      lastDailyGbpDate = todayDate;
      const { data: todayGbp } = await supabase
        .from('weekly_posts')
        .select('id, run_id, post_date, photo_file')
        .eq('platform', 'gbp')
        .eq('status', 'scheduled')
        .eq('post_date', todayDate);

      for (const post of todayGbp || []) {
        console.log(`[mav-bridge][gbp-daily] Posting scheduled GBP for ${post.post_date}`);
        const result = await runPhase(post.run_id, 'gbp', 'node', [GBP_POSTER_PATH, '--date', post.post_date], PROJECT_ROOT);
        let parsed = null;
        try { parsed = JSON.parse((result.stdout || '').split('\n').filter(l => l.trim().startsWith('{')).pop() || '{}'); } catch {}
        const gbpDailyOk = result.exitCode === 0 || result.exitCode === 3;
        if (gbpDailyOk) {
          let parsedUrl = null;
          try {
            const lastLine = (result.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
            parsedUrl = lastLine ? JSON.parse(lastLine).postUrl : null;
          } catch {}
          await supabase.from('weekly_posts')
            .update({ status: 'posted', posted_at: new Date().toISOString(), platform_post_id: parsedUrl })
            .eq('id', post.id);
          console.log(`[mav-bridge][gbp-daily] Posted ${post.post_date} (exit ${result.exitCode})`);
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
      supabase.from('weekly_posts').select('platform,status').order('created_at', { ascending: false }).limit(100),
    ]);
    const runs = runsRes.data || [];
    const posts = postsRes.data || [];
    const latest = runs[0] || null;

    const statusCounts = { complete: 0, partial: 0, blocked: 0, incomplete: 0 };
    for (const r of runs) {
      if (r.status === 'done') statusCounts.complete++;
      else if (['posting', 'posted', 'executing'].includes(r.status)) statusCounts.partial++;
      else if (r.status === 'error') statusCounts.blocked++;
      else statusCounts.incomplete++;
    }

    const pendingPosts = posts.filter(p => p.status === 'pending_approval');
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const reports = runs
      .filter(r => ['done', 'posted', 'pending_approval', 'approved', 'error'].includes(r.status))
      .map(r => ({
        id: r.id,
        date: r.created_at,
        updatedAt: r.done_at || r.created_at,
        status: r.status === 'pending_approval' ? 'needs_approval' : r.status === 'error' ? 'blocked' : 'complete',
        source: 'mav-bridge',
        label: `Run ${r.week_of || r.id?.slice(0, 8) || '?'}`,
      }));

    sendJsonHttp(res, 200, {
      state: latest?.status || 'idle',
      reports,
      faults: runs.filter(r => r.status === 'error').slice(0, 3)
        .map(r => r.error || `Run ${r.id?.slice(0, 8)} failed`),
      activeWorkflow: {
        name: 'SEO Automation',
        phase: latest?.status || 'idle',
        reportsGenerated: reports.filter(r => new Date(r.date).getTime() > sevenDaysAgo).length,
      },
      statusCounts,
      workflowStatus: {
        actions: {
          actions: [],
          summary: {
            needs_approval: pendingPosts.length,
            blocked_access: posts.filter(p => p.status === 'error').length,
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
      supabase.from('weekly_posts').select('*').in('status', ['pending_approval', 'error']).order('day').limit(50),
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
        blocked_access: posts.filter(p => p.status === 'error').length,
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
