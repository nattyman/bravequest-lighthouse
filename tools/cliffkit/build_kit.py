"""Cliff kit builder: sculpts the headland rock pieces in Blender (bpy module, headless) and writes js/cliffkit_data.js.

    pip install bpy --break-system-packages      # Blender 5.3 as a Python module
    python3 tools/cliffkit/build_kit.py          # rebuild js/cliffkit_data.js (deterministic)
    python3 tools/cliffkit/build_kit.py --shots DIR [--only buttress,arch] [--no-export]

Each piece: faceted convex-hull blocks (cut with booleans) -> voxel remesh -> bedding terraces along Z -> layered
procedural displacement (Voronoi cracks, cellular plates, cloud lumps) -> open back / buried base cut -> bake to vertex
colour (ray-traced ambient occlusion with the cliff/ground it sits against, cavity, bed tint, moss on up-facing parts)
-> collapse decimate to the piece's triangle budget -> hard edges split by angle -> quantised export.

Blender is Z-up with the piece's outward face toward -Y; the export turns that into the game's Y-up frame with the
outward face toward +Z. Units are metres. Origins (recorded per piece in the data as `origin`):
  back-base  centre of the back (attachment) plane, at the piece's foot       (buttress, scree)
  back-top   centre of the back plane, at the piece's top surface              (lip crag, ledge slab)
  base       centre of the footprint at the base                                (boulders, sea stacks, arch)
"""
import bpy, bmesh, math, random, sys, os, json, base64, struct, argparse, time
from mathutils import Vector, Matrix, Euler
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser()
ap.add_argument('--shots', default='')
ap.add_argument('--only', default='')
ap.add_argument('--no-export', action='store_true')
ap.add_argument('--out', default=os.path.join(ROOT, 'js', 'cliffkit_data.js'))
A = ap.parse_args([a for a in sys.argv[1:]])

# ---------------------------------------------------------------- palette (sRGB 0..1), matches world.js
def hexc(h): h = h.lstrip('#'); return Vector((int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255))
P = dict(rock=hexc('#5d6372'), rock2=hexc('#434957'), warm=hexc('#6c665f'), pale=hexc('#7a7e86'), seam=hexc('#30343e'),
         moss=hexc('#4a5e38'), mossDark=hexc('#34472b'), lichen=hexc('#8a8a6a'), wet=hexc('#2f343d'), lime=hexc('#c9c5b8'))

def lerp(a, b, t): return a + (b - a) * t
def clamp(x, a=0.0, b=1.0): return a if x < a else b if x > b else x
def smooth(a, b, x): t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t)
def hash1(i, s=0): x = math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - math.floor(x)

# ---------------------------------------------------------------- scene helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for t in list(bpy.data.textures): bpy.data.textures.remove(t)

def link(obj):
    bpy.context.scene.collection.objects.link(obj); return obj

def mesh_obj(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return link(bpy.data.objects.new(name, me))

def apply_mods(obj):
    """bake the modifier stack into the mesh (evaluated copy), then clear the stack"""
    dg = bpy.context.evaluated_depsgraph_get(); ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    old = obj.data; obj.modifiers.clear(); obj.data = me; bpy.data.meshes.remove(old)
    return obj

def bake_transform(obj):
    obj.data.transform(obj.matrix_basis); obj.matrix_basis = Matrix.Identity(4)

def remove(obj):
    me = obj.data; bpy.data.objects.remove(obj, do_unlink=True)
    if me and me.users == 0: bpy.data.meshes.remove(me)

def hull(name, pts):
    bm = bmesh.new()
    for p in pts: bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=bm.verts)
    for v in list(res.get('geom_interior', [])) + list(res.get('geom_unused', [])):
        if isinstance(v, bmesh.types.BMVert) and v.is_valid: bm.verts.remove(v)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm)

def block(rng, c, s, rot=(0, 0, 0), chamfer=0.18, jit=0.08, bulge=0.06, extra=6):
    """a chunky faceted block: a box with randomly truncated corners (crisp bevel planes) + a few bulged face points"""
    cx, cy, cz = c; sx, sy, sz = s; pts = []
    for ix in (-1, 1):
        for iy in (-1, 1):
            for iz in (-1, 1):
                ch = chamfer * (0.4 + rng.random() * 1.2)
                corner = Vector((ix * sx / 2 * (1 + (rng.random() - .5) * jit), iy * sy / 2 * (1 + (rng.random() - .5) * jit), iz * sz / 2 * (1 + (rng.random() - .5) * jit)))
                for ax in range(3):
                    q = corner.copy(); q[ax] -= (ix, iy, iz)[ax] * ch * (sx, sy, sz)[ax] * (0.5 + rng.random() * 0.6); pts.append(q)
    for _ in range(extra):  # bulges on random faces
        ax = rng.randrange(3); sg = rng.choice((-1, 1)); q = Vector(((rng.random() - .5) * sx * .7, (rng.random() - .5) * sy * .7, (rng.random() - .5) * sz * .7))
        q[ax] = sg * (sx, sy, sz)[ax] / 2 * (1 + bulge * rng.random()); pts.append(q)
    M = Matrix.Translation(Vector(c)) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
    return hull('blk', [M @ p for p in pts])

