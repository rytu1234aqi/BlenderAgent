"""Scene IR checks run inside Blender by test_blender_integration.py."""

from pathlib import Path
import sys
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import patch

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blendguard import blender_runner, blender_scene
from blendguard.scene_ir import object_id_for
from blendguard.workspace import file_sha256


def check_legacy_fcurves():
    # Blender 4.4 upgrades legacy actions on load, so exercise the old RNA shape directly.
    key = SimpleNamespace(co=(1.0, 0.0), handle_left=(0.5, 0.0), handle_right=(1.5, 0.0), interpolation="BEZIER")
    curve = SimpleNamespace(data_path="location", array_index=2, keyframe_points=[key])
    action = SimpleNamespace(name="Legacy", fcurves=[curve])
    obj = SimpleNamespace(animation_data=SimpleNamespace(action=action, drivers=[]))

    def digest():
        return blender_scene._animation_ir(obj)["fcurves_hash"]

    before = digest()
    key.co = (1.0, -1e-11)
    assert digest() == before
    for record, field, value in (
        (key, "co", (1.0, 0.1)),
        (key, "handle_left", (0.25, 0.0)),
        (key, "handle_right", (1.75, 0.0)),
        (key, "interpolation", "LINEAR"),
        (curve, "data_path", "scale"),
        (curve, "array_index", 1),
    ):
        with patch.object(record, field, value):
            assert digest() != before, field


def check_high_poly():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=256, y_subdivisions=256)
    obj = bpy.context.object
    mesh = obj.data
    mesh.materials.append(bpy.data.materials.new("First"))
    mesh.materials.append(bpy.data.materials.new("Second"))
    assert len(mesh.vertices) >= 50_000
    object_id = object_id_for(obj.name)

    def inspect_mesh():
        start = perf_counter()
        result = blender_scene.inspect_scene()["objects"][object_id]["mesh"]
        return result, perf_counter() - start

    assert blender_scene.np is not None
    before, first_time = inspect_mesh()
    repeated, second_time = inspect_mesh()
    print(f"High-poly mesh ({len(mesh.vertices):,} vertices): {first_time:.3f}s, {second_time:.3f}s", flush=True)
    assert max(first_time, second_time) < 2.0
    assert before == repeated

    with patch.object(blender_scene, "np", None):
        assert inspect_mesh()[0] == before

    mesh.vertices[0].co.z = -0.0
    assert inspect_mesh()[0]["geometry_hash"] == before["geometry_hash"]
    mesh.vertices[0].co.z = 1e-5
    assert inspect_mesh()[0]["geometry_hash"] != before["geometry_hash"]
    mesh.vertices[0].co.z = 0.0
    assert inspect_mesh()[0]["geometry_hash"] == before["geometry_hash"]

    mesh.polygons[0].material_index = 1
    assert inspect_mesh()[0]["geometry_hash"] != before["geometry_hash"]
    mesh.polygons[0].material_index = 0
    assert inspect_mesh()[0]["geometry_hash"] == before["geometry_hash"]

    mesh.vertices[0].co.z = float("nan")
    for numpy in (blender_scene.np, None):
        with patch.object(blender_scene, "np", numpy):
            try:
                inspect_mesh()
            except ValueError as error:
                assert str(error) == "Scene IR cannot contain NaN or infinity"
            else:
                raise AssertionError("Mesh inspection accepted NaN")


