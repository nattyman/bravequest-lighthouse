"""Tree kit builder: grows the forest oaks and pines in Blender (bpy module, headless) and writes js/treekit_data.js.

    pip install bpy --break-system-packages      # Blender 5.3 as a Python module
    python3 tools/florakit/build_trees.py                     # rebuild js/treekit_data.js (deterministic)
    python3 tools/florakit/build_trees.py --shots DIR [--only oak0,pine1] [--no-export]

Oaks: a branch skeleton (trunk with root flare, a few thick limbs that fork and taper) skinned with the Skin modifier,
subdivided, given vertical bark ridges by a stretched texture displacement; the canopy is one metaball family per leaf
clump (a big core ball ringed by smaller lobes, so each clump has a scalloped outline), flattened underneath, each
decimated on its own so the gaps between clumps stay open. Pines: a skinned tapering trunk with a few dead stubs and
whorls of drooping, splayed boughs of irregular length (each a flat leaf-shaped pad with a ridge). Snag: a dead oak.
Each form is built three times from one skeleton and one set of clumps or boughs, so the levels share their outline:
LOD0 full; LOD1 the same skin without subdivision and each clump decimated from its LOD0 mesh (pines: every bough with
fewer rings); LOD2 each clump as a decimated hull of its LOD0 mesh (pines: one star per whorl whose points are the
boughs' own tips). Lower clumps are stretched back to their LOD0 clump's bounds, and lower levels take their colours and
canopy normals from the nearest LOD0 surface, so the switch between levels changes little but the facet count.
Colour is baked per vertex: ray-traced ambient occlusion against the whole tree and the ground, lit tops and dark
undersides, warm clumps, bark tone variation and moss on the north and upper sides. Canopy normals lean out from
each clump's centre (pines: from the trunk) so the toon ramp shades each mass round.
Blender is Z-up; the export turns that into the game's Y-up frame (x, z, -y), origin at the foot, metres.
"""
import bpy, bmesh, math, random, sys, os, json, base64, struct, argparse, time
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser()
ap.add_argument('--shots', default='')
ap.add_argument('--only', default='')
ap.add_argument('--no-export', action='store_true')
ap.add_argument('--out', default=os.path.join(ROOT, 'js', 'treekit_data.js'))
A = ap.parse_args(sys.argv[1:])

def hexc(h): h = h.lstrip('#'); return Vector((int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255))
P = dict(bark=hexc('#4a3b31'), bark2=hexc('#30261f'), barkG=hexc('#565049'), moss=hexc('#41562f'), mossL=hexc('#58703c'),
         dark=hexc('#23332a'), mid=hexc('#3a5331'), lite=hexc('#617c47'), warm=hexc('#7d7646'), gold=hexc('#8a7a3e'),
         pdark=hexc('#1c2c21'), pmid=hexc('#2c442e'), plite=hexc('#4c6a47'), pbark=hexc('#3a2c24'),
         snag=hexc('#6a6259'), snag2=hexc('#3e3833'))

def lerp(a, b, t): return a + (b - a) * t
def clamp(x, a=0.0, b=1.0): return a if x < a else b if x > b else x
def smooth(a, b, x): t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t)
def hash1(i, s=0): x = math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - math.floor(x)
def vnoise(x, y, z, s=0):
    return .5 + .25 * math.sin(x * 1.7 + s) * math.cos(y * 1.3 - s * .7) + .25 * math.sin(z * 2.1 + x * .6 + s * 1.9)

# ---------------------------------------------------------------- blender helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def link(obj): bpy.context.scene.collection.objects.link(obj); return obj

def remove(obj):
    me = obj.data if obj.type == 'MESH' else None; bpy.data.objects.remove(obj, do_unlink=True)
    if me and me.users == 0: bpy.data.meshes.remove(me)

def evaluated_mesh(obj):
    dg = bpy.context.evaluated_depsgraph_get(); ev = obj.evaluated_get(dg)
    return bpy.data.meshes.new_from_object(ev, depsgraph=dg)

def apply_mods(obj):
    me = evaluated_mesh(obj); old = obj.data; obj.modifiers.clear(); obj.data = me
    if old.users == 0: bpy.data.meshes.remove(old)
    return obj