def boulder(rng, c, r, squash=(1, 1, .75), n=26, facet=0.12):
    """rounded weathered boulder: hull of jittered points on an ellipsoid (few points = big planes)"""
    pts = []
    for i in range(n):
        z = 1 - 2 * (i + .5) / n; rr = math.sqrt(max(0, 1 - z * z)); a = i * 2.39996 + rng.random() * .6
        k = 1 + (rng.random() - .5) * 2 * facet
        pts.append(Vector((math.cos(a) * rr * r * squash[0] * k, math.sin(a) * rr * r * squash[1] * k, z * r * squash[2] * k)))
    M = Matrix.Translation(Vector(c)) @ Euler((rng.random() * .4, rng.random() * .4, rng.random() * 6.28), 'XYZ').to_matrix().to_4x4()
    return hull('bld', [M @ p for p in pts])

def drum(rng, c, r0, r1, h, sides=7, jit=.14, rot=0.0):
    """a tapered faceted drum (a sea-stack course): two jittered polygons hulled"""
    pts = []
    for ring, (rr, z) in enumerate(((r0, -h / 2), (r1, h / 2))):
        for i in range(sides):
            a = rot + i / sides * 6.2832 + (rng.random() - .5) * .35; k = 1 + (rng.random() - .5) * 2 * jit
            pts.append(Vector((math.cos(a) * rr * k, math.sin(a) * rr * k, z + (rng.random() - .5) * h * .12)))
        # chamfer ring just inside each cap
        for i in range(sides):
            a = rot + (i + .5) / sides * 6.2832; pts.append(Vector((math.cos(a) * rr * .82, math.sin(a) * rr * .82, z * (1.06 if ring else 1.04))))
    return hull('drm', [Matrix.Translation(Vector(c)) @ p for p in pts])

def join(objs, name):
    """union through the voxel remesher later; here just merge the meshes into one object"""
    bm = bmesh.new()
    for o in objs:
        o.data.transform(o.matrix_world); bm.from_mesh(o.data); remove(o)
    return mesh_obj(name, bm)

def boolean(obj, cutter, op='DIFFERENCE'):
    m = obj.modifiers.new('b', 'BOOLEAN'); m.operation = op; m.object = cutter
    m.solver = 'EXACT'
    apply_mods(obj); remove(cutter); return obj

def cut_box(c, s, rot=(0, 0, 0)):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    o = mesh_obj('cut', bm); o.scale = s; o.location = c; o.rotation_euler = rot; bake_transform(o); return o

def remesh(obj, voxel):
    m = obj.modifiers.new('r', 'REMESH'); m.mode = 'VOXEL'; m.voxel_size = voxel; m.adaptivity = 0.0; m.use_smooth_shade = False
    return apply_mods(obj)

_tex = {}
def tex(kind, **kw):
    key = kind + json.dumps(kw, sort_keys=True)
    if key in _tex: return _tex[key]
    t = bpy.data.textures.new('t%d' % len(_tex), type=kind)
    for k, v in kw.items(): setattr(t, k, v)
    _tex[key] = t; return t

def displace(obj, t, strength, offset=(0, 0, 0), scale=1.0, mid=0.5):
    e = bpy.data.objects.new('tc', None); link(e); e.location = offset; e.scale = (scale, scale, scale)
    m = obj.modifiers.new('d', 'DISPLACE'); m.texture = t; m.texture_coords = 'OBJECT'; m.texture_coords_object = e
    m.strength = strength; m.mid_level = mid; m.direction = 'NORMAL'
    apply_mods(obj); bpy.data.objects.remove(e, do_unlink=True); return obj

def smooth_corrective(obj, factor=.5, reps=3):
    m = obj.modifiers.new('s', 'SMOOTH'); m.factor = factor; m.iterations = reps; return apply_mods(obj)

def terrace(obj, bed=1.2, depth=.25, warp=.35, lean=.5, seed=0, zmin=-99, zmax=99, axis_out=None):
    """bedding: each bed of thickness `bed` leans back toward its top and a groove runs along each seam.
    Vertices move horizontally along their own horizontal normal (so vertical faces step in and out)."""
    me = obj.data; me.update()
    rng = random.Random(seed); ph = rng.random() * 10
    for v in me.vertices:
        p = v.co; n = v.normal; hn = Vector((n.x, n.y, 0))
        if hn.length < .25 or p.z < zmin or p.z > zmax: continue
        hn.normalize()
        w = warp * (math.sin(p.x * .37 + ph) + .6 * math.sin(p.y * .53 + ph * 1.7) + .4 * math.sin((p.x + p.y) * 1.1 + ph))
        f = (p.z / bed + w) % 1.0
        bi = math.floor(p.z / bed + w)
        bd = depth * (0.6 + 0.8 * hash1(bi, seed))        # some beds are harder (stand prouder) than others
        groove = 1 - smooth(0.0, 0.14, f) * smooth(1.0, 0.9, f)
        off = -bd * (lean * f + 1.2 * groove)
        v.co = p + hn * off * (1 - abs(n.z))
    me.update()

# ---------------------------------------------------------------- baking to vertex colour
FIB = []
for i in range(40):
    z = 1 - (i + .5) / 40; r = math.sqrt(1 - z * z); a = i * 2.39996; FIB.append(Vector((math.cos(a) * r, math.sin(a) * r, z)))

def frame(n):
    t = Vector((0, 0, 1)) if abs(n.z) < .9 else Vector((1, 0, 0))
    b = n.cross(t).normalized(); t = b.cross(n); return t, b

