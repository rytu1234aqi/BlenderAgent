from pathlib import Path
import sys

import bpy


argv = sys.argv[sys.argv.index("--") + 1:]
output = Path(argv[0])
bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
rack = bpy.context.object
rack.name = "rack"

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1))
server = bpy.context.object
server.name = "server_03"
server.dimensions = (0.48, 0.65, 0.0889)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
server.parent = rack

material = bpy.data.materials.new("server_black")
material.diffuse_color = (0.02, 0.02, 0.02, 1)
server.data.materials.append(material)
panel_blue = bpy.data.materials.new("panel_blue")
panel_blue.diffuse_color = (0.02, 0.2, 0.8, 1)
panel_blue.use_fake_user = True

bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.24, 0, 0))
port = bpy.context.object
port.name = "server_03_port"
port.parent = server

curve = bpy.data.curves.new("cable_07_data", type="CURVE")
curve.dimensions = "3D"
curve.bevel_depth = 0.002
curve.bevel_resolution = 1
spline = curve.splines.new("POLY")
spline.points.add(1)
spline.points[0].co = (-0.3, 0, 0.5, 1)
spline.points[1].co = (0.24, 0, 1, 1)
cable = bpy.data.objects.new("cable_07", curve)
bpy.context.collection.objects.link(cable)

bpy.ops.object.camera_add(location=(3, -4, 3))
camera = bpy.context.object
camera.name = "Camera"
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(1, -2, 4))
bpy.context.object.name = "Key Light"

bpy.context.scene.unit_settings.system = "METRIC"
bpy.context.scene.unit_settings.scale_length = 1.0
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(output))
