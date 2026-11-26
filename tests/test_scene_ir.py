import copy
import unittest

from blendguard.contracts import EditContract
from blendguard.scene_ir import (
    classify_differences,
    descendants_of,
    diff_values,
    object_id_for,
    path_matches,
    semantic_hash,
)


def scene():
    return {
        "scene_ir_version": "1.0",
        "objects": {
            "obj_server": {
                "name": "server_03",
                "parent_id": None,
                "local_transform": {"location": [0.0, 0.0, 1.0]},
                "world_matrix": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]],
            },
            "obj_port": {
                "name": "port",
                "parent_id": "obj_server",
                "local_transform": {"location": [0.2, 0.0, 0.0]},
                "world_matrix": [[1, 0, 0, 0.2], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]],
            },
            "obj_camera": {"name": "Camera", "parent_id": None},
        },
    }


def contract(write_set, derived=None):
    return EditContract.from_dict({
        "run_id": "run-test",
        "source_sha256": "b" * 64,
        "instruction": "test",
        "targets": ["obj_server"],
        "write_set": write_set,
        "derived_allowances": derived or [],
    })


class SceneIRTests(unittest.TestCase):
    def test_stable_object_id(self):
        self.assertEqual(object_id_for("server_03"), object_id_for("server_03"))
        self.assertNotEqual(object_id_for("server_03"), object_id_for("server_04"))

    def test_noop_has_no_differences(self):
        self.assertEqual(diff_values(scene(), copy.deepcopy(scene())), [])
        self.assertEqual(semantic_hash(scene()), semantic_hash(copy.deepcopy(scene())))

    def test_authorized_parent_and_derived_child_change(self):
        before = scene()
        after = copy.deepcopy(before)
        after["objects"]["obj_server"]["local_transform"]["location"][2] = 0.9
        after["objects"]["obj_server"]["world_matrix"][2][3] = 0.9
        after["objects"]["obj_port"]["world_matrix"][2][3] = 0.9
        edit = contract(
            [
                "scene.objects.obj_server.local_transform.location",
                "scene.objects.obj_server.world_matrix",
            ],
            [{"relation": "children_world_transform", "root_object_id": "obj_server"}],
        )
        report = classify_differences(before, after, edit)
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["unauthorized_changes"], [])
        self.assertEqual(descendants_of(before, "obj_server"), {"obj_port"})

    def test_unauthorized_camera_change_is_rejected(self):
        before = scene()
        after = copy.deepcopy(before)
        after["objects"]["obj_camera"]["name"] = "Changed"
        report = classify_differences(before, after, contract([]))
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["unauthorized_changes"][0]["path"], "scene.objects.obj_camera.name")

    def test_transform_permission_does_not_allow_mesh_modifier_or_animation_edits(self):
        before = scene()
        server = before["objects"]["obj_server"]
        server["mesh"] = {
            "uv_layers": [{"hash": semantic_hash([0.0, 0.0])}],
            "shape_keys": {"key_blocks": [{"value": 0.0, "hash": semantic_hash([0, 0, 0])}]},
        }
        server["modifiers"] = [
            {"type": "SOLIDIFY", "thickness": 0.01},
            {"type": "MIRROR", "merge_threshold": 0.001},
            {"type": "ARRAY", "relative_offset_displace": [1.0, 0.0, 0.0]},
            {"type": "SUBSURF", "levels": 1},
        ]
        server["animation"] = {"fcurves_hash": semantic_hash([1, 0])}
        after = copy.deepcopy(before)
        updated = after["objects"]["obj_server"]
        updated["local_transform"]["location"][0] = 0.5
        updated["mesh"]["uv_layers"][0]["hash"] = semantic_hash([0.5, 0.0])
        updated["mesh"]["shape_keys"]["key_blocks"][0].update(value=0.5, hash=semantic_hash([0, 0, 1]))
        updated["modifiers"][0]["thickness"] = 0.02
        updated["modifiers"][1]["merge_threshold"] = 0.002
        updated["modifiers"][2]["relative_offset_displace"][0] = 1.00001
        updated["modifiers"][3]["levels"] = 2
        updated["animation"]["fcurves_hash"] = semantic_hash([1, 1])

        prefix = "scene.objects.obj_server"
        report = classify_differences(before, after, contract([f"{prefix}.local_transform.location"]))
        self.assertEqual(report["status"], "failed")
        self.assertEqual(len(report["authorized_changes"]), 1)
        self.assertEqual({(item["path"], item["classification"]) for item in report["unauthorized_changes"]}, {
            (f"{prefix}.{field}", "UNAUTHORIZED") for field in (
                "mesh.uv_layers.0.hash", "mesh.shape_keys.key_blocks.0.value", "mesh.shape_keys.key_blocks.0.hash",
                "modifiers.0.thickness", "modifiers.1.merge_threshold", "modifiers.2.relative_offset_displace.0",
                "modifiers.3.levels", "animation.fcurves_hash",
            )
        })

    def test_world_matrix_is_implied_by_local_transform_write(self):
        before = scene()
        after = copy.deepcopy(before)
        after["objects"]["obj_server"]["local_transform"]["location"][2] = 0.9
        after["objects"]["obj_server"]["world_matrix"][2][3] = 0.9
        report = classify_differences(
            before,
            after,
            contract(["scene.objects.obj_server.local_transform.location"]),
        )
        self.assertEqual(report["status"], "passed")
        classifications = {item["classification"] for item in report["authorized_changes"]}
        self.assertIn("DERIVED_AUTHORIZED", classifications)

    def test_rotation_dimension_roundoff_is_local_and_bounded(self):
        before = scene()
        for record in before["objects"].values():
            record["dimensions"] = [1.0, 2.0, 3.0]
        after = copy.deepcopy(before)
        for object_id in ["obj_server", "obj_port"]:
            after["objects"][object_id]["world_matrix"][:2] = [[0, -1, 0, 0], [1, 0, 0, 0]]
            after["objects"][object_id]["dimensions"][0] += 1e-7
        edit = contract(
            ["scene.objects.obj_server.local_transform.rotation_euler"],
            [{"relation": "children_world_transform", "root_object_id": "obj_server"}],
        )
        self.assertEqual(classify_differences(before, after, edit)["status"], "passed")
        after["objects"]["obj_camera"]["dimensions"][0] += 1e-7
        after["objects"]["obj_port"]["dimensions"][0] += 0.001
        changes = classify_differences(before, after, edit)["unauthorized_changes"]
        self.assertEqual({item["path"] for item in changes}, {
            "scene.objects.obj_camera.dimensions.0", "scene.objects.obj_port.dimensions.0",
        })

    def test_curve_endpoint_write_allows_world_endpoint_and_dimensions(self):
        before = {
            "objects": {
                "obj_cable": {
                    "dimensions": [1.0, 0.0, 0.5],
                    "curve": {
                        "splines": [{"points": [{"co": [0, 0, 0, 1]}, {"co": [0, 0, 0.5, 1]}]}],
                        "world_endpoints": {"end": [0, 0, 0.5]},
                    },
                }
            }
        }
        after = copy.deepcopy(before)
        after["objects"]["obj_cable"]["dimensions"][2] = 0.4
        after["objects"]["obj_cable"]["curve"]["splines"][0]["points"][1]["co"][2] = 0.4
        after["objects"]["obj_cable"]["curve"]["world_endpoints"]["end"][2] = 0.4
        report = classify_differences(
            before,
            after,
            contract(["scene.objects.obj_cable.curve.splines.0.points.1.co"]),
        )
        self.assertEqual(report["status"], "passed")

    def test_parent_scale_explicitly_allows_child_world_matrix_and_dimensions(self):
        before = scene()
        before["objects"]["obj_port"]["dimensions"] = [0.1, 0.1, 0.1]
        after = copy.deepcopy(before)
        after["objects"]["obj_server"]["local_transform"]["scale"] = [2, 1, 1]
        after["objects"]["obj_port"]["world_matrix"][0][0] = 2
        after["objects"]["obj_port"]["dimensions"][0] = 0.2
        edit = contract(
            ["scene.objects.obj_server.local_transform.scale"],
            [{"relation": "children_world_geometry", "root_object_id": "obj_server"}],
        )
        report = classify_differences(before, after, edit)
        self.assertEqual(report["status"], "passed")
        transform_only = contract(
            ["scene.objects.obj_server.local_transform.scale"],
            [{"relation": "children_world_transform", "root_object_id": "obj_server"}],
        )
        self.assertEqual(classify_differences(before, after, transform_only)["status"], "failed")

    def test_write_path_covers_descendants_not_siblings(self):
        self.assertTrue(path_matches("scene.objects.obj.location", "scene.objects.obj.location.2"))
        self.assertFalse(path_matches("scene.objects.obj.location", "scene.objects.obj.scale.2"))
        self.assertTrue(path_matches("scene.objects.*.modifiers", "scene.objects.obj.modifiers"))


if __name__ == "__main__":
    unittest.main()
