from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
from typing import Any

from .errors import ContractError, SourceHashChanged


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def append_jsonl(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, sort_keys=True, ensure_ascii=False) + "\n")


class RunWorkspace:
    def __init__(self, source_file: Path, run_dir: Path, expected_source_sha256: str):
        self.original_source = source_file.resolve()
        self.run_dir = run_dir.resolve()
        self.expected_source_sha256 = expected_source_sha256.lower()
        self.input_source = self.run_dir / "input" / "source.blend"
        self.working_file = self.run_dir / "work" / "working.blend"
        self.checkpoints = self.run_dir / "work" / "checkpoints"
        self.reports = self.run_dir / "reports"
        self.delivery = self.run_dir / "delivery"
        self.export_dir = self.run_dir / "export"

    def prepare(self) -> None:
        if not self.original_source.is_file():
            raise ContractError(f"Source file does not exist: {self.original_source}")
        if self.run_dir.exists() and any(self.run_dir.iterdir()):
            raise ContractError(f"Run directory must be empty: {self.run_dir}")
        actual = file_sha256(self.original_source)
        if actual != self.expected_source_sha256:
            raise SourceHashChanged(
                "Source file hash does not match the contract",
                details={"expected": self.expected_source_sha256, "actual": actual},
            )
        for directory in [self.checkpoints, self.reports, self.delivery, self.export_dir]:
            directory.mkdir(parents=True, exist_ok=True)
        self.input_source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.original_source, self.input_source)
        copied_hash = file_sha256(self.input_source)
        if copied_hash != self.expected_source_sha256:
            raise SourceHashChanged(
                "Retained source copy does not match the contract hash",
                details={"expected": self.expected_source_sha256, "actual": copied_hash},
            )
        shutil.copy2(self.input_source, self.working_file)
        self.input_source.chmod(stat.S_IREAD)
        self.assert_source_unchanged()

    def assert_source_unchanged(self) -> None:
        actual = file_sha256(self.original_source)
        if actual != self.expected_source_sha256:
            raise SourceHashChanged(
                "Original source file changed during the run",
                details={"expected": self.expected_source_sha256, "actual": actual},
            )

    def checkpoint(self, name: str) -> Path:
        path = self.checkpoints / f"{name}.blend"
        shutil.copy2(self.working_file, path)
        return path

    def commit(self) -> Path:
        self.assert_source_unchanged()
        output = self.delivery / "output.blend"
        temporary = self.delivery / "output.blend.tmp"
        shutil.copy2(self.working_file, temporary)
        os.replace(temporary, output)
        return output

    def commit_export(self) -> Path:
        source = self.export_dir / "output.glb"
        if not source.is_file():
            raise ContractError(f"Validated GLB does not exist: {source}")
        output = self.delivery / "output.glb"
        temporary = self.delivery / "output.glb.tmp"
        shutil.copy2(source, temporary)
        os.replace(temporary, output)
        return output

    def discard_delivery(self) -> None:
        for name in ["output.blend", "output.blend.tmp", "output.glb", "output.glb.tmp", "quality_report.json"]:
            (self.delivery / name).unlink(missing_ok=True)

    def manifest(self, *, pending: bool = False) -> dict:
        output_source = self.working_file if pending else self.delivery / "output.blend"
        glb_source = self.export_dir / "output.glb" if pending else self.delivery / "output.glb"
        return {
            "source_sha256": self.expected_source_sha256,
            "source_copy_sha256": file_sha256(self.input_source),
            "working_sha256": file_sha256(self.working_file) if self.working_file.exists() else None,
            "output_sha256": file_sha256(output_source) if output_source.exists() else None,
            "output_glb_sha256": file_sha256(glb_source) if glb_source.exists() else None,
        }
