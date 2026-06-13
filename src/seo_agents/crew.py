from __future__ import annotations

import csv
import os
import shutil
from datetime import date, datetime
from pathlib import Path

from crewai import Agent, Crew, LLM, Process, Task
from crewai_tools import ScrapeWebsiteTool, SerpApiGoogleSearchTool
from dotenv import load_dotenv
from pydantic import BaseModel, Field


class TaskCompletion(BaseModel):
    """One completed (or blocked) execution-queue task. Field names match what
    actions.py expects in its completion dicts — do not rename casually."""

    task_id: str = Field(description="Task ID from the execution queue, e.g. T001")
    title: str = ""
    agent: str = ""
    completion_status: str = Field(default="", description="COMPLETE, PARTIAL, or BLOCKED")
    action_taken: str = ""
    deliverable_location: str = Field(default="", description="File path or place the deliverable lives")
    deliverable: str = Field(default="", description="The full deliverable text itself, when it is a text artifact")
    definition_of_done: str = Field(default="", description="YES, NO, or PARTIAL")
    blocker: str = Field(default="", description="If partial or blocked, what is blocking")
    owner_signoff_needed: str = Field(default="", description="YES or NO")


class CompletionReport(BaseModel):
    completions: list[TaskCompletion]


def structured_completions_enabled() -> bool:
    return os.getenv("CREWAI_STRUCTURED_COMPLETIONS", "true").lower() in {"1", "true", "yes", "on"}


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROMPT_DIR = PROJECT_ROOT / "prompts" / "agents"
BASELINE_DIR = PROJECT_ROOT / "knowledge" / "baselines"
OUTPUT_DIR = PROJECT_ROOT / "outputs"
ARCHIVE_DIR = OUTPUT_DIR / "archive"

DEFAULT_SITE_URL = "https://www.grizzlyelectricaltx.com/"
DEFAULT_REGION = "DFW, Texas"
DEFAULT_AUDIENCE = "DFW homeowners and light commercial customers"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def read_prompt(name: str) -> str:
    return read_text(PROMPT_DIR / name)


def read_baselines() -> str:
    sections = []
    for path in sorted(BASELINE_DIR.glob("*.md")):
        sections.append(f"## {path.name}\n\n{read_text(path)}")
    return "\n\n---\n\n".join(sections)


