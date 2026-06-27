// scripts/lib/run-phase.mjs
// Subprocess runner shared by mav-bridge and gbp-worker. The caller supplies
// log + hopError (each wires its own Supabase client), a default cwd, and an
// optional hopPrefix so each process tags failures with its own source name.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function makeRunPhase({ log, hopError, projectRoot, hopPrefix = 'mav-bridge' }) {
  return async function runPhase(runId, phase, exe, args, cwd, opts = {}) {
    // Default 15 min. The facebook phase needs more: it can render up to 3 Veo 3
    // videos sequentially (each up to ~13 min — see facebook-poster VIDEO_GEN_TIMEOUT_MS),
    // so callers pass a longer timeoutMs to keep Fix 1 effective end-to-end.
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
      await hopError(runId, phase, `${hopPrefix}→subprocess:${phase}`, `${exe} failed (exit ${exitCode})${killed}`, { message: detail });
      return { ok: false, stdout, stderr, exitCode, error: detail };
    }
  };
}
