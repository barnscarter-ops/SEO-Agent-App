# Split GBP Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move GBP photo curation + posting out of the LocalSystem `mav-bridge` service into a new worker that runs in Carter's interactive `carte` session, so the saved Google session, the `H:\` Drive mount, and a visible browser are all available.

**Architecture:** Disjoint platform ownership over the existing Supabase queue. `mav-bridge` (LocalSystem) keeps Facebook + website + orchestration + alerting and stops touching `gbp` rows. A new `gbp-worker.mjs` (Windows Scheduled Task, "run when logged on", as `carte`) polls Supabase for `gbp` rows and runs curation → sync → driver post → mark/archive. Shared GBP logic lives in one module so there is no copy-paste. Errors are written to `weekly_posts.status`/`.error`, which the service's existing fault-detection already alerts on.

**Tech Stack:** Node.js v24 (ESM `.mjs`), `@supabase/supabase-js`, `xlsx`, Playwright (in the external `gbp-poster` skill driver), Windows Task Scheduler. Tests are framework-free `node:assert/strict` self-checks run with `node scripts/lib/<name>.test.mjs`, ending in `console.log('ok <name>')` (existing convention — see `scripts/lib/alert-store.test.mjs`).

**Working directory:** All relative paths below are from the repo root of this worktree (`C:\Workspace\Active\SEO-Agents-App\.claude\worktrees\dazzling-mcclintock-a88761`). Run all `node` and `git` commands from there.

**Spec:** `docs/superpowers/specs/2026-06-27-split-gbp-worker-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `scripts/lib/gbp-runner.mjs` | All shared GBP logic: pure helpers (date/exit-code/Central-time) + orchestration (`markGbpPostedAndArchive`, `runGbpForApprovedRun`, `runDailyGbp`). Single source of truth. | Create |
| `scripts/lib/gbp-runner.test.mjs` | Self-check for the pure helpers + a stubbed wiring test for `runDailyGbp`. | Create |
| `scripts/lib/run-phase.mjs` | The `runPhase` subprocess runner, extracted so both the bridge and the worker share it. | Create |
| `scripts/lib/run-phase.test.mjs` | Self-check: runs a real trivial subprocess (success + non-zero exit). | Create |
| `scripts/gbp-worker.mjs` | New entry point. Polls Supabase for `gbp` work, runs it via `gbp-runner`. `--once` flag for a single poll. Runs as `carte`. | Create |
| `scripts/mav-bridge.mjs` | Stop doing GBP/curation. Import `runPhase` from `run-phase.mjs`; gate the GBP calls behind `MAV_BRIDGE_GBP` (default `off`); remove now-dead inline GBP helpers. | Modify |
| `C:\Users\carte\.claude\skills\gbp-poster\driver.mjs` | Detect the logged-out GBP marketing page in `assertLoggedIn` → throw a `session_expired`-classified error. **Outside this git repo.** | Modify |
| `C:\Users\carte\.claude\skills\gbp-poster\driver.selfcheck.mjs` | Assert the new message classifies as `session_expired`. **Outside this git repo.** | Create |
| `ops/gbp-worker-task.xml` | Task Scheduler definition for the worker. | Create |
| `docs/runbooks/gbp-worker.md` | How to install/verify the task, re-auth, rollback. | Create |

---

## Task 1: Pure GBP helpers in `gbp-runner.mjs`

**Files:**
- Create: `scripts/lib/gbp-runner.mjs`
- Test: `scripts/lib/gbp-runner.test.mjs`

These four functions carry the real logic; everything else in later tasks is wiring around them.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/gbp-runner.test.mjs`:

