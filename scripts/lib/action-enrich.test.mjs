// scripts/lib/action-enrich.test.mjs
import assert from 'node:assert/strict';
import {
  bucketStatus, isStuck, STUCK_THRESHOLDS, describeAction, agentFor, mediaStatusFor,
} from './action-enrich.mjs';

// bucketStatus
assert.equal(bucketStatus('pending_approval'), 'pending');
assert.equal(bucketStatus('approved'), 'pending');
assert.equal(bucketStatus('scheduled'), 'pending');
assert.equal(bucketStatus('awaiting_prompt'), 'pending');
assert.equal(bucketStatus('executing'), 'in_process');
assert.equal(bucketStatus('posting'), 'in_process');
assert.equal(bucketStatus('research_running'), 'in_process');
assert.equal(bucketStatus('done'), 'completed');
assert.equal(bucketStatus('posted'), 'completed');
assert.equal(bucketStatus('error'), 'failed');
assert.equal(bucketStatus('needs_verification'), 'failed');
assert.equal(bucketStatus('weird_unknown'), 'pending'); // safe default

// isStuck — only meaningful for in_process rows
const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const fresh = new Date(Date.now() - 60 * 1000).toISOString();        // 1m ago
assert.equal(isStuck('website_task', old), true);   // 2h > 15m
assert.equal(isStuck('website_task', fresh), false);
assert.equal(isStuck('seo_run', old), false);       // 2h < 90m
assert.equal(isStuck('weekly_post_facebook', old), true); // 2h > 60m
assert.equal(isStuck('weekly_post_gbp', fresh), false);
assert.equal(isStuck('website_task', null), false); // no timestamp => not stuck

// thresholds present for every type
for (const k of ['website_task','weekly_post_gbp','weekly_post_facebook','seo_run']) {
  assert.ok(STUCK_THRESHOLDS[k] > 0, `threshold for ${k}`);
}

// describeAction — DB description wins, else type fallback, never empty
assert.ok(describeAction({ type: 'seo_run' }).length > 0);
assert.equal(describeAction({ type: 'website_task', description: 'Custom thing' }), 'Custom thing');
assert.ok(describeAction({ type: 'weekly_post', platform: 'gbp', post_date: '2026-06-26' }).includes('2026-06-26'));

// agentFor
assert.equal(agentFor({ type: 'seo_run' }), 'SEO Crew');
assert.equal(agentFor({ type: 'weekly_post', platform: 'gbp' }), 'Grizzly GBP Poster Agent');
assert.equal(agentFor({ type: 'weekly_post', platform: 'facebook' }), 'Grizzly Facebook Poster Agent');
assert.ok(agentFor({ type: 'website_task' }).length > 0);

// mediaStatusFor
assert.equal(mediaStatusFor('video', 'video'), 'video');
assert.equal(mediaStatusFor('video', 'photo'), 'downgraded');
assert.equal(mediaStatusFor('video', 'text'), 'none');
assert.equal(mediaStatusFor('video', undefined), 'none');
assert.equal(mediaStatusFor('photo', 'photo'), 'photo');
assert.equal(mediaStatusFor('text', 'text'), 'none');

console.log('ok action-enrich');
