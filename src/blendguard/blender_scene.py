from __future__ import annotations

from array import array
import hashlib
import math
import os
from pathlib import Path
import struct
import sys
from typing import Any

import bpy

try:
    import numpy as np
except ImportError:
    np = None

from .scene_ir import (
    FLOAT_PRECISION, SCENE_IR_VERSION, data_id_for, inside_source_directory, object_id_for, semantic_hash,
)
from .workspace import file_sha256


_MODIFIER_FIELDS = {
    "BEVEL": ("width", "segments", "limit_method"),
    "SOLIDIFY": ("thickness", "offset", "use_even_offset", "use_rim"),
    "ARRAY": (
        "count", "fit_type", "use_relative_offset", "relative_offset_displace",
        "use_constant_offset", "constant_offset_displace", "use_object_offset", "offset_object",
    ),
    "MIRROR": ("use_axis", "use_bisect_axis", "use_bisect_flip_axis", "merge_threshold", "mirror_object"),
    "SUBSURF": ("levels", "render_levels", "subdivision_type"),
    "BOOLEAN": ("operation", "solver", "object"),
    "WEIGHTED_NORMAL": ("mode", "weight", "keep_sharp"),
}
_MODIFIER_OBJECT_FIELDS = {"offset_object", "mirror_object", "object"}
_MODIFIER_VECTOR_FIELDS = {"relative_offset_displace", "constant_offset_displace"}


def _vector(values) -> list[float]:
    return [float(value) for value in values]


def _matrix(matrix) -> list[list[float]]:
    return [_vector(row) for row in matrix]


def _object_id(obj) -> str:
    library = obj.library.filepath if obj.library else ""
    return object_id_for(obj.name, obj.type, library)


def _simple_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "__iter__"):
        try:
            return [_simple_value(item) for item in value]
        except TypeError:
            pass
    return str(value)


def _modifier_ir(modifier) -> dict:
    fields = _MODIFIER_FIELDS.get(modifier.type, ())
    result = {
        "name": modifier.name,
        "type": modifier.type,
        "show_viewport": bool(modifier.show_viewport),
        "show_render": bool(modifier.show_render),
        "parameters_covered": bool(fields),
    }
    for name in fields:
        value = getattr(modifier, name)
        if name in _MODIFIER_OBJECT_FIELDS:
            result[name] = _object_id(value) if value is not None else None
        elif name in _MODIFIER_VECTOR_FIELDS:
            result[name] = _vector(value)
        else:
            result[name] = _simple_value(value)
    return result


def _constraint_ir(constraint) -> dict:
    result = {"name": constraint.name, "type": constraint.type, "parameters_covered": False}
    for name in ["target", "subtarget", "owner_space", "target_space", "influence"]:
        if hasattr(constraint, name):
            value = getattr(constraint, name)
            if name == "target" and value is not None:
                value = _object_id(value)
            result[name] = _simple_value(value)
            result["parameters_covered"] = True
    return result


def _bulk_bytes(collection, field: str, count: int, floating: bool) -> memoryview:
    # Read into native 32-bit RNA buffers before conversion to the hash encoding.
    if np is not None:
        values = np.empty(count, dtype=np.float32 if floating else np.int32)
        if count:
            collection.foreach_get(field, values)
        if floating:
            if not np.isfinite(values).all():
                raise ValueError("Scene IR cannot contain NaN or infinity")
            values = values.astype("<f8")
            np.round(values, FLOAT_PRECISION, out=values)
            values[values == 0] = 0.0
        else:
            values = values.astype("<i4", copy=False)
        return memoryview(values).cast("B")

    values = array("f" if floating else "i", [0]) * count
    if count:
        collection.foreach_get(field, values)
    if floating:
        if not all(map(math.isfinite, values)):
            raise ValueError("Scene IR cannot contain NaN or infinity")
        # Match NumPy's scale, round-to-even and unscale operations.
        scale = 10.0 ** FLOAT_PRECISION
        values = array("d", (round(value * scale) / scale for value in values))
    if values.itemsize != (8 if floating else 4):
        format_code = "<d" if floating else "<i"
        return memoryview(b"".join(struct.pack(format_code, value) for value in values))
    if sys.byteorder != "little":
        values.byteswap()
    return memoryview(values).cast("B")


def _binary_hash(domain: bytes, fields) -> str:
    digest = hashlib.sha256(b"blendguard.scene-ir.binary.v1\0" + domain + b"\0")
    for collection, field, width, floating in fields:
        count = len(collection) * width
        digest.update(struct.pack("<Q", count))
        digest.update(_bulk_bytes(collection, field, count, floating))
    return "sha256:" + digest.hexdigest()