def bake(obj, spec):
    """returns per-vertex [(r,g,b) palette colour, ao] for the (dense) mesh. AO is ray-traced against the mesh itself and
    the surfaces the piece rests on (the cliff behind an attachment piece, the ground / sea floor under a free one)."""
    me = obj.data; me.update()
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table(); bvh = BVHTree.FromBMesh(bm)
    maxd = spec.get('aoDist', 2.5); back = spec['origin'].startswith('back'); gz = spec.get('groundZ', None)
    # cavity: concave (pointiness-like) curvature from the 1-ring
    cav = [0.0] * len(bm.verts)
    for v in bm.verts:
        if not v.link_edges: continue
        s = Vector(); el = 0
        for e in v.link_edges: o = e.other_vert(v); s += o.co; el += (o.co - v.co).length
        s /= len(v.link_edges); el /= len(v.link_edges)
        cav[v.index] = (v.normal.dot(s - v.co)) / max(el, 1e-4)
    out = []
    seed = spec.get('seed', 1); bed = spec.get('bed', 1.2)
    lo = spec['zmin']; hi = spec['zmax']
    for v in bm.verts:
        p = v.co; n = v.normal
        t, b = frame(n); occ = 0.0; tot = 0.0; o = p + n * .03
        for d0 in FIB[::2]:
            d = (t * d0.x + b * d0.y + n * d0.z).normalized(); w = d0.z; tot += w
            hit = bvh.ray_cast(o, d, maxd)
            dist = hit[3] if hit[0] is not None else 1e9
            if back and d.y > 1e-3: dist = min(dist, (0 - o.y) / d.y if o.y < 0 else 0)
            if gz is not None and d.z < -1e-3: dist = min(dist, (gz - o.z) / d.z if o.z > gz else 0)
            if dist < maxd: occ += w * (1 - dist / maxd) ** .7
        ao = 1 - occ / tot
        cv = clamp(cav[v.index] * 1.6, -1, 1)
        # bed tint: alternate the palette rock tones per bed, dark seams, warm iron streaks
        zz = p.z / bed + .3 * math.sin(p.x * .37 + seed) + .2 * math.sin(p.y * .53 + seed * 2)
        bi = math.floor(zz); f = zz - bi
        h = hash1(bi, seed)
        c = P['rock'].lerp(P['rock2'], .65 if h < .34 else 0).lerp(P['warm'], .55 if h > .72 else 0)
        c = c.lerp(P['pale'], .25 * smooth(.5, .9, hash1(bi + 7, seed)))
        c = c.lerp(P['seam'], .55 * (1 - smooth(0, .1, f)))
        c = c.lerp(P['pale'], .35 * smooth(.05, .5, -cv))           # worn edges catch the light
        c = c.lerp(P['seam'], .35 * smooth(.05, .5, cv))            # cracks and hollows hold dirt
        up = n.z
        if spec.get('moss', True):
            mk = smooth(.45, .8, up) * (0.55 + .45 * hash1(math.floor(p.x * 1.3) + 31 * math.floor(p.y * 1.3), seed + 3))
            c = c.lerp(P['moss'].lerp(P['mossDark'], .4 * (1 - ao)), clamp(mk * spec.get('mossK', 1)))
            c = c.lerp(P['lichen'], .22 * smooth(.2, .6, up) * smooth(.6, .9, hash1(math.floor(p.x * 2) + 17 * math.floor(p.z * 2), seed + 9)))
        if spec.get('wet') is not None:                             # sea pieces: dark wet foot, pale bird lime on top
            c = c.lerp(P['wet'], .7 * (1 - smooth(spec['wet'], spec['wet'] + 1.6, p.z)))
        if spec.get('lime'):
            c = c.lerp(P['lime'], .45 * smooth(hi - 2.5, hi - .2, p.z) * smooth(.1, .6, up))
        out.append((c, clamp(ao * (1 - .25 * clamp(cv)) )))
    bm.free()
    return out

def transfer_colours(dense, dense_cols, low):
    """low-poly vertex -> mean of the nearest dense vertices (the bake lives on the dense mesh)"""
    kd = KDTree(len(dense.data.vertices))
    for i, v in enumerate(dense.data.vertices): kd.insert(v.co, i)
    kd.balance()
    res = []
    for v in low.data.vertices:
        near = kd.find_n(v.co, 6); c = Vector(); a = 0; ws = 0
        for (co, i, d) in near:
            w = 1 / (d + .03); c += dense_cols[i][0] * w; a += dense_cols[i][1] * w; ws += w
        res.append((c / ws, a / ws))
    return res

def decimate(obj, tris):
    me = obj.data; me.calc_loop_triangles(); n = len(me.loop_triangles)
    if n > tris:
        m = obj.modifiers.new('dp', 'DECIMATE'); m.decimate_type = 'DISSOLVE'; m.angle_limit = math.radians(1.5); apply_mods(obj)
        m = obj.modifiers.new('tr', 'TRIANGULATE'); apply_mods(obj)
        me = obj.data; me.calc_loop_triangles(); n = len(me.loop_triangles)
    if n > tris:
        m = obj.modifiers.new('dc', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = tris / n; m.use_collapse_triangulate = True
        apply_mods(obj)
    m = obj.modifiers.new('tr', 'TRIANGULATE'); apply_mods(obj)
    obj.data.calc_loop_triangles(); return len(obj.data.loop_triangles)

def hard_edges(obj, angle):
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.view_layer.objects: o.select_set(o == obj)
    try: bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle), keep_sharp_edges=False)
    except TypeError: bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))