def check_coverage_and_rollback(root):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add()
    obj = bpy.context.object
    mesh = obj.data
    mesh.uv_layers.new(name="Secondary UV")
    mesh.uv_layers.active_index = 1
    mesh.color_attributes.new(name="Float", type="FLOAT_COLOR", domain="POINT")
    mesh.color_attributes.new(name="Byte", type="BYTE_COLOR", domain="CORNER")
    obj.shape_key_add(name="Basis")
    obj.shape_key_add(name="Deform")
    modifier_types = ("SOLIDIFY", "MIRROR", "ARRAY", "SUBSURF", "BOOLEAN", "WEIGHTED_NORMAL", "NODES")
    reference = bpy.data.objects.new("Reference", None)
    bpy.context.collection.objects.link(reference)
    for kind in modifier_types:
        modifier = obj.modifiers.new(kind, kind)
        modifier.show_viewport = False
        modifier.show_render = False
    obj.modifiers["MIRROR"].mirror_object = reference
    obj.modifiers["ARRAY"].offset_object = reference
    obj.driver_add("scale", 2)

    # The cube uses the second slot, which action.fcurves cannot see in Blender 4.4.
    action = bpy.data.actions.new("Two Slots")
    first_slot = action.slots.new(id_type="OBJECT", name="First")
    second_slot = action.slots.new(id_type="OBJECT", name="Second")
    strip = action.layers.new("Keys").strips.new(type="KEYFRAME")
    for slot in (first_slot, second_slot):
        curve = strip.channelbag(slot, ensure=True).fcurves.new("location", index=2)
        curve.keyframe_points.insert(1, 0)
        curve.keyframe_points.insert(20, 0.5)
    obj.animation_data.action = action
    obj.animation_data.action_slot = second_slot
    slot_handle = second_slot.handle

    source = root / "coverage.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    source_hash = file_sha256(source)
    object_id = object_id_for(obj.name)
    reference_id = object_id_for(reference.name, "EMPTY")
    scene = blender_scene.inspect_scene()
    record = scene["objects"][object_id]
    uv_layers = record["mesh"]["uv_layers"]
    assert [layer["active"] for layer in uv_layers] == [False, True]
    assert [layer["active_render"] for layer in uv_layers] == [True, False]
    assert record["mesh"]["shape_keys"]["use_relative"]
    modifiers = {modifier["type"]: modifier for modifier in record["modifiers"]}
    assert all(modifiers[kind]["parameters_covered"] for kind in modifier_types[:-1])
    assert modifiers["MIRROR"]["mirror_object"] == reference_id
    assert modifiers["ARRAY"]["offset_object"] == reference_id
    assert modifiers["BOOLEAN"]["object"] is None
    assert not modifiers["NODES"]["parameters_covered"]
    assert any("NODES" in note for note in scene["coverage_notes"])
    assert record["animation"]["driver_count"] == 1
    assert not record["animation"]["drivers_covered"]

    def edit_keyframe(target):
        strip = target.animation_data.action.layers[0].strips[0]
        bag = next(bag for bag in strip.channelbags if bag.slot_handle == slot_handle)
        bag.fcurves[0].keyframe_points[1].co.y += 0.1

    edits = {
        "uv": ("mesh.uv_layers.0.hash", lambda o: setattr(o.data.uv_layers[0].uv[0].vector, "x", 0.123)),
        "float_color": ("mesh.color_attributes.0.hash", lambda o: setattr(
            o.data.color_attributes["Float"].data[0], "color", (0.2, 0.3, 0.4, 1.0),
        )),
        "byte_color": ("mesh.color_attributes.1.hash", lambda o: setattr(
            o.data.color_attributes["Byte"].data[0], "color_srgb", (0.2, 0.3, 0.4, 1.0),
        )),
        "solidify": ("modifiers.0.thickness", lambda o: setattr(o.modifiers["SOLIDIFY"], "thickness", 0.25)),
        "mirror": ("modifiers.1.merge_threshold", lambda o: setattr(o.modifiers["MIRROR"], "merge_threshold", 0.02)),
        "array": ("modifiers.2.relative_offset_displace.0", lambda o: setattr(
            o.modifiers["ARRAY"].relative_offset_displace, "x", 1.00001,
        )),
        "subsurf": ("modifiers.3.levels", lambda o: setattr(o.modifiers["SUBSURF"], "levels", 3)),
        "shape_value": ("mesh.shape_keys.key_blocks.1.value", lambda o: setattr(
            o.data.shape_keys.key_blocks["Deform"], "value", 0.75,
        )),
        "shape_vertex": ("mesh.shape_keys.key_blocks.1.hash", lambda o: setattr(
            o.data.shape_keys.key_blocks["Deform"].points[0].co, "x", 0.123,
        )),
        "keyframe": ("animation.fcurves_hash", edit_keyframe),
    }
    # Inject a single tool side effect per run while using the real runner and checkpoint.
    for name, (expected_path, mutate) in edits.items():
        run_dir = root / name
        request = {
            "source_file": str(source),
            "run_dir": str(run_dir),
            "contract": {
                "run_id": name,
                "source_sha256": source_hash,
                "instruction": "Move the reference object",
                "targets": [reference_id],
                "write_set": [f"scene.objects.{reference_id}.local_transform.location"],
            },
            "operations": [{
                "tool": "move_part",
                "arguments": {"object_id": reference_id, "axis": "x", "delta": 0.1},
            }],
        }
        with patch.object(blender_runner, "_inject_fault") as inject:
            inject.side_effect = lambda *_: mutate(blender_scene.object_by_id(object_id))
            result = blender_runner.execute_request(request)
        assert result["status"] == "ROLLED_BACK", (name, result)
        assert result["rollback"]["status"] == "passed", (name, result)
        assert result["rollback"]["differences"] == [], (name, result)
        assert any(
            change["path"] == f"scene.objects.{object_id}.{expected_path}"
            and change["classification"] == "UNAUTHORIZED"
            for change in result["locality"]["unauthorized_changes"]
        ), (name, result)
        assert not (run_dir / "delivery" / "output.blend").exists(), name
    assert file_sha256(source) == source_hash


if __name__ == "__main__":
    check, directory = sys.argv[sys.argv.index("--") + 1:]
    if check == "high_poly":
        check_high_poly()
    else:
        assert check == "coverage"
        check_legacy_fcurves()
        check_coverage_and_rollback(Path(directory))
