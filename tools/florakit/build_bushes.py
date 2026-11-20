"""Undergrowth kit builder: models the shrubs, brambles, bracken, ferns, gorse and heather in Blender (bpy module,
headless) and writes js/bushkit_data.js (G.bushkitData).

    pip install bpy --break-system-packages      # Blender 5.3 as a Python module
    python3 tools/florakit/build_bushes.py       # rebuild js/bushkit_data.js (deterministic)
    python3 tools/florakit/build_bushes.py --shots DIR [--only gorse,fern] [--no-export]

Each kind is built three times, on purpose, at three levels of detail: LOD0 and LOD1 from the same sculpt (leaf clumps
are displaced icospheres, canes and stems are tubes, fronds are cut as pinnate strips with a serrated outline) with the
clump count and resolution stepped down and a collapse decimate to the budget; LOD2 is a separate few-piece model that
keeps the outline. Vertex colour is baked per level: ray-traced ambient occlusion against the full model and the ground,
dark hearts and undersides, lit outer tips, warm dusk tints, and the flowers and berries as flecks. Normals on leaf
masses are pushed out from the clump and bush centres so the toon ramp shades each clump as one rounded mass.
Blender is Z-up; the export is the game's Y-up frame (x, z, -y), origin at the foot, metres.
"""
import bpy, bmesh, math, os, sys, json, base64, struct, argparse, time
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser()
ap.add_argument('--shots', default='')
ap.add_argument('--only', default='')
ap.add_argument('--no-export', action='store_true')
ap.add_argument('--out', default=os.path.join(ROOT, 'js', 'bushkit_data.js'))
A = ap.parse_args(sys.argv[1:])

def hexc(h): h = h.lstrip('#'); return Vector((int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255))
def lerp(a, b, t): return a + (b - a) * t
def clamp(x, a=0.0, b=1.0): return a if x < a else b if x > b else x
def smooth(a, b, x): t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t)
def hash1(*v):
    s = 0.0
    for i, x in enumerate(v): s += x * (127.1, 311.7, 74.7, 269.5)[i % 4]
    x = math.sin(s) * 43758.5453; return x - math.floor(x)
def vhash(p, k=1.0, s=0): return hash1(math.floor(p.x * k), math.floor(p.y * k), math.floor(p.z * k), s)
def nz(p, s=0.0): return noise.noise(Vector((p.x + s * 7.3, p.y - s * 3.1, p.z + s * 1.7)))

class RNG:
    """tiny deterministic LCG (same numbers on every machine and Python build)"""
    def __init__(self, seed): self.s = seed % 2147483647 or 1
    def __call__(self): self.s = self.s * 16807 % 2147483647; return (self.s - 1) / 2147483646
    def r(self, a, b): return a + (b - a) * self()

