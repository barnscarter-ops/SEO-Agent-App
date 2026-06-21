#!/usr/bin/env node
/**
 * facebook-post-week.mjs
 * Reads facebook_posting_schedule.md, generates all videos upfront,
 * then in a single browser session:
 *   - Posts Day 1 immediately (or schedules it if --schedule-all)
 *   - Schedules Days 2–7 using Facebook's built-in post scheduler
 *
 * Usage:
 *   node facebook-post-week.mjs [--dry-run] [--schedule-all] [--time HH:MM]
 *
 * Options:
 *   --dry-run        Show what would be posted/scheduled, no browser
 *   --schedule-all   Schedule ALL 7 days (including day 1) instead of posting day 1 live
 *   --time HH:MM     Time of day to schedule posts (default: 09:00)
 *   --start-day N    Start from day N (default: 1)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const FB_PAGE_URL = process.env.FB_PAGE_URL
  || (process.env.FB_PAGE_ID ? `https://www.facebook.com/${process.env.FB_PAGE_ID}` : '');
const GEMINI_VIDEO_GEN = process.env.GEMINI_VIDEO_GENERATOR
  || path.join(__dirname, 'gemini-video-generator.mjs');
const VIDEO_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');
const GBP_PHOTO_PATH = process.env.GBP_PHOTO_PATH
  || String.raw`C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos`;
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'fb-session');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'outputs', 'fb-debug');
const VIEWPORT = { width: 1366, height: 900 };
const FB_GRAPH_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const FB_GRAPH_PAGE_ID = process.env.FB_PAGE_ID || '';

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, scheduleAll: false, postTime: '09:00', startDay: 1, endDay: 999 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--schedule-all') args.scheduleAll = true;
    else if (argv[i] === '--time') args.postTime = argv[++i] || '09:00';
    else if (argv[i] === '--start-day') args.startDay = parseInt(argv[++i] || '1');
    else if (argv[i] === '--end-day') args.endDay = parseInt(argv[++i] || '999');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Schedule file parser
// ---------------------------------------------------------------------------

function stripMd(str) {
  return (str || '').replace(/\*\*/g, '').trim();
}

