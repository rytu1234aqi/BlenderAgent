from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any, Iterable

from .contracts import EditContract


FLOAT_PRECISION = 9
SCENE_IR_VERSION = "1.0"


def inside_source_directory(root: Path, path: str) -> bool:
    if not path:
        return False
    root = os.path.normcase(os.path.abspath(root))
    candidate = os.path.normcase(os.path.abspath(path))
    try:
        if os.path.commonpath([root, candidate]) != root:
            return False
        resolved_root = os.path.normcase(os.path.realpath(root))
        resolved_candidate = os.path.normcase(os.path.realpath(candidate))
        return os.path.commonpath([resolved_root, resolved_candidate]) == resolved_root
    except ValueError:
        return False


def object_id_for(name: str, object_type: str = "MESH", library_path: str = "") -> str:
    identity = f"{object_type}\0{name}\0{library_path}".encode("utf-8")
    return "obj_" + hashlib.sha256(identity).hexdigest()[:16]


def data_id_for(kind: str, name: str) -> str:
    identity = f"{kind}\0{name}".encode("utf-8")
    return f"{kind}_" + hashlib.sha256(identity).hexdigest()[:16]


def canonicalize(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Scene IR cannot contain NaN or infinity")
        normalized = round(value, FLOAT_PRECISION)
        return 0.0 if normalized == 0 else normalized
    if isinstance(value, dict):
        return {str(key): canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [canonicalize(item) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    raise TypeError(f"Unsupported Scene IR value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(canonicalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def semantic_hash(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Difference:
    path: str
    before: Any
    after: Any
    kind: str

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "before": self.before,
            "after": self.after,
            "kind": self.kind,
        }


def diff_values(before: Any, after: Any, path: str = "scene") -> list[Difference]:
    before = canonicalize(before)
    after = canonicalize(after)
    if type(before) is not type(after):
        return [Difference(path, before, after, "changed")]
    if isinstance(before, dict):
        differences = []
        for key in sorted(set(before) | set(after)):
            child_path = f"{path}.{key}"
            if key not in before:
                differences.append(Difference(child_path, None, after[key], "added"))
            elif key not in after:
                differences.append(Difference(child_path, before[key], None, "removed"))
            else:
                differences.extend(diff_values(before[key], after[key], child_path))
        return differences
    if isinstance(before, list):
        if len(before) != len(after):
            return [Difference(path, before, after, "changed")]
        differences = []
        for index, (left, right) in enumerate(zip(before, after)):
            differences.extend(diff_values(left, right, f"{path}.{index}"))
        return differences
    if before != after:
        return [Difference(path, before, after, "changed")]
    return []


def _segments_match(pattern: list[str], path: list[str]) -> bool:
    if not pattern:
        return True
    if pattern[0] == "**":
        return True
    if not path:
        return False
    if pattern[0] not in {"*", path[0]}:
        return False
    return _segments_match(pattern[1:], path[1:])


def path_matches(pattern: str, path: str) -> bool:
    """Match a path or any descendant of an authorized path."""
    return _segments_match(pattern.split("."), path.split("."))


def descendants_of(scene: dict, root_id: str) -> set[str]:
    objects = scene.get("objects", {})
    children: dict[str, list[str]] = {}
    for object_id, record in objects.items():
        parent_id = record.get("parent_id")
        if parent_id:
            children.setdefault(parent_id, []).append(object_id)
    result: set[str] = set()
    pending = list(children.get(root_id, []))
    while pending:
        current = pending.pop()
        if current in result:
            continue
        result.add(current)
        pending.extend(children.get(current, []))
    return result


def expand_implied_patterns(write_set: list[str]) -> list[str]:
    implied = []
    for pattern in write_set:
        for field in ["location", "rotation_euler", "scale"]:
            suffix = f".local_transform.{field}"
            if pattern.endswith(suffix):
                prefix = pattern[:-len(suffix)]
                implied.append(f"{prefix}.world_matrix")
                if field == "scale":
                    implied.append(f"{prefix}.dimensions")
        if ".curve.splines." in pattern and pattern.endswith(".co"):
            object_prefix = pattern.split(".curve.splines.", 1)[0]
            implied.append(f"{object_prefix}.curve.world_endpoints")
            implied.append(f"{object_prefix}.dimensions")
        if pattern.endswith(".modifiers"):
            implied.append(f"{pattern[:-len('.modifiers')]}.dimensions")
    return implied


def expand_derived_patterns(contract: EditContract, scene: dict) -> list[str]:
    patterns = expand_implied_patterns(contract.write_set)
    for allowance in contract.derived_allowances:
        if allowance.get("relation") in {"children_world_transform", "children_world_geometry"}:
            root_id = allowance.get("root_object_id")
            if root_id not in scene.get("objects", {}):
                continue
            patterns.extend(
                f"scene.objects.{object_id}.world_matrix"
                for object_id in descendants_of(scene, root_id)
            )
            if allowance.get("relation") == "children_world_geometry":
                patterns.extend(
                    f"scene.objects.{object_id}.dimensions"
                    for object_id in descendants_of(scene, root_id)
                )
    return patterns


def classify_differences(
    before: dict,
    after: dict,
    contract: EditContract,
) -> dict:
    derived_patterns = expand_derived_patterns(contract, before)
    original_objects = before.get("objects", {})
    rotation_roots = {
        object_id for object_id in original_objects
        if any(path_matches(pattern, f"scene.objects.{object_id}.local_transform.rotation_euler") for pattern in contract.write_set)
    }
    rotated_objects = set(rotation_roots)
    for allowance in contract.derived_allowances:
        root = allowance.get("root_object_id")
        if allowance.get("relation") == "children_world_transform" and root in rotation_roots:
            rotated_objects.update(descendants_of(before, root))
    for object_id in sorted(rotated_objects):
        original = original_objects[object_id]
        prefix = f"scene.objects.{object_id}"
        updated = after.get("objects", {}).get(object_id, {})
        if not updated.get("world_matrix") or updated["world_matrix"] == original.get("world_matrix"):
            continue
        if original.get("curve"):
            derived_patterns.append(f"{prefix}.curve.world_endpoints")
        old_dimensions = original.get("dimensions", [])
        new_dimensions = updated.get("dimensions", [])
        # Blender measures dimensions using single-precision world basis lengths.
        # A rigid rotation can change those lengths by a few float32 ULPs.
        if len(old_dimensions) == len(new_dimensions) == 3 and all(
            math.isclose(old, new, rel_tol=5e-7, abs_tol=1e-9)
            for old, new in zip(old_dimensions, new_dimensions)
        ):
            derived_patterns.append(f"{prefix}.dimensions")
    authorized = []
    unauthorized = []
    for difference in diff_values(before, after):
        item = difference.to_dict()
        if any(path_matches(pattern, difference.path) for pattern in contract.write_set):
            item["classification"] = "DIRECT_AUTHORIZED"
            authorized.append(item)
        elif any(path_matches(pattern, difference.path) for pattern in derived_patterns):
            item["classification"] = "DERIVED_AUTHORIZED"
            authorized.append(item)
        else:
            item["classification"] = "UNAUTHORIZED"
            unauthorized.append(item)
    return {
        "status": "passed" if not unauthorized else "failed",
        "authorized_changes": authorized,
        "unauthorized_changes": unauthorized,
        "derived_patterns": derived_patterns,
    }


def save_scene_ir(scene: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_json(scene) + "\n", encoding="utf-8")


def iter_changed_paths(diff_report: dict) -> Iterable[str]:
    for item in diff_report["authorized_changes"] + diff_report["unauthorized_changes"]:
        yield item["path"]
