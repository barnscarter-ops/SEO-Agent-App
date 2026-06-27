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

// cold-start detection: fresh store is empty, populated store is not
const tmp2 = path.join(os.tmpdir(), `alerted-empty-${Date.now()}.json`);
try { fs.rmSync(tmp2, { force: true }); } catch {}
const fresh = makeAlertStore(tmp2);
assert.equal(fresh.isEmpty(), true);
// record() adopts a fault as baseline WITHOUT counting as a fresh fire
fresh.record('runX', 'actX', 'failed');
assert.equal(fresh.isEmpty(), false);
assert.equal(fresh.shouldFire('runX', 'actX', 'failed'), false); // already known => no alert
fs.rmSync(tmp2, { force: true });

fs.rmSync(tmp, { force: true });
console.log('ok alert-store');
