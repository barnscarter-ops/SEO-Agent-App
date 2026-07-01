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
import { checkFacebookToken } from './facebook-poster.mjs';
import { mediaStatusFor, bucketStatus, isStuck, describeAction, agentFor } from './lib/action-enrich.mjs';
import { makeAlertStore } from './lib/alert-store.mjs';
import { makeRunPhase } from './lib/run-phase.mjs';
import { runGbpForApprovedRun, runDailyGbp, centralDateHour } from './lib/gbp-runner.mjs';

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
// GBP is owned by the user-session gbp-worker (Scheduled Task). The service does NO
// GBP by default. Flip MAV_BRIDGE_GBP to 'on' ONLY as a rollback, and stop gbp-worker
// first to avoid double-posting. See docs/runbooks/gbp-worker.md.
const GBP_ON = (process.env.MAV_BRIDGE_GBP || 'off').toLowerCase() === 'on';
const PHOTO_PICK_PATH = path.join(PROJECT_ROOT, 'scripts', 'gbp-photo-pick.mjs');
const GBP_PATHS = { photoPick: PHOTO_PICK_PATH, gbpPoster: GBP_POSTER_PATH, seoAgentsExe: SEO_AGENTS_EXE };
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SMTP_FROM = process.env.SMTP_FROM || '';
const SMTP_TO = process.env.SMTP_TO || '';
const SMTP_APP_PASSWORD = process.env.SMTP_APP_PASSWORD || '';
const GRIZZLY_HCP_DIR = process.env.GRIZZLY_HCP_DIR || 'C:\\Workspace\\Active\\grizzly-hcp';
const ALERTED_PATH = path.join(PROJECT_ROOT, 'state', 'alerted.json');
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[mav-bridge] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
fs.mkdirSync(path.join(PROJECT_ROOT, 'state'), { recursive: true });
const alertStore = makeAlertStore(ALERTED_PATH);
// Cold-start guard: if the dedup store is empty on boot, the first fault-detection
// pass adopts whatever is already failed/stuck as a silent baseline instead of
// firing an alert for every pre-existing fault at once. Only NEW faults after boot
// alert. (Without this, a fresh deploy with N standing failures sends N texts.)
const faultStoreWasEmpty = alertStore.isEmpty();
let faultBaselineSeeded = false;
// Never alert on faults older than this — stale historical failures are noise.
const FAULT_RECENCY_MS = 24 * 60 * 60 * 1000;

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

