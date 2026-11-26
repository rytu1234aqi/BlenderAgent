import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]


class ExampleTests(unittest.TestCase):
    def test_move_request_example_is_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "rack.blend"
            source.write_bytes(b"request-generation-fixture")
            output = root / "request.json"
            environment = os.environ.copy()
            environment["PYTHONPATH"] = str(PROJECT / "src")
            subprocess.run(
                [
                    sys.executable,
                    str(PROJECT / "examples" / "make_move_request.py"),
                    str(source),
                    "--output",
                    str(output),
                    "--run-dir",
                    str(root / "run"),
                ],
                check=True,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            request = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(request["contract"]["source_sha256"]), 64)
            self.assertEqual([item["tool"] for item in request["operations"]], ["move_part", "move_curve_endpoint"])


if __name__ == "__main__":
    unittest.main()