```javascript
// scripts/lib/gbp-runner.test.mjs
import assert from 'node:assert/strict';
import {
  excelDateToIso,
  parseDriverJson,
  gbpNeedsVerificationMessage,
  gbpDailyStatusForExit,
  centralDateHour,
} from './gbp-runner.mjs';

// excelDateToIso: Date, Excel serial, and string forms
assert.equal(excelDateToIso(new Date('2026-06-27T00:00:00Z')), '2026-06-27');
assert.equal(excelDateToIso(46200), '2026-07-04'); // Excel serial for 2026-07-04
assert.equal(excelDateToIso('2026-06-27 extra'), '2026-06-27');
assert.equal(excelDateToIso(''), '');

// parseDriverJson: last JSON line wins; junk → {}
assert.deepEqual(parseDriverJson('noise\n{"result":"posted","postUrl":"u"}'), { result: 'posted', postUrl: 'u' });
assert.deepEqual(parseDriverJson('not json at all'), {});

// gbpNeedsVerificationMessage: includes attempt count + snapshot path
const m = gbpNeedsVerificationMessage({ verificationAttempts: 3, verificationSnapshot: { textFile: 'C:/x.json' } });
assert.ok(m.includes('3'));
assert.ok(m.includes('C:/x.json'));

// gbpDailyStatusForExit: exit code → weekly_posts update intent
assert.deepEqual(gbpDailyStatusForExit(0, { postUrl: 'u' }),
  { status: 'posted', error: null, archive: true, platform_post_id: 'u' });
assert.equal(gbpDailyStatusForExit(3, { verificationAttempts: 5 }).status, 'needs_verification');
assert.equal(gbpDailyStatusForExit(3, {}).archive, false);
assert.deepEqual(gbpDailyStatusForExit(4, {}), { status: 'pending_approval', error: null, archive: false, platform_post_id: null });
assert.equal(gbpDailyStatusForExit(1, {}).status, 'error');
assert.equal(gbpDailyStatusForExit(1, {}).archive, false);

// centralDateHour: 2026-06-27 14:30 UTC is 09:30 CDT (UTC-5 in June)
const { todayDate, cstHour } = centralDateHour(new Date('2026-06-27T14:30:00Z'));
assert.equal(todayDate, '2026-06-27');
assert.equal(cstHour, 9);
// 05:30 UTC same day is 00:30 CDT → still 2026-06-27, hour 0
const early = centralDateHour(new Date('2026-06-27T05:30:00Z'));
assert.equal(early.todayDate, '2026-06-27');
assert.equal(early.cstHour, 0);

console.log('ok gbp-runner pure helpers');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/gbp-runner.test.mjs`
Expected: FAIL — `Cannot find module './gbp-runner.mjs'` (or `excelDateToIso is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/gbp-runner.mjs` (pure helpers only for now — orchestration is added in Task 3):

```javascript
// scripts/lib/gbp-runner.mjs
// Single source of truth for GBP curation + posting logic, shared by mav-bridge
// (legacy/rollback path) and gbp-worker (the user-session owner).
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

// Excel cells store dates as Date objects, serial numbers, or strings depending
// on how the workbook was written. Normalise all three to an ISO yyyy-mm-dd.
export function excelDateToIso(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return String(value || '').slice(0, 10);
}

// The driver prints a JSON result as the last stdout line. Pull it out; tolerate noise.
export function parseDriverJson(stdout) {
  try {
    const lastLine = (stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    return lastLine ? JSON.parse(lastLine) : {};
  } catch {
    return {};
  }
}

export function gbpNeedsVerificationMessage(parsed = {}) {
  const attempts = parsed.verificationAttempts || 5;
  const snapshot = parsed.verificationSnapshot?.textFile || parsed.verificationSnapshot?.screenshot || '';
  const suffix = snapshot ? ` Snapshot: ${snapshot}` : '';
  return `GBP post was submitted but not verified after ${attempts} 60-second snapshot checks. Check manually before retrying.${suffix}`;
}

// Map a driver exit code to the weekly_posts update intent. `archive: true` means
// the caller should also run markGbpPostedAndArchive. Exit codes (driver.mjs):
//   0 = posted+verified, 3 = submitted-unverified, 4 = approval-gate-unset, else = error.
export function gbpDailyStatusForExit(exitCode, parsed = {}) {
  if (exitCode === 0) {
    return { status: 'posted', error: null, archive: true, platform_post_id: parsed.postUrl || null };
  }
  if (exitCode === 3) {
    return { status: 'needs_verification', error: gbpNeedsVerificationMessage(parsed), archive: false, platform_post_id: null };
  }
  if (exitCode === 4) {
    return { status: 'pending_approval', error: null, archive: false, platform_post_id: null };
  }
  return { status: 'error', error: null, archive: false, platform_post_id: null };
}

// Derive the Central-time (DST-aware) date + hour from a UTC instant. Used to gate
// the daily poster to once per calendar day after 9am Central.
export function centralDateHour(nowUtc) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(nowUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const todayDate = `${get('year')}-${get('month')}-${get('day')}`;
  let cstHour = parseInt(get('hour'), 10);
  if (cstHour === 24) cstHour = 0; // some ICU builds emit 24 at midnight
  return { todayDate, cstHour };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/gbp-runner.test.mjs`
Expected: PASS — prints `ok gbp-runner pure helpers`.

> If the Excel serial assertion fails, print the actual value with
> `node -e "import('xlsx').then(x=>console.log(x.default.SSF.parse_date_code(46200)))"` and
> correct the expected ISO date in the test to match — the serial→date mapping is the
> source of truth, not the literal `46200`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/gbp-runner.mjs scripts/lib/gbp-runner.test.mjs
git commit -m "feat(gbp): pure helpers for shared GBP runner module"
```

---

## Task 2: Extract `runPhase` into `run-phase.mjs`

`runPhase` currently lives inline in `mav-bridge.mjs` (lines ~141-167). The worker needs the same subprocess runner. Extract it as a pure function that takes its logging callbacks as parameters, so each process keeps its own Supabase-backed `log`/`hopError`.

**Files:**
- Create: `scripts/lib/run-phase.mjs`
- Test: `scripts/lib/run-phase.test.mjs`
- Modify: `scripts/mav-bridge.mjs` (replace inline `runPhase` with an import)

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/run-phase.test.mjs`:

```javascript
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

// failure: node exits non-zero → ok:false, exitCode captured, hopError logged
const bad = await runPhase('r1', 'test', process.execPath, ['-e', 'process.exit(7)']);
assert.equal(bad.ok, false);
assert.equal(bad.exitCode, 7);
assert.ok(logs.some(l => l.startsWith('ERR:')));

console.log('ok run-phase');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/run-phase.test.mjs`
Expected: FAIL — `Cannot find module './run-phase.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/run-phase.mjs`:

```javascript
// scripts/lib/run-phase.mjs
// Subprocess runner shared by mav-bridge and gbp-worker. The caller supplies
// log + hopError (each wires its own Supabase client) and a default cwd.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function makeRunPhase({ log, hopError, projectRoot }) {
  return async function runPhase(runId, phase, exe, args, cwd, opts = {}) {
    // Default 15 min; callers that render Veo videos pass a longer timeoutMs.
    const timeoutMs = opts.timeoutMs || 15 * 60 * 1000;
    await log(runId, phase, 'info', `Starting: ${exe} ${args.join(' ')}`);
    try {
      const { stdout, stderr } = await execFileAsync(exe, args, {
        cwd: cwd || projectRoot,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (stderr) await log(runId, phase, 'info', stderr.slice(0, 2000));
      await log(runId, phase, 'info', `Done: ${stdout.slice(0, 500)}`);
      return { ok: true, stdout, stderr, exitCode: 0 };
    } catch (e) {
      const stdout = e.stdout || '';
      const stderr = e.stderr || '';
      const exitCode = typeof e.code === 'number' ? e.code : -1;
      const killed = e.killed ? ` (killed: timed out after ${Math.round(timeoutMs / 1000)}s)` : '';
      const detail = [e.message + killed, stderr, stdout].filter(Boolean).join('\n').slice(0, 1500);
      await hopError(runId, phase, `subprocess:${phase}`, `${exe} failed (exit ${exitCode})${killed}`, { message: detail });
      return { ok: false, stdout, stderr, exitCode, error: detail };
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/run-phase.test.mjs`
Expected: PASS — prints `ok run-phase`.

- [ ] **Step 5: Refactor mav-bridge to use the shared runPhase**

In `scripts/mav-bridge.mjs`:

a) Add the import near the other `./lib/...` imports (after the `makeAlertStore` import, ~line 24):

