// scripts/lib/alert-store.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeAlertStore } from './alert-store.mjs';

const tmp = path.join(os.tmpdir(), `alerted-${Date.now()}.json`);
try { fs.rmSync(tmp, { force: true }); } catch {}

const store = makeAlertStore(tmp);
// first time a fault is seen => fires
assert.equal(store.shouldFire('run1', 'act1', 'failed'), true);
// same fault again => does not fire
assert.equal(store.shouldFire('run1', 'act1', 'failed'), false);
// different fault type on same action => fires
assert.equal(store.shouldFire('run1', 'act1', 'stuck'), true);
// persisted across instances
const store2 = makeAlertStore(tmp);
assert.equal(store2.shouldFire('run1', 'act1', 'failed'), false);
// clearing a fault lets it fire again
store2.clearFault('run1', 'act1', 'failed');
assert.equal(store2.shouldFire('run1', 'act1', 'failed'), true);

fs.rmSync(tmp, { force: true });
console.log('ok alert-store');