function parseSchedule(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const blocks = text.split(/\n\s*---\s*\n/).filter(b => b.includes('DAY:'));
  return blocks.map(block => {
    const get = (key) => {
      // Handles both plain `KEY: value` and bold markdown `**KEY: value**`
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

function buildCaption(post) {
  return [
    post.hook ? `${post.hook}\n\n` : '',
    post.body || '',
    post.hashtags ? `\n\n${post.hashtags}` : '',
    post.cta ? `\n\n${post.cta}` : '',
  ].join('').trim();
}

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

const LOGO_PATH = process.env.GRIZZLY_LOGO_PATH
  || path.join(PROJECT_ROOT, 'assets', 'grizzly-logo.png');
const ENDCARD_PATH = process.env.GRIZZLY_ENDCARD_PATH
  || path.join(PROJECT_ROOT, 'assets', 'grizzly-endcard.jpg');

function addBrandedEndCard(rawPath, finalPath) {
  const cardSrc = fs.existsSync(ENDCARD_PATH) ? ENDCARD_PATH : LOGO_PATH;
  if (!fs.existsSync(cardSrc)) {
    fs.renameSync(rawPath, finalPath);
    return;
  }
  try {
    const probeOut = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'json', rawPath,
    ], { encoding: 'utf8', timeout: 15000 });
    const stream = JSON.parse(probeOut).streams?.[0] || {};
    const W = stream.width || 720;
    const H = stream.height || 1280;
    const [fpsN, fpsD] = (stream.r_frame_rate || '24/1').split('/').map(Number);
    const fps = Math.round(fpsN / fpsD) || 24;

    // Scale card image to fit video width, pad with black to full height, 3 sec
    execFileSync('ffmpeg', [
      '-y',
      '-i', rawPath,
      '-loop', '1', '-t', '3', '-i', cardSrc,
      '-filter_complex', [
        `[1:v]scale=${W}:-1,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}[card]`,
        `[0:v]setsar=1[main]`,
        `[main][card]concat=n=2:v=1:a=0[out]`,
      ].join(';'),
      '-map', '[out]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-an',
      finalPath,
    ], { timeout: 120000 });
    fs.unlinkSync(rawPath);
  } catch (e) {
    console.error(`  Warning: ffmpeg end card failed (${e.message.slice(0, 120)}) — using raw video`);
    if (fs.existsSync(rawPath)) fs.renameSync(rawPath, finalPath);
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

async function generateCinematicPrompt(post) {
  if (post.video_prompt) {
    console.error(`  Using approved VIDEO_PROMPT from schedule.`);
    return post.video_prompt;
  }
  if (!OPENAI_API_KEY) {
    console.error('  No OPENAI_API_KEY and no schedule prompt — skipping video.');
    return null;
  }
  const caption = buildCaption(post);
  console.error(`  Generating cinematic Veo 3 prompt via GPT-4o-mini...`);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a video director writing Veo 3 generation prompts for Grizzly Electrical Solutions, a licensed residential and commercial electrician in DFW, Texas.\n\nWrite a single vivid, cinematic prompt (100-140 words) that:\n- Opens with an establishing shot that sets a relatable scene (home, family, business)\n- Builds tension around an electrical problem (flickering lights, sparking outlet, dead panel, etc.)\n- Includes a dramatic visual moment — arcing breakers, sparks, smoke, worried faces, a professional electrician arriving\n- Feels like a mini movie trailer — emotional, urgent, real\n- Matches the service and caption topic provided\n- Ends with: Photorealistic, cinematic, 4K, dramatic atmosphere, no text overlays.\n\nOutput the prompt only. No explanation, no quotes, no title.`,
        },
        {
          role: 'user',
          content: `Service: ${post.service}\nHook: ${post.hook}\nCaption:\n${caption}`,
        },
      ],
    }),
  });
  const json = await res.json();
  if (json.error) {
    console.error(`  GPT prompt gen error: ${json.error.message} — using schedule prompt`);
    return post.video_prompt;
  }
  const generated = json.choices?.[0]?.message?.content?.trim();
  console.error(`  Prompt: ${generated?.slice(0, 100)}...`);
  return generated || post.video_prompt;
}

function generateGeminiVideo(prompt, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rawPath = outputPath.replace(/\.mp4$/, '-raw.mp4');
  const out = execFileSync('node', [GEMINI_VIDEO_GEN, '--prompt', prompt, '--output', rawPath], {
    timeout: 5 * 60 * 1000,
    encoding: 'utf8',
  });
  const lastLine = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
  if (!lastLine) throw new Error('No JSON output from gemini-video-generator');
  const result = JSON.parse(lastLine);
  if (result.status !== 'success') throw new Error(`Video gen failed: ${result.message}`);
  console.error(`  Adding branded end card...`);
  addBrandedEndCard(rawPath, outputPath);
  return outputPath;
}

function resolveVideoPath(post) {
  return path.join(VIDEO_OUTPUT_DIR, `fb-video-${post.date}.mp4`);
}

let geminiCreditsDepletedFlag = false;

async function generateAllVideos(posts) {
  const videoPosts = posts.filter(p => p.type === 'video');
  console.error(`\nGenerating ${videoPosts.length} videos upfront...`);
  for (const post of videoPosts) {
    const videoPath = resolveVideoPath(post);
    if (fs.existsSync(videoPath)) {
      console.error(`  Day ${post.day}: reusing ${path.basename(videoPath)}`);
      continue;
    }
    console.error(`\n  Day ${post.day}: ${post.service}`);
    try {
      const prompt = await generateCinematicPrompt(post);
      if (!prompt) {
        console.error(`  Day ${post.day}: no video prompt available — will post without video`);
        continue;
      }
      console.error(`  Day ${post.day}: generating video...`);
      generateGeminiVideo(prompt, videoPath);
      console.error(`  Day ${post.day}: saved ${path.basename(videoPath)}`);
    } catch (e) {
      const errText = (e.stderr ? e.stderr.toString() : '') + e.message;
      const isCreditsError = errText.includes('prepayment credits') || errText.includes('credits are depleted') || errText.includes('RESOURCE_EXHAUSTED');
      if (isCreditsError) {
        geminiCreditsDepletedFlag = true;
        console.error(`  Day ${post.day}: GEMINI CREDITS DEPLETED — will post without video. Top up at https://aistudio.google.com/`);
      } else {
        console.error(`  Day ${post.day}: video generation failed (${e.message.slice(0, 120)}) — will post without video`);
      }
    }
  }
  console.error('\nAll videos ready.\n');
}

// ---------------------------------------------------------------------------
// Playwright helpers
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
    throw new Error('Playwright not found.');
  }
}