def decimate(obj, tris):
    m = obj.modifiers.new('tr', 'TRIANGULATE'); apply_mods(obj)
    me = obj.data; me.calc_loop_triangles(); n = len(me.loop_triangles)
    if n > tris:
        m = obj.modifiers.new('dc', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = tris / n; m.use_collapse_triangulate = True
        apply_mods(obj)
    m = obj.modifiers.new('tr', 'TRIANGULATE'); apply_mods(obj)
    obj.data.calc_loop_triangles(); return len(obj.data.loop_triangles)

def hull_of(obj):
    """replace a mesh by its convex hull (triangles)"""
    bm = bmesh.new()
    for v in obj.data.vertices: bm.verts.new(v.co)
    r = bmesh.ops.convex_hull(bm, input=bm.verts[:])
    drop = {g for g in r['geom_interior'] + r['geom_unused'] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(bm, geom=list(drop), context='VERTS')
    bmesh.ops.triangulate(bm, faces=bm.faces[:]); bm.to_mesh(obj.data); bm.free(); obj.data.update(); return obj

def fit_bounds(obj, lo, hi):
    """stretch a decimated clump back to the bounds of its full-detail mesh (decimation pulls the extremes in)"""
    me = obj.data; vs = [v.co for v in me.vertices]
    a = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))); b = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    for v in me.vertices:
        for k in range(3): v.co[k] = lo[k] + (v.co[k] - a[k]) / max(b[k] - a[k], 1e-6) * (hi[k] - lo[k])
    me.update()

def bounds(obj):
    vs = [v.co for v in obj.data.vertices]
    return (Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))), Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs))))

def copy_obj(obj, name):
    o = link(bpy.data.objects.new(name, obj.data.copy())); o.matrix_world = obj.matrix_world.copy(); return o

def mesh_data(obj):
    """-> (verts [Vector], tris [(a,b,c)]) of a triangulated mesh object"""
    me = obj.data; me.calc_loop_triangles()
    return [obj.matrix_world @ v.co for v in me.vertices], [tuple(t.vertices) for t in me.loop_triangles]

# ---------------------------------------------------------------- skeletons (Z up)
class Skel:
    def __init__(s): s.p = []; s.r = []; s.e = []
    def add(s, p, r, parent=None):
        s.p.append(Vector(p)); s.r.append(r)
        if parent is not None: s.e.append((parent, len(s.p) - 1))
        return len(s.p) - 1

def skin(name, sk, subsurf=1, bark=0.0, seed=0, wide=1.0):
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(p) for p in sk.p], sk.e, []); me.update()
    obj = link(bpy.data.objects.new(name, me))
    m = obj.modifiers.new('sk', 'SKIN'); m.branch_smoothing = .5; m.use_smooth_shade = True
    sv = me.skin_vertices[0].data
    for i, r in enumerate(sk.r): sv[i].radius = (r * wide, r)
    sv[0].use_root = True
    if subsurf: s = obj.modifiers.new('ss', 'SUBSURF'); s.levels = subsurf; s.render_levels = subsurf
    apply_mods(obj)
    if bark > 0:   # vertical bark ridges: a texture stretched along the trunk
        t = bpy.data.textures.new(name + 'bk', 'CLOUDS'); t.noise_scale = .35; t.noise_depth = 1
        obj.data.transform(Matrix.Diagonal((1, 1, .18, 1)))
        d = obj.modifiers.new('dp', 'DISPLACE'); d.texture = t; d.strength = bark; d.mid_level = .5; d.texture_coords = 'LOCAL'
        apply_mods(obj); obj.data.transform(Matrix.Diagonal((1, 1, 1 / .18, 1)))
    return obj