# ---------------------------------------------------------------- the pieces
def plane_cut(obj, co, no):
    """remove everything on the +no side of the plane (leaves the cut open: backs and buried bases are never seen)"""
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=Vector(co), plane_no=Vector(no), clear_outer=True)
    bm.to_mesh(obj.data); bm.free(); obj.data.update(); return obj

def top_to_origin(obj):
    zt = max(v.co.z for v in obj.data.vertices); obj.data.transform(Matrix.Translation((0, 0, -zt))); obj.data.update(); return obj

def back_cut(obj, ymin=0.0, zbot=None, ztop=None):
    """flat open back at y=0 (attachment plane), optional flat cuts below zbot / above ztop"""
    plane_cut(obj, (0, ymin, 0), (0, 1, 0))
    if zbot is not None: plane_cut(obj, (0, 0, zbot), (0, 0, -1))
    if ztop is not None: plane_cut(obj, (0, 0, ztop), (0, 0, 1))
    return obj

def crack_layers(obj, rng, k=1.0, cells=1.6, plates=.9, lumps=.25):
    """layered procedural displacement: Voronoi crack network (F2-F1), cellular plates (F1), cloud lumps"""
    off = (rng.random() * 50, rng.random() * 50, rng.random() * 50)
    displace(obj, tex('VORONOI', distance_metric='DISTANCE', color_mode='INTENSITY', weight_1=-1.0, weight_2=1.0, weight_3=0.0, weight_4=0.0, noise_intensity=1.0),
             .22 * k, off, 1 / cells, mid=.35)
    displace(obj, tex('VORONOI', distance_metric='DISTANCE', color_mode='INTENSITY', weight_1=1.0, weight_2=0.0, weight_3=0.0, weight_4=0.0, noise_intensity=1.0),
             -.18 * k * plates, off, 1 / (cells * 2.2), mid=.5)
    displace(obj, tex('CLOUDS', noise_basis='BLENDER_ORIGINAL', noise_scale=1.0, noise_depth=2, noise_type='SOFT_NOISE'),
             .9 * k * lumps, off, 1 / (cells * 3.5), mid=.5)

def carve(name, pts, rng, cuts=5, depth=(.25, .9), zbias=(-.45, .65), keep_back=False):
    """hand-carved block: the convex hull of `pts`, then `cuts` random planes shave wedges off it (each leaves a crisp
    flat facet). Planes with a +Y normal are skipped when keep_back (the attachment plane stays whole)."""
    bm = bmesh.new()
    for p in pts: bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    for _ in range(cuts):
        a = rng.random() * 6.2832; z = lerp(zbias[0], zbias[1], rng.random())
        d = Vector((math.cos(a), math.sin(a), z)).normalized()
        if keep_back and d.y > .2: d.y = -d.y
        sup = max(v.co.dot(d) for v in bm.verts); mn = min(v.co.dot(d) for v in bm.verts)
        off = sup - min((sup - mn) * .28, lerp(depth[0], depth[1], rng.random()))
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=d * off, plane_no=d, clear_outer=True)
        pv = [v.co.copy() for v in bm.verts]; bm.clear()
        for p in pv: bm.verts.new(p)
        bmesh.ops.convex_hull(bm, input=bm.verts)
    for v in [v for v in bm.verts if not v.link_faces]: bm.verts.remove(v)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm)

def sections(rng, levels, jit=.12, rot=0.0):
    """points of stacked horizontal sections: levels = [(z, [(x, y), ...]), ...] each jittered"""
    pts = []
    for z, poly in levels:
        for (x, y) in poly:
            pts.append(Vector((x * (1 + (rng.random() - .5) * jit) + (rng.random() - .5) * jit, y * (1 + (rng.random() - .5) * jit), z + (rng.random() - .5) * jit * 2)))
    if rot: pts = [Euler((0, 0, rot)).to_matrix() @ p for p in pts]
    return pts

def prow(hw, d, sk=0.0):
    """a buttress cross-section against a face at y=0: back corners, angled cheeks and a blunt, off-centre nose"""
    return [(-hw, 0), (hw, 0), (hw * .95, -d * .45), (hw * .55 + sk, -d * .9), (sk, -d), (-hw * .45 + sk, -d * .92), (-hw * .92, -d * .5)]

def ngon(r, n, ex=1.0, ey=1.0, ph=0.0):
    return [(math.cos(ph + i / n * 6.2832) * r * ex, math.sin(ph + i / n * 6.2832) * r * ey) for i in range(n)]

def shift(pts, v):
    v = Vector(v); return [p + v for p in pts]

