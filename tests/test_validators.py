import copy
import math
import unittest

from blendguard.contracts import EditContract
from blendguard.errors import ContractError
from blendguard.validators import validate_constraints


def scene():
    return {
        "objects": {
            "server": {
                "local_transform": {"location": [0, 0, 1]},
                "dimensions": [1, 2, 3],
                "world_matrix": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]],
            },
            "port": {
                "world_matrix": [[1, 0, 0, 0.2], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]],
            },
            "cable": {
                "curve": {"world_endpoints": {"start": [0, 0, 0], "end": [0.2, 0, 1]}},
            },
        }
    }


def edit(constraints):
    return EditContract.from_dict({
        "run_id": "run",
        "source_sha256": "c" * 64,
        "instruction": "test",
        "targets": ["server"],
        "write_set": [],
        "constraints": constraints,
    })


class ValidatorTests(unittest.TestCase):
    def test_rotation_uses_pre_rotated_scaled_world_frame(self):
        before, after = scene(), scene()
        before["objects"]["server"]["world_matrix"] = [
            [0, -3, 0, 0], [2, 0, 0, 0], [0, 0, 4, 1], [0, 0, 0, 1],
        ]
        c, s = math.cos(math.radians(-35)), math.sin(math.radians(-35))
        after["objects"]["server"]["world_matrix"] = [
            [0, -3*c, 4*s, 0], [2, 0, 0, 0], [0, 3*s, 4*c, 1], [0, 0, 0, 1],
        ]
        constraint = {"type": "rotation_delta", "target": "server", "axis": "x", "angle_deg": 325}
        report = validate_constraints(before, after, edit([constraint]))
        self.assertEqual(report["status"], "passed")
        self.assertAlmostEqual(report["checks"][0]["measured"], -35)
        for mismatch in [{"angle_deg": 35}, {"axis": "z", "angle_deg": 0}]:
            with self.subTest(mismatch=mismatch):
                self.assertEqual(validate_constraints(before, after, edit([constraint | mismatch]))["status"], "failed")
        after["objects"]["server"]["world_matrix"][1][0] = 0
        self.assertEqual(validate_constraints(before, after, edit([constraint]))["status"], "failed")

    def test_rotation_constraint_validates_shape_and_finite_values(self):
        constraint = {"type": "rotation_delta", "target": "server", "axis": "z", "angle_deg": 360}
        edit([constraint]).validate()
        self.assertEqual(validate_constraints(scene(), scene(), edit([constraint]))["status"], "passed")
        for invalid in [
            {"target": ""}, {"axis": "Z"}, {"angle_deg": float("nan")},
            {"angle_deg": True}, {"angle_deg": 10**400}, {"tolerance_deg": -1}, {"tolerance_deg": float("inf")},
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(ContractError):
                edit([constraint | invalid]).validate()

    def test_all_constraints_pass(self):
        before = scene()
        after = copy.deepcopy(before)
        after["objects"]["server"]["local_transform"]["location"][2] = 0.9
        after["objects"]["server"]["world_matrix"][2][3] = 0.9
        constraints = [
            {"type": "translation_delta", "target": "server", "axis": "z", "delta": -0.1, "tolerance": 0.0001},
            {"type": "dimensions_unchanged", "target": "server"},
            {"type": "object_count_unchanged"},
            {"type": "endpoint_distance", "endpoint": "cable:end", "target_port": "port", "max_distance": 0.001},
        ]
        report = validate_constraints(before, after, edit(constraints))
        self.assertEqual(report["status"], "passed")

    def test_wrong_delta_fails_with_measured_value(self):
        before = scene()
        after = copy.deepcopy(before)
        after["objects"]["server"]["local_transform"]["location"][2] = 0.5
        after["objects"]["server"]["world_matrix"][2][3] = 0.5
        constraints = [{"type": "translation_delta", "target": "server", "axis": "z", "delta": -0.1}]
        report = validate_constraints(before, after, edit(constraints))
        self.assertEqual(report["status"], "failed")
        self.assertAlmostEqual(report["checks"][0]["measured"], -0.5)
    def test_translation_delta_uses_original_target_local_axis(self):
        before = scene()
        before["objects"]["server"]["world_matrix"] = [
            [0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1],
        ]
        after = copy.deepcopy(before)
        after["objects"]["server"]["world_matrix"][1][3] = 0.1
        constraint = {"type": "translation_delta", "target": "server", "axis": "x", "delta": 0.1}
        self.assertEqual(validate_constraints(before, after, edit([constraint]))["status"], "passed")
        after["objects"]["server"]["world_matrix"][0][3] = 0.2
        self.assertEqual(validate_constraints(before, after, edit([constraint]))["status"], "failed")
        after["objects"]["server"]["world_matrix"][1][3] = 0.0
        after["objects"]["server"]["world_matrix"][0][3] = 0.1
        self.assertEqual(validate_constraints(before, after, edit([constraint]))["status"], "failed")

    def test_material_slot_constraint_rejects_valid_but_wrong_material(self):
        before = scene()
        before["objects"]["server"]["mesh"] = {"material_slot_ids": ["mat_old"]}
        after = copy.deepcopy(before)
        after["objects"]["server"]["mesh"]["material_slot_ids"] = ["mat_requested"]
        constraint = {"type": "material_slot", "target": "server", "slot_index": 0, "material_id": "mat_requested"}
        self.assertEqual(validate_constraints(before, after, edit([constraint]))["status"], "passed")
        after["objects"]["server"]["mesh"]["material_slot_ids"] = ["mat_other"]
        self.assertEqual(validate_constraints(before, after, edit([constraint]))["status"], "failed")

    def test_agent_goal_constraints_pass_and_reject_wrong_results(self):
        before = scene()
        before["objects"]["server"]["modifiers"] = []
        after = copy.deepcopy(before)
        after["objects"]["server"]["dimensions"] = [0.5, 2, 3]
        after["objects"]["server"]["world_matrix"][0][3] = 0.8
        after["objects"]["server"]["modifiers"] = [{
            "name": "Agent Bevel", "type": "BEVEL", "width": 0.002, "segments": 2,
        }]
        after["objects"]["new_server"] = copy.deepcopy(after["objects"]["server"])
        constraints = [
            {"type": "dimensions_equal", "target": "server", "dimensions": [0.5, 2, 3]},
            {"type": "object_location", "target": "server", "location": [0.8, 0, 1]},
            {"type": "object_count_delta", "delta": 1},
            {"type": "bevel_present", "target": "server", "modifier": "Agent Bevel", "width": 0.002, "segments": 2},
        ]
        passed = validate_constraints(before, after, edit(constraints))
        self.assertEqual(passed["status"], "passed")
        after["objects"]["server"]["dimensions"][0] = 0.6
        after["objects"]["server"]["modifiers"][0]["width"] = 0.01
        failed = validate_constraints(before, after, edit(constraints))
        self.assertEqual(failed["status"], "failed")
        self.assertEqual([item["status"] for item in failed["checks"]].count("failed"), 2)


if __name__ == "__main__":
    unittest.main()
