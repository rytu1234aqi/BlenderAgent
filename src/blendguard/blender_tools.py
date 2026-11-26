from __future__ import annotations

import math
from typing import Any

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

from .blender_scene import _object_id, material_by_id, object_by_id
from .contracts import EditContract, Operation
from .errors import PermissionDenied, ToolExecutionError, UnsupportedAsset
from .rotation import orthonormal_rotation
from .scene_ir import object_id_for, path_matches


def _number(value: Any, name: str) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            number = float(value)
        except OverflowError:
            pass
        else:
            if math.isfinite(number):
                return number
    raise ToolExecutionError(f"{name} must be a finite number")


def _vector(value: Any, name: str, length: int = 3) -> list[float]:
    if not isinstance(value, list) or len(value) != length:
        raise ToolExecutionError(f"{name} must contain {length} numbers")
    return [_number(item, name) for item in value]


def _required(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ToolExecutionError(f"{name} must be a non-empty string")
    return value


def _authorize(contract: EditContract, *paths: str) -> None:
    for path in paths:
        if not any(path_matches(pattern, path) for pattern in contract.write_set):
            raise PermissionDenied(
                "Operation requires a path outside the contract write set",
                details={"required_path": path, "write_set": contract.write_set},
            )


def _authorize_creation(contract: EditContract, name: str, object_type: str = "MESH") -> str:
    object_id = object_id_for(name, object_type)
    _authorize(contract, f"scene.objects.{object_id}")
    return object_id


def execute_tool(operation: Operation, contract: EditContract) -> dict:
    arguments = operation.arguments
    tool = operation.tool

    if tool == "move_part":
        object_id = _required(arguments.get("object_id"), "object_id")
        axis = arguments.get("axis")
        if axis not in {"x", "y", "z"}:
            raise ToolExecutionError("axis must be x, y or z")
        delta = _number(arguments.get("delta"), "delta")
        _authorize(contract, f"scene.objects.{object_id}.local_transform.location")
        obj = object_by_id(object_id)
        local_axis = Vector(tuple(1.0 if index == "xyz".index(axis) else 0.0 for index in range(3)))
        direction = obj.matrix_world.to_3x3() @ local_axis
        if direction.length < 1e-12:
            raise ToolExecutionError("Target local axis has a singular world transform")
        direction.normalize()
        world_destination = obj.matrix_world.translation + direction * delta
        if obj.parent:
            parent_transform = obj.parent.matrix_world @ obj.matrix_parent_inverse
            obj.location = parent_transform.inverted() @ world_destination
        else:
            obj.location = world_destination
        return {"object_id": object_id}

    if tool == "rotate_part":
        object_id = _required(arguments.get("object_id"), "object_id")
        axis = arguments.get("axis")
        if axis not in ("x", "y", "z"):
            raise ToolExecutionError("axis must be x, y or z")
        angle = math.remainder(_number(arguments.get("angle_deg"), "angle_deg"), 360)
        _authorize(contract, f"scene.objects.{object_id}.local_transform.rotation_euler")
        obj = object_by_id(object_id)
        if obj.rotation_mode in {"QUATERNION", "AXIS_ANGLE"}:
            raise UnsupportedAsset("rotate_part requires an Euler rotation mode")
        if obj.parent and obj.parent_type != "OBJECT":
            raise UnsupportedAsset("rotate_part requires object parenting")
        try:
            world_rotation = Matrix(orthonormal_rotation(obj.matrix_world))
            if angle:
                desired = world_rotation @ Matrix.Rotation(math.radians(angle), 3, axis.upper())
                if obj.parent:
                    parent = (obj.parent.matrix_world @ obj.matrix_parent_inverse).to_3x3()
                    desired = parent.inverted() @ desired
                # QR decomposition after applying the inverse parent preserves the
                # desired world rotation frame, even when the parent is scaled.
                local = Matrix(orthonormal_rotation(desired))
                sx, sy = (math.copysign(1, obj.scale[i] * obj.delta_scale[i]) for i in range(2))
                local = local @ Matrix.Diagonal((sx, sy, sx * sy))
                delta = Euler(obj.delta_rotation_euler, obj.rotation_mode).to_matrix()
                obj.rotation_euler = (delta.transposed() @ local).to_euler(obj.rotation_mode, obj.rotation_euler)
        except ValueError as exc:
            raise UnsupportedAsset("rotate_part requires an invertible world and parent transform") from exc
        return {"object_id": object_id}

    if tool == "set_dimensions":
        object_id = _required(arguments.get("object_id"), "object_id")
        dimensions = _vector(arguments.get("dimensions"), "dimensions")
        if any(value <= 0 for value in dimensions):
            raise ToolExecutionError("All dimensions must be positive")
        _authorize(
            contract,
            f"scene.objects.{object_id}.local_transform.scale",
            f"scene.objects.{object_id}.dimensions",
        )
        obj = object_by_id(object_id)
        if obj.type != "MESH":
            raise UnsupportedAsset("set_dimensions currently supports mesh objects only")
        obj.dimensions = dimensions
        return {"object_id": object_id}

    if tool == "create_box":
        name = _required(arguments.get("name"), "name")
        dimensions = _vector(arguments.get("dimensions"), "dimensions")
        location = _vector(arguments.get("location", [0, 0, 0]), "location")
        if any(value <= 0 for value in dimensions):
            raise ToolExecutionError("All dimensions must be positive")
        if name in bpy.data.objects:
            raise ToolExecutionError(f"An object named {name!r} already exists")
        object_id = _authorize_creation(contract, name)
        geometry = bmesh.new()
        try:
            bmesh.ops.create_cube(geometry, size=1.0, matrix=Matrix.Diagonal((*dimensions, 1.0)))
            mesh = bpy.data.meshes.new(name)
            geometry.to_mesh(mesh)
        finally:
            geometry.free()
        obj = bpy.data.objects.new(name, mesh)
        obj.location = location
        bpy.context.collection.objects.link(obj)
        return {"object_id": object_id, "name": name}

    if tool == "duplicate_part":
        source_id = _required(arguments.get("source_object_id"), "source_object_id")
        name = _required(arguments.get("name"), "name")
        offset = _vector(arguments.get("offset", [0, 0, 0]), "offset")
        include_children = arguments.get("include_children", False)
        if not isinstance(include_children, bool):
            raise ToolExecutionError("include_children must be a boolean")
        child_names = arguments.get("child_names", {})
        if not isinstance(child_names, dict) or not all(
            isinstance(key, str) and isinstance(value, str) and value for key, value in child_names.items()
        ):
            raise ToolExecutionError("child_names must map source object IDs to non-empty names")
        if not include_children and child_names:
            raise ToolExecutionError("child_names requires include_children=true")
        source = object_by_id(source_id)
        descendants = sorted(source.children_recursive, key=lambda item: item.name) if include_children else []
        if {_object_id(item) for item in descendants} != set(child_names):
            raise ToolExecutionError("child_names must cover exactly the source object's descendants")
        if name in bpy.data.objects or any(child_name in bpy.data.objects for child_name in child_names.values()):
            raise ToolExecutionError("A requested duplicate object name already exists")
        if len(set(child_names.values())) != len(child_names) or name in child_names.values():
            raise ToolExecutionError("Duplicate assembly names must be unique")
        for child in descendants:
            if child.type not in {"MESH", "EMPTY"} or not child.users_collection:
                raise UnsupportedAsset("Assembly duplication supports linked Mesh and Empty descendants only")
        object_id = _authorize_creation(contract, name)
        for child in descendants:
            _authorize_creation(contract, child_names[_object_id(child)], child.type)
        if source.type != "MESH" or not source.users_collection:
            raise UnsupportedAsset("duplicate_part currently supports linked mesh objects only")
        duplicates = {}

        def clone(original, parent=None):
            is_root = original == source
            duplicate_name = name if is_root else child_names[_object_id(original)]
            duplicate = original.copy()
            duplicate.name = duplicate_name
            original.users_collection[0].objects.link(duplicate)
            if not is_root:
                duplicate.parent = parent
            duplicate_id = _object_id(duplicate)
            duplicates[_object_id(original)] = duplicate_id
            if is_root:
                duplicate.location += Vector(offset)
            if include_children:
                for child in sorted(original.children, key=lambda item: item.name):
                    clone(child, duplicate)
            return duplicate

        clone(source)
        return {"object_id": object_id, "source_object_id": source_id, "assembly_object_ids": duplicates}

    if tool == "assign_material":
        object_id = _required(arguments.get("object_id"), "object_id")
        material_id = _required(arguments.get("material_id"), "material_id")
        slot_index = arguments.get("slot_index", 0)
        if not isinstance(slot_index, int) or isinstance(slot_index, bool) or slot_index < 0:
            raise ToolExecutionError("slot_index must be a non-negative integer")
        _authorize(contract, f"scene.objects.{object_id}.mesh.material_slot_ids")
        obj = object_by_id(object_id)
        if obj.type != "MESH" or slot_index >= len(obj.material_slots):
            raise ToolExecutionError("Target mesh does not contain the requested material slot")
        material = material_by_id(material_id)
        obj.material_slots[slot_index].link = "OBJECT"
        obj.material_slots[slot_index].material = material
        return {"object_id": object_id, "material_id": material_id}

    if tool == "add_bevel":
        object_id = _required(arguments.get("object_id"), "object_id")
        width = _number(arguments.get("width"), "width")
        segments = arguments.get("segments", 2)
        if width <= 0 or not isinstance(segments, int) or isinstance(segments, bool) or not 1 <= segments <= 16:
            raise ToolExecutionError("Bevel width must be positive and segments must be between 1 and 16")
        _authorize(contract, f"scene.objects.{object_id}.modifiers")
        obj = object_by_id(object_id)
        if obj.type != "MESH":
            raise UnsupportedAsset("add_bevel supports mesh objects only")
        name = _required(arguments.get("name", "BlendGuard Bevel"), "name")
        if name in obj.modifiers:
            raise ToolExecutionError(f"Modifier {name!r} already exists")
        modifier = obj.modifiers.new(name=name, type="BEVEL")
        modifier.width = width
        modifier.segments = segments
        return {"object_id": object_id, "modifier": name}

    if tool == "move_curve_endpoint":
        object_id = _required(arguments.get("object_id"), "object_id")
        end = arguments.get("end")
        if end not in {"start", "end"}:
            raise ToolExecutionError("end must be start or end")
        curve_obj = object_by_id(object_id)
        if curve_obj.type != "CURVE" or len(curve_obj.data.splines) != 1:
            raise UnsupportedAsset("Only single-spline Curve endpoints are supported")
        spline = curve_obj.data.splines[0]
        if spline.type == "BEZIER":
            raise UnsupportedAsset("Bezier endpoint editing is not enabled in v1")
        if len(spline.points) < 2 or curve_obj.data.users > 1:
            raise UnsupportedAsset("Curve needs at least two points and single-user data")
        point_index = 0 if end == "start" else len(spline.points) - 1
        _authorize(contract, f"scene.objects.{object_id}.curve.splines.0.points.{point_index}.co")
        if "target_port_object_id" in arguments:
            target_obj = object_by_id(_required(arguments["target_port_object_id"], "target_port_object_id"))
            world_target = target_obj.matrix_world.translation.copy()
        else:
            world_target = Vector(_vector(arguments.get("world_position"), "world_position"))
        local_target = curve_obj.matrix_world.inverted() @ world_target
        previous = spline.points[point_index].co.copy()
        spline.points[point_index].co = (*local_target, previous[3])
        return {"object_id": object_id, "end": end, "point_index": point_index}

    raise ToolExecutionError(f"No executor registered for {tool}")
