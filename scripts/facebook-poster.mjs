#!/usr/bin/env node
/**
 * facebook-poster.mjs
 * Single consolidated Facebook posting module for Grizzly Electrical Solutions.
 *
 * Replaces the three previous overlapping files:
 *   - facebook-poster-adapter.mjs      (single post via Graph API)
 *   - facebook-post-week.mjs           (whole-week batch + Playwright)
 *   - facebook-playwright-adapter.mjs  (single post via Playwright + login)
 *
 * Posting strategy:
 *   1. Graph API is the PRIMARY path (no browser needed).
 *   2. On a token-expiry error the Graph call retries once after re-resolving the
 *      Page token; if it still fails it throws a clear "regenerate your token" error.
 *   3. Playwright is an OPTIONAL fallback, used ONLY when explicitly enabled with
 *      FB_USE_PLAYWRIGHT=1 (it is never selected automatically).
 *
 * Modes:
 *   node facebook-poster.mjs --payload <json> [--dry-run]   # post ONE item (dashboard action queue)
 *   node facebook-poster.mjs [--schedule-all] [--time HH:MM] [--start-day N] [--end-day N] [--dry-run]
 *                                                            # whole week from facebook_posting_schedule.md (mav-bridge)
 *   node facebook-poster.mjs --check-token                  # print FB_PAGE_ACCESS_TOKEN status JSON
 *   node facebook-poster.mjs --auth                         # Playwright: first-time browser login
 *
 * Single-post payload shape:
 *   { "live": true, "action": { "id": "...", "post": {
 *       "type": "text|photo|video", "headline", "hook", "body", "hashtags",
 *       "photo_file", "video_prompt", "cta", "date", "day" } } }
 *
 * Required env (or .env):
 *   FB_PAGE_ID            — numeric Facebook Page ID
 *   FB_PAGE_ACCESS_TOKEN  — long-lived Page Access Token
 * Optional env:
 *   FB_USE_PLAYWRIGHT     — "1" to use Playwright browser automation instead of the Graph API
 *   FB_PAGE_URL           — page URL for Playwright (falls back to https://facebook.com/<FB_PAGE_ID>)
 *   FB_GRAPH_API_VERSION  — Graph API version (default v22.0)
 *   FB_VIDEO_OUTPUT_DIR   — where Gemini videos are saved (default outputs/fb-videos)
 *   GEMINI_VIDEO_GENERATOR — path to gemini-video-generator.mjs
 *   GBP_PHOTO_PATH        — folder of GBP post photos used as video fallback
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
let FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const USE_PLAYWRIGHT = /^(1|true|yes|on)$/i.test(process.env.FB_USE_PLAYWRIGHT || '');

const FB_PAGE_URL = process.env.FB_PAGE_URL
  || (FB_PAGE_ID ? `https://www.facebook.com/${FB_PAGE_ID}` : '');
const VIDEO_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');
const GEMINI_VIDEO_GEN = process.env.GEMINI_VIDEO_GENERATOR
  || path.join(__dirname, 'gemini-video-generator.mjs');
const GBP_PHOTO_PATH = process.env.GBP_PHOTO_PATH
  || String.raw`C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos`;
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const LOGO_PATH = process.env.GRIZZLY_LOGO_PATH || path.join(PROJECT_ROOT, 'assets', 'grizzly-logo.png');
const ENDCARD_PATH = process.env.GRIZZLY_ENDCARD_PATH || path.join(PROJECT_ROOT, 'assets', 'grizzly-endcard.jpg');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Must exceed gemini-video-generator's poll ceiling (90 polls × 8s = 720s) so a
// slow Veo 3 render isn't killed by the parent before it can finish. See Fix 1.
const VIDEO_GEN_TIMEOUT_MS = 13 * 60 * 1000;

// Playwright session/debug locations
const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'fb-session');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'outputs', 'fb-debug');
const VIEWPORT = { width: 1366, height: 900 };

// ---------------------------------------------------------------------------
// Structured per-hop logging (Fix 5)
// Every outbound boundary tags its failures so a vague UI error can be traced
// to the exact hop that broke: dashboard → mav-bridge → facebook-poster → Graph/Playwright.
// All logs go to stderr; stdout is reserved for the final JSON result the caller parses.
// ---------------------------------------------------------------------------

function hopLog(hop, level, message, extra) {
  const rec = { ts: new Date().toISOString(), source: 'facebook-poster', hop, level, message, ...extra };
  console.error(`[facebook-poster][${hop}][${level}] ${message}`);
  if (level === 'error') console.error(`  ↳ ${JSON.stringify(rec)}`);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function buildCaption(post) {
  return [
    post.hook ? `${post.hook}\n\n` : '',
    post.body || post.headline || '',
    post.hashtags ? `\n\n${post.hashtags}` : '',
    post.cta ? `\n\n${post.cta}` : '',
  ].join('').trim();
}

function stripMd(str) {
  return (str || '').replace(/\*\*/g, '').trim();
}

