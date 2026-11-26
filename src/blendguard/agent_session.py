from __future__ import annotations

import json
from pathlib import Path
import shutil
from typing import Callable

from .errors import BlendGuardError, PlanningError
from .planning import Planner, compile_request
from .workspace import write_json


def _numeric_only_changes(before, after) -> bool:
    if isinstance(before, dict):
        return isinstance(after, dict) and set(before) == set(after) and all(
            _numeric_only_changes(before[key], after[key]) for key in before
        )
    if isinstance(before, list):
        return isinstance(after, list) and len(before) == len(after) and all(
            _numeric_only_changes(left, right) for left, right in zip(before, after)
        )
    if isinstance(before, bool) or not isinstance(before, (int, float)):
        return before == after
    return isinstance(after, (int, float)) and not isinstance(after, bool)


def assert_retry_scope(original: dict, replacement: dict) -> None:
    original_contract = dict(original["contract"])
    replacement_contract = dict(replacement["contract"])
    original_contract["run_id"] = replacement_contract["run_id"]
    if original_contract != replacement_contract:
        raise PlanningError("A retry may not change the contract, constraints or authorized scope")
    if not _numeric_only_changes(original["operations"], replacement["operations"]):
        raise PlanningError("A retry may change numeric parameters only, not tools, targets or names")


def _retryable(result: dict) -> bool:
    if result.get("status") == "ABORTED":
        return result.get("error", {}).get("code") == "TOOL_EXECUTION_FAILED"
    if result.get("status") == "ROLLED_BACK" and result.get("reason") == "VALIDATION_FAILED":
        return result.get("targets", {}).get("status") == "failed" and result.get("locality", {}).get("status") == "passed"
    return False


def execute_agent_plan(
    planner: Planner,
    instruction: str,
    summary: dict,
    source_file: Path,
    source_sha256: str,
    run_dir: Path,
    runner: Callable[[dict], tuple[int, dict]],
    *,
    confirmed_target: str | None,
    approve_low_confidence: bool,
    export: bool,
    retry_budget: int,
    initial_plan: tuple[dict, dict],
) -> dict:
    run_dir.mkdir(parents=True, exist_ok=False)
    attempts = []
    feedback = None
    original_request = None
    final_result = None
    for attempt in range(retry_budget + 1):
        attempt_id = f"{run_dir.name}_attempt_{attempt + 1:03d}"
        try:
            proposal, provider_metadata = initial_plan if attempt == 0 else planner.propose(instruction, summary, feedback)
            request = compile_request(
                instruction,
                proposal,
                summary,
                str(source_file),
                source_sha256,
                attempt_id,
                confirmed_target=confirmed_target,
                approve_low_confidence=approve_low_confidence,
                export=export,
                retry_budget=retry_budget,
            )
            if original_request is None:
                original_request = request
            else:
                assert_retry_scope(original_request, request)
            attempt_dir = run_dir / "attempts" / f"attempt_{attempt + 1:03d}"
            request["run_dir"] = str(attempt_dir)
            write_json(attempt_dir.parent / f"request_{attempt + 1:03d}.json", request)
            returncode, result = runner(request)
        except Exception as exc:
            error = exc.to_dict() if isinstance(exc, BlendGuardError) else {
                "code": "AGENT_SESSION_FAILED",
                "message": str(exc),
                "details": {"type": type(exc).__name__},
            }
            attempts.append({
                "attempt": attempt + 1,
                "run_id": attempt_id,
                "status": "ERROR",
                "error": error,
            })
            final_result = {"status": "ABORTED", "error": error}
            break
        attempts.append({
            "attempt": attempt + 1,
            "run_id": attempt_id,
            "proposal": proposal,
            "provider": provider_metadata,
            "status": result["status"],
            "path": str(attempt_dir),
        })
        final_result = result
        if returncode == 0 and result["status"] == "COMMITTED":
            for directory in ["input", "reports", "export", "delivery"]:
                shutil.copytree(attempt_dir / directory, run_dir / directory)
            result = dict(result)
            result["output"] = str(run_dir / "delivery" / "output.blend")
            write_json(run_dir / "delivery" / "quality_report.json", result)
            report = {
                "status": "COMMITTED",
                "run_id": run_dir.name,
                "attempts": attempts,
                "verification_run_dir": str(run_dir),
                "execution": result,
            }
            write_json(run_dir / "result.json", report)
            write_json(run_dir / "reports" / "agent_plan.json", report)
            return report
        if attempt >= retry_budget or not _retryable(result):
            break
        feedback = {
            "code": "TARGET_CONSTRAINT_FAILED" if result["status"] == "ROLLED_BACK" else result["error"]["code"],
            "targets": result.get("targets"),
            "error": result.get("error"),
        }
    report = {
        "status": "FAILED",
        "run_id": run_dir.name,
        "attempts": attempts,
        "execution": final_result,
        "note": "No attempt was promoted to the root delivery directory.",
    }
    write_json(run_dir / "result.json", report)
    write_json(run_dir / "reports" / "agent_plan.json", report)
    return report
