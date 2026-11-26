from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from blendguard.inspect_cache import InspectionCache
from blendguard.scene_ir import SCENE_IR_VERSION
from blendguard.workspace import file_sha256, write_json


class InspectionCacheTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.source = self.root / "source.blend"
        self.source.write_bytes(b"source")
        self.blender = self.root / "blender.exe"
        self.blender.write_bytes(b"blender")
        self.cache = self.cache_for()
        self.scene = {
            "scene_ir_version": SCENE_IR_VERSION,
            "blender_version": "test",
            "unit_settings": {"system": "NONE", "scale_length": 1.0},
            "objects": {}, "materials": {}, "images": {}, "world": None, "coverage_notes": [],
        }

    def cache_for(self):
        return InspectionCache.for_source(self.root / "cache", self.source, file_sha256(self.source), self.blender)

    def test_key_tracks_source_content_executable_code_and_version(self):
        self.assertEqual(self.cache, self.cache_for())
        timestamp = self.source.stat()
        self.source.write_bytes(b"update")
        os.utime(self.source, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
        self.assertNotEqual(self.cache.cache_key, self.cache_for().cache_key)
        original = self.cache_for()
        self.blender.write_bytes(b"blender updated")
        self.assertNotEqual(original.cache_key, self.cache_for().cache_key)
        original = self.cache_for()
        timestamp = self.blender.stat()
        os.utime(self.blender, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns - 2_000_000_000))
        self.assertNotEqual(original.cache_key, self.cache_for().cache_key)
        original = self.cache_for()
        for name in ("blender_scene.py", "scene_ir.py", "blender_inspect.py"):
            with self.subTest(name=name), patch(
                "blendguard.inspect_cache.file_sha256",
                side_effect=lambda path: "changed" if path.name == name else file_sha256(path),
            ):
                self.assertNotEqual(original.cache_key, self.cache_for().cache_key)
        with patch("blendguard.inspect_cache.SCENE_IR_VERSION", "2.0"):
            self.assertNotEqual(original.cache_key, self.cache_for().cache_key)
        self.source = self.source.rename(self.root / "renamed.blend")
        self.assertNotEqual(original.cache_key, self.cache_for().cache_key)

    def test_corrupt_mismatched_and_unreadable_entries_are_misses(self):
        self.assertIsNone(self.cache.read())
        self.cache.write(self.scene)
        self.assertEqual(self.cache.read(), self.scene)
        original = json.loads(self.cache.path.read_text(encoding="utf-8"))
        for changes in (
            {"cache_key": "other"}, {"source_sha256": "other"}, {"scene_ir": []},
            {"scene_ir": self.scene | {"scene_ir_version": "2.0"}},
            {"scene_ir": self.scene | {"objects": []}},
            {"scene_ir": self.scene | {"objects": {"obj_invalid": None}}},
        ):
            with self.subTest(changes=changes):
                write_json(self.cache.path, original | changes)
                self.assertIsNone(self.cache.read())
        for content in (b"[", b"\xff"):
            self.cache.path.write_bytes(content)
            self.assertIsNone(self.cache.read())
        with patch.object(Path, "read_text", side_effect=PermissionError):
            self.assertIsNone(self.cache.read())

    def test_referenced_file_appearance_modification_and_deletion(self):
        texture = self.root / "texture.png"
        image = {"path": str(texture), "exists": False, "packed": False, "sha256": None, "hash_scope": "source_directory"}
        self.scene["images"]["Texture"] = image
        self.cache.write(self.scene)
        self.assertEqual(self.cache.read(), self.scene)
        (self.root / "unreferenced.png").touch()
        self.assertEqual(self.cache.read(), self.scene)
        texture.write_bytes(b"original")
        self.assertIsNone(self.cache.read())
        image.update(exists=True, sha256=file_sha256(texture))
        self.cache.write(self.scene)
        self.assertEqual(self.cache.read(), self.scene)
        texture.write_bytes(b"modified")
        self.assertIsNone(self.cache.read())
        texture.unlink()
        self.assertIsNone(self.cache.read())

    def test_outside_image_is_never_hashed(self):
        outside = self.root.with_name(self.root.name + "-other") / "texture.png"
        image = {"path": str(outside), "exists": True, "packed": False, "sha256": "hash", "hash_scope": "source_directory"}
        self.scene["images"]["Texture"] = image
        self.cache.write(self.scene)
        with patch("blendguard.inspect_cache.file_sha256") as hash_file:
            self.assertIsNone(self.cache.read())
            image.update(exists=None, sha256=None, hash_scope="not_read")
            self.cache.write(self.scene)
            self.assertEqual(self.cache.read(), self.scene)
            hash_file.assert_not_called()

    def test_image_redirected_outside_source_directory_is_never_hashed(self):
        texture = self.root / "texture.png"
        texture.write_bytes(b"data")
        self.scene["images"]["Texture"] = {
            "path": str(texture), "exists": True, "packed": False,
            "sha256": file_sha256(texture), "hash_scope": "source_directory",
        }
        self.cache.write(self.scene)
        self.assertEqual(self.cache.read(), self.scene)
        realpath = os.path.realpath
        outside = self.root.with_name(self.root.name + "-other") / texture.name

        def redirected(path):
            return str(outside) if Path(path) == texture else realpath(path)

        with (
            patch("blendguard.scene_ir.os.path.realpath", side_effect=redirected),
            patch("blendguard.inspect_cache.file_sha256") as hash_file,
        ):
            self.assertIsNone(self.cache.read())
            hash_file.assert_not_called()

    def test_concurrent_publications_use_separate_staging_paths(self):
        scenes = [self.scene | {"blender_version": str(i)} for i in range(12)]
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(self.cache.write, scenes))
        self.assertIn(self.cache.read(), scenes)
        self.assertEqual(list(self.cache.path.parent.iterdir()), [self.cache.path])
