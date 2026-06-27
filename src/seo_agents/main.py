from __future__ import annotations

import argparse
import json
import os
import shutil
import smtplib
import sys
import time
from datetime import date, datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path

from dotenv import load_dotenv

from seo_agents.actions import (
    approve_action,
    format_action_queue_text,
    gbp_adapter_status,
    mark_gbp_dates_approved,
    run_action,
    sync_gbp_schedule_to_workbook,
    wordpress_adapter_status,
    write_action_queue,
)
from seo_agents.crew import (
    DEFAULT_AUDIENCE,
    DEFAULT_REGION,
    DEFAULT_SITE_URL,
    ARCHIVE_DIR,
    OUTPUT_DIR,
    archive_used_photos,
    build_executor_crew,
    build_facebook_crew,
    build_poster_crew,
    build_seo_crew,
)
from seo_agents.status import (
    build_workflow_status,
    format_status_text,
    format_validation_text,
    validate_workflow_outputs,
    write_workflow_status,
)


RESEARCH_OUTPUTS = [
    "content_report.md",
    "website_report.md",
    "gbp_report.md",
    "reputation_report.md",
    "grizzly_local_presence_plan.md",
    "grizzly_execution_queue.md",
]

RUN_HEALTH_FILE = OUTPUT_DIR / "run_health.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


_PHASE_LABELS = {
    "research": "Research",
    "execute": "Execution",
    "post_schedule": "GBP Post Schedule",
}


def _send_failure_alert(phase: str, error: str, topic: str, at: str) -> None:
    """Send a Gmail SMTP alert when a phase fails. Silently skips if not configured."""
    app_password = os.getenv("SMTP_APP_PASSWORD", "").strip()
    from_addr = os.getenv("SMTP_FROM_EMAIL", "barnscarter@gmail.com").strip()
    to_addr = os.getenv("SMTP_TO_EMAIL", "barnscarter@gmail.com").strip()
    if not app_password:
        return  # Not configured — skip silently

    phase_label = _PHASE_LABELS.get(phase, phase)
    topic_line = f"\nTopic: {topic}" if topic else ""
    subject = f"⚠ SEO Agent FAILED: {phase_label}"
    body = (
        f"A Maverick SEO agent run failed and needs your attention.\n\n"
        f"Phase:     {phase_label}{topic_line}\n"
        f"Failed at: {at}\n"
        f"Error:\n\n{error or 'No error message captured.'}\n\n"
        f"---\n"
        f"Check outputs/run_health.json and the terminal logs for details.\n"
        f"Fix the issue before the next scheduled Friday run.\n\n"
        f"— Maverick Console"
    )
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as smtp:
            smtp.starttls()
            smtp.login(from_addr, app_password)
            smtp.sendmail(from_addr, [to_addr], msg.as_string())
        print(f"\n📧 Failure alert sent to {to_addr}")
    except Exception as exc:
        print(f"\n⚠ Could not send failure alert: {exc}")