function parseSchedule(filePath) {
  return parseScheduleText(fs.readFileSync(filePath, 'utf8'));
}

export function parseScheduleText(text) {
  const blocks = text.split(/\n\s*---\s*\n/).filter(b => b.includes('DAY:'));
  return blocks.map(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\s*(.*?)\\s*$`, 'm'));
      return m ? stripMd(m[1]) : '';
    };
    return {
      day: parseInt(get('DAY')) || 0,
      date: get('DATE'),
      type: get('TYPE').toLowerCase(),
      service: get('SERVICE'),
      hook: get('HOOK'),
      body: get('BODY'),
      cta: get('CTA'),
      hashtags: get('HASHTAGS'),
      photo_file: get('PHOTO_FILE'),
      video_prompt: get('VIDEO_PROMPT'),
      status: get('STATUS'),
    };
  }).filter(p => p.day > 0).sort((a, b) => a.day - b.day);
}

function resolvePhotoPath(post) {
  const photoFile = post.photo_file || '';
  if (!photoFile) return null;
  if (path.isAbsolute(photoFile)) return fs.existsSync(photoFile) ? photoFile : null;
  const fromGbp = path.join(GBP_PHOTO_PATH, photoFile);
  if (fs.existsSync(fromGbp)) return fromGbp;
  const fromOutputs = path.join(PROJECT_ROOT, 'outputs', photoFile);
  return fs.existsSync(fromOutputs) ? fromOutputs : null;
}

function resolveVideoPath(post) {
  const slug = (post.date || post.day || new Date().toISOString().slice(0, 10)).toString().replace(/\s/g, '-');
  return path.join(VIDEO_OUTPUT_DIR, `fb-video-${slug}.mp4`);
}

function dateTimeToUnix(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0).getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Token handling (Graph API)
// ---------------------------------------------------------------------------

class TokenExpiredError extends Error {}

function isTokenError(graphError) {
  // Graph error code 190 covers expired/invalid OAuth access tokens.
  return graphError && (graphError.code === 190 || graphError.type === 'OAuthException');
}

function tokenErrorMessage(graphError) {
  return `FB_PAGE_ACCESS_TOKEN is expired or invalid (Graph error ${graphError?.code ?? '190'}: `
    + `${graphError?.message || 'OAuthException'}). Regenerate a long-lived Page Access Token at `
    + `https://developers.facebook.com/tools/explorer and update FB_PAGE_ACCESS_TOKEN in .env.`;
}

async function debugToken(token) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/debug_token`
    + `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  return res.json();
}

/**
 * Pure classification of a /debug_token response. Extracted so the expiry-decision
 * logic (the part with real edge cases: invalid / expired / expiring-soon / never-expires)
 * is testable without a network call. See scripts/facebook-poster.selfcheck.mjs.
 */
export function classifyDebugToken(json, nowSec) {
  const data = json?.data || {};
  if (json?.error || data.is_valid === false) {
    return {
      ok: false, level: 'error', valid: false, expired: true,
      message: tokenErrorMessage(json?.error || { code: 190, message: data.error?.message || 'token invalid' }),
    };
  }
  const expiresAt = Number(data.expires_at || 0); // 0 = never expires (long-lived page token)
  if (!expiresAt) {
    return { ok: true, level: 'info', valid: true, neverExpires: true, expiresAt: 0, message: 'FB token valid (no expiry)' };
  }
  const daysLeft = Math.floor((expiresAt - nowSec) / 86400);
  if (daysLeft < 0) {
    return { ok: false, level: 'error', valid: false, expired: true, expiresAt, daysLeft, message: tokenErrorMessage({ code: 190, message: 'token expired' }) };
  }
  if (daysLeft <= 7) {
    return {
      ok: false, level: 'warn', valid: true, expiresAt, daysLeft,
      message: `FB_PAGE_ACCESS_TOKEN expires in ${daysLeft} day(s) (${new Date(expiresAt * 1000).toISOString().slice(0, 10)}). Regenerate it soon at https://developers.facebook.com/tools/explorer`,
    };
  }
  return { ok: true, level: 'info', valid: true, expiresAt, daysLeft, message: `FB token valid (${daysLeft} days left)` };
}

/**
 * Validate FB_PAGE_ACCESS_TOKEN against the /debug_token endpoint. (Fix 4)
 * Returns a structured status; callers log the message at the right level.
 */
export async function checkFacebookToken(token = FB_PAGE_ACCESS_TOKEN) {
  if (!token) {
    return { ok: false, level: 'warn', valid: false, message: 'FB_PAGE_ACCESS_TOKEN not set in .env' };
  }
  let json;
  try {
    json = await debugToken(token);
  } catch (e) {
    return { ok: false, level: 'warn', valid: false, message: `Could not reach Graph debug_token: ${e.message}` };
  }
  return classifyDebugToken(json, Math.floor(Date.now() / 1000));
}

