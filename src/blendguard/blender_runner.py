from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy

from .blender_export import export_and_reimport
from .blender_scene import inspect_scene, object_by_id
from .blender_tools import execute_tool
from .contracts import EditContract, Operation
from .errors import BlendGuardError, ToolExecutionError
from .scene_ir import classify_differences, diff_values, save_scene_ir
from .validators import validate_constraints
from .workspace import RunWorkspace, append_jsonl, write_json


def _open(path: Path) -> None:
    bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)


def _save(workspace: RunWorkspace) -> None:
    bpy.ops.wm.save_as_mainfile(filepath=str(workspace.working_file), check_existing=False)


def _rollback(workspace: RunWorkspace, initial_ir: dict) -> dict:
    _open(workspace.checkpoints / "cp_000.blend")
    _save(workspace)
    restored_ir = inspect_scene()
    differences = [item.to_dict() for item in diff_values(initial_ir, restored_ir)]
    report = {
        "status": "passed" if not differences else "failed",
        "differences": differences,
        "checkpoint": "cp_000.blend",
    }
    write_json(workspace.reports / "rollback_validation.json", report)
    if differences:
        raise ToolExecutionError("Rollback restoration produced unexpected scene differences", details=report)
    return report


def _inject_fault(configuration: dict | None, operation: Operation) -> None:
    if not configuration or configuration.get("operation_id") != operation.operation_id:
        return
    fault_type = configuration.get("type")
    if fault_type == "raise_after_operation":
        raise RuntimeError(f"Injected exception after {operation.operation_id}")
    if fault_type == "unauthorized_object_change":
        obj = object_by_id(configuration["object_id"])
        obj.location.x += 1.0
        return
    raise ToolExecutionError(f"Unknown fault injection type: {fault_type!r}")