# ---------------------------------------------------------------- geometry: one bmesh per model, parts tagged per vertex
class Build:
    LEAF, STEM, FROND, FLOWER = 0, 1, 2, 3
    def __init__(self):
        self.bm = bmesh.new(); self.part = self.bm.verts.layers.int.new('part'); self.cid = self.bm.verts.layers.int.new('cid')
        self.clumps = []        # (centre, radius) for the soft normals and the colour hearts
        self.sq = []
    def _tag(self, verts, part, cid=-1):
        for v in verts: v[self.part] = part; v[self.cid] = cid
    def clump(self, c, r, sq=(1, 1, .8), sub=2, lump=.22, seed=0, spike=0.0, rag=0.0):
        """leaf mass: displaced icosphere; spike = per-vertex outward jitter (gorse), rag = ragged top (heather)"""
        if sub < 0:     # the far level: a squat bipyramid (eight faces), turned per clump, sized to the same outline
            a0 = hash1(seed, 4) * 6.28
            q = [(math.cos(a0 + k * 1.5708), math.sin(a0 + k * 1.5708), .12) for k in range(4)] + [(0, 0, .95), (0, 0, -.8)]
            vs = [self.bm.verts.new(Vector(v)) for v in q]
            for k in range(4): self.bm.faces.new((vs[k], vs[(k + 1) % 4], vs[4])); self.bm.faces.new((vs[(k + 1) % 4], vs[k], vs[5]))
            r *= 1.14
        else: vs = bmesh.ops.create_icosphere(self.bm, subdivisions=sub + 1, radius=1.0)['verts']
        cid = len(self.clumps); self.clumps.append((Vector(c), r * max(sq))); self.sq.append(sq)
        for v in vs:
            d = v.co.normalized() if sub >= 0 else v.co.copy()
            k = 1 + lump * nz(d * 1.6, seed) + lump * .45 * nz(d * 3.7, seed + 3)
            if spike: k += spike * (hash1(v.index, seed, 3) - .35)
            p = Vector((d.x * sq[0], d.y * sq[1], d.z * sq[2])) * r * k
            if rag and d.z > .1: p.z += rag * r * d.z * (hash1(v.index, seed, 9) ** 1.5) * 1.6
            v.co = p + Vector(c)
        self._tag(vs, self.LEAF, cid)
    def cone(self, base, d, ln, rad, cid=-1, part=0, sides=3):
        """a spike / sprig: open 3-sided cone from base (sunk into the mass) out along d"""
        d = Vector(d).normalized(); a = Vector((0, 0, 1)) if abs(d.z) < .9 else Vector((1, 0, 0))
        u = d.cross(a).normalized(); w = d.cross(u); base = Vector(base)
        ring = [self.bm.verts.new(base + (u * math.cos(k / sides * math.tau) + w * math.sin(k / sides * math.tau)) * rad) for k in range(sides)]
        tip = self.bm.verts.new(base + d * ln)
        for k in range(sides): self.bm.faces.new((ring[k], ring[(k + 1) % sides], tip))
        self._tag(ring + [tip], part, cid)
    def bead(self, c, r, part=3, cid=-1):
        """a flower or berry: small tetrahedron"""
        c = Vector(c); q = [c + Vector(v) * r for v in ((0, 0, 1.2), (.94, 0, -.33), (-.47, .82, -.33), (-.47, -.82, -.33))]
        vs = [self.bm.verts.new(x) for x in q]
        for f in ((0, 1, 2), (0, 2, 3), (0, 3, 1), (1, 3, 2)): self.bm.faces.new([vs[i] for i in f])
        self._tag(vs, part, cid)
    def spikes(self, cid, n, ln, rad, zmin=-.2, seed=0, part=0, up=0.0):
        """n spikes spread over clump cid (fibonacci directions), sunk a little into its skin"""
        c, r = self.clumps[cid]
        for i in range(n):
            z = 1 - (i + .5) / n * (1 - zmin); z = max(-1, min(1, z)); rr = math.sqrt(max(0, 1 - z * z)); ang = i * 2.39996 + seed
            d = Vector((rr * math.cos(ang), rr * math.sin(ang), z)); sq = self.sq[cid]
            p = c + Vector((d.x * sq[0], d.y * sq[1], d.z * sq[2])) * r / max(sq) * .86
            dd = (d + Vector((0, 0, up))).normalized()
            self.cone(p, dd, ln * (.7 + .6 * hash1(i, seed, 2)), rad, cid, part)
    def tube(self, pts, radii, sides=5):
        """stem / cane through pts (open ends, tapered)"""
        rings = []
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            a = Vector((0, 0, 1)) if abs(t.z) < .9 else Vector((1, 0, 0))
            u = t.cross(a).normalized(); w = t.cross(u)
            ring = []
            for k in range(sides):
                ang = k / sides * math.tau
                ring.append(self.bm.verts.new(p + (u * math.cos(ang) + w * math.sin(ang)) * radii[i]))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for k in range(sides):
                a, b = rings[i][k], rings[i][(k + 1) % sides]; c, d = rings[i + 1][(k + 1) % sides], rings[i + 1][k]
                self.bm.faces.new((a, b, c, d))
        if radii[-1] < 1e-3 or True:   # close the tip with a point so canes end cleanly
            tip = self.bm.verts.new(pts[-1] + (pts[-1] - pts[-2]).normalized() * radii[-1])
            for k in range(sides): self.bm.faces.new((rings[-1][k], rings[-1][(k + 1) % sides], tip))
            rings.append([tip])
        self._tag([v for r in rings for v in r], self.STEM)
    def blade(self, a, b, w):
        """a stipe far away: one thin triangle from a (foot, w wide) up to b"""
        d = (Vector(b) - Vector(a)); s = Vector((-d.y, d.x, 0)).normalized() * w
        vs = [self.bm.verts.new(Vector(a) - s), self.bm.verts.new(Vector(a) + s), self.bm.verts.new(Vector(b))]
        self.bm.faces.new(vs); self._tag(vs, self.STEM)
    def frond(self, base, yaw, L, W, e0, e1, pinnae, droop=.35, serr=False, twist=0.0, tipcurl=0.0, shape='lance', kite=False):
        """an arching pinnate frond: spine from base, elevation e0 -> e1 (radians); outline cut into the mesh as
        alternating pinna tips and notches on both sides (serr: each pinna also toothed)"""
        f = Vector((math.cos(yaw), math.sin(yaw), 0)); side0 = Vector((-f.y, f.x, 0))
        n = pinnae; seg = 2 * n
        spine = [Vector(base)]; p = Vector(base)
        for i in range(1, seg + 1):
            t = i / seg; e = lerp(e0, e1, t ** 1.25) - tipcurl * smooth(.75, 1, t)
            p = p + (f * math.cos(e) + Vector((0, 0, math.sin(e)))) * (L / seg); spine.append(p.copy())
        def width(t):
            if shape == 'delta': return W * (1 - t) ** .85 * smooth(0, .12, t + .02) + W * .05
            return W * (math.sin(math.pi * min(1, t * .95 + .03)) ** .75) * (1 - .25 * (1 - t))
        verts_sp = [self.bm.verts.new(q) for q in spine]
        allv = list(verts_sp)
        for sd in (-1, 1):
            notch = []; tips = []; mids = []
            for k in range(n + 1):
                t = (2 * k) / seg; i = 2 * k
                tw = twist * t * sd
                s = (side0 * sd * (1 - abs(tw)) + Vector((0, 0, -droop * (.3 + t)))).normalized()
                notch.append(self.bm.verts.new(spine[i] + s * width(t) * .16))
            for k in range(n):
                t = (2 * k + 1) / seg; i = 2 * k + 1
                s = (side0 * sd + Vector((0, 0, -droop * (.5 + t))) + f * .35).normalized()
                tips.append(self.bm.verts.new(spine[i] + s * width(t)))
                if serr: mids.append(self.bm.verts.new(spine[i] + s * width(t) * .62 - f * (L / seg) * .55))
            for k in range(n):
                S0, S1, S2 = verts_sp[2 * k], verts_sp[2 * k + 1], verts_sp[2 * k + 2]
                N0, N1, T = notch[k], notch[k + 1], tips[k]
                q = (lambda a, b, c: self.bm.faces.new((a, b, c) if sd > 0 else (a, c, b)))
                if kite: q(S0, T, S1); q(S1, T, S2)
                elif serr:
                    M = mids[k]; q(S0, N0, M); q(S0, M, T); q(S0, T, S2); q(S2, T, N1)
                else:
                    q(S0, N0, T); q(S0, T, S2); q(S2, T, N1)
            if kite:
                for v in notch: self.bm.verts.remove(v)
                notch = []
            allv += notch + tips + mids
        tip = verts_sp[-1]
        self._tag(allv, self.FROND)
        return spine
    def finish(self, name):
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces[:])
        me = bpy.data.meshes.new(name); self.bm.to_mesh(me); self.bm.free()
        obj = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(obj)
        obj['clumps'] = [[c.x, c.y, c.z, r] for c, r in self.clumps]
        return obj

