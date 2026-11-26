from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy

from .blender_scene import inspect_scene
from .workspace import write_json


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser(description="Read-only Blender scene inspection")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    args = parser.parse_args(argv)
    bpy.ops.wm.open_mainfile(filepath=str(args.source), load_ui=False, use_scripts=False)
    write_json(args.result, inspect_scene())


if __name__ == "__main__":
    main()
