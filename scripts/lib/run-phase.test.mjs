// scripts/lib/run-phase.test.mjs
import assert from 'node:assert/strict';
import { makeRunPhase } from './run-phase.mjs';

const logs = [];
const log = async (_runId, _phase, _level, msg) => { logs.push(msg); };
const hopError = async (_runId, _phase, _hop, msg) => { logs.push('ERR:' + msg); };
const runPhase = makeRunPhase({ log, hopError, projectRoot: process.cwd() });

// success: node prints to stdout, exit 0
const ok = await runPhase('r1', 'test', process.execPath, ['-e', 'process.stdout.write("hi")']);
assert.equal(ok.ok, true);
assert.equal(ok.exitCode, 0);
assert.ok(ok.stdout.includes('hi'));

// failure: node exits non-zero => ok:false, exitCode captured, hopError logged
const bad = await runPhase('r1', 'test', process.execPath, ['-e', 'process.exit(7)']);
assert.equal(bad.ok, false);
assert.equal(bad.exitCode, 7);
assert.ok(logs.some(l => l.startsWith('ERR:')));

console.log('ok run-phase');
