# Invisible barriers on the home island: no collider without something drawn where it stands.
# A playtester was stopped in open grass on the north moor below the cliff path, early in a new game: a scree fan's two
# colliders (cliffkit.js) had been worked out from the cliff's foot 26 m away from the rock itself. This suite keeps that
# class of bug out:
#   - the reported spot, walked with the stick (G.input.setVirtual) from two sides: it must not stop in the open
#   - cliffkit: no placement's collider is further than its radius from its own rock (K.debug.orphanCols stays empty)
#   - the sweep: every circle and box collider on the island that a walker can reach (walkable ground round it, its height
#     band meeting the ground's) must have a drawn mesh inside it: an instance's bounds, or a ray hit on a merged mesh.
#     Run on every quality level (cliffkit keeps fewer rocks on the lower ones, with their colliders).
#   - the moored boat's collider is only there once she is (before that it was a post in the shallows off the south beach)
# Usage: python3 test/barriers_e2e.py "http://localhost:PORT/dev.html?debug&headless"
import asyncio, json, sys, time
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8995/dev.html?debug&headless"

HELPERS = r"""
window.BT={
  start(){ G.devtools.start('story'); for(let i=0;i<60;i++){ G.step(1/30,5); if(G.cine&&G.cine.on)G.cine.skip(); G.ui.advance&&G.ui.advance(); } },
  // hold the stick forward along yaw for n frames from (x,z); where it ends, and where (if anywhere) it stopped dead
  walk(x,z,yaw,n){ const P=G.player; P.teleport(x,G.floorAt(x,z),z,yaw); G.step(1/30,5); P.aimCamera(yaw,.15); G.input.setVirtual('forward',true);
    let last={x:P.pos.x,z:P.pos.z}, stall=null;
    for(let i=0;i<n;i++){ if(G.cine.on)G.cine.skip(); G.step(1/30,1); const d=Math.hypot(P.pos.x-last.x,P.pos.z-last.z);
      if(i>10&&d<.02&&!stall)stall=[+P.pos.x.toFixed(2),+P.pos.z.toFixed(2)]; last={x:P.pos.x,z:P.pos.z}; }
    G.input.setVirtual('forward',false); G.step(1/30,3); return {end:[+P.pos.x.toFixed(1),+P.pos.z.toFixed(1)],stall}; },
  // the sweep: colliders a walker can meet with nothing drawn inside them
  sweep(){ const T=G.THREE, rc=new T.Raycaster();
    const SKIP=new Set(['terrain','grass','grassFar','sky','sea','fogWall','cliffFoam','northVeil','corruptionPatches','caveContactRing','outline']);
    const me=G.player.model;   // Rowan himself, standing by a stray collider, doesn't excuse it
    const vis=o=>{ for(let p=o;p;p=p.parent)if(!p.visible||p===me)return false; return true; };
    const meshes=[], boxes=new Map(), CK=8, key=(x,z)=>Math.floor(x/CK)+','+Math.floor(z/CK), m=new T.Matrix4(), bb=new T.Box3();
    G.scene.updateMatrixWorld(true);
    // undergrowth is walked through (it has no colliders), so a bush standing in a stray collider doesn't excuse it
    G.scene.traverse(o=>{ if(!o.isMesh||SKIP.has(o.name)||/^undergrowth/.test(o.name)||!vis(o))return;
      if(o.material&&!Array.isArray(o.material)&&o.material.transparent&&o.material.opacity<.5)return;
      // instanced meshes carry a bounding sphere for the whole tile, which three's per-instance raycast misreads: use each instance's box
      if(o.isInstancedMesh){ const g=o.geometry; if(!g._bt){ g._bt=new T.Box3().setFromBufferAttribute(g.attributes.position); }
        for(let i=0;i<o.count;i++){ o.getMatrixAt(i,m); m.premultiply(o.matrixWorld); bb.copy(g._bt).applyMatrix4(m); if(bb.isEmpty())continue;
          const e={x0:bb.min.x,x1:bb.max.x,z0:bb.min.z,z1:bb.max.z,y0:bb.min.y,y1:bb.max.y};
          for(let x=Math.floor(e.x0/CK);x<=Math.floor(e.x1/CK);x++)for(let z=Math.floor(e.z0/CK);z<=Math.floor(e.z1/CK);z++){ const k=x+','+z; if(!boxes.has(k))boxes.set(k,[]); boxes.get(k).push(e); } } }
      else meshes.push(o); });
    const cols=new Set(); for(let x=-264;x<=264;x+=8)for(let z=-144;z<=144;z+=8)for(const c of G.collidersNear(x,z))cols.add(c);
    for(const b of G.boxColliders){ const cs=Math.cos(b.yaw||0),sn=Math.sin(b.yaw||0), rr=Math.min(b.hw,b.hd), nx=Math.max(1,Math.round(b.hw/rr)), nz=Math.max(1,Math.round(b.hd/rr));
      for(let i=0;i<nx;i++)for(let j=0;j<nz;j++){ const lx=-b.hw+(i+.5)*2*b.hw/nx, lz=-b.hd+(j+.5)*2*b.hd/nz; cols.add({x:b.x+lx*cs+lz*sn,z:b.z-lx*sn+lz*cs,r:rr,y0:b.y0,y1:b.y1,box:true}); } }
    const flags=[]; let n=0;
    for(const c of cols){ if(Math.abs(c.x)>262||Math.abs(c.z)>142)continue;   // the home island only (interiors sit 800 m out)
      let gmin=1e9,gmax=-1e9,walk=0;
      for(let k=0;k<12;k++){ const a=k/12*Math.PI*2, x=c.x+Math.sin(a)*(c.r+.45), z=c.z+Math.cos(a)*(c.r+.45); if(G.world.walkable(x,z)){ walk++; const g=G.floorAt(x,z); gmin=Math.min(gmin,g); gmax=Math.max(gmax,g); } }
      if(!walk||c.y0>gmax+1.6||c.y1<gmin)continue; n++;
      const ya=Math.max(gmin,c.y0), yb=Math.min(gmax+1.8,c.y1), rr=c.r*.7; let hit=false;
      for(const e of boxes.get(key(c.x,c.z))||[]){ if(e.y1<ya||e.y0>yb)continue; const qx=Math.max(e.x0,Math.min(c.x,e.x1)), qz=Math.max(e.z0,Math.min(c.z,e.z1)); if(Math.hypot(qx-c.x,qz-c.z)<rr){ hit=true; break; } }
      for(const d of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){ if(hit)break;
        rc.set(new T.Vector3(c.x+d[0]*c.r*.5,yb+30,c.z+d[1]*c.r*.5),new T.Vector3(0,-1,0)); rc.far=30+(yb-ya)+.01; hit=rc.intersectObjects(meshes,false).length>0; }
      for(const hy of [.4,1.2]){ if(hit)break; for(let k=0;k<8&&!hit;k++){ const a=k/8*Math.PI*2, dx=Math.sin(a), dz=Math.cos(a), R0=c.r+2;
        rc.set(new T.Vector3(c.x+dx*R0,ya+hy,c.z+dz*R0),new T.Vector3(-dx,0,-dz)); rc.far=R0-rr; hit=rc.intersectObjects(meshes,false).length>0; } }
      if(!hit)flags.push({x:+c.x.toFixed(1),z:+c.z.toFixed(1),r:+c.r.toFixed(2),box:!!c.box,y0:c.y0>-1e8?+c.y0.toFixed(1):null,y1:c.y1<1e8?+c.y1.toFixed(1):null,ground:+gmin.toFixed(1)}); }
    return {checked:n,flags}; },
  // cliffkit: every live collider within its radius of its own rock (judged on the rock's above-ground vertices)
  cliffkitFit(){ const K=G.cliffkit, T=G.THREE, out=[], m=new T.Matrix4(), q=new T.Quaternion(), e=new T.Euler(), v=new T.Vector3(), gh=(x,z)=>(G.world.groundY||G.world.height)(x,z);
    for(const o of K.placements){ if(!o.col||!o.col.length)continue; const P=K.pieces[o.piece], A=P.geo.attributes.position;
      const s=o.scale==null?1:o.scale, sx=Array.isArray(s)?s[0]:s, sy=Array.isArray(s)?s[1]:s, sz=Array.isArray(s)?s[2]:s;
      m.compose(new T.Vector3(o.x,o.y,o.z),q.setFromEuler(e.set(o.pitch||0,o.yaw||0,o.roll||0,'YXZ')),new T.Vector3(sx,sy,sz));
      const pts=[]; for(let k=0;k<A.count;k+=2){ v.fromBufferAttribute(A,k).applyMatrix4(m); if(v.y>gh(v.x,v.z)-.2)pts.push(v.x,v.z); }
      for(const c of o.col){ let best=1e9; for(let k=0;k<pts.length;k+=2)best=Math.min(best,Math.hypot(pts[k]-c.x,pts[k+1]-c.z));
        if(best>c.r)out.push({piece:o.piece,at:[+o.x.toFixed(1),+o.z.toFixed(1)],col:[+c.x.toFixed(1),+c.z.toFixed(1),+c.r.toFixed(2)],off:+best.toFixed(1)}); } }
    return {placements:K.placements.length,orphans:K.debug.orphanCols||null,far:out}; }
};
"""

