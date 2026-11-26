from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import math
from typing import Any

from .errors import ContractError


SUPPORTED_TOOLS = {
    "create_box",
    "move_part",
    "rotate_part",
    "set_dimensions",
    "duplicate_part",
    "assign_material",
    "add_bevel",
    "move_curve_endpoint",
}


def _string_list(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractError(f"{field_name} must be a list of strings")
    return value


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


@dataclass(frozen=True)
class Operation:
    tool: str
    arguments: dict[str, Any]
    operation_id: str

    @classmethod
    def from_dict(cls, data: dict[str, Any], index: int = 0) -> "Operation":
        if not isinstance(data, dict):
            raise ContractError("Each operation must be an object")
        tool = data.get("tool")
        arguments = data.get("arguments")
        if tool not in SUPPORTED_TOOLS:
            raise ContractError(
                f"Unsupported tool: {tool!r}",
                details={"supported_tools": sorted(SUPPORTED_TOOLS)},
            )
        if not isinstance(arguments, dict):
            raise ContractError("Operation arguments must be an object")
        operation_id = data.get("operation_id", f"op_{index + 1:03d}")
        if not isinstance(operation_id, str) or not operation_id:
            raise ContractError("operation_id must be a non-empty string")
        return cls(tool=tool, arguments=arguments, operation_id=operation_id)

    def to_dict(self) -> dict:
        return {
            "operation_id": self.operation_id,
            "tool": self.tool,
            "arguments": self.arguments,
        }


@dataclass(frozen=True)
class EditContract:
    run_id: str
    source_sha256: str
    instruction: str
    targets: list[str]
    write_set: list[str]
    dependencies: list[str] = field(default_factory=list)
    derived_allowances: list[dict[str, Any]] = field(default_factory=list)
    freeze_set: list[str] = field(default_factory=list)
    constraints: list[dict[str, Any]] = field(default_factory=list)
    retry_budget: int = 2
    export: dict[str, Any] = field(default_factory=dict)
    contract_version: str = "1.0"
    scene_ir_version: str = "1.0"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EditContract":
        if not isinstance(data, dict):
            raise ContractError("Contract must be a JSON object")
        required = ["run_id", "source_sha256", "instruction", "targets", "write_set"]
        missing = [name for name in required if name not in data]
        if missing:
            raise ContractError("Missing contract fields", details={"missing": missing})

        run_id = data["run_id"]
        source_sha256 = data["source_sha256"]
        instruction = data["instruction"]
        if not all(isinstance(value, str) and value for value in [run_id, source_sha256, instruction]):
            raise ContractError("run_id, source_sha256 and instruction must be non-empty strings")
        if len(source_sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in source_sha256):
            raise ContractError("source_sha256 must be a SHA-256 hexadecimal digest")

        raw_targets = data["targets"]
        if not isinstance(raw_targets, list):
            raise ContractError("targets must be a list")
        targets = []
        for target in raw_targets:
            if isinstance(target, str):
                targets.append(target)
            elif isinstance(target, dict) and isinstance(target.get("object_id"), str):
                targets.append(target["object_id"])
            else:
                raise ContractError("Each target must be an object ID or an object containing object_id")

        raw_dependencies = data.get("dependencies", [])
        if not isinstance(raw_dependencies, list):
            raise ContractError("dependencies must be a list")
        dependencies = []
        for dependency in raw_dependencies:
            if isinstance(dependency, str):
                dependencies.append(dependency)
            elif isinstance(dependency, dict) and isinstance(dependency.get("object_id"), str):
                dependencies.append(dependency["object_id"])
            else:
                raise ContractError("Each dependency must be an object ID or contain object_id")

        derived_allowances = data.get("derived_allowances", [])
        constraints = data.get("constraints", [])
        export = data.get("export", {})
        if not isinstance(derived_allowances, list) or not all(isinstance(x, dict) for x in derived_allowances):
            raise ContractError("derived_allowances must be a list of objects")
        if not isinstance(constraints, list) or not all(isinstance(x, dict) for x in constraints):
            raise ContractError("constraints must be a list of objects")
        if not isinstance(export, dict):
            raise ContractError("export must be an object")
        retry_budget = data.get("retry_budget", 2)
        if not isinstance(retry_budget, int) or isinstance(retry_budget, bool) or not 0 <= retry_budget <= 2:
            raise ContractError("retry_budget must be an integer between 0 and 2")

        return cls(
            run_id=run_id,
            source_sha256=source_sha256.lower(),
            instruction=instruction,
            targets=targets,
            write_set=_string_list(data["write_set"], "write_set"),
            dependencies=dependencies,
            derived_allowances=derived_allowances,
            freeze_set=_string_list(data.get("freeze_set", []), "freeze_set"),
            constraints=constraints,
            retry_budget=retry_budget,
            export=export,
            contract_version=str(data.get("contract_version", "1.0")),
            scene_ir_version=str(data.get("scene_ir_version", "1.0")),
        )

    def validate(self) -> None:
        if self.contract_version != "1.0" or self.scene_ir_version != "1.0":
            raise ContractError("Unsupported contract or Scene IR version")
        for constraint in self.constraints:
            constraint_type = constraint.get("type")
            if constraint_type not in {
                "translation_delta",
                "rotation_delta",
                "dimensions_unchanged",
                "object_count_unchanged",
                "endpoint_distance",
                "dimensions_equal",
                "object_location",
                "object_count_delta",
                "bevel_present",
                "material_slot",
            }:
                raise ContractError(f"Unsupported constraint type: {constraint_type!r}")
            if constraint_type == "translation_delta":
                delta = constraint.get("delta")
                if not _is_finite_number(delta):
                    raise ContractError("translation_delta requires a finite numeric delta")
                if constraint.get("axis") not in {"x", "y", "z"}:
                    raise ContractError("translation_delta axis must be x, y or z")
            if constraint_type == "rotation_delta":
                if not isinstance(constraint.get("target"), str) or not constraint["target"]:
                    raise ContractError("rotation_delta requires a target object ID")
                if constraint.get("axis") not in ("x", "y", "z"):
                    raise ContractError("rotation_delta axis must be x, y or z")
                angle = constraint.get("angle_deg")
                if not _is_finite_number(angle):
                    raise ContractError("rotation_delta requires a finite numeric angle_deg")
                tolerance = constraint.get("tolerance_deg", 0.05)
                if not _is_finite_number(tolerance) or tolerance < 0:
                    raise ContractError("rotation_delta requires a finite non-negative tolerance_deg")
            if constraint_type == "endpoint_distance":
                max_distance = constraint.get("max_distance")
                if isinstance(max_distance, bool) or not isinstance(max_distance, (int, float)) or max_distance < 0:
                    raise ContractError("endpoint_distance requires a non-negative max_distance")
            if constraint_type in {"dimensions_equal", "object_location"}:
                field_name = "dimensions" if constraint_type == "dimensions_equal" else "location"
                vector = constraint.get(field_name)
                if (
                    not isinstance(vector, list) or len(vector) != 3
                    or any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in vector)
                ):
                    raise ContractError(f"{constraint_type} requires three finite {field_name}")
            if constraint_type == "object_count_delta":
                delta = constraint.get("delta")
                if not isinstance(delta, int) or isinstance(delta, bool) or delta < 0:
                    raise ContractError("object_count_delta requires a non-negative integer delta")
            if constraint_type == "material_slot":
                if (
                    not isinstance(constraint.get("material_id"), str) or not constraint["material_id"]
                    or not isinstance(constraint.get("slot_index"), int) or isinstance(constraint["slot_index"], bool)
                    or constraint["slot_index"] < 0
                ):
                    raise ContractError("material_slot requires a material ID and non-negative integer slot index")
            if constraint_type == "bevel_present":
                width = constraint.get("width")
                segments = constraint.get("segments")
                if (
                    isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or width <= 0
                    or not isinstance(segments, int) or isinstance(segments, bool) or not 1 <= segments <= 16
                ):
                    raise ContractError("bevel_present requires positive width and segments between 1 and 16")

    def to_dict(self) -> dict:
        return {
            "contract_version": self.contract_version,
            "scene_ir_version": self.scene_ir_version,
            "run_id": self.run_id,
            "source_sha256": self.source_sha256,
            "instruction": self.instruction,
            "targets": self.targets,
            "dependencies": self.dependencies,
            "write_set": self.write_set,
            "derived_allowances": self.derived_allowances,
            "freeze_set": self.freeze_set,
            "constraints": self.constraints,
            "retry_budget": self.retry_budget,
            "export": self.export,
        }

    def digest(self) -> str:
        payload = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()
