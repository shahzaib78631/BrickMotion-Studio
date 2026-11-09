"""
Blender Cycles (Metal GPU) re-creation of BrickLink Studio's EyeSight render of a neural-shade
training scene: same geometry, EyeSight's own colours, the BUILD_FL light preset, white world,
shadow-catcher ground, composited over white.

  Blender -b --factory-startup --python scripts/neural/blender/render.py -- \
      <scene dir> <out.png> [--samples N] [--scale 0.5] [--geom <dir>] [--set key=value ...]

<scene dir> is data/neuralshade/scene_XXXXX. Its exported geometry is looked up in
--geom (default /private/tmp/claude-501/blender/geom/<id>); when missing it is exported first with
`npx tsx scripts/neural/blender/export-scene.ts` (run from the repository root).
"""
import bpy
import json
import math
import os
import struct
import subprocess
import sys
import time
import zlib

import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))

# ---------------------------------------------------------------------------------------------
# Tuned parameters (see the table in the report / README of this folder). Override: --set k=v
P = {
    'samples': 128,
    'adaptive_threshold': 0.01,
    'denoise': 1,
    # light preset BUILD_FL (settings_camera_light.xml): toward-light vectors in Studio's light
    # frame (x = camera right, y = away from camera, z = up), strengths × --light-intensity 0.7
    'light_intensity': 1.0,
    'key_strength': 1.187,       # Light_FL
    'fill_strength': 0.751,      # Light_RL, Light_FR, Light_RR
    'light_size': 1.0,         # EyeSight distant-light "size": disk radius at unit distance
    'light_frame': 'heading',  # 'heading' (rotate rig about Z with the camera), 'camera', 'world'
    'light_scale': 1.0,        # global multiplier on sun strengths
    'world_strength': 0.415,    # LEGO_StudioSet.xml background strength, colour = --param 0 (white)
    # SOLID-GROUP principled BSDF
    'roughness': 0.1,
    'ior': 1.45,
    'specular': 0.5,           # Specular IOR level (0.5 = as IOR says)
    'coat': 0.25,              # old Clearcoat 1.0 ≈ Coat Weight 0.25 in Principled v2
    'coat_roughness': 0.0,
    'coat_ior': 1.5,
    'sheen': 0.0,
    'trans_roughness': 0.02,
    'ao_gamma': 0.609,           # image × AO^gamma (bricks)
    'floor_ao_gamma': 0.587,     # ground × AO^gamma
    'floor_key_ratio': 0.807,    # key strength multiplier for the ground-shadow render
    'floor_scale': 0.5,        # resolution of the ground-shadow render (it is soft)
    'floor_samples': 32,
    'ao_samples': 32,
    'sheen_roughness': 0.5,
    'subsurface': 0.0,
    'bevel_radius': 0.0625,    # studs; EyeSight rounding_edge_normal size 0.05 in its units
    'bevel_samples': 4,
    'bump_strength': 0.0,      # NormalGroup noise bump (strength 0.2 in EyeSight)
    'bump_distance': 0.05,
    'bump_scale': 2.0,
    # ground
    'floor_albedo': 0.8,
    'catcher': 1,              # shadow catcher floor (EyeSight --shadow-ground)
    'floor_glossy': 0,         # floor seen in reflections
    'floor_diffuse': 0,        # floor bounces light onto bricks
    'bg': 1.0,                 # backdrop white level the image is composited over
    'exposure': 1.0,           # linear multiplier on the final image
    'diffuse_bounces': 3,
    'glossy_bounces': 4,
    'clamp_indirect': 40.0,
    'filter_width': 1.5,
}

