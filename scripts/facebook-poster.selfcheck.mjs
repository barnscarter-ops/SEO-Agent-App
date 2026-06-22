#!/usr/bin/env node
/**
 * Self-check for facebook-poster.mjs pure logic (ponytail rule: one runnable check).
 * No frameworks — plain asserts. Run: node scripts/facebook-poster.selfcheck.mjs
 * Exercises the bits with real edge cases: token-expiry classification,
 * caption building, and schedule parsing.
 */
import assert from 'node:assert/strict';
import { classifyDebugToken, buildCaption, parseScheduleText } from './facebook-poster.mjs';

const NOW = 1_700_000_000; // fixed reference second

// ── Token classification ──────────────────────────────────────────────
assert.equal(classifyDebugToken({ error: { code: 190, message: 'bad' } }, NOW).level, 'error', 'graph error → error');
assert.equal(classifyDebugToken({ data: { is_valid: false } }, NOW).level, 'error', 'invalid token → error');
assert.equal(classifyDebugToken({ data: { is_valid: true, expires_at: 0 } }, NOW).neverExpires, true, 'expires_at 0 → never expires');
assert.equal(classifyDebugToken({ data: { is_valid: true, expires_at: NOW - 86400 } }, NOW).expired, true, 'past expiry → expired');
assert.equal(classifyDebugToken({ data: { is_valid: true, expires_at: NOW + 3 * 86400 } }, NOW).level, 'warn', '3 days left → warn');
assert.equal(classifyDebugToken({ data: { is_valid: true, expires_at: NOW + 30 * 86400 } }, NOW).level, 'info', '30 days left → info');

// ── Caption building ──────────────────────────────────────────────────
assert.equal(
  buildCaption({ hook: 'Sparks?', body: 'Call us.', hashtags: '#dfw', cta: 'Book now' }),
  'Sparks?\n\nCall us.\n\n#dfw\n\nBook now',
  'caption assembles hook/body/hashtags/cta',
);
assert.equal(buildCaption({ headline: 'Only headline' }), 'Only headline', 'falls back to headline when no body');

// ── Schedule parsing ──────────────────────────────────────────────────
const md = `
**DAY:** 2
**DATE:** 2026-06-23
**TYPE:** Video
**SERVICE:** Panel upgrades
**HOOK:** Old panel?
**BODY:** We replace it.
**HASHTAGS:** #electric
---
DAY: 1
DATE: 2026-06-22
TYPE: photo
SERVICE: Outlets
HOOK: Dead outlet?
BODY: Fixed fast.
PHOTO_FILE: outlet.jpg
`;
const posts = parseScheduleText(md);
assert.equal(posts.length, 2, 'parses both day blocks');
assert.equal(posts[0].day, 1, 'sorted by day ascending');
assert.equal(posts[0].type, 'photo', 'type lowercased');
assert.equal(posts[1].type, 'video', 'markdown-bold values stripped');
assert.equal(posts[1].service, 'Panel upgrades', 'service parsed without ** markers');

console.log('facebook-poster self-check: all assertions passed ✓');
