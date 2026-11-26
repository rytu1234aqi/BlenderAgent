from __future__ import annotations

import argparse
from pathlib import Path

from blendguard.scene_ir import object_id_for
from blendguard.workspace import file_sha256, write_json


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a server translation example request")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    server = object_id_for("server_03")
    port = object_id_for("server_03_port", "EMPTY")
    cable = object_id_for("cable_07", "CURVE")
    request = {
        "source_file": str(source),
        "run_dir": str(args.run_dir.resolve()),
        "contract": {
            "contract_version": "1.0",
            "scene_ir_version": "1.0",
            "run_id": args.run_dir.name,
            "source_sha256": file_sha256(source),
            "instruction": "Move server_03 down 1U and update only cable_07",
            "targets": [server],
            "dependencies": [cable],
            "write_set": [
                f"scene.objects.{server}.local_transform.location",
                f"scene.objects.{cable}.curve.splines.0.points.1.co",
            ],
            "derived_allowances": [
                {"relation": "children_world_transform", "root_object_id": server}
            ],
            "freeze_set": ["materials", "animations", "cameras", "lights"],
            "constraints": [
                {
                    "id": "server_translation",
                    "type": "translation_delta",
                    "target": server,
                    "axis": "z",
                    "delta": -0.04445,
                    "tolerance": 0.00001,
                },
                {"type": "dimensions_unchanged", "target": server, "tolerance": 0.00001},
                {
                    "id": "cable_connection",
                    "type": "endpoint_distance",
                    "endpoint": f"{cable}:end",
                    "target_port": port,
                    "max_distance": 0.00001,
                },
                {"type": "object_count_unchanged"},
            ],
            "retry_budget": 0,
            "export": {"enabled": False},
        },
        "operations": [
            {
                "operation_id": "move_server",
                "tool": "move_part",
                "arguments": {"object_id": server, "axis": "z", "delta": -0.04445},
            },
            {
                "operation_id": "update_cable",
                "tool": "move_curve_endpoint",
                "arguments": {
                    "object_id": cable,
                    "end": "end",
                    "target_port_object_id": port,
                },
            },
        ],
    }
    write_json(args.output, request)
    print(args.output)


if __name__ == "__main__":
    main()