def execute_request(request: dict) -> dict:
    contract = EditContract.from_dict(request["contract"])
    contract.validate()
    operations = [Operation.from_dict(item, index) for index, item in enumerate(request.get("operations", []))]
    workspace = RunWorkspace(
        Path(request["source_file"]),
        Path(request["run_dir"]),
        contract.source_sha256,
    )
    workspace.prepare()
    events = workspace.reports / "events.jsonl"
    write_json(workspace.reports / "contract.json", contract.to_dict())
    write_json(workspace.reports / "plan.json", {"operations": [item.to_dict() for item in operations]})
    append_jsonl(events, {"event": "run.received", "run_id": contract.run_id, "status": "RECEIVED"})
    rollback_report = None
    rollback_attempted = False
    initial_ir = None

    try:
        _open(workspace.working_file)
        initial_ir = inspect_scene()
        save_scene_ir(initial_ir, workspace.reports / "initial_ir.json")
        workspace.checkpoint("cp_000")
        append_jsonl(events, {"event": "scene.inspected", "run_id": contract.run_id, "status": "SNAPSHOT_READY"})

        for index, operation in enumerate(operations, start=1):
            append_jsonl(events, {
                "event": "tool.started",
                "run_id": contract.run_id,
                "operation_id": operation.operation_id,
                "tool": operation.tool,
            })
            try:
                result = execute_tool(operation, contract)
                bpy.context.view_layer.update()
                _inject_fault(request.get("fault_injection"), operation)
                bpy.context.view_layer.update()
                _save(workspace)
                checkpoint = workspace.checkpoint(f"cp_{index:03d}")
            except Exception:
                rollback_attempted = True
                rollback_report = _rollback(workspace, initial_ir)
                raise
            append_jsonl(events, {
                "event": "tool.finished",
                "run_id": contract.run_id,
                "operation_id": operation.operation_id,
                "tool": operation.tool,
                "status": "SUCCEEDED",
                "result": result,
                "checkpoint": checkpoint.name,
            })

        # Exercise a real save even for an empty plan so no-op regressions are visible.
        _save(workspace)
        final_ir = inspect_scene()
        save_scene_ir(final_ir, workspace.reports / "final_ir.json")
        locality = classify_differences(initial_ir, final_ir, contract)
        targets = validate_constraints(initial_ir, final_ir, contract)
        write_json(workspace.reports / "diff.json", locality)
        write_json(workspace.reports / "validation.json", {"targets": targets, "locality": locality})
        if targets["status"] != "passed" or locality["status"] != "passed":
            rollback_attempted = True
            rollback_report = _rollback(workspace, initial_ir)
            append_jsonl(events, {"event": "rollback.completed", "run_id": contract.run_id, "status": "ROLLED_BACK"})
            return {
                "run_id": contract.run_id,
                "status": "ROLLED_BACK",
                "reason": "VALIDATION_FAILED",
                "targets": targets,
                "locality": locality,
                "rollback": rollback_report,
            }

        export_report = None
        if contract.export.get("enabled"):
            export_path = workspace.export_dir / "output.glb"
            export_report = export_and_reimport(export_path, final_ir)
            write_json(workspace.reports / "export_validation.json", export_report)
            if export_report["status"] != "passed":
                rollback_attempted = True
                rollback_report = _rollback(workspace, initial_ir)
                append_jsonl(events, {"event": "rollback.completed", "run_id": contract.run_id, "status": "ROLLED_BACK"})
                return {
                    "run_id": contract.run_id,
                    "status": "ROLLED_BACK",
                    "reason": "EXPORT_VALIDATION_FAILED",
                    "export": export_report,
                    "rollback": rollback_report,
                }

        _open(workspace.working_file)
        workspace.assert_source_unchanged()
        output = workspace.delivery / "output.blend"
        if export_report:
            export_report["delivery_path"] = str(workspace.delivery / "output.glb")
            write_json(workspace.reports / "export_validation.json", export_report)
        report = {
            "run_id": contract.run_id,
            "status": "COMMITTED",
            "contract_sha256": contract.digest(),
            "targets": targets,
            "locality": locality,
            "export": export_report,
            "coverage_notes": final_ir.get("coverage_notes", []),
            "manifest": workspace.manifest(pending=True),
            "output": str(output),
        }
        write_json(workspace.delivery / "quality_report.json", report)
        write_json(workspace.reports / "manifest.json", report["manifest"])
        append_jsonl(events, {"event": "run.validated", "run_id": contract.run_id, "status": "VALIDATED"})
        if request.get("fault_injection", {}).get("type") == "raise_before_commit":
            raise OSError("Injected commit-path I/O failure")
        workspace.commit()
        if export_report:
            workspace.commit_export()
        return report
    except Exception as exc:
        cleanup_error = None
        try:
            workspace.discard_delivery()
        except OSError as cleanup_exc:
            cleanup_error = str(cleanup_exc)
        error = exc.to_dict() if isinstance(exc, BlendGuardError) else {
            "code": "TOOL_EXECUTION_FAILED",
            "message": str(exc),
            "details": {"type": type(exc).__name__},
        }
        if cleanup_error:
            error.setdefault("details", {})["delivery_cleanup_error"] = cleanup_error
        if not rollback_attempted and initial_ir is not None and (workspace.checkpoints / "cp_000.blend").is_file():
            rollback_attempted = True
            try:
                rollback_report = _rollback(workspace, initial_ir)
            except Exception as rollback_exc:
                error.setdefault("details", {})["rollback_error"] = str(rollback_exc)
        try:
            append_jsonl(events, {
                "event": "run.aborted",
                "run_id": contract.run_id,
                "status": "ABORTED",
                "error": error,
            })
        except OSError as event_exc:
            error.setdefault("details", {})["event_log_error"] = str(event_exc)
        report = {
            "run_id": contract.run_id,
            "status": "ABORTED",
            "error": error,
            "rollback": rollback_report,
        }
        write_json(workspace.reports / "result.json", report)
        return report


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser(description="BlendGuard deterministic Blender Runner")
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    args = parser.parse_args(argv)
    request = json.loads(args.request.read_text(encoding="utf-8"))
    result = execute_request(request)
    try:
        if request.get("fault_injection", {}).get("type") in {"raise_final_result_write", "raise_persistent_final_result_write"}:
            raise OSError("Injected final result write failure")
        write_json(args.result, result)
    except OSError as exc:
        if result["status"] != "COMMITTED":
            raise
        workspace = RunWorkspace(
            Path(request["source_file"]), Path(request["run_dir"]), request["contract"]["source_sha256"],
        )
        rollback_report = None
        error = {"code": "RESULT_WRITE_FAILED", "message": str(exc), "details": {"type": type(exc).__name__}}
        try:
            workspace.discard_delivery()
            initial_ir = json.loads((workspace.reports / "initial_ir.json").read_text(encoding="utf-8"))
            rollback_report = _rollback(workspace, initial_ir)
        except Exception as cleanup_exc:
            error["details"]["cleanup_error"] = str(cleanup_exc)
        result = {"run_id": request["contract"]["run_id"], "status": "ABORTED", "error": error, "rollback": rollback_report}
        try:
            if request.get("fault_injection", {}).get("type") == "raise_persistent_final_result_write":
                raise OSError("Injected persistent final result write failure")
            write_json(args.result, result)
        except OSError as fallback_exc:
            result["error"]["details"]["result_path_error"] = str(fallback_exc)
            write_json(workspace.reports / "result.json", result)
    if result["status"] != "COMMITTED":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