// Re-resolve a Page token from a (possibly user) token. Used once on retry.
async function resolvePageToken() {
  const probe = await debugToken(FB_PAGE_ACCESS_TOKEN).catch(() => ({}));
  if (probe?.data?.type === 'PAGE') return; // already a page token
  hopLog('facebook-poster→graph', 'info', 'User token detected — exchanging for a Page Access Token...');
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}?fields=access_token,name`
    + `&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`
  );
  const json = await res.json();
  if (json.error) throw new TokenExpiredError(tokenErrorMessage(json.error));
  if (!json.access_token) throw new Error('No access_token in page response — ensure pages_manage_posts is granted.');
  FB_PAGE_ACCESS_TOKEN = json.access_token;
  hopLog('facebook-poster→graph', 'info', `Got Page token for: ${json.name}`);
}

// Run a Graph operation, retrying once on token expiry after re-resolving the token. (Fix 3.2)
async function withTokenRetry(label, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof TokenExpiredError)) throw e;
    hopLog('facebook-poster→graph', 'warn', `${label}: token error — re-resolving Page token and retrying once`);
    await resolvePageToken();
    try {
      return await fn();
    } catch (e2) {
      hopLog('facebook-poster→graph', 'error', `${label}: still failing after token refresh`, { detail: e2.message });
      throw new TokenExpiredError(e2 instanceof TokenExpiredError ? e2.message : tokenErrorMessage({ code: 190, message: e2.message }));
    }
  }
}

// ---------------------------------------------------------------------------
// Graph API posting
// ---------------------------------------------------------------------------

async function graphParse(label, res) {
  const json = await res.json();
  if (json.error) {
    if (isTokenError(json.error)) throw new TokenExpiredError(tokenErrorMessage(json.error));
    hopLog('facebook-poster→graph', 'error', `${label} failed`, { code: json.error.code, detail: json.error.message });
    throw new Error(`Graph API (${label}): ${json.error.message}`);
  }
  return json;
}

async function graphPostText(caption, scheduleUnix) {
  const body = new URLSearchParams({ message: caption, access_token: FB_PAGE_ACCESS_TOKEN });
  if (scheduleUnix) { body.append('published', 'false'); body.append('scheduled_publish_time', String(scheduleUnix)); }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/feed`, { method: 'POST', body });
  return (await graphParse('text', res)).id;
}

async function graphPostPhoto(photoPath, caption, scheduleUnix) {
  const form = new FormData();
  form.append('caption', caption);
  form.append('access_token', FB_PAGE_ACCESS_TOKEN);
  form.append('source', new Blob([fs.readFileSync(photoPath)]), path.basename(photoPath));
  if (scheduleUnix) { form.append('published', 'false'); form.append('scheduled_publish_time', String(scheduleUnix)); }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/photos`, { method: 'POST', body: form });
  return (await graphParse('photo', res)).id;
}

async function graphPostVideo(videoPath, caption, scheduleUnix) {
  const fileSize = fs.statSync(videoPath).size;
  const base = `https://graph-video.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/videos`;

  // 1. start upload session
  const startBody = new URLSearchParams({ upload_phase: 'start', file_size: String(fileSize), access_token: FB_PAGE_ACCESS_TOKEN });
  const startJson = await graphParse('video start', await fetch(base, { method: 'POST', body: startBody }));
  const { upload_session_id } = startJson;

  // 2. transfer (single chunk — fine for short Veo clips, well under 1GB)
  const chunkForm = new FormData();
  chunkForm.append('upload_phase', 'transfer');
  chunkForm.append('upload_session_id', upload_session_id);
  chunkForm.append('start_offset', startJson.start_offset);
  chunkForm.append('access_token', FB_PAGE_ACCESS_TOKEN);
  chunkForm.append('video_file_chunk', new Blob([fs.readFileSync(videoPath)]), path.basename(videoPath));
  await graphParse('video transfer', await fetch(base, { method: 'POST', body: chunkForm }));

  // 3. finish
  const finishBody = new URLSearchParams({
    upload_phase: 'finish', upload_session_id, description: caption,
    access_token: FB_PAGE_ACCESS_TOKEN, published: scheduleUnix ? 'false' : 'true',
  });
  if (scheduleUnix) finishBody.append('scheduled_publish_time', String(scheduleUnix));
  const finishJson = await graphParse('video finish', await fetch(base, { method: 'POST', body: finishBody }));
  return finishJson.id || upload_session_id;
}

