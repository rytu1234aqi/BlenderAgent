import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from blendguard.errors import SourceHashChanged
from blendguard.workspace import RunWorkspace, file_sha256


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "original.blend"
        self.source.write_bytes(b"original blender fixture")

    def tearDown(self):
        for path in self.root.rglob("source.blend"):
            if path.exists():
                path.chmod(stat.S_IWRITE)
        self.temporary.cleanup()

    def workspace(self):
        return RunWorkspace(self.source, self.root / "run", file_sha256(self.source))

    def test_prepare_preserves_source_and_commit_copies_work(self):
        workspace = self.workspace()
        workspace.prepare()
        original_hash = file_sha256(self.source)
        workspace.working_file.write_bytes(b"modified")
        workspace.checkpoint("cp_000")
        output = workspace.commit()
        self.assertEqual(file_sha256(self.source), original_hash)
        self.assertEqual(output.read_bytes(), b"modified")
        self.assertEqual((workspace.checkpoints / "cp_000.blend").read_bytes(), b"modified")

    def test_source_change_is_detected(self):
        workspace = self.workspace()
        workspace.prepare()
        self.source.write_bytes(b"external change")
        with self.assertRaises(SourceHashChanged):
            workspace.assert_source_unchanged()

    def test_wrong_contract_hash_does_not_create_copy(self):
        workspace = RunWorkspace(self.source, self.root / "run", "0" * 64)
        with self.assertRaises(SourceHashChanged):
            workspace.prepare()
        self.assertFalse(workspace.working_file.exists())
    def test_source_copy_hash_mismatch_stops_before_working_copy(self):
        workspace = self.workspace()
        with patch("blendguard.workspace.shutil.copy2", side_effect=lambda source, destination: Path(destination).write_bytes(b"tampered copy")):
            with self.assertRaises(SourceHashChanged):
                workspace.prepare()
        self.assertFalse(workspace.working_file.exists())


if __name__ == "__main__":
    unittest.main()
