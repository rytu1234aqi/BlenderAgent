from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy


DEFAULT_VIEWS = ["overview", "front", "right", "cable"]


def render_previews(source: Path, output_dir: Path, views: list[str]) -> dict:
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    known_cameras = {view: f"Preview_{view.title()}" for view in DEFAULT_VIEWS}
    unknown = [view for view in views if view not in known_cameras]
    if unknown:
        raise ValueError(f"Unknown preview views: {unknown}")
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 960
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    output_dir.mkdir(parents=True, exist_ok=True)
    images = []
    for view in views:
        camera_name = f"Preview_{view.title()}"
        if camera_name not in bpy.data.objects:
            raise ValueError(f"Required fixed camera is missing: {camera_name}")
        scene.camera = bpy.data.objects[camera_name]
        path = output_dir / f"{view}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        images.append({"view": view, "camera": camera_name, "file": path.name})
    report = {
        "status": "RENDERED",
        "blender_version": bpy.app.version_string,
        "source": str(source),
        "views": images,
        "note": "Fixed-camera previews are visual aids, not geometry validation evidence.",
    }
    (output_dir / "preview_manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Render fixed teaching-rack cameras without modifying the source")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--views", nargs="+", choices=DEFAULT_VIEWS, default=DEFAULT_VIEWS)
    args = parser.parse_args(argv)
    report = render_previews(args.source.resolve(), args.output_dir.resolve(), args.views)
    print(json.dumps({"status": report["status"], "images": len(report["views"])}))


if __name__ == "__main__":
    main()