// Dispatch one post over the Graph API, with token-expiry retry around the whole op.
async function graphDispatch(post, caption, videoPath, scheduleUnix) {
  return withTokenRetry(`day ${post.day ?? '?'} (${post.type})`, async () => {
    if (post.type === 'video' && videoPath && fs.existsSync(videoPath)) {
      hopLog('facebook-poster→graph', 'info', `Uploading video (${(fs.statSync(videoPath).size / 1e6).toFixed(1)} MB)`);
      return graphPostVideo(videoPath, caption, scheduleUnix);
    }
    const fullPhotoPath = resolvePhotoPath(post);
    if (fullPhotoPath) {
      if (post.type === 'video') hopLog('facebook-poster→graph', 'info', `Video unavailable — falling back to photo: ${path.basename(fullPhotoPath)}`);
      else hopLog('facebook-poster→graph', 'info', `Uploading photo: ${path.basename(fullPhotoPath)}`);
      return graphPostPhoto(fullPhotoPath, caption, scheduleUnix);
    }
    if (post.photo_file) hopLog('facebook-poster→graph', 'warn', `Photo not found: ${post.photo_file} — posting as text`);
    return graphPostText(caption, scheduleUnix);
  });
}

// ---------------------------------------------------------------------------
// Gemini video generation
// ---------------------------------------------------------------------------

function addBrandedEndCard(rawPath, finalPath) {
  const cardSrc = fs.existsSync(ENDCARD_PATH) ? ENDCARD_PATH : LOGO_PATH;
  if (!fs.existsSync(cardSrc)) {
    fs.renameSync(rawPath, finalPath);
    return;
  }
  try {
    const probeOut = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', rawPath,
    ], { encoding: 'utf8', timeout: 15000 });
    const stream = JSON.parse(probeOut).streams?.[0] || {};
    const W = stream.width || 720;
    const H = stream.height || 1280;
    const [fpsN, fpsD] = (stream.r_frame_rate || '24/1').split('/').map(Number);
    const fps = Math.round(fpsN / fpsD) || 24;
    execFileSync('ffmpeg', [
      '-y', '-i', rawPath, '-loop', '1', '-t', '3', '-i', cardSrc,
      '-filter_complex', [
        `[1:v]scale=${W}:-1,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}[card]`,
        `[0:v]setsar=1[main]`,
        `[main][card]concat=n=2:v=1:a=0[out]`,
      ].join(';'),
      '-map', '[out]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-an', finalPath,
    ], { timeout: 120000 });
    fs.unlinkSync(rawPath);
  } catch (e) {
    hopLog('facebook-poster→ffmpeg', 'warn', `end card failed (${e.message.slice(0, 120)}) — using raw video`);
    if (fs.existsSync(rawPath)) fs.renameSync(rawPath, finalPath);
  }
}

function generateGeminiVideo(prompt, outputPath, { brand = true } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rawPath = brand ? outputPath.replace(/\.mp4$/, '-raw.mp4') : outputPath;
  const out = execFileSync('node', [GEMINI_VIDEO_GEN, '--prompt', prompt, '--output', rawPath], {
    timeout: VIDEO_GEN_TIMEOUT_MS,
    encoding: 'utf8',
  });
  const lastLine = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
  if (!lastLine) throw new Error('No JSON output from gemini-video-generator');
  const result = JSON.parse(lastLine);
  if (result.status !== 'success') throw new Error(`Video gen failed: ${result.message}`);
  if (brand) {
    hopLog('facebook-poster→ffmpeg', 'info', 'Adding branded end card...');
    addBrandedEndCard(rawPath, outputPath);
  }
  return outputPath;
}

async function generateCinematicPrompt(post) {
  if (post.video_prompt) return post.video_prompt;
  if (!OPENAI_API_KEY) {
    hopLog('facebook-poster→openai', 'warn', 'No OPENAI_API_KEY and no schedule prompt — skipping video.');
    return null;
  }
  const caption = buildCaption(post);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: 300,
      messages: [
        { role: 'system', content: `You are a video director writing Veo 3 generation prompts for Grizzly Electrical Solutions, a licensed residential and commercial electrician in DFW, Texas.\n\nWrite a single vivid, cinematic prompt (100-140 words) that:\n- Opens with an establishing shot that sets a relatable scene (home, family, business)\n- Builds tension around an electrical problem (flickering lights, sparking outlet, dead panel, etc.)\n- Includes a dramatic visual moment — arcing breakers, sparks, smoke, worried faces, a professional electrician arriving\n- Feels like a mini movie trailer — emotional, urgent, real\n- Matches the service and caption topic provided\n- Ends with: Photorealistic, cinematic, 4K, dramatic atmosphere, no text overlays.\n\nOutput the prompt only. No explanation, no quotes, no title.` },
        { role: 'user', content: `Service: ${post.service}\nHook: ${post.hook}\nCaption:\n${caption}` },
      ],
    }),
  });
  const json = await res.json();
  if (json.error) {
    hopLog('facebook-poster→openai', 'warn', `prompt gen error: ${json.error.message} — using schedule prompt`);
    return post.video_prompt || null;
  }
  return json.choices?.[0]?.message?.content?.trim() || post.video_prompt || null;
}