def write_run_health(phase: str, status: str, topic: str = "", error: str = "", started_at: float | None = None) -> None:
    """Write per-phase run health so MCC can show last-run status and alert on failures."""
    OUTPUT_DIR.mkdir(exist_ok=True)
    existing: dict = {}
    if RUN_HEALTH_FILE.exists():
        try:
            existing = json.loads(RUN_HEALTH_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    at = _now_iso()
    existing[phase] = {
        "status": status,
        "topic": topic or None,
        "at": at,
        "duration_s": round(time.monotonic() - started_at, 1) if started_at is not None else None,
        "error": error or None,
    }
    tmp = RUN_HEALTH_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
    tmp.replace(RUN_HEALTH_FILE)
    if status == "failed":
        _send_failure_alert(phase, error, topic, at)


def archive_research_run(topic: str, run_args: dict) -> Path:
    """Copy all research outputs to a timestamped archive folder for trend analysis."""
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    run_dir = ARCHIVE_DIR / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    archived = []
    for fname in RESEARCH_OUTPUTS:
        src = OUTPUT_DIR / fname
        if src.exists():
            shutil.copy2(src, run_dir / fname)
            archived.append(fname)
    meta = {
        "topic": topic,
        "phase": "research",
        "archived_at": _now_iso(),
        "args": run_args,
        "files": archived,
    }
    (run_dir / "run_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return run_dir


def load_previous_run_context(max_runs: int = 2) -> str:
    """Return a brief summary from the last N research runs for trend injection.

    Pulls the first 40 lines of each archived manager plan so the crew can
    recognise what was recommended previously and look for improvement signals.
    """
    if not ARCHIVE_DIR.exists():
        return ""
    runs = sorted(
        (d for d in ARCHIVE_DIR.iterdir() if d.is_dir() and (d / "run_meta.json").exists()),
        key=lambda d: d.name,
        reverse=True,
    )[:max_runs]
    if not runs:
        return ""
    sections = []
    for run_dir in runs:
        meta_path = run_dir / "run_meta.json"
        plan_path = run_dir / "grizzly_local_presence_plan.md"
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        archived_at = meta.get("archived_at", run_dir.name)
        topic = meta.get("topic", "unknown")
        plan_snippet = ""
        if plan_path.exists():
            lines = plan_path.read_text(encoding="utf-8", errors="replace").splitlines()
            plan_snippet = "\n".join(lines[:40])
        sections.append(
            f"### Run: {archived_at} | Topic: {topic}\n\n{plan_snippet}"
        )
    if not sections:
        return ""
    return (
        "The following is a summary of previous research runs. "
        "Use this to identify trends, measure whether prior recommendations had impact, "
        "and refine your approach over time. Do NOT repeat recommendations that are already done.\n\n"
        + "\n\n---\n\n".join(sections)
    )


def _call_local_llm(prompt: str, max_tokens: int = 2000) -> str:
    """Call the local llama-server (or configured API base) directly.

    Uses OPENROUTER_API_KEY for auth. Strips Qwen3 <think> blocks automatically.
    """
    import re
    import urllib.error
    import urllib.request

    def _strip_think(text: str) -> str:
        return re.sub(r"(?s)<think>.*?</think>", "", text).strip()

    api_base = os.getenv("CREWAI_RESEARCH_API_BASE", "https://openrouter.ai/api/v1").rstrip("/")
    _raw_model = os.getenv("CREWAI_RESEARCH_MODEL", "openrouter/z-ai/glm-5.2")
    model = _raw_model.replace("openrouter/", "", 1) if _raw_model.startswith("openrouter/") else _raw_model
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }).encode()

    # Call OpenRouter API
    _or_error = None
    try:
        req = urllib.request.Request(
            f"{api_base}/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.getenv('OPENROUTER_API_KEY', '')}",
            },
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
        content = data["choices"][0]["message"]["content"]
        if content is None:
            # GLM 5.2 reasoning model may return None for content if all tokens went to reasoning
            raise RuntimeError("Model returned null content (try increasing max_tokens)")
        return _strip_think(content)
    except Exception as err:
        _or_error = err

    # If we get here, the OpenRouter request failed
    or_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not or_key:
        raise RuntimeError(
            "OpenRouter request failed and OPENROUTER_API_KEY is not set. "
            "Add your OpenRouter key to .env before running compact-baselines."
        )
    raise RuntimeError(
        f"OpenRouter request failed: {_or_error}. "
        f"Check OPENROUTER_API_KEY and network connectivity."
    )