def piece_buttress(rng):
    """tall buttress: an angular prow of rock standing out of the face, tapering as it climbs, with a lower shoulder
    on each side and a jutting bed part way up"""
    L = [(-1.6, prow(4.6, 5.4, .4)), (3.5, prow(4.1, 4.9, .2)), (8.5, prow(3.3, 3.9, -.3)), (13.5, prow(2.5, 2.7, .1)), (18.0, prow(1.5, 1.4, .2))]
    parts = [carve('main', sections(rng, L, .1), rng, cuts=7, keep_back=True)]
    parts.append(carve('shL', sections(rng, [(-1.6, prow(2.4, 3.6)), (4.5, prow(2.0, 2.9)), (8.0, prow(1.1, 1.4))], .12), rng, cuts=4, keep_back=True))
    parts[-1].location = (-4.4, 0, 0); bake_transform(parts[-1])
    parts.append(carve('shR', sections(rng, [(-1.6, prow(2.0, 3.0)), (2.6, prow(1.8, 2.6)), (5.5, prow(1.0, 1.2))], .12), rng, cuts=4, keep_back=True))
    parts[-1].location = (4.6, 0, 0); bake_transform(parts[-1])
    parts.append(carve('bed', sections(rng, [(9.2, prow(3.9, 4.6, -.2)), (10.4, prow(3.7, 4.5, -.2))], .06), rng, cuts=3, zbias=(-.1, .1), keep_back=True))
    o = remesh(join(parts, 'buttress'), .2)
    for k in range(2):  # vertical joints down the front
        x = (-1.4 if k else 1.0) + (rng.random() - .5) * .8
        o = boolean(o, cut_box((x, -5, 5.5 + k * 3), (.42, 3.6, 10 - k * 3), (0, .06 * (k * 2 - 1), .35 - k * .7)))
    o = remesh(o, .16)
    terrace(o, bed=1.7, depth=.14, lean=.35, seed=11)
    crack_layers(o, rng, k=.75, cells=2.0, lumps=.2)
    return back_cut(o, 0, -1.4, None)

def piece_lipcrag(rng):
    """overhanging lip crag: a heavy cap bed thrusting out from under the lip, the rock beneath it cut back into an
    undercut wedge, so seen from below it breaks the edge of the plateau"""
    cap = [(0, prow(4.4, 4.4, .3)), (-1.1, prow(4.5, 5.4, .5)), (-2.6, prow(4.0, 4.6, .3))]
    body = [(-2.3, prow(3.5, 3.3, -.2)), (-4.6, prow(2.9, 2.4, .1)), (-7.4, prow(1.3, 1.0, .3))]
    horn = [(-.4, ngon(1.0, 6, 1.2, .9)), (-2.4, ngon(.9, 6, 1.1, .8)), (-3.4, ngon(.3, 5))]
    parts = [carve('cap', sections(rng, cap, .08), rng, cuts=6, zbias=(-.5, .3), keep_back=True),
             carve('body', sections(rng, body, .12), rng, cuts=5, keep_back=True),
             carve('horn', shift(sections(rng, horn, .15), (-2.4, -3.9, .2)), rng, cuts=3)]
    o = remesh(join(parts, 'lipcrag'), .17)
    o = boolean(o, cut_box((1.3, -5, -3), (.38, 3.8, 6), (0, .1, .4)))
    o = remesh(o, .14)
    terrace(o, bed=1.1, depth=.16, lean=.3, seed=23)
    crack_layers(o, rng, k=.7, cells=1.7, lumps=.2)
    return top_to_origin(back_cut(o, 0, None, None))

def piece_slab(rng):
    """ledge slab: a thick bed jutting from the face with a level top and broken front edge; under it the rock is
    cut back, so the slab reads as a ledge with a shadow line"""
    top = [(0, prow(4.8, 4.0, .2)), (-1.0, prow(4.9, 4.4, .3)), (-2.1, prow(4.3, 3.4, .1))]
    parts = [carve('slab', sections(rng, top, .07), rng, cuts=6, zbias=(-.25, .2), keep_back=True)]
    for k in range(2):
        x = -2.6 + k * 4.4 + (rng.random() - .5)
        blk = [(-.25 - k * .3, ngon(1.3, 5, 1.2, .8)), (-1.9 - k * .2, ngon(1.1, 5, 1.1, .7))]
        parts.append(carve('brk', shift(sections(rng, blk, .15), (x, -3.6 - k * .3, 0)), rng, cuts=3))
    parts.append(carve('under', sections(rng, [(-1.9, prow(3.6, 2.4)), (-3.2, prow(2.4, 1.2))], .1), rng, cuts=3, keep_back=True))
    o = remesh(join(parts, 'slab'), .15)
    o = boolean(o, cut_box((1.8, -4.2, -.6), (1.0, 2.6, 4), (0, 0, .6)))                           # a broken-off notch
    o = remesh(o, .13)
    terrace(o, bed=.75, depth=.1, lean=.3, seed=37)
    crack_layers(o, rng, k=.6, cells=1.5, lumps=.15)
    return top_to_origin(back_cut(o, 0, None, None))

def piece_scree(rng):
    """scree fan: angular fallen blocks heaped against the foot of a face, steep at the back, thinning out in front"""
    body = [Vector((x, 0, z)) for x, z in ((-1.6, 3.1), (1.6, 3.1), (-3.2, 0), (3.2, 0), (-2.2, 1.9), (2.2, 1.9))]
    for i in range(9):
        a = -1.25 + i / 8 * 2.5; body.append(Vector((math.sin(a) * 6.3, -math.cos(a) * 5.2, -.1)))
        body.append(Vector((math.sin(a) * 3.3, -math.cos(a) * 2.8, 1.45)))
    parts = [carve('fan', body, rng, cuts=2, zbias=(.3, .9), keep_back=True)]
    for i in range(17):
        a = (rng.random() - .5) * 2.3; rr = .8 + rng.random() ** .7 * 5.0
        x = math.sin(a) * rr; y = -math.cos(a) * rr * .85
        s = lerp(1.9, .7, rr / 5.8) * (.65 + rng.random() * .6)
        zt = max(0, 3.1 * (1 - rr / 5.9)) + s * .2
        pts = [Vector(((rng.random() - .5) * s * 2, (rng.random() - .5) * s * 1.6, (rng.random() - .5) * s * 1.1)) for _ in range(9)]
        parts.append(carve('blk', shift(pts, (x, y, zt)), rng, cuts=2))
    o = remesh(join(parts, 'scree'), .11)
    crack_layers(o, rng, k=.3, cells=.9, lumps=.1)
    return back_cut(o, 0, -.35, None)