let geminiCreditsDepletedFlag = false;

async function generateAllVideos(posts) {
  const videoPosts = posts.filter(p => p.type === 'video');
  hopLog('facebook-poster', 'info', `Generating ${videoPosts.length} videos upfront...`);
  for (const post of videoPosts) {
    const videoPath = resolveVideoPath(post);
    if (fs.existsSync(videoPath)) {
      hopLog('facebook-poster', 'info', `Day ${post.day}: reusing ${path.basename(videoPath)}`);
      continue;
    }
    try {
      const prompt = await generateCinematicPrompt(post);
      if (!prompt) {
        hopLog('facebook-poster', 'warn', `Day ${post.day}: no video prompt — will post without video`);
        continue;
      }
      generateGeminiVideo(prompt, videoPath);
      hopLog('facebook-poster', 'info', `Day ${post.day}: saved ${path.basename(videoPath)}`);
    } catch (e) {
      const errText = (e.stderr ? e.stderr.toString() : '') + e.message;
      if (/prepayment credits|credits are depleted|RESOURCE_EXHAUSTED/.test(errText)) {
        geminiCreditsDepletedFlag = true;
        hopLog('facebook-poster→gemini', 'warn', `Day ${post.day}: GEMINI CREDITS DEPLETED — will post without video.`);
      } else {
        hopLog('facebook-poster→gemini', 'warn', `Day ${post.day}: video generation failed (${e.message.slice(0, 120)}) — will post without video`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Playwright fallback (only when FB_USE_PLAYWRIGHT=1)
// ---------------------------------------------------------------------------

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const candidates = [
      process.env.PLAYWRIGHT_NODE_MODULE_DIR,
      'C:\\Workspace\\Active\\homelab-noc-dashboard\\homelab-noc-dashboard\\homelab-noc-dashboard\\node_modules',
    ].filter(Boolean);
    for (const dir of candidates) {
      const entry = path.join(dir, 'playwright', 'index.mjs');
      if (fs.existsSync(entry)) return await import(pathToFileURL(entry).href);
    }
    throw new Error('Playwright not found. Set PLAYWRIGHT_NODE_MODULE_DIR or install playwright.');
  }
}

async function saveDebug(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const p = path.join(DEBUG_DIR, `fb-${label}-${stamp}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

async function assertLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  if (/login|checkpoint|recover/i.test(page.url())) {
    throw new Error('Facebook session expired. Re-run: node facebook-poster.mjs --auth');
  }
}

async function switchToPageProfile(page) {
  const switchBtn = page.locator(
    'div[role="button"]:has-text("Switch now"), span:has-text("Switch now"), a:has-text("Switch now"), div[role="button"]:has-text("Switch profiles"), span:has-text("Switch profiles")'
  ).first();
  if (await switchBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await switchBtn.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    hopLog('facebook-poster→playwright', 'info', 'Switched to Grizzly profile.');
    return true;
  }
  return false;
}

async function openPostComposer(page) {
  if (!FB_PAGE_URL) throw new Error('FB_PAGE_URL or FB_PAGE_ID must be set in .env');
  await page.goto(FB_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await assertLoggedIn(page);
  await switchToPageProfile(page);
  const composerSelectors = [
    '[aria-label="Create post"]',
    '[aria-label="Write something..."]',
    'div[role="button"]:has-text("Create post")',
    'div[role="button"]:has-text("Write something")',
    'div[role="button"]:has-text("What\'s on your mind")',
  ];
  for (const sel of composerSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { await el.click({ timeout: 5000 }); break; }
  }
  await page.waitForTimeout(1500);
}

async function typeCaption(page, caption) {
  const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
  await dialog.waitFor({ timeout: 10000 });
  const textarea = dialog.locator('div[contenteditable="true"]').first();
  await textarea.waitFor({ timeout: 10000 });
  await textarea.click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await page.evaluate((text) => {
    const d = document.querySelector('div[role="dialog"]');
    const el = d ? d.querySelector('div[contenteditable="true"]') : null;
    if (el) { el.focus(); document.execCommand('insertText', false, text); }
  }, caption);
  await page.waitForTimeout(500);
  const typed = await textarea.innerText().catch(() => '');
  if (!typed.includes(caption.slice(0, 20))) await textarea.type(caption, { delay: 10 });
}

async function attachMedia(page, post, videoPath) {
  const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
  const attachFile = async (filePath) => {
    const btn = dialog.locator('[aria-label="Photo/video"], [aria-label="Add photos or videos"]').first();
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      btn.click({ timeout: 5000 }),
    ]);
    await fileChooser.setFiles(filePath);
  };
  if (post.type === 'video' && videoPath && fs.existsSync(videoPath)) {
    await attachFile(videoPath);
    hopLog('facebook-poster→playwright', 'info', 'Waiting for video to upload...');
    await page.waitForTimeout(30000);
  } else {
    const fullPhotoPath = resolvePhotoPath(post);
    if (post.type === 'video' && fullPhotoPath) {
      hopLog('facebook-poster→playwright', 'info', `Video unavailable — falling back to photo: ${path.basename(fullPhotoPath)}`);
      await attachFile(fullPhotoPath);
      await page.waitForTimeout(3000);
    } else if (fullPhotoPath) {
      await attachFile(fullPhotoPath);
      await page.waitForTimeout(3000);
    } else if (post.photo_file) {
      hopLog('facebook-poster→playwright', 'warn', `photo not found: ${post.photo_file} — posting as text`);
    }
  }
}

async function dismissPopups(page) {
  const dismissSelectors = [
    'div[role="button"]:text-is("Not now")', 'div[role="button"]:text-is("Close")',
    'div[role="button"]:text-is("Dismiss")', 'div[role="button"]:text-is("Got it")', '[aria-label="Close"]',
  ];
  for (const sel of dismissSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  await page.waitForTimeout(300);
}

async function jsClickButton(page, text) {
  return page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('[role="button"], button'));
    const btn = all.find(b => b.textContent.trim() === t);
    if (btn) { btn.scrollIntoView(); btn.click(); return true; }
    return false;
  }, text);
}

async function clickNextOrPost(page) {
  await dismissPopups(page);
  await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]:not([aria-label="Notifications"])');
    if (dialog) dialog.scrollTop = dialog.scrollHeight;
    const inner = dialog && dialog.querySelector('div[style*="overflow"], div[class*="scroll"]');
    if (inner) inner.scrollTop = inner.scrollHeight;
  });
  await page.waitForTimeout(500);
  const clicked = await jsClickButton(page, 'Next');
  if (clicked) { await page.waitForTimeout(2000); return 'next'; }
  return 'post';
}

async function submitPost(page, caption) {
  const mode = await clickNextOrPost(page);
  if (mode === 'next') {
    const editReelTitle = page.locator('h2:has-text("Edit reel"), div:has-text("Edit reel")').first();
    if (await editReelTitle.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (caption) {
        const titleInput = page.locator('input[placeholder*="title" i], textarea[placeholder*="title" i], input[aria-label*="title" i]').first();
        if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) await titleInput.fill(caption.slice(0, 255));
      }
      await page.waitForTimeout(500);
      const nextBtns = page.getByRole('button', { name: 'Next', exact: true });
      if (await nextBtns.count() > 0) await nextBtns.last().click({ force: true, timeout: 5000 });
      else await page.mouse.click(90, 405);
      await page.waitForTimeout(2000);
    }
    const published = await jsClickButton(page, 'Share now')
      || await jsClickButton(page, 'Publish now') || await jsClickButton(page, 'Publish')
      || await jsClickButton(page, 'Post now') || await jsClickButton(page, 'Post');
    if (!published) throw new Error('Could not find publish button on publishing screen');
  } else {
    if (!await jsClickButton(page, 'Post')) throw new Error('Could not find Post button in composer');
  }
  await page.waitForTimeout(5000);
}

async function schedulePost(page, scheduleDate, scheduleTime, caption) {
  const mode = await clickNextOrPost(page);
  if (mode === 'next') {
    if (caption) {
      const captionInput = page.locator('div[contenteditable="true"], textarea').first();
      if (await captionInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await captionInput.click().catch(() => {});
        await page.evaluate((text) => {
          const el = document.querySelector('div[contenteditable="true"], textarea');
          if (el) { el.focus(); document.execCommand('insertText', false, text); }
        }, caption);
        await page.waitForTimeout(500);
      }
    }
    const scheduleOpt = page.locator('div[role="button"]:has-text("Schedule"), label:has-text("Schedule"), span:has-text("Schedule for later")').first();
    if (await scheduleOpt.isVisible({ timeout: 3000 }).catch(() => false)) { await scheduleOpt.click({ timeout: 5000 }); await page.waitForTimeout(1000); }
  } else {
    const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
    const nextBtn = dialog.locator('div[role="button"]:text-is("Next"), button:text-is("Next")').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) { await nextBtn.click({ timeout: 10000 }); await page.waitForTimeout(2000); }
    for (const sel of ['label:has-text("Schedule")', 'div[role="button"]:has-text("Schedule post")', 'span:has-text("Schedule post")', 'div[role="radio"]:has-text("Schedule")']) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { await el.click({ timeout: 5000 }); await page.waitForTimeout(1000); break; }
    }
  }
  const dateInput = page.locator('input[type="date"], input[placeholder*="date" i], input[aria-label*="date" i]').first();
  if (await dateInput.isVisible({ timeout: 5000 }).catch(() => false)) { await dateInput.fill(scheduleDate); await page.waitForTimeout(500); }
  const timeInput = page.locator('input[type="time"], input[placeholder*="time" i], input[aria-label*="time" i]').first();
  if (await timeInput.isVisible({ timeout: 3000 }).catch(() => false)) { await timeInput.fill(scheduleTime); await page.waitForTimeout(500); }
  for (const sel of ['div[role="button"]:text-is("Schedule")', 'button:text-is("Schedule")', 'div[role="button"]:text-is("Schedule post")', 'div[role="button"]:text-is("Save")']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { await el.click({ timeout: 10000 }); break; }
  }
  await Promise.race([
    page.locator('div[role="dialog"]').waitFor({ state: 'hidden', timeout: 30000 }),
    page.waitForNavigation({ timeout: 30000 }),
  ]).catch(() => {});
  await page.waitForTimeout(2000);
}

async function withPlaywrightPage(fn) {
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: VIEWPORT });
  const page = await context.newPage();
  try { return await fn(page); }
  finally { await context.close(); }
}

// ---------------------------------------------------------------------------
// Mode: --auth (Playwright login)
// ---------------------------------------------------------------------------

async function runAuth() {
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, viewport: VIEWPORT,
    args: ['--start-maximized'], ignoreDefaultArgs: ['--window-size'],
  });
  const page = await context.newPage();
  console.error('AUTH MODE: Log into Facebook (complete 2FA if needed), then close the window.');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await context.close();
  return { status: 'auth_complete', session_dir: USER_DATA_DIR };
}

// ---------------------------------------------------------------------------
// Mode: --check-token (Fix 4 standalone)
// ---------------------------------------------------------------------------

async function runCheckToken() {
  const status = await checkFacebookToken();
  hopLog('facebook-poster→graph', status.level, status.message);
  return { status: status.ok ? 'ok' : (status.expired ? 'expired' : 'warning'), token: status };
}

// ---------------------------------------------------------------------------
// Mode: single payload post (dashboard action queue)
// ---------------------------------------------------------------------------

async function runSinglePayload(args) {
  const payload = JSON.parse(args.payloadText);
  const action = payload.action || {};
  const post = action.post || {};
  const live = Boolean(payload.live) && !args.dryRun;
  const type = (post.type || 'text').toLowerCase();
  post.type = type;
  const caption = buildCaption(post);

  if (!live) {
    return {
      status: 'dry_run', adapter: 'facebook-poster', action_id: action.id || null, post_type: type,
      date: post.date || post.day || null, headline: post.headline || null,
      caption_preview: caption.slice(0, 200) + (caption.length > 200 ? '...' : ''),
      via: USE_PLAYWRIGHT ? 'playwright' : 'graph', message: 'Dry run — no API call made',
    };
  }

  // Resolve / generate the video file for video posts.
  let videoPath = post.video_file || null;
  if (type === 'video' && !videoPath) {
    if (!post.video_prompt) throw new Error('video_prompt or video_file required for video posts');
    videoPath = resolveVideoPath(post);
    if (!fs.existsSync(videoPath)) {
      hopLog('facebook-poster', 'info', `Generating video via Gemini: ${post.video_prompt.slice(0, 80)}...`);
      try {
        generateGeminiVideo(post.video_prompt, videoPath);
      } catch (e) {
        hopLog('facebook-poster→gemini', 'warn', `video generation failed (${e.message.slice(0, 120)}) — will fall back to photo/text`);
        videoPath = null;
      }
    }
  }

  let postId = null;
  let via;
  if (USE_PLAYWRIGHT) {
    via = 'playwright';
    await withPlaywrightPage(async (page) => {
      await openPostComposer(page);
      await typeCaption(page, caption);
      await attachMedia(page, post, videoPath);
      await submitPost(page, caption);
    });
  } else {
    via = 'graph';
    if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
      throw new Error('FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN must be set in .env (or set FB_USE_PLAYWRIGHT=1)');
    }
    postId = await graphDispatch(post, caption, videoPath, null);
  }

  return {
    status: 'success', adapter: 'facebook-poster', via, action_id: action.id || null, post_type: type,
    post_id: postId, date: post.date || post.day || null, headline: post.headline || null,
    fb_post_url: postId ? `https://www.facebook.com/${String(postId).replace('_', '/posts/')}` : null,
  };
}

// ---------------------------------------------------------------------------
// Mode: whole-week schedule (mav-bridge)
// ---------------------------------------------------------------------------

async function runWeek(args) {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    throw new Error(`Schedule file not found: ${SCHEDULE_FILE}\nRun: seo-agents facebook-schedule`);
  }
  const posts = parseSchedule(SCHEDULE_FILE).filter(p => p.day >= args.startDay && p.day <= args.endDay);
  if (!posts.length) throw new Error('No posts found in schedule file.');

  hopLog('facebook-poster', 'info', `Loaded ${posts.length} posts from schedule (starting day ${args.startDay})`);

  if (args.dryRun) {
    return {
      status: 'dry_run',
      via: USE_PLAYWRIGHT ? 'playwright' : 'graph',
      posts: posts.map(p => ({
        day: p.day, date: p.date, type: p.type, service: p.service,
        action: p.day === 1 && !args.scheduleAll ? 'post_now' : `schedule_${p.date}_${args.postTime}`,
        video_ready: p.type === 'video' ? fs.existsSync(resolveVideoPath(p)) : null,
      })),
    };
  }

  await generateAllVideos(posts);
  for (const p of posts) if (p.type === 'video') p._videoPath = resolveVideoPath(p);

  const results = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  if (USE_PLAYWRIGHT) {
    hopLog('facebook-poster→playwright', 'info', 'FB_USE_PLAYWRIGHT=1 — using browser automation');
    await withPlaywrightPage(async (page) => {
      for (const post of posts) {
        const caption = buildCaption(post);
        const rawScheduleUnix = dateTimeToUnix(post.date, args.postTime);
        const isLive = (post.day === 1 && !args.scheduleAll) || rawScheduleUnix < nowUnix + 600;
        try {
          await openPostComposer(page);
          await typeCaption(page, caption);
          await attachMedia(page, post, post._videoPath || null);
          if (isLive) {
            await submitPost(page, caption);
            results.push({ day: post.day, date: post.date, status: 'posted', type: post.type });
          } else {
            await schedulePost(page, post.date, args.postTime, caption);
            results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type });
          }
        } catch (e) {
          const screenshot = await saveDebug(page, `day${post.day}-failure`);
          results.push({ day: post.day, date: post.date, status: 'error', message: e.message, screenshot });
          hopLog('facebook-poster→playwright', 'error', `Day ${post.day} failed: ${e.message}`);
        }
        await page.waitForTimeout(2000);
      }
    });
  } else {
    if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
      throw new Error('FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN must be set in .env (or set FB_USE_PLAYWRIGHT=1)');
    }
    hopLog('facebook-poster→graph', 'info', 'Using Graph API (no browser)');
    for (const post of posts) {
      const caption = buildCaption(post);
      const rawScheduleUnix = dateTimeToUnix(post.date, args.postTime);
      const isLive = (post.day === 1 && !args.scheduleAll) || rawScheduleUnix < nowUnix + 600;
      const scheduleUnix = isLive ? null : rawScheduleUnix;
      try {
        const id = await graphDispatch(post, caption, post._videoPath || null, scheduleUnix);
        if (isLive) {
          results.push({ day: post.day, date: post.date, status: 'posted', type: post.type, id });
          hopLog('facebook-poster→graph', 'info', `Day ${post.day} posted live (id: ${id})`);
        } else {
          results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type, id });
          hopLog('facebook-poster→graph', 'info', `Day ${post.day} scheduled for ${post.date} ${args.postTime} (id: ${id})`);
        }
      } catch (e) {
        results.push({ day: post.day, date: post.date, status: 'error', message: e.message });
        hopLog('facebook-poster→graph', 'error', `Day ${post.day} failed: ${e.message}`);
      }
    }
  }

  const output = { status: 'complete', results };
  if (geminiCreditsDepletedFlag) output.gemini_credits_depleted = true;
  return output;
}

