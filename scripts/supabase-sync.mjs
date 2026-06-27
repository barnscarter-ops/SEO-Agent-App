#!/usr/bin/env node
/**
 * supabase-sync.mjs
 * Parses agent output files and syncs them into Supabase.
 * Run automatically after `seo-agents execute` completes.
 *
 * Usage:
 *   node scripts/supabase-sync.mjs [--week-of YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { normalizePhotoFile } from './lib/schedule-text.mjs';

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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const OUTPUTS = path.join(PROJECT_ROOT, 'outputs');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getWeekOf() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--week-of');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  // Default: next Monday
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function readFile(filename) {
  const p = path.join(OUTPUTS, filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// ─────────────────────────────────────────────
// Parse facebook_posting_schedule.md
// ─────────────────────────────────────────────

function stripMd(str) {
  // Remove **bold** markers and trim
  return (str || '').replace(/\*\*/g, '').trim();
}

function parseFacebookSchedule(text) {
  if (!text) return [];
  // Strip leading ```markdown code fence the LLM sometimes adds
  text = stripCodeFence(text);
  const blocks = text.split(/\n\s*---\s*\n/).filter(b => /DAY:/i.test(b));
  return blocks.map(block => {
    const get = key => {
      // Handle both plain `KEY: value` and bold `**KEY: value**` formats
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\*{0,2}\\s*(.+?)\\s*\\*{0,2}\\s*$`, 'm'));
      return m ? stripMd(m[1]) : '';
    };
    return {
      platform: 'facebook',
      day: parseInt(get('DAY')) || 0,
      post_date: get('DATE'),
      type: get('TYPE').toLowerCase(),
      service: stripMd(get('SERVICE')),
      hook: stripMd(get('HOOK')),
      body: stripMd(get('BODY')),
      cta: stripMd(get('CTA')),
      hashtags: get('HASHTAGS') || null,
      photo_file: normalizePhotoFile(get('PHOTO_FILE')) || null,
      video_prompt: get('VIDEO_PROMPT') || null,
      status: 'pending_approval',
    };
  }).filter(p => p.day > 0 && p.post_date);
}

// ─────────────────────────────────────────────
// Parse gbp_posting_schedule.md
// ─────────────────────────────────────────────

function parseGbpSchedule(text) {
  if (!text) return [];
  const blocks = text.split(/\n\s*---\s*\n/).filter(b => b.includes('DAY:'));
  return blocks.map(block => {
    const get = key => {
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\*{0,2}\\s*(.+)$`, 'm'));
      return m ? stripMd(m[1]) : '';
    };
    return {
      platform: 'gbp',
      day: parseInt(get('DAY')) || 0,
      post_date: get('DATE'),
      type: 'photo',
      service: get('SERVICE'),
      hook: get('HEADLINE'),
      body: get('BODY'),
      cta: get('CTA'),
      hashtags: null,
      photo_file: normalizePhotoFile(get('PHOTO_FILE')) || null,
      video_prompt: null,
      status: 'pending_approval',
    };
  }).filter(p => p.day > 0 && p.post_date);
}

// ─────────────────────────────────────────────
// Parse website tasks from execution queue + reports
// ─────────────────────────────────────────────

