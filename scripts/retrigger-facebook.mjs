#!/usr/bin/env node
/**
 * retrigger-facebook.mjs
 * One-time fix: resets Facebook posts to 'approved' and the run to 'approved'
 * so mav-bridge picks it up and runs facebook-post-week.mjs.
 *
 * Use when Facebook posts are stuck at 'pending_approval' after a run
 * that completed GBP but never processed Facebook.
 *
 * Usage:
 *   node scripts/retrigger-facebook.mjs [--run-id <uuid>]
 *   (defaults to the most recent run)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const args = process.argv.slice(2);
const runIdIdx = args.indexOf('--run-id');
let runId = runIdIdx !== -1 ? args[runIdIdx + 1] : null;

if (!runId) {
  const { data: latest, error } = await supabase
    .from('seo_runs')
    .select('id, week_of, status')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !latest) { console.error('Could not find latest run:', error?.message); process.exit(1); }
  runId = latest.id;
  console.log(`Using latest run: ${runId} (${latest.week_of}, status=${latest.status})`);
}

// Check what FB posts look like
const { data: fbPosts, error: fbErr } = await supabase
  .from('weekly_posts')
  .select('id, day, post_date, status, hook')
  .eq('run_id', runId)
  .eq('platform', 'facebook')
  .order('day');

if (fbErr) { console.error('Fetch error:', fbErr.message); process.exit(1); }

console.log(`\nFacebook posts (${fbPosts.length} total):`);
for (const p of fbPosts) {
  console.log(`  Day ${p.day} (${p.post_date}): ${p.hook?.slice(0, 50)} — ${p.status}`);
}

const postsToApprove = fbPosts.filter(p => ['pending_approval', 'error'].includes(p.status));
if (!postsToApprove.length) {
  console.log('\nNo Facebook posts need re-triggering (none in pending_approval or error state).');
  process.exit(0);
}

console.log(`\nWill re-approve ${postsToApprove.length} Facebook posts and reset run to 'approved'...`);

// Move FB posts to approved
const { error: approvePostsErr } = await supabase
  .from('weekly_posts')
  .update({ status: 'approved', error: null })
  .in('id', postsToApprove.map(p => p.id));
if (approvePostsErr) { console.error('Error approving FB posts:', approvePostsErr.message); process.exit(1); }
console.log(`✅ ${postsToApprove.length} Facebook posts → approved`);

// Reset run to approved so mav-bridge picks it up
const { error: resetRunErr } = await supabase
  .from('seo_runs')
  .update({ status: 'approved', approved_at: new Date().toISOString(), error: null })
  .eq('id', runId);
if (resetRunErr) { console.error('Error resetting run:', resetRunErr.message); process.exit(1); }
console.log(`✅ Run ${runId} → approved`);

console.log('\nmav-bridge will pick this up on next poll (within 30 seconds).');
console.log('GBP posts (now scheduled) and website tasks (approved) will be skipped — only FB will run.');