async function saveDebug(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const p = path.join(DEBUG_DIR, `fb-week-${label}-${stamp}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

async function assertLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  if (/login|checkpoint|recover/i.test(page.url())) {
    throw new Error('Facebook session expired. Re-run: node facebook-playwright-adapter.mjs --auth');
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
    console.error('Switched to Grizzly Electrical Solutions profile.');
    return true;
  }
  console.error('Already on Grizzly profile (or switch button not found).');
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
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 5000 });
      break;
    }
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
    const dialog = document.querySelector('div[role="dialog"]');
    const el = dialog ? dialog.querySelector('div[contenteditable="true"]') : null;
    if (el) { el.focus(); document.execCommand('insertText', false, text); }
  }, caption);
  await page.waitForTimeout(500);
  const typed = await textarea.innerText().catch(() => '');
  if (!typed.includes(caption.slice(0, 20))) {
    await textarea.type(caption, { delay: 10 });
  }
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
    console.error('  Waiting for video to upload...');
    await page.waitForTimeout(30000);
  } else {
    // Photo post, or video post where generation failed — use photo_file
    const fullPhotoPath = resolvePhotoPath(post);
    if (post.type === 'video' && !fullPhotoPath) {
      console.error(`  Video unavailable and no GBP photo found — posting as text only`);
    } else if (post.type === 'video' && fullPhotoPath) {
      console.error(`  Video unavailable — falling back to GBP photo: ${path.basename(fullPhotoPath)}`);
      await attachFile(fullPhotoPath);
      await page.waitForTimeout(3000);
    } else if (fullPhotoPath) {
      await attachFile(fullPhotoPath);
      await page.waitForTimeout(3000);
    } else if (post.photo_file) {
      console.error(`  Warning: photo not found: ${post.photo_file} — posting as text`);
    }
  }
}

// ---------------------------------------------------------------------------
// Click through to publishing options screen (handles both Post and Reel flows)
// Returns the new dialog/screen after clicking Next (if applicable)
// ---------------------------------------------------------------------------

async function dismissPopups(page) {
  // Dismiss any floating popups/banners that might block clicks (e.g. "Add folder", notifications)
  const dismissSelectors = [
    'div[role="button"]:text-is("Not now")',
    'div[role="button"]:text-is("Close")',
    'div[role="button"]:text-is("Dismiss")',
    'div[role="button"]:text-is("Got it")',
    '[aria-label="Close"]',
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

async function clickNextOrPost(page) {
  await dismissPopups(page);
  await saveDebug(page, 'before-next-click');

  // Scroll the dialog to the bottom first, then JS-click Next
  await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]:not([aria-label="Notifications"])');
    if (dialog) dialog.scrollTop = dialog.scrollHeight;
    // Also scroll any inner scrollable container
    const inner = dialog && dialog.querySelector('div[style*="overflow"], div[class*="scroll"]');
    if (inner) inner.scrollTop = inner.scrollHeight;
  });
  await page.waitForTimeout(500);

  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role="button"], button'));
    const btn = all.find(b => b.textContent.trim() === 'Next');
    if (btn) { btn.scrollIntoView(); btn.click(); return true; }
    return false;
  });
  if (clicked) {
    await page.waitForTimeout(2000);
    return 'next';
  }
  return 'post';
}

// ---------------------------------------------------------------------------
// Submit immediately (post now)
// ---------------------------------------------------------------------------

async function jsClickButton(page, text) {
  return page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('[role="button"], button'));
    const btn = all.find(b => b.textContent.trim() === t);
    if (btn) { btn.scrollIntoView(); btn.click(); return true; }
    return false;
  }, text);
}

async function submitPost(page, caption) {
  const mode = await clickNextOrPost(page);

  if (mode === 'next') {
    // Could be "Edit reel" screen (step 2) or publishing screen — check which
    await saveDebug(page, 'post-now-after-next');

    // If we're on the "Edit reel" screen, fill caption and click Next again
    const editReelTitle = page.locator('h2:has-text("Edit reel"), div:has-text("Edit reel")').first();
    if (await editReelTitle.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Fill reel title with the hook (short)
      if (caption) {
        const titleInput = page.locator('input[placeholder*="title" i], textarea[placeholder*="title" i], input[aria-label*="title" i]').first();
        if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await titleInput.fill(caption.slice(0, 255));
        }
      }
      await page.waitForTimeout(500);
      // Click the Next button — use getByRole for reliability, then fallback to force click
      const nextBtns = page.getByRole('button', { name: 'Next', exact: true });
      const nextCount = await nextBtns.count();
      console.error(`  Found ${nextCount} Next button(s) on Edit reel screen`);
      if (nextCount > 0) {
        await nextBtns.last().click({ force: true, timeout: 5000 });
      } else {
        // Nuclear fallback: click by position of blue button at bottom of left panel
        await page.mouse.click(90, 405);
      }
      await page.waitForTimeout(2000);
      await saveDebug(page, 'post-now-publishing-screen');
    }

    // Now on publishing options screen — click "Share now" / "Publish" / "Post"
    const published = await jsClickButton(page, 'Share now')
      || await jsClickButton(page, 'Publish now')
      || await jsClickButton(page, 'Publish')
      || await jsClickButton(page, 'Post now')
      || await jsClickButton(page, 'Post');

    if (!published) throw new Error('Could not find publish button on publishing screen');

  } else {
    // Standard text/photo post — Post button in dialog
    const posted = await jsClickButton(page, 'Post');
    if (!posted) throw new Error('Could not find Post button in composer');
  }

  await page.waitForTimeout(5000);
  await saveDebug(page, 'post-now-after-submit');
}

// ---------------------------------------------------------------------------
// Schedule for a future date
// ---------------------------------------------------------------------------

async function schedulePost(page, scheduleDate, scheduleTime, caption) {
  const mode = await clickNextOrPost(page);
  await saveDebug(page, `schedule-next-${scheduleDate}`);

  if (mode === 'next') {
    // On publishing options screen (Reel flow) — add caption if needed
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
    // Look for schedule option on Reel publishing screen
    const scheduleOpt = page.locator(
      'div[role="button"]:has-text("Schedule"), label:has-text("Schedule"), span:has-text("Schedule for later")'
    ).first();
    if (await scheduleOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await scheduleOpt.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
    }
  } else {
    // Standard post flow — click "Next" from composer to get to scheduling
    const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
    const nextBtn = dialog.locator('div[role="button"]:text-is("Next"), button:text-is("Next")').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nextBtn.click({ timeout: 10000 });
      await page.waitForTimeout(2000);
    }
    // Select "Schedule" option
    const scheduleSelectors = [
      'label:has-text("Schedule")',
      'div[role="button"]:has-text("Schedule post")',
      'span:has-text("Schedule post")',
      'div[role="radio"]:has-text("Schedule")',
    ];
    for (const sel of scheduleSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        break;
      }
    }
  }

  await saveDebug(page, `schedule-picker-${scheduleDate}`);

  // Fill date
  const dateInput = page.locator('input[type="date"], input[placeholder*="date" i], input[aria-label*="date" i]').first();
  if (await dateInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await dateInput.fill(scheduleDate);
    await page.waitForTimeout(500);
  }

  // Fill time
  const timeInput = page.locator('input[type="time"], input[placeholder*="time" i], input[aria-label*="time" i]').first();
  if (await timeInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await timeInput.fill(scheduleTime);
    await page.waitForTimeout(500);
  }

  await saveDebug(page, `schedule-filled-${scheduleDate}`);

  // Confirm scheduling
  const confirmSelectors = [
    'div[role="button"]:text-is("Schedule")',
    'button:text-is("Schedule")',
    'div[role="button"]:text-is("Schedule post")',
    'div[role="button"]:text-is("Save")',
  ];
  for (const sel of confirmSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 10000 });
      break;
    }
  }

  await Promise.race([
    page.locator('div[role="dialog"]').waitFor({ state: 'hidden', timeout: 30000 }),
    page.waitForNavigation({ timeout: 30000 }),
  ]).catch(() => {});
  await page.waitForTimeout(2000);
}

// ---------------------------------------------------------------------------
// Graph API posting (primary path when FB_PAGE_ACCESS_TOKEN is set)
// ---------------------------------------------------------------------------

function dateTimeToUnix(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0).getTime() / 1000);
}

async function graphPostText(caption, scheduleUnix) {
  const body = new URLSearchParams({ message: caption, access_token: FB_GRAPH_TOKEN });
  if (scheduleUnix) { body.append('published', 'false'); body.append('scheduled_publish_time', String(scheduleUnix)); }
  const res = await fetch(`https://graph.facebook.com/v19.0/${FB_GRAPH_PAGE_ID}/feed`, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(`Graph API: ${json.error.message}`);
  return json.id;
}

async function graphPostPhoto(photoPath, caption, scheduleUnix) {
  const formData = new FormData();
  formData.append('caption', caption);
  formData.append('access_token', FB_GRAPH_TOKEN);
  formData.append('source', new Blob([fs.readFileSync(photoPath)]), path.basename(photoPath));
  if (scheduleUnix) { formData.append('published', 'false'); formData.append('scheduled_publish_time', String(scheduleUnix)); }
  const res = await fetch(`https://graph.facebook.com/v19.0/${FB_GRAPH_PAGE_ID}/photos`, { method: 'POST', body: formData });
  const json = await res.json();
  if (json.error) throw new Error(`Graph API: ${json.error.message}`);
  return json.id;
}

async function graphPostVideo(videoPath, caption, scheduleUnix) {
  const fileSize = fs.statSync(videoPath).size;
  // Start upload session
  const startBody = new URLSearchParams({ upload_phase: 'start', file_size: String(fileSize), access_token: FB_GRAPH_TOKEN });
  const startRes = await fetch(`https://graph-video.facebook.com/v19.0/${FB_GRAPH_PAGE_ID}/videos`, { method: 'POST', body: startBody });
  const startJson = await startRes.json();
  if (startJson.error) throw new Error(`Graph API video start: ${startJson.error.message}`);
  const { upload_session_id } = startJson;
  // Upload (single chunk — works up to ~1GB)
  const chunkForm = new FormData();
  chunkForm.append('upload_phase', 'transfer');
  chunkForm.append('upload_session_id', upload_session_id);
  chunkForm.append('start_offset', startJson.start_offset);
  chunkForm.append('access_token', FB_GRAPH_TOKEN);
  chunkForm.append('video_file_chunk', new Blob([fs.readFileSync(videoPath)]), path.basename(videoPath));
  const chunkRes = await fetch(`https://graph-video.facebook.com/v19.0/${FB_GRAPH_PAGE_ID}/videos`, { method: 'POST', body: chunkForm });
  const chunkJson = await chunkRes.json();
  if (chunkJson.error) throw new Error(`Graph API video transfer: ${chunkJson.error.message}`);
  // Finish
  const finishBody = new URLSearchParams({
    upload_phase: 'finish', upload_session_id, description: caption,
    access_token: FB_GRAPH_TOKEN, published: scheduleUnix ? 'false' : 'true',
  });
  if (scheduleUnix) finishBody.append('scheduled_publish_time', String(scheduleUnix));
  const finishRes = await fetch(`https://graph-video.facebook.com/v19.0/${FB_GRAPH_PAGE_ID}/videos`, { method: 'POST', body: finishBody });
  const finishJson = await finishRes.json();
  if (finishJson.error) throw new Error(`Graph API video finish: ${finishJson.error.message}`);
  return finishJson.id || upload_session_id;
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

async function graphDispatch(post, caption, videoPath, scheduleUnix) {
  if (post.type === 'video' && videoPath && fs.existsSync(videoPath)) {
    console.error(`  Uploading video via Graph API (${(fs.statSync(videoPath).size / 1e6).toFixed(1)} MB)...`);
    return graphPostVideo(videoPath, caption, scheduleUnix);
  }
  // Video missing (generation failed) or photo post — use photo_file
  const fullPhotoPath = resolvePhotoPath(post);
  if (fullPhotoPath) {
    if (post.type === 'video') console.error(`  Video unavailable — falling back to GBP photo: ${path.basename(fullPhotoPath)}`);
    else console.error(`  Uploading photo via Graph API: ${path.basename(fullPhotoPath)}`);
    return graphPostPhoto(fullPhotoPath, caption, scheduleUnix);
  }
  if (post.photo_file) console.error(`  Warning: photo not found: ${post.photo_file} — posting as text`);
  console.error(`  Posting text via Graph API...`);
  return graphPostText(caption, scheduleUnix);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(SCHEDULE_FILE)) {
    throw new Error(`Schedule file not found: ${SCHEDULE_FILE}\nRun: seo-agents facebook-schedule`);
  }

  const posts = parseSchedule(SCHEDULE_FILE);
  const filtered = posts.filter(p => p.day >= args.startDay && p.day <= args.endDay);

  if (filtered.length === 0) throw new Error('No posts found in schedule file.');

  console.error(`\nLoaded ${filtered.length} posts from schedule (starting day ${args.startDay}):`);
  for (const p of filtered) {
    console.error(`  Day ${p.day} (${p.date}): ${p.type.toUpperCase()} — ${p.service}`);
  }

  // Dry run
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      posts: filtered.map(p => ({
        day: p.day, date: p.date, type: p.type, service: p.service,
        action: p.day === 1 && !args.scheduleAll ? 'post_now' : `schedule_${p.date}_${args.postTime}`,
        video_ready: p.type === 'video' ? fs.existsSync(resolveVideoPath(p)) : null,
      })),
    }, null, 2));
    return;
  }

  // Generate all videos upfront
  await generateAllVideos(filtered);

  // Resolve video paths
  for (const p of filtered) {
    if (p.type === 'video') p._videoPath = resolveVideoPath(p);
  }

  const results = [];

  if (FB_GRAPH_TOKEN && FB_GRAPH_PAGE_ID) {
    // -----------------------------------------------------------------------
    // Graph API path — no browser needed
    // -----------------------------------------------------------------------
    console.error('\nUsing Graph API (no browser)');
    const nowUnix = Math.floor(Date.now() / 1000);
    for (const post of filtered) {
      const caption = buildCaption(post);
      const rawScheduleUnix = dateTimeToUnix(post.date, args.postTime);
      // If scheduled time is in the past or within 10 min, post live instead
      const scheduleInPast = rawScheduleUnix < nowUnix + 600;
      const isLive = (post.day === 1 && !args.scheduleAll) || scheduleInPast;
      const scheduleUnix = isLive ? null : rawScheduleUnix;
      const action = isLive
        ? (scheduleInPast && args.scheduleAll ? 'POST NOW (9 AM passed)' : 'POST NOW')
        : `SCHEDULE ${args.postTime}`;
      console.error(`\nProcessing Day ${post.day} (${post.date}) — ${action}`);
      try {
        const id = await graphDispatch(post, caption, post._videoPath || null, scheduleUnix);
        if (isLive) {
          results.push({ day: post.day, date: post.date, status: 'posted', type: post.type, id });
          console.error(`  ✓ Day ${post.day} posted live (id: ${id})`);
        } else {
          results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type, id });
          console.error(`  ✓ Day ${post.day} scheduled for ${post.date} at ${args.postTime} (id: ${id})`);
        }
      } catch (e) {
        results.push({ day: post.day, date: post.date, status: 'error', message: e.message });
        console.error(`  ✗ Day ${post.day} failed: ${e.message}`);
      }
    }
  } else {
    // -----------------------------------------------------------------------
    // Playwright fallback — browser automation
    // -----------------------------------------------------------------------
    console.error('\nFB_PAGE_ACCESS_TOKEN not set — falling back to Playwright browser automation');
    const { chromium } = await importPlaywright();
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: VIEWPORT,
    });
    const page = await context.newPage();
    try {
      const nowUnixPw = Math.floor(Date.now() / 1000);
      for (const post of filtered) {
        const caption = buildCaption(post);
        const rawScheduleUnix = dateTimeToUnix(post.date, args.postTime);
        const scheduleInPast = rawScheduleUnix < nowUnixPw + 600;
        const isLive = (post.day === 1 && !args.scheduleAll) || scheduleInPast;
        const action = isLive
          ? (scheduleInPast && args.scheduleAll ? 'POST NOW (9 AM passed)' : 'POST NOW')
          : `SCHEDULE ${args.postTime}`;
        console.error(`\nProcessing Day ${post.day} (${post.date}) — ${action}`);
        try {
          await openPostComposer(page);
          await saveDebug(page, `day${post.day}-composer`);
          await typeCaption(page, caption);
          await attachMedia(page, post, post._videoPath || null);
          if (isLive) {
            await submitPost(page, caption);
            results.push({ day: post.day, date: post.date, status: 'posted', type: post.type });
            console.error(`  ✓ Day ${post.day} posted live`);
          } else {
            await schedulePost(page, post.date, args.postTime, caption);
            results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type });
            console.error(`  ✓ Day ${post.day} scheduled for ${post.date} at ${args.postTime}`);
          }
        } catch (e) {
          const screenshot = await saveDebug(page, `day${post.day}-failure`);
          results.push({ day: post.day, date: post.date, status: 'error', message: e.message, screenshot });
          console.error(`  ✗ Day ${post.day} failed: ${e.message}`);
        }
        await page.waitForTimeout(2000);
      }
    } finally {
      await context.close();
    }
  }

  const output = { status: 'complete', results };
  if (geminiCreditsDepletedFlag) output.gemini_credits_depleted = true;
  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  process.exit(1);
});