# BUILD_FL: z axis of each light transform (row-major matrices in settings_camera_light.xml),
# normalised: the direction toward the light, in Studio's front = -y frame.
BUILD_FL = [
    ('Light_FL', (-0.02431, -0.01808, 0.02612), 'key'),
    ('Light_RL', (-0.02278, 0.02614, 0.01995), 'fill'),
    ('Light_FR', (0.02438, -0.00616, 0.03111), 'fill'),
    ('Light_RR', (0.02636, 0.02253, 0.01995), 'fill'),
]


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    pos, opts = [], {'scale': 1.0, 'geom': None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--samples':
            P['samples'] = int(argv[i + 1]); i += 2
        elif a == '--scale':
            opts['scale'] = float(argv[i + 1]); i += 2
        elif a == '--geom':
            opts['geom'] = argv[i + 1]; i += 2
        elif a == '--params':
            P.update(json.load(open(argv[i + 1]))); i += 2
        elif a == '--set':
            k, v = argv[i + 1].split('=', 1)
            if k not in P:
                raise SystemExit(f'unknown parameter {k}')
            P[k] = type(P[k])(v) if not isinstance(P[k], str) else v
            i += 2
        else:
            pos.append(a); i += 1
    if len(pos) < 2:
        raise SystemExit('usage: render.py -- <scene dir> <out.png> [--samples N] [--scale s] [--set k=v]')
    return pos[0], pos[1], opts


def ensure_geometry(scene_dir, geom):
    sid = os.path.basename(os.path.normpath(scene_dir)).replace('scene_', '')
    geom = geom or os.path.join('/private/tmp/claude-501/blender/geom', sid)
    if not os.path.exists(os.path.join(geom, 'scene.json')):
        root = os.path.dirname(geom)
        subprocess.run(['npx', 'tsx', os.path.join(HERE, 'export-scene.ts'), scene_dir, '--out', root], cwd=REPO, check=True)
    return geom


# ---------------------------------------------------------------------------------------------
def setup_device():
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'METAL'
    sc = bpy.context.scene
    sc.cycles.device = 'GPU'


def make_material(name, rgb, finish='solid'):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = P['roughness']
    bsdf.inputs['IOR'].default_value = P['ior']
    bsdf.inputs['Specular IOR Level'].default_value = P['specular']
    bsdf.inputs['Coat Weight'].default_value = P['coat']
    bsdf.inputs['Coat Roughness'].default_value = P['coat_roughness']
    bsdf.inputs['Coat IOR'].default_value = P['coat_ior']
    bsdf.inputs['Sheen Weight'].default_value = P['sheen']
    bsdf.inputs['Sheen Roughness'].default_value = P['sheen_roughness']
    if finish == 'trans':
        bsdf.inputs['Transmission Weight'].default_value = 1.0
        bsdf.inputs['Roughness'].default_value = P['trans_roughness']
        bsdf.inputs['IOR'].default_value = 1.49
        bsdf.inputs['Coat Weight'].default_value = 0.0
    elif finish in ('chrome', 'metal'):
        bsdf.inputs['Metallic'].default_value = 1.0
        bsdf.inputs['Roughness'].default_value = 0.08 if finish == 'chrome' else 0.3
    elif finish == 'pearl':
        bsdf.inputs['Metallic'].default_value = 0.6
        bsdf.inputs['Roughness'].default_value = 0.3
    elif finish == 'rubber':
        bsdf.inputs['Roughness'].default_value = 0.7
        bsdf.inputs['Coat Weight'].default_value = 0.0
    if P['subsurface'] > 0 and finish == 'solid':
        bsdf.inputs['Subsurface Weight'].default_value = P['subsurface']
        bsdf.inputs['Subsurface Radius'].default_value = (0.5, 0.5, 0.5)
        bsdf.inputs['Subsurface Scale'].default_value = 0.05
    normal = None
    if P['bump_strength'] > 0:
        tc = nodes.new('ShaderNodeTexCoord')
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = P['bump_scale']
        noise.inputs['Detail'].default_value = 0.0
        links.new(tc.outputs['Generated'], noise.inputs['Vector'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = P['bump_strength']
        bump.inputs['Distance'].default_value = P['bump_distance']
        links.new(noise.outputs['Fac'], bump.inputs['Height'])
        normal = bump.outputs['Normal']
    if P['bevel_radius'] > 0:
        bev = nodes.new('ShaderNodeBevel')
        bev.samples = P['bevel_samples']
        bev.inputs['Radius'].default_value = P['bevel_radius']
        if normal is not None:
            links.new(normal, bev.inputs['Normal'])
        normal = bev.outputs['Normal']
    if normal is not None:
        links.new(normal, bsdf.inputs['Normal'])
        links.new(normal, bsdf.inputs['Coat Normal'])
    return m


def build_scene(geom_dir, scale):
    meta = json.load(open(os.path.join(geom_dir, 'scene.json')))
    raw = np.fromfile(os.path.join(geom_dir, 'geom.bin'), dtype=np.float32)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene

    mats = {name: make_material(name, m['rgb'], m.get('finish', 'solid')) for name, m in meta['materials'].items()}

    # one mesh per part, roles as material slots linked per object (instances differ in colour)
    meshes, zmin = {}, math.inf
    part_minz = {}
    for part, roles in meta['parts'].items():
        if not roles:
            continue
        P_all, N_all, mat_idx = [], [], []
        for k, r in enumerate(roles):
            n = r['n']
            off = r['off']
            P_all.append(raw[off:off + n * 3].reshape(-1, 3))
            N_all.append(raw[off + n * 3:off + n * 6].reshape(-1, 3))
            mat_idx.append(np.full(n // 3, k, dtype=np.int32))
        pos = np.concatenate(P_all) / 1.0
        nrm = np.concatenate(N_all)
        nverts = len(pos)
        me = bpy.data.meshes.new(f'part_{part}')
        me.vertices.add(nverts)
        me.vertices.foreach_set('co', pos.ravel())
        nf = nverts // 3
        me.loops.add(nverts)
        me.loops.foreach_set('vertex_index', np.arange(nverts, dtype=np.int32))
        me.polygons.add(nf)
        me.polygons.foreach_set('loop_start', np.arange(0, nverts, 3, dtype=np.int32))
        me.polygons.foreach_set('loop_total', np.full(nf, 3, dtype=np.int32))
        me.polygons.foreach_set('material_index', np.concatenate(mat_idx))
        me.polygons.foreach_set('use_smooth', np.ones(nf, dtype=bool))
        me.update(calc_edges=True)
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        nrm = nrm / np.maximum(ln, 1e-8)
        me.normals_split_custom_set_from_vertices([tuple(v) for v in nrm])
        for _ in roles:
            me.materials.append(None)
        meshes[part] = me
        bb = np.array([pos.min(0), pos.max(0)])
        part_minz[part] = np.array([[x, y, z, 1.0] for x in bb[:, 0] for y in bb[:, 1] for z in bb[:, 2]])

    coll = sc.collection
    for i, inst in enumerate(meta['instances']):
        me = meshes.get(inst['part'])
        if me is None:
            continue
        ob = bpy.data.objects.new(f'p{i}', me)
        M = Matrix([inst['m'][0:4], inst['m'][4:8], inst['m'][8:12], inst['m'][12:16]])
        ob.matrix_world = M
        for k, mname in enumerate(inst['mats']):
            ob.material_slots[k].link = 'OBJECT'
            ob.material_slots[k].material = mats[mname]
        coll.objects.link(ob)
        Mn = np.array(M)
        zmin = min(zmin, float((part_minz[inst['part']] @ Mn.T)[:, 2].min()))

    # ground: EyeSight --shadow-ground puts a catcher at the lowest geometry
    floor_z = min(0.0, zmin) if math.isfinite(zmin) else 0.0
    bpy.ops.mesh.primitive_plane_add(size=20000, location=(0, 0, floor_z))
    floor = bpy.context.active_object
    fm = bpy.data.materials.new('floor')
    fm.use_nodes = True
    fb = fm.node_tree.nodes.get('Principled BSDF')
    fb.inputs['Base Color'].default_value = (P['floor_albedo'],) * 3 + (1,)
    fb.inputs['Roughness'].default_value = 1.0
    fb.inputs['Specular IOR Level'].default_value = 0.0
    floor.data.materials.append(fm)
    floor.is_shadow_catcher = bool(P['catcher'])
    floor.visible_glossy = bool(P['floor_glossy'])
    floor.visible_diffuse = bool(P['floor_diffuse'])

    # camera
    cam = meta['camera']
    cd = bpy.data.cameras.new('cam')
    cd.sensor_fit = 'VERTICAL'
    cd.angle_y = math.radians(cam['fov'])
    cd.clip_start = cam['near']
    cd.clip_end = cam['far'] * 4
    co = bpy.data.objects.new('cam', cd)
    pos, tgt = Vector(cam['position']), Vector(cam['target'])
    co.location = pos
    co.rotation_mode = 'QUATERNION'
    co.rotation_quaternion = (tgt - pos).to_track_quat('-Z', 'Y')
    coll.objects.link(co)
    sc.camera = co

    # lights: BUILD_FL in the camera's frame
    fwd = tgt - pos
    if P['light_frame'] == 'world':
        right, ahead, up = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    elif P['light_frame'] == 'camera':
        q = co.rotation_quaternion
        right, ahead, up = q @ Vector((1, 0, 0)), q @ Vector((0, 0, -1)), q @ Vector((0, 1, 0))
    else:
        ahead = Vector((fwd.x, fwd.y, 0)).normalized()
        up = Vector((0, 0, 1))
        right = ahead.cross(up)
    angle = 2 * math.atan(P['light_size'])
    for name, z, kind in BUILD_FL:
        v = Vector(z).normalized()
        L = (right * v.x + ahead * v.y + up * v.z).normalized()
        ld = bpy.data.lights.new(name, 'SUN')
        ld.energy = (P['key_strength'] if kind == 'key' else P['fill_strength']) * P['light_intensity'] * P['light_scale']
        ld.angle = angle
        lo = bpy.data.objects.new(name, ld)
        lo.rotation_mode = 'QUATERNION'
        lo.rotation_quaternion = L.to_track_quat('Z', 'Y')
        coll.objects.link(lo)

    # world: uniform white × strength
    w = bpy.data.worlds.new('world')
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    bg.inputs['Strength'].default_value = P['world_strength']
    sc.world = w

    # render settings
    r = sc.render
    r.engine = 'CYCLES'
    r.resolution_x = int(round(meta['width'] * scale))
    r.resolution_y = int(round(meta['height'] * scale))
    r.resolution_percentage = 100
    r.film_transparent = True
    r.use_persistent_data = False
    c = sc.cycles
    setup_device()
    c.samples = P['samples']
    c.use_adaptive_sampling = P['adaptive_threshold'] > 0
    if P['adaptive_threshold'] > 0:
        c.adaptive_threshold = P['adaptive_threshold']
    c.use_denoising = bool(P['denoise'])
    if P['denoise']:
        c.denoiser = 'OPENIMAGEDENOISE'
        try:
            c.denoising_use_gpu = True
        except AttributeError:
            pass
        c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    c.max_bounces = 32
    c.diffuse_bounces = P['diffuse_bounces']
    c.glossy_bounces = P['glossy_bounces']
    c.transmission_bounces = 32
    c.transparent_max_bounces = 32
    c.sample_clamp_direct = 0
    c.sample_clamp_indirect = P['clamp_indirect']
    c.pixel_filter_type = 'BLACKMAN_HARRIS'
    c.filter_width = P['filter_width']
    c.caustics_reflective = True
    c.caustics_refractive = True
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0
    sc.view_settings.gamma = 1
    return sc


def srgb_encode(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def write_png(path, rgb8):
    h, w, _ = rgb8.shape
    raw = b''.join(b'\x00' + rgb8[y].tobytes() for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 6)))
        f.write(chunk(b'IEND', b''))


def render_linear(sc, path):
    """Renders the current state to an EXR and returns the (h, w, 4) linear premultiplied array."""
    r = sc.render
    r.image_settings.file_format = 'OPEN_EXR'
    r.image_settings.color_depth = '32'
    r.image_settings.color_mode = 'RGBA'
    r.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    os.remove(path)
    return px.reshape(h, w, 4)[::-1].copy()


def make_ao_material():
    """White diffuse: rendered under the white world alone with no bounces it gives cosine-weighted ambient occlusion."""
    m = bpy.data.materials.new('ao_white')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type != 'OUTPUT_MATERIAL':
            nt.nodes.remove(n)
    d = nt.nodes.new('ShaderNodeBsdfDiffuse')
    d.inputs['Color'].default_value = (1, 1, 1, 1)
    nt.links.new(d.outputs['BSDF'], nt.nodes['Material Output'].inputs['Surface'])
    return m


def components(sc, out_npz):
    """Calibration mode: renders world / key / fill light separately with a plain (non-catcher)
    floor, plus a brick mask, so light weights can be fitted offline (the image is linear in them)."""
    floor = bpy.data.objects['Plane']
    floor.is_shadow_catcher = False
    sc.render.film_transparent = False
    world_bg = sc.world.node_tree.nodes.get('Background')
    lights = {o.name: o for o in sc.objects if o.type == 'LIGHT'}
    out = {}
    def set_on(world, names):
        world_bg.inputs['Strength'].default_value = 1.0 if world else 0.0
        for n, o in lights.items():
            o.data.energy = 1.0 if n in names else 0.0
    for comp, (world, names) in {
        'world': (True, []), 'key': (False, ['Light_FL']), 'fill': (False, ['Light_RL', 'Light_FR', 'Light_RR']),
    }.items():
        set_on(world, names)
        out[comp] = render_linear(sc, out_npz + f'.{comp}.exr')[..., :3]
    # ambient occlusion: white diffuse override, world only, no bounces
    set_on(True, [])
    ao_mat = make_ao_material()
    bpy.context.view_layer.material_override = ao_mat
    sc.cycles.diffuse_bounces = 0
    out['ao'] = render_linear(sc, out_npz + '.ao.exr')[..., :3].mean(-1)
    bpy.context.view_layer.material_override = None
    # mask: floor as holdout → alpha is coverage of bricks
    floor.is_holdout = True
    sc.render.film_transparent = True
    sc.cycles.samples = 8
    sc.cycles.use_denoising = False
    out['mask'] = render_linear(sc, out_npz + '.mask.exr')[..., 3]
    np.savez(out_npz, **out)


def main():
    scene_dir, out_png, opts = parse_args()
    t0 = time.time()
    geom = ensure_geometry(os.path.abspath(scene_dir), opts['geom'])
    sc = build_scene(geom, opts['scale'])
    if out_png.endswith('.npz'):
        components(sc, out_png)
        print(f'BLENDER_COMPONENTS_DONE {out_png} total={time.time() - t0:.1f}s')
        return
    t1 = time.time()
    tmp = out_png + '.tmp'
    floor = bpy.data.objects['Plane']
    lights = [o for o in sc.objects if o.type == 'LIGHT']
    energies = {o.name: o.data.energy for o in lights}
    world_bg = sc.world.node_tree.nodes.get('Background')

    # 1. beauty: bricks only (the ground is composited below), premultiplied RGBA
    floor.is_shadow_catcher = False
    floor.visible_camera = False
    beauty = render_linear(sc, tmp + '.beauty.exr')
    t2 = time.time()
    rgb, a = beauty[..., :3], beauty[..., 3:4]
    h, w = a.shape[:2]

    # 2. ambient occlusion: white diffuse under the white world alone, no bounces (bricks and ground)
    ao = None
    if P['ao_gamma'] > 0 or P['floor_ao_gamma'] > 0:
        floor.visible_camera = True
        sc.render.film_transparent = False
        bpy.context.view_layer.material_override = make_ao_material()
        for o in lights:
            o.data.energy = 0
        world_bg.inputs['Strength'].default_value = 1.0
        sc.cycles.diffuse_bounces = 0
        sc.cycles.samples = P['ao_samples']
        ao = np.clip(render_linear(sc, tmp + '.ao.exr')[..., :3].mean(-1, keepdims=True), 1e-4, 1)

    # 3. ground shadow of the sun lights alone: shadow catcher, world off, at reduced resolution
    floor.visible_camera = True
    floor.is_shadow_catcher = True
    sc.render.film_transparent = True
    bpy.context.view_layer.material_override = make_ao_material()
    world_bg.inputs['Strength'].default_value = 0.0
    for o in lights:
        o.data.energy = energies[o.name] * (P['floor_key_ratio'] if o.name == 'Light_FL' else 1.0)
    sc.cycles.samples = P['floor_samples']
    sc.render.resolution_percentage = int(round(100 * P['floor_scale']))
    lit = 1 - render_linear(sc, tmp + '.floor.exr')[..., 3:4]
    lit = resize_bilinear(lit, h, w)
    t3 = time.time()

    ground = np.clip(lit, 0, 1) * P['bg']
    bricks = rgb
    if ao is not None:
        ground = ground * ao ** P['floor_ao_gamma']
        bricks = rgb * ao ** P['ao_gamma']
    out = (bricks + (1 - a) * ground) * P['exposure']
    rgb8 = (srgb_encode(out) * 255 + 0.5).astype(np.uint8)
    write_png(out_png, np.ascontiguousarray(rgb8))
    print(f'BLENDER_RENDER_DONE {out_png} {w}x{h} samples={P["samples"]} setup={t1 - t0:.1f}s beauty={t2 - t1:.1f}s '
          f'ao+ground={t3 - t2:.1f}s total={time.time() - t0:.1f}s')


def resize_bilinear(img, h, w):
    sh, sw = img.shape[:2]
    if (sh, sw) == (h, w):
        return img
    ys = np.clip((np.arange(h) + 0.5) * sh / h - 0.5, 0, sh - 1)
    xs = np.clip((np.arange(w) + 0.5) * sw / w - 0.5, 0, sw - 1)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, sh - 1), np.minimum(x0 + 1, sw - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    top = img[y0][:, x0] * (1 - fx) + img[y0][:, x1] * fx
    bot = img[y1][:, x0] * (1 - fx) + img[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


main()
