from __future__ import annotations

import math
from pathlib import Path

import bpy

from .blender_scene import inspect_scene


def validate_export(expected: dict, imported: dict) -> dict:
    checks = []
    for object_id, before in expected.get("objects", {}).items():
        if before.get("type") not in {"MESH", "CURVE"}:
            continue
        after = imported.get("objects", {}).get(object_id)
        if after is None and before.get("type") == "CURVE":
            converted = [
                record for record in imported.get("objects", {}).values()
                if record.get("name") == before["name"] and record.get("type") == "MESH"
            ]
            after = converted[0] if len(converted) == 1 else None
        exists = after is not None and after.get("type") == "MESH"
        checks.append({
            "object_id": object_id,
            "name": before["name"],
            "check": "object_exists",
            "status": "passed" if exists else "failed",
        })
        if not exists:
            continue
        for field in ["parent_id", "dimensions", "world_matrix"]:
            if field == "dimensions":
                passed = all(
                    math.isclose(a, b, abs_tol=0.001, rel_tol=0.0)
                    for a, b in zip(before[field], after[field])
                )
            elif field == "world_matrix":
                before_values = [value for row in before[field] for value in row]
                after_values = [value for row in after[field] for value in row]
                passed = all(
                    math.isclose(a, b, abs_tol=0.001, rel_tol=0.0)
                    for a, b in zip(before_values, after_values)
                )
            else:
                passed = before[field] == after[field]
            checks.append({
                "object_id": object_id,
                "name": before["name"],
                "check": field,
                "status": "passed" if passed else "failed",
                "before": before[field],
                "after": after[field],
            })
        expected_materials = (before.get("mesh") or {}).get("material_slot_ids") or []
        if expected_materials:
            actual_materials = (after.get("mesh") or {}).get("material_slot_ids") or []
            checks.append({
                "object_id": object_id,
                "name": before["name"],
                "check": "material_slot_ids",
                "status": "passed" if actual_materials == expected_materials else "failed",
                "before": expected_materials,
                "after": actual_materials,
            })
    return {
        "status": "passed" if checks and all(check["status"] == "passed" for check in checks) else "failed",
        "checks": checks,
    }


def reimport_and_validate(glb_path: Path, expected: dict) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    imported = inspect_scene()
    report = validate_export(expected, imported)
    report["path"] = str(glb_path)
    return report


def export_and_reimport(glb_path: Path, expected: dict) -> dict:
    # glTF stores mesh geometry; convert curves only in memory and never save this scene.
    bpy.ops.object.select_all(action="DESELECT")
    curves = [obj for obj in bpy.context.scene.objects if obj.type == "CURVE"]
    for obj in curves:
        obj.select_set(True)
    if curves:
        bpy.context.view_layer.objects.active = curves[0]
        bpy.ops.object.convert(target="MESH")
    # With apply enabled, glTF reads modified meshes' data materials and can miss
    # object-linked overrides. Put the effective slots on the export mesh in memory.
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.modifiers:
            continue
        overrides = {
            index: slot.material for index, slot in enumerate(obj.material_slots)
            if slot.link == "OBJECT" and slot.material != obj.data.materials[index]
        }
        if not overrides:
            continue
        if obj.data.users > 1 or obj.data.library:
            obj.data = obj.data.copy()
        for index, material in overrides.items():
            obj.data.materials[index] = material
            obj.material_slots[index].link = "DATA"
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_apply=True,
        export_animations=False,
    )
    report = reimport_and_validate(glb_path, expected)
    report["curve_conversion"] = "in_memory_only" if curves else "not_required"
    return report
