from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from time import perf_counter

from .workspace import file_sha256, write_json
from .errors import BlendGuardError


def run_blender_request(request: dict, blender: str, timeout: int = 300) -> tuple[int, dict]:
    """Execute an absolute-path request and return its machine-readable result."""
    run_dir = Path(request["run_dir"])
    result_path = run_dir / "result.json"
    source_root = Path(__file__).resolve().parents[1]
    expression = (
        f"import sys; sys.path.insert(0, {str(source_root)!r}); "
        "from blendguard.blender_runner import main; main()"
    )
    with tempfile.TemporaryDirectory(prefix="blendguard-request-") as directory:
        resolved_request = Path(directory) / "request.json"
        write_json(resolved_request, request)
        command = [
            str(Path(blender).resolve()),
            "--background",
            "--factory-startup",
            "--disable-autoexec",
            "--python-exit-code",
            "1",
            "--python-expr",
            expression,
            "--",
            "--request",
            str(resolved_request),
            "--result",
            str(result_path),
        ]
        try:
            completed = subprocess.run(command, check=False, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 124, {"status": "ABORTED", "error": {"code": "BLENDER_TIMEOUT", "message": f"Blender exceeded {timeout} seconds"}}
    if not result_path.exists() and (run_dir / "reports" / "result.json").is_file():
        result_path = run_dir / "reports" / "result.json"
    if not result_path.exists():
        return completed.returncode or 1, {"status": "ABORTED", "error": {"code": "RUNNER_NO_RESULT"}}
    return completed.returncode, json.loads(result_path.read_text(encoding="utf-8"))


def _blender_executable(configured: str | None) -> str:
    candidate = configured or os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")
    if not candidate:
        raise SystemExit(
            "Blender was not found. Pass --blender /path/to/blender.exe "
            "or set BLENDER_EXECUTABLE."
        )
    return candidate


def _cmd_hash(args: argparse.Namespace) -> None:
    print(file_sha256(args.file))


def _cmd_run(args: argparse.Namespace) -> None:
    request_path = args.request.resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    source = Path(request["source_file"])
    if not source.is_absolute():
        source = (request_path.parent / source).resolve()
        request["source_file"] = str(source)
    run_dir = Path(request["run_dir"])
    if not run_dir.is_absolute():
        run_dir = (request_path.parent / run_dir).resolve()
        request["run_dir"] = str(run_dir)
    blender = _blender_executable(args.blender)
    returncode, _ = run_blender_request(request, blender, args.blender_timeout)
    raise SystemExit(returncode)


def _cmd_verify(args: argparse.Namespace) -> None:
    run_dir = args.run_dir.resolve()
    result_path = args.result.resolve() if args.result else run_dir / "reports" / "independent_verification.json"
    blender = _blender_executable(args.blender)
    source_root = Path(__file__).resolve().parents[1]
    expression = (
        f"import sys; sys.path.insert(0, {str(source_root)!r}); "
        "from blendguard.verifier import main; main()"
    )
    command = [
        str(Path(blender).resolve()),
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code", "1",
        "--python-expr",
        expression,
        "--",
        "--run-dir",
        str(run_dir),
        "--result",
        str(result_path),
    ]
    try:
        completed = subprocess.run(command, check=False, timeout=args.blender_timeout)
    except subprocess.TimeoutExpired:
        write_json(result_path, {"status": "FAILED", "error": {"code": "BLENDER_TIMEOUT", "message": f"Verifier exceeded {args.blender_timeout} seconds"}})
        print(f"FAILED: {result_path}")
        raise SystemExit(124)
    if result_path.exists():
        result = json.loads(result_path.read_text(encoding="utf-8"))
        print(f"{result['status']}: {result_path}")
    raise SystemExit(completed.returncode)


def _summary_digest(summary: dict) -> str:
    payload = json.dumps(summary, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _load_reviewed_plan(path: Path, source: Path, source_hash: str, instruction: str, summary: dict) -> tuple[dict, dict, str]:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"PLAN_APPROVAL_MISMATCH: cannot read reviewed plan: {exc}") from exc
    if plan.get("status") not in {"READY", "NEEDS_CONFIRMATION"}:
        raise SystemExit("PLAN_APPROVAL_MISMATCH: reviewed plan must be READY or NEEDS_CONFIRMATION")
    mismatches = []
    if plan.get("instruction") != instruction:
        mismatches.append("instruction")
    if plan.get("source_sha256") != source_hash:
        mismatches.append("source_sha256")
    if plan.get("summary_sha256") != _summary_digest(summary):
        mismatches.append("scene summary")
    try:
        plan_source = Path(plan.get("source_file", "")).resolve()
    except (OSError, RuntimeError):
        plan_source = None
    if plan_source != source:
        mismatches.append("source_file")
    if not isinstance(plan.get("proposal"), dict) or not isinstance(plan.get("planner"), dict):
        mismatches.append("proposal or planner")
    if mismatches:
        raise SystemExit("PLAN_APPROVAL_MISMATCH: " + ", ".join(mismatches))
    return plan["proposal"], plan["planner"], file_sha256(path)


def _create_planner(name: str, model: str | None):
    from .planning import ClaudePlanner, DeepSeekPlanner, DeterministicPlanner

    if name == "deterministic":
        return DeterministicPlanner()
    if name == "deepseek":
        return DeepSeekPlanner(model=model)
    if name == "claude":
        return ClaudePlanner(model=model or "claude-opus-5-5")
    raise ValueError(f"Unknown planner: {name}")


def _inspect_scene(source: Path, blender: Path, timeout: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="blendguard-inspection-") as directory:
        scene_path = Path(directory) / "scene_ir.json"
        source_root = Path(__file__).resolve().parents[1]
        expression = (
            f"import sys; sys.path.insert(0, {str(source_root)!r}); "
            "from blendguard.blender_inspect import main; main()"
        )
        try:
            completed = subprocess.run([
                str(blender), "--background", "--factory-startup", "--disable-autoexec",
                "--python-exit-code", "1", "--python-expr", expression, "--", "--source", str(source), "--result", str(scene_path),
            ], check=False, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise SystemExit(f"BLENDER_TIMEOUT: scene inspection exceeded {timeout} seconds")
        if completed.returncode or not scene_path.is_file():
            raise SystemExit("Read-only Blender scene inspection failed")
        return json.loads(scene_path.read_text(encoding="utf-8"))


def _cmd_agent(args: argparse.Namespace) -> None:
    from .agent_session import execute_agent_plan
    from .inspect_cache import InspectionCache
    from .planning import compile_request
    from .scene_summary import load_asset_metadata, summarize_scene

    source = args.source.resolve()
    run_dir = args.run_dir.resolve()
    plan_path = args.plan_output.resolve() if args.plan_output else run_dir.with_name(run_dir.name + ".plan.json")
    plan_input = args.plan_input.resolve() if args.plan_input else None
    blender = Path(_blender_executable(args.blender)).resolve()
    if not source.is_file():
        raise SystemExit(f"Source file does not exist: {source}")
    if run_dir.exists():
        raise SystemExit(f"Run directory must not exist: {run_dir}")
    if plan_path.exists() and plan_path != plan_input:
        raise SystemExit(f"Plan output already exists: {plan_path}")
    if (args.approve_low_confidence or args.confirm_target) and not plan_input:
        raise SystemExit("Confirmation flags require --plan-input so the exact reviewed proposal is executed")
    if plan_input and not plan_input.is_file():
        raise SystemExit(f"Reviewed plan does not exist: {plan_input}")
    metadata = load_asset_metadata(source)
    started = perf_counter()
    inspected_source_hash = file_sha256(source)
    cache = None
    if not args.no_inspect_cache:
        cache_dir = args.inspect_cache_dir or Path(
            os.environ.get("BLENDGUARD_INSPECT_CACHE_DIR") or run_dir.parent / ".blendguard_inspect_cache"
        )
        try:
            cache = InspectionCache.for_source(cache_dir, source, inspected_source_hash, blender)
        except OSError:
            pass
    scene = cache.read() if cache else None
    cache_hit = scene is not None
    if scene is None:
        scene = _inspect_scene(source, blender, args.blender_timeout)
    source_hash = file_sha256(source)
    if source_hash != inspected_source_hash:
        raise SystemExit("SOURCE_HASH_CHANGED: source changed during read-only inspection")
    if cache and not cache_hit:
        cache.write(scene)
    inspection = {"cache_hit": cache_hit, "elapsed_ms": (perf_counter() - started) * 1000}
    summary = summarize_scene(scene, metadata)
    summary_sha256 = _summary_digest(summary)
    planner = _create_planner(args.planner, args.model)
    instruction = args.instruction
    approved_plan_sha256 = None
    if plan_input:
        proposal, provider, approved_plan_sha256 = _load_reviewed_plan(plan_input, source, source_hash, instruction, summary)
    else:
        try:
            proposal, provider = planner.propose(instruction, summary)
        except BlendGuardError as exc:
            write_json(plan_path, {
                "status": "NOT_EXECUTABLE", "planner": planner.name, "instruction": instruction,
                "source_file": str(source), "source_sha256": source_hash, "error": exc.to_dict(),
                "inspection": inspection,
            })
            print(f"{exc.code}: {exc.message}")
            raise SystemExit(2)
    base = {
        "status": "READY",
        "planner": provider,
        "instruction": instruction,
        "proposal": proposal,
        "source_file": str(source),
        "source_sha256": source_hash,
        "summary_sha256": summary_sha256,
        "inspection": inspection,
        "approved_plan_sha256": approved_plan_sha256,
        "run_dir": str(run_dir),
        "execute_requested": bool(args.execute),
        "model_verified": False,
    }
    try:
        request = compile_request(
            instruction, proposal, summary, str(source), source_hash, run_dir.name,
            confirmed_target=args.confirm_target,
            approve_low_confidence=args.approve_low_confidence,
            export=args.export,
            retry_budget=args.retry_budget,
        )
    except BlendGuardError as exc:
        write_json(plan_path, base | {"status": "NEEDS_CONFIRMATION" if exc.code in {"TARGET_AMBIGUOUS", "CONFIRMATION_REQUIRED"} else "NOT_EXECUTABLE", "error": exc.to_dict()})
        print(f"{exc.code}: {exc.message}")
        print(f"Plan: {plan_path}")
        raise SystemExit(2)
    if not args.execute:
        write_json(plan_path, base | {"request": request})
        print(f"READY (not executed): {plan_path}")
        return
    try:
        report = execute_agent_plan(
            planner, instruction, summary, source, source_hash, run_dir,
            lambda item: run_blender_request(item, str(blender), args.blender_timeout),
            confirmed_target=args.confirm_target,
            approve_low_confidence=args.approve_low_confidence,
            export=args.export,
            retry_budget=args.retry_budget,
            initial_plan=(proposal, provider),
        )
    except BlendGuardError as exc:
        write_json(plan_path, base | {"status": "FAILED", "error": exc.to_dict()})
        print(f"{exc.code}: {exc.message}")
        raise SystemExit(2)
    write_json(plan_path, base | {"status": report["status"], "attempts": report["attempts"], "verification_run_dir": report.get("verification_run_dir")})
    print(json.dumps({"status": report["status"], "run_dir": str(run_dir), "attempts": len(report["attempts"])}, ensure_ascii=False))
    if report["status"] != "COMMITTED":
        raise SystemExit(2)


def _cmd_preview(args: argparse.Namespace) -> None:
    source_root = Path(__file__).resolve().parents[1]
    expression = (
        f"import sys; sys.path.insert(0, {str(source_root)!r}); "
        "from blendguard.blender_preview import main; main()"
    )
    blender = _blender_executable(args.blender)
    try:
        completed = subprocess.run([
            str(Path(blender).resolve()), "--background", "--factory-startup", "--disable-autoexec",
            "--python-exit-code", "1", "--python-expr", expression, "--", "--source", str(args.source.resolve()),
            "--output-dir", str(args.output_dir.resolve()), "--views", *args.views,
        ], check=False, timeout=args.blender_timeout)
    except subprocess.TimeoutExpired:
        raise SystemExit(f"BLENDER_TIMEOUT: preview exceeded {args.blender_timeout} seconds")
    manifest = args.output_dir.resolve() / "preview_manifest.json"
    if completed.returncode == 0 and not manifest.is_file():
        raise SystemExit("Preview renderer did not write its manifest")
    raise SystemExit(completed.returncode)


def main() -> None:
    parser = argparse.ArgumentParser(prog="blendguard")
    subparsers = parser.add_subparsers(dest="command", required=True)

    hash_parser = subparsers.add_parser("hash", help="Calculate a source .blend SHA-256")
    hash_parser.add_argument("file", type=Path)
    hash_parser.set_defaults(handler=_cmd_hash)

    run_parser = subparsers.add_parser("run", help="Execute a contract and tool plan in Blender")
    run_parser.add_argument("--request", required=True, type=Path)
    run_parser.add_argument("--blender")
    run_parser.add_argument("--blender-timeout", type=int, default=300, help="Maximum seconds for the Blender process")
    run_parser.set_defaults(handler=_cmd_run)

    verify_parser = subparsers.add_parser("verify", help="Independently verify a committed delivery")
    verify_parser.add_argument("--run-dir", required=True, type=Path)
    verify_parser.add_argument("--result", type=Path)
    verify_parser.add_argument("--blender")
    verify_parser.add_argument("--blender-timeout", type=int, default=300, help="Maximum seconds for the Blender process")
    verify_parser.set_defaults(handler=_cmd_verify)

    agent_parser = subparsers.add_parser("agent", help="Plan one natural-language local edit, optionally execute it")
    agent_parser.add_argument("--source", required=True, type=Path)
    agent_parser.add_argument("--instruction", required=True)
    agent_parser.add_argument("--run-dir", required=True, type=Path)
    agent_parser.add_argument("--plan-output", type=Path)
    agent_parser.add_argument("--plan-input", type=Path, help="Reuse an exact reviewed READY or NEEDS_CONFIRMATION plan without replanning")
    agent_parser.add_argument("--planner", choices=["deepseek", "claude", "deterministic"], default="deepseek")
    agent_parser.add_argument("--model", default=None)
    agent_parser.add_argument("--execute", action="store_true", help="Actually run the typed plan; planning alone never writes the asset")
    agent_parser.add_argument("--confirm-target", help="Confirmed object ID, which must be among the resolved candidates")
    agent_parser.add_argument("--approve-low-confidence", action="store_true")
    agent_parser.add_argument("--retry-budget", type=int, choices=[0, 1, 2], default=0)
    agent_parser.add_argument("--no-export", dest="export", action="store_false", default=True)
    agent_parser.add_argument("--blender")
    agent_parser.add_argument("--inspect-cache-dir", type=Path, help="Directory for read-only scene inspections")
    agent_parser.add_argument("--no-inspect-cache", action="store_true", help="Always inspect the source in a fresh Blender process")
    agent_parser.add_argument("--blender-timeout", type=int, default=300, help="Maximum seconds for each Blender process")
    agent_parser.set_defaults(handler=_cmd_agent)

    preview_parser = subparsers.add_parser("preview", help="Render fixed preview cameras without modifying the source")
    preview_parser.add_argument("--source", required=True, type=Path)
    preview_parser.add_argument("--output-dir", required=True, type=Path)
    preview_parser.add_argument("--views", nargs="+", choices=["overview", "front", "right", "cable"], default=["overview", "front", "right", "cable"])
    preview_parser.add_argument("--blender")
    preview_parser.add_argument("--blender-timeout", type=int, default=300, help="Maximum seconds for the Blender process")
    preview_parser.set_defaults(handler=_cmd_preview)

    args = parser.parse_args()
    if getattr(args, "blender_timeout", 300) <= 0:
        parser.error("--blender-timeout must be positive")
    args.handler(args)


if __name__ == "__main__":
    main()