def _uv_layers_ir(mesh) -> list[dict]:
    layers = mesh.uv_layers
    return [
        {
            "name": layer.name,
            "active": index == layers.active_index,
            "active_render": layer.active_render,
            "hash": _binary_hash(b"uv", [(layer.uv, "vector", 2, True)]),
        }
        for index, layer in enumerate(layers)
    ]


def _color_attributes_ir(mesh) -> list[dict]:
    return [
        {
            "name": attribute.name,
            "domain": attribute.domain,
            "data_type": attribute.data_type,
            "hash": _binary_hash(
                b"color", [(attribute.data, "color_srgb" if attribute.data_type == "BYTE_COLOR" else "color", 4, True)],
            ),
        }
        for attribute in mesh.color_attributes
    ]


def _shape_keys_ir(keys) -> dict | None:
    if keys is None:
        return None
    return {
        "use_relative": keys.use_relative,
        "key_blocks": [
            {
                "name": block.name,
                "value": block.value,
                "mute": block.mute,
                "hash": _binary_hash(b"shape-key", [(block.points, "co", 3, True)]),
            }
            for block in keys.key_blocks
        ],
    }


def _mesh_ir(obj) -> dict:
    mesh = obj.data
    return {
        "data_name": mesh.name,
        "vertex_count": len(mesh.vertices),
        "edge_count": len(mesh.edges),
        "face_count": len(mesh.polygons),
        "geometry_hash": _binary_hash(b"mesh-geometry", [
            (mesh.vertices, "co", 3, True),
            (mesh.edges, "vertices", 2, False),
            (mesh.polygons, "loop_total", 1, False),
            (mesh.polygons, "loop_start", 1, False),
            (mesh.polygons, "material_index", 1, False),
            (mesh.loops, "vertex_index", 1, False),
        ]),
        "material_slot_ids": [
            data_id_for("mat", slot.material.name) if slot.material else None
            for slot in obj.material_slots
        ],
        "uv_layers": _uv_layers_ir(mesh),
        "color_attributes": _color_attributes_ir(mesh),
        "shape_keys": _shape_keys_ir(mesh.shape_keys),
    }


def _curve_ir(obj) -> dict | None:
    if obj.type != "CURVE":
        return None
    splines = []
    unsupported = False
    world_endpoints = {}
    for spline_index, spline in enumerate(obj.data.splines):
        if spline.type == "BEZIER":
            points = [
                {
                    "co": _vector(point.co),
                    "handle_left": _vector(point.handle_left),
                    "handle_right": _vector(point.handle_right),
                }
                for point in spline.bezier_points
            ]
            local_endpoints = {
                "start": points[0]["co"][:3],
                "end": points[-1]["co"][:3],
            }
            unsupported = True
        else:
            points = [{"co": _vector(point.co)} for point in spline.points]
            local_endpoints = {
                "start": points[0]["co"][:3],
                "end": points[-1]["co"][:3],
            }
        splines.append({"type": spline.type, "points": points})
        if spline_index == 0:
            for end, point in local_endpoints.items():
                world = obj.matrix_world @ __import__("mathutils").Vector(point)
                world_endpoints[end] = _vector(world)
    return {
        "data_name": obj.data.name,
        "splines": splines,
        "world_endpoints": world_endpoints,
        "endpoint_editing_supported": len(splines) == 1 and not unsupported,
    }


def _fcurves_ir(fcurves) -> list[dict]:
    return [
        {
            "data_path": curve.data_path,
            "array_index": curve.array_index,
            "keyframes": [
                (_vector(key.co), _vector(key.handle_left), _vector(key.handle_right), key.interpolation)
                for key in curve.keyframe_points
            ],
        }
        for curve in fcurves
    ]


def _action_fcurves_hash(animation) -> str:
    action = animation.action
    if getattr(action, "is_action_layered", False):
        # The legacy accessor exposes only the first slot of a layered action.
        layers = [
            [
                [
                    {"slot_handle": bag.slot_handle, "fcurves": _fcurves_ir(bag.fcurves)}
                    for bag in getattr(strip, "channelbags", ())
                ]
                for strip in layer.strips
            ]
            for layer in action.layers
        ]
        return semantic_hash({"layers": layers, "action_slot_handle": animation.action_slot_handle})
    return semantic_hash({"fcurves": _fcurves_ir(action.fcurves)})


def _animation_ir(obj) -> dict:
    animation = obj.animation_data
    if not animation:
        return {"action": None, "drivers_covered": True}
    result = {
        "action": animation.action.name if animation.action else None,
        "drivers_covered": len(animation.drivers) == 0,
        "driver_count": len(animation.drivers),
    }
    if animation.action is not None:
        result["fcurves_hash"] = _action_fcurves_hash(animation)
    return result