async def main():
    fails = []
    def check(name, ok, info=''):
        print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info)[:600], flush=True)
        if not ok: fails.append(name)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':960,'height':540}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        t0 = time.time()
        await pg.goto(URL, timeout=180000); await pg.wait_for_timeout(4000)
        await pg.evaluate(HELPERS)
        await pg.evaluate("BT.start()")
        st = await pg.evaluate("[G.state.mode,G.quest.step]")
        check('story start', st == ['play','cottage'], st)

        # the reported spot: north moor below the cliff path, ~105 m from the cottage door; walk it with the stick
        for name, args, past in [('walk east through the spot', '78,-58.5,Math.PI/2,150', lambda e: e[0] > 92),
                                 ('walk north-east through the spot', '80,-62,0.9,150', lambda e: e[0] > 90),
                                 ('walk north-west back through it', '90,-64,-0.75,90', lambda e: e[0] < 84)]:
            r = await pg.evaluate(f"BT.walk({args})")
            check(name, past(r['end']), r)

        r = await pg.evaluate("BT.cliffkitFit()")
        check('cliffkit: no collider dropped for want of rock', r['orphans'] == [], r['orphans'])
        check('cliffkit: every collider on its own rock', r['placements'] > 50 and not r['far'], r)

        for lv in ['balanced', 'saver', 'high']:
            await pg.evaluate(f"G.setQuality('{lv}'); G.step(1/30,3)")
            r = await pg.evaluate("BT.sweep()")
            check(f'sweep ({lv}): nothing invisible in the way', r['checked'] > 500 and not r['flags'], r)
        await pg.evaluate("G.setQuality('balanced')")

        r = await pg.evaluate("""(()=>{ const m=G.boat.debug.moor, live=()=>G.collidersNear(m.x,m.z).some(c=>Math.abs(c.x-m.x)<.01&&Math.abs(c.z-m.z)<.01&&c.r===1.4);
          const before=live(); G.boat.debug.build&&G.boat.debug.build(true); const built=G.boat.built, after=live(); return {before,built,after}; })()""")
        check('boat: no mooring collider before she is patched', r['before'] is False, r)
        if r['built']: check('boat: the mooring collider once she is', r['after'] is True, r)
        else: print('SKIP boat built  (no debug build hook)')

        check('no page errors', not errs, errs[:3])
        print(f'time {time.time()-t0:.0f}s')
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)))
    sys.exit(1 if fails else 0)
asyncio.run(main())
