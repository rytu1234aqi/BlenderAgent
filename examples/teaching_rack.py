"""Build the original, procedurally authored ICT teaching rack (Blender 4.4)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector


U = 0.04445
CAMERAS = {
    "Preview_Overview": {"location": [3.2, -4.4, 2.8], "target": [0, 0, 1.05], "lens": 58},
    "Preview_Front": {"location": [0, -4.0, 1.08], "target": [0, 0, 1.08], "ortho_scale": 2.55},
    "Preview_Right": {"location": [4.0, -0.02, 1.12], "target": [0, 0, 1.12], "ortho_scale": 2.5},
    "Preview_Cable": {"location": [1.25, -2.3, 1.75], "target": [0.02, -0.28, 1.43], "lens": 65},
}


def material(name, color, metallic=0.0, roughness=0.45, emission=None):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if emission:
        shader.inputs["Emission Color"].default_value = (*color, 1)
        shader.inputs["Emission Strength"].default_value = emission
    return result


def box(name, dimensions, location, mat=None, parent=None, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
    if bevel:
        modifier = obj.modifiers.new("Manufactured edge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    return obj


def empty(name, location, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.035
    obj.parent = parent
    return obj


def cable(name, points, mat, radius=0.006):
    data = bpy.data.curves.new(f"{name}_data", "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 2
    data.bevel_depth = radius
    data.bevel_resolution = 3
    spline = data.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, position in zip(spline.points, points):
        point.co = (*position, 1)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    return obj


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_camera(name, specification):
    data = bpy.data.cameras.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = specification["location"]
    aim(obj, specification["target"])
    if "ortho_scale" in specification:
        data.type = "ORTHO"
        data.ortho_scale = specification["ortho_scale"]
    else:
        data.lens = specification["lens"]
    data.clip_start = 0.01
    data.clip_end = 100
    return obj


def build(output: Path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene["asset_title"] = "BlendGuard ICT Teaching Rack"
    scene["rack_unit_m"] = U
    scene["asset_license"] = "Original procedural geometry; project-owned"

    graphite = material("rack_graphite", (0.055, 0.075, 0.095), metallic=0.65)
    silver = material("brushed_aluminium", (0.38, 0.46, 0.52), metallic=0.75)
    chassis = material("server_chassis", (0.12, 0.17, 0.21), metallic=0.6)
    panel = material("server_front_panel", (0.025, 0.045, 0.065), metallic=0.35)
    black = material("port_black", (0.008, 0.012, 0.018), roughness=0.65)
    blue = material("panel_blue", (0.025, 0.22, 0.7), metallic=0.25)
    cyan = material("status_cyan", (0.02, 0.8, 0.95), emission=3)
    green = material("status_green", (0.08, 0.85, 0.22), emission=2)
    orange = material("cable_orange", (1.0, 0.19, 0.025), roughness=0.32)
    yellow = material("cable_yellow", (0.95, 0.68, 0.025), roughness=0.35)
    floor_mat = material("studio_floor", (0.19, 0.22, 0.25), roughness=0.8)

    rack = empty("rack", [0, 0, 0])
    rack["asset_role"] = "rack_root"
    rack["rack_unit_m"] = U
    for x, side in [(-0.30, "left"), (0.30, "right")]:
        for y, face in [(-0.34, "front"), (0.34, "rear")]:
            box(f"rack_post_{side}_{face}", [0.04, 0.04, 2.02], [x, y, 1.06], silver, rack, 0.003)
    box("rack_roof", [0.64, 0.74, 0.045], [0, 0, 2.085], graphite, rack, 0.005)
    box("rack_base", [0.64, 0.74, 0.075], [0, 0, 0.075], graphite, rack, 0.005)
    box("rack_rear_panel", [0.57, 0.014, 1.94], [0, 0.345, 1.08], graphite, rack, 0.003)
    for x, side in [(-0.318, "left"), (0.318, "right")]:
        box(f"rack_side_{side}", [0.012, 0.65, 1.88], [x, 0.015, 1.08], graphite, rack, 0.003)
        for z in [0.28, 0.62, 0.96, 1.30, 1.64, 1.94]:
            box(f"rack_rail_{side}_{z:.2f}", [0.018, 0.022, 0.025], [x * 0.89, -0.36, z], silver, rack)
    box("rack_header_blue", [0.49, 0.022, 0.07], [0, -0.373, 2.015], blue, rack, 0.003)
    for index in range(5):
        box(f"header_mark_{index + 1}", [0.045, 0.004, 0.012], [-0.16 + index * 0.08, -0.387, 2.015], cyan, rack)
    for index, z in enumerate([0.69, 0.99, 1.29, 1.59], start=1):
        box(f"rack_shelf_{index:02d}", [0.55, 0.62, 0.018], [0, -0.005, z - U - 0.009], silver, rack, 0.002)
        server = box(f"server_{index:02d}", [0.48, 0.60, 2 * U], [0, -0.015, z], chassis, rack, 0.004)
        server["asset_role"] = "server"
        server["rack_units"] = 2
        box(f"server_{index:02d}_front", [0.465, 0.018, 0.076], [0, -0.309, 0], panel, server, 0.002)
        for side, x in [("left", -0.218), ("right", 0.218)]:
            box(f"server_{index:02d}_handle_{side}", [0.018, 0.045, 0.06], [x, -0.333, 0], silver, server, 0.003)
        for bay in range(3):
            x = -0.145 + bay * 0.076
            box(f"server_{index:02d}_drive_{bay + 1}", [0.064, 0.014, 0.052], [x, -0.326, 0], black, server, 0.001)
            box(f"server_{index:02d}_drive_mark_{bay + 1}", [0.044, 0.003, 0.006], [x, -0.335, 0.015], silver, server)
        for vent in range(4):
            box(f"server_{index:02d}_vent_{vent + 1}", [0.004, 0.005, 0.038], [0.07 + vent * 0.014, -0.323, 0], silver, server)
        box(f"server_{index:02d}_display", [0.043, 0.005, 0.022], [0.145, -0.323, 0.012], blue, server)
        box(f"server_{index:02d}_status", [0.012, 0.008, 0.012], [0.15, -0.33, -0.021], green, server, 0.002)
        box(f"server_{index:02d}_network_socket", [0.038, 0.018, 0.025], [0.192, -0.325, 0], black, server, 0.002)
        port = empty(f"server_{index:02d}_port", [0.192, -0.342, 0], server)
        port["asset_role"] = "network_port"
        box(f"server_{index:02d}_label", [0.055, 0.003, 0.012], [-0.173, -0.325, 0.033], blue, server)

    switch = box("switch_01", [0.48, 0.40, U], [0, -0.09, 1.86], silver, rack, 0.003)
    switch["asset_role"] = "network_switch"
    box("switch_01_front", [0.465, 0.018, 0.035], [0, -0.208, 0], panel, switch)
    for index in range(8):
        x = -0.18 + index * 0.051
        box(f"switch_01_socket_{index + 1:02d}", [0.035, 0.014, 0.021], [x, -0.222, 0], black, switch, 0.001)
        box(f"switch_01_led_{index + 1:02d}", [0.009, 0.004, 0.005], [x, -0.232, 0.014], green, switch)
        empty(f"switch_01_port_{index + 1:02d}", [x, -0.235, 0], switch)

    # Endpoints coincide with the declared port empties. Intermediate points make
    # the orange patch lead visibly hang in front of the rack rather than inside it.
    cable("cable_07", [
        [-0.129, -0.325, 1.86],
        [-0.13, -0.47, 1.80],
        [0.21, -0.48, 1.48],
        [0.192, -0.357, 1.29],
    ], orange)
    cable("cable_02", [
        [-0.078, -0.325, 1.86],
        [-0.08, -0.43, 1.76],
        [0.26, -0.44, 1.68],
        [0.192, -0.357, 1.59],
    ], yellow)
    box("demo_floor", [200, 200, 0.02], [0, 0, -0.025], floor_mat)

    for name, specification in CAMERAS.items():
        add_camera(name, specification)
    scene.camera = bpy.data.objects["Preview_Overview"]
    for name, location, power, size in [
        ("Key_Light", [1.5, -2.7, 4], 650, 3),
        ("Fill_Light", [-2.5, -1.0, 2.5], 400, 2.5),
        ("Rim_Light", [1.2, 2.2, 3.2], 700, 2),
    ]:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power
        data.shape = "DISK"
        data.size = size
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = location
        aim(obj, [0, 0, 1])
    world = bpy.data.worlds.new("Studio_World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.22, 0.27, 0.33, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.45
    scene.world = world
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 960
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"

    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    manifest = {
        "asset_version": "1.0",
        "title": "ICT Teaching Rack",
        "source": output.name,
        "protected_objects": ["rack", "demo_floor"],
        "previews": {
            "directory": "previews",
            "views": {view: f"{view}.png" for view in ("overview", "front", "right", "cable")},
        },
        "license": "Original procedural geometry; no external assets",
        "rack_unit_m": U,
        "editable_roles": {"server": [f"server_{index:02d}" for index in range(1, 5)]},
        "aliases": {"机柜": "rack", "交换机": "switch_01"},
        "cameras": CAMERAS,
        "connections": [
            {"cable": "cable_07", "end": "end", "port": "server_03_port", "target": "server_03"},
            {"cable": "cable_07", "end": "start", "port": "switch_01_port_02", "target": "switch_01"},
            {"cable": "cable_02", "end": "end", "port": "server_04_port", "target": "server_04"},
            {"cable": "cable_02", "end": "start", "port": "switch_01_port_03", "target": "switch_01"},
        ],
    }
    (output.parent / "asset_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"TEACHING_RACK={output}")
    print(f"OBJECTS={len(scene.objects)}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args(argv)
    build(args.output.resolve())


if __name__ == "__main__":
    main()