// ---------------------------------------------------------------------------
// Arg parsing + dispatch
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    payloadText: '', dryRun: false, auth: false, checkToken: false,
    scheduleAll: false, postTime: '09:00', startDay: 1, endDay: 999,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--payload') args.payloadText = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--auth') args.auth = true;
    else if (argv[i] === '--check-token') args.checkToken = true;
    else if (argv[i] === '--schedule-all') args.scheduleAll = true;
    else if (argv[i] === '--time') args.postTime = argv[++i] || '09:00';
    else if (argv[i] === '--start-day') args.startDay = parseInt(argv[++i] || '1');
    else if (argv[i] === '--end-day') args.endDay = parseInt(argv[++i] || '999');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.auth) result = await runAuth();
  else if (args.checkToken) result = await runCheckToken();
  else if (args.payloadText) result = await runSinglePayload(args);
  else result = await runWeek(args);

  // stdout is the machine-readable contract for callers (actions.py / mav-bridge).
  console.log(JSON.stringify(result, null, args.payloadText || args.auth || args.checkToken ? 0 : 2));
  if (result.status === 'error' || result.status === 'expired') process.exitCode = 1;
}

// Only run the CLI when invoked directly — allows mav-bridge to import checkFacebookToken().
const invokedDirectly = process.argv[1]
  && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(__filename)).href;

if (invokedDirectly) {
  main().catch(e => {
    console.log(JSON.stringify({ status: 'error', adapter: 'facebook-poster', message: e.message || String(e) }));
    process.exit(1);
  });
}