def piece_boulders(rng):
    """boulder cluster: a few big weathered boulders leaning together, smaller stones round their feet"""
    def bould(c, r, sq, n, cuts):
        pts = []
        for i in range(n):
            z = 1 - 2 * (i + .5) / n; rr = math.sqrt(max(0, 1 - z * z)); a = i * 2.39996 + rng.random() * .6; k = 1 + (rng.random() - .5) * .25
            pts.append(Vector((math.cos(a) * rr * r * sq[0] * k, math.sin(a) * rr * r * sq[1] * k, z * r * sq[2] * k)))
        return carve('b', shift([Euler((rng.random() * .3, rng.random() * .3, rng.random() * 6.28)).to_matrix() @ p for p in pts], c), rng, cuts=cuts, depth=(.1, .3))
    parts = [bould((0, 0, 1.05), 1.95, (1.15, .95, .8), 16, 4), bould((2.3, .9, .6), 1.3, (1, .9, .75), 14, 3),
             bould((-2.0, 1.2, .5), 1.1, (1.1, .9, .7), 13, 3), bould((.7, -2.1, .45), .95, (1, 1, .7), 12, 3)]
    for i in range(6):
        a = rng.random() * 6.28; r = 2.5 + rng.random() * 1.5
        parts.append(bould((math.cos(a) * r, math.sin(a) * r, .1), .32 + rng.random() * .3, (1, 1, .7), 10, 1))
    o = remesh(join(parts, 'boulders'), .1)
    smooth_corrective(o, .35, 2)
    crack_layers(o, rng, k=.4, cells=1.1, lumps=.25)
    terrace(o, bed=.6, depth=.05, seed=41)
    return plane_cut(o, (0, 0, -0.4), (0, 0, -1))

def piece_stack_tall(rng):
    """sea stack, tall: three bedded courses stacked off-centre and turned against each other, narrowing upward to a
    tilted flat top, on a broad wave-cut foot with a notch at the waterline"""
    parts = [carve('foot', sections(rng, [(-3, ngon(5.0, 7, 1, .8)), (1.0, ngon(4.7, 7, 1, .78, .2))], .1), rng, cuts=4, zbias=(-.2, .4))]
    z = .6; r = 4.0; x = 0; y = 0; ph = 0
    for k, h in enumerate((5.0, 4.4, 4.0)):
        r1 = r * .86; ph += .5 + rng.random() * .4
        L = [(z, ngon(r, 6, 1, .78, ph)), (z + h * .55, ngon(r * .97, 6, 1, .8, ph + .12)), (z + h + .5, ngon(r1, 6, 1, .76, ph + .2))]
        parts.append(carve('c%d' % k, shift(sections(rng, L, .1), (x, y, 0)), rng, cuts=5, zbias=(-.3, .35)))
        z += h; r = r1 * .92; x += (rng.random() - .3) * .9; y += (rng.random() - .5) * .6
    cap = [(z - .2, ngon(r * 1.12, 6, 1, .8, ph + .4)), (z + 1.0, ngon(r * 1.05, 6, 1, .8, ph + .5))]
    c = carve('cap', shift(sections(rng, cap, .06), (x + .4, y, 0)), rng, cuts=3, zbias=(-.1, .1)); c.rotation_euler = (.07, -.1, 0); bake_transform(c)
    parts.append(c)
    o = remesh(join(parts, 'stackTall'), .2)
    o = boolean(o, cut_box((.5, -3.5, 8), (.42, 3.0, 11), (0, .05, .3)))
    o = remesh(o, .17)
    terrace(o, bed=1.3, depth=.3, lean=.45, seed=53)
    terrace(o, bed=4.0, depth=.55, seed=54, zmin=-.6, zmax=1.6)
    crack_layers(o, rng, k=.85, cells=1.8, lumps=.18)
    return plane_cut(o, (0, 0, -2.6), (0, 0, -1))

def piece_stack_squat(rng):
    """sea stack, squat skerry: three broad bedded tiers with level tops, a fallen block at one corner"""
    parts = [carve('t0', sections(rng, [(-2.2, ngon(5.0, 8, 1, .75)), (1.3, ngon(4.6, 8, 1, .72, .2))], .08), rng, cuts=5, zbias=(-.2, .4)),
             carve('t1', shift(sections(rng, [(1.0, ngon(3.4, 7, 1, .75)), (3.3, ngon(3.0, 7, 1, .72, .3))], .08), (-.6, .3, 0)), rng, cuts=4, zbias=(-.2, .4)),
             carve('t2', shift(sections(rng, [(3.1, ngon(1.8, 6, 1, .8)), (4.7, ngon(1.3, 6, 1, .75))], .1), (.3, -.1, 0)), rng, cuts=3),
             carve('fall', shift(sections(rng, [(-1, ngon(1.4, 5)), (1.9, ngon(1.1, 5, 1, .8, .4))], .2), (4.1, -2.3, 0)), rng, cuts=3)]
    o = remesh(join(parts, 'stackSquat'), .14)
    terrace(o, bed=.95, depth=.2, lean=.35, seed=61)
    terrace(o, bed=4.0, depth=.45, seed=62, zmin=-.6, zmax=1.4)
    crack_layers(o, rng, k=.85, cells=1.6, lumps=.2)
    return plane_cut(o, (0, 0, -2.2), (0, 0, -1))

