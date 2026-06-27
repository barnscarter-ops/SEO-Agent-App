#!/usr/bin/env node
/**
 * gbp-photo-pick.mjs
 * Weekly photo picker for GBP posts. THE single source of truth for GBP photos.
 *
 * Scans the GBP_PHOTOS_FOLDER (default: H:\My Drive\GBP Photos) for new photos,
 * scores them with GPT-4o vision, picks the best match per post in the weekly
 * schedule, and copies the 7 winners straight to GBP_CURATED_FOLDER.
 *
 * Pipeline (one feed in, one pick out):
 *   1. Photo source — new job photos land in the Drive "GBP Photos" folder via the
 *      Google Drive phone app (auto-upload / "Add to Drive" after a job).
 *      NOTE: the old Google Photos album → Drive sync (grizzly-photos-sync.gs) is
 *      DEAD and removed — Google removed Photos Library API readonly/album access on
 *      2025-03-31, so unattended pulls from a Photos album are no longer possible.
 *   2. Google Drive desktop — mirrors that folder to H:\My Drive\GBP Photos.
 *   3. THIS script — discover → score (cached) → match → copy to Curated
 *      → rewrite PHOTO_FILE in outputs/gbp_posting_schedule.md.
 *   4. mav-bridge.mjs — runs this, then sync-gbp-schedule, then driver.mjs.
 *
 * Replaces the old photo-scanner → photo-matcher two-step AND google-photos-sync.mjs
 * (which used the same dead Photos Library API).
 *
 * Usage:
 *   node gbp-photo-pick.mjs               Run full pick for this week
 *   node gbp-photo-pick.mjs --dry-run     Show selections without copying
 *   node gbp-photo-pick.mjs --rescan      Re-score all photos (ignore cache)
 *
 * Env vars (from .env):
 *   OPENAI_API_KEY
 *   GBP_PHOTOS_FOLDER     Source of photos (H:\My Drive\GBP Photos)
 *   GBP_CURATED_FOLDER    Where picked photos go (E:\Media\Grizzly\Curated)
 *   GBP_PHOTO_CACHE       JSON cache of scored photos (state/photo-cache.json)
 *   GBP_MIN_PHOTO_SCORE   Minimum score to consider (default: 60)
 *   GBP_PHOTOS_YEARS      How many years back to scan (default: 5)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePhotoFile } from './lib/schedule-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env ──────────────────────────────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PHOTOS_FOLDER = process.env.GBP_PHOTOS_FOLDER || 'H:\\My Drive\\GBP Photos';
const CURATED_FOLDER = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';
const CACHE_FILE = process.env.GBP_PHOTO_CACHE || path.join(PROJECT_ROOT, 'state', 'photo-cache.json');
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'gbp_posting_schedule.md');
const MIN_SCORE = parseInt(process.env.GBP_MIN_PHOTO_SCORE || '60');
const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

const dryRun = process.argv.includes('--dry-run');
const rescan = process.argv.includes('--rescan');

// ── Cache helpers ──────────────────────────────────────────────────────────

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Schedule parser ────────────────────────────────────────────────────────

function parseSchedule(text) {
  const posts = [];
  const blocks = text.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const get = (key) => {
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\*{0,2}\\s*(.+?)\\s*$`, 'im'));
      return m ? m[1].trim() : '';
    };
    const date = get('DATE');
    if (!date || date.toLowerCase().includes('day')) continue;
    posts.push({
      date,
      day: get('DAY'),
      service: get('SERVICE'),
      topic: get('TOPIC'),
      headline: get('HEADLINE'),
      body: get('BODY'),
      caption: get('CAPTION'),
      cta: get('CTA'),
      hashtags: get('HASHTAGS'),
      photo_file: normalizePhotoFile(get('PHOTO_FILE')),
    });
  }
  return posts;
}

function updateSchedulePhotoFile(text, date, newPhotoFile) {
  const lines = text.split('\n');
  let inTargetBlock = false;
  const result = [];
  for (const line of lines) {
    if (line.trim() === '---') inTargetBlock = false;
    if (/^\*{0,2}DATE:\*{0,2}\s*/i.test(line) && line.includes(date)) inTargetBlock = true;
    if (inTargetBlock && /^\*{0,2}PHOTO_FILE:\*{0,2}\s*/i.test(line)) {
      result.push(`**PHOTO_FILE:** ${newPhotoFile}`);
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

// ── GPT-4o vision scoring ──────────────────────────────────────────────────

function detectMime(imagePath, buf) {
  // Check magic bytes — Drive sometimes strips extensions
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function scorePhoto(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  let imageBuffer = fs.readFileSync(imagePath);
  let mime = detectMime(imagePath, imageBuffer);

  if (ext === '.heic' || ext === '.heif') {
    try {
      const heicConvert = (await import('heic-convert')).default;
      imageBuffer = Buffer.from(await heicConvert({ buffer: imageBuffer, format: 'JPEG', quality: 0.85 }));
    } catch {
      // heic-convert not installed — skip
      return { score: 0, service_type: 'other', tags: [], reject_reason: 'heic-convert not installed' };
    }
  } else if (ext === '.png') {
    mime = 'image/png';
  } else if (ext === '.webp') {
    mime = 'image/webp';
  }

  const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Score this photo 0-100 for use as a Google Business Profile post for an electrical contractor.

High (70-100): professional electrical work — panels, wiring, conduit, EV chargers, fixtures, completed installs. Clean, well-lit, no faces.
Medium (40-69): electrical work but partially obscured, cluttered, or poorly lit.
Low (0-39): not electrical work, has faces/PII, screenshot, receipt, personal photo, unrelated.

Set "service_type" to ONE of: "panel", "ev-charger", "lighting", "wiring", "outlet", "other"

Tags — pick all that apply:
  panel-upgrade, panel-replacement, main-panel, subpanel, breaker-box, breaker-replacement,
  ev-charger, ev-charging-station, level-2-charger, ev-outlet,
  lighting-fixture, recessed-lighting, outdoor-lighting, ceiling-fan, light-switch, dimmer,
  wiring, wire-run, conduit, romex, junction-box,
  outlet-installation, gfci-outlet, usb-outlet, dedicated-circuit,
  electrical-safety, smoke-detector, whole-home, service-upgrade

Reply ONLY with JSON: {"score":<0-100>,"service_type":"<type>","tags":["tag1"],"reject_reason":"<blank if score>=60>"}`,
          },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content?.trim() || '{"score":0}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { score: 0, service_type: 'other', tags: [], reject_reason: 'parse error' };
  }
}

// ── Service type matching ──────────────────────────────────────────────────

const SERVICE_TYPE_KEYWORDS = {
  panel: ['panel', 'breaker', 'main panel', 'subpanel', 'electrical panel', 'box'],
  'ev-charger': ['ev', 'charger', 'electric vehicle', 'level 2', 'charging station', 'tesla'],
  lighting: ['light', 'fixture', 'recessed', 'ceiling fan', 'dimmer', 'lamp', 'led', 'illuminat'],
  wiring: ['wiring', 'wire', 'conduit', 'romex', 'junction', 'rewir'],
  outlet: ['outlet', 'gfci', 'receptacle', 'plug', 'usb', 'circuit'],
};

function derivePostServiceType(post) {
  const text = `${post.service} ${post.topic} ${post.headline} ${post.body || ''}`.toLowerCase();
  for (const [type, keywords] of Object.entries(SERVICE_TYPE_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return type;
  }
  return 'other';
}

function serviceSlug(service) {
  return (service || 'electrical')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// ── Photo discovery ────────────────────────────────────────────────────────

function isLikelyImage(filePath) {
  try {
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // JPEG, PNG, WebP, HEIC (ftyp box), GIF
    if (buf[0] === 0xFF && buf[1] === 0xD8) return true;
    if (buf[0] === 0x89 && buf[1] === 0x50) return true;
    if (buf[0] === 0x52 && buf[1] === 0x49) return true;
    if (buf[4] === 0x66 && buf[5] === 0x74) return true; // ftyp (HEIC/MP4 offset 4)
  } catch { /* unreadable */ }
  return false;
}

function discoverPhotos(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { recursive: true, withFileTypes: false })
    .map(f => path.join(folder, f.toString()))
    .filter(f => {
      try {
        if (!fs.statSync(f).isFile()) return false;
        const ext = path.extname(f).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) return true;
        if (ext === '') return isLikelyImage(f); // Drive sometimes strips extensions
        return false;
      } catch { return false; }
    });
}

// ── GPT-4o text-based post-to-photo matching ──────────────────────────────

async function matchPhotosToSchedule(posts, photos) {
  const catalog = photos.map((p, i) => ({
    idx: i + 1,
    filename: path.basename(p.filePath),
    score: p.effectiveScore ?? p.score,
    service_type: p.service_type,
    tags: (p.tags || []).join(', ') || 'electrical work',
  }));

  const postSummaries = posts.map((p, i) =>
    `Post ${i + 1} (${p.date}): service="${p.service}", topic="${p.topic}", headline="${p.headline}"` +
    (p.body ? `, body="${p.body.slice(0, 150)}"` : '')
  ).join('\n');

  const catalogText = catalog.map(p =>
    `Photo ${p.idx}: "${p.filename}" score=${p.score} service_type=${p.service_type} tags: ${p.tags}`
  ).join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Match photos to GBP posts for Grizzly Electrical Solutions. Each post gets exactly one photo, no repeats.

POSTS:
${postSummaries}

PHOTOS:
${catalogText}

Rules:
- Match service_type first: panel post → panel photo, ev-charger post → ev-charger photo, etc.
- Within matching type, prefer higher score.
- Only use a mismatched type if zero correct-type photos exist.

Reply ONLY with a JSON array of ${posts.length} photo numbers (1-based), one per post:
[photoNum1, photoNum2, ...]`,
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content?.trim() || '[]';
  try {
    const indices = JSON.parse(text.replace(/```json|```/g, '').trim());
    return indices.map(i => photos[i - 1] || null);
  } catch {
    throw new Error(`Failed to parse GPT match response: ${text}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set in .env'); process.exit(1); }

  if (!fs.existsSync(SCHEDULE_FILE)) {
    console.error(`Schedule not found: ${SCHEDULE_FILE}`);
    console.error('Run the SEO agents pipeline first to generate gbp_posting_schedule.md');
    process.exit(1);
  }

  if (!fs.existsSync(PHOTOS_FOLDER)) {
    console.error(`Photos folder not found: ${PHOTOS_FOLDER}`);
    console.error(`Add photos to that folder or set GBP_PHOTOS_FOLDER in .env`);
    process.exit(1);
  }

  console.log(`\n=== GBP Weekly Photo Pick ===`);
  console.log(`Source: ${PHOTOS_FOLDER}`);
  console.log(`Curated: ${CURATED_FOLDER}`);
  if (dryRun) console.log('(dry run — no files will be copied)\n');

  // ── Step 1: Discover photos ──────────────────────────────────────────────
  const allFiles = discoverPhotos(PHOTOS_FOLDER);
  console.log(`\nFound ${allFiles.length} photos in source folder`);

  if (!allFiles.length) {
    console.error('No photos found. Add electrical job photos to:');
    console.error(`  ${PHOTOS_FOLDER}`);
    process.exit(1);
  }

  // ── Step 2: Score new photos (cache prevents re-scoring) ─────────────────
  const cache = rescan ? {} : loadCache();
  const toScore = allFiles.filter(f => !cache[f]);

  if (toScore.length > 0) {
    console.log(`Scoring ${toScore.length} new photos (${allFiles.length - toScore.length} cached)...`);
    for (const filePath of toScore) {
      const filename = path.basename(filePath);
      process.stdout.write(`  ${filename}... `);
      try {
        const result = await scorePhoto(filePath);
        const label = result.score >= MIN_SCORE ? `✓ ${result.score} [${result.service_type}]` : `✗ ${result.score} (${result.reject_reason || 'low score'})`;
        console.log(label);
        const mtime = fs.statSync(filePath).mtimeMs;
        cache[filePath] = {
          filePath,
          filename,
          score: result.score,
          service_type: result.service_type || 'other',
          tags: result.tags || [],
          scoredAt: new Date().toISOString(),
          photoDate: mtime,
        };
        saveCache(cache);
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
        cache[filePath] = { filePath, filename, score: -1, service_type: 'other', tags: [], error: e.message };
        saveCache(cache);
      }
    }
  } else {
    console.log(`All ${allFiles.length} photos already scored (use --rescan to re-score)`);
  }

  // ── Step 3: Filter to usable photos, ranked by score + recency ───────────
  const now = Date.now();
  const DAY = 86400000;

  function recencyBonus(entry) {
    // Backfill mtime for cache entries that predate this field
    if (!entry.photoDate) {
      try { entry.photoDate = fs.statSync(entry.filePath).mtimeMs; } catch { entry.photoDate = 0; }
    }
    const ageDays = (now - entry.photoDate) / DAY;
    // Up to +20 pts for very recent; fades to 0 at 365 days. Only applies if score >= 65.
    if (entry.score < 65) return 0;
    if (ageDays <= 30)  return 20;
    if (ageDays <= 90)  return 14;
    if (ageDays <= 180) return 8;
    if (ageDays <= 365) return 4;
    return 0;
  }

  const usable = allFiles
    .map(f => cache[f])
    .filter(e => e && e.score >= MIN_SCORE)
    .map(e => ({ ...e, effectiveScore: e.score + recencyBonus(e) }))
    .sort((a, b) => b.effectiveScore - a.effectiveScore);

  console.log(`\nUsable photos (score >= ${MIN_SCORE}): ${usable.length} of ${allFiles.length}`);

  if (!usable.length) {
    console.error(`No photos scored >= ${MIN_SCORE}. Add better photos or lower GBP_MIN_PHOTO_SCORE.`);
    process.exit(1);
  }

  // ── Step 4: Load schedule ─────────────────────────────────────────────────
  let scheduleText = fs.readFileSync(SCHEDULE_FILE, 'utf8');
  const posts = parseSchedule(scheduleText);

  if (!posts.length) {
    console.error('No posts found in schedule. Check gbp_posting_schedule.md format.');
    process.exit(1);
  }

  console.log(`Schedule: ${posts.length} posts`);

  const postsToMatch = posts.slice(0, Math.min(posts.length, usable.length));
  if (postsToMatch.length < posts.length) {
    console.warn(`\nWarning: only ${usable.length} usable photos for ${posts.length} posts — some posts won't get a photo`);
  }

  // ── Step 5: Match photos to posts ────────────────────────────────────────
  console.log('\nMatching photos to posts...');
  let matches;
  try {
    matches = await matchPhotosToSchedule(postsToMatch, usable);
  } catch (e) {
    console.error(`GPT matching failed: ${e.message}`);
    // Fallback: assign by service_type order
    matches = postsToMatch.map(post => {
      const postType = derivePostServiceType(post);
      return usable.find(p => p.service_type === postType) || usable[0] || null;
    });
  }

  // ── Step 6: Copy winners to Curated ──────────────────────────────────────
  if (!dryRun) fs.mkdirSync(CURATED_FOLDER, { recursive: true });

  const usedFilenames = new Set();
  let successCount = 0;

  console.log('');
  for (let i = 0; i < postsToMatch.length; i++) {
    const post = postsToMatch[i];
    let photo = matches[i];

    // Deduplicate — if GPT picked the same photo twice, grab next best unused
    if (photo && usedFilenames.has(photo.filename)) {
      photo = usable.find(p => !usedFilenames.has(p.filename) && p.service_type === (photo?.service_type || 'other'))
           || usable.find(p => !usedFilenames.has(p.filename))
           || null;
    }

    if (!photo) {
      console.log(`  ${post.date} [${post.service}] → NO PHOTO AVAILABLE`);
      continue;
    }

    const ext = path.extname(photo.filename);
    const destFilename = `${post.date}-${serviceSlug(post.service)}${ext}`;
    const destPath = path.join(CURATED_FOLDER, destFilename);

    const bonus = (photo.effectiveScore ?? photo.score) - photo.score;
    const scoreStr = bonus > 0 ? `${photo.score}+${bonus}=${photo.effectiveScore}` : `${photo.score}`;
    console.log(`  ${post.date} [${post.service}] → ${photo.filename} (score: ${scoreStr}, type: ${photo.service_type})`);
    console.log(`    → ${destFilename}`);

    if (!dryRun) {
      fs.copyFileSync(photo.filePath, destPath);
      scheduleText = updateSchedulePhotoFile(scheduleText, post.date, destPath);
    }

    usedFilenames.add(photo.filename);
    successCount++;
  }

  if (!dryRun && successCount > 0) {
    fs.writeFileSync(SCHEDULE_FILE, scheduleText);
    console.log(`\n✓ Done: ${successCount}/${postsToMatch.length} posts matched`);
    console.log(`  Curated folder: ${CURATED_FOLDER}`);
    console.log(`  Schedule updated: ${SCHEDULE_FILE}`);
    console.log(`\nNext: node scripts/sync-gbp-schedule.mjs`);
  } else if (dryRun) {
    console.log(`\n✓ Dry run complete: ${successCount}/${postsToMatch.length} posts would be matched`);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
