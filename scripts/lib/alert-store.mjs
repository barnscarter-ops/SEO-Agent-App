// scripts/lib/alert-store.mjs
// Persisted dedup for fired alerts so a fault alerts once, not every poll.
// Key = `${runId}:${actionId}:${faultType}`. Survives reboot via a JSON file.
import fs from 'node:fs';

export function makeAlertStore(filePath) {
  const load = () => {
    try { return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { return new Set(); }
  };
  const save = (set) => {
    try { fs.writeFileSync(filePath, JSON.stringify([...set])); } catch {}
  };
  const key = (runId, actionId, faultType) => `${runId || '-'}:${actionId}:${faultType}`;

  return {
    // Returns true exactly once per (run,action,fault) until cleared.
    shouldFire(runId, actionId, faultType) {
      const set = load();
      const k = key(runId, actionId, faultType);
      if (set.has(k)) return false;
      set.add(k);
      save(set);
      return true;
    },
    clearFault(runId, actionId, faultType) {
      const set = load();
      if (set.delete(key(runId, actionId, faultType))) save(set);
    },
  };
}