```javascript
import { makeRunPhase } from './lib/run-phase.mjs';
```

b) Delete the inline `runPhase` function (the whole `async function runPhase(...) { ... }` block, ~lines 141-167) and replace it with a constructed instance placed AFTER `hopError` and `log` are defined (i.e. just below the `hopError` definition, ~line 103):

```javascript
const runPhase = makeRunPhase({ log, hopError, projectRoot: PROJECT_ROOT });
```

Note: the original `hopError` tag was `mav-bridge→subprocess:${phase}`; the extracted version tags `subprocess:${phase}`. The bridge's `hopError` already prefixes `[mav-bridge]` in its console line, so the hop label stays attributable. This is acceptable; no further change needed.

- [ ] **Step 6: Verify mav-bridge still parses and boots**

Run: `node --check scripts/mav-bridge.mjs`
Expected: no output, exit 0 (syntax OK).

Then a boot smoke test (it will exit quickly if Supabase env is missing, which is fine — we only check it parses and starts):

Run: `node -e "import('./scripts/mav-bridge.mjs').catch(e=>{console.error(e.message);process.exit(1)})" &`
Expected: prints `[mav-bridge] Starting — polling Supabase…` (or exits with the explicit `SUPABASE_URL or SUPABASE_SERVICE_KEY not set` message if env is absent). Either is a pass — a stack trace/`ReferenceError: runPhase is not defined` is a fail. Kill it after a few seconds: `kill %1` (bash) — do not leave it running.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/run-phase.mjs scripts/lib/run-phase.test.mjs scripts/mav-bridge.mjs
git commit -m "refactor(bridge): extract runPhase into shared lib/run-phase.mjs"
```

---

## Task 3: GBP orchestration in `gbp-runner.mjs`

Add the stateful functions the worker calls: `markGbpPostedAndArchive`, `runGbpForApprovedRun`, `runDailyGbp`. They take a `deps` object so they are testable with stubs.

**Files:**
- Modify: `scripts/lib/gbp-runner.mjs`
- Modify: `scripts/lib/gbp-runner.test.mjs` (add a stubbed `runDailyGbp` wiring test)

- [ ] **Step 1: Write the failing test (append to `gbp-runner.test.mjs`)**

Add the new import names to the existing top import and append this block before the final `console.log`:

```javascript
import { runDailyGbp } from './gbp-runner.mjs'; // add to the existing import list

