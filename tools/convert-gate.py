"""Converts the Dark Portal, as exported by wow.export (OBJ + MTL + PNG + JSON), into what the animation
loads, and bakes the light on its stone. Run it through tools/convert-gate.ps1, which finds Blender:

    blender --background --factory-startup --python-exit-code 1 --python convert-gate.py -- <wow.export folder> <web folder>

It writes into the web folder:
    gate/gate.bin    vertices and triangles
    gate/light.png   the baked light: red = how much sky each bit of stone sees, green = the key light on it
    gate/*.png       the textures
    gate.js          what is where in gate.bin

Three models go in: the stone gate (a WMO), the green swirl that fills it and the sky round it (both M2).
The swirl is moved to where the gate's own effect model sits, which is where the game puts it. The gate
and the swirl stay in the gate model's own units and axes: x sideways, y up, z towards the viewer. The
sky stays in its own: it is drawn round the camera, wherever that is.
"""
import json
import math
import os
import shutil
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

SIZE = 2048                                       # the light map, in pixels each way
KEY = Vector((-0.45, 0.72, 0.53)).normalized()    # towards the key light: upper left, in front of the gate
FLOATS = 10                                       # per vertex: position, normal, texture uv, light map uv


def load_obj(path):
    """An OBJ and its MTL: positions, normals, uvs, the textures by material, and batches of triangles
    as (group, material, corners), a corner being the indices (position, uv, normal)."""
    v, vn, vt, batches, textures = [], [], [], [], {}
    group = material = ''
    corners = None
    folder = os.path.dirname(path)
    with open(path) as f:
        for line in f:
            p = line.split()
            if not p:
                continue
            if p[0] == 'v':
                v.append((float(p[1]), float(p[2]), float(p[3])))
            elif p[0] == 'vn':
                vn.append((float(p[1]), float(p[2]), float(p[3])))
            elif p[0] == 'vt':
                vt.append((float(p[1]), float(p[2])))
            elif p[0] == 'g':
                group, corners = (p[1] if len(p) > 1 else ''), None
            elif p[0] == 'usemtl':
                material, corners = p[1], None
            elif p[0] == 'mtllib':
                name = None
                with open(os.path.join(folder, line[7:].strip())) as mtl:
                    for m in mtl:
                        m = m.strip()
                        if m.startswith('newmtl '):
                            name = m[7:].strip()
                        elif m.startswith('map_Kd ') and name:
                            textures[name] = os.path.normpath(os.path.join(folder, m[7:].strip()))
            elif p[0] == 'f':
                if corners is None:
                    corners = []
                    batches.append((group, material, corners))
                c = [tuple(int(i) - 1 for i in s.split('/')) for s in p[1:]]
                for i in range(1, len(c) - 1):  # a fan, in case a face is not a triangle
                    corners.extend((c[0], c[i], c[i + 1]))
    return v, vn, vt, batches, textures