def apply_mods(obj):
    dg = bpy.context.evaluated_depsgraph_get(); ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    old = obj.data; obj.modifiers.clear(); obj.data = me; bpy.data.meshes.remove(old)

def ntris(obj): obj.data.calc_loop_triangles(); return len(obj.data.loop_triangles)

def decimate(obj, tris):
    n = ntris(obj)
    if n > tris:
        m = obj.modifiers.new('dc', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = tris / n * .985; m.use_collapse_triangulate = True
        apply_mods(obj)
    m = obj.modifiers.new('tr', 'TRIANGULATE'); apply_mods(obj)
    return ntris(obj)

# ---------------------------------------------------------------- the models: fn(rng, lod) -> Build
# Every level is laid out from the same random draws as LOD0 (same clump centres, sizes, stems and fronds); the lower
# levels only use coarser pieces: icospheres a step down (a little larger, so the faceted shape covers the same outline),
# fewer spikes and beads (bigger), thinner stem tubes or none, fronds with fewer pinnae.
def lo(sub, lod):
    """clump resolution and radius factor at this level for a clump modelled at `sub` on LOD0 (LOD2: octahedra)"""
    if lod == 2: return -1, 1.0
    s = max(0, sub - lod); return s, (1.0 if s == sub else 1.09)

def m_hazel(rng, lod):
    """hazel: a few springy stems under a crown of big, round leaf clumps; the outer clumps sit lower so the outline
    is a soft dome with scalloped edges rather than a heap of facets"""
    b = Build()
    stems = [(k / 5 * 6.28 + rng.r(-.4, .4), rng.r(.35, .55), rng.r(.5, .64)) for k in range(5)]
    tops = []
    for k, (a, lean, h) in enumerate(stems):
        d = Vector((math.cos(a) * math.sin(lean), math.sin(a) * math.sin(lean), math.cos(lean)))
        pts = [Vector((math.cos(a) * .04, math.sin(a) * .04, 0)) + d * (h * t) for t in (0, .5, 1)]
        if lod == 0: b.tube(pts, [.032, .024, .016], 4)
        elif lod == 1 and k % 2 == 0: b.tube([pts[0], pts[2]], [.03, .016], 3)
        tops.append(pts[-1])
    s, f = lo(1, lod); b.clump((0, 0, .86), .36 * f, (1.1, 1.1, .82), s, .12, 99)
    for k in range(5):
        t = tops[k]; r = rng.r(.27, .32)
        b.clump(Vector((t.x * 1.15, t.y * 1.15, t.z + r * .25)), r * f, (1.08, 1.05, .84), s, .12, k * 3 + 1)
    if lod < 2:
        for k in range(3):   # small lobes low on the rim break the dome's edge
            a = k / 3 * 6.28 + 1.1; b.clump(Vector((math.cos(a) * .5, math.sin(a) * .5, .48)), .18, (1.05, 1.05, .8), -lod, .1, 40 + k)
    return b

def m_holly(rng, lod):
    """holly: a dark, glossy pyramid of overlapping clumps, broad at the base, a pointed top, prickly edges and a few
    clusters of red berries on the sunny side"""
    b = Build(); s, f = lo(1, lod)
    if lod == 0: b.tube([Vector((0, 0, 0)), Vector((.02, 0, .5)), Vector((0, .02, 1.05))], [.05, .035, .015], 4)
    k = 0
    for ti, (z, r, n, off) in enumerate([(.36, .46, 3, .34), (.7, .34, 3, .2), (1.0, .22, 1, 0)]):
        for j in range(n):
            a = j / n * 6.28 + ti * 1.05 + rng.r(-.2, .2)
            rr = r * (rng.r(.85, .95) if n > 1 else 1.0)
            b.clump((math.cos(a) * off, math.sin(a) * off, z + rng.r(-.03, .03)), rr * f, (1, 1, .95 if ti < 2 else 1.25), s, .16, k * 7 + 2)
            if lod == 0: b.spikes(k, 7, .09, .028, -.2, k)
            k += 1
    for i in range(4):     # berry clusters: three beads each on LOD0, one bigger bead on LOD1, none far off
        cid = i % k; c, r = b.clumps[cid]; a = i * 2.4 + .6
        base = c + Vector((math.cos(a), math.sin(a), .29)) * r * (.86, .96, 1.0)[lod]
        if lod == 2: break
        for q in range((3, 1, 1)[lod]):
            b.bead(base + Vector(((q - 1) * .045, (q % 2) * .04, 0)), (.045, .065, .085)[lod])
    return b

def m_bramble(rng, lod):
    """bramble: a low tangled mound with long canes arching out of it, each ending in a leafy tuft, and blackberries
    on top"""
    b = Build(); s, f = lo(1, lod)
    nc = 5
    for k in range(nc):
        a = k / nc * 6.28 + rng.r(0, .6); off = rng.r(.3, .4) if k else 0
        rr = rng.r(.28, .34) if k else .4
        b.clump((math.cos(a) * off, math.sin(a) * off, rng.r(.2, .26) if k else .34), rr * f, (1.15, 1.1, .78), s, .2, k * 11 + 4)
    for k in range(4):
        a = k / 4 * 6.28 + rng.r(-.3, .3) + .5; d = Vector((math.cos(a), math.sin(a), 0)); R = rng.r(.55, .66); H = rng.r(.7, .82)
        pts = [d * (.15 + R * t) + Vector((0, 0, .2 + (H - .2) * math.sin(math.pi * t ** .75) - .25 * t)) for t in (0, .35, .62, .88)]
        if lod == 0: b.tube(pts, [.034, .03, .024, .018], 4)
        elif lod == 1: b.tube([pts[0], pts[2], pts[3]], [.034, .026, .018], 3)
        if lod < 2: b.clump(pts[2] + Vector((0, 0, .06)), .17 * (1, 1.04)[lod], (1.1, 1.1, .9), -lod, .12, 60 + k)   # leaves along the arch
        else: b.bead(pts[2] + Vector((0, 0, .06)), .2, Build.LEAF)
    for i in range((6, 3, 0)[lod]):
        c, r = b.clumps[(i * 2 if lod else i) % nc]; a = i * 2.4
        b.bead(c + Vector((math.cos(a) * r * .7, math.sin(a) * r * .7, r * .62)), (.04, .055)[lod])
    return b

def m_fern(rng, lod):
    """fern: a shuttlecock of arching fronds; the same fronds at every level, cut into fewer pinnae"""
    b = Build(); pin = (5, 2, 1)[lod]
    for k in range(6):
        a = k / 6 * 6.28 + rng.r(-.25, .25); L = rng.r(.75, .9)
        b.frond((math.cos(a) * .03, math.sin(a) * .03, 0), a, L, rng.r(.13, .16), rng.r(1.3, 1.5), rng.r(-.35, -.05), pin,
                droop=.3, twist=.15, tipcurl=.2 if lod == 0 else 0, kite=lod > 0)
    return b

def m_bracken(rng, lod):
    """bracken: stiff stipes, each holding out one broad triangular frond"""
    b = Build(); pin = (4, 2, 1)[lod]
    for k in range(4):
        a = k / 4 * 6.28 + rng.r(-.4, .4); lean = rng.r(.2, .35); h = rng.r(.3, .4)
        d = Vector((math.cos(a), math.sin(a), 0))
        top = d * (h * math.sin(lean)) + Vector((0, 0, h))
        if lod == 0: b.tube([d * .02, top], [.012, .007], 3)
        else: b.blade(d * .02, top, .02)
        b.frond(top, a + rng.r(-.2, .2), rng.r(.62, .72), rng.r(.3, .34), rng.r(.55, .7), rng.r(-.7, -.5), pin, droop=.12,
                serr=False, twist=.1, shape='delta', kite=lod == 2)
    return b

def m_gorse(rng, lod):
    """gorse: a full rounded dome of short-spined shoots, a couple of lower side lobes, yellow flowers spread over the top"""
    b = Build()
    def flowers(n, r):
        for i in range(n):
            z = .95 - (i + .5) / n * .85; rr = math.sqrt(max(0, 1 - z * z)); a = i * 2.39996 + .7
            cid = 0 if (i % 3 or len(b.clumps) == 1) else 1 + (i // 3) % (len(b.clumps) - 1)
            c, rad = b.clumps[cid]; sq = b.sq[cid]
            b.bead(c + Vector((rr * math.cos(a) * sq[0], rr * math.sin(a) * sq[1], z * sq[2])) * rad / max(sq) * 1.02, r, cid=cid)
    b.clump((0, 0, .47), .6 * (1, 1, 1.09)[lod], (1.1, 1, .84), (1, 1, 0)[lod], .16, 2)
    b.clump((.42, .16, .3), .36 * (1, 1.09, 1.09)[lod], (1, 1, .85), (1, 0, 0)[lod], .2, 6)
    b.clump((-.36, -.3, .27), .32 * (1, 1.09, 1.09)[lod], (1, 1, .85), (1, 0, 0)[lod], .2, 8)
    if lod < 2:
        b.spikes(0, (24, 12)[lod], (.13, .15)[lod], (.05, .06)[lod], -.1, 1, up=.2)
        b.spikes(1, (6, 3)[lod], .11, .045, -.1, 2); b.spikes(2, (6, 3)[lod], .11, .045, -.1, 3)
    flowers((28, 14, 8)[lod], (.075, .105, .13)[lod])
    return b

def m_heather(rng, lod):
    """heather: a cushion of ragged clumps heaped into a mound, purple flower spikes standing thick out of the top"""
    b = Build(); n = 5
    for k in range(n):
        a = k / max(n - 1, 1) * 6.28 + rng.r(0, .8); off = rng.r(.22, .3) if k else 0
        s, f = lo(1, lod)
        b.clump((math.cos(a) * off, math.sin(a) * off, .17 if k else .24), (rng.r(.22, .27) if k else .35) * f, (1.12, 1.05, .9),
                s, .2, k * 5 + 1, rag=(.2, .18, .14)[lod])
    sp = (12, 6, 5)[lod]
    for k in range(n if lod < 2 else 1):
        b.spikes(k, sp if k == 0 else max(2, sp * 2 // 3), (.15, .16, .17)[lod], (.035, .042, .05)[lod], .3, k, part=Build.FLOWER, up=1.3)
    return b

# ---------------------------------------------------------------- colour bake (sRGB palette, final colour incl. AO)
P = {k: hexc(v) for k, v in dict(
    hzDark='#1c2d1e', hzMid='#3b5a2f', hzLite='#79994a', hzWarm='#8f8b4c', bark='#4a3b30', bark2='#2c231d',
    hoDark='#14231b', hoMid='#25412f', hoLite='#5f8a66', berry='#8e2a22',
    brDark='#1f2f1d', brMid='#3d5530', brLite='#6c8240', cane='#5a3a32', cane2='#3a2622', bb='#2a1626', bbRed='#7a2c26',
    fnDark='#203a20', fnMid='#3f632e', fnLite='#78a043',
    bkDark='#2e4220', bkMid='#527030', bkLite='#83a044', bkRust='#7e5a2e', stipe='#5a4a2a',
    goDark='#1c2c1b', goMid='#34532a', goLite='#64903e', goFl='#d2a22c', goFl2='#e2bc46',
    heWood='#3a3026', heMid='#544452', hePurp='#70547c', heLite='#927498', heDead='#6e5a44').items()}
FIB = [Vector((math.sqrt(1 - z * z) * math.cos(i * 2.39996), math.sqrt(1 - z * z) * math.sin(i * 2.39996), z))
       for i, z in ((i, (i + .5) / 24) for i in range(24))]

def frame(n):
    t = Vector((0, 0, 1)) if abs(n.z) < .9 else Vector((1, 0, 0))
    b = n.cross(t).normalized(); return b.cross(n), b

def bake_ao(bvh, p, n, maxd):
    t, b = frame(n); occ = 0.0; tot = 0.0; o = p + n * .012
    for d0 in FIB:
        d = (t * d0.x + b * d0.y + n * d0.z).normalized(); w = d0.z; tot += w
        hit = bvh.ray_cast(o, d, maxd); dist = hit[3] if hit[0] is not None else 1e9
        if d.z < -1e-3: dist = min(dist, max(0, -o.z / d.z))     # the ground
        if dist < maxd: occ += w * (1 - dist / maxd) ** .8
    return 1 - occ / tot

def colour(kind, p, n, ao, part, heart, top, lod, cid=-1):
    """heart: 0 at a clump/bush centre .. 1 at its skin; top: height 0..1 over the model"""
    up = n.z; h = vhash(p, 9, 3); h2 = vhash(p, 5.3, 7); lit = clamp(.5 + .5 * up) * smooth(.45, 1, heart)
    if part == Build.FLOWER:
        if kind == 'gorse': return P['goFl'].lerp(P['goFl2'], h2) * (.75 + .25 * ao)
        if kind == 'heather': return P['hePurp'].lerp(P['heLite'], smooth(.2, 1, top)) * (.5 + .5 * ao)
        if kind == 'holly': return P['berry'] * (.7 + .3 * ao)
        if kind == 'bramble': return (P['bb'] if h2 > .35 else P['bbRed']) * (.7 + .3 * ao)
    if part == Build.STEM:
        c = P['bark2'].lerp(P['bark'], clamp(.5 + .5 * up))
        if kind == 'bramble': c = P['cane2'].lerp(P['cane'], .3 + .7 * top)
        if kind in ('bracken',): c = P['stipe'] * .8
        if kind in ('gorse', 'heather'): c = P['heWood']
        return c * (.55 + .45 * ao)
    ch = hash1(cid, 17) if cid >= 0 else h2          # one value per leaf clump: whole clumps vary, not single facets
    sky = clamp(.5 + .5 * up)
    if kind == 'hazel':
        c = P['hzDark'].lerp(P['hzMid'], smooth(.05, .75, heart * .55 + top * .35 + sky * .25))
        c = c.lerp(P['hzLite'], smooth(.45, .95, sky) * smooth(.5, 1, heart) * (.45 + .55 * top) * .9)
        c = c.lerp(P['hzWarm'], .32 * smooth(.72, .9, ch) * smooth(.4, .9, sky))
    elif kind == 'holly':
        c = P['hoDark'].lerp(P['hoMid'], smooth(.05, .8, heart * .6 + top * .25 + sky * .25))
        c = c.lerp(P['hoLite'], smooth(.55, .95, sky) * smooth(.55, 1, heart) * (.5 + .3 * h))
    elif kind == 'bramble':
        c = P['brDark'].lerp(P['brMid'], smooth(.05, .8, heart * .6 + top * .35 + sky * .2))
        c = c.lerp(P['brLite'], smooth(.5, .95, sky) * smooth(.5, 1, heart) * .75)
        c = c.lerp(P['bkRust'], .22 * smooth(.78, .95, ch) * sky)
    elif kind == 'fern':
        c = P['fnDark'].lerp(P['fnMid'], smooth(0, .55, top)).lerp(P['fnLite'], smooth(.45, 1, top) * clamp(.4 + .6 * up))
    elif kind == 'bracken':
        c = P['bkDark'].lerp(P['bkMid'], smooth(0, .6, top)).lerp(P['bkLite'], smooth(.55, 1, top) * clamp(.3 + .7 * up))
        c = c.lerp(P['bkRust'], .55 * smooth(.6, .9, vhash(p, 2.2, 11)) * smooth(.4, 1, top))
    elif kind == 'gorse':
        lit = clamp(.45 + .55 * up) * smooth(.3, .95, heart)
        c = P['goDark'].lerp(P['goMid'], smooth(.1, .7, heart)).lerp(P['goLite'], lit * .95)
        return c * (.7 + .3 * ao)
    elif kind == 'heather':
        c = P['heWood'].lerp(P['heMid'], smooth(.05, .35, top)).lerp(P['hePurp'], smooth(.2, .6, top * .6 + sky * .4) * smooth(.3, .8, heart))
        c = c.lerp(P['heLite'], smooth(.5, .95, sky) * smooth(.6, 1, top) * .35)
        c = c.lerp(P['heDead'], .45 * smooth(.8, .95, ch))
    else:
        c = Vector((.5, .5, .5))
    return c * (.58 + .42 * ao)

# ---------------------------------------------------------------- per-vertex data: normals, colours
def vertex_data(kind, obj, ref, lod):
    """ref: (bvh, kd, part list, cid list, clumps) from the un-decimated model of the same level (AO from LOD0)"""
    bvh, kd, parts, cids, clumps, zmax = ref
    me = obj.data; me.update()
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table(); bm.normal_update()
    gc = Vector((0, 0, zmax * .42))
    out = []; pl = []
    for v in bm.verts:
        p = v.co; _, j, _ = kd.find(p); part = parts[j]; cid = cids[j]
        if part == Build.LEAF and cid >= 0 and cid < len(clumps):
            c, r = clumps[cid]; dv = (p - Vector(c)); heart = clamp(dv.length / max(r, 1e-3))
            dc = dv.normalized(); db = (p - gc); db.z *= .7; db = db.normalized()
            n = (v.normal * .3 + dc * .45 + db * .35).normalized()
        elif part == Build.FROND:
            o = Vector((p.x, p.y, 0)); o = o.normalized() if o.length > 1e-4 else Vector((0, 0, 0))
            n = (Vector((0, 0, 1)) * .7 + o * .45).normalized(); heart = 1.0
        else:
            n = v.normal.copy(); heart = 1.0
        top = clamp(p.z / max(zmax, 1e-3))
        if part == Build.FROND: top = clamp(.25 + .75 * Vector((p.x, p.y)).length / .7) * .6 + top * .4
        ao = bake_ao(bvh, p, n if part != Build.FROND else Vector((0, 0, 1)), .55 if part != Build.FROND else .35)
        out.append((p.copy(), n, colour(kind, p, n, ao, part, heart, top, lod, cid))); pl.append(part)
    tris = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return out, tris, pl

def tone(verts, tris, parts):
    """area-weighted mean colour per part"""
    acc = {}
    for t in tris:
        a, b, c = (verts[i][0] for i in t); w = (b - a).cross(c - a).length * .5
        m = acc.setdefault(parts[t[0]], [Vector((0, 0, 0)), 0.0])
        m[0] += (verts[t[0]][2] + verts[t[1]][2] + verts[t[2]][2]) * (w / 3); m[1] += w
    return {k: v[0] / max(v[1], 1e-9) for k, v in acc.items()}

def match_tone(verts, tris, parts, ref):
    """scale each part's colours so its mean tone is the full model's (the coarser pieces hide fewer dark hearts)"""
    me = tone(verts, tris, parts); g = {}
    for k, m in me.items():
        r = ref.get(k, m); g[k] = Vector([clamp(r[i] / max(m[i], 1e-4), .8, 1.25) for i in range(3)])
    return [(p, n, Vector((c.x * g[pt].x, c.y * g[pt].y, c.z * g[pt].z))) for (p, n, c), pt in zip(verts, parts)]

def bounds(obj): vs = [v.co for v in obj.data.vertices]; return [min(v[k] for v in vs) for k in range(3)], [max(v[k] for v in vs) for k in range(3)]

def match_bounds(obj, ref):
    """stretch a coarser level to the full model's footprint and height (about the foot)"""
    (a0, b0), (a1, b1) = ref, bounds(obj)
    c0 = [(a0[k] + b0[k]) / 2 for k in range(2)]; c1 = [(a1[k] + b1[k]) / 2 for k in range(2)]
    sc = [clamp((b0[k] - a0[k]) / max(b1[k] - a1[k], 1e-4), .88, 1.14) for k in range(2)] + [clamp(b0[2] / max(b1[2], 1e-4), .88, 1.14)]
    for v in obj.data.vertices: v.co = Vector((c0[0] + (v.co.x - c1[0]) * sc[0], c0[1] + (v.co.y - c1[1]) * sc[1], v.co.z * sc[2]))
    k = (sc[0] + sc[1] + sc[2]) / 3
    obj['clumps'] = [[c0[0] + (c[0] - c1[0]) * sc[0], c0[1] + (c[1] - c1[1]) * sc[1], c[2] * sc[2], c[3] * k] for c in obj['clumps']]

def reference(obj):
    me = obj.data; me.update()
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    pl = bm.verts.layers.int.get('part'); cl = bm.verts.layers.int.get('cid')
    parts = [v[pl] for v in bm.verts]; cids = [v[cl] for v in bm.verts]
    kd = KDTree(len(bm.verts))
    for v in bm.verts: kd.insert(v.co, v.index)
    kd.balance(); bvh = BVHTree.FromBMesh(bm); zmax = max(v.co.z for v in bm.verts); bm.free()
    return kd, parts, cids, [(Vector(c[:3]), c[3]) for c in obj['clumps']], zmax, bvh

# ---------------------------------------------------------------- export
def b64(fmt, vals): return base64.b64encode(struct.pack('<%d%s' % (len(vals), fmt), *vals)).decode()

def export(verts, tris):
    co = [Vector((p.x, p.z, -p.y)) for p, _, _ in verts]
    mn = [min(c[k] for c in co) for k in range(3)]; mx = [max(c[k] for c in co) for k in range(3)]
    ext = [max(mx[k] - mn[k], 1e-6) for k in range(3)]
    q = []; nq = []; cq = []; ix = []
    for c in co:
        for k in range(3): q.append(int(round((c[k] - mn[k]) / ext[k] * 65535)) - 32768)
    for _, n, _ in verts:
        g = Vector((n.x, n.z, -n.y)).normalized(); nq += [int(round(g.x * 127)), int(round(g.y * 127)), int(round(g.z * 127))]
    for _, _, c in verts: cq += [int(round(clamp(c.x) * 255)), int(round(clamp(c.y) * 255)), int(round(clamp(c.z) * 255))]
    for t in tris: ix += t
    return dict(tris=len(tris), verts=len(verts), min=[round(v, 4) for v in mn], size=[round(v, 4) for v in ext],
                p=b64('h', q), n=b64('b', nq), c=b64('B', cq), i=b64('H', ix))

# ---------------------------------------------------------------- the list: name, builder, budgets per level, seed
KINDS = [
    ('shrub',   m_hazel,   (400, 140, 48), 11),
    ('holly',   m_holly,   (400, 156, 56), 23),
    ('bramble', m_bramble, (400, 140, 56), 37),
    ('bracken', m_bracken, (132, 52, 20), 41),
    ('fern',    m_fern,    (180, 48, 24), 53),
    ('gorse',   m_gorse,   (460, 205, 92), 67),
    ('heather', m_heather, (380, 166, 60), 79),
]
COLKIND = {'shrub': 'hazel'}

# ---------------------------------------------------------------- contact sheets
def contact_sheets(rows, outdir):
    sc = bpy.context.scene; sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading; sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = False; sh.show_shadows = False
    sc.render.resolution_x = 1100; sc.render.resolution_y = 650
    world = bpy.data.worlds.new('w'); sc.world = world; world.color = (.42, .44, .5)
    try: sc.view_settings.view_transform = 'Standard'
    except Exception: pass
    sp = 2.0
    for r, objs in enumerate(rows):
        for c, o in enumerate(objs): o.location = (c * sp * 1.15, 0, -r * 1.55)
    cam_d = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_d); sc.collection.objects.link(cam); sc.camera = cam
    cam_d.type = 'ORTHO'; cx = sp * 1.15; cz = -(len(rows) - 1) * 1.55 / 2 + .4
    cam_d.ortho_scale = len(rows) * 1.55 * 1.7
    files = []
    for nm, d, mode in (('colour', (.55, -1, .32), 'VERTEX'), ('silhouette', (0, -1, .08), 'SINGLE'), ('top', (.3, -.6, 1), 'VERTEX')):
        dv = Vector(d).normalized(); cam.location = Vector((cx, 0, cz)) + dv * 60
        cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
        if mode == 'SINGLE': sh.light = 'FLAT'; sh.color_type = 'SINGLE'; sh.single_color = (0, 0, 0); world.color = (1, 1, 1)
        else: sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; world.color = (.42, .44, .5)
        if nm == 'top':
            cam_d.ortho_scale = len(rows) * 1.55 * 1.7
        f = os.path.join(outdir, 'blender-%s.png' % nm); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
    # close-ups of LOD0 per kind, large
    for r, objs in enumerate(rows):
        for o in [x for row in rows for x in row]: o.hide_render = True
        for o in objs: o.hide_render = False
        sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; world.color = (.42, .44, .5)
        dv = Vector((.5, -1, .45)).normalized(); c0 = Vector((cx, 0, -r * 1.55 + .4)); cam.location = c0 + dv * 60
        cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler(); cam_d.ortho_scale = 6.2
        sc.render.resolution_x = 900; sc.render.resolution_y = 380
        f = os.path.join(outdir, 'blender-kind-%s.png' % objs[0].name.split('_')[0]); sc.render.filepath = f; bpy.ops.render.render(write_still=True); files.append(f)
    return files

# ---------------------------------------------------------------- main
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    only = set(A.only.split(',')) if A.only else None
    out = {}; rows = []; t0 = time.time()
    for name, fn, budgets, seed in KINDS:
        if only and name not in only: continue
        ck = COLKIND.get(name, name); rec = []; objs = []; ref0 = None
        for lod in range(3):
            obj = fn(RNG(seed * 1009 + 7), lod).finish('%s_%d' % (name, lod))
            if ref0 is None: box0 = bounds(obj)
            else: match_bounds(obj, box0)
            kd, parts, cids, clumps, zmax, bvh = reference(obj)
            if ref0 is None: ref0 = bvh                         # every level is shaded against the full model
            tri = decimate(obj, budgets[lod])
            verts, tris, vp = vertex_data(ck, obj, (ref0, kd, parts, cids, clumps, zmax), lod)
            if lod == 0: tone0 = tone(verts, tris, vp)
            else: verts = match_tone(verts, tris, vp, tone0)
            rec.append(export(verts, tris))
            ca = obj.data.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
            for i, (_, _, c) in enumerate(verts): ca.data[i].color_srgb = (min(1, c.x * 1.5), min(1, c.y * 1.5), min(1, c.z * 1.5), 1)
            obj.data.color_attributes.active_color = ca
            objs.append(obj)
            print('%-8s lod%d tris %4d (budget %d) verts %4d size %s' % (name, lod, tri, budgets[lod], len(verts), rec[-1]['size']), flush=True)
        out[name] = rec; rows.append(objs)
    if not A.no_export and not only:
        data = dict(v=1, axes='y-up, origin at the foot, metres', kinds=out)
        js = ('/* generated by tools/florakit/build_bushes.py (Blender %s) -- do not edit by hand */\n' % bpy.app.version_string +
              '(function(){window.G=window.G||{};G.bushkitData=' + json.dumps(data, separators=(',', ':')) + ';})();\n')
        open(A.out, 'w').write(js); print('wrote', A.out, len(js), 'bytes', flush=True)
    if A.shots:
        os.makedirs(A.shots, exist_ok=True)
        for f in contact_sheets(rows, A.shots): print('shot', f)
    print('done in %.1fs' % (time.time() - t0))

main()