def piece_arch(rng):
    """small sea arch: a thick leg and a slimmer one under a sagging lintel bed, the opening bored through"""
    parts = [carve('legL', shift(sections(rng, [(-3, ngon(2.8, 7, 1, .85)), (5, ngon(2.3, 7, 1, .8, .3)), (8.6, ngon(2.0, 6, 1, .8))], .1), (-4.4, 0, 0)), rng, cuts=5),
             carve('legR', shift(sections(rng, [(-3, ngon(2.3, 7, 1, .85)), (4.5, ngon(1.9, 7, 1, .8, .2)), (8.0, ngon(1.9, 6, 1, .8))], .1), (4.3, .2, 0)), rng, cuts=5),
             carve('lintel', sections(rng, [(5.6, [(-6.4, -1.9), (6.4, -1.7), (6.5, 1.8), (-6.2, 2.0), (0, -1.6), (0, 1.7)]),
                                            (8.8, [(-5.6, -1.5), (5.4, -1.4), (5.6, 1.6), (-5.4, 1.7), (-1, -1.6), (-1, 1.7)])], .06), rng, cuts=4, zbias=(-.3, .3))]
    o = remesh(join(parts, 'arch'), .2)
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=1.0, radius2=1.0, depth=12)
    cyl = mesh_obj('bore', bm); cyl.rotation_euler = (math.pi / 2, 0, .05); cyl.scale = (2.6, 4.4, 1); cyl.location = (.1, 0, 1.4); bake_transform(cyl)
    o = boolean(o, cyl)
    o = remesh(o, .16)
    terrace(o, bed=1.25, depth=.25, lean=.35, seed=71)
    terrace(o, bed=4.0, depth=.45, seed=72, zmin=-.6, zmax=1.5)
    crack_layers(o, rng, k=.85, cells=1.7, lumps=.2)
    return plane_cut(o, (0, 0, -2.4), (0, 0, -1))

PIECES = [
    # name, builder, tri budget, origin, bake extras, hard-edge angle
    ('buttress',   piece_buttress,    1800, 'back-base', dict(bed=1.45, aoDist=3.0), 38),
    ('lipcrag',    piece_lipcrag,     1500, 'back-top',  dict(bed=1.05, aoDist=2.5, mossK=1.2), 38),
    ('slab',       piece_slab,         900, 'back-top',  dict(bed=.8, aoDist=2.0, mossK=1.3), 40),
    ('scree',      piece_scree,       1100, 'back-base', dict(bed=.7, aoDist=1.6, groundZ=-.05, mossK=.25), 42),
    ('boulders',   piece_boulders,     950, 'base',      dict(bed=.55, aoDist=1.8, groundZ=0.0, mossK=1.1), 48),
    ('stackTall',  piece_stack_tall,  1500, 'base',      dict(bed=1.25, aoDist=3.0, wet=.4, lime=True, mossK=.7), 38),
    ('stackSquat', piece_stack_squat, 1300, 'base',      dict(bed=.95, aoDist=2.5, wet=.3, lime=True, mossK=.9), 38),
    ('arch',       piece_arch,        1500, 'base',      dict(bed=1.2, aoDist=3.0, wet=.4, lime=True, mossK=.8), 38),
]

# ---------------------------------------------------------------- export
def b64(fmt, vals): return base64.b64encode(struct.pack('<%d%s' % (len(vals), fmt), *vals)).decode()

def export_piece(name, obj, cols, origin, budget):
    me = obj.data; me.calc_loop_triangles()
    try: me.calc_normals_split()
    except Exception: pass
    cn = me.corner_normals if hasattr(me, 'corner_normals') else None
    verts = {}; vlist = []; idx = []
    for lt in me.loop_triangles:
        tri = []
        for li, vi in zip(lt.loops, lt.vertices):
            n = Vector(cn[li].vector) if cn is not None else Vector(me.loops[li].normal)
            q = (vi, round(n.x * 127), round(n.y * 127), round(n.z * 127))
            if q not in verts: verts[q] = len(vlist); vlist.append((vi, n))
            tri.append(verts[q])
        # Blender CCW (Z-up, -Y out) -> game Y-up: (x, z, -y) keeps handedness, so the winding stays
        idx += tri
    co = [Vector((me.vertices[vi].co.x, me.vertices[vi].co.z, -me.vertices[vi].co.y)) for vi, _ in vlist]
    mn = Vector((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co)))
    mx = Vector((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co)))
    ext = mx - mn; q = []
    for c in co:
        for k in range(3): q.append(int(round((c[k] - mn[k]) / max(ext[k], 1e-6) * 65535)) - 32768)
    nq = []
    for vi, n in vlist:
        g = Vector((n.x, n.z, -n.y)).normalized(); nq += [int(round(g.x * 127)), int(round(g.y * 127)), int(round(g.z * 127))]
    cq = []
    for vi, n in vlist:
        c, a = cols[vi]; cq += [int(round(clamp(c.x) * 255)), int(round(clamp(c.y) * 255)), int(round(clamp(c.z) * 255)), int(round(clamp(a) * 255))]
    return dict(name=name, origin=origin, tris=len(idx) // 3, verts=len(vlist), budget=budget,
                min=[round(v, 4) for v in mn], max=[round(v, 4) for v in mx], size=[round(v, 3) for v in ext],
                p=b64('h', q), n=b64('b', nq), c=b64('B', cq), i=b64('H', idx))