def bake(v, vn, corners, light_png):
    """Unwraps the stone and bakes its light into light_png. corners: every triangle corner of the stone.
    Returns the light map uv of each corner."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    scene = bpy.context.scene

    # The mesh, with vertices at the same spot welded so that the unwrap sees which faces touch.
    # Triangles that collapse to a line get no place in the light map; they cannot be seen anyway.
    spot, verts, faces, kept = {}, [], [], []
    for t in range(0, len(corners), 3):
        tri = []
        for c in corners[t:t + 3]:
            p = v[c[0]]
            if p not in spot:
                spot[p] = len(verts)
                verts.append(p)
            tri.append(spot[p])
        kept.append(len(set(tri)) == 3)
        if kept[-1]:
            faces.append(tri)
    mesh = bpy.data.meshes.new('gate')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    if len(mesh.polygons) != len(faces) or len(mesh.loops) != len(faces) * 3:
        raise RuntimeError('Blender changed the mesh while building it')
    mesh.polygons.foreach_set('use_smooth', [True] * len(faces))
    if hasattr(mesh, 'use_auto_smooth'):  # Blender before 4.1
        mesh.use_auto_smooth = True
    mesh.normals_split_custom_set([vn[c[2]] for t in range(0, len(corners), 3) if kept[t // 3] for c in corners[t:t + 3]])
    gate = bpy.data.objects.new('gate', mesh)
    scene.collection.objects.link(gate)

    # The ground it stands on, so no light comes up from below.
    low = min(p[1] for p in verts) - 0.5
    ground = bpy.data.meshes.new('ground')
    ground.from_pydata([(-4000, low, -4000), (4000, low, -4000), (4000, low, 4000), (-4000, low, 4000)], [], [(0, 1, 2, 3)])
    scene.collection.objects.link(bpy.data.objects.new('ground', ground))

    image = bpy.data.images.new('light', SIZE, SIZE, alpha=False)
    image.colorspace_settings.name = 'Non-Color'
    stone = bpy.data.materials.new('stone')
    if stone.node_tree is None:  # Blender before 5.0
        stone.use_nodes = True
    nodes = stone.node_tree.nodes
    nodes.clear()
    white = nodes.new('ShaderNodeBsdfDiffuse')
    white.inputs['Color'].default_value = (1, 1, 1, 1)
    stone.node_tree.links.new(white.outputs['BSDF'], nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])
    target = nodes.new('ShaderNodeTexImage')  # the bake goes into the selected image node
    target.image = image
    nodes.active = target
    mesh.materials.append(stone)

    world = bpy.data.worlds.new('sky')
    scene.world = world
    if world.node_tree is None:  # Blender before 5.0
        world.use_nodes = True
    world.node_tree.nodes.clear()
    sky = world.node_tree.nodes.new('ShaderNodeBackground')
    sky.inputs['Color'].default_value = (1, 1, 1, 1)
    world.node_tree.links.new(sky.outputs['Background'], world.node_tree.nodes.new('ShaderNodeOutputWorld').inputs['Surface'])

    started = time.time()
    mesh.uv_layers.new(name='light')
    bpy.context.view_layer.objects.active = gate
    gate.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002)
    bpy.ops.object.mode_set(mode='OBJECT')
    print('unwrapped %d triangles in %.0f s' % (len(faces), time.time() - started))

    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'

    def lit(samples):
        """The light falling on the stone right now, without the stone's own colour, as one value per pixel."""
        began = time.time()
        scene.cycles.samples = samples
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT'}, margin=3, use_clear=True)
        px = np.empty(SIZE * SIZE * 4, np.float32)
        image.pixels.foreach_get(px)
        print('baked a pass in %.0f s' % (time.time() - began))
        return px.reshape(SIZE, SIZE, 4)[:, :, 0].copy()

    # Pass 1: an evenly white sky, so each bit of stone gets as much light as it sees sky.
    sky.inputs['Strength'].default_value = 1.0
    from_sky = lit(128)
    # Pass 2: the key light alone, slightly soft, strong enough that stone facing it squarely gets 1.
    sky.inputs['Strength'].default_value = 0.0
    lamp = bpy.data.lights.new('key', 'SUN')
    lamp.energy = math.pi
    lamp.angle = math.radians(6)
    sun = bpy.data.objects.new('key', lamp)
    sun.rotation_euler = KEY.to_track_quat('Z', 'Y').to_euler()  # a sun shines down its own -z
    scene.collection.objects.link(sun)
    from_key = lit(64)

    out = np.zeros((SIZE, SIZE, 4), np.float32)
    out[:, :, 0], out[:, :, 1], out[:, :, 3] = from_sky, from_key, 1.0
    image.pixels.foreach_set(np.clip(out, 0.0, 1.0).ravel())
    image.filepath_raw = light_png
    image.file_format = 'PNG'
    image.save()

    uv = np.empty(len(mesh.loops) * 2, np.float32)
    mesh.uv_layers['light'].data.foreach_get('uv', uv)
    result, loop = [], 0
    for keep in kept:
        for _ in range(3):
            result.append((float(uv[loop * 2]), float(uv[loop * 2 + 1])) if keep else (0.0, 0.0))
            loop += keep
    return result


def num(x):
    return ('%.3f' % x).rstrip('0').rstrip('.')


def box(points):
    a = np.array(points, np.float32)
    return '[' + ', '.join(num(x) for x in list(a.min(0)) + list(a.max(0))) + ']'


