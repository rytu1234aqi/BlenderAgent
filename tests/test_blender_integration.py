import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

from blendguard.scene_ir import data_id_for, object_id_for
from blendguard.workspace import file_sha256, write_json


BLENDER = os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")
PROJECT = Path(__file__).resolve().parents[1]
SRC = PROJECT / "src"


@unittest.skipUnless(BLENDER, "Blender is not installed or BLENDER_EXECUTABLE is not set")
class BlenderSceneCoverageTests(unittest.TestCase):
    def run_scene_check(self, name):
        with tempfile.TemporaryDirectory() as directory:
            try:
                completed = subprocess.run(
                    [
                        str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
                        "--python-exit-code", "1", "--python", str(PROJECT / "tests" / "blender_scene_checks.py"),
                        "--", name, directory,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self.assertEqual(completed.returncode, 0, f"{completed.stdout}\n{completed.stderr}")
            finally:
                for path in Path(directory).rglob("source.blend"):
                    path.chmod(stat.S_IWRITE)

    def test_high_poly_mesh_hash_is_fast_deterministic_and_sensitive_to_edits(self):
        self.run_scene_check("high_poly")

    def test_unauthorized_mesh_modifier_and_keyframe_edits_roll_back(self):
        self.run_scene_check("coverage")


@unittest.skipUnless(BLENDER, "Blender is not installed or BLENDER_EXECUTABLE is not set")
class BlenderIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "rack.blend"
        subprocess.run(
            [
                str(Path(BLENDER).resolve()),
                "--background",
                "--factory-startup",
                "--disable-autoexec",
                "--python",
                str(PROJECT / "tests" / "blender_fixture.py"),
                "--",
                str(self.source),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=90,
        )

    def tearDown(self):
        for path in self.root.rglob("source.blend"):
            if path.exists():
                path.chmod(stat.S_IWRITE)
        self.temporary.cleanup()

    def blender_command(self, module, arguments):
        expression = f"import sys; sys.path.insert(0, {str(SRC)!r}); from {module} import main; main()"
        return [
            str(Path(BLENDER).resolve()),
            "--background",
            "--factory-startup",
            "--disable-autoexec",
            "--python-expr",
            expression,
            "--",
            *arguments,
        ]

    def run_request(
        self,
        name,
        operations,
        write_set,
        constraints=None,
        export=False,
        fault_injection=None,
    ):
        run_dir = self.root / name
        request = {
            "source_file": str(self.source),
            "run_dir": str(run_dir),
            "contract": {
                "run_id": name,
                "source_sha256": file_sha256(self.source),
                "instruction": "Execute the authorized integration-test plan",
                "targets": [object_id_for("server_03")],
                "write_set": write_set,
                "derived_allowances": [
                    {"relation": "children_world_transform", "root_object_id": object_id_for("server_03")}
                ],
                "constraints": constraints or [],
                "retry_budget": 0,
                "export": {"enabled": export, "profile": "ict_teaching_glb_v1"},
            },
            "operations": operations,
        }
        if fault_injection:
            request["fault_injection"] = fault_injection
        request_path = self.root / f"{name}.json"
        write_json(request_path, request)
        result_path = run_dir / "result.json"
        completed = subprocess.run(
            self.blender_command(
                "blendguard.blender_runner",
                ["--request", str(request_path), "--result", str(result_path)],
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if not result_path.exists() and (run_dir / "reports" / "result.json").is_file():
            result_path = run_dir / "reports" / "result.json"
        if not result_path.exists():
            self.fail(f"Runner did not write a result:\nSTDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}")
        return completed, json.loads(result_path.read_text(encoding="utf-8"))

    def verify_run(self, name):
        run_dir = self.root / name
        result_path = run_dir / "reports" / "independent_verification.json"
        completed = subprocess.run(
            self.blender_command(
                "blendguard.verifier",
                ["--run-dir", str(run_dir), "--result", str(result_path)],
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if not result_path.exists():
            self.fail(f"Verifier did not write a result:\nSTDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}")
        return completed, json.loads(result_path.read_text(encoding="utf-8"))

    def move_case(self, name, export=False, fault_injection=None):
        server = object_id_for("server_03")
        port = object_id_for("server_03_port", "EMPTY")
        cable = object_id_for("cable_07", "CURVE")
        return self.run_request(
            name,
            [
                {"operation_id": "move", "tool": "move_part", "arguments": {"object_id": server, "axis": "z", "delta": -0.04445}},
                {"operation_id": "cable", "tool": "move_curve_endpoint", "arguments": {"object_id": cable, "end": "end", "target_port_object_id": port}},
            ],
            [
                f"scene.objects.{server}.local_transform.location",
                f"scene.objects.{cable}.curve.splines.0.points.1.co",
            ],
            [
                {"type": "translation_delta", "target": server, "axis": "z", "delta": -0.04445, "tolerance": 0.00001},
                {"type": "dimensions_unchanged", "target": server, "tolerance": 0.00001},
                {"type": "endpoint_distance", "endpoint": f"{cable}:end", "target_port": port, "max_distance": 0.00001},
                {"type": "object_count_unchanged"},
            ],
            export=export,
            fault_injection=fault_injection,
        )

    def assert_aborted_without_delivery(self, name, result, error_code):
        self.assertEqual(result["status"], "ABORTED", result)
        self.assertEqual(result["error"]["code"], error_code, result)
        self.assertEqual(result["rollback"]["status"], "passed", result)
        self.assertFalse((self.root / name / "delivery" / "output.blend").exists())

    def test_noop_save_has_no_unauthorized_differences(self):
        completed, result = self.run_request("noop_save", [], [])
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "COMMITTED")
        self.assertEqual(result["locality"]["unauthorized_changes"], [])
        self.assertEqual(result["locality"]["authorized_changes"], [])

    def test_move_server_and_curve_endpoint_and_independently_verify(self):
        completed, result = self.move_case("move_success")
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "COMMITTED")
        self.assertEqual(result["locality"]["unauthorized_changes"], [])
        self.assertTrue((self.root / "move_success" / "delivery" / "output.blend").exists())
        verified, verification = self.verify_run("move_success")
        self.assertEqual(verified.returncode, 0, verification)
        self.assertEqual(verification["status"], "VERIFIED")

    def test_local_axis_move_uses_target_rotation_not_parent_components(self):
        expression = (
            "import bpy, math; "
            f"bpy.ops.wm.open_mainfile(filepath={str(self.source)!r}, load_ui=False, use_scripts=False); "
            "bpy.data.objects['server_03'].rotation_euler.z = math.pi / 2; "
            f"bpy.ops.wm.save_as_mainfile(filepath={str(self.source)!r})"
        )
        subprocess.run([
            str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
            "--python-exit-code", "1", "--python-expr", expression,
        ], check=True, capture_output=True, text=True, timeout=90)
        server = object_id_for("server_03")
        completed, result = self.run_request(
            "local_axis_move",
            [{"tool": "move_part", "arguments": {"object_id": server, "axis": "x", "delta": 0.1}}],
            [f"scene.objects.{server}.local_transform.location"],
            [{"type": "translation_delta", "target": server, "axis": "x", "delta": 0.1, "tolerance": 0.00001}],
        )
        self.assertEqual(completed.returncode, 0, result)
        final_ir = json.loads((self.root / "local_axis_move" / "reports" / "final_ir.json").read_text(encoding="utf-8"))
        initial_ir = json.loads((self.root / "local_axis_move" / "reports" / "initial_ir.json").read_text(encoding="utf-8"))
        before = initial_ir["objects"][server]["world_matrix"]
        after = final_ir["objects"][server]["world_matrix"]
        self.assertAlmostEqual(after[0][3] - before[0][3], 0.0, places=5)
        self.assertAlmostEqual(after[1][3] - before[1][3], 0.1, places=5)

    def test_commit_path_io_failure_leaves_no_successful_delivery(self):
        completed, result = self.move_case(
            "commit_io_failure", fault_injection={"type": "raise_before_commit"},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assert_aborted_without_delivery("commit_io_failure", result, "TOOL_EXECUTION_FAILED")
        self.assertFalse((self.root / "commit_io_failure" / "delivery" / "quality_report.json").exists())

    def test_final_result_write_failure_cleans_committed_delivery(self):
        completed, result = self.move_case(
            "final_result_write_failure", fault_injection={"type": "raise_final_result_write"},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assert_aborted_without_delivery("final_result_write_failure", result, "RESULT_WRITE_FAILED")
        self.assertFalse((self.root / "final_result_write_failure" / "delivery" / "quality_report.json").exists())

    def test_persistent_result_path_failure_uses_run_report_fallback(self):
        completed, result = self.move_case(
            "persistent_result_write_failure", fault_injection={"type": "raise_persistent_final_result_write"},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assert_aborted_without_delivery("persistent_result_write_failure", result, "RESULT_WRITE_FAILED")
        self.assertTrue((self.root / "persistent_result_write_failure" / "reports" / "result.json").is_file())
        self.assertFalse((self.root / "persistent_result_write_failure" / "result.json").exists())
        self.assertIn("result_path_error", result["error"]["details"])

    def test_all_modeling_tools_commit_expected_changes(self):
        server = object_id_for("server_03")
        tray = object_id_for("test_tray")
        duplicate = object_id_for("server_copy")
        blue = data_id_for("mat", "panel_blue")
        completed, result = self.run_request(
            "all_tools",
            [
                {"tool": "create_box", "arguments": {"name": "test_tray", "dimensions": [0.4, 0.5, 0.02], "location": [0, 0, 2]}},
                {"tool": "set_dimensions", "arguments": {"object_id": server, "dimensions": [0.5, 0.65, 0.0889]}},
                {"tool": "duplicate_part", "arguments": {"source_object_id": server, "name": "server_copy", "offset": [0.6, 0, 0]}},
                {"tool": "assign_material", "arguments": {"object_id": server, "material_id": blue, "slot_index": 0}},
                {"tool": "add_bevel", "arguments": {"object_id": server, "width": 0.002, "segments": 2}},
            ],
            [
                f"scene.objects.{tray}",
                f"scene.objects.{server}.local_transform.scale",
                f"scene.objects.{server}.dimensions",
                f"scene.objects.{duplicate}",
                f"scene.objects.{server}.mesh.material_slot_ids",
                f"scene.objects.{server}.modifiers",
            ],
        )
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["locality"]["unauthorized_changes"], [])
        final_ir = json.loads((self.root / "all_tools" / "reports" / "final_ir.json").read_text(encoding="utf-8"))
        self.assertIn(tray, final_ir["objects"])
        self.assertIn(duplicate, final_ir["objects"])
        self.assertAlmostEqual(final_ir["objects"][server]["dimensions"][0], 0.5, places=5)
        self.assertEqual(final_ir["objects"][server]["mesh"]["material_slot_ids"], [blue])
        self.assertEqual(final_ir["objects"][server]["mesh"]["geometry_hash"], final_ir["objects"][duplicate]["mesh"]["geometry_hash"])
        bevels = [item for item in final_ir["objects"][server]["modifiers"] if item["type"] == "BEVEL"]
        self.assertEqual(len(bevels), 1)
        self.assertEqual(bevels[0]["segments"], 2)

    def test_glb_preserves_object_material_override_on_modified_shared_mesh(self):
        subprocess.run([
            str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
            str(self.source), "--python-exit-code", "1", "--python-expr",
            "import bpy\n"
            "server = bpy.data.objects['server_03']\n"
            "server.modifiers.new('Existing Bevel', 'BEVEL').width = 0.002\n"
            "peer = server.copy()\n"
            "peer.name = 'shared_mesh_peer'\n"
            "peer.location.x += 1\n"
            "bpy.context.collection.objects.link(peer)\n"
            "bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)\n",
        ], check=True, capture_output=True, timeout=90)
        source_hash = file_sha256(self.source)
        server = object_id_for("server_03")
        blue = data_id_for("mat", "panel_blue")
        completed, result = self.run_request(
            "shared_material_export",
            [{"tool": "assign_material", "arguments": {"object_id": server, "material_id": blue, "slot_index": 0}}],
            [f"scene.objects.{server}.mesh.material_slot_ids"],
            export=True,
        )
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "COMMITTED")
        self.assertEqual(result["locality"]["unauthorized_changes"], [])
        slots = {
            check["name"]: check["after"] for check in result["export"]["checks"]
            if check["check"] == "material_slot_ids"
        }
        self.assertEqual(slots["server_03"], [blue])
        self.assertEqual(slots["shared_mesh_peer"], [data_id_for("mat", "server_black")])
        self.assertEqual(file_sha256(self.source), source_hash)

    def test_invalid_parameters_fail_and_restore_every_tool(self):
        server = object_id_for("server_03")
        cable = object_id_for("cable_07", "CURVE")
        blue = data_id_for("mat", "panel_blue")
        cases = [
            ("move_part", {"object_id": server, "axis": "z", "delta": "bad"}, [f"scene.objects.{server}.local_transform.location"]),
            ("rotate_part", {"object_id": server, "axis": "z", "angle_deg": "bad"}, [f"scene.objects.{server}.local_transform.rotation_euler"]),
            ("set_dimensions", {"object_id": server, "dimensions": [0, 1, 1]}, [f"scene.objects.{server}.local_transform.scale", f"scene.objects.{server}.dimensions"]),
            ("create_box", {"name": "bad_box", "dimensions": [1, -1, 1]}, [f"scene.objects.{object_id_for('bad_box')}"]),
            ("duplicate_part", {"source_object_id": "obj_missing", "name": "bad_copy"}, [f"scene.objects.{object_id_for('bad_copy')}"]),
            ("assign_material", {"object_id": server, "material_id": blue, "slot_index": 99}, [f"scene.objects.{server}.mesh.material_slot_ids"]),
            ("add_bevel", {"object_id": server, "width": 0}, [f"scene.objects.{server}.modifiers"]),
            ("move_curve_endpoint", {"object_id": cable, "end": "end"}, [f"scene.objects.{cable}.curve.splines.0.points.1.co"]),
        ]
        for index, (tool, arguments, write_set) in enumerate(cases):
            with self.subTest(tool=tool):
                name = f"invalid_{index}_{tool}"
                completed, result = self.run_request(name, [{"tool": tool, "arguments": arguments}], write_set)
                self.assertNotEqual(completed.returncode, 0)
                self.assert_aborted_without_delivery(name, result, "TOOL_EXECUTION_FAILED")

    def test_every_tool_requires_write_permission(self):
        server = object_id_for("server_03")
        cable = object_id_for("cable_07", "CURVE")
        blue = data_id_for("mat", "panel_blue")
        cases = [
            ("move_part", {"object_id": server, "axis": "z", "delta": 1}),
            ("rotate_part", {"object_id": server, "axis": "z", "angle_deg": 15}),
            ("set_dimensions", {"object_id": server, "dimensions": [1, 1, 1]}),
            ("create_box", {"name": "unauthorized_box", "dimensions": [1, 1, 1]}),
            ("duplicate_part", {"source_object_id": server, "name": "unauthorized_copy"}),
            ("assign_material", {"object_id": server, "material_id": blue, "slot_index": 0}),
            ("add_bevel", {"object_id": server, "width": 0.002}),
            ("move_curve_endpoint", {"object_id": cable, "end": "end", "world_position": [0, 0, 0]}),
        ]
        for index, (tool, arguments) in enumerate(cases):
            with self.subTest(tool=tool):
                name = f"denied_{index}_{tool}"
                completed, result = self.run_request(name, [{"tool": tool, "arguments": arguments}], [])
                self.assertNotEqual(completed.returncode, 0)
                self.assert_aborted_without_delivery(name, result, "PERMISSION_DENIED")

    def test_duplicate_assembly_requires_every_child_write_permission(self):
        server = object_id_for("server_03")
        port = object_id_for("server_03_port", "EMPTY")
        name = "denied_assembly"
        completed, result = self.run_request(
            name,
            [{"tool": "duplicate_part", "arguments": {
                "source_object_id": server, "name": "server_copy", "offset": [0.6, 0, 0],
                "include_children": True, "child_names": {port: "server_copy_port"},
            }}],
            [f"scene.objects.{object_id_for('server_copy')}"],
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assert_aborted_without_delivery(name, result, "PERMISSION_DENIED")

    def test_rotation_that_fails_its_constraint_rolls_back(self):
        name = "incorrect_rotation"
        object_id = object_id_for("server_03")
        source_hash = file_sha256(self.source)
        completed, result = self.run_request(
            name,
            [{"tool": "rotate_part", "arguments": {"object_id": object_id, "axis": "z", "angle_deg": 15}}],
            [f"scene.objects.{object_id}.local_transform.rotation_euler"],
            constraints=[{"type": "rotation_delta", "target": object_id, "axis": "z", "angle_deg": -15}],
            export=True,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual(result["targets"]["status"], "failed")
        self.assertEqual(result["locality"]["unauthorized_changes"], [])
        self.assertEqual(result["rollback"]["differences"], [])
        self.assertFalse((self.root / name / "delivery" / "output.glb").exists())
        self.assertEqual(file_sha256(self.source), source_hash)

    def test_mid_execution_exception_restores_initial_scene(self):
        server = object_id_for("server_03")
        name = "fault_exception"
        completed, result = self.run_request(
            name,
            [{"operation_id": "move", "tool": "move_part", "arguments": {"object_id": server, "axis": "z", "delta": -0.04445}}],
            [f"scene.objects.{server}.local_transform.location"],
            fault_injection={"type": "raise_after_operation", "operation_id": "move"},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assert_aborted_without_delivery(name, result, "TOOL_EXECUTION_FAILED")
        self.assertEqual(result["rollback"]["differences"], [])

    def test_unauthorized_side_effect_is_detected_and_rolled_back(self):
        server = object_id_for("server_03")
        camera = object_id_for("Camera", "CAMERA")
        name = "fault_camera"
        completed, result = self.run_request(
            name,
            [{"operation_id": "move", "tool": "move_part", "arguments": {"object_id": server, "axis": "z", "delta": -0.04445}}],
            [f"scene.objects.{server}.local_transform.location"],
            fault_injection={"type": "unauthorized_object_change", "operation_id": "move", "object_id": camera},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["status"], "ROLLED_BACK", result)
        self.assertEqual(result["rollback"]["status"], "passed", result)
        unauthorized_paths = [item["path"] for item in result["locality"]["unauthorized_changes"]]
        self.assertTrue(any(path.startswith(f"scene.objects.{camera}.local_transform.location") for path in unauthorized_paths))
        self.assertFalse((self.root / name / "delivery" / "output.blend").exists())

    def test_glb_export_reimport_and_independent_verification(self):
        completed, result = self.move_case("export_success", export=True)
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["export"]["status"], "passed", result)
        self.assertTrue((self.root / "export_success" / "delivery" / "output.glb").is_file())
        self.assertIsNotNone(result["manifest"]["output_glb_sha256"])
        verified, verification = self.verify_run("export_success")
        self.assertEqual(verified.returncode, 0, verification)
        self.assertEqual(verification["status"], "VERIFIED")
        self.assertEqual(verification["export"]["status"], "passed")
    def test_independent_verifier_rejects_replaced_delivery(self):
        completed, result = self.move_case("tampered_delivery")
        self.assertEqual(completed.returncode, 0, result)
        run_dir = self.root / "tampered_delivery"
        shutil.copy2(run_dir / "input" / "source.blend", run_dir / "delivery" / "output.blend")
        verified, verification = self.verify_run("tampered_delivery")
        self.assertNotEqual(verified.returncode, 0)
        self.assertEqual(verification["status"], "FAILED")
        output_check = next(item for item in verification["hashes"] if item["check"] == "output_sha256")
        self.assertEqual(output_check["status"], "failed")
        self.assertEqual(verification["targets"]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