def oak_skeleton(rng, H, lean, nlimb, lod):
    """trunk + roots + limbs that fork; returns skeleton and the clump list [(centre, radius, limb)]"""
    sk = Skel(); clumps = []
    ax = lambda t: Vector((lean[0] * math.sin(t * 2.2), lean[1] * math.sin(t * 2.2), t * H))
    base = sk.add((0, 0, -.35), .52)
    prev = base; nseg = 5 if lod == 0 else 3 if lod == 1 else 2
    trunk = [base]
    for k in range(1, nseg + 1):
        t = k / nseg * .78; p = ax(t)
        prev = sk.add(p, lerp(.48, .36, t / .78), prev); trunk.append(prev)
    if lod < 2:   # root flare: low buttress roots
        nr = 5 if lod == 0 else 3
        for k in range(nr):
            a = k / nr * math.tau + rng.uniform(-.3, .3); L = rng.uniform(.75, .95)
            m1 = sk.add((math.cos(a) * .3, math.sin(a) * .3, .25), .3, trunk[1] if lod == 0 else base) if lod == 0 else None
            sk.add((math.cos(a) * L, math.sin(a) * L, -.28), .1, m1 if m1 is not None else base)
    top = trunk[-1]
    # limbs: spread round, rise outward, curl up at the ends, fork
    a0 = rng.uniform(0, math.tau)
    for b in range(nlimb):
        a = a0 + b / nlimb * math.tau + rng.uniform(-.35, .35)
        el = rng.uniform(.55, 1.0); L = rng.uniform(2.6, 3.4)
        src = trunk[max(2, len(trunk) - 1 - (b % 2))] if lod == 0 else top
        o = sk.p[src]; d = Vector((math.cos(a) * math.sin(el), math.sin(a) * math.sin(el), math.cos(el)))
        steps = 3 if lod == 0 else 2; pi = src; r0 = .31
        for k in range(1, steps + 1):
            t = k / steps; q = o + d * L * t + Vector((0, 0, .45 * t * t))
            pi = sk.add(q, lerp(r0, .14, t), pi)
        tip = sk.p[pi]
        # fork: two or three twigs carrying the clumps
        nf = 2 + (1 if rng.random() < .4 else 0)
        for f in range(nf):
            fa = a + (f - (nf - 1) / 2) * rng.uniform(.7, 1.0); fe = rng.uniform(.35, .8); fl = rng.uniform(1.1, 1.7)
            fd = Vector((math.cos(fa) * math.sin(fe), math.sin(fa) * math.sin(fe), math.cos(fe)))
            fp = tip + fd * fl
            if lod < 2: sk.add(fp, .07, pi)
            clumps.append((fp + Vector((0, 0, .5)), rng.uniform(1.3, 1.7), b))
        clumps.append((tip + Vector((0, 0, .75)), rng.uniform(1.4, 1.75), b))
    # the leader: crown clump
    lp = ax(1.0) + Vector((0, 0, .3)); li = sk.add(lp, .14, top)
    clumps.append((lp + Vector((0, 0, .6)), rng.uniform(1.65, 1.95), nlimb))
    return sk, clumps

def clump_mesh(name, centres, rng, res, flat=.42):
    """a metaball family: per clump a core and a ring of lobes -> mesh, the underside flattened"""
    mb = bpy.data.metaballs.new(name); mb.resolution = res; mb.render_resolution = res; mb.threshold = .6
    obj = link(bpy.data.objects.new(name, mb))
    for (c, R) in centres:
        e = mb.elements.new(); e.co = c; e.radius = R * 1.05; e.stiffness = 2.0
        n = 6
        for k in range(n):
            a = k / n * math.tau + rng.uniform(-.4, .4); el = rng.uniform(-.15, .75)
            d = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el) * .8))
            e = mb.elements.new(); e.co = c + d * R * rng.uniform(.62, .8); e.radius = R * rng.uniform(.5, .66); e.stiffness = 2.0
    bpy.context.view_layer.update()
    me = evaluated_mesh(obj); bpy.data.objects.remove(obj); bpy.data.metaballs.remove(mb)
    o = link(bpy.data.objects.new(name + 'M', me))
    # flatten the bottoms a little: stylised clumps sit on soft flat undersides
    zc = min(c.z for c, R in centres); Rm = max(R for c, R in centres)
    for v in me.vertices:
        z0 = zc - Rm * flat
        if v.co.z < z0 + .3: v.co.z = lerp(v.co.z, z0 + .3, .55)
    return o

# ---------------------------------------------------------------- pine pieces (python meshes -> blender)
def bough_pad(verts, tris, o, a, L, W, droop, steps, lift=.12):
    """a drooping leaf-shaped pad from o along azimuth a: rings with a raised ridge, points at both ends"""
    d = Vector((math.cos(a), math.sin(a), 0)); s = Vector((-math.sin(a), math.cos(a), 0))
    rings = []
    for k in range(steps + 1):
        t = k / steps; c = o + d * L * t + Vector((0, 0, L * (lift * t - droop * t * t)))
        if k == 0 or k == steps: rings.append([len(verts)]); verts.append(c); continue
        w = W * math.sin(math.pi * t) ** .6 * (1 - .25 * t)
        idx = len(verts)
        verts.extend([c - s * w + Vector((0, 0, -.12 * w)), c + Vector((0, 0, .26 * w)), c + s * w + Vector((0, 0, -.12 * w)), c + Vector((0, 0, -.1 * w))])
        rings.append([idx, idx + 1, idx + 2, idx + 3])
    for k in range(steps):
        A, B = rings[k], rings[k + 1]
        if len(A) == 1:
            for j in range(4): tris.append((A[0], B[j], B[(j + 1) % 4]))
        elif len(B) == 1:
            for j in range(4): tris.append((A[j], B[0], A[(j + 1) % 4]))
        else:
            for j in range(4):
                j2 = (j + 1) % 4; tris.append((A[j], B[j], B[j2])); tris.append((A[j], B[j2], A[j2]))