def _material_ir(material) -> dict:
    result = {
        "name": material.name,
        "use_nodes": bool(material.use_nodes),
        "node_tree_covered": bool(material.use_nodes),
    }
    if material.use_nodes and material.node_tree:
        nodes = []
        for node in material.node_tree.nodes:
            inputs = []
            for socket in node.inputs:
                inputs.append(
                    {
                        "name": socket.name,
                        "default_value": _simple_value(getattr(socket, "default_value", None)),
                    }
                )
            nodes.append({"name": node.name, "type": node.bl_idname, "inputs": inputs})
        links = [
            {
                "from_node": link.from_node.name,
                "from_socket": link.from_socket.name,
                "to_node": link.to_node.name,
                "to_socket": link.to_socket.name,
            }
            for link in material.node_tree.links
        ]
        result["nodes"] = nodes
        result["links"] = links
    return result


def inspect_scene() -> dict:
    bpy.context.view_layer.update()
    records = sorted(bpy.context.scene.objects, key=lambda obj: (obj.type, obj.name))
    objects = {}
    coverage = []
    for obj in records:
        object_id = _object_id(obj)
        record = {
            "name": obj.name,
            "type": obj.type,
            "parent_id": _object_id(obj.parent) if obj.parent else None,
            "collection_names": sorted(collection.name for collection in obj.users_collection),
            "local_transform": {
                "location": _vector(obj.location),
                "rotation_euler": _vector(obj.rotation_euler),
                "scale": _vector(obj.scale),
            },
            "world_matrix": _matrix(obj.matrix_world),
            "matrix_parent_inverse": _matrix(obj.matrix_parent_inverse),
            "dimensions": _vector(obj.dimensions),
            "modifiers": [_modifier_ir(modifier) for modifier in obj.modifiers],
            "constraints": [_constraint_ir(constraint) for constraint in obj.constraints],
            "animation": _animation_ir(obj),
            "mesh": _mesh_ir(obj) if obj.type == "MESH" else None,
            "curve": _curve_ir(obj),
        }
        if obj.type == "CAMERA":
            record["camera"] = {"lens": float(obj.data.lens), "clip_start": float(obj.data.clip_start), "clip_end": float(obj.data.clip_end)}
        if obj.type == "LIGHT":
            record["light"] = {"type": obj.data.type, "energy": float(obj.data.energy), "color": _vector(obj.data.color)}
        objects[object_id] = record
        for modifier in record["modifiers"]:
            if not modifier["parameters_covered"]:
                coverage.append(f"Modifier parameters are only partially covered: {modifier['type']}")
        if not record["animation"]["drivers_covered"]:
            coverage.append(f"Drivers are not fully covered on object: {obj.name}")

    materials = {
        data_id_for("mat", material.name): _material_ir(material)
        for material in sorted(bpy.data.materials, key=lambda item: item.name)
    }
    images = {}
    for image in sorted(bpy.data.images, key=lambda item: item.name):
        path = bpy.path.abspath(image.filepath) if image.filepath else ""
        normalized = os.path.normcase(os.path.normpath(path)) if path else ""
        allowed_to_read = bool(bpy.data.filepath) and inside_source_directory(Path(bpy.data.filepath).parent, path)
        exists = allowed_to_read and Path(path).is_file()
        images[image.name] = {
            "path": normalized,
            "exists": exists if allowed_to_read else None,
            "packed": bool(image.packed_file),
            "sha256": file_sha256(Path(path)) if exists else None,
            "hash_scope": "source_directory" if allowed_to_read else "not_read",
        }
        if path and not allowed_to_read:
            coverage.append(f"External image was not read outside the source directory: {image.name}")

    return {
        "scene_ir_version": SCENE_IR_VERSION,
        "blender_version": bpy.app.version_string,
        "unit_settings": {
            "system": bpy.context.scene.unit_settings.system,
            "scale_length": float(bpy.context.scene.unit_settings.scale_length),
        },
        "objects": objects,
        "materials": materials,
        "images": images,
        "world": bpy.context.scene.world.name if bpy.context.scene.world else None,
        "coverage_notes": sorted(set(coverage)),
    }


def object_by_id(object_id: str):
    for obj in bpy.context.scene.objects:
        if _object_id(obj) == object_id:
            return obj
    raise KeyError(f"Unknown object ID: {object_id}")


def material_by_id(material_id: str):
    for material in bpy.data.materials:
        if data_id_for("mat", material.name) == material_id:
            return material
    raise KeyError(f"Unknown material ID: {material_id}")
