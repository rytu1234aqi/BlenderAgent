import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import blendguard.cli as cli
from blendguard.cli import _cmd_run, _load_reviewed_plan, _summary_digest, run_blender_request
from blendguard.planning import ClaudePlanner, DeepSeekPlanner, DeterministicPlanner
from blendguard.workspace import file_sha256, write_json


class CLITests(unittest.TestCase):
    def test_child_receives_resolved_request_without_rewriting_user_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request_path = root / "request.json"
            write_json(request_path, {"source_file": "asset.blend", "run_dir": "run"})
            captured = {}

            def fake_run(command, check, timeout):
                request_argument = Path(command[command.index("--request") + 1])
                captured["request"] = json.loads(request_argument.read_text(encoding="utf-8"))
                result_path = Path(command[command.index("--result") + 1])
                write_json(result_path, {"status": "COMMITTED"})
                return __import__("subprocess").CompletedProcess(command, 0)

            with patch("blendguard.cli.subprocess.run", side_effect=fake_run):
                with self.assertRaises(SystemExit) as exit_context:
                    _cmd_run(argparse.Namespace(request=request_path, blender="fake-blender", blender_timeout=300))
            self.assertEqual(exit_context.exception.code, 0)
            self.assertEqual(captured["request"]["source_file"], str((root / "asset.blend").resolve()))
            self.assertEqual(captured["request"]["run_dir"], str((root / "run").resolve()))
            original = json.loads(request_path.read_text(encoding="utf-8"))
            self.assertEqual(original["source_file"], "asset.blend")
            self.assertEqual(original["run_dir"], "run")
    def test_reviewed_plan_is_bound_to_source_instruction_and_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "asset.blend"
            source.write_bytes(b"asset")
            summary = {"objects": [{"name": "server_03"}]}
            plan = {
                "status": "READY", "instruction": "move", "source_file": str(source),
                "source_sha256": file_sha256(source), "summary_sha256": _summary_digest(summary),
                "proposal": {"action": "move_part"}, "planner": {"planner": "test"},
            }
            path = root / "reviewed.json"
            write_json(path, plan)
            proposal, provider, digest = _load_reviewed_plan(path, source, file_sha256(source), "move", summary)
            self.assertEqual(proposal, plan["proposal"])
            self.assertEqual(digest, file_sha256(path))
            with self.assertRaises(SystemExit) as mismatch:
                _load_reviewed_plan(path, source, file_sha256(source), "different instruction", summary)
            self.assertIn("PLAN_APPROVAL_MISMATCH", str(mismatch.exception.code))
            with self.assertRaises(SystemExit):
                _load_reviewed_plan(path, source, file_sha256(source), "move", {"objects": []})

    def test_agent_defaults_to_deepseek_without_touching_files_or_network(self):
        captured = {}

        def fake_handler(args):
            captured.update(vars(args))

        argv = [
            "blendguard", "agent", "--source", "asset.blend",
            "--instruction", "move server_03", "--run-dir", "run",
        ]
        with patch.object(sys, "argv", argv), patch.object(cli, "_cmd_agent", fake_handler):
            cli.main()
        self.assertEqual(captured["planner"], "deepseek")
        self.assertIsNone(captured["model"])

    def test_agent_rehashes_source_after_cache_hit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.blend"
            source.write_bytes(b"original")
            blender = root / "blender.exe"
            blender.touch()
            run_dir = root / "runs" / "test"
            argv = [
                "blendguard", "agent", "--source", str(source), "--instruction", "move server_03",
                "--run-dir", str(run_dir), "--blender", str(blender), "--planner", "deterministic",
            ]

            def change_source(cache):
                self.assertEqual(cache.path.parent, run_dir.parent.resolve() / ".blendguard_inspect_cache")
                self.assertEqual(cache.source_sha256, file_sha256(source))
                source.write_bytes(b"modified")
                return {}

            with (
                patch.object(sys, "argv", argv),
                patch.dict(os.environ, {"BLENDGUARD_INSPECT_CACHE_DIR": ""}),
                patch("blendguard.inspect_cache.InspectionCache.read", autospec=True, side_effect=change_source),
                patch("blendguard.inspect_cache.InspectionCache.write") as cache_write,
                patch.object(cli, "_inspect_scene") as inspect,
                self.assertRaisesRegex(SystemExit, "SOURCE_HASH_CHANGED"),
            ):
                cli.main()
            cache_write.assert_not_called()
            inspect.assert_not_called()
            self.assertFalse(run_dir.with_suffix(".plan.json").exists())

    def test_planner_selection_keeps_provider_defaults_separate(self):
        with patch.dict(os.environ, {"DEEPSEEK_MODEL": "deepseek-env"}, clear=True):
            deepseek = cli._create_planner("deepseek", None)
            self.assertIsInstance(deepseek, DeepSeekPlanner)
            self.assertEqual(deepseek.model, "deepseek-env")
            explicit = cli._create_planner("deepseek", "deepseek-explicit")
            self.assertEqual(explicit.model, "deepseek-explicit")
            claude = cli._create_planner("claude", None)
            self.assertIsInstance(claude, ClaudePlanner)
            self.assertEqual(claude.model, "claude-opus-5-5")
            self.assertIsInstance(cli._create_planner("deterministic", None), DeterministicPlanner)

    def test_blender_timeout_returns_machine_readable_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = {"run_dir": str(root / "run")}
            with patch("blendguard.cli.subprocess.run", side_effect=subprocess.TimeoutExpired("blender", 1)):
                returncode, result = run_blender_request(request, "fake-blender", timeout=1)
            self.assertEqual(returncode, 124)
            self.assertEqual(result["status"], "ABORTED")
            self.assertEqual(result["error"]["code"], "BLENDER_TIMEOUT")


if __name__ == "__main__":
    unittest.main()