# ---------------------------------------------------------------- contact sheet
def contact_sheet(objs, outdir):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading; sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = False; sh.show_shadows = True
    sh.studio_light = 'Default' if 'Default' in [l.name for l in bpy.context.preferences.studio_lights] else sh.studio_light
    sc.display.shadow_focus = .2
    sc.render.resolution_x = 1100; sc.render.resolution_y = 520; sc.render.film_transparent = False
    world = bpy.data.worlds.new('w'); sc.world = world; world.color = (.46, .48, .55)
    sc.display_settings.display_device = 'sRGB'
    try: sc.view_settings.view_transform = 'Standard'
    except Exception: pass
    # lay out in a row (two rows when many)
    x = 0; row = []
    for o in objs:
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]; w = max(v.x for v in bb) - min(v.x for v in bb)
        o.location.x = x - min(v.x for v in bb) + o.location.x; x += w + 2.5; row.append(o)
        zmin = min(v.z for v in bb)
        if zmin < -.5 and o.get('origin') == 'back-top': o.location.z -= zmin
    cx = x / 2 - 1.25
    # a ground plane under the free pieces and a back wall behind the attachment pieces (dark, so the shapes read)
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=200)
    gnd = mesh_obj('ground', bm); gnd.location = (cx, 0, -.02)
    gnd.data.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
    for d in gnd.data.color_attributes['Col'].data: d.color_srgb = (.30, .33, .30, 1)
    cam_d = bpy.data.cameras.new('cam'); cam = link(bpy.data.objects.new('cam', cam_d)); sc.camera = cam
    cam_d.type = 'ORTHO'; cam_d.ortho_scale = x * 1.0
    views = [('front', (0, -1, .32)), ('three-quarter', (.75, -1, .55)), ('below', (.15, -1, -.18)), ('top', (.02, -.25, 1))]
    files = []
    for nm, d in views:
        dv = Vector(d).normalized(); cam.location = Vector((cx, 0, 6)) + dv * 120
        cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
        gnd.hide_render = nm == 'below'
        f = os.path.join(outdir, 'blender-%s.png' % nm); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
    # close-ups: each piece alone at 3/4
    for o in objs: o.hide_render = True
    for o in objs:
        o.hide_render = False
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]; c = sum(bb, Vector()) / 8; r = max((v - c).length for v in bb)
        dv = Vector((.8, -1, .45)).normalized(); cam.location = c + dv * 80; cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
        cam_d.ortho_scale = r * 2.3; sc.render.resolution_x = 520; sc.render.resolution_y = 420
        f = os.path.join(outdir, 'blender-piece-%s.png' % o.name); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
        o.hide_render = True
    return files

# ---------------------------------------------------------------- main
def main():
    reset()
    only = set(A.only.split(',')) if A.only else None
    out = []; low_objs = []; t0 = time.time()
    for k, (name, fn, budget, origin, extra, angle) in enumerate(PIECES):
        if only and name not in only: continue
        t1 = time.time()
        rng = random.Random(1000 + k * 7919)
        dense = fn(rng); dense.name = name + '_dense'
        me = dense.data; me.update()
        zs = [v.co.z for v in me.vertices]
        spec = dict(extra); spec.update(origin=origin, seed=k * 13 + 5, zmin=min(zs), zmax=max(zs))
        cols = bake(dense, spec)
        low = bpy.data.objects.new(name, dense.data.copy()); link(low)
        tris = decimate(low, budget)
        hard_edges(low, angle)
        lc = transfer_colours(dense, cols, low)
        remove(dense)
        rec = export_piece(name, low, lc, origin, budget); out.append(rec)
        # vertex colour for the contact sheet: palette x AO
        ca = low.data.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
        for i, (c, a) in enumerate(lc):
            s = (.45 + .55 * a) * 1.45; ca.data[i].color_srgb = (min(1, c.x * s), min(1, c.y * s), min(1, c.z * s), 1)
        low.data.color_attributes.active_color = ca
        low['origin'] = origin; low_objs.append(low)
        print('%-11s tris %5d  verts %5d  size %s  %.1fs' % (name, rec['tris'], rec['verts'], rec['size'], time.time() - t1), flush=True)
    if not A.no_export and not only:
        data = dict(v=1, axes='y-up, outward face +z, metres', pieces={r['name']: r for r in out})
        js = ('/* generated by tools/cliffkit/build_kit.py (Blender %s) -- do not edit by hand */\n' % bpy.app.version_string +
              '(function(){window.G=window.G||{};G.cliffkitData=' + json.dumps(data, separators=(',', ':')) + ';})();\n')
        open(A.out, 'w').write(js)
        print('wrote', A.out, len(js), 'bytes', flush=True)
    if A.shots:
        os.makedirs(A.shots, exist_ok=True)
        for f in contact_sheet(low_objs, A.shots): print('shot', f)
    print('done in %.1fs' % (time.time() - t0))

main()
