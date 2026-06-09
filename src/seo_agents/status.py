from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from seo_agents.actions import build_action_queue
from seo_agents.crew import OUTPUT_DIR


STATUS_FILE = OUTPUT_DIR / "workflow_status.json"
CLIENT = {
    "id": "grizzly",
    "name": "Grizzly Electrical Solutions",
}
WORKFLOW_ID = "grizzly-seo"

RESEARCH_REPORTS = {
    "content": ("content_report.md", "CONTENT"),
    "website": ("website_report.md", "WEBSITE"),
    "gbp": ("gbp_report.md", "GBP"),
    "reputation": ("reputation_report.md", "REPUTATION"),
}

REPORTS = {
    **RESEARCH_REPORTS,
    "manager_plan": ("grizzly_local_presence_plan.md", None),
    "execution_queue": ("grizzly_execution_queue.md", None),
    "content_completion": ("content_completion.md", None),
    "assets_completion": ("assets_completion.md", None),
    "technical_completion": ("technical_completion.md", None),
    "delegation_verification": ("delegation_verification.md", None),
    "final_report": ("final_report.md", None),
    "gbp_posting_schedule": ("gbp_posting_schedule.md", None),
}


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def _markdown_body(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", stripped)
        stripped = re.sub(r"\s*```\s*$", "", stripped)
    return stripped.strip()


def _file_timestamp(path: Path) -> str | None:
    if not path.exists():
        return None
    return datetime.fromtimestamp(path.stat().st_mtime, UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _report_info(name: str, marker: str | None) -> dict[str, Any]:
    path = OUTPUT_DIR / name
    text = _read_text(path)
    info: dict[str, Any] = {
        "file": name,
        "present": path.exists(),
        "bytes": path.stat().st_size if path.exists() else 0,
        "updated_at": _file_timestamp(path),
    }
    if marker:
        info["marker"] = marker
        info["marker_valid"] = f"[START:{marker}]" in text and f"[END:{marker}]" in text
    return info


def _extract_int(text: str, label: str) -> int | None:
    match = re.search(rf"(?:\*\*)?{re.escape(label)}(?:\*\*)?\s*:\s*(\d+)", text, re.IGNORECASE)
    return int(match.group(1)) if match else None


def _extract_task_blocks(text: str) -> list[dict[str, str]]:
    body = _markdown_body(text)
    parts = re.split(r"(?=^### Task ID:\s*)", body, flags=re.MULTILINE)
    tasks: list[dict[str, str]] = []
    for part in parts:
        task_id = re.search(r"^### Task ID:\s*([A-Z]+-?\d+)", part, flags=re.MULTILINE)
        if not task_id:
            continue
        task = {"id": task_id.group(1)}
        for label, key in (
            ("Task Title", "title"),
            ("Assigned Executor", "executor"),
            ("Verification Result", "status"),
            ("Definition of Done Met", "definition_of_done"),
            ("What was missing", "missing"),
            ("Recommended Next Step", "next_step"),
            ("Notes", "notes"),
        ):
            match = re.search(rf"- \*\*{re.escape(label)}\*\*:\s*(.+)", part)
            if match:
                task[key] = match.group(1).strip()
        tasks.append(task)
    if tasks:
        return tasks
    table_rows = re.findall(
        r"^\|\s*([A-Z]+-?\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$",
        body,
        flags=re.MULTILINE,
    )
    for task_id, title, maybe_executor, result in table_rows:
        if task_id == "Task ID":
            continue
        separator_values = {task_id.strip("- "), title.strip("- "), maybe_executor.strip("- "), result.strip("- ")}
        if not any(separator_values):
            continue
        status = result.strip()
        task: dict[str, str] = {
            "id": task_id.strip(),
            "title": title.strip(),
            "status": status,
            "definition_of_done": "YES" if status.upper() in {"VERIFIED", "COMPLETE"} else "PARTIAL" if status.upper() == "PARTIAL" else "NO",
        }
        if maybe_executor.strip() and maybe_executor.strip().upper() not in {"VERIFICATION RESULT", "WHAT WAS MISSING"}:
            task["executor"] = maybe_executor.strip()
        detail = re.search(
            rf"^### Task {re.escape(task['id'])}:\s*.*?\n(.*?)(?=^### Task [A-Z]+-?\d+:|\Z)",
            body,
            flags=re.MULTILINE | re.DOTALL,
        )
        if detail:
            reason = re.search(r"^- \*\*Reason\*\*:\s*(.+)", detail.group(1), flags=re.MULTILINE)
            if reason:
                task["notes"] = reason.group(1).strip()
        tasks.append(task)
    return tasks


def _extract_queue_tasks(text: str) -> list[dict[str, str]]:
    body = _markdown_body(text)
    parts = re.split(r"(?=^## Task \d+:)", body, flags=re.MULTILINE)
    tasks: list[dict[str, str]] = []
    for part in parts:
        task_id = re.search(r"\*\*Task ID\*\*:\s*([A-Z]+-\d+)", part)
        if not task_id:
            continue
        task = {"id": task_id.group(1)}
        for label, key in (
            ("Task Title", "title"),
            ("Assigned Execution Agent", "executor"),
            ("Priority", "priority"),
            ("Due Window", "due_window"),
        ):
            match = re.search(rf"\*\*{re.escape(label)}\*\*:\s*(.+)", part)
            if match:
                task[key] = match.group(1).strip()
        tasks.append(task)
    return tasks


def _extract_owner_signoffs(text: str) -> list[str]:
    body = _markdown_body(text)
    section = re.search(r"^## Owner Sign-Off Needed\s*(.*?)(?=^#{1,6}\s+|\Z)", body, flags=re.MULTILINE | re.DOTALL)
    if not section:
        return []
    return [
        line[2:].strip()
        for line in section.group(1).splitlines()
        if line.strip().startswith("- ")
    ]


def _overlay_action_completion_status(
    tasks: list[dict[str, str]],
    action_queue: dict[str, Any],
) -> list[dict[str, str]]:
    actions_by_task = {
        action.get("source_task_id"): action
        for action in action_queue.get("actions", [])
        if action.get("source_task_id")
    }
    updated: list[dict[str, str]] = []
    for task in tasks:
        action = actions_by_task.get(task.get("id"))
        completion = action.get("completion", {}) if action else {}
        if not completion:
            updated.append(task)
            continue
        task = {**task}
        completion_status = completion.get("completion_status", "").upper()
        definition = completion.get("definition_of_done", "").upper()
        if completion_status == "COMPLETE" and definition == "YES":
            task["status"] = "COMPLETE"
            task["definition_of_done"] = "YES"
            task["notes"] = completion.get("action_taken", task.get("notes", ""))
        elif completion_status:
            task["status"] = completion_status
            task["definition_of_done"] = completion.get("definition_of_done", task.get("definition_of_done", ""))
            task["notes"] = completion.get("blocker") or completion.get("action_taken", task.get("notes", ""))
        updated.append(task)
    return updated


def _task_counts(tasks: list[dict[str, str]]) -> dict[str, int]:
    verified = 0
    partial = 0
    incomplete = 0
    for task in tasks:
        status = task.get("status", "").upper()
        definition = task.get("definition_of_done", "").upper()
        if status in {"COMPLETE", "VERIFIED"} and definition == "YES":
            verified += 1
        elif status == "PARTIAL" or definition == "PARTIAL":
            partial += 1
        elif status:
            incomplete += 1
    return {
        "total": len(tasks),
        "verified": verified,
        "partial": partial,
        "incomplete": incomplete,
    }


def _phase_statuses(reports: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    def valid_report(name: str) -> bool:
        report = reports[name]
        return report["present"] and report["bytes"] > 0 and report.get("marker_valid", True)

    research_ok = all(
        valid_report(name)
        for name in RESEARCH_REPORTS
    )
    plan_ok = valid_report("manager_plan") and valid_report("execution_queue")
    execution_started = any(
        reports[name]["present"] and reports[name]["bytes"] > 0
        for name in ("content_completion", "assets_completion", "technical_completion", "delegation_verification", "final_report")
    )
    execution_done = valid_report("delegation_verification") and valid_report("final_report")
    return {
        "research": {
            "status": "complete" if research_ok and plan_ok else "pending",
            "reports": [*RESEARCH_REPORTS, "manager_plan", "execution_queue"],
        },
        "execute": {
            "status": "complete" if execution_done else "running" if execution_started else "pending",
            "reports": ["content_completion", "assets_completion", "technical_completion", "delegation_verification", "final_report"],
        },
        "post_schedule": {
            "status": "complete" if valid_report("gbp_posting_schedule") else "pending",
            "reports": ["gbp_posting_schedule"],
        },
    }


def build_workflow_status(
    phase: str = "status",
    phase_status: str = "complete",
    args: dict[str, Any] | None = None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reports = {
        key: _report_info(filename, marker)
        for key, (filename, marker) in REPORTS.items()
    }
    final_text = _read_text(OUTPUT_DIR / "final_report.md")
    verification_text = _read_text(OUTPUT_DIR / "delegation_verification.md")
    queue_text = _read_text(OUTPUT_DIR / "grizzly_execution_queue.md")
    verification_source = verification_text or final_text
    tasks = _extract_task_blocks(verification_source)
    queued_tasks = _extract_queue_tasks(queue_text)
    owner_signoffs = _extract_owner_signoffs(final_text)
    action_queue = build_action_queue()
    tasks = _overlay_action_completion_status(tasks, action_queue)
    counts = _task_counts(tasks)

    summary = {
        "total_tasks_checked": counts["total"] or _extract_int(verification_source, "Total Tasks Checked"),
        "count_verified": counts["verified"],
        "count_partial": counts["partial"],
        "count_incomplete": counts["incomplete"],
        "tasks": tasks,
        "queued_tasks": queued_tasks,
        "owner_signoffs_needed": owner_signoffs,
        "action_queue": action_queue["summary"],
    }
    phases = _phase_statuses(reports)
    if phase in phases:
        phases[phase]["status"] = "failed" if error else phase_status

    if error:
        status = "failed"
        next_action = f"Review {phase} failure and logs."
    elif owner_signoffs:
        status = "needs_owner_review"
        next_action = "Review final_report.md owner sign-off items."
    elif phases["execute"]["status"] == "complete":
        status = "complete"
        next_action = "Review completed execution report."
    elif phases["research"]["status"] == "complete":
        status = "ready_to_execute"
        next_action = "Review plan and run seo-agents execute when approved."
    else:
        status = "pending"
        next_action = "Run seo-agents research <topic>."

    payload: dict[str, Any] = {
        "version": "1.0.0",
        "generated_at": _now_iso(),
        "client": CLIENT,
        "workflow_id": WORKFLOW_ID,
        "phase": phase,
        "status": status,
        "phase_status": phase_status,
        "reports": reports,
        "workflow": phases,
        "summary": summary,
        "actions": action_queue,
        "next_action": next_action,
    }
    if args:
        payload["args"] = args
    if error:
        payload["error"] = error
    if extra:
        payload["extra"] = extra
    return payload


def write_workflow_status(
    phase: str = "status",
    phase_status: str = "complete",
    args: dict[str, Any] | None = None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    OUTPUT_DIR.mkdir(exist_ok=True)
    payload = build_workflow_status(phase=phase, phase_status=phase_status, args=args, error=error, extra=extra)
    temp_path = STATUS_FILE.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(STATUS_FILE)
    return payload


def validate_workflow_outputs(status: dict[str, Any] | None = None) -> list[str]:
    payload = status or build_workflow_status()
    issues: list[str] = []
    reports = payload["reports"]
    required_reports = [*RESEARCH_REPORTS, "manager_plan", "execution_queue"]
    for name in required_reports:
        report = reports[name]
        if not report["present"]:
            issues.append(f"Missing required report: {report['file']}")
            continue
        if report["bytes"] <= 0:
            issues.append(f"Empty required report: {report['file']}")
        if report.get("marker") and not report.get("marker_valid"):
            issues.append(f"Missing report markers in {report['file']}: [START:{report['marker']}] / [END:{report['marker']}]")

    for name in ("delegation_verification", "final_report"):
        report = reports[name]
        if report["present"] and report["bytes"] <= 0:
            issues.append(f"Empty execution report: {report['file']}")

    summary = payload["summary"]
    if reports["delegation_verification"]["present"] and summary.get("total_tasks_checked") is None:
        issues.append("Could not parse Total Tasks Checked from delegation_verification.md")
    return issues


def format_validation_text(issues: list[str]) -> str:
    if not issues:
        return "Workflow output validation passed."
    lines = ["Workflow output validation failed:"]
    lines.extend(f"  - {issue}" for issue in issues)
    return "\n".join(lines)


def format_status_text(status: dict[str, Any]) -> str:
    summary = status["summary"]
    lines = [
        f"Workflow: {status['workflow_id']} ({status['client']['name']})",
        f"Status: {status['status']}",
        f"Phase: {status['phase']} / {status['phase_status']}",
        f"Next action: {status['next_action']}",
        "",
        "Reports:",
    ]
    for name, report in status["reports"].items():
        marker = report.get("marker")
        marker_state = ""
        if marker:
            marker_state = " marker=ok" if report.get("marker_valid") else " marker=missing"
        state = "present" if report["present"] else "missing"
        lines.append(f"  - {name}: {state}{marker_state}")
    lines.extend([
        "",
        "Task summary:",
        f"  - checked: {summary.get('total_tasks_checked') or 0}",
        f"  - verified: {summary.get('count_verified') or 0}",
        f"  - partial: {summary.get('count_partial') or 0}",
        f"  - incomplete: {summary.get('count_incomplete') or 0}",
        f"  - owner sign-offs: {len(summary.get('owner_signoffs_needed') or [])}",
        f"  - actions needing approval: {summary.get('action_queue', {}).get('needs_approval', 0)}",
        f"  - actions blocked on access: {summary.get('action_queue', {}).get('blocked_access', 0)}",
    ])
    return "\n".join(lines)