function stripCodeFence(text) {
  // Remove leading/trailing ```markdown or ``` wrappers the LLM sometimes adds
  return text.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function parseWebsiteTasks(executionQueueText, finalReportText) {
  const tasks = [];
  const seenTitles = new Set();

  // From final_report.md — incomplete tasks become pending website tasks
  if (finalReportText) {
    const clean = stripCodeFence(finalReportText);

    // Format A: markdown table rows  | T001 | Title | Missing | Next |
    const incompleteSection = clean.match(/##\s+Incomplete[^#]*([\s\S]*?)(?=\n##|$)/i)?.[1] || '';
    const tableRows = [...incompleteSection.matchAll(/\|\s*(T\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/g)];
    for (const [, id, title, missing, next] of tableRows) {
      const t = title.trim();
      if (!t || seenTitles.has(t)) continue;
      seenTitles.add(t);
      tasks.push({
        type: 'seo_fix',
        priority: 'high',
        title: t,
        description: `Missing: ${missing.trim()}\nNext step: ${next.trim()}`,
        details: { task_id: id.trim(), source: 'final_report' },
        status: 'pending_approval',
      });
    }

    // Format B: ### Task N: Title header blocks with bullet fields
    // Matches blocks starting at "### Task" up to the next "###" or "##" or end
    const headerBlocks = [...clean.matchAll(/###\s+Task\s+\d+[:\s]+([^\n]+)([\s\S]*?)(?=\n###|\n##|$)/gi)];
    for (const [, headerTitle, body] of headerBlocks) {
      const getBullet = key => {
        const m = body.match(new RegExp(`\\*{0,2}${key}\\*{0,2}\\s*:\\s*(.+)`, 'i'));
        return m ? m[1].replace(/\*{0,2}$/, '').trim() : '';
      };
      const taskId = getBullet('Task ID') || getBullet('Task Id') || '';
      const title = (getBullet('Task Title') || headerTitle).trim();
      const missing = getBullet('What was missing') || getBullet('Missing') || '';
      const next = getBullet('Recommended Next Step') || getBullet('Next Step') || '';
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);
      tasks.push({
        type: 'seo_fix',
        priority: 'high',
        title,
        description: [missing && `Missing: ${missing}`, next && `Next step: ${next}`].filter(Boolean).join('\n'),
        details: { task_id: taskId, source: 'final_report' },
        status: 'pending_approval',
      });
    }
  }

  // From grizzly_execution_queue.md
  if (executionQueueText) {
    const clean = stripCodeFence(executionQueueText);

    // Format A: blocks separated by --- horizontal rule
    const hrBlocks = clean.split(/\n\s*---\s*\n/).filter(b => /Task\s+(ID|Title)/i.test(b));

    // Format B: blocks separated by ## Task N: headers (most common in this pipeline)
    const headerMatches = [...clean.matchAll(/##\s+Task\s+\d+[:\s]+[^\n]+([\s\S]*?)(?=\n##|\n#|$)/gi)];
    const headerBlocks = headerMatches.map(m => m[0]);

    const allBlocks = hrBlocks.length ? hrBlocks : headerBlocks;

    for (const block of allBlocks) {
      const getField = key => {
        // Handles: "**Task Title**: value", "Task Title: value", "1) **Task Title**: value"
        const m = block.match(new RegExp(`\\*{0,2}${key}\\*{0,2}\\s*:(?:\\*{0,2})?\\s*(.+)`, 'i'));
        return m ? m[1].replace(/\*{0,2}$/, '').trim() : '';
      };
      const title = getField('Task Title') || getField('TASK_TITLE') || getField('Title');
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);
      const rawPriority = getField('Priority') || getField('PRIORITY') || '';
      const type = getField('Type') || getField('TYPE') || '';
      const taskId = getField('Task ID') || getField('Task Id') || '';
      tasks.push({
        type: mapTaskType(type || title),
        priority: mapPriority(rawPriority),
        title,
        description: getField('Description') || getField('DESCRIPTION') || '',
        details: { task_id: taskId, source: 'execution_queue' },
        status: 'pending_approval',
      });
    }
  }

  return tasks;
}

function mapTaskType(raw) {
  const r = raw.toLowerCase();
  if (r.includes('blog')) return 'blog_post';
  if (r.includes('service')) return 'service_update';
  if (r.includes('promo')) return 'promotion';
  if (r.includes('alert') || r.includes('broken') || r.includes('fix')) return 'alert';
  return 'seo_fix';
}

function mapPriority(raw) {
  const r = raw.toLowerCase();
  if (r.includes('critical')) return 'critical';
  if (r.includes('high')) return 'high';
  if (r.includes('low')) return 'low';
  return 'medium';
}

// ─────────────────────────────────────────────
// Main sync
// ─────────────────────────────────────────────

async function main() {
  const weekOf = getWeekOf();
  console.log(`Syncing week of ${weekOf} to Supabase...`);

  // Upsert seo_run row
  const { data: runData, error: runError } = await supabase
    .from('seo_runs')
    .upsert({ week_of: weekOf, status: 'pending_approval', execute_completed_at: new Date().toISOString() },
      { onConflict: 'week_of' })
    .select()
    .single();

  if (runError) { console.error('Failed to upsert seo_run:', runError.message); process.exit(1); }
  const runId = runData.id;
  console.log(`Run ID: ${runId}`);

  // Clear existing pending posts for this run (allow re-sync)
  await supabase.from('weekly_posts').delete().eq('run_id', runId).eq('status', 'pending_approval');
  await supabase.from('website_tasks').delete().eq('run_id', runId).eq('status', 'pending_approval');

  // Parse and insert Facebook posts
  const fbText = readFile('facebook_posting_schedule.md');
  const fbPosts = parseFacebookSchedule(fbText);
  if (fbPosts.length) {
    const { error } = await supabase.from('weekly_posts').insert(fbPosts.map(p => ({ ...p, run_id: runId })));
    if (error) console.error('FB posts insert error:', error.message);
    else console.log(`Synced ${fbPosts.length} Facebook posts`);
  } else {
    console.log('No Facebook posts found');
  }

  // Parse and insert GBP posts
  const gbpText = readFile('gbp_posting_schedule.md');
  const gbpPosts = parseGbpSchedule(gbpText);
  if (gbpPosts.length) {
    const { error } = await supabase.from('weekly_posts').insert(gbpPosts.map(p => ({ ...p, run_id: runId })));
    if (error) console.error('GBP posts insert error:', error.message);
    else console.log(`Synced ${gbpPosts.length} GBP posts`);
  } else {
    console.log('No GBP posts found');
  }

  // Parse and insert website tasks
  const queueText = readFile('grizzly_execution_queue.md');
  const reportText = readFile('final_report.md');
  const tasks = parseWebsiteTasks(queueText, reportText);
  if (tasks.length) {
    const { error } = await supabase.from('website_tasks').insert(tasks.map(t => ({ ...t, run_id: runId })));
    if (error) console.error('Website tasks insert error:', error.message);
    else console.log(`Synced ${tasks.length} website tasks`);
  }

  console.log(`\nSync complete. Run ${runId} is pending_approval in Supabase.`);
  console.log('Open the MCC dashboard to review and approve.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
