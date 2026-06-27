// scripts/lib/alert-store.mjs
// Persisted dedup for fired alerts so a fault alerts once, not every poll.
// Key = `${runId}:${actionId}:${faultType}`. Survives reboot via a JSON file.
import fs from 'node:fs';

export function makeAlertStore(filePath) {
  // ponytail: load+save the whole Set on every call (sync disk IO). Fine at our
  // scale (a handful of faults); if the set grows large, cache in memory + flush on write.
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
    // True when no alert has ever been recorded — used to detect a cold start
    // so the first poll can adopt existing faults as baseline (no alert blast).
    isEmpty() {
      return load().size === 0;
    },
    // Record a fault as already-known WITHOUT treating it as a fresh fire.
    // Used for baseline seeding so pre-existing faults don't alert on first run.
    record(runId, actionId, faultType) {
      const set = load();
      set.add(key(runId, actionId, faultType));
      save(set);
    },
  };
}
