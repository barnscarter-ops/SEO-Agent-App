// scripts/lib/schedule-text.test.mjs
import assert from 'node:assert/strict';
import { normalizePhotoFile, cleanField } from './schedule-text.mjs';

// backticks stripped
assert.equal(normalizePhotoFile('`2026-06-26-panel.JPG`'), '2026-06-26-panel.JPG');
// bold + backticks stripped
assert.equal(normalizePhotoFile('**`a.JPG`**'), 'a.JPG');
// blank sentinels => empty
assert.equal(normalizePhotoFile('*(blank)*'), '');
assert.equal(normalizePhotoFile('(blank)'), '');
assert.equal(normalizePhotoFile(''), '');
assert.equal(normalizePhotoFile(null), '');
// a stray VIDEO_PROMPT leak is not a filename => empty (no image extension)
assert.equal(normalizePhotoFile('VIDEO_PROMPT: a cinematic shot of sparks'), '');
// plain filename passes through
assert.equal(normalizePhotoFile('photo.png'), 'photo.png');
// absolute windows path preserved
assert.equal(normalizePhotoFile('`E:\\Media\\Grizzly\\Curated\\x.jpg`'), 'E:\\Media\\Grizzly\\Curated\\x.jpg');
// cleanField strips bold + backticks but keeps prose
assert.equal(cleanField('**Panel Upgrade**'), 'Panel Upgrade');
assert.equal(cleanField('`code`'), 'code');

console.log('ok schedule-text');
