"""Best-effort cache for the agent's read-only Blender inspection."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

from .scene_ir import SCENE_IR_VERSION, inside_source_directory
from .workspace import file_sha256, write_json


_INSPECTION_FILES = ("blender_scene.py", "scene_ir.py", "blender_inspect.py")


def _json_sha256(value: dict) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _images_match(images: dict, source_dir: Path) -> bool:
    for image in images.values():
        if not isinstance(image, dict):
            return False
        path = image["path"]
        if not isinstance(path, str) or "\0" in path or type(image["packed"]) is not bool:
            return False
        if path and os.path.normpath(path) != path:
            return False
        inside = bool(path) and Path(path).is_absolute() and inside_source_directory(source_dir, path)
        if not inside:
            if image["hash_scope"] != "not_read" or image["exists"] is not None or image["sha256"] is not None:
                return False
            continue
        if image["hash_scope"] != "source_directory":
            return False
        file = Path(path)
        exists = file.is_file()
        if image["exists"] is not exists:
            return False
        if image["sha256"] != (file_sha256(file) if exists else None):
            return False
    return True


@dataclass(frozen=True)
class InspectionCache:
    path: Path
    cache_key: str
    source: Path
    source_sha256: str

    @classmethod
    def for_source(cls, directory: Path, source: Path, source_sha256: str, blender: Path) -> InspectionCache:
        executable = blender.resolve(strict=True)
        info = executable.stat()
        code_dir = Path(__file__).resolve().parent
        cache_key = _json_sha256({
            "source_sha256": source_sha256,
            # Relative image and library references depend on the source's location.
            "source_file": os.path.normcase(str(source)),
            "blender": [os.path.normcase(str(executable)), info.st_mtime_ns, info.st_size],
            "inspection_code": {name: file_sha256(code_dir / name) for name in _INSPECTION_FILES},
            "scene_ir_version": SCENE_IR_VERSION,
        })
        return cls(directory / f"{cache_key}.json", cache_key, source, source_sha256)

    def read(self) -> dict | None:
        try:
            entry = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(entry, dict):
                return None
            if entry["source_sha256"] != self.source_sha256 or entry["cache_key"] != self.cache_key:
                return None
            scene = entry["scene_ir"]
            if not isinstance(scene, dict) or scene["scene_ir_version"] != SCENE_IR_VERSION:
                return None
            if not (
                isinstance(scene["blender_version"], str)
                and isinstance(scene["unit_settings"], dict)
                and isinstance(scene["unit_settings"]["system"], str)
                and type(scene["unit_settings"]["scale_length"]) in (int, float)
                and math.isfinite(scene["unit_settings"]["scale_length"])
                and all(isinstance(scene[key], dict) for key in ("objects", "materials", "images"))
                and all(
                    isinstance(record, dict) and isinstance(record.get("name"), str)
                    for key in ("objects", "materials") for record in scene[key].values()
                )
                and (scene["world"] is None or isinstance(scene["world"], str))
                and isinstance(scene["coverage_notes"], list)
                and all(isinstance(note, str) for note in scene["coverage_notes"])
            ):
                return None
            if entry["scene_ir_sha256"] != _json_sha256(scene) or not _images_match(scene["images"], self.source.parent):
                return None
            return scene
        except (OSError, ValueError, TypeError, KeyError, RecursionError, OverflowError):
            return None

    def write(self, scene: dict) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Give concurrent misses separate staging paths on the cache filesystem.
            with tempfile.TemporaryDirectory(prefix=".write-", dir=self.path.parent) as directory:
                staged = Path(directory) / self.path.name
                write_json(staged, {
                    "cache_key": self.cache_key,
                    "source_sha256": self.source_sha256,
                    "scene_ir": scene,
                    "scene_ir_sha256": _json_sha256(scene),
                })
                os.replace(staged, self.path)
        except (OSError, ValueError, RecursionError):
            pass
