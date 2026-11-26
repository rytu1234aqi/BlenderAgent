from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy

from .blender_export import reimport_and_validate
from .blender_scene import inspect_scene
from .contracts import EditContract
from .scene_ir import classify_differences
from .validators import validate_constraints
from .workspace import file_sha256, write_json


def _open(path: Path) -> None:
    bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)


def _check(name: str, passed: bool, measured=None, expected=None) -> dict:
    return {
        "check": name,
        "status": "passed" if passed else "failed",
        "measured": measured,
        "expected": expected,
    }


def verify_run(run_dir: Path) -> dict:
    run_dir = run_dir.resolve()
    contract = EditContract.from_dict(
        json.loads((run_dir / "reports" / "contract.json").read_text(encoding="utf-8"))
    )
    contract.validate()
    quality_report = json.loads((run_dir / "delivery" / "quality_report.json").read_text(encoding="utf-8"))
    source = run_dir / "input" / "source.blend"
    output = run_dir / "delivery" / "output.blend"
    source_hash = file_sha256(source)
    output_hash = file_sha256(output)
    hash_checks = [
        _check("reported_committed", quality_report.get("status") == "COMMITTED", quality_report.get("status"), "COMMITTED"),
        _check("source_sha256", source_hash == contract.source_sha256, source_hash, contract.source_sha256),
        _check("output_sha256", output_hash == quality_report["manifest"]["output_sha256"], output_hash, quality_report["manifest"]["output_sha256"]),
        _check("contract_sha256", contract.digest() == quality_report.get("contract_sha256"), contract.digest(), quality_report.get("contract_sha256")),
    ]

    _open(source)
    initial_ir = inspect_scene()
    _open(output)
    final_ir = inspect_scene()
    targets = validate_constraints(initial_ir, final_ir, contract)
    locality = classify_differences(initial_ir, final_ir, contract)

    export_report = None
    export_hash_check = None
    if contract.export.get("enabled"):
        glb = run_dir / "delivery" / "output.glb"
        actual_glb_hash = file_sha256(glb)
        expected_glb_hash = quality_report["manifest"].get("output_glb_sha256")
        export_hash_check = _check(
            "output_glb_sha256",
            actual_glb_hash == expected_glb_hash,
            actual_glb_hash,
            expected_glb_hash,
        )
        hash_checks.append(export_hash_check)
        export_report = reimport_and_validate(glb, final_ir)

    sections_passed = [
        all(item["status"] == "passed" for item in hash_checks),
        targets["status"] == "passed",
        locality["status"] == "passed",
        export_report is None or export_report["status"] == "passed",
    ]
    return {
        "run_id": contract.run_id,
        "status": "VERIFIED" if all(sections_passed) else "FAILED",
        "blender_version": bpy.app.version_string,
        "hashes": hash_checks,
        "targets": targets,
        "locality": locality,
        "export": export_report,
    }


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser(description="Independently verify a BlendGuard delivery")
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = verify_run(args.run_dir)
    except Exception as exc:
        result = {
            "status": "FAILED",
            "error": {"type": type(exc).__name__, "message": str(exc)},
        }
    write_json(args.result, result)
    if result["status"] != "VERIFIED":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