def generate_blog_post(topic: str, keywords: str = "", status: str = "draft") -> dict:
    """Use Qwen to write a blog post then push it to WordPress via the REST adapter."""
    import subprocess

    kw_line = f"\nTarget keywords to naturally weave in: {keywords}" if keywords else ""
    prompt = (
        "You are a content writer for Grizzly Electrical Solutions, a licensed residential electrician "
        "serving Dallas-Fort Worth (Rowlett, Garland, Plano, Richardson, Dallas).\n\n"
        f"Write a complete, publish-ready blog post on this topic: {topic}{kw_line}\n\n"
        "RULES:\n"
        "- 400-700 words\n"
        "- Tone: direct, honest, contractor-real — no corporate fluff, no fear tactics\n"
        "- No DIY electrical instructions that could replace a licensed electrician\n"
        "- Include 2-4 H2 subheadings\n"
        "- End with a short CTA paragraph mentioning Grizzly's DFW service area and linking "
        "to https://www.grizzlyelectricaltx.com/contact-us/\n"
        "- Output ONLY the HTML body content (p, h2, ul/li tags). No <html>, no <head>, no <body> wrapper.\n"
        "- First line must be the title as plain text prefixed with TITLE: (e.g. TITLE: My Post Title)\n"
        "- Second line must be a one-sentence excerpt prefixed with EXCERPT:\n"
        "- Third line must be 3-5 hashtags prefixed with TAGS: (e.g. TAGS: electrical panel, DFW electrician)\n"
        "- Then a blank line, then the HTML content.\n"
    )

    print(f"  Generating blog post with Qwen: {topic!r}...")
    raw = _call_local_llm(prompt, max_tokens=2000)

    # Parse title / excerpt / tags from the first lines
    lines = raw.strip().splitlines()
    title, excerpt, tags_raw, html_lines = topic, "", "", []
    for i, line in enumerate(lines):
        if line.startswith("TITLE:"):
            title = line[6:].strip()
        elif line.startswith("EXCERPT:"):
            excerpt = line[8:].strip()
        elif line.startswith("TAGS:"):
            tags_raw = line[5:].strip()
        elif line.strip() == "" and i < 5:
            html_lines = lines[i + 1:]
            break
    if not html_lines:
        html_lines = [l for l in lines if not l.startswith(("TITLE:", "EXCERPT:", "TAGS:"))]
    content_html = "\n".join(html_lines).strip()

    tag_names = [t.strip().lstrip("#") for t in tags_raw.split(",") if t.strip()]

    print(f"  Title   : {title}")
    print(f"  Excerpt : {excerpt[:80]}{'...' if len(excerpt) > 80 else ''}")
    print(f"  Tags    : {', '.join(tag_names)}")
    print(f"  Content : {len(content_html)} chars")

    action = {
        "id": f"BLOG-{datetime.now().strftime('%Y%m%d%H%M%S')}",
        "action_type": "website_blog_post",
        "content_type": "post",
        "draft": {
            "title": title,
            "excerpt": excerpt,
            "content": content_html,
            "status": status,
        },
    }

    wp_config = os.getenv(
        "WORDPRESS_SITE_CONFIG",
        str(Path(__file__).parent.parent.parent / "config" / "wordpress-sites" / "grizzly.json"),
    )
    wp_adapter = os.getenv("WORDPRESS_ACTION_ADAPTER", "")

    result = {
        "topic": topic,
        "title": title,
        "excerpt": excerpt,
        "tags": tag_names,
        "content_chars": len(content_html),
        "status": status,
    }

    if not wp_adapter or not Path(wp_adapter).exists():
        result["wp_result"] = {"status": "skipped", "reason": "WORDPRESS_ACTION_ADAPTER not configured"}
        return result

    payload = json.dumps({"live": True, "approved": True, "action": action})
    cmd = ["node", wp_adapter, "--config", wp_config, "--payload", payload]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=str(Path(wp_adapter).parent))
        wp_out = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {}
        post_result = next((r for r in wp_out.get("results", []) if r.get("post_id")), {})
        result["wp_result"] = {
            "status": wp_out.get("status"),
            "post_id": post_result.get("post_id"),
            "link": post_result.get("link"),
            "post_status": post_result.get("post_status"),
            "message": post_result.get("message"),
        }
    except Exception as e:
        result["wp_result"] = {"status": "error", "error": str(e)}

    return result


def compact_baselines(dry_run: bool = False) -> dict:
    """Merge all current baseline files into one lean summary and archive the originals.

    Keeps the active baselines folder small so agent context never bloats.
    Run once a month, or whenever the folder feels heavy.
    """
    from seo_agents.crew import BASELINE_DIR, read_text

    source_files = sorted(BASELINE_DIR.glob("*.md"))
    if not source_files:
        return {"status": "nothing_to_compact", "files": []}

    combined_parts = []
    total_chars = 0
    for path in source_files:
        content = read_text(path)
        combined_parts.append(f"### FILE: {path.name}\n\n{content}")
        total_chars += len(content)

    combined = "\n\n---\n\n".join(combined_parts)
    today = date.today().isoformat()

    prompt = (
        f"You are compacting the knowledge baselines for a local SEO agent system "
        f"for Grizzly Electrical Solutions (DFW residential electrician).\n\n"
        f"Below are ALL current baseline files ({len(source_files)} files, {total_chars:,} chars). "
        f"Produce a single merged 'Current Status' document.\n\n"
        f"RULES:\n"
        f"- Keep it under 800 words total\n"
        f"- Preserve ALL active open items and recommendations (things not yet done)\n"
        f"- RESOLVED ISSUES section: one line per resolved item — just enough to prevent re-recommendation\n"
        f"- CURRENT SITE STATUS: key confirmed facts still true today\n"
        f"- OPEN ITEMS: still needs attention, with priority\n"
        f"- DO NOT RE-RECOMMEND: explicit list so future agents skip these\n"
        f"- Drop: verbose history, 'why it mattered' sections, success stories — those are archived\n"
        f"- Date this document: {today}\n\n"
        f"SOURCE FILES:\n{combined}\n\n"
        f"Write ONLY the markdown document. No preamble or explanation."
    )

    print(f"  Compacting {len(source_files)} baseline files ({total_chars:,} chars) → single summary...")
    summary = _call_local_llm(prompt, max_tokens=1200)

    if dry_run:
        return {
            "status": "dry_run",
            "source_files": [f.name for f in source_files],
            "source_chars": total_chars,
            "preview": summary[:600] + "\n...[truncated]" if len(summary) > 600 else summary,
        }

    # Archive originals
    month_str = datetime.now().strftime("%Y-%m")
    archive_dir = BASELINE_DIR / "archive" / month_str
    archive_dir.mkdir(parents=True, exist_ok=True)
    archived = []
    for path in source_files:
        shutil.copy2(path, archive_dir / path.name)
        path.unlink()
        archived.append(path.name)

    # Write new summary
    output_name = f"grizzly-current-status-{today}.md"
    output_path = BASELINE_DIR / output_name
    output_path.write_text(
        f"# Grizzly Electrical Solutions — Current SEO Status — {today}\n\n{summary}\n",
        encoding="utf-8",
    )

    return {
        "status": "compacted",
        "archived_to": str(archive_dir),
        "archived_files": archived,
        "output": output_name,
        "output_chars": len(summary),
        "reduction_pct": round((1 - len(summary) / max(total_chars, 1)) * 100),
    }