def star_whorl(verts, tris, o, boughs, droop, h):
    """one whorl (LOD2): a top point, each bough's ridge at mid-length and its tip, a bottom point"""
    top = len(verts); verts.append(o + Vector((0, 0, h))); bot = len(verts); verts.append(o + Vector((0, 0, -.15)))
    mid = []; tip = []; n = len(boughs)
    for a, L in boughs:
        d = Vector((math.cos(a), math.sin(a), 0))
        mid.append(len(verts)); verts.append(o + d * L * .5 + Vector((0, 0, L * (.03 - .25 * droop + .11))))
        tip.append(len(verts)); verts.append(o + d * L + Vector((0, 0, L * (.06 - droop))))
    for k in range(n):
        k2 = (k + 1) % n
        tris += [(top, mid[k], mid[k2]), (mid[k], tip[k], mid[k2]), (mid[k2], tip[k], tip[k2]), (bot, tip[k2], tip[k])]

def py_obj(name, verts, tris):
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in verts], [], tris); me.update()
    return link(bpy.data.objects.new(name, me))

# ---------------------------------------------------------------- bake + export
FIB = []
for i in range(24):
    z = 1 - (i + .5) / 24; r = math.sqrt(max(0, 1 - z * z)); a = i * 2.39996
    FIB.append(Vector((math.cos(a) * r, math.sin(a) * r, z)))

def frame(n):
    t = Vector((0, 0, 1)) if abs(n.z) < .9 else Vector((1, 0, 0))
    b = n.cross(t).normalized(); t = b.cross(n); return t, b

def normals_of(verts, tris):
    N = [Vector() for _ in verts]
    for a, b, c in tris:
        n = (verts[b] - verts[a]).cross(verts[c] - verts[a])
        N[a] += n; N[b] += n; N[c] += n
    return [n.normalized() if n.length > 1e-9 else Vector((0, 0, 1)) for n in N]

def ao_of(verts, norms, bvh, maxd):
    out = []
    for p, n in zip(verts, norms):
        t, b = frame(n); occ = tot = 0.0; o = p + n * .04
        for d0 in FIB:
            d = (t * d0.x + b * d0.y + n * d0.z).normalized(); w = d0.z; tot += w
            hit = bvh.ray_cast(o, d, maxd); dist = hit[3] if hit[0] is not None else 1e9
            if d.z < -1e-3: dist = min(dist, max(0, (o.z + .05) / -d.z))          # the ground under the tree
            if dist < maxd: occ += w * (1 - dist / maxd) ** .8
        out.append(1 - occ / tot)
    return out

def b64(fmt, vals): return base64.b64encode(struct.pack('<%d%s' % (len(vals), fmt), *vals)).decode()

def export_geo(verts, tris, norms, cols):
    co = [Vector((v.x, v.z, -v.y)) for v in verts]
    mn = Vector((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co)))
    mx = Vector((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co))); ext = mx - mn
    q = []
    for c in co:
        for k in range(3): q.append(int(round((c[k] - mn[k]) / max(ext[k], 1e-6) * 65535)) - 32768)
    nq = []
    for n in norms: g = Vector((n.x, n.z, -n.y)).normalized(); nq += [int(round(g.x * 127)), int(round(g.y * 127)), int(round(g.z * 127))]
    cq = []
    for c in cols: cq += [int(round(clamp(c[k]) * 255)) for k in range(3)]
    idx = [i for t in tris for i in t]
    return dict(tris=len(tris), verts=len(verts), min=[round(v, 4) for v in mn], size=[round(v, 4) for v in ext],
                p=b64('h', q), n=b64('b', nq), c=b64('B', cq), i=b64('H', idx))

class Part:
    """a merged mesh in python: verts, tris, a 'centre' per vertex for soft normals"""
    def __init__(s): s.v = []; s.t = []; s.c = []; s.tag = []
    def add_obj(s, obj, centre=None, tag=0):
        vs, ts = mesh_data(obj); o = len(s.v); s.v += vs; s.t += [(a + o, b + o, c + o) for a, b, c in ts]
        s.c += [centre] * len(vs); s.tag += [tag] * len(vs)
    def add_py(s, vs, ts, centre=None, tag=0):
        o = len(s.v); s.v += vs; s.t += [(a + o, b + o, c + o) for a, b, c in ts]; s.c += [centre] * len(vs); s.tag += [tag] * len(vs)