def main(export, web):
    gate_path = os.path.join(export, 'world', 'wmo', 'outland', 'darkportal', 'darkportal_temple')
    swirl_path = os.path.join(export, 'world', 'expansion01', 'doodads', 'hellfirepeninsula', 'darkportal', 'hellfire_darkportal_fx.obj')
    sky_path = os.path.join(export, 'environments', 'stars', 'hellfireskybox.obj')
    out = os.path.join(web, 'gate')
    os.makedirs(out, exist_ok=True)

    # Where the gate places its effect model, in the game's axes (z up), turned a quarter round z.
    with open(gate_path + '.json') as f:
        place = json.load(f)['doodads'][0]
    if abs(place['rotation'][2] + 0.7071) > 0.001 or abs(place['rotation'][3] - 0.7071) > 0.001 or place['scale'] != 1:
        raise RuntimeError('The gate places its effect model differently than this tool expects: %r' % place)
    px, py, pz = place['position']

    v, vn, vt, batches, textures = load_obj(gate_path + '.obj')
    corners = [c for b in batches for c in b[2]]
    light = bake(v, vn, corners, os.path.join(out, 'light.png'))

    data, index, seen = [], [], {}

    def vertex(key, values):
        if key not in seen:
            seen[key] = len(data) // FLOATS
            data.extend(values)
        index.append(seen[key])

    js = ['// Written by tools/convert-gate.py from the models exported by wow.export: run tools/convert-gate.ps1 again',
          '// instead of editing this. Positions are in the gate model\'s own units and axes: x sideways, y up, z towards the viewer.',
          'const GATE = {', '  stone: [ // what to draw with which texture']
    n = 0
    for group, material, cs in batches:
        first = len(index)
        for c in cs:
            lm = (round(light[n][0], 5), round(light[n][1], 5))
            vertex(c + lm, v[c[0]] + vn[c[2]] + vt[c[1]] + lm)
            n += 1
        tex = os.path.basename(textures[material])
        shutil.copyfile(textures[material], os.path.join(out, tex))
        js.append("    { tex: '%s', first: %d, count: %d }," % (tex, first, len(cs)))
    stone_verts, stone_box = len(data) // FLOATS, box(v)

    # The swirl, into the gate's space: its sideways axis becomes the gate's x.
    v, vn, vt, batches, textures = load_obj(swirl_path)
    v = [(-z + px, y + pz, x - py) for x, y, z in v]
    vn = [(-z, y, x) for x, y, z in vn]
    seen.clear()
    js += ['  ],', '  swirl: [ // the effect\'s parts, numbered as in its model']
    portal = eyes = None
    for group, material, cs in batches:
        first = len(index)
        for c in cs:
            vertex(c, v[c[0]] + vn[c[2]] + vt[c[1]] + (0.0, 0.0))
        tex = os.path.basename(textures[material])
        shutil.copyfile(textures[material], os.path.join(out, tex))
        js.append("    { part: %s, tex: '%s', first: %d, count: %d }," % (group.replace('Geoset', ''), tex, first, len(cs)))
        points = [v[c[0]] for c in cs]
        if 'greenbackdrop' in tex:
            portal = box(points)
        if 'green_glow' in tex:  # each glow is a fan round a middle vertex that pokes forward
            front = max(p[2] for p in points)
            eyes = sorted({p for p in points if p[2] > front - 0.05})

    # The sky, as it is.
    v, vn, vt, batches, textures = load_obj(sky_path)
    seen.clear()
    js += ['  ],', '  sky: [ // the sky\'s parts, numbered as in its model']
    for group, material, cs in batches:
        first = len(index)
        for c in cs:
            vertex(c, v[c[0]] + vn[c[2]] + vt[c[1]] + (0.0, 0.0))
        tex = os.path.basename(textures[material])
        shutil.copyfile(textures[material], os.path.join(out, tex))
        js.append("    { part: %s, tex: '%s', first: %d, count: %d }," % (group.replace('Geoset', ''), tex, first, len(cs)))
    js += ['  ],',
           '  floats: %d, // gate/gate.bin: this many floats per vertex (position, normal, uv, light map uv), then 32-bit indices' % FLOATS,
           '  verts: %d, stoneVerts: %d, indices: %d, // the stone\'s vertices come first' % (len(data) // FLOATS, stone_verts, len(index)),
           '  box: %s, // the stone: min x, y, z, max x, y, z' % stone_box,
           '  portal: %s, // the swirl\'s flat backdrop: min x, y, z, max x, y, z' % portal,
           '  eyes: [%s], // the statues\' eyes' % ', '.join('[%s]' % ', '.join(num(x) for x in e) for e in eyes),
           '};', '']
    with open(os.path.join(out, 'gate.bin'), 'wb') as f:
        f.write(np.array(data, np.float32).tobytes())
        f.write(np.array(index, np.uint32).tobytes())
    with open(os.path.join(web, 'gate.js'), 'w', newline='\n') as f:
        f.write('\n'.join(js))
    print('stone: %d vertices, swirl and sky: %d vertices, %d triangles; written to %s' % (stone_verts, len(data) // FLOATS - stone_verts, len(index) // 3, out))


main(*sys.argv[sys.argv.index('--') + 1:][:2])
