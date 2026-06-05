from __future__ import annotations

import argparse
import os
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

from seo_agents.crew import (
    DEFAULT_AUDIENCE,
    DEFAULT_REGION,
    DEFAULT_SITE_URL,
    ARCHIVE_DIR,
    OUTPUT_DIR,
    archive_used_photos,
    build_executor_crew,
    build_poster_crew,
    build_seo_crew,
)

APPROVAL_BANNER = """
╔══════════════════════════════════════════════════════════════════╗
║           ✅  RESEARCH + PLAN COMPLETE — OWNER REVIEW           ║
╠══════════════════════════════════════════════════════════════════╣
║  Review these files before running execution:                   ║
║  • outputs/grizzly_local_presence_plan.md  (manager plan)       ║
║  • outputs/grizzly_execution_queue.md      (task queue)         ║
║                                                                  ║
║  When ready to execute:                                          ║
║    seo-agents execute                                            ║
╚══════════════════════════════════════════════════════════════════╝
"""


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


def main() -> None:
    reconfigure_stdio()
    load_dotenv()
    args = parse_args()
    ensure_dirs()

    # Determine effective command
    command = args.command

    # Legacy positional: `seo-agents <topic>`
    if command is None and args.topic:
        command = "research"

    if command == "research" or (command is None and args.topic):
        topic = getattr(args, "topic", "") or ""
        crew = build_seo_crew(
            topic=topic,
            site_url=getattr(args, "site_url", ""),
            audience=getattr(args, "audience", ""),
            region=getattr(args, "region", ""),
            keywords=getattr(args, "keywords", ""),
        )
        if args.dry_run:
            print(f"Ready: {crew.name}")
            print(f"Agents ({len(crew.agents)}):")
            for agent in crew.agents:
                print(f"  - {agent.role}")
            print(f"Tasks: {len(crew.tasks)}")
            return
        try:
            result = crew.kickoff()
            print(result)
            print(APPROVAL_BANNER)
        except Exception as e:
            print(f"\n❌ Research crew failed: {e}")
            sys.exit(1)

    elif command == "execute":
        queue_path = OUTPUT_DIR / "grizzly_execution_queue.md"
        if not queue_path.exists():
            print("❌ No execution queue found. Run research first:")
            print("   seo-agents research <topic>")
            sys.exit(1)

        crew = build_executor_crew()
        if args.dry_run:
            print(f"Ready: {crew.name}")
            print(f"Agents ({len(crew.agents)}):")
            for agent in crew.agents:
                print(f"  - {agent.role}")
            print(f"Tasks: {len(crew.tasks)}")
            return
        try:
            result = crew.kickoff()
            print(result)
            # Archive final report with timestamp
            final = OUTPUT_DIR / "final_report.md"
            if final.exists():
                stamp = date.today().isoformat()
                archived = ARCHIVE_DIR / f"final_report_{stamp}.md"
                archived.write_bytes(final.read_bytes())
                print(f"\n✅ Final report archived to: {archived}")
        except Exception as e:
            print(f"\n❌ Executor crew failed: {e}")
            sys.exit(1)

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
        except Exception as e:
            print(f"\n❌ GBP Poster crew failed: {e}")
            sys.exit(1)

    else:
        print("Usage:")
        print("  seo-agents research <topic>   — run research phase")
        print("  seo-agents execute            — run execution phase (after owner review)")
        print("  seo-agents post-schedule      — generate 7-day GBP posting schedule")
        print("  seo-agents --help             — full help")
        sys.exit(1)


if __name__ == "__main__":
    main()