def soft_normals(part, amt, axis=False):
    N = normals_of(part.v, part.t); out = []
    for p, n, c in zip(part.v, N, part.c):
        if c is None: out.append(n); continue
        d = (Vector((p.x - c.x, p.y - c.y, (p.z - c.z) * .4 + .9)) if axis else (p - c)).normalized()
        out.append(n.lerp(d, amt).normalized())
    return out

# ---------------------------------------------------------------- the forms
def colour_bark(p, n, ao, seed, H, kind):
    up = n.z; north = n.y
    nz = vnoise(p.x * 3.1, p.y * 3.1, p.z * 1.1, seed)
    if kind == 'snag':
        c = P['snag2'].lerp(P['snag'], clamp(.35 + .5 * up + .5 * (nz - .5) + .25 * smooth(0, 4, p.z)))
        c = c.lerp(P['moss'], .55 * smooth(.25, .7, north) * (1 - smooth(1.5, 3, p.z)))
    else:
        c = P['bark2'].lerp(P['bark'] if kind == 'oak' else P['pbark'] * 1.25, clamp(.45 + .45 * up + .8 * (nz - .5)))
        c = c.lerp(P['barkG'], .3 * smooth(.6, .9, vnoise(p.x * 1.3, p.y * 1.3, p.z * .4, seed + 5)))
        mk = smooth(.2, .75, north * .8 + up * .6) * (1 - smooth(H * .55, H * .8, p.z)) * (.6 + .4 * nz)
        c = c.lerp(P['moss'].lerp(P['mossL'], .4 * up), clamp(mk * (.85 if kind == 'oak' else .5)))
        c = c.lerp(P['bark2'] * .7, .5 * (1 - smooth(-.3, .5, p.z)))     # damp dark foot
    return c * (.62 + .38 * ao) * 1.1

def colour_leaf(p, n, ao, t, warm, seed, pine=False):
    up = n.z; nz = vnoise(p.x * 1.9, p.y * 1.9, p.z * 1.9, seed)
    if pine:
        c = P['pdark'].lerp(P['pmid'], smooth(-.4, .5, up) * .9).lerp(P['plite'], smooth(.2, 1, up) * (.6 + .4 * min(t, .8)))
        c = c.lerp(P['pdark'].lerp(P['pmid'], .6), .85 * smooth(.88, .95, t))    # the leader takes the boughs' colour, not the sky-lit top's
    else:
        c = P['dark'].lerp(P['mid'], smooth(-.55, .35, up)).lerp(P['lite'], smooth(.2, .95, up) * (.55 + .45 * t))
        if warm < .2: c = c.lerp(P['warm'] if warm < .12 else P['gold'], clamp(.6 * smooth(-.2, .6, up)))
    c = c * (.88 + .24 * nz) * 1.22
    return c * (.72 + .28 * ao)

def take_from(part, ref, vals, k=6):
    """per vertex: the mean of vals over the k nearest vertices of ref with the same tag (the full-detail surface)"""
    trees = {}
    for tg in set(ref.tag):
        ids = [i for i, t in enumerate(ref.tag) if t == tg]; kd = KDTree(len(ids))
        for j, i in enumerate(ids): kd.insert(ref.v[i], i)
        kd.balance(); trees[tg] = kd
    out = []
    for p, tg in zip(part.v, part.tag):
        kd = trees.get(tg) or next(iter(trees.values())); hits = kd.find_n(p, k)
        w = [1 / (d + .05) for _, _, d in hits]; acc = vals[hits[0][1]] * 0
        for (_, i, _), wi in zip(hits, w): acc = acc + vals[i] * wi
        out.append(acc / sum(w))
    return out

def finish(trunk, canopy, kind, seed, H, warmth, pine=False, amt=.62, ref=None):
    """bake both parts against each other and the ground; -> exported trunk + canopy dicts. With ref (the LOD0 result) the
    colours, and the canopy's soft normals, come from the nearest full-detail surface instead"""
    tN = normals_of(trunk.v, trunk.t)
    cN = soft_normals(canopy, amt, axis=pine) if canopy.v else []
    allv = trunk.v + canopy.v; allt = trunk.t + [(a + len(trunk.v), b + len(trunk.v), c + len(trunk.v)) for a, b, c in canopy.t]
    bvh = BVHTree.FromPolygons([tuple(v) for v in allv], allt)
    if ref:
        rT, rC = ref['_parts']; tC = take_from(trunk, rT, ref['_cols'][0], 4)
    else:
        tA = ao_of(trunk.v, tN, bvh, 2.2)
        tC = [colour_bark(p, n, a, seed, H, kind) for p, n, a in zip(trunk.v, tN, tA)]
    out = dict(trunk=export_geo(trunk.v, trunk.t, tN, tC))
    if canopy.v:
        if ref:
            cC = take_from(canopy, rC, ref['_cols'][1], 8)
            cN = [n.normalized() for n in take_from(canopy, rC, ref['_norms'][1], 8)]
        else:
            gN = normals_of(canopy.v, canopy.t); cA = ao_of(canopy.v, gN, bvh, 3.0)
            zs = [v.z for v in canopy.v]; z0, z1 = min(zs), max(zs)
            cC = [colour_leaf(p, n, a, (p.z - z0) / max(z1 - z0, 1e-3), warmth[tg % len(warmth)], seed, pine)
                  for p, n, a, tg in zip(canopy.v, cN, cA, canopy.tag)]
        out['canopy'] = export_geo(canopy.v, canopy.t, cN, cC)
        out['_cols'] = (tC, cC); out['_norms'] = (tN, cN)
    else: out['_cols'] = (tC, []); out['_norms'] = (tN, [])
    out['_parts'] = (trunk, canopy)
    return out

