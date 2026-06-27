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
