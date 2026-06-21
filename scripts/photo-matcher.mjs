#!/usr/bin/env node
/**
 * photo-matcher.mjs
 * Content-matching photo selector for GBP weekly posts.
 *
 * Reads this week's GBP posting schedule, picks the best matching photo
 * from the Raw pool for each day, copies it to the Curated folder, and
 * rewrites PHOTO_FILE in the schedule so sync-gbp-schedule uses the real path.
 *
 * Run after SEO agents generate gbp_posting_schedule.md, before sync-gbp-schedule.
 *
 * Usage:
 *   node photo-matcher.mjs              Match photos for this week's schedule
 *   node photo-matcher.mjs --dry-run    Show matches without copying files
 *
 * Env vars (from .env):
 *   OPENAI_API_KEY
 *   GBP_RAW_FOLDER      (E:\Media\Grizzly\Raw)
 *   GBP_CURATED_FOLDER  (E:\Media\Grizzly\Curated)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const RAW_FOLDER = process.env.GBP_RAW_FOLDER || 'E:\\Media\\Grizzly\\Raw';
const CURATED_FOLDER = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'gbp_posting_schedule.md');
const INDEX_FILE = path.join(PROJECT_ROOT, 'state', 'raw-photo-index.json');

// ── Index helpers ──────────────────────────────────────────────────────────

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return []; }
}

function saveIndex(index) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ── Schedule parser ────────────────────────────────────────────────────────

function parseSchedule(text) {
  const posts = [];
  const blocks = text.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const get = (key) => {
      // Handle both plain `KEY: value` and bold `**KEY:** value` markdown formats
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
      photo_file: get('PHOTO_FILE'),
    });
  }
  return posts;
}

function updateSchedulePhotoFile(text, date, newPhotoFile) {
  // Replace the PHOTO_FILE line within the block for this date
  const lines = text.split('\n');
  let inTargetBlock = false;
  const result = [];
  for (const line of lines) {
    if (line.trim() === '---') {
      inTargetBlock = false;
    }
    if (/^\*{0,2}DATE:\*{0,2}\s*/i.test(line) && line.includes(date)) {
      inTargetBlock = true;
    }
    if (inTargetBlock && /^\*{0,2}PHOTO_FILE:\*{0,2}\s*/i.test(line)) {
      result.push(`**PHOTO_FILE:** ${newPhotoFile}`);
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

// ── GPT-4o text matching ───────────────────────────────────────────────────

async function pickBestPhotos(posts, availablePhotos) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  // Build a concise photo catalog from index data (tags + score — no vision needed)
  const catalog = availablePhotos.map((p, i) => ({
    idx: i,
    filename: p.filename,
    score: p.score,
    service_type: p.service_type || 'other',
    tags: (p.tags || []).join(', ') || 'electrical work',
  }));

  const postSummaries = posts.map((p, i) =>
    `Post ${i + 1} (${p.date}): Service="${p.service}", Topic="${p.topic}", Headline="${p.headline}"` +
    (p.body ? `, Body="${p.body.slice(0, 200)}"` : '')
  ).join('\n');

  const catalogText = catalog.map(p =>
    `Photo ${p.idx + 1}: "${p.filename}" | score=${p.score} | service_type=${p.service_type} | tags: ${p.tags}`
  ).join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are matching photos to social media posts for Grizzly Electrical Solutions.

POSTS (${posts.length} posts, one photo each, no repeats):
${postSummaries}

AVAILABLE PHOTOS (${catalog.length} photos):
${catalogText}

Rules:
- Each post gets exactly one photo. No photo can be used twice.
- FIRST match on service_type: panel posts → panel photos, ev-charger posts → ev-charger photos, lighting posts → lighting photos, etc.
- A "lighting" service_type photo must NEVER be assigned to a panel post (and vice versa).
- Within matching service_type, prefer higher-scoring photos.
- Only use a mismatched service_type photo if there are ZERO photos of the correct type available.
- Read the post Body text carefully — it describes exactly what the photo must show.

Reply ONLY with a JSON array of ${posts.length} photo indices (1-based, matching the Photo number above), one per post in order:
[photoIdx1, photoIdx2, ...]`,
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content?.trim() || '[]';
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const indices = JSON.parse(clean);
    return indices.map(i => availablePhotos[i - 1] || null);
  } catch {
    throw new Error(`Failed to parse GPT response: ${text}`);
  }
}

// ── Service type helpers ───────────────────────────────────────────────────

const SERVICE_TYPE_KEYWORDS = {
  panel: ['panel', 'breaker', 'main panel', 'subpanel', 'electrical panel', 'service panel', 'load center'],
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

function isCompatible(postServiceType, photoServiceType) {
  if (postServiceType === 'other' || photoServiceType === 'other') return true;
  return postServiceType === photoServiceType;
}

// After GPT picks, validate and replace any clear service-type mismatches
function validateAndFixMatches(posts, matches, available) {
  const usedFilenames = new Set();
  const fixed = matches.map((photo, i) => {
    if (!photo) return null;
    usedFilenames.add(photo.filename);
    return photo;
  });

  for (let i = 0; i < posts.length; i++) {
    const photo = fixed[i];
    if (!photo) continue;
    const postType = derivePostServiceType(posts[i]);
    const photoType = photo.service_type || 'other';

    if (!isCompatible(postType, photoType)) {
      // Find best replacement: same service_type, not already used, highest score
      const replacement = available
        .filter(p => !usedFilenames.has(p.filename))
        .filter(p => isCompatible(postType, p.service_type || 'other'))
        .sort((a, b) => b.score - a.score)[0];

      if (replacement && replacement.filename !== photo.filename) {
        console.log(`  ⚠ Fixing mismatch: Post "${posts[i].date}" [${postType}] had photo service_type="${photoType}" → replacing with "${replacement.filename}" [${replacement.service_type}]`);
        usedFilenames.delete(photo.filename);
        usedFilenames.add(replacement.filename);
        fixed[i] = replacement;
      }
    }
  }

  return fixed;
}

// ── Slug helper ────────────────────────────────────────────────────────────

function serviceSlug(service) {
  return (service || 'electrical')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(SCHEDULE_FILE)) {
    console.error(`Schedule not found: ${SCHEDULE_FILE}`);
    console.error('Run the SEO agents pipeline first to generate gbp_posting_schedule.md');
    process.exit(1);
  }

  const index = loadIndex();
  const available = index.filter(e => e.path && !e.used && fs.existsSync(e.path));

  if (!available.length) {
    console.error('No photos available in Raw pool (run photo-scanner.mjs scan first)');
    process.exit(1);
  }

  let scheduleText = fs.readFileSync(SCHEDULE_FILE, 'utf8');
  const posts = parseSchedule(scheduleText);

  if (!posts.length) {
    console.error('No posts found in schedule. Check gbp_posting_schedule.md format.');
    process.exit(1);
  }

  console.log(`\nMatching photos for ${posts.length} posts...`);
  console.log(`Raw pool: ${available.length} available photos`);
  if (dryRun) console.log('(dry run — no files will be copied)\n');

  const postsToMatch = posts.slice(0, Math.min(posts.length, available.length));
  if (postsToMatch.length < posts.length) {
    console.warn(`Warning: only ${available.length} photos available for ${posts.length} posts`);
  }

  console.log('Asking GPT-4o to match posts to photos...');
  const rawMatches = await pickBestPhotos(postsToMatch, available);
  const matches = validateAndFixMatches(postsToMatch, rawMatches, available);

  fs.mkdirSync(CURATED_FOLDER, { recursive: true });

  const usedPhotoIds = new Set();
  let successCount = 0;

  for (let i = 0; i < postsToMatch.length; i++) {
    const post = postsToMatch[i];
    const photo = matches[i];

    if (!photo) {
      console.log(`  ${post.date}: No photo matched`);
      continue;
    }

    if (usedPhotoIds.has(photo.filename)) {
      // GPT picked a duplicate — find next best available
      const fallback = available.find(p => !usedPhotoIds.has(p.filename));
      if (!fallback) {
        console.log(`  ${post.date}: No unique photo available`);
        continue;
      }
      matches[i] = fallback;
    }

    const chosen = matches[i];
    const ext = path.extname(chosen.filename);
    const destFilename = `${post.date}-${serviceSlug(post.service)}${ext}`;
    const destPath = path.join(CURATED_FOLDER, destFilename);

    console.log(`  ${post.date} [${post.service}] → ${chosen.filename} (score: ${chosen.score})`);
    console.log(`    → ${destFilename}`);

    if (!dryRun) {
      fs.copyFileSync(chosen.path, destPath);

      // Update schedule markdown with the full absolute path
      scheduleText = updateSchedulePhotoFile(scheduleText, post.date, destPath);

      // Mark as used in index
      const indexEntry = index.find(e => e.filename === chosen.filename);
      if (indexEntry) {
        indexEntry.used = true;
        indexEntry.used_for = post.date;
        indexEntry.curated_path = destPath;
      }
    }

    usedPhotoIds.add(chosen.filename);
    successCount++;
  }

  if (!dryRun) {
    // Write updated schedule back
    fs.writeFileSync(SCHEDULE_FILE, scheduleText);
    // Save updated index
    saveIndex(index);
  }

  console.log(`\n✓ Matched ${successCount}/${postsToMatch.length} posts`);
  console.log(`  Curated folder: ${CURATED_FOLDER}`);
  if (!dryRun) {
    console.log(`  Schedule updated: ${SCHEDULE_FILE}`);
    console.log(`  Run sync-gbp-schedule next to write paths to Excel.`);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
