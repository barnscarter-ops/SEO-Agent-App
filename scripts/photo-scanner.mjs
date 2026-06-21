#!/usr/bin/env node
/**
 * photo-scanner.mjs
 * Local photo scoring pipeline for GBP post photos.
 *
 * Commands:
 *   scan [--folder <path>]   Score photos in the inbox folder, move high-scorers to Raw pool
 *
 * Workflow:
 *   1. Download photos from Google Photos (Grizzly electrical album) to GBP_INBOX_FOLDER manually
 *      (Google Photos web → select all → Download)
 *   2. Run: node photo-scanner.mjs scan
 *   3. High-scoring photos (>=65) move to GBP_RAW_FOLDER + backup to GBP_BACKUP_FOLDER
 *   4. Low-scoring photos stay in inbox for manual review
 *
 * Env vars (from .env):
 *   OPENAI_API_KEY
 *   GBP_INBOX_FOLDER    (default: E:\Media\Grizzly\Inbox)
 *   GBP_RAW_FOLDER      (default: E:\Media\Grizzly\Raw)
 *   GBP_BACKUP_FOLDER   (default: M:\backups\gbp-raw)
 *   GBP_MIN_PHOTO_SCORE (default: 65)
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
const INBOX_FOLDER = process.env.GBP_INBOX_FOLDER || 'E:\\Media\\Grizzly\\Inbox';
const RAW_FOLDER = process.env.GBP_RAW_FOLDER || 'E:\\Media\\Grizzly\\Raw';
const BACKUP_FOLDER = process.env.GBP_BACKUP_FOLDER || 'M:\\backups\\gbp-raw';
const MIN_SCORE = parseInt(process.env.GBP_MIN_PHOTO_SCORE || '65');
const INDEX_FILE = path.join(PROJECT_ROOT, 'state', 'raw-photo-index.json');
const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

// ── Index helpers ──────────────────────────────────────────────────────────

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return []; }
}

function saveIndex(index) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ── GPT-4o vision scoring ──────────────────────────────────────────────────

async function scorePhoto(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();

  let imageBuffer = fs.readFileSync(imagePath);
  let mime = 'image/jpeg';

  if (ext === '.heic' || ext === '.heif') {
    const heicConvert = (await import('heic-convert')).default;
    imageBuffer = Buffer.from(await heicConvert({ buffer: imageBuffer, format: 'JPEG', quality: 0.85 }));
    mime = 'image/jpeg';
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
            text: `Score this photo 0-100 for use as a Google Business Profile social post for an electrical contractor.

High score (70-100): shows professional electrical work clearly — panels, wiring, conduit, EV chargers, outdoor fixtures, completed installs. Clean, well-lit, no faces.
Medium score (40-69): shows electrical work but partially obscured, cluttered, or poorly lit.
Low score (0-39): not electrical work, has faces/PII, is a screenshot, receipt, personal photo, or unrelated.

For tags, use SPECIFIC service-type terms from this vocabulary (pick all that apply):
  Panel work: panel-upgrade, panel-replacement, main-panel, subpanel, breaker-box, breaker-replacement
  EV charging: ev-charger, ev-charging-station, level-2-charger, ev-outlet
  Lighting: lighting-fixture, recessed-lighting, outdoor-lighting, ceiling-fan, light-switch, dimmer
  Wiring/conduit: wiring, wire-run, conduit, romex, junction-box
  Outlets: outlet-installation, gfci-outlet, usb-outlet, dedicated-circuit
  Other electrical: electrical-safety, smoke-detector, whole-home, service-upgrade

Also set "service_type" to ONE of: "panel", "ev-charger", "lighting", "wiring", "outlet", "other"

Reply ONLY with JSON: {"score": <0-100>, "service_type": "<type>", "tags": ["tag1","tag2"], "reject_reason": "<blank if score>=65>"}`,
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
    return { score: 0, tags: [], reject_reason: 'parse error' };
  }
}

// ── Scan command ───────────────────────────────────────────────────────────

async function scan(inboxFolder) {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set in .env');
    process.exit(1);
  }

  if (!fs.existsSync(inboxFolder)) {
    console.error(`Inbox folder not found: ${inboxFolder}`);
    console.error('Create it and add photos before running scan.');
    process.exit(1);
  }

  const index = loadIndex();
  const indexedPaths = new Set(index.map(e => e.source_path).filter(Boolean));

  // Backfill: copy any Raw files missing from backup (e.g. scored before backup folder was writable)
  if (BACKUP_FOLDER && fs.existsSync(RAW_FOLDER)) {
    const rawFiles = fs.readdirSync(RAW_FOLDER).filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()));
    let backfilled = 0;
    for (const f of rawFiles) {
      const backupPath = path.join(BACKUP_FOLDER, f);
      if (!fs.existsSync(backupPath)) {
        try {
          fs.mkdirSync(BACKUP_FOLDER, { recursive: true });
          fs.copyFileSync(path.join(RAW_FOLDER, f), backupPath);
          backfilled++;
        } catch (e) {
          console.warn(`  Backfill backup failed for ${f}: ${e.message}`);
        }
      }
    }
    if (backfilled > 0) console.log(`  Backfilled ${backfilled} Raw photos to backup folder`);
  }

  const allFiles = fs.readdirSync(inboxFolder, { recursive: true })
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => path.join(inboxFolder, f))
    .filter(f => fs.statSync(f).isFile());

  const newFiles = allFiles.filter(f => !indexedPaths.has(f));

  console.log(`\nInbox: ${inboxFolder}`);
  console.log(`Total photos: ${allFiles.length} | Already processed: ${allFiles.length - newFiles.length} | New: ${newFiles.length}`);

  if (!newFiles.length) {
    console.log('No new photos to score. Drop more photos into the inbox and run again.');
    return;
  }

  fs.mkdirSync(RAW_FOLDER, { recursive: true });

  let downloaded = 0;
  let skipped = 0;

  for (const filePath of newFiles) {
    const filename = path.basename(filePath);
    process.stdout.write(`  Scoring ${filename}... `);

    try {
      const result = await scorePhoto(filePath);
      const label = result.score >= MIN_SCORE ? '✓' : '✗';
      console.log(`${label} ${result.score}${result.reject_reason ? ` (${result.reject_reason})` : ''}`);

      const entry = {
        source_path: filePath,
        filename,
        score: result.score,
        service_type: result.service_type || 'other',
        tags: result.tags || [],
        scanned_at: new Date().toISOString(),
        used: false,
        path: null,
      };

      if (result.score >= MIN_SCORE) {
        const destPath = path.join(RAW_FOLDER, filename);
        fs.copyFileSync(filePath, destPath);
        entry.path = destPath;
        downloaded++;

        if (BACKUP_FOLDER) {
          try {
            fs.mkdirSync(BACKUP_FOLDER, { recursive: true });
            fs.copyFileSync(filePath, path.join(BACKUP_FOLDER, filename));
            console.log(`    → Backed up to: ${path.join(BACKUP_FOLDER, filename)}`);
          } catch (e) {
            console.warn(`    Backup failed (Proxmox reachable?): ${e.message}`);
          }
        }

        // Remove from Inbox after successful copy to Raw (and backup)
        try {
          fs.unlinkSync(filePath);
          console.log(`    → Moved to Raw: ${destPath}`);
        } catch (e) {
          console.warn(`    Could not remove from Inbox (${e.message}) — Raw copy is safe`);
        }
      } else {
        skipped++;
      }

      index.push(entry);
      saveIndex(index);

      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      index.push({ source_path: filePath, filename, score: -1, error: e.message, used: false, path: null });
      saveIndex(index);
    }
  }

  console.log(`\n✓ Scan complete`);
  console.log(`  Moved to Raw pool (removed from Inbox): ${downloaded}`);
  console.log(`  Skipped (low score): ${skipped}`);
  console.log(`  Total available in Raw pool: ${index.filter(e => e.path && !e.used).length}`);
  console.log(`\n  Low-score photos remain in inbox for manual review: ${inboxFolder}`);
}

// ── Retag command ──────────────────────────────────────────────────────────

async function retag() {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set in .env');
    process.exit(1);
  }

  const index = loadIndex();
  const toRetag = index.filter(e => e.path && fs.existsSync(e.path) && !e.service_type);

  console.log(`\nRetag: ${toRetag.length} existing Raw photos missing service_type`);
  console.log(`(${index.length - toRetag.length} already have service_type — skipping)\n`);

  if (!toRetag.length) {
    console.log('Nothing to retag. All index entries already have service_type.');
    return;
  }

  let updated = 0;
  for (const entry of toRetag) {
    process.stdout.write(`  Retagging ${entry.filename}... `);
    try {
      const result = await scorePhoto(entry.path);
      entry.service_type = result.service_type || 'other';
      entry.tags = result.tags || entry.tags || [];
      // Don't touch score — photo already passed its original scan threshold
      console.log(`✓ service_type=${entry.service_type} | tags: ${entry.tags.join(', ')}`);
      updated++;
      saveIndex(index);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  console.log(`\n✓ Retag complete: ${updated}/${toRetag.length} entries updated`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '';
  const folderFlag = args.indexOf('--folder');
  const inboxFolder = folderFlag >= 0 ? args[folderFlag + 1] : INBOX_FOLDER;

  if (command === 'scan') {
    await scan(inboxFolder);
  } else if (command === 'retag') {
    await retag();
  } else {
    console.log('Usage:');
    console.log('  node photo-scanner.mjs scan                  Score photos in default inbox');
    console.log('  node photo-scanner.mjs scan --folder <path>  Score photos in a specific folder');
    console.log('  node photo-scanner.mjs retag                 Add service_type to existing Raw photos');
    console.log('');
    console.log(`Default inbox: ${INBOX_FOLDER}`);
    console.log(`Raw pool:      ${RAW_FOLDER}`);
    console.log(`Min score:     ${MIN_SCORE}`);
    process.exit(0);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
