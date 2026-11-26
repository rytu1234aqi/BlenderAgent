from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .errors import ContractError


def load_asset_metadata(source: Path) -> dict:
    sidecar = source.with_suffix(".manifest.json")
    for candidate in (sidecar, source.parent / "asset_manifest.json"):
        if not candidate.is_file():
            continue
        metadata = json.loads(candidate.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            raise ContractError("Asset manifest must be a JSON object")
        if metadata.get("source") == source.name or ("source" not in metadata and candidate == sidecar):
            return metadata
    return {}


def finite_number(value: Any, field: str) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            number = float(value)
        except OverflowError:
            pass
        else:
            if math.isfinite(number):
                return number
    raise ContractError(f"{field} must be a finite number")


def numeric_vector(value: Any, field: str, length: int = 3) -> list[float]:
    if not isinstance(value, list) or len(value) != length:
        raise ContractError(f"{field} must contain {length} numbers")
    return [finite_number(item, field) for item in value]


def summarize_scene(scene: dict, metadata: dict | None = None) -> dict:
    """Project verbose Scene IR into the small read-only snapshot sent to a planner."""
    metadata = metadata or {}
    protected_objects = metadata.get("protected_objects", [])
    if not isinstance(protected_objects, list) or not all(isinstance(name, str) for name in protected_objects):
        raise ContractError("protected_objects must be a list of object names")
    objects = []
    for object_id, record in sorted(scene.get("objects", {}).items(), key=lambda item: item[1]["name"]):
        editable = record["type"] in {"MESH", "CURVE", "EMPTY"}
        objects.append({
            "object_id": object_id,
            "name": record["name"],
            "type": record["type"],
            "editable": editable,
            "parent_id": record.get("parent_id"),
            "location": record["local_transform"]["location"],
            "world_location": [record["world_matrix"][row][3] for row in range(3)],
            "world_matrix": record["world_matrix"],
            "matrix_parent_inverse": record.get("matrix_parent_inverse") or [
                [1.0 if row == column else 0.0 for column in range(4)] for row in range(4)
            ],
            "dimensions": record["dimensions"],
            "bevels": [
                {"name": item["name"], "width": item["width"], "segments": item["segments"]}
                for item in record.get("modifiers", []) if item["type"] == "BEVEL"
            ],
            "material_slot_ids": (record.get("mesh") or {}).get("material_slot_ids", []),
            "curve_endpoints": (record.get("curve") or {}).get("world_endpoints"),
            "curve_point_count": len(record["curve"]["splines"][0]["points"]) if record.get("curve") and record["curve"]["splines"] else None,
        })
    connections = []
    for connection in metadata.get("connections", []):
        connections.append({
            key: _object_reference(scene, connection[key])
            for key in ["cable", "port", "target"]
        } | {"end": connection["end"]})
    return {
        "summary_version": "1.0",
        "blender_version": scene["blender_version"],
        "units": scene["unit_settings"],
        "rack_unit_m": metadata.get("rack_unit_m", 0.04445),
        "objects": objects,
        "protected_objects": protected_objects,
        "materials": [
            {"material_id": material_id, "name": record["name"]}
            for material_id, record in sorted(scene.get("materials", {}).items(), key=lambda item: item[1]["name"])
        ],
        "connections": connections,
        "aliases": metadata.get("aliases", {}),
        "coverage_notes": scene.get("coverage_notes", []),
    }


def _object_reference(scene: dict, name: str) -> dict:
    matches = [
        {"object_id": object_id, "name": record["name"]}
        for object_id, record in scene["objects"].items() if record["name"] == name
    ]
    if len(matches) != 1:
        raise ContractError(f"Asset manifest does not identify a unique object: {name}")
    return matches[0]


def resolve_target(summary: dict, query: str) -> tuple[dict | None, list[dict]]:
    """Exact names win; broad substring matches return candidates, never a guess."""
    if not isinstance(query, str) or not query.strip():
        return None, []
    query = query.strip()
    objects = [obj for obj in summary["objects"] if obj.get("editable", True)]
    exact = [obj for obj in objects if obj["object_id"] == query or obj["name"].casefold() == query.casefold()]
    alias = summary.get("aliases", {}).get(query)
    if alias and not exact:
        exact = [obj for obj in objects if obj["name"] == alias]
    if len(exact) == 1:
        return exact[0], exact
    if exact:
        return None, exact
    folded = query.casefold()
    candidates = [obj for obj in objects if folded in obj["name"].casefold()]
    return (candidates[0], candidates) if len(candidates) == 1 else (None, candidates)


def material_target(summary: dict, query: str) -> tuple[dict | None, list[dict]]:
    if not isinstance(query, str) or not query.strip():
        return None, []
    query = query.strip()
    materials = summary["materials"]
    exact = [item for item in materials if item["material_id"] == query or item["name"].casefold() == query.casefold()]
    if len(exact) == 1:
        return exact[0], exact
    candidates = [item for item in materials if query.casefold() in item["name"].casefold()]
    return (candidates[0], candidates) if len(candidates) == 1 else (None, candidates)
