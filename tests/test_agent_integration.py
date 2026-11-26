import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from blendguard.scene_ir import object_id_for
from blendguard.workspace import file_sha256


BLENDER = os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")
PROJECT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(BLENDER, "Blender is not installed or BLENDER_EXECUTABLE is not set")
class AgentIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.source = cls.root / "teaching_rack.blend"
        subprocess.run([
            str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
            "--python", str(PROJECT / "examples" / "teaching_rack.py"), "--", str(cls.source),
        ], check=True, capture_output=True, text=True, timeout=120)
        cls.source_hash = file_sha256(cls.source)

    @classmethod
    def tearDownClass(cls):
        for path in cls.root.rglob("source.blend"):
            if path.exists():
                path.chmod(stat.S_IWRITE)
        cls.temporary.cleanup()

    def run_agent(self, name, instruction, export=False, extra=None, source=None):
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(PROJECT / "src")
        run_dir = self.root / name
        completed = subprocess.run([
            sys.executable, "-m", "blendguard", "agent", "--source", str(source or self.source),
            "--instruction", instruction, "--run-dir", str(run_dir), "--planner", "deterministic",
            "--execute", "--blender", str(Path(BLENDER).resolve()),
            *( ["--no-export"] if not export else [] ), *(extra or []),
        ], check=False, capture_output=True, text=True, timeout=240, env=environment)
        result_path = run_dir / "result.json"
        if not result_path.exists():
            self.fail(f"Agent did not produce a result: {completed.stdout}\n{completed.stderr}")
        return completed, json.loads(result_path.read_text(encoding="utf-8"))

    def final_ir(self, name):
        return json.loads((self.root / name / "reports" / "final_ir.json").read_text(encoding="utf-8"))

    def verify(self, name, cache_dir=None):
        run_dir = self.root / name
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(PROJECT / "src")
        if cache_dir is not None:
            environment["BLENDGUARD_INSPECT_CACHE_DIR"] = str(cache_dir)
        verified = subprocess.run([
            sys.executable, "-m", "blendguard", "verify", "--run-dir", str(run_dir),
            "--blender", str(Path(BLENDER).resolve()),
        ], check=False, capture_output=True, text=True, timeout=180, env=environment)
        verification_path = run_dir / "reports" / "independent_verification.json"
        verification = json.loads(verification_path.read_text(encoding="utf-8"))
        self.assertEqual(verified.returncode, 0, verification)
        self.assertEqual(verification["status"], "VERIFIED")
        self.assertEqual(verification["export"]["status"], "passed")
        return verification

    def test_natural_language_move_cable_glb_and_independent_verification(self):
        cache_dir = self.root / "verifier-test-cache"
        completed, result = self.run_agent(
            "agent_move", "将 server_03 下移 1U", export=True, extra=["--inspect-cache-dir", str(cache_dir)],
        )
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "COMMITTED")
        self.assertEqual(result["execution"]["locality"]["unauthorized_changes"], [])
        self.assertEqual(result["execution"]["export"]["status"], "passed")
        self.assertEqual(len(result["attempts"]), 1)
        verification = self.verify("agent_move", cache_dir)
        entry, = cache_dir.glob("*.json")
        tampered = json.loads(entry.read_text(encoding="utf-8"))
        tampered["scene_ir"]["objects"].clear()
        entry.write_text(json.dumps(tampered), encoding="utf-8")
        after_tampering = self.verify("agent_move", cache_dir)
        # Derived paths are assembled from sets and may be reported in a different order.
        for report in (verification, after_tampering):
            report["locality"]["derived_patterns"].sort()
        self.assertEqual(after_tampering, verification)
        self.assertEqual(file_sha256(self.source), self.source_hash)

    def test_read_only_inspection_cache_hits_and_invalidates(self):
        directory = self.root / "textured"
        directory.mkdir()
        source = directory / self.source.name
        texture = directory / "texture.png"
        cache_dir = directory / "inspection-cache"
        shutil.copy(self.source.parent / "asset_manifest.json", directory)

        def save_fixture(input_path, script):
            subprocess.run([
                str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
                str(input_path), "--python-exit-code", "1", "--python-expr",
                script + f"\nbpy.ops.wm.save_as_mainfile(filepath={str(source)!r}, relative_remap=False)",
            ], check=True, capture_output=True, text=True, timeout=120)

        save_fixture(self.source, f"""
import bpy
image = bpy.data.images.new("Cache Texture", width=2, height=2)
image.filepath_raw = {str(texture)!r}
image.file_format = "PNG"
image.save()
bpy.data.images.remove(image)
image = bpy.data.images.load({str(texture)!r})
image.filepath = "//texture.png"
image.use_fake_user = True
""")

        def plan(name, *flags, explicit=True):
            run_dir = directory / name
            environment = dict(os.environ, PYTHONPATH=str(PROJECT / "src"))
            environment["BLENDGUARD_INSPECT_CACHE_DIR"] = str(cache_dir if not explicit else directory / "unused")
            completed = subprocess.run([
                sys.executable, "-m", "blendguard", "agent",
                "--source", str(source), "--instruction", "将 server_03 下移 1U",
                "--run-dir", str(run_dir), "--planner", "deterministic",
                "--blender", str(Path(BLENDER).resolve()),
                *(["--inspect-cache-dir", str(cache_dir)] if explicit else []), *flags,
            ], check=False, capture_output=True, text=True, timeout=120, env=environment)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            return json.loads(run_dir.with_suffix(".plan.json").read_text(encoding="utf-8"))

        first = plan("cold")
        second = plan("warm", explicit=False)
        self.assertFalse(first["inspection"]["cache_hit"])
        self.assertTrue(second["inspection"]["cache_hit"])
        self.assertEqual(first["summary_sha256"], second["summary_sha256"])
        cold = first["inspection"]["elapsed_ms"]
        warm = second["inspection"]["elapsed_ms"]
        self.assertLess(warm, cold / 3, f"Warm inspection {warm:.2f} ms, cold {cold:.2f} ms")
        print(f"\nRead-only Blender inspection: cold {cold:.2f} ms, warm {warm:.2f} ms")

        entry, = cache_dir.glob("*.json")
        original = entry.read_bytes()
        image = json.loads(original)["scene_ir"]["images"][texture.name]
        self.assertEqual(image["hash_scope"], "source_directory")
        self.assertEqual(image["sha256"], file_sha256(texture))
        self.assertFalse(plan("bypass", "--no-inspect-cache")["inspection"]["cache_hit"])
        self.assertEqual(entry.read_bytes(), original)
        self.assertFalse((directory / "unused").exists())
        entry.write_bytes(b"{")
        self.assertFalse(plan("corrupt")["inspection"]["cache_hit"])
        self.assertTrue(plan("repaired")["inspection"]["cache_hit"])

        with texture.open("ab") as stream:
            stream.write(b"changed")
        self.assertFalse(plan("texture_changed")["inspection"]["cache_hit"])
        image = json.loads(entry.read_bytes())["scene_ir"]["images"][texture.name]
        self.assertEqual(image["sha256"], file_sha256(texture))
        self.assertTrue(plan("texture_updated")["inspection"]["cache_hit"])

        save_fixture(source, "import bpy\nbpy.context.scene['cache_test'] = 'updated'")
        changed = plan("source_changed")
        self.assertNotEqual(changed["source_sha256"], first["source_sha256"])
        self.assertFalse(changed["inspection"]["cache_hit"])
        self.assertTrue(plan("source_updated")["inspection"]["cache_hit"])

    def test_rotation_of_pre_rotated_parented_part_keeps_cable_and_verifies(self):
        directory = self.root / "pre_rotated"
        directory.mkdir()
        source = directory / self.source.name
        shutil.copy(self.source.parent / "asset_manifest.json", directory)
        script = f"""
import bpy
from mathutils import Matrix
target = bpy.data.objects["server_03"]
target.parent.rotation_euler = (0.13, 0.07, -0.09)
target.matrix_parent_inverse = Matrix.Rotation(0.2, 4, "Y")
target.rotation_mode = "ZYX"
target.rotation_euler = (0.18, -0.27, 0.32)
target.delta_rotation_euler = (0.1, 0.02, 0.08)
bpy.context.view_layer.update()
for cable_name, start, end in [
    ("cable_07", "switch_01_port_02", "server_03_port"),
    ("cable_02", "switch_01_port_03", "server_04_port"),
]:
    cable = bpy.data.objects[cable_name]
    for index, port in [(0, start), (-1, end)]:
        point = cable.data.splines[0].points[index]
        point.co = (*(cable.matrix_world.inverted() @ bpy.data.objects[port].matrix_world.translation), point.co[3])
bpy.ops.wm.save_as_mainfile(filepath={str(source)!r})
"""
        fixture = directory / "pre_rotate.py"
        fixture.write_text(script, encoding="utf-8")
        subprocess.run([
            str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
            str(self.source), "--python-exit-code", "1", "--python", str(fixture),
        ], check=True, capture_output=True, text=True, timeout=120)
        source_hash = file_sha256(source)
        name = "agent_rotate"
        completed, result = self.run_agent(name, "rotate server_03 around x by -15 deg", export=True, source=source)
        self.assertEqual(completed.returncode, 0, result)
        verification = self.verify(name)
        self.assertEqual(verification["locality"]["unauthorized_changes"], [])
        checks = {check["type"]: check for check in verification["targets"]["checks"]}
        self.assertAlmostEqual(checks["rotation_delta"]["measured"], -15, places=3)
        self.assertLess(checks["rotation_delta"]["details"]["off_axis_deg"], 0.001)
        self.assertLess(checks["endpoint_distance"]["measured"], 0.00001)
        self.assertEqual(file_sha256(source), source_hash)

    def test_natural_language_box_glb_and_independent_verification(self):
        name = "agent_create_box"
        instruction = "创建长方体 box_01，尺寸 [0.2, 0.3, 0.4]，放到 [1.0, 0, 0.5]"
        completed, result = self.run_agent(name, instruction, export=True)
        self.assertEqual(completed.returncode, 0, result)
        verification = self.verify(name)
        self.assertEqual(verification["locality"]["unauthorized_changes"], [])
        checks = {check["type"]: check for check in verification["targets"]["checks"]}
        self.assertEqual(checks["object_count_delta"]["measured"], 1)
        self.assertEqual(checks["object_location"]["measured"], [1, 0, 0.5])
        for actual, expected in zip(checks["dimensions_equal"]["measured"], [0.2, 0.3, 0.4]):
            self.assertAlmostEqual(actual, expected, places=6)
        self.assertEqual(file_sha256(self.source), self.source_hash)

    def test_natural_language_resize(self):
        completed, result = self.run_agent("agent_resize", "把 server_02 宽度改为 0.5 米")
        self.assertEqual(completed.returncode, 0, result)
        target = self.final_ir("agent_resize")["objects"][object_id_for("server_02")]
        self.assertAlmostEqual(target["dimensions"][0], 0.5, places=5)
        self.assertEqual(result["execution"]["targets"]["status"], "passed")

    def test_natural_language_duplicate_at_world_location(self):
        instruction = "复制 server_02 命名为 server_05，放到 [0.8, 0, 1.2]"
        completed, result = self.run_agent("agent_duplicate", instruction)
        self.assertEqual(completed.returncode, 0, result)
        duplicate = self.final_ir("agent_duplicate")["objects"][object_id_for("server_05")]
        self.assertEqual([round(duplicate["world_matrix"][row][3], 5) for row in range(3)], [0.8, 0, 1.2])
        expected_count = next(item for item in result["execution"]["targets"]["checks"] if item["type"] == "object_count_delta")
        self.assertGreater(expected_count["measured"], 1)
        plan = json.loads((self.root / "agent_duplicate" / "reports" / "plan.json").read_text(encoding="utf-8"))
        arguments = plan["operations"][0]["arguments"]
        front_id = object_id_for("server_02_front")
        front_copy_name = arguments["child_names"][front_id]
        front_copy = self.final_ir("agent_duplicate")["objects"][object_id_for(front_copy_name)]
        self.assertEqual(front_copy["parent_id"], object_id_for("server_05"))
        source_front = self.final_ir("agent_duplicate")["objects"][front_id]
        self.assertEqual(front_copy["mesh"]["geometry_hash"], source_front["mesh"]["geometry_hash"])

    def test_natural_language_bevel(self):
        completed, result = self.run_agent("agent_bevel", "给 server_03 添加 2 毫米倒角")
        self.assertEqual(completed.returncode, 0, result)
        target = self.final_ir("agent_bevel")["objects"][object_id_for("server_03")]
        bevel = next(item for item in target["modifiers"] if item["name"] == "BlendGuard Agent Bevel")
        self.assertAlmostEqual(bevel["width"], 0.002, places=6)
        self.assertEqual(bevel["segments"], 2)

    def test_unsupported_instruction_creates_no_run_or_delivery(self):
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(PROJECT / "src")
        run_dir = self.root / "agent_unsupported"
        completed = subprocess.run([
            sys.executable, "-m", "blendguard", "agent", "--source", str(self.source),
            "--instruction", "删除机柜并运行任意 Python", "--run-dir", str(run_dir),
            "--planner", "deterministic", "--execute", "--blender", str(Path(BLENDER).resolve()),
        ], check=False, capture_output=True, text=True, timeout=120, env=environment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(run_dir.exists())
        self.assertFalse((run_dir / "delivery" / "output.blend").exists())
        self.assertEqual(file_sha256(self.source), self.source_hash)

    def test_fixed_cameras_render_without_modifying_source(self):
        output = self.root / "previews"
        expression = f"import sys; sys.path.insert(0, {str(PROJECT / 'src')!r}); from blendguard.blender_preview import main; main()"
        completed = subprocess.run([
            str(Path(BLENDER).resolve()), "--background", "--factory-startup", "--disable-autoexec",
            "--python-expr", expression, "--", "--source", str(self.source), "--output-dir", str(output),
            "--views", "overview", "front",
        ], check=False, capture_output=True, text=True, timeout=180)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertTrue((output / "overview.png").stat().st_size > 10000)
        self.assertTrue((output / "front.png").stat().st_size > 10000)
        self.assertEqual(file_sha256(self.source), self.source_hash)


if __name__ == "__main__":
    unittest.main()