// Structured per-hop error logging (Fix 5). The data path is
// Vercel → Tailscale → server.mjs → mav-bridge → adapters. When something
// breaks, this tags WHICH outbound boundary failed so a vague dashboard error
// can be traced to the exact hop. `hop` is e.g. 'mav-bridge→supabase',
// 'mav-bridge→openai', 'mav-bridge→subprocess:facebook'.
async function hopError(runId, phase, hop, message, err) {
  const detail = err ? `${message}: ${err.message || err}` : message;
  const rec = { ts: new Date().toISOString(), source: 'mav-bridge', hop, phase, message: detail };
  console.error(`[mav-bridge][${hop}][error] ${detail}`);
  console.error(`  ↳ ${JSON.stringify(rec)}`);
  if (runId) {
    // Supabase's query builder is a thenable, not a real Promise — it has no
    // `.catch`. Awaiting + destructuring the error keeps a logging failure from
    // throwing out of poll() (which would kill fault detection mid-cycle).
    const { error } = await supabase.from('run_logs')
      .insert({ run_id: runId, phase, level: 'error', message: `[${hop}] ${detail}` });
    if (error) console.error(`[mav-bridge][mav-bridge→supabase][error] could not write hop error: ${error.message}`);
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

// Fire a non-silent alert exactly once per (run, action, fault). Banner data is
// served separately by /seo/actions; this handles the push channels (iMessage + email).
async function notifyAlert({ runId, actionId, faultType, title, detail }) {
  if (!alertStore.shouldFire(runId, actionId, faultType)) return;
  const msg = `⚠️ Grizzly SEO: ${title}\n${detail || ''}`.trim();
  // iMessage via grizzly-hcp send-only helper. Failure must not break the poll loop.
  try {
    await execFileAsync('npx', ['tsx', 'scripts/notify-imessage.ts', msg], {
      cwd: GRIZZLY_HCP_DIR, timeout: 20_000, windowsHide: true, shell: true,
    });
  } catch (e) {
    console.error(`[mav-bridge] iMessage alert failed: ${e.message}`);
  }
  await sendBridgeAlert(`Grizzly SEO: ${title}`, detail || title);
}

// ─────────────────────────────────────────────
// Run a phase and capture output
// ─────────────────────────────────────────────

const runPhase = makeRunPhase({ log, hopError, projectRoot: PROJECT_ROOT });

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

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  } catch (e) {
    // Tag the OpenAI hop so a network/DNS failure here is distinguishable from a bad response.
    throw new Error(`[mav-bridge→openai] request failed: ${e.message}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`[mav-bridge→openai] ${json.error.message || 'API error'}`);
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

  // ── Fix 4: validate the Facebook Page token before the pipeline runs so a stale
  // token surfaces as a clear warning/alert instead of a cryptic mid-run failure. ──
  try {
    const tok = await checkFacebookToken();
    await log(runId, 'facebook', tok.level, tok.message);
    if (tok.level === 'error' || (tok.level === 'warn' && tok.expiresAt)) {
      await sendBridgeAlert(
        '⚠️ Grizzly SEO: Facebook Token Needs Attention',
        `${tok.message}\n\nRegenerate a long-lived Page Access Token at https://developers.facebook.com/tools/explorer and update FB_PAGE_ACCESS_TOKEN in .env, then restart mav-bridge.\n\nRun ID: ${runId}`,
      );
    }
  } catch (e) {
    await hopError(runId, 'facebook', 'mav-bridge→graph', 'Facebook token check failed', e);
  }

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
    // Idempotency guard: rows that already carry a platform_post_id have already
    // been posted (or scheduled) — never re-post them. Only spawn facebook-poster
    // when there's at least one genuinely unposted row.
    const unposted = fbPosts.filter(p => !p.platform_post_id);
    if (!unposted.length) {
      await log(runId, 'facebook', 'info', 'All Facebook posts already have platform_post_id — skipping re-post');
    } else {
      await log(runId, 'facebook', 'info', `Posting ${unposted.length} Facebook posts (${fbPosts.length - unposted.length} already posted)`);
      await supabase.from('weekly_posts')
        .update({ status: 'posting' })
        .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'approved')
        .is('platform_post_id', null);

      const result = await runPhase(runId, 'facebook', 'node', [
        path.join(PROJECT_ROOT, 'scripts', 'facebook-poster.mjs'),
        '--schedule-all', '--time', '09:00',
      ], PROJECT_ROOT, { timeoutMs: 45 * 60 * 1000 }); // up to 3 Veo 3 renders + uploads

      if (result.ok) {
        // Parse per-post results from JSON output so Day 1 → 'posted', Days 2-7 → 'scheduled'
        try {
          const parsed = JSON.parse((result.stdout || '').trim());
          const postResults = parsed?.results || [];
          const dayMap = new Map(postResults.map(r => [r.day, r]));

          const fallbacks = postResults.filter(r => r.fallback);
          if (fallbacks.length) {
            const summary = fallbacks.map(r => `Day ${r.day}: ${r.fallback}`).join(', ');
            await log(runId, 'facebook', 'warn', `FALLBACK: ${summary}`);
          }

          if (parsed?.gemini_credits_depleted) {
            await log(runId, 'facebook', 'warn', 'GEMINI_CREDITS_DEPLETED: Video days posted as photos. Top up at https://aistudio.google.com/');
            await sendBridgeAlert(
              '⚠️ Grizzly SEO: Gemini Credits Depleted — Videos Not Generated',
              `The weekly Facebook video posts (Days 1, 4, 7) could not be generated because your Gemini API prepayment credits are depleted.\n\nPosts were published as photo-only posts.\n\nTo restore video generation:\n1. Go to https://aistudio.google.com/\n2. Add prepayment credits to your Google AI account\n3. Next week's run will automatically generate videos again.\n\nRun ID: ${runId}`,
            );
          }

          for (const fbPost of unposted) {
            const r = dayMap.get(fbPost.day);
            if (r) {
              const postStatus = r.status === 'posted' ? 'posted'
                : r.status === 'scheduled' ? 'scheduled'
                : 'error';
              await supabase.from('weekly_posts')
                .update({
                  status: postStatus,
                  media_status: mediaStatusFor(fbPost.type, r.media),
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
  }

  // ── 2. GBP posts (owned by gbp-worker; service only acts if MAV_BRIDGE_GBP=on) ──
  if (GBP_ON) {
    const { data: gbpPosts } = await supabase
      .from('weekly_posts').select('*')
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');
    if (gbpPosts?.length) {
      // Atomic CAS on status='approved' — if gbp-worker claimed these rows first,
      // this update matches zero rows and we skip instead of double-posting.
      const { data: claimed } = await supabase.from('weekly_posts')
        .update({ status: 'posting' })
        .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved')
        .select('id');
      if (!claimed?.length) {
        await log(runId, 'gbp', 'info', 'GBP rows already claimed by gbp-worker — skipping');
      } else {
        const claimedIds = new Set(claimed.map(c => c.id));
        await runGbpForApprovedRun({
          runId, gbpPosts: gbpPosts.filter(p => claimedIds.has(p.id)),
          deps: { supabase, runPhase, log, env: process.env, projectRoot: PROJECT_ROOT, paths: GBP_PATHS },
        });
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
      // Tag the Supabase hop so a DB/network failure here is distinct from a
      // downstream adapter failure (Fix 5).
      console.error(`[mav-bridge][mav-bridge→supabase][error] poll query failed: ${error.message}`);
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

    // ── Daily tick: once per calendar day after 9am Central ──
    const { todayDate, cstHour } = centralDateHour(new Date());
    if (cstHour >= 9 && lastDailyGbpDate !== todayDate) {
      lastDailyGbpDate = todayDate;

      // GBP daily posting is owned by gbp-worker. Service only posts if MAV_BRIDGE_GBP=on.
      if (GBP_ON) {
        await runDailyGbp({
          supabase, runPhase, log, env: process.env,
          todayDate, gbpPosterPath: GBP_POSTER_PATH, projectRoot: PROJECT_ROOT,
        });
      }

      // ── Facebook reconciliation ──────────────────
      // FB Days 2–7 are scheduled on Facebook's own native scheduler at run time
      // (each row already carries a real FB post id). Facebook publishes them on
      // their dates; the bridge never posts FB daily. So once a scheduled FB row's
      // date has arrived (lte — we check today's post too, not just past days),
      // verify it actually published via the Graph API before marking it 'posted'.
      //
      // Three outcomes per row, distinguished so the dashboard never lies and we
      // never clobber a post that simply hasn't hit its publish minute yet:
      //   - is_published === true   → mark 'posted'
      //   - valid object, is_published === false → still pending; LEAVE as 'scheduled'
      //                                 (re-checked on the next tick / next day)
      //   - Graph error / not found → mark 'error' (deleted or rejected upstream)
      //   - network throw           → leave unchanged (can't confirm either way)
      const { data: pastFb } = await supabase
        .from('weekly_posts')
        .select('id, post_date, platform_post_id')
        .eq('platform', 'facebook')
        .eq('status', 'scheduled')
        .lte('post_date', todayDate);
      for (const post of pastFb || []) {
        if (post.platform_post_id && FB_PAGE_ACCESS_TOKEN) {
          try {
            const checkRes = await fetch(
              `https://graph.facebook.com/${GRAPH_API_VERSION}/${post.platform_post_id}?fields=id,is_published&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`
            );
            const checkJson = await checkRes.json();
            if (checkJson.error) {
              // Post object itself is gone/rejected — real failure.
              await supabase.from('weekly_posts')
                .update({ status: 'error', error: `Facebook reports: ${checkJson.error.message || JSON.stringify(checkJson.error)}` })
                .eq('id', post.id);
              console.log(`[mav-bridge][fb-reconcile] ${post.post_date} NOT found on Facebook — marked error`);
            } else if (checkJson.is_published === false) {
              // Scheduled but Facebook hasn't published it yet this second.
              // Leave as 'scheduled' and let the next tick re-verify.
              console.log(`[mav-bridge][fb-reconcile] ${post.post_date} not yet published — leaving scheduled`);
            } else {
              await supabase.from('weekly_posts')
                .update({ status: 'posted', posted_at: new Date().toISOString() })
                .eq('id', post.id);
              console.log(`[mav-bridge][fb-reconcile] ${post.post_date} verified + marked posted`);
            }
          } catch (e) {
            // Network error — can't confirm. Don't flip the row either way.
            console.log(`[mav-bridge][fb-reconcile] ${post.post_date} verify failed (${e.message}) — leaving scheduled`);
          }
        } else {
          // No post ID / no token to verify — trust the schedule.
          await supabase.from('weekly_posts')
            .update({ status: 'posted', posted_at: new Date().toISOString() })
            .eq('id', post.id);
          console.log(`[mav-bridge][fb-reconcile] ${post.post_date} no platform_post_id — trusting schedule, marked posted`);
        }
      }
    }

    // ── Stuck-posting TTL recovery ────────────────
    // A worker crash mid-post can leave a row parked in 'posting' forever, which
    // both blocks re-runs (nothing else picks it up) and hides the failure from
    // the dashboard. Anything still 'posting' after 30 minutes gets force-reset to
    // 'error' so it surfaces and can be retried/approved again.
    try {
      const POSTING_TTL_MS = 30 * 60 * 1000;
      const { data: stuckPosting } = await supabase.from('weekly_posts')
        .select('id, run_id, platform, updated_at')
        .eq('status', 'posting')
        .lt('updated_at', new Date(Date.now() - POSTING_TTL_MS).toISOString());
      for (const row of stuckPosting || []) {
        await supabase.from('weekly_posts')
          .update({ status: 'error', error: 'Stuck in posting state >30min — auto-reset' })
          .eq('id', row.id);
        console.log(`[mav-bridge][stuck-recovery] Reset ${row.platform} post ${row.id} from posting → error`);
      }
    } catch (e) {
      console.error(`[mav-bridge][stuck-recovery] ${e.message}`);
    }

    // ── Non-silent fault detection ───────────────
    // Failed rows and rows stuck in-process past their per-type threshold both
    // alert once (deduped). Recovered rows clear their dedup key so a future
    // recurrence re-alerts.
    try {
      // Only consider recently-updated rows — never alert on stale historical faults.
      const faultCutoff = new Date(Date.now() - FAULT_RECENCY_MS).toISOString();
      const { data: faultRuns, error: faultRunsErr } = await supabase.from('seo_runs')
        .select('id,status,updated_at,error').in('status', ['error', 'executing']).gte('updated_at', faultCutoff);
      const { data: faultPosts, error: faultPostsErr } = await supabase.from('weekly_posts')
        .select('id,run_id,platform,status,updated_at,error,post_date').in('status', ['error', 'needs_verification', 'posting']).gte('updated_at', faultCutoff);
      const { data: faultTasks, error: faultTasksErr } = await supabase.from('website_tasks')
        .select('id,run_id,status,updated_at,error,title').in('status', ['error', 'executing']).gte('updated_at', faultCutoff);
      if (faultRunsErr || faultPostsErr || faultTasksErr) {
        console.warn(`[mav-bridge][fault-detect] query error: ${(faultRunsErr || faultPostsErr || faultTasksErr).message}`);
      }

      // On a cold start (empty store) the first pass only records the baseline.
      const seeding = faultStoreWasEmpty && !faultBaselineSeeded;

      const checkRow = async (row, thresholdKey, label) => {
        const b = bucketStatus(row.status);
        const isFailed = b === 'failed';
        const isStuckRow = b === 'in_process' && isStuck(thresholdKey, row.updated_at);
        if (!isFailed && !isStuckRow) {
          // healthy now — clear both dedup keys so a recurrence re-alerts
          alertStore.clearFault(row.run_id || row.id, row.id, 'failed');
          alertStore.clearFault(row.run_id || row.id, row.id, 'stuck');
          return;
        }
        const faultType = isFailed ? 'failed' : 'stuck';
        if (seeding) {
          // Adopt as baseline without alerting (avoids a cold-start alert blast).
          alertStore.record(row.run_id || row.id, row.id, faultType);
          return;
        }
        if (isFailed) {
          await notifyAlert({ runId: row.run_id || row.id, actionId: row.id, faultType: 'failed',
            title: `Failed: ${label}`, detail: row.error || 'Action failed — check run logs.' });
        } else {
          await notifyAlert({ runId: row.run_id || row.id, actionId: row.id, faultType: 'stuck',
            title: `Stuck: ${label}`, detail: `In process longer than the ${thresholdKey} limit (since ${row.updated_at}).` });
        }
      };

      await Promise.all([
        ...(faultRuns || []).map(r => checkRow(r, 'seo_run', `SEO Run ${(r.id || '').slice(0, 8)}`)),
        ...(faultPosts || []).map(p => checkRow(p,
          p.platform === 'facebook' ? 'weekly_post_facebook' : 'weekly_post_gbp',
          `${p.platform} post ${p.post_date || ''}`.trim())),
        ...(faultTasks || []).map(t => checkRow(t, 'website_task', t.title || `Task ${(t.id || '').slice(0, 8)}`)),
      ]);

      // Seal the baseline only if all three fault queries succeeded this pass. If
      // any errored, the adopted set is incomplete — leave faultBaselineSeeded false
      // so the next poll re-seeds rather than alerting on the rows we missed.
      if (seeding && !faultRunsErr && !faultPostsErr && !faultTasksErr) {
        faultBaselineSeeded = true;
        const n = (faultRuns?.length || 0) + (faultPosts?.length || 0) + (faultTasks?.length || 0);
        console.log(`[mav-bridge][fault-detect] cold start: adopted ${n} existing fault(s) as baseline — no alerts sent. Only new faults will alert.`);
      }
    } catch (e) {
      console.error(`[mav-bridge][fault-detect] ${e.message}`);
    }
  } catch (e) {
    console.error(`[mav-bridge][mav-bridge→poll][error] poll exception: ${e.message}`);
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
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [runsRes, postsRes, tasksRes] = await Promise.all([
      supabase.from('seo_runs').select('*')
        .or(`status.in.(pending_approval,approved,awaiting_prompt,executing,error),and(status.eq.done,done_at.gte.${since48h})`)
        .order('created_at', { ascending: false }).limit(20),
      supabase.from('weekly_posts').select('*')
        .or(`status.in.(pending_approval,approved,scheduled,posting,error,needs_verification),and(status.eq.posted,posted_at.gte.${since48h})`)
        .order('post_date', { ascending: true }).limit(60),
      supabase.from('website_tasks').select('*')
        .in('status', ['pending_approval', 'approved', 'executing', 'error'])
        .gte('created_at', since7d)
        .order('priority').limit(20),
    ]);

    const runs = runsRes.data || [];
    const posts = postsRes.data || [];
    const tasks = tasksRes.data || [];

    const enrich = (row, type) => {
      const a = { ...row, type };
      const bucket = bucketStatus(row.status);
      const thresholdKey = type === 'seo_run' ? 'seo_run'
        : type === 'website_task' ? 'website_task'
        : (row.platform === 'facebook' ? 'weekly_post_facebook' : 'weekly_post_gbp');
      const stuck = bucket === 'in_process' && isStuck(thresholdKey, row.updated_at);
      const status = stuck ? 'failed' : bucket;
      const status_detail = stuck ? 'stuck' : row.status;
      const needsApproval = row.status === 'pending_approval' || row.status === 'awaiting_prompt';
      const isApproved = row.status === 'approved';
      return {
        id: row.id,
        type,
        title: row.title || row.service || (type === 'seo_run' ? `SEO Run ${row.week_of || (row.id || '').slice(0, 8)}` : `${type} ${(row.id || '').slice(0, 8)}`),
        description: describeAction(a, row.description),
        priority: (row.priority || (type === 'seo_run' ? 'high' : 'medium')),
        status,
        status_detail,
        assigned_agent: agentFor(a),
        platform: row.platform || (type === 'website_task' ? 'website_cms' : type === 'seo_run' ? 'pipeline' : null),
        // ponytail: weekly_posts.media_status column may not exist pre-migration; undefined falls through to fallback
        media_status: type === 'weekly_post' ? (row.media_status || (row.status === 'posted' ? 'none' : 'n/a')) : 'n/a',
        error: row.error || null,
        executing_since: bucket === 'in_process' ? (row.updated_at || null) : null,
        updated_at: row.updated_at || row.created_at || null,
        approval_required: needsApproval,
        approval: isApproved ? { approved: true, status: row.status } : null,
        live_adapter: 'mav-bridge',
        posts_count: type === 'seo_run' ? posts.filter(p => p.run_id === row.id).length : undefined,
      };
    };

    const actions = [
      ...runs.map(r => enrich(r, 'seo_run')),
      ...posts.map(p => enrich(p, 'weekly_post')),
      ...tasks.map(t => enrich(t, 'website_task')),
    ];

    const alerts = actions
      .filter(a => a.status === 'failed')
      .map(a => ({
        id: `${a.id}:${a.status_detail === 'stuck' ? 'stuck' : 'failed'}`,
        severity: a.status_detail === 'stuck' ? 'warn' : 'error',
        title: a.status_detail === 'stuck' ? `Stuck: ${a.title}` : `Failed: ${a.title}`,
        detail: a.error || (a.status_detail === 'stuck' ? `In process longer than the ${a.type} limit.` : 'Action failed — check run logs.'),
        action_id: a.id,
        fault_type: a.status_detail === 'stuck' ? 'stuck' : 'failed',
      }));

    sendJsonHttp(res, 200, {
      actions,
      alerts,
      summary: {
        needs_approval: actions.filter(a => a.approval_required).length,
        in_process: actions.filter(a => a.status === 'in_process').length,
        completed: actions.filter(a => a.status === 'completed').length,
        failed: actions.filter(a => a.status === 'failed').length,
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

  // ── POST /seo/actions/dismiss ────────────────
  if (method === 'POST' && url.pathname === '/seo/actions/dismiss') {
    const { actionId } = await readBody(req);
    if (!actionId) { sendJsonHttp(res, 400, { error: 'actionId required' }); return; }

    const { data: task, error: taskErr } = await supabase.from('website_tasks')
      .update({ status: 'skipped' })
      .eq('id', actionId)
      .in('status', ['pending_approval', 'error'])
      .select().maybeSingle();
    if (taskErr) { sendJsonHttp(res, 500, { error: taskErr.message }); return; }
    if (task) { sendJsonHttp(res, 200, { ok: true, type: 'website_task', id: task.id, message: 'Task skipped.' }); return; }

    const { data: post, error: postErr } = await supabase.from('weekly_posts')
      .update({ status: 'skipped' })
      .eq('id', actionId)
      .in('status', ['pending_approval', 'error'])
      .select().maybeSingle();
    if (postErr) { sendJsonHttp(res, 500, { error: postErr.message }); return; }
    if (post) { sendJsonHttp(res, 200, { ok: true, type: 'weekly_post', id: post.id, message: 'Post skipped.' }); return; }

    sendJsonHttp(res, 404, { error: 'Action not found or cannot be dismissed' });
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
    // Inbound hop: Vercel → Tailscale → server.mjs → here. Tag it so a failure
    // in request handling is attributable to this boundary (Fix 5).
    console.error(`[mav-bridge][server.mjs→mav-bridge][error] ${req.method} ${req.url}: ${e.message}`);
    try { sendJsonHttp(res, 500, { error: 'Internal server error', hop: 'mav-bridge', detail: e.message }); } catch {}
  });
});
httpServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[mav-bridge] HTTP server listening on http://127.0.0.1:${BRIDGE_PORT}`);
});

poll(); // run immediately on start
setInterval(poll, POLL_INTERVAL_MS);