// --- runDailyGbp wiring: a verified post (exit 0) marks the row 'posted' ---
{
  const updates = [];
  // Minimal chainable Supabase stub. select-chain ends at .order() (awaitable);
  // update-chain ends at .eq() (awaitable).
  const makeQb = (rows) => {
    const qb = {
      from: () => qb,
      select: () => qb,
      eq: () => qb,
      order: () => Promise.resolve({ data: rows }),
      update: (vals) => { updates.push(vals); return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    };
    return qb;
  };
  const supabase = makeQb([{ id: 'p1', run_id: 'r1', post_date: '2026-06-27', photo_file: '' }]);
  const runPhase = async () => ({ ok: true, exitCode: 0, stdout: '{"result":"posted","postUrl":"https://x/post"}', stderr: '' });

  await runDailyGbp({
    supabase,
    runPhase,
    log: async () => {},
    env: {}, // no GBP_WORKBOOK_PATH → markGbpPostedAndArchive short-circuits, no Excel touched
    todayDate: '2026-06-27',
    gbpPosterPath: 'C:/fake/driver.mjs',
    projectRoot: process.cwd(),
  });

  const posted = updates.find(u => u.status === 'posted');
  assert.ok(posted, 'runDailyGbp should mark the row posted on exit 0');
  assert.equal(posted.platform_post_id, 'https://x/post');
}

console.log('ok gbp-runner orchestration');
```

(Keep the existing `console.log('ok gbp-runner pure helpers')` line where it is; the new block runs after it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/gbp-runner.test.mjs`
Expected: FAIL — `runDailyGbp is not a function` / not exported.

- [ ] **Step 3: Implement the orchestration (append to `gbp-runner.mjs`)**

Append to `scripts/lib/gbp-runner.mjs`:

```javascript
// Called only after the driver verifies the post (exit 0): set Posted=TRUE in the
// Excel workbook and move the photo to the dated archive folder. deps: { env, log }.
export async function markGbpPostedAndArchive({ postDate, exitCode, runId, env, log }) {
  if (exitCode !== 0) return;
  const GBP_WORKBOOK_PATH = env.GBP_WORKBOOK_PATH || '';
  const GBP_ARCHIVE_FOLDER = env.GBP_ARCHIVE_FOLDER || 'M:\\backups\\gbp-archive';
  if (!GBP_WORKBOOK_PATH) { await log(runId, 'gbp', 'info', 'GBP_WORKBOOK_PATH not set — skipping Excel update'); return; }
  if (!fs.existsSync(GBP_WORKBOOK_PATH)) { await log(runId, 'gbp', 'warn', `GBP workbook not found: ${GBP_WORKBOOK_PATH}`); return; }

  try {
    const workbook = xlsx.readFile(GBP_WORKBOOK_PATH);
    const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows.length) return;

    const header = rows[0].map(h => String(h).trim());
    const dateCol = header.findIndex(h => h.toLowerCase() === 'date');
    const postedCol = header.findIndex(h => h.toLowerCase() === 'posted');
    const photoCol = header.findIndex(h =>
      h === 'AssetIdOrDescription' || h === 'Related Picture' || h.toLowerCase().includes('asset'));

    if (dateCol === -1) { await log(runId, 'gbp', 'warn', 'GBP workbook: Date column not found'); return; }

    let targetRow = -1;
    let photoPath = '';
    for (let i = 1; i < rows.length; i++) {
      if (excelDateToIso(rows[i][dateCol]) === postDate) {
        targetRow = i;
        if (photoCol >= 0) photoPath = String(rows[i][photoCol] || '').trim();
        break;
      }
    }
    if (targetRow === -1) { await log(runId, 'gbp', 'warn', `GBP workbook: no row found for ${postDate}`); return; }

    if (postedCol >= 0) {
      sheet[xlsx.utils.encode_cell({ r: targetRow, c: postedCol })] = { t: 'b', v: true };
      xlsx.writeFile(workbook, GBP_WORKBOOK_PATH);
      await log(runId, 'gbp', 'info', `Excel Posted=TRUE set for ${postDate}`);
    }
    if (photoPath && fs.existsSync(photoPath)) {
      const monthDir = path.join(GBP_ARCHIVE_FOLDER, postDate.slice(0, 7));
      fs.mkdirSync(monthDir, { recursive: true });
      fs.renameSync(photoPath, path.join(monthDir, path.basename(photoPath)));
      await log(runId, 'gbp', 'info', `Photo archived: ${path.basename(photoPath)} → ${monthDir}`);
    }
  } catch (e) {
    await log(runId, 'gbp', 'warn', `markGbpPostedAndArchive error: ${e.message}`);
  }
}

// Apply a driver result to one weekly_posts row (shared by run + daily paths).
async function applyDriverResult({ supabase, post, result, env, log }) {
  const parsed = parseDriverJson(result.stdout);
  const map = gbpDailyStatusForExit(result.exitCode, parsed);
  const update = { status: map.status, error: map.error };
  if (map.status === 'posted') {
    update.posted_at = new Date().toISOString();
    update.platform_post_id = map.platform_post_id;
  }
  if (map.status === 'error') {
    update.error = (result.stderr || result.error || 'GBP poster failed').slice(0, 300);
  }
  await supabase.from('weekly_posts').update(update).eq('id', post.id);
  if (map.archive) {
    await markGbpPostedAndArchive({ postDate: post.post_date, exitCode: result.exitCode, runId: post.run_id, env, log });
  }
  return map.status;
}

// Run-time GBP for a freshly-approved run: curate photos (H:→E:), sync the Excel
// workbook, post Day 1 immediately, mark Days 2-7 scheduled + approved-in-workbook.
// deps: { supabase, runPhase, log, env, projectRoot, paths }
//   paths: { photoPick, gbpPoster, seoAgentsExe }
export async function runGbpForApprovedRun({ runId, gbpPosts, deps }) {
  const { supabase, runPhase, log, env, projectRoot, paths } = deps;

  // 0. Curate (reads H:\, writes E:\, rewrites PHOTO_FILE in the schedule).
  if (fs.existsSync(paths.photoPick)) {
    const r = await runPhase(runId, 'gbp', 'node', [paths.photoPick], projectRoot);
    if (!r.ok) await log(runId, 'gbp', 'warn', `gbp-photo-pick failed (continuing): ${r.error}`);
    else await log(runId, 'gbp', 'info', 'Photo curation complete');
  }

  // 1. Sync schedule → Excel workbook.
  const sync = await runPhase(runId, 'gbp', paths.seoAgentsExe, ['sync-gbp-schedule'], projectRoot);
  if (!sync.ok) {
    await log(runId, 'gbp', 'error', `sync-gbp-schedule failed: ${sync.error}`);
    await supabase.from('weekly_posts').update({ status: 'error', error: sync.error })
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'posting');
    return;
  }

  // 2. Post Day 1 now.
  const day1 = gbpPosts.find(p => p.day === 1);
  if (day1) {
    await log(runId, 'gbp', 'info', 'Posting Day 1 GBP immediately...');
    const r = await runPhase(runId, 'gbp', 'node', [paths.gbpPoster, '--date', day1.post_date], projectRoot);
    const status = await applyDriverResult({ supabase, post: day1, result: r, env, log });
    await log(runId, 'gbp', status === 'posted' ? 'info' : 'warn', `Day 1 GBP → ${status} (exit ${r.exitCode})`);
  }

  // 3. Mark Days 2-7 scheduled + propagate the weekly approval into the workbook gate.
  const later = gbpPosts.filter(p => p.day > 1);
  if (later.length) {
    await supabase.from('weekly_posts').update({ status: 'scheduled' })
      .eq('run_id', runId).eq('platform', 'gbp').gt('day', 1);
    const dateArgs = later.map(p => p.post_date).filter(Boolean).flatMap(d => ['--date', d]);
    if (dateArgs.length) {
      const appr = await runPhase(runId, 'gbp', paths.seoAgentsExe, ['mark-gbp-approved', ...dateArgs], projectRoot);
      if (!appr.ok) await log(runId, 'gbp', 'warn', `mark-gbp-approved failed (Days 2-7 may block): ${appr.error}`);
    }
    await log(runId, 'gbp', 'info', 'Days 2-7 marked scheduled + approved in workbook');
  }
}

// Daily poster: post today's scheduled GBP rows. Caller gates this to once/day ≥9am
// Central using centralDateHour(). deps inline: { supabase, runPhase, log, env, todayDate, gbpPosterPath, projectRoot }
export async function runDailyGbp({ supabase, runPhase, log, env, todayDate, gbpPosterPath, projectRoot }) {
  const { data: todayGbp } = await supabase
    .from('weekly_posts')
    .select('id, run_id, post_date, photo_file')
    .eq('platform', 'gbp')
    .eq('status', 'scheduled')
    .eq('post_date', todayDate)
    .order('post_date', { ascending: true });

  for (const post of todayGbp || []) {
    await log(post.run_id, 'gbp', 'info', `Posting scheduled GBP for ${post.post_date}`);
    const result = await runPhase(post.run_id, 'gbp', 'node', [gbpPosterPath, '--date', post.post_date], projectRoot);
    const status = await applyDriverResult({ supabase, post, result, env, log });
    await log(post.run_id, 'gbp', status === 'error' ? 'error' : 'info', `Daily GBP ${post.post_date} → ${status} (exit ${result.exitCode})`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/gbp-runner.test.mjs`
Expected: PASS — prints both `ok gbp-runner pure helpers` and `ok gbp-runner orchestration`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/gbp-runner.mjs scripts/lib/gbp-runner.test.mjs
git commit -m "feat(gbp): orchestration (run + daily) in shared gbp-runner module"
```

---

## Task 4: The `gbp-worker.mjs` entry point

**Files:**
- Create: `scripts/gbp-worker.mjs`

The worker polls Supabase for `gbp` work and runs it via `gbp-runner`. It mirrors `mav-bridge`'s env loading, Supabase client, and `log`/`hopError`, but only touches `gbp` rows.

- [ ] **Step 1: Write the worker**

Create `scripts/gbp-worker.mjs`:

```javascript
#!/usr/bin/env node
/**
 * gbp-worker.mjs
 * User-session GBP poster. Runs as `carte` via a Windows Scheduled Task
 * ("run only when user is logged on") so the saved Google session
 * (C:\Users\carte\.claude\gbp-session), the H:\ Drive mount, and a visible
 * browser are all available — none of which exist under the LocalSystem
 * mav-bridge service.
 *
 * Owns the `gbp` slice of weekly_posts; mav-bridge owns facebook/website.
 * Disjoint platform ownership over the shared Supabase queue = no double-post.
 * Errors are written to weekly_posts.status/.error, which mav-bridge's existing
 * fault-detection alerts on (iMessage + email).
 *
 * Usage:
 *   node gbp-worker.mjs           Poll forever (default; the Scheduled Task runs this)
 *   node gbp-worker.mjs --once    One poll pass, then exit (smoke/manual test)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { makeRunPhase } from './lib/run-phase.mjs';
import { centralDateHour, runGbpForApprovedRun, runDailyGbp } from './lib/gbp-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env (same loader as mav-bridge)
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.GBP_WORKER_POLL_MS || process.env.MAV_BRIDGE_POLL_MS || '30000');
const SEO_AGENTS_EXE = process.env.SEO_AGENTS_EXE
  || 'C:\\Users\\carte\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\seo-agents.exe';
const GBP_POSTER_PATH = 'C:\\Users\\carte\\.claude\\skills\\gbp-poster\\driver.mjs';
const PHOTO_PICK_PATH = path.join(PROJECT_ROOT, 'scripts', 'gbp-photo-pick.mjs');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[gbp-worker] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function log(runId, phase, level, message) {
  console.log(`[gbp-worker][${phase}][${level}] ${message}`);
  if (runId) {
    const { error } = await supabase.from('run_logs').insert({ run_id: runId, phase, level, message });
    if (error) console.error(`[gbp-worker][supabase][error] log insert failed: ${error.message}`);
  }
}
async function hopError(runId, phase, hop, message, err) {
  const detail = err ? `${message}: ${err.message || err}` : message;
  console.error(`[gbp-worker][${hop}][error] ${detail}`);
  if (runId) await supabase.from('run_logs').insert({ run_id: runId, phase, level: 'error', message: `[${hop}] ${detail}` });
}

const runPhase = makeRunPhase({ log, hopError, projectRoot: PROJECT_ROOT });
const paths = { photoPick: PHOTO_PICK_PATH, gbpPoster: GBP_POSTER_PATH, seoAgentsExe: SEO_AGENTS_EXE };

let busy = false;
let lastDailyGbpDate = '';

async function poll() {
  if (busy) return;
  busy = true;
  try {
    // 1. Approved-run GBP: claim this run's gbp rows (approved → posting) so a second
    //    poll can't double-process, then run curation + sync + Day-1 + mark Days 2-7.
    const { data: approved, error: apprErr } = await supabase
      .from('weekly_posts')
      .select('*')
      .eq('platform', 'gbp')
      .eq('status', 'approved')
      .order('run_id');
    if (apprErr) console.error(`[gbp-worker][supabase][error] approved query: ${apprErr.message}`);

    if (approved?.length) {
      // Process the earliest run_id only (mirrors mav-bridge's one-run-per-poll).
      const runId = approved[0].run_id;
      const gbpPosts = approved.filter(p => p.run_id === runId);
      await supabase.from('weekly_posts').update({ status: 'posting' })
        .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');
      await log(runId, 'gbp', 'info', `Claimed ${gbpPosts.length} gbp post(s) for run ${String(runId).slice(0, 8)}`);
      await runGbpForApprovedRun({
        runId,
        gbpPosts,
        deps: { supabase, runPhase, log, env: process.env, projectRoot: PROJECT_ROOT, paths },
      });
    }

    // 2. Daily poster: today's scheduled gbp rows, once/day ≥9am Central.
    const { todayDate, cstHour } = centralDateHour(new Date());
    if (cstHour >= 9 && lastDailyGbpDate !== todayDate) {
      lastDailyGbpDate = todayDate;
      await runDailyGbp({
        supabase, runPhase, log,
        env: process.env,
        todayDate, gbpPosterPath: GBP_POSTER_PATH, projectRoot: PROJECT_ROOT,
      });
    }
  } catch (e) {
    console.error(`[gbp-worker][poll][error] ${e.message}`);
  } finally {
    busy = false;
  }
}

const once = process.argv.includes('--once');
console.log(`[gbp-worker] Starting — project root: ${PROJECT_ROOT}`);
if (once) {
  await poll();
  console.log('[gbp-worker] --once complete');
  process.exit(0);
} else {
  console.log(`[gbp-worker] Polling Supabase every ${POLL_INTERVAL_MS / 1000}s`);
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check scripts/gbp-worker.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Smoke test `--once`**

Run: `node scripts/gbp-worker.mjs --once`
Expected: prints `[gbp-worker] Starting…` then `[gbp-worker] --once complete` and exits 0. With no approved gbp rows it does nothing; with real `.env` it will only act on genuine gbp work. A clean exit (no stack trace, no `is not a function`) is the pass. (If it's before 9am Central or there are no scheduled rows for today, the daily branch is correctly skipped.)

- [ ] **Step 4: Commit**

```bash
git add scripts/gbp-worker.mjs
git commit -m "feat(gbp): user-session gbp-worker entry point"
```

---

## Task 5: Stop mav-bridge from doing GBP (gate behind `MAV_BRIDGE_GBP`, default off)

The worker now owns GBP. Remove the inline GBP logic from `mav-bridge.mjs` and replace the call sites with guarded calls into the shared module. Default `off` → the service does no GBP and cannot double-post. `MAV_BRIDGE_GBP=on` is an emergency lever to put GBP back on the service (and would require stopping the worker).

**Files:**
- Modify: `scripts/mav-bridge.mjs`

- [ ] **Step 1: Add imports + the flag + paths**

Near the other `./lib/...` imports, add:

```javascript
import { runGbpForApprovedRun, runDailyGbp, centralDateHour } from './lib/gbp-runner.mjs';
```

Below the existing constants (near `GBP_POSTER_PATH`, ~line 46), add:

```javascript
// GBP is owned by the user-session gbp-worker (Scheduled Task). The service does NO
// GBP by default. Flip to 'on' ONLY as a rollback, and stop gbp-worker first to avoid
// double-posting. See docs/runbooks/gbp-worker.md.
const GBP_ON = (process.env.MAV_BRIDGE_GBP || 'off').toLowerCase() === 'on';
const PHOTO_PICK_PATH = path.join(PROJECT_ROOT, 'scripts', 'gbp-photo-pick.mjs');
const GBP_PATHS = { photoPick: PHOTO_PICK_PATH, gbpPoster: GBP_POSTER_PATH, seoAgentsExe: SEO_AGENTS_EXE };
```

- [ ] **Step 2: Remove the now-dead inline GBP helpers**

Delete these functions from `mav-bridge.mjs` (all moved to `lib/gbp-runner.mjs`):
- `excelDateToIso` (~lines 173-180)
- `parseDriverJson` (~lines 182-189)
- `gbpNeedsVerificationMessage` (~lines 191-196)
- `markGbpPostedAndArchive` (~lines 200-261)

Leave the `// GBP Excel + photo archive helpers` comment banner or delete it — cosmetic.

- [ ] **Step 3: Replace executeApprovedRun's GBP sections with one guarded call**

In `executeApprovedRun`:

a) Delete the **Step 0 curation block** (the `// ── 0. GBP photo curation …` block that runs `PHOTO_PICK_PATH`, ~lines 386-400).

b) Delete the entire **`// ── 2. GBP posts ──` block** (~lines 472-559, from the `const { data: gbpPosts } = …` query through the end of its `if (gbpPosts?.length) { … }`).

c) In place of where block 2 was, insert:

```javascript
  // ── 2. GBP posts (owned by gbp-worker; service only acts if MAV_BRIDGE_GBP=on) ──
  if (GBP_ON) {
    const { data: gbpPosts } = await supabase
      .from('weekly_posts').select('*')
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');
    if (gbpPosts?.length) {
      await supabase.from('weekly_posts').update({ status: 'posting' })
        .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');
      await runGbpForApprovedRun({
        runId, gbpPosts,
        deps: { supabase, runPhase, log, env: process.env, projectRoot: PROJECT_ROOT, paths: GBP_PATHS },
      });
    }
  }
```

Note: with `GBP_ON` false (default), `allOk` is unaffected by GBP — the run is marked `done` on FB+website success while the worker finishes GBP asynchronously. The `/seo/status` `liveRunStatus` derives the run's displayed status from all posts (incl. gbp), so the dashboard stays accurate.

- [ ] **Step 4: Replace the daily GBP loop in `poll()`**

In `poll()`, the daily block currently computes Central time inline and then posts GBP and reconciles FB. Replace the inline Central-time computation (~lines 638-646) with the shared helper and guard only the GBP loop — **keep the Facebook reconciliation**.

Find this region (the `const nowUtc = new Date(); … const todayDate = …; let cstHour = …; if (cstHour >= 9 && lastDailyGbpDate !== todayDate) { … }`) and rewrite it as:

```javascript
    // ── Daily tick: once per calendar day after 9am Central ──
    const { todayDate, cstHour } = centralDateHour(new Date());
    if (cstHour >= 9 && lastDailyGbpDate !== todayDate) {
      lastDailyGbpDate = todayDate;

      // GBP daily posting is owned by gbp-worker. Service only posts if MAV_BRIDGE_GBP=on.
      if (GBP_ON) {
        await runDailyGbp({
          supabase, runPhase, log, env: process.env,
          todayDate, gbpPosterPath: GBP_POSTER_PATH, projectRoot: PROJECT_ROOT,
        });
      }

      // ── Facebook reconciliation (unchanged — always runs) ──
      // FB Days 2–7 are scheduled on Facebook's native scheduler at run time. Once a
      // scheduled FB row's date has passed, the post is live — advance it to 'posted'.
      // ponytail: optimistic — no post-hoc FB read-back. Ceiling: a dropped FB post
      // would still show posted. Upgrade: re-fetch each platform_post_id via Graph API.
      const { data: pastFb } = await supabase
        .from('weekly_posts').select('id, post_date')
        .eq('platform', 'facebook').eq('status', 'scheduled').lt('post_date', todayDate);
      for (const post of pastFb || []) {
        await supabase.from('weekly_posts')
          .update({ status: 'posted', posted_at: new Date().toISOString() })
          .eq('id', post.id);
        console.log(`[mav-bridge][fb-reconcile] ${post.post_date} scheduled date passed — marked posted`);
      }
    }
```

Delete the old inline `nowUtc`/`ctParts`/`ctp`/`todayDate`/`cstHour` lines and the old `for (const post of todayGbp …)` GBP loop entirely (the FB reconcile code above is the same logic that previously followed the GBP loop).

- [ ] **Step 5: Verify mav-bridge parses and boots**

Run: `node --check scripts/mav-bridge.mjs`
Expected: exit 0, no output.

Run (boot smoke, then kill):
`node -e "import('./scripts/mav-bridge.mjs').catch(e=>{console.error(e.message);process.exit(1)})" &`
Expected: `[mav-bridge] Starting…` (or the explicit missing-env message). Fail = any `ReferenceError`/`is not defined` (e.g. a leftover reference to a deleted helper). Search for stragglers:

Run: `grep -n "markGbpPostedAndArchive\|parseDriverJson\|gbpNeedsVerificationMessage\|todayGbp" scripts/mav-bridge.mjs`
Expected: **no matches** (all GBP-only references removed). Kill the smoke process.

- [ ] **Step 6: Run the existing bridge-related self-checks to confirm no collateral breakage**

Run: `node scripts/lib/action-enrich.test.mjs && node scripts/lib/alert-store.test.mjs && node scripts/lib/run-phase.test.mjs && node scripts/lib/gbp-runner.test.mjs`
Expected: four `ok …` lines, exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/mav-bridge.mjs
git commit -m "feat(bridge): hand GBP to gbp-worker; gate service GBP behind MAV_BRIDGE_GBP (default off)"
```

---

## Task 6: driver.mjs — detect the logged-out marketing page

`assertLoggedIn` only catches the `accounts.google.com` redirect and a "Sign in" button. A session that's expired but lands on the GBP marketing page ("Stand out on Google with a free Business Profile") slips through and fails later as `ui_changed_or_timeout`. Add detection so it's reported as `session_expired`.

**Files (outside this git repo — in the gbp-poster skill):**
- Modify: `C:\Users\carte\.claude\skills\gbp-poster\driver.mjs`
- Create: `C:\Users\carte\.claude\skills\gbp-poster\driver.selfcheck.mjs`

- [ ] **Step 1: Write the self-check**

Create `C:\Users\carte\.claude\skills\gbp-poster\driver.selfcheck.mjs`:

```javascript
// driver.selfcheck.mjs — verify the logged-out marketing-page message classifies
// as session_expired (the regex that routes the new throw to the right failure
// reason + RETRYABLE exclusion).
import assert from 'node:assert/strict';
import { classifyFailure } from './driver.mjs';

assert.equal(
  classifyFailure('GBP session expired (logged-out Business Profile marketing page shown). Re-authenticate with: node driver.mjs --auth'),
  'session_expired',
);
// regression: the existing sign-in redirect still classifies correctly
assert.equal(classifyFailure('redirected to accounts.google.com'), 'session_expired');
// a generic timeout must NOT be mistaken for session_expired
assert.equal(classifyFailure('waiting for selector timed out'), 'ui_changed_or_timeout');

console.log('ok driver session-expired classification');
```

- [ ] **Step 2: Run it to verify it passes already (classifyFailure pre-exists)**

Run: `node "C:\Users\carte\.claude\skills\gbp-poster\driver.selfcheck.mjs"`
Expected: PASS — `ok driver session-expired classification`. (This guards the message wording; the new throw string contains "session expired", which `classifyFailure` already maps. It will pass before AND after Step 3 — that's intended: it locks the contract that the message we add classifies correctly.)

- [ ] **Step 3: Add the marketing-page detection in `assertLoggedIn`**

In `C:\Users\carte\.claude\skills\gbp-poster\driver.mjs`, find `assertLoggedIn` (lines ~123-131). After the existing "Sign in" button check and before the closing brace, add:

```javascript
    // Expired sessions sometimes land on the public GBP marketing page instead of
    // redirecting to accounts.google.com. Catch it explicitly so it's reported as
    // session_expired (→ needs --auth) rather than a downstream ui_changed timeout.
    const loggedOutMarketing = page.getByText(
      /Stand out on Google|free Business Profile|Get your free Business Profile|Manage your Business Profile/i,
    ).first();
    if (await loggedOutMarketing.isVisible({ timeout: 1000 }).catch(() => false)) {
      throw new Error('GBP session expired (logged-out Business Profile marketing page shown). Re-authenticate with: node driver.mjs --auth');
    }
```

- [ ] **Step 4: Verify the driver still parses and the self-check still passes**

Run: `node --check "C:\Users\carte\.claude\skills\gbp-poster\driver.mjs"`
Expected: exit 0, no output.

Run: `node "C:\Users\carte\.claude\skills\gbp-poster\driver.selfcheck.mjs"`
Expected: PASS — `ok driver session-expired classification`.

- [ ] **Step 5: Manual integration note (no automated browser test)**

The page-detection logic itself can only be exercised against a real logged-out
session. After deploying, verify once manually: with the Google session signed out,
run `node "C:\Users\carte\.claude\skills\gbp-poster\driver.mjs" --date <today>` and
confirm the JSON result has `"failure_reason":"session_expired"` and the stderr tells
you to run `--auth`. Re-auth with
`node "C:\Users\carte\.claude\skills\gbp-poster\driver.mjs" --auth`.

- [ ] **Step 6: Commit (only if the skills dir is version-controlled)**

```bash
# The gbp-poster skill lives outside the SEO-Agents-App repo. If that directory is a
# git repo, commit there; otherwise the edit + self-check simply live on disk.
cd "C:\Users\carte\.claude\skills\gbp-poster" && git rev-parse --is-inside-work-tree 2>/dev/null \
  && git add driver.mjs driver.selfcheck.mjs \
  && git commit -m "fix(gbp-driver): detect logged-out marketing page as session_expired" \
  || echo "skills dir not a git repo — changes saved on disk only"
```

Return to the worktree afterward for the remaining tasks.

---

## Task 7: Register the worker as a Scheduled Task + runbook

**Files:**
- Create: `ops/gbp-worker-task.xml`
- Create: `docs/runbooks/gbp-worker.md`

- [ ] **Step 1: Create the Task Scheduler definition**

Create `ops/gbp-worker-task.xml`. This is a Task Scheduler v1.2 export: logon trigger for `carte`, run only when logged on, restart-on-failure, no execution time limit (it's a daemon). Replace the `node` path in `<Command>` only if `where node` reports a different location.

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Grizzly SEO GBP worker — posts Google Business Profile updates from Carter's interactive session (saved Google login, H: Drive mount, visible browser). Owns the gbp slice; mav-bridge owns facebook/website.</Description>
    <URI>\Grizzly SEO GBP Worker</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>CARTERSPC\carte</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>CARTERSPC\carte</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\nodejs\node.exe</Command>
      <Arguments>C:\Workspace\Active\SEO-Agents-App\scripts\gbp-worker.mjs</Arguments>
      <WorkingDirectory>C:\Workspace\Active\SEO-Agents-App</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

- [ ] **Step 2: Confirm the node.exe path before registering**

Run: `where node`
Expected: a path like `C:\Program Files\nodejs\node.exe`. If different, update `<Command>` in the XML to match.

- [ ] **Step 3: Write the runbook**

Create `docs/runbooks/gbp-worker.md`:

```markdown
# GBP Worker Runbook

The GBP worker (`scripts/gbp-worker.mjs`) posts Google Business Profile updates from
Carter's interactive `carte` session. It exists because the LocalSystem `mav-bridge`
service cannot post GBP: under LocalSystem `os.homedir()` is the system profile (so the
saved Google login at `C:\Users\carte\.claude\gbp-session` is invisible), the `H:\`
Drive photo mount is absent, and Playwright needs a visible desktop.

**Ownership split:** the worker owns `weekly_posts` rows where `platform='gbp'`.
`mav-bridge` owns `facebook` + website + run orchestration + alerting. They share
Supabase; ownership is disjoint, so they cannot double-post.

## Install the Scheduled Task

From an elevated PowerShell:

    schtasks /create /tn "Grizzly SEO GBP Worker" /xml "C:\Workspace\Active\SEO-Agents-App\ops\gbp-worker-task.xml" /ru CARTERSPC\carte

Start it now without re-logging-in:

    schtasks /run /tn "Grizzly SEO GBP Worker"

Verify it's registered and running:

    schtasks /query /tn "Grizzly SEO GBP Worker" /v /fo LIST

The task is also triggered automatically at each logon of `carte`. It is a long-running
daemon (its own poll loop), so one launch per login is expected; "Restart on failure"
covers crashes.

## Verify it's working

    node C:\Workspace\Active\SEO-Agents-App\scripts\gbp-worker.mjs --once

A clean exit with `[gbp-worker] --once complete` and no stack trace means the wiring is
healthy. Real posting only happens when there are approved/scheduled `gbp` rows.

## Re-authenticate the Google session

When a GBP post fails with `session_expired` (you'll get an iMessage/email via
mav-bridge's fault detection), re-auth interactively:

    node "C:\Users\carte\.claude\skills\gbp-poster\driver.mjs" --auth

Log into Google Business Profile in the window that opens, then close it.

## Rollback (put GBP back on the service)

Only if the worker is broken and you need GBP posting restored on `mav-bridge`:

1. **Stop the worker first** (prevents double-posting):
   `schtasks /end /tn "Grizzly SEO GBP Worker"` and disable it:
   `schtasks /change /tn "Grizzly SEO GBP Worker" /disable`
2. Set `MAV_BRIDGE_GBP=on` in `C:\Workspace\Active\SEO-Agents-App\.env`.
3. Restart mav-bridge: `pm2 restart mav-bridge` (or restart the PM2 service).

Note: the service still runs under LocalSystem, so GBP will only actually work there if
the service itself has been moved to a user session — otherwise this rollback restores
the *old broken* behavior. Prefer fixing the worker.
```

- [ ] **Step 4: Validate the XML is well-formed**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('ops/gbp-worker-task.xml','utf16le');if(!s.includes('LogonTrigger'))throw new Error('bad xml');console.log('xml ok')"`
Expected: `xml ok`. (If the file was saved UTF-8 instead of UTF-16, re-save as UTF-16 LE — `schtasks /create /xml` requires UTF-16. Adjust the `readFileSync` encoding if your editor wrote UTF-8 and confirm `schtasks` accepts it in Step 5 of verification.)

- [ ] **Step 5: Commit**

```bash
git add ops/gbp-worker-task.xml docs/runbooks/gbp-worker.md
git commit -m "ops(gbp): scheduled-task definition + runbook for gbp-worker"
```

---

## Final integration verification (after all tasks)

- [ ] **All self-checks green:**

Run: `node scripts/lib/gbp-runner.test.mjs && node scripts/lib/run-phase.test.mjs && node scripts/lib/action-enrich.test.mjs && node scripts/lib/alert-store.test.mjs`
Expected: four `ok …` lines.

- [ ] **No GBP stragglers in mav-bridge:**

Run: `grep -n "gbp-photo-pick\|sync-gbp-schedule\|markGbpPostedAndArchive" scripts/mav-bridge.mjs`
Expected: no matches (the only GBP references left are the guarded `runGbpForApprovedRun`/`runDailyGbp` calls and the `GBP_ON`/`GBP_PATHS`/`GBP_POSTER_PATH` constants).

- [ ] **Both entry points parse:**

Run: `node --check scripts/mav-bridge.mjs && node --check scripts/gbp-worker.mjs`
Expected: exit 0.

- [ ] **Install the task** per the runbook and confirm `schtasks /query /tn "Grizzly SEO GBP Worker"` shows it.

- [ ] **End-to-end smoke** on the next real approved run: confirm a Day-1 GBP post appears, the worker logs to `run_logs`, and `mav-bridge` no longer logs any `[gbp]` phase lines (proving the split).
```