def trunk_limits(part, rmax, z0=.45, z1=2.2):
    """keep the trunk inside its collider at player height"""
    worst = 0
    for i, v in enumerate(part.v):
        if z0 <= v.z <= z1:
            r = math.hypot(v.x, v.y); worst = max(worst, r)
            if r > rmax: k = rmax / r; part.v[i] = Vector((v.x * k, v.y * k, v.z))
    return worst

OAK_BUDGET = [(520, 1080), (190, 450), (60, 180)]
def build_oak(idx, seed):
    rng0 = random.Random(seed)
    H = rng0.uniform(4.2, 5.2); lean = (rng0.uniform(-.5, .5), rng0.uniform(-.5, .5)); nlimb = 3 + (idx % 2)
    warmth = [rng0.random() for _ in range(40)]
    rng = random.Random(seed)
    for _ in range(3 + 2 + nlimb + 1): rng.random()
    sk, clumps = oak_skeleton(rng, H, lean, nlimb, 0)
    crng = random.Random(seed * 7 + 1); full = []
    for k, (c, R, limb) in enumerate(clumps):
        o = clump_mesh('cl%d' % k, [(c, R)], crng, .34); decimate(o, OAK_BUDGET[0][1] // len(clumps)); full.append((o, c, k, bounds(o)))
    lods = []
    for lod in range(3):
        tb, cb = OAK_BUDGET[lod]
        to = skin('oakT', sk, subsurf=1 if lod == 0 else 0, bark=.07 if lod == 0 else 0, seed=seed)
        decimate(to, tb); trunk = Part(); trunk.add_obj(to); remove(to)
        trunk_limits(trunk, .5)
        canopy = Part()
        for o0, c, k, (lo, hi) in full:
            o = o0 if lod == 0 else copy_obj(o0, 'cl%d_%d' % (k, lod))
            if lod == 2: hull_of(o)
            if lod: decimate(o, cb // len(clumps)); fit_bounds(o, lo, hi)
            canopy.add_obj(o, c, k)
            if lod: remove(o)
        lods.append(finish(trunk, canopy, 'oak', seed, H, warmth, ref=lods[0] if lod else None))
    for o0, *_ in full: remove(o0)
    return dict(name='oak%d' % idx, h=round(H, 3), lods=lods)

PINE_BUDGET = [(150, 1250), (60, 0), (24, 0)]
def build_pine(idx, seed):
    rng0 = random.Random(seed); H = rng0.uniform(9.6, 11.4); bend = (rng0.uniform(-.25, .25), rng0.uniform(-.25, .25))
    ntier = 10 if idx != 1 else 11
    lods = []
    ax = lambda z: Vector((bend[0] * math.sin(z / H * 2), bend[1] * math.sin(z / H * 2), z))
    for lod in range(3):
        rng = random.Random(seed * 3 + 11)
        sk = Skel(); prev = sk.add((0, 0, -.3), .32); ns = 4
        for k in range(1, ns + 1):
            z = H * .98 * k / ns; prev = sk.add(ax(z), lerp(.3, .05, k / ns), prev)
        if lod == 0:   # bare dead stubs just above head height
            for k in range(4):
                a = rng.uniform(0, math.tau); z = rng.uniform(2.3, 3.0); o = ax(z)
                sk.add(o + Vector((math.cos(a) * rng.uniform(.4, .7), math.sin(a) * rng.uniform(.4, .7), -.08)), .03, 1 if z < H * .25 else 1)
        to = skin('pineT', sk, subsurf=1 if lod == 0 else 0, bark=.035 if lod == 0 else 0, seed=seed, wide=1.0)
        decimate(to, PINE_BUDGET[lod][0]); trunk = Part(); trunk.add_obj(to); remove(to); trunk_limits(trunk, .33)
        canopy = Part(); vs = []; ts = []
        trng = random.Random(seed * 5 + 3)
        for k in range(ntier):
            t = k / (ntier - 1); z = lerp(3.35, H - 1.5, t ** .9); o = ax(z)
            R = lerp(3.0, .8, t) * trng.uniform(.85, 1.12); ph = trng.uniform(0, math.tau)
            nb = int(round(lerp(7, 3, t))); droop = lerp(.45, .3, t)
            lens = [R * trng.uniform(.62, 1.18) for _ in range(nb)]; jit = [trng.uniform(-.25, .25) for _ in range(nb)]
            angs = [ph + (b + jit[b]) / nb * math.tau for b in range(nb)]
            if lod < 2:   # LOD1: every bough, fewer rings (the long low ones keep three)
                for b in range(nb):
                    bough_pad(vs, ts, o, angs[b], lens[b], lens[b] * .5, droop, 4 if lod == 0 else 3 if k < 3 else 2, lift=.06)
            else:   # a star whose points are the boughs' tips
                star_whorl(vs, ts, o, sorted((a % math.tau, L) for a, L in zip(angs, lens)), droop, .1 * max(lens))
        # the leader: a short, blunt top whorl rather than a needle
        o = ax(H - .7); n0 = len(vs)
        vs += [o + Vector((0, 0, .95))]; ring = []; mid = []
        for k in range(5): a = k / 5 * math.tau; ring.append(len(vs)); vs.append(o + Vector((math.cos(a) * .55, math.sin(a) * .55, -.18)))
        for k in range(5): a = (k + .5) / 5 * math.tau; mid.append(len(vs)); vs.append(o + Vector((math.cos(a) * .3, math.sin(a) * .3, .42)))
        for k in range(5):
            ts.append((ring[k], ring[(k + 1) % 5], mid[k])); ts.append((mid[k], ring[(k + 1) % 5], mid[(k + 1) % 5])); ts.append((n0, mid[k], mid[(k + 1) % 5]))
        vs = [v if v.z >= 2.7 else Vector((v.x, v.y, 2.7 - (2.7 - v.z) * .4)) for v in vs]   # bough tips stay above head height
        po = py_obj('pineC', vs, ts)
        if lod == 0: decimate(po, PINE_BUDGET[0][1])
        vv, tt = mesh_data(po); remove(po)
        # each vertex leans out from the trunk axis at its own height (centre on the axis)
        canopy.v = vv; canopy.t = tt; canopy.tag = [0] * len(vv)
        canopy.c = [None if v.z > H - .9 else ax(v.z) for v in vv]   # the leader keeps its own facets: no sky-lit cap
        lods.append(finish(trunk, canopy, 'pine', seed, H, [0], pine=True, amt=.5, ref=lods[0] if lod else None))
    return dict(name='pine%d' % idx, h=round(H, 3), lods=lods)

SNAG_BUDGET = [500, 220, 100]
def build_snag(seed):
    rng0 = random.Random(seed); H = 4.4; lean = (.3, -.2); lods = []
    sk, clumps = oak_skeleton(random.Random(seed), H, lean, 4, 0)
    for lod in range(3):
        to = skin('snagT', sk, subsurf=1 if lod == 0 else 0, bark=.06 if lod == 0 else 0, seed=seed)
        decimate(to, SNAG_BUDGET[lod]); trunk = Part(); trunk.add_obj(to); remove(to); trunk_limits(trunk, .5)
        lods.append(finish(trunk, Part(), 'snag', seed, H, [0], ref=lods[0] if lod else None))
    return dict(name='snag', h=H, lods=lods)

FORMS = [('oak0', lambda: build_oak(0, 101)), ('oak1', lambda: build_oak(1, 202)), ('oak2', lambda: build_oak(2, 303)),
         ('oak3', lambda: build_oak(3, 404)), ('pine0', lambda: build_pine(0, 505)), ('pine1', lambda: build_pine(1, 606)),
         ('pine2', lambda: build_pine(2, 707)), ('snag', lambda: build_snag(808))]

# ---------------------------------------------------------------- contact sheets
def sheet(forms, outdir):
    sc = bpy.context.scene; sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading; sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = False; sh.show_shadows = False
    sc.render.resolution_x = 1100; sc.render.resolution_y = 640
    world = bpy.data.worlds.new('w'); sc.world = world; world.color = (.62, .68, .76)
    try: sc.view_settings.view_transform = 'Standard'
    except Exception: pass
    objs = []
    for fi, f in enumerate(forms):
        for lod, L in enumerate(f['lods']):
            for part, cols, nrm in zip(L['_parts'], L['_cols'], L['_norms']):
                if not part.v: continue
                o = py_obj('%s_%d' % (f['name'], lod), part.v, part.t)
                ca = o.data.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
                for i, c in enumerate(cols): ca.data[i].color_srgb = (min(1, c.x * 1.5), min(1, c.y * 1.5), min(1, c.z * 1.5), 1)
                o.data.color_attributes.active_color = ca
                try: o.data.normals_split_custom_set_from_vertices([tuple(n) for n in nrm])
                except Exception as e: print('normals', e)
                o.location = (fi * 9.5, 0, -lod * 14); objs.append(o)
    cam_d = bpy.data.cameras.new('cam'); cam = link(bpy.data.objects.new('cam', cam_d)); sc.camera = cam
    cam_d.type = 'ORTHO'; W = len(forms) * 9.5; cam_d.ortho_scale = max(W, 44 * 1100 / 640)
    cx = (len(forms) - 1) * 9.5 / 2
    files = []
    for nm, d in [('side', (0, -1, .08)), ('three-quarter', (.6, -1, .4))]:
        dv = Vector(d).normalized(); cam.location = Vector((cx, 0, -9)) + dv * 120
        cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
        f = os.path.join(outdir, 'blender-%s.png' % nm); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
    sh.color_type = 'SINGLE'; sh.single_color = (0, 0, 0); sh.light = 'FLAT'
    dv = Vector((0, -1, .08)).normalized(); cam.location = Vector((cx, 0, -9)) + dv * 120; cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
    f = os.path.join(outdir, 'blender-silhouette.png'); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
    # a close-up of every LOD0 at eye level
    sh.color_type = 'VERTEX'; sh.light = 'STUDIO'; sc.render.resolution_x = 1100; sc.render.resolution_y = 560
    for o in objs: o.hide_render = not o.name.endswith('_0') and '_0.' not in o.name
    cam_d.ortho_scale = len(forms) * 9.5 * .55
    for half in range(2):
        cxh = (half * 4 + 1.5) * 9.5
        for o in objs: o.hide_render = not (o.name.split('.')[0].endswith('_0') and half * 4 <= round(o.location.x / 9.5) < half * 4 + 4)
        dv = Vector((.35, -1, .2)).normalized(); cam.location = Vector((cxh, 0, 4.5)) + dv * 120; cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
        cam_d.ortho_scale = 40
        f = os.path.join(outdir, 'blender-lod0-%d.png' % half); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
    return files

def strip(L): return {k: v for k, v in L.items() if not k.startswith('_')}

def main():
    reset(); t0 = time.time()
    only = set(A.only.split(',')) if A.only else None
    forms = []
    for name, fn in FORMS:
        if only and name not in only: continue
        t1 = time.time(); f = fn(); forms.append(f)
        print('%-6s h %.2f  ' % (name, f['h']) + '  '.join('L%d %4d+%4d' % (k, L['trunk']['tris'], L.get('canopy', {}).get('tris', 0)) for k, L in enumerate(f['lods'])) + '  %.1fs' % (time.time() - t1), flush=True)
    if not A.no_export and not only:
        def pack(f): return dict(name=f['name'], h=f['h'], lods=[strip(L) for L in f['lods']])
        data = dict(v=1, axes='y-up, origin at the foot, metres', colour='sRGB, AO baked in',
                    oaks=[pack(f) for f in forms if f['name'].startswith('oak')], pines=[pack(f) for f in forms if f['name'].startswith('pine')],
                    extras={f['name']: pack(f) for f in forms if f['name'] == 'snag'})
        js = ('/* generated by tools/florakit/build_trees.py (Blender %s) -- do not edit by hand */\n' % bpy.app.version_string +
              '(function(){window.G=window.G||{};G.treekitData=' + json.dumps(data, separators=(',', ':')) + ';})();\n')
        open(A.out, 'w').write(js); print('wrote', A.out, len(js), 'bytes', flush=True)
    if A.shots:
        os.makedirs(A.shots, exist_ok=True)
        for f in sheet(forms, A.shots): print('shot', f)
    for f in forms:
        L = f['lods'][0]; tp = L['_parts']; zs = [v.z for v in tp[1].v] or [0]; tz = [v.z for v in tp[0].v]
        print(f['name'], 'top %.2f canopy-bottom %.2f trunk-top %.2f' % (max(max(zs), max(tz)), min(zs), max(tz)))
    print('done in %.1fs' % (time.time() - t0))

main()