def _fetch_completed_tasks() -> str:
    """Fetch all completed website tasks from Supabase to inject into research context."""
    import json
    import urllib.error
    import urllib.request

    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        return ""
    try:
        req = urllib.request.Request(
            f"{url}/rest/v1/website_tasks?status=eq.done&select=title,description,details,updated_at,run_id&order=updated_at.desc&limit=50",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            tasks = json.loads(resp.read())
        if not tasks:
            return ""
        lines = ["COMPLETED TASKS FROM PREVIOUS RUNS (verify each is still live before recommending it again):"]
        for t in tasks:
            completed = t.get("updated_at", "")[:10] if t.get("updated_at") else "unknown date"
            task_id = (t.get("details") or {}).get("task_id", "?") if isinstance(t.get("details"), dict) else "?"
            lines.append(f"  - [{task_id}] {t.get('title', '?')} — completed {completed}")
        lines.append("\nFor each item above: scrape the relevant page and confirm the work is still in place.")
        lines.append("Mark CONFIRMED LIVE or REGRESSION before writing any new recommendations.")
        return "\n".join(lines)
    except Exception as exc:
        print(f"⚠ Could not fetch completed tasks from Supabase: {exc}")
        return ""


def _run_supabase_sync(week_of: str = "") -> None:
    """Push the current outputs to Supabase after a pipeline phase completes."""
    import subprocess

    script = Path(__file__).parent.parent.parent / "scripts" / "supabase-sync.mjs"
    if not script.exists():
        print("⚠ supabase-sync.mjs not found — skipping Supabase sync")
        return
    cmd = ["node", str(script)]
    if week_of:
        cmd += ["--week-of", week_of]
    print("\n🔄 Syncing to Supabase...")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=str(script.parent.parent))
        if proc.stdout:
            print(proc.stdout.strip())
        if proc.returncode != 0:
            print(f"⚠ Supabase sync failed (exit {proc.returncode}): {proc.stderr.strip()}")
        else:
            print("✅ Supabase sync complete")
    except Exception as exc:
        print(f"⚠ Supabase sync error: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Grizzly CrewAI local SEO agent system.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # --- research subcommand (default) ---
    research = subparsers.add_parser(
        "research",
        help="Run Phase 1–3: research agents + manager plan + execution queue.",
    )
    research.add_argument("topic", help="SEO focus, service page, report type, or campaign topic.")
    research.add_argument("--site-url", default="", help=f"Website URL to inspect. Default: {DEFAULT_SITE_URL}")
    research.add_argument("--audience", default="", help=f"Target audience. Default: {DEFAULT_AUDIENCE}")
    research.add_argument("--region", default="", help=f"Target search region. Default: {DEFAULT_REGION}")
    research.add_argument("--keywords", default="", help="Comma-separated seed keywords.")
    research.add_argument("--dry-run", action="store_true", help="Show crew config without calling LLM.")

    # --- execute subcommand ---
    execute = subparsers.add_parser(
        "execute",
        help="Run Phase 4–5: executor agents perform tasks, manager verifies, final report saved.",
    )
    execute.add_argument("--dry-run", action="store_true", help="Show crew config without calling LLM.")

    # --- post-schedule subcommand ---
    poster = subparsers.add_parser(
        "post-schedule",
        help="Run GBP Poster crew: pull trends, match photos, produce 7-day posting schedule.",
    )
    poster.add_argument("--days", type=int, default=7, help="Number of days to schedule. Default: 7")
    poster.add_argument("--start-date", default="", help="Start date YYYY-MM-DD. Default: next business day.")
    poster.add_argument("--dry-run", action="store_true", help="Show crew config without calling LLM.")

    # --- status subcommand ---
    status = subparsers.add_parser(
        "status",
        help="Show workflow status from generated outputs.",
    )
    status.add_argument("--json", action="store_true", help="Print machine-readable workflow status JSON.")

    # --- validate subcommand ---
    validate = subparsers.add_parser(
        "validate",
        help="Validate generated workflow outputs without running agents.",
    )
    validate.add_argument("--json", action="store_true", help="Print validation results as JSON.")

    # --- action queue commands ---
    actions = subparsers.add_parser(
        "actions",
        help="Build and show executable action queue from workflow outputs.",
    )
    actions.add_argument("--json", action="store_true", help="Print action queue JSON.")

    approve = subparsers.add_parser(
        "approve-action",
        help="Approve one action for live execution.",
    )
    approve.add_argument("action_id", help="Action id from seo-agents actions.")
    approve.add_argument("--by", default="owner", help="Approver name. Default: owner")
    approve.add_argument("--note", default="", help="Approval note.")

    run = subparsers.add_parser(
        "run-action",
        help="Run one action. Defaults to dry-run; use --live only after approval.",
    )
    run.add_argument("action_id", help="Action id from seo-agents actions.")
    run.add_argument("--live", action="store_true", help="Run against the live adapter where configured.")

    sync_gbp = subparsers.add_parser(
        "sync-gbp-schedule",
        help="Sync gbp_posting_schedule.md into the existing GBP poster workbook.",
    )
    sync_gbp.add_argument("--dry-run", action="store_true", help="Preview workbook rows without writing.")

    mark_approved = subparsers.add_parser(
        "mark-gbp-approved",
        help="Stamp workbook Status='Approved' for one or more post dates (weekly approval fan-out).",
    )
    mark_approved.add_argument("--date", action="append", required=True, dest="dates",
                               help="Post date YYYY-MM-DD; repeat for multiple days.")

    adapter_status = subparsers.add_parser(
        "adapter-status",
        help="Show live-action adapter readiness for MCC and SEO execution agents.",
    )
    adapter_status.add_argument("--json", action="store_true", help="Print adapter status as JSON.")

    compact = subparsers.add_parser(
        "compact-baselines",
        help="Merge all baseline files into one lean summary and archive the originals.",
    )
    compact.add_argument("--dry-run", action="store_true", help="Preview output without archiving.")
    compact.add_argument("--json", action="store_true", help="Print result as JSON.")

    blog = subparsers.add_parser(
        "blog-post",
        help="Generate a blog post with Qwen and publish it to WordPress as a draft.",
    )
    blog.add_argument("topic", help="Blog post topic or title idea.")
    blog.add_argument("--publish", action="store_true", help="Publish immediately instead of saving as draft.")
    blog.add_argument("--dry-run", action="store_true", help="Generate content but do not push to WordPress.")
    blog.add_argument("--keywords", default="", help="Optional comma-separated target keywords.")

    fb_schedule = subparsers.add_parser(
        "facebook-schedule",
        help="Run Facebook Schedule crew: build 7-day Facebook posting plan with hooks, stories, and video prompts.",
    )
    fb_schedule.add_argument("--days", type=int, default=7, help="Number of days to schedule. Default: 7")
    fb_schedule.add_argument("--start-date", default="", help="Start date YYYY-MM-DD. Default: next business day.")

    # Legacy: allow `seo-agents <topic>` as shorthand for `seo-agents research <topic>`
    parser.add_argument("topic", nargs="?", help=argparse.SUPPRESS)
    parser.add_argument("--site-url", default="", help=argparse.SUPPRESS)
    parser.add_argument("--audience", default="", help=argparse.SUPPRESS)
    parser.add_argument("--region", default="", help=argparse.SUPPRESS)
    parser.add_argument("--keywords", default="", help=argparse.SUPPRESS)
    parser.add_argument("--dry-run", action="store_true", help=argparse.SUPPRESS)

    return parser.parse_args()


def reconfigure_stdio() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def ensure_dirs() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    ARCHIVE_DIR.mkdir(exist_ok=True)


def _run_execute_pipeline() -> None:
    """Run execute → GBP schedule → Facebook schedule → Supabase sync.

    Called automatically after research and also when `seo-agents execute` is
    invoked directly.
    """
    queue_path = OUTPUT_DIR / "grizzly_execution_queue.md"
    if not queue_path.exists():
        print("❌ No execution queue found. Run research first:")
        print("   seo-agents research <topic>")
        sys.exit(1)

    crew = build_executor_crew()
    t0 = time.monotonic()
    try:
        result = crew.kickoff()
        print(result)
        final = OUTPUT_DIR / "final_report.md"
        archived_path = ""
        if final.exists():
            stamp = date.today().isoformat()
            archived_file = ARCHIVE_DIR / f"final_report_{stamp}.md"
            archived_file.write_bytes(final.read_bytes())
            archived_path = str(archived_file)
            print(f"\n✅ Final report archived to: {archived_file}")
        write_run_health("execute", "success", started_at=t0)
        write_workflow_status(
            phase="execute",
            phase_status="complete",
            extra={"archived_final_report": archived_path},
        )
    except Exception as e:
        write_run_health("execute", "failed", error=str(e), started_at=t0)
        write_workflow_status(phase="execute", phase_status="failed", error=str(e))
        print(f"\n❌ Executor crew failed: {e}")
        sys.exit(1)

    # Day 1 (today, Friday) posts immediately on approval.
    # Days 2-7 (Saturday through Thursday) are the 6-day scheduled queue via daily cron.
    start_date = date.today().isoformat()

    print(f"\n{'─'*60}")
    print(f"📅 Auto-running GBP post schedule (starting {start_date})...")
    t1 = time.monotonic()
    try:
        gbp_crew = build_poster_crew(start_date=start_date, days=7)
        gbp_result = gbp_crew.kickoff()
        print(gbp_result)
        schedule_path = OUTPUT_DIR / "gbp_posting_schedule.md"
        photo_path = os.getenv("GBP_PHOTO_PATH", r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos")
        archived_photos = archive_used_photos(schedule_path, Path(photo_path))
        if archived_photos:
            print(f"📁 Archived {len(archived_photos)} photo(s) to Archive folder")
        write_run_health("post_schedule", "success", started_at=t1)
        write_workflow_status(
            phase="post_schedule",
            phase_status="complete",
            args={"start_date": start_date, "days": 7},
            extra={"archived_photos": archived_photos},
        )
        print(f"✅ GBP posting schedule saved")
    except Exception as e:
        write_run_health("post_schedule", "failed", error=str(e), started_at=t1)
        write_workflow_status(phase="post_schedule", phase_status="failed", error=str(e))
        print(f"⚠ GBP post schedule failed (non-fatal): {e}")

    print(f"\n{'─'*60}")
    print(f"📘 Auto-running Facebook post schedule (starting {start_date})...")
    t2 = time.monotonic()
    try:
        fb_crew = build_facebook_crew(start_date=start_date, days=7)
        fb_result = fb_crew.kickoff()
        print(fb_result)
        write_run_health("facebook_schedule", "success", started_at=t2)
        print(f"✅ Facebook posting schedule saved")
    except Exception as e:
        write_run_health("facebook_schedule", "failed", error=str(e), started_at=t2)
        print(f"⚠ Facebook schedule failed (non-fatal): {e}")

    _run_supabase_sync()


def main() -> None:
    reconfigure_stdio()
    load_dotenv(override=True)
    args = parse_args()
    ensure_dirs()

    # Determine effective command
    command = args.command

    # Legacy positional: `seo-agents <topic>`
    if command is None and args.topic:
        command = "research"

    if command == "research" or (command is None and args.topic):
        topic = getattr(args, "topic", "") or ""
        run_args = {
            "topic": topic,
            "site_url": getattr(args, "site_url", ""),
            "audience": getattr(args, "audience", ""),
            "region": getattr(args, "region", ""),
            "keywords": getattr(args, "keywords", ""),
        }

        # Compact baselines first so agents don't re-recommend completed items
        print("\n🗜  Compacting baselines before research...")
        try:
            compact_result = compact_baselines()
        except Exception as _compact_err:
            print(f"   WARNING: Baseline compaction failed (non-fatal): {_compact_err}")
            compact_result = {"status": "skipped"}
        if compact_result["status"] == "compacted":
            print(f"   ✅ Baselines compacted: {len(compact_result['archived_files'])} files → {compact_result['output']} ({compact_result['reduction_pct']}% smaller)")
        elif compact_result["status"] == "nothing_to_compact":
            print("   ℹ  No baseline files to compact — continuing.")
        else:
            print(f"   ℹ  Baselines: {compact_result['status']}")

        previous_context = load_previous_run_context()
        print("📋 Fetching completed tasks from Supabase...")
        completed_tasks = _fetch_completed_tasks()
        if completed_tasks:
            print(f"   ✅ {completed_tasks.count(chr(10) + '  -')} completed task(s) loaded for verification")
        else:
            print("   ℹ  No completed tasks found — skipping verification step")
        crew = build_seo_crew(
            topic=topic,
            site_url=run_args["site_url"],
            audience=run_args["audience"],
            region=run_args["region"],
            keywords=run_args["keywords"],
            previous_context=previous_context,
            completed_tasks=completed_tasks,
        )
        if args.dry_run:
            print(f"Ready: {crew.name}")
            print(f"Agents ({len(crew.agents)}):")
            for agent in crew.agents:
                print(f"  - {agent.role}")
            print(f"Tasks: {len(crew.tasks)}")
            if previous_context:
                print(f"  (previous run context: {len(previous_context)} chars injected)")
            return
        t0 = time.monotonic()
        try:
            result = crew.kickoff()
            print(result)
            run_dir = archive_research_run(topic, run_args)
            print(f"\n📁 Research outputs archived to: {run_dir}")
            write_run_health("research", "success", topic=topic, started_at=t0)
            write_workflow_status(phase="research", phase_status="complete", args=run_args)
            print(f"\n{'─'*60}")
            print("🚀 Research complete — auto-starting execution pipeline...")
            print(f"{'─'*60}")
            _run_execute_pipeline()
        except Exception as e:
            write_run_health("research", "failed", topic=topic, error=str(e), started_at=t0)
            write_workflow_status(phase="research", phase_status="failed", args=run_args, error=str(e))
            print(f"\n❌ Research crew failed: {e}")
            sys.exit(1)

    elif command == "execute":
        if args.dry_run:
            crew = build_executor_crew()
            print(f"Ready: {crew.name}")
            print(f"Agents ({len(crew.agents)}):")
            for agent in crew.agents:
                print(f"  - {agent.role}")
            print(f"Tasks: {len(crew.tasks)}")
            return
        _run_execute_pipeline()

    elif command == "post-schedule":
        # Default start_date to today so the agent doesn't hallucinate a date
        start_date = getattr(args, "start_date", "") or date.today().isoformat()
        crew = build_poster_crew(
            start_date=start_date,
            days=getattr(args, "days", 7),
        )
        if args.dry_run:
            print(f"Ready: {crew.name}")
            print(f"Agents ({len(crew.agents)}):")
            for agent in crew.agents:
                print(f"  - {agent.role}")
            print(f"Tasks: {len(crew.tasks)}")
            return
        t0 = time.monotonic()
        try:
            result = crew.kickoff()
            print(result)
            schedule_path = OUTPUT_DIR / "gbp_posting_schedule.md"
            print(f"\n✅ GBP posting schedule saved to: {schedule_path}")
            # Archive used photos and update manifest
            photo_path = os.getenv(
                "GBP_PHOTO_PATH",
                r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos"
            )
            archived = archive_used_photos(schedule_path, Path(photo_path))
            if archived:
                print(f"📁 Archived {len(archived)} photo(s) to Archive folder and updated manifest:")
                for f in archived:
                    print(f"   - {f}")
            else:
                print("ℹ️  No photos to archive (NEEDS PHOTO entries or no matches in manifest).")
            write_run_health("post_schedule", "success", started_at=t0)
            write_workflow_status(
                phase="post_schedule",
                phase_status="complete",
                args={"start_date": start_date, "days": getattr(args, "days", 7)},
                extra={"archived_photos": archived},
            )
            _run_supabase_sync(week_of=start_date)
        except Exception as e:
            write_run_health("post_schedule", "failed", error=str(e), started_at=t0)
            write_workflow_status(
                phase="post_schedule",
                phase_status="failed",
                args={"start_date": start_date, "days": getattr(args, "days", 7)},
                error=str(e),
            )
            print(f"\n❌ GBP Poster crew failed: {e}")
            sys.exit(1)

    elif command == "status":
        status = write_workflow_status(phase="status", phase_status="complete")
        if args.json:
            print(json.dumps(status, indent=2))
        else:
            print(format_status_text(status))

    elif command == "validate":
        status = build_workflow_status(phase="validate", phase_status="complete")
        issues = validate_workflow_outputs(status)
        if args.json:
            print(json.dumps({"ok": not issues, "issues": issues, "status": status}, indent=2))
        else:
            print(format_validation_text(issues))
        if issues:
            sys.exit(1)

    elif command == "actions":
        queue = write_action_queue()
        if args.json:
            print(json.dumps(queue, indent=2))
        else:
            print(format_action_queue_text(queue))

    elif command == "approve-action":
        queue = approve_action(args.action_id, approved_by=args.by, note=args.note)
        action = next(item for item in queue["actions"] if item["id"] == args.action_id)
        print(f"Approved {action['id']}: {action['title']}")

    elif command == "run-action":
        result = run_action(args.action_id, live=args.live)
        print(json.dumps(result, indent=2))

    elif command == "sync-gbp-schedule":
        result = sync_gbp_schedule_to_workbook(dry_run=args.dry_run)
        print(json.dumps(result, indent=2))

    elif command == "mark-gbp-approved":
        result = mark_gbp_dates_approved(args.dates)
        print(json.dumps(result, indent=2))

    elif command == "adapter-status":
        result = {
            "wordpress_browser": wordpress_adapter_status(),
            "google_business_profile": gbp_adapter_status(),
        }
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            for name, status in result.items():
                print(f"{name}: {status['state']}")
                for missing in status.get("missing", []):
                    print(f"  - missing: {missing}")

    elif command == "compact-baselines":
        result = compact_baselines(dry_run=getattr(args, "dry_run", False))
        if getattr(args, "json", False):
            print(json.dumps(result, indent=2))
        elif result["status"] == "nothing_to_compact":
            print("Nothing to compact — baselines folder is already empty.")
        elif result["status"] == "dry_run":
            print(f"Dry run — would archive {len(result['source_files'])} files ({result['source_chars']:,} chars):")
            for f in result["source_files"]:
                print(f"  - {f}")
            print(f"\nPreview of merged output:\n\n{result['preview']}")
        else:
            print(f"\n✅ Baselines compacted:")
            print(f"   Archived {len(result['archived_files'])} files → {result['archived_to']}")
            print(f"   New summary: {result['output']} ({result['output_chars']:,} chars, {result['reduction_pct']}% smaller)")

    elif command == "blog-post":
        status_val = "publish" if args.publish else "draft"
        dry_run = getattr(args, "dry_run", False)
        if dry_run:
            # Generate content only, skip WP push
            kw_line = f"\nTarget keywords: {args.keywords}" if args.keywords else ""
            prompt = (
                "You are a content writer for Grizzly Electrical Solutions (DFW electrician). "
                f"Write a blog post on: {args.topic}{kw_line}\n"
                "400-700 words, H2 subheadings, honest contractor tone. "
                "First line: TITLE: ...\nSecond line: EXCERPT: ...\nThird line: TAGS: ...\n"
                "Then blank line then HTML body only."
            )
            print(f"  Dry run — generating content only (no WordPress push)...")
            raw = _call_local_llm(prompt, max_tokens=2000)
            print(raw)
        else:
            result = generate_blog_post(args.topic, keywords=args.keywords, status=status_val)
            wp = result.get("wp_result", {})
            if wp.get("post_id"):
                print(f"\n✅ Blog post created:")
                print(f"   Title    : {result['title']}")
                print(f"   Post ID  : {wp['post_id']}")
                print(f"   Status   : {wp['post_status']}")
                print(f"   Preview  : {wp['link']}")
            else:
                print(f"\n⚠ Blog post generated but WP push failed:")
                print(json.dumps(result, indent=2))
                sys.exit(1)

    elif command == "facebook-schedule":
        start_date = getattr(args, "start_date", "") or date.today().isoformat()
        crew = build_facebook_crew(
            start_date=start_date,
            days=getattr(args, "days", 7),
        )
        print(f"\n🔵 Running Facebook Schedule crew for {getattr(args, 'days', 7)} days starting {start_date}...")
        try:
            result = crew.kickoff()
            print(f"\n✅ Facebook schedule written to: outputs/facebook_posting_schedule.md")
            print("  Run `seo-agents actions` to see the new Facebook post actions in the queue.")
            _run_supabase_sync(week_of=start_date)
        except Exception as e:
            print(f"\n❌ Facebook Schedule crew failed: {e}")
            sys.exit(1)

    else:
        print("Usage:")
        print("  seo-agents research <topic>      — run research phase")
        print("  seo-agents execute               — run execution phase (after owner review)")
        print("  seo-agents post-schedule         — generate 7-day GBP posting schedule")
        print("  seo-agents facebook-schedule     — generate 7-day Facebook posting schedule (hooks + videos)")
        print("  seo-agents status                — show workflow status")
        print("  seo-agents validate              — validate generated outputs")
        print("  seo-agents actions               — show executable action queue")
        print("  seo-agents run-action <id>       — dry-run one action")
        print("  seo-agents adapter-status        — show live adapter readiness")
        print("  seo-agents sync-gbp-schedule     — sync GBP schedule to poster workbook")
        print("  seo-agents compact-baselines     — merge baselines into one file, archive old ones")
        print("  seo-agents blog-post <topic>     — generate blog post with Qwen, push to WordPress as draft")
        print("  seo-agents --help                — full help")
        sys.exit(1)


if __name__ == "__main__":
    main()