def read_latest_baseline(stem_prefix: str) -> str:
    """Return content of the most recently modified baseline file matching stem_prefix*.md.

    Using the newest file by mtime means adding an updated baseline (e.g.
    wordpress-contact-form-access-2026-07-01.md) automatically supersedes the
    old one — no code change required.
    """
    matches = sorted(
        BASELINE_DIR.glob(f"{stem_prefix}*.md"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        return f"[BASELINE NOT FOUND: no file matching {stem_prefix}*.md in {BASELINE_DIR}]"
    return read_text(matches[0])


def read_output(name: str) -> str:
    path = OUTPUT_DIR / name
    if path.exists():
        return read_text(path)
    return f"[FILE NOT FOUND: {name}]"


def out(name: str) -> str:
    """Return an absolute output path string for CrewAI task output_file."""
    return str(OUTPUT_DIR / name)


def is_verbose() -> bool:
    return os.getenv("CREWAI_VERBOSE", "false").lower() in {"1", "true", "yes", "on"}


def _serper_key_valid() -> bool:
    key = os.getenv("SERPAPI_API_KEY", "").strip()
    return bool(key) and key not in {"your-serper-key", "your_serper_key", "SERPER_KEY", "your-serpapi-key"}


def build_tools() -> list:
    tools = [ScrapeWebsiteTool()]
    if _serper_key_valid():
        try:
            tools.insert(0, SerpApiGoogleSearchTool())
        except Exception:
            pass  # serpapi package version incompatible — scraping only
    return tools


def agent_backstory(prompt_file: str) -> str:
    return (
        f"{read_prompt(prompt_file)}\n\n"
        "Use the baseline knowledge supplied in each task. Do not invent missing facts. "
        "Separate confirmed evidence, recommendations, drafts, and owner approval items."
    )


# ---------------------------------------------------------------------------
# LLM builders
# ---------------------------------------------------------------------------

def _llm_kwargs(tier: str) -> dict:
    """Optional per-tier routing to a local OpenAI-compatible server.

    Set CREWAI_<TIER>_API_BASE (e.g. http://127.0.0.1:8080/v1) to route that
    tier to local llama-server; the model name still comes from
    CREWAI_<TIER>_MODEL (use the openai/ prefix, e.g. openai/qwen3.6-35b-a3b).
    """
    kwargs: dict = {}
    api_base = os.getenv(f"CREWAI_{tier}_API_BASE")
    if api_base:
        kwargs["base_url"] = api_base
        kwargs["api_key"] = os.getenv(f"CREWAI_{tier}_API_KEY", "local")
    max_tokens = os.getenv(f"CREWAI_{tier}_MAX_TOKENS")
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    return kwargs


def build_research_llm() -> LLM:
    load_dotenv()
    return LLM(
        model=os.getenv("CREWAI_RESEARCH_MODEL", "openai/gpt-4o-mini"),
        temperature=float(os.getenv("CREWAI_TEMPERATURE", "0.2")),
        **_llm_kwargs("RESEARCH"),
    )


def build_exec_llm() -> LLM:
    load_dotenv()
    return LLM(
        model=os.getenv("CREWAI_EXEC_MODEL", "openai/gpt-4o"),
        temperature=float(os.getenv("CREWAI_TEMPERATURE", "0.2")),
        **_llm_kwargs("EXEC"),
    )


# ---------------------------------------------------------------------------
# Research + Plan Crew  (seo-agents <topic>)
# ---------------------------------------------------------------------------

def build_grizzly_crew(
    topic: str,
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
    previous_context: str = "",
    completed_tasks: str = "",
) -> Crew:
    research_llm = build_research_llm()
    exec_llm = build_exec_llm()
    tools = build_tools()
    baselines = read_baselines()
    target_site = site_url or DEFAULT_SITE_URL
    target_audience = audience or DEFAULT_AUDIENCE
    target_region = region or DEFAULT_REGION
    seed_keywords = keywords or "Use the baseline priority services and infer only safe, relevant terms."

    shared_context = (
        f"Current request/focus: {topic}\n"
        f"Target site: {target_site}\n"
        f"Target audience: {target_audience}\n"
        f"Target region: {target_region}\n"
        f"Seed keywords: {seed_keywords}\n\n"
        "Baseline knowledge from imported Grizzly reports:\n\n"
        f"{baselines}"
    )
    if previous_context:
        shared_context += f"\n\n---\n\n{previous_context}"
    if completed_tasks:
        shared_context += f"\n\n---\n\n{completed_tasks}"

    # --- Research agents (gpt-4o-mini) ---
    content_agent = Agent(
        role="Grizzly Content and Keyword Agent",
        goal="Create practical local SEO keyword plans and draft-ready content for Grizzly Electrical Solutions.",
        backstory=agent_backstory("content-keyword-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    website_agent = Agent(
        role="Grizzly Website SEO Agent",
        goal="Audit website SEO, service-page structure, technical issues, and conversion problems.",
        backstory=agent_backstory("website-seo-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    gbp_agent = Agent(
        role="Grizzly GBP and Local Rankings Agent",
        goal="Audit Google Business Profile visibility, surface search trend signals, and identify local ranking opportunities.",
        backstory=agent_backstory("gbp-local-rankings-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    reputation_agent = Agent(
        role="Grizzly Reviews and Reputation Agent",
        goal="Assess review health, surface reputation risks, and draft review response and request copy.",
        backstory=agent_backstory("reviews-reputation-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    # --- Orchestration agents (gpt-4o) ---
    manager_agent = Agent(
        role="Grizzly Local Presence Agent-Manager",
        goal="Validate all specialist reports, synthesize findings into a focused local presence plan, and verify execution completions.",
        backstory=agent_backstory("local-presence-manager-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    scheduling_agent = Agent(
        role="Grizzly Delegation and Scheduling Agent",
        goal="Convert manager recommendations into a practical execution queue with ownership, timing, and verification criteria.",
        backstory=agent_backstory("delegation-scheduling-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    # --- Tasks ---
    content_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Create an updated Content / Keyword Plan for the current focus. Preserve the Grizzly tone, "
            "avoid DIY electrical troubleshooting steps, and include draft-ready content only where useful."
        ),
        expected_output=(
            "A Content / Keyword Plan wrapped in [START:CONTENT]...[END:CONTENT] markers, containing: "
            "keyword opportunities, blog topics, GBP/social drafts, website copy suggestions, "
            "priority ranking, ready-to-publish drafts, and owner approval needs."
        ),
        agent=content_agent,
        output_file=out("content_report.md"),
        markdown=True,
    )

    website_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Review website SEO for the current focus using the baseline report AND live verification via ScrapeWebsiteTool.\n\n"
            "STEP 1 — VERIFY COMPLETED TASKS FIRST (mandatory before any new research):\n"
            "The shared context above includes a 'COMPLETED TASKS FROM PREVIOUS RUNS' section. For each completed task, "
            "scrape the relevant live page and confirm the work is still in place. Report each as:\n"
            "  ✅ CONFIRMED LIVE: [task title] — [what you saw on the page]\n"
            "  ❌ REGRESSION: [task title] — [what is missing or broken now]\n"
            "Do this check for every completed task before writing any new recommendations.\n\n"
            "STEP 2 — LIVE VERIFICATION RULE (mandatory for all issues):\n"
            "For every issue mentioned in the baseline, scrape the relevant live page and confirm the issue still exists "
            "before recommending it. If the page looks fine, the form works, or the issue is gone — mark it RESOLVED "
            "and do not recommend it. Only surface issues that are present right now.\n\n"
            "For conversion issues specifically (contact form, phone visibility, CTAs): scrape the contact page and the "
            "homepage. Report what you actually see, not what the baseline says to expect.\n\n"
            "Do not claim access to Search Console, CMS backend, or rankings data unless proven by tool output."
        ),
        expected_output=(
            "A Website SEO Report wrapped in [START:WEBSITE]...[END:WEBSITE] markers, containing: "
            "homepage notes, service-page findings, technical issues, conversion issues, "
            "recommended actions, draft copy, and owner approval needs."
        ),
        agent=website_agent,
        output_file=out("website_report.md"),
        markdown=True,
    )

    gbp_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Prepare a GBP / Local Rankings Report for the current focus. Use SerperDevTool to pull "
            "this week's trending electrical service queries in DFW. Use the imported baseline and any "
            "available public evidence. Clearly label missing owner-access items."
        ),
        expected_output=(
            "A GBP / Local Rankings Report wrapped in [START:GBP]...[END:GBP] markers, containing: "
            "status summary, search trend signals this week, ranking notes, GBP issues, "
            "competitor notes, recommended GBP post topics, recommended actions, ready-to-publish "
            "GBP drafts, and owner approval needs."
        ),
        agent=gbp_agent,
        output_file=out("gbp_report.md"),
        markdown=True,
    )

    reputation_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Prepare a Reviews / Reputation Report for the current focus using the imported baseline and any "
            "provided evidence. Do not invent reviews, ratings, customers, or platform data. "
            "If no new data is available, use the baseline and label it clearly — never produce an empty report."
        ),
        expected_output=(
            "A Reviews / Reputation Report wrapped in [START:REPUTATION]...[END:REPUTATION] markers, containing: "
            "review summary, needed responses, review request opportunities, reputation risks, "
            "recommended actions, ready-to-publish drafts, and owner approval needs."
        ),
        agent=reputation_agent,
        output_file=out("reputation_report.md"),
        markdown=True,
    )

    manager_task = Task(
        description=(
            "First, perform a strict audit of all four input reports. "
            "Verify each report is present, non-empty, and wrapped in its required markers: "
            "[START:CONTENT]...[END:CONTENT], [START:WEBSITE]...[END:WEBSITE], "
            "[START:GBP]...[END:GBP], [START:REPUTATION]...[END:REPUTATION].\n\n"
            "If any report is missing, empty, or missing markers, explicitly list it as "
            "'CRITICAL FAILURE: MISSING' in your Executive Summary and flag it for the owner.\n\n"
            "Then synthesize all available reports into one implementation-ready Local Presence Manager Plan. "
            "Prioritize residential lead-generating services first: troubleshooting, recessed lighting, "
            "panel replacement, service upgrades, EV chargers, generator work, and remodel electrical. "
            "Keep recommendations practical, evidence-based, and separated from draft copy.\n\n"
            "Include a Phase 5 Verification Checklist pre-populated from the highest-priority tasks."
        ),
        expected_output=(
            "A markdown Local Presence Manager Plan with: executive summary (including any critical failures), "
            "highest-priority actions, delegated agent follow-ups, draft assets ready for owner review, "
            "missing evidence checklist, owner approvals needed, and Phase 5 verification checklist."
        ),
        agent=manager_agent,
        context=[content_task, website_task, gbp_task, reputation_task],
        output_file=out("grizzly_local_presence_plan.md"),
        markdown=True,
    )

    scheduling_task = Task(
        description=(
            "Transform the Local Presence Manager Plan into a simple execution queue for implementation. "
            "For each task, assign one execution owner, priority, due window, exact implementation steps, "
            "dependencies, and a verifiable definition of done. Delegate only to these execution-agent territories: "
            "Local Content Production Executor, Local Presence Assets Executor, Technical SEO and CRO Executor. "
            "Use Owner/Admin only where approval, access, or business decisions are required."
        ),
        expected_output=(
            "A markdown execution queue containing discrete task blocks with: task ID, title, "
            "assigned execution agent, priority (P1/P2/P3), due window, exact action steps, "
            "dependencies, definition of done, and verification checklist."
        ),
        agent=scheduling_agent,
        context=[manager_task],
        output_file=out("grizzly_execution_queue.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Local Presence Crew",
        agents=[content_agent, website_agent, gbp_agent, reputation_agent, manager_agent, scheduling_agent],
        tasks=[content_task, website_task, gbp_task, reputation_task, manager_task, scheduling_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


# ---------------------------------------------------------------------------
# Executor Crew  (seo-agents execute)
# ---------------------------------------------------------------------------

def build_executor_crew() -> Crew:
    """
    Reads the execution queue cold — no shared context from the research phase.
    Fans tasks to the 3 executors by territory, then runs the manager + delegation
    verification loop against the completion reports.
    """
    exec_llm = build_exec_llm()
    tools = build_tools()

    execution_queue = read_output("grizzly_execution_queue.md")
    manager_plan = read_output("grizzly_local_presence_plan.md")
    wordpress_handoff = read_latest_baseline("wordpress-contact-form-access")
    contact_form_story = read_latest_baseline("contact-form-repair-success-story")
    wordpress_config_path = PROJECT_ROOT / "config" / "wordpress-sites" / "grizzly.json"
    wordpress_config = read_text(wordpress_config_path) if wordpress_config_path.exists() else "{}"

    queue_context = (
        "You are reading the execution queue plus current system handoff evidence. "
        "Use the queue for task scope, and use the handoff evidence to avoid stale blockers. "
        "If a task was previously blocked but current handoff evidence proves access or repair, reflect the current state.\n\n"
        f"EXECUTION QUEUE:\n\n{execution_queue}\n\n"
        "CURRENT WORDPRESS SITE CONFIG (no credentials):\n\n"
        f"```json\n{wordpress_config}\n```\n\n"
        "CURRENT WORDPRESS CONTACT FORM HANDOFF:\n\n"
        f"{wordpress_handoff}\n\n"
        "CONTACT FORM REPAIR SUCCESS STORY:\n\n"
        f"{contact_form_story}"
    )

    # --- Executor agents ---
    content_executor = Agent(
        role="Local Content Production Executor",
        goal="Execute content tasks from the execution queue and produce complete draft deliverables with a completion report.",
        backstory=agent_backstory("content-production-executor.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    assets_executor = Agent(
        role="Local Presence Assets Executor",
        goal="Execute GBP and local presence tasks from the execution queue and produce draft assets with a completion report.",
        backstory=agent_backstory("local-presence-assets-executor.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    technical_executor = Agent(
        role="Technical SEO and CRO Executor",
        goal="Execute technical SEO and conversion tasks from the execution queue and produce structured recommendations with a completion report.",
        backstory=agent_backstory("technical-seo-cro-executor.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    # --- Verification agents (same agents, new tasks) ---
    manager_verifier = Agent(
        role="Grizzly Local Presence Agent-Manager",
        goal="Verify all executor completion reports against the original plan and execution queue. Produce the final verified report.",
        backstory=agent_backstory("local-presence-manager-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    scheduling_verifier = Agent(
        role="Grizzly Delegation and Scheduling Agent",
        goal="Cross-check the execution queue against completion reports and confirm every task's definition of done was met.",
        backstory=agent_backstory("delegation-scheduling-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    # --- Execution tasks ---
    structured = structured_completions_enabled()

    def exec_task(agent: Agent, executor_role: str, scope_label: str, stem: str) -> Task:
        if structured:
            # Structured JSON: actions.py parses this directly instead of
            # regex-scraping markdown, so format drift can't drop tasks.
            return Task(
                description=(
                    f"{queue_context}\n\n"
                    f"Execute all tasks in the queue assigned to: {executor_role}.\n"
                    "For each task: read it, gather evidence using your tools, produce the deliverable, "
                    "and record a completion entry. If a task is blocked, document the blocker clearly. "
                    "Put the full text of any text deliverable in the entry's 'deliverable' field."
                ),
                expected_output=(
                    f"A JSON completion report covering every {scope_label} task in the queue: "
                    "a 'completions' list with one entry per task containing task_id, title, agent, "
                    "completion_status (COMPLETE/PARTIAL/BLOCKED), action_taken, deliverable_location, "
                    "deliverable, definition_of_done (YES/NO/PARTIAL), blocker, owner_signoff_needed (YES/NO)."
                ),
                agent=agent,
                output_json=CompletionReport,
                output_file=out(f"{stem}.json"),
            )
        return Task(
            description=(
                f"{queue_context}\n\n"
                f"Execute all tasks in the queue assigned to: {executor_role}.\n"
                "For each task: read it, gather evidence using your tools, produce the deliverable, "
                "and append a COMPLETION REPORT block. If a task is blocked, document the blocker clearly."
            ),
            expected_output=(
                f"All {scope_label} tasks completed with deliverables and structured COMPLETION REPORT blocks. "
                "Each block includes: Task ID, status (COMPLETE/PARTIAL/BLOCKED), action taken, "
                "definition of done met (YES/NO/PARTIAL), and owner sign-off needed."
            ),
            agent=agent,
            output_file=out(f"{stem}.md"),
            markdown=True,
        )

    content_exec_task = exec_task(content_executor, "Local Content Production Executor", "content", "content_completion")
    assets_exec_task = exec_task(assets_executor, "Local Presence Assets Executor", "GBP/assets", "assets_completion")
    technical_exec_task = exec_task(technical_executor, "Technical SEO and CRO Executor", "technical SEO", "technical_completion")

    # --- Verification tasks ---
    delegation_verify_task = Task(
        description=(
            "Cross-check the original execution queue against all three completion reports.\n\n"
            f"ORIGINAL EXECUTION QUEUE:\n\n{execution_queue}\n\n"
            "COMPLETION REPORTS: See context from the three executor tasks above.\n\n"
            "For every task in the queue:\n"
            "1. Find its completion entry\n"
            "2. Confirm the definition of done was met\n"
            "3. Flag INCOMPLETE if no completion entry exists\n"
            "4. Flag PARTIAL if the definition of done was only partly met\n"
            "Produce a verification summary table."
        ),
        expected_output=(
            "A verification summary with: total tasks checked, count verified/partial/incomplete, "
            "and a table listing each task ID, title, assigned executor, and verification result."
        ),
        agent=scheduling_verifier,
        context=[content_exec_task, assets_exec_task, technical_exec_task],
        output_file=out("delegation_verification.md"),
        markdown=True,
    )

    manager_final_task = Task(
        description=(
            "Produce the final verified report for this execution cycle.\n\n"
            f"ORIGINAL MANAGER PLAN:\n\n{manager_plan}\n\n"
            f"ORIGINAL EXECUTION QUEUE:\n\n{execution_queue}\n\n"
            "COMPLETION REPORTS AND VERIFICATION: See context from all previous tasks.\n\n"
            "Synthesize everything into the Final Verified Report. "
            "Include: verification summary, verified completions, incomplete/partial tasks, "
            "recommended next steps, and owner sign-off items. "
            "Save a timestamped copy to the archive directory."
        ),
        expected_output=(
            "A Final Verified Report in the standard format: verification summary, "
            "verified completions table, incomplete/partial tasks with next steps, "
            "and owner sign-off items. File saved to outputs/final_report.md."
        ),
        agent=manager_verifier,
        context=[content_exec_task, assets_exec_task, technical_exec_task, delegation_verify_task],
        output_file=out("final_report.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Executor Crew",
        agents=[content_executor, assets_executor, technical_executor, scheduling_verifier, manager_verifier],
        tasks=[content_exec_task, assets_exec_task, technical_exec_task, delegation_verify_task, manager_final_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


def _read_manifest(manifest_path: Path) -> tuple[list[str], list[dict]]:
    """
    Read the photo manifest CSV.
    Returns (fieldnames, rows).
    """
    if not manifest_path.exists():
        return ["Topic", "Source", "Target", "Status", "UsedDate"], []
    with manifest_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or ["Topic", "Source", "Target", "Status"])
        rows = list(reader)
    if "UsedDate" not in fieldnames:
        fieldnames.append("UsedDate")
    return fieldnames, rows


def _available_photos(photo_dir: Path, manifest_path: Path) -> list[str]:
    """
    Return filenames in photo_dir that are NOT yet marked used/archived in the manifest.
    Falls back to full directory scan if manifest is absent.
    """
    used_names: set[str] = set()
    if manifest_path.exists():
        _, rows = _read_manifest(manifest_path)
        for row in rows:
            status = row.get("Status", "").strip().lower()
            if status in {"used", "archived", "posted"}:
                target = Path(row.get("Target", ""))
                used_names.add(target.name)

    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG", ".WEBP"}
    available = [
        p.name for p in sorted(photo_dir.iterdir())
        if p.suffix in image_exts and p.name not in used_names
    ]
    return available


def archive_used_photos(schedule_path: Path, photo_dir: Path) -> list[str]:
    """
    After the poster crew runs:
    1. Parse the schedule for PHOTO_FILE entries
    2. Mark those photos as 'used' in the manifest with today's date
    3. Move the files to Archive/YYYY-MM/ to free local space
    Returns list of archived filenames.
    """
    if not schedule_path.exists():
        return []

    schedule_text = schedule_path.read_text(encoding="utf-8", errors="replace")

    # Extract PHOTO_FILE entries from schedule — handle plain and markdown bold formats
    used_photos: set[str] = set()
    lines = schedule_text.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        # Handle both "PHOTO_FILE: name" and "**PHOTO_FILE:** name" formats
        if "PHOTO_FILE" in stripped and "NEEDS PHOTO" not in stripped.upper():
            # Strip markdown bold markers
            cleaned = stripped.replace("**", "").strip()
            if cleaned.startswith("PHOTO_FILE:"):
                filename = cleaned.replace("PHOTO_FILE:", "").strip()
                # If filename is empty, the value may be on the next line
                if not filename and i + 1 < len(lines):
                    filename = lines[i + 1].strip().replace("**", "").strip()
                # Strip trailing markdown (e.g. trailing spaces/backslash)
                filename = filename.rstrip("\\ ")
                if filename and not filename.upper().startswith("NEEDS PHOTO"):
                    used_photos.add(filename)

    if not used_photos:
        return []

    manifest_path = photo_dir / "gbp-photo-manifest.csv"
    fieldnames, rows = _read_manifest(manifest_path)

    # Archive destination
    month_str = datetime.today().strftime("%Y-%m")
    archive_dir = photo_dir / "Archive" / month_str
    archive_dir.mkdir(parents=True, exist_ok=True)

    today = date.today().isoformat()
    archived: list[str] = []

    # Track which used_photos were matched to a manifest row
    matched: set[str] = set()

    for row in rows:
        target_path = Path(row.get("Target", ""))
        filename = target_path.name
        if filename in used_photos:
            row["Status"] = "used"
            row["UsedDate"] = today
            src = photo_dir / filename
            dst = archive_dir / filename
            if src.exists():
                shutil.move(str(src), str(dst))
                archived.append(filename)
            matched.add(filename)

    # Handle untracked photos (exist in directory, used in schedule, not in manifest)
    for filename in used_photos - matched:
        src = photo_dir / filename
        if src.exists():
            dst = archive_dir / filename
            shutil.move(str(src), str(dst))
            archived.append(filename)
            # Add a new manifest entry for traceability
            rows.append({
                "Topic": filename,
                "Source": str(photo_dir / filename),
                "Target": str(photo_dir / filename),
                "Status": "used",
                "UsedDate": today,
            })

    # Write manifest back
    with manifest_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    return archived


def build_poster_crew(
    start_date: str = "",
    days: int = 7,
) -> Crew:
    """
    Separate daily crew. Reads content + GBP reports, pulls live trend signals,
    scans the local photo directory (filtering manifest for unused photos),
    and produces a 7-day GBP posting schedule.
    """
    exec_llm = build_exec_llm()

    photo_path = os.getenv("GBP_PHOTO_PATH", r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos")
    photo_dir = Path(photo_path)
    manifest_path = photo_dir / "gbp-photo-manifest.csv"

    # Manifest-aware photo scan — exclude already used/archived
    if photo_dir.exists():
        available = _available_photos(photo_dir, manifest_path)
        used_count = sum(
            1 for p in photo_dir.glob("gbp-photo-manifest.csv") if p.exists()
        )  # just checking existence
        # Count used from manifest for reporting
        _, mrows = _read_manifest(manifest_path)
        used_count = sum(
            1 for r in mrows
            if r.get("Status", "").strip().lower() in {"used", "archived", "posted"}
        )
        photo_list = "\n".join(available) if available else "No unused photos available."
        photo_summary = f"{len(available)} available, {used_count} already used/archived"
    else:
        available = []
        photo_list = f"Photo directory not found: {photo_path}"
        photo_summary = "directory missing"

    content_report = read_output("content_report.md")
    gbp_report = read_output("gbp_report.md")

    poster_context = (
        f"GBP_PHOTO_PATH: {photo_path}\n"
        f"MANIFEST: {manifest_path}\n"
        f"PHOTO AVAILABILITY: {photo_summary}\n\n"
        "AVAILABLE PHOTOS (not yet used — do NOT select any photo not in this list):\n"
        f"{photo_list}\n\n"
        "MANIFEST RULE: Only select photos from the AVAILABLE PHOTOS list above. "
        "Photos already marked used/archived in the manifest are excluded and must not be reused.\n\n"
        f"START DATE: {start_date or 'Next business day'}\n"
        f"DAYS TO SCHEDULE: {days}\n\n"
        "CONTENT REPORT (research phase):\n\n"
        f"{content_report}\n\n"
        "GBP REPORT (research phase, includes trend signals):\n\n"
        f"{gbp_report}"
    )

    tools = build_tools()

    poster_agent = Agent(
        role="Grizzly GBP Poster Agent",
        goal="Produce a structured 7-day GBP posting schedule using only available (unused) photos from the manifest.",
        backstory=agent_backstory("gbp-poster-agent.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    poster_task = Task(
        description=(
            f"{poster_context}\n\n"
            "Use SerperDevTool to pull this week's trending electrical service queries in DFW. "
            f"Build a {days}-day GBP posting schedule starting from {start_date or 'the next business day'}. "
            "CRITICAL: Only assign photos from the AVAILABLE PHOTOS list — never repeat a photo "
            "already in the manifest with status used/archived/posted. "
            "Use the DAY/DATE/SERVICE/TOPIC/TREND_TIE/HEADLINE/BODY/CAPTION/PHOTO_FILE/CTA/HASHTAGS/STATUS format. "
            "HASHTAGS must include 3-5 relevant hashtags (e.g. #DallasElectrician #ElectricalPanel #RowlettTX). "
            "Always include at least one local hashtag and one service hashtag. "
            "All posts must have STATUS: Needs approval."
        ),
        expected_output=(
            f"A {days}-day GBP posting schedule with one structured entry per day, "
            "followed by: Photo Gaps section, Trend Summary This Week, and Owner Notes."
        ),
        agent=poster_agent,
        output_file=out("gbp_posting_schedule.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly GBP Poster Crew",
        agents=[poster_agent],
        tasks=[poster_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


# ---------------------------------------------------------------------------
# Facebook Schedule Crew  (seo-agents facebook-schedule)
# ---------------------------------------------------------------------------

def build_facebook_crew(
    start_date: str = "",
    days: int = 7,
) -> Crew:
    """
    Generates a 7-day Facebook posting schedule for Grizzly.
    Tone is punchy and story-driven (not informational like GBP).
    Every 4th day (days 1, 4, 7) is a VIDEO post with a Gemini video prompt.
    All other days are PHOTO or TEXT posts with strong hooks and hashtags.
    """
    exec_llm = build_exec_llm()

    photo_path = os.getenv("GBP_PHOTO_PATH", r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos")
    photo_dir = Path(photo_path)
    manifest_path = photo_dir / "gbp-photo-manifest.csv"

    if photo_dir.exists():
        available = _available_photos(photo_dir, manifest_path)
        photo_list = "\n".join(available) if available else "No unused photos available."
    else:
        available = []
        photo_list = f"Photo directory not found: {photo_path}"

    content_report = read_output("content_report.md")
    gbp_report = read_output("gbp_report.md")

    fb_context = (
        f"START DATE: {start_date or 'Next business day'}\n"
        f"DAYS TO SCHEDULE: {days}\n\n"
        "VIDEO DAYS: Days 1, 4, and 7 must be VIDEO posts. All other days are PHOTO (if photos available) or TEXT posts.\n\n"
        "AVAILABLE PHOTOS (for non-video days):\n"
        f"{photo_list}\n\n"
        "CONTENT REPORT:\n\n"
        f"{content_report}\n\n"
        "GBP REPORT (includes trend signals):\n\n"
        f"{gbp_report}"
    )

    fb_agent = Agent(
        role="Grizzly Facebook Content Agent",
        goal=(
            "Write scroll-stopping Facebook posts for Grizzly Electrical Solutions. "
            "Posts must grab attention instantly, tell a mini-story, and drive action. "
            "Use punchy hooks, local references, and emotional angles. Never sound corporate. "
            "Video posts must include a cinematic, specific Gemini video prompt."
        ),
        backstory=(
            "You are an expert social media copywriter for a local electrical contractor in DFW, Texas. "
            "You know that Facebook users scroll fast — your job is to STOP the scroll with the first line. "
            "You write the way homeowners talk, not the way companies talk. "
            "You use fear, curiosity, humor, and local pride to drive engagement. "
            "Every post must feel human, urgent, and worth reading all the way through."
        ),
        tools=[],
        llm=exec_llm,
        verbose=is_verbose(),
    )

    fb_task = Task(
        description=(
            f"{fb_context}\n\n"
            f"Build a {days}-day Facebook posting schedule starting from {start_date or 'the next business day'}.\n\n"
            "TONE RULES (mandatory):\n"
            "- HOOK must be the first line — make it impossible to scroll past (question, bold claim, or shocking stat)\n"
            "- BODY tells a mini-story (30-80 words). No bullet points. Conversational, local, real.\n"
            "- CTA is specific: 'Call us today', 'DM us for a free quote', 'Link in bio to book'\n"
            "- HASHTAGS: 5-8 tags. Always include #DFW or #Dallas, one service tag, one brand tag (#GrizzlyElectrical)\n\n"
            "VIDEO POST RULES (days 1, 4, 7):\n"
            "- TYPE must be: video\n"
            "- VIDEO_PROMPT must be a cinematic description for Gemini Veo: include setting, action, lighting, mood, duration hint\n"
            "- Example: 'Professional electrician replacing a circuit breaker panel in a modern Dallas home, "
            "close-up of hands working, warm workshop lighting, confident and skilled, 8 seconds'\n\n"
            "PHOTO POST RULES (days 2, 3, 5, 6):\n"
            "- TYPE must be: photo (if photo available from list) or text\n"
            "- PHOTO_FILE: pick from AVAILABLE PHOTOS list. Leave blank if none available.\n\n"
            "Use the following format for each post (one per day, separated by ---):\n\n"
            "DAY: [number]\n"
            "DATE: [YYYY-MM-DD]\n"
            "TYPE: [video|photo|text]\n"
            "SERVICE: [service area this post covers]\n"
            "HOOK: [first line — the scroll-stopper]\n"
            "BODY: [the story, 30-80 words]\n"
            "CTA: [specific call to action]\n"
            "HASHTAGS: [5-8 hashtags]\n"
            "PHOTO_FILE: [path or blank]\n"
            "VIDEO_PROMPT: [Gemini Veo prompt or blank]\n"
            "STATUS: Needs approval\n\n"
            "---\n\n"
            "After all 7 posts, add a CONTENT NOTES section with trend signals used and photo gaps."
        ),
        expected_output=(
            f"A {days}-day Facebook posting schedule with one structured entry per day, "
            "including hooks, stories, hashtags, and Gemini video prompts for video days."
        ),
        agent=fb_agent,
        output_file=out("facebook_posting_schedule.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Facebook Schedule Crew",
        agents=[fb_agent],
        tasks=[fb_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


# ---------------------------------------------------------------------------
# Public alias (backward compat)
# ---------------------------------------------------------------------------

def build_seo_crew(
    topic: str,
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
    previous_context: str = "",
    completed_tasks: str = "",
) -> Crew:
    return build_grizzly_crew(
        topic=topic,
        site_url=site_url,
        audience=audience,
        region=region,
        keywords=keywords,
        previous_context=previous_context,
        completed_tasks=completed_tasks,
    )
