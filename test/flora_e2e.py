"""The plants: trees (tree kit), bushes and ferns (undergrowth), grass and the far grass, wild flowers.
- the plant modules are loaded and built, with no page or console errors;
- the layout is the one on main: a checksum over every tree's matrix, every circle and box collider in the order the game
  adds them, the fern, bush and flower placements and the plant counts in W.stats equals the value measured on main (the same
  function reads the trees from the world's tree tiles and the small plants from wherever they are drawn, so it gives the same
  value with or without the plant kits);
- the ground the game walks on is unchanged (the cliffs suite's sample of G.world.height / walkable / groundY);
- quality high -> balanced -> saver -> balanced switches without errors or a reload, and from two fixed viewpoints (inside the
  wood, out on the moor) fewer plant triangles are drawn on saver than on balanced, and on balanced than on high;
- budgets against main measured the same way from the same viewpoints: plant triangles on saver below main's saver figure,
  on balanced no more than main's balanced figure + 5 %, on high no more than 1.6 x main's balanced; plant draw calls no more
  than main's + 12;
- the fallbacks: with the tree kit's data blocked the trees are built the old way, with the bush kit's data blocked the
  ferns and bushes are, and the layout checksum is the same each time.
usage: python3 test/flora_e2e.py [url] [--measure]   (default http://localhost:8800/dev.html?debug&headless)
  --measure prints the layout checksum and the per-viewpoint figures instead of checking them (how the constants below
  were taken on main)."""
import asyncio, sys, time, json
from playwright.async_api import async_playwright
ARGS=[a for a in sys.argv[1:] if not a.startswith('--')]
URL=ARGS[0] if ARGS else 'http://localhost:8800/dev.html?debug&headless'
MEASURE='--measure' in sys.argv
LAYOUT_ONLY='--layout-only' in sys.argv   # with --measure: stop after the layout

# ---- measured on main (origin/main 57298c9, before the plant work) with this file's --measure, 960x600 ----
LAYOUT_HASH='2006640d'   # 771 trees, 2106 ferns, 822 bushes, 8451 flowers (after the hollow is cleared), 1217 circle + 238 box colliders
# (re-taken for the charcoal kiln in the old wood: 3 ferns and 3 bushes left out of its clearing, and its own collider; main was 7ddccccf)
# (re-taken when the invisible barriers went: a cliff scree's colliders moved onto its rock, the hidden boat's mooring post no longer added at build)
MAIN={'forest':{'saver':{'tris':598361,'draws':68},'balanced':{'tris':743561,'draws':68},'high':{'tris':859721,'draws':68}},   # plant triangles / draw calls in view
      'moor':{'saver':{'tris':723810,'draws':88},'balanced':{'tris':869010,'draws':88},'high':{'tris':985170,'draws':88}}}
# the cliffs suite's ground sample and the value it measured on main (unchanged by the plants)
GROUND_HASH='750d31fc:12567'
GROUND="""(()=>{ const W=G.world, t0=W.tide; W.tide=0; let h=2166136261>>>0, n=0;
  const mix=v=>{ h=Math.imul(h^(v|0),16777619)>>>0; };
  const one=(x,z)=>{ mix(Math.round(W.height(x,z)*1000)); mix(W.walkable(x,z)?1:2); if(W.groundY)mix(Math.round(W.groundY(x,z)*1000)); n++; };
  try{ for(let x=-300;x<=300;x+=7.3)for(let z=-210;z<=210;z+=6.1)one(x,z);
       for(let x=88;x<=240;x+=1.7)for(let z=-72;z<=72;z+=1.9)one(x,z); }
  finally{ W.tide=t0; }
  return (h>>>0).toString(16)+':'+n; })()"""

# every collider call in order, recorded from the first one (installed before the world is built)
INIT=r"""(()=>{ window.__col=[]; window.__box=[]; window.__boot=Math.random();
  const wrap=()=>{ const G=window.G; if(!G||!G.addCollider||G.addCollider.__fl)return;
    const ac=G.addCollider; G.addCollider=function(c){ window.__col.push([c.x,c.z,c.r,c.y0,c.y1]); return ac.apply(this,arguments); }; G.addCollider.__fl=1;
    const ab=G.addBoxCollider; G.addBoxCollider=function(b){ window.__box.push([b.x,b.z,b.hw,b.hd,b.yaw||0,b.y0,b.y1]); return ab.apply(this,arguments); }; };
  new MutationObserver(wrap).observe(document,{childList:true,subtree:true}); })();"""

# which meshes are plants: the tree kit's meshes, the undergrowth's meshes, anything drawn with the tree trunk / leaf
# materials (old trees and bushes, the kit's near pools), and the double-sided vertex-coloured instanced plants (grass, far
# grass, old ferns, flowers). The same rule holds on main, where none of the kits exist.
PLANT_JS=r"""const T=G.THREE, TT=G.world._treeTiles, PM=new Set(), TG=new Set();
  for(const k of ['oakT','oakC','pineT','pineC'])for(const t of TT[k]){ PM.add(t.mat); TG.add(t.geo.attributes.position); }
  if(TT.mats){ PM.add(TT.mats.trunk); PM.add(TT.mats.leaf); }
  const dsi=o=>o.isInstancedMesh&&!Array.isArray(o.material)&&o.material.side===T.DoubleSide&&o.geometry.attributes.color&&!o.geometry.attributes.uv;
  const isPlant=o=>!!(o.userData.bqTreeMesh||o.userData.bqUnder||PM.has(o.material)||dsi(o));"""
COUNT=r"""(()=>{ """+PLANT_JS+r"""
  const cam=G.camera; cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const fr=new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse));
  const r={tris:0,draws:0,all:0};
  G.scene.traverseVisible(o=>{ if(!o.isMesh)return; if(o.frustumCulled&&!fr.intersectsObject(o))return; if(o.isInstancedMesh&&!o.count)return;
    const g=o.geometry; let n=g.index?g.index.count:g.attributes.position.count; if(g.drawRange&&g.drawRange.count!==Infinity)n=Math.min(n,g.drawRange.count);
    let t=n/3; if(o.isInstancedMesh)t*=o.count; if(!t)return; r.all+=t; if(isPlant(o)){ r.tris+=t; r.draws++; } });
  r.tris=Math.round(r.tris); r.all=Math.round(r.all); return r; })()"""
# the layout: trees from the world's tree tiles (what is placed, after the hollow is cleared); ferns, bushes and flowers
# from the undergrowth's own list when it draws them, else from the instanced meshes the old code builds; colliders in order
LAYOUT=r"""(()=>{ """+PLANT_JS+r"""
  const R=v=>v==null?'n':Math.round(Math.fround(v)*1000), key=a=>{ let s=''; for(let i=0;i<16;i++)s+=R(a[i])+','; return s; };
  // flowers: only where each stands (the grass work sizes them by the drifts they stand in, a look change that moves nothing)
  const keyP=a=>R(a[12])+','+R(a[13])+','+R(a[14]);
  const isFlower=g=>{ if(!g.boundingBox)g.computeBoundingBox(); return g.boundingBox.max.y-g.boundingBox.min.y<.6; };
  const trees=[]; for(const k of ['oakT','pineT'])for(const t of TT[k])for(const [,items] of t.t)for(const [m] of items)trees.push(k[0]+key(m.elements));
  const fern=[], bush=[], flower=[];
  const UG=G.undergrowth&&G.undergrowth.debug&&G.undergrowth.debug.list;
  if(UG)for(const o of UG)(o.grp==='fern'?fern:bush).push(key(o.src.elements));
  G.scene.traverse(o=>{ if(!o.isInstancedMesh||o.userData.bqTreeMesh||o.userData.bqUnder||/^grass/.test(o.name))return;
    if(TG.has(o.geometry.attributes.position))return;                       // old trees
    const isBush=PM.has(o.material), isDs=dsi(o); if(!isBush&&!isDs)return; const fl=isDs&&isFlower(o.geometry);
    const a=o.instanceMatrix.array; for(let i=0;i<o.count;i++){ const m=a.subarray(i*16,i*16+16); if(fl)flower.push(keyP(m)); else (isBush?bush:fern).push(key(m)); } });
  trees.sort(); fern.sort(); bush.sort(); flower.sort();
  let h=2166136261>>>0; const mix=s=>{ for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619)>>>0; h=Math.imul(h^10,16777619)>>>0; };
  const S=G.world.stats, st=[S.trees,S.ferns,S.bushes,S.flowers,S.rocks].join(',');
  const parts={trees,fern,bush,flower,col:window.__col.map(c=>c.map(R).join(',')),box:window.__box.map(c=>c.map(R).join(',')),stats:[st]}, n={}, sub={};
  for(const k in parts){ const h0=h; h=2166136261>>>0; for(const s of parts[k])mix(s); sub[k]=(h>>>0).toString(16); h=h0; for(const s of parts[k])mix(s); n[k]=parts[k].length; }
  return {hash:(h>>>0).toString(16), n, sub, stats:st, ug:!!UG}; })()"""
# frame a viewpoint: the Traveler stands where the camera is (so the plants' detail rings and the grass are centred on it)
VIEWS={'forest':(-112,-1,1.8,-132,4,2.0), 'moor':(25,-5,3.0,-20,30,2.0)}
def place(v):
    cx,cz,ce,tx,tz,tu=VIEWS[v]
    return f"""(()=>{{ const H=G.world.height, cy=Math.max(H({cx},{cz}),0)+{ce}, ty=Math.max(H({tx},{tz}),0)+{tu};
      G.player.teleport({cx},null,{cz}); G.cliffmat._debug.cam({cx},cy,{cz},{tx},ty,{tz}); G.focus.copy(G.player.pos);
      if(G.world.treeLOD)G.world.treeLOD.update(true); if(G.undergrowth&&G.undergrowth.update)G.undergrowth.update(true);
      return {COUNT}; }})()"""

FAIL=[]; SKIPS=[]
def check(name,cond,info=''):
    print(('PASS ' if cond else 'FAIL ')+name+('' if cond else '  '+str(info)[:500])); sys.stdout.flush()
    if not cond: FAIL.append(name)
def skip(name,why): print('SKIP '+name+'  ('+why+')'); SKIPS.append(name)

async def timed(name,coro,budget):
    t=time.time()
    try: r=await asyncio.wait_for(coro,budget)
    except asyncio.TimeoutError: check(name+' (within '+str(budget)+' s)',False,'timed out'); return None
    except Exception as e: check(name,False,repr(e)[:300]); return None
    print('  ['+name+' %.0f s]'%(time.time()-t)); sys.stdout.flush(); return r

BUILT="""({treekit:!!(G.treekit&&G.treekit.oaks&&G.treekit.oaks.length&&G.treekit.pines.length), treeLOD:!!(G.world.treeLOD&&G.world.treeLOD.far.length),
  undergrowth:!!(G.undergrowth&&G.undergrowth.stats&&G.undergrowth.stats.instances>0), ugMeshes:(()=>{let n=0; G.scene.traverse(o=>{if(o.userData.bqUnder)n++;}); return n;})(),
  grass:!!(G.scene.getObjectByName('grass')&&G.scene.getObjectByName('grass').parent), far:!!G.scene.getObjectByName('grassFar'),
  oldTrees:(()=>{ const TG=new Set(); const TT=G.world._treeTiles; for(const k of ['oakT','oakC','pineT','pineC'])for(const t of TT[k])TG.add(t.geo.attributes.position);
    let n=0; G.scene.traverse(o=>{ if(o.isInstancedMesh&&TG.has(o.geometry.attributes.position)&&!o.userData.bqTreeMesh)n++; }); return n; })(),
  cols:window.__col.length, level:G.quality.level})"""

async def main():
    t0=time.time()
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])

        async def boot(block=None):
            pg=await b.new_page(viewport={'width':960,'height':600}); errs=[]
            pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
            def con(m):
                if m.type!='error' or '404' in m.text: return
                if block and 'ERR_FAILED' in m.text: return        # the blocked data file itself
                errs.append('console: '+m.text)
            pg.on('console',con)
            await pg.add_init_script(INIT)
            if block: await pg.route('**/'+block,lambda r:r.abort())
            await pg.goto(URL,timeout=240000)
            await pg.wait_for_function("window.G&&G.flow&&document.getElementById('loading').textContent.startsWith('Ready')",timeout=240000)
            r=await pg.evaluate(BUILT)
            return pg,errs,r

        # ---- the game with every plant module ----
        res=await timed('boot',boot(),240)
        pg,errs,r=res if res else (None,[],None)
        ev=(lambda js:pg.evaluate(js)) if pg else None
        built=bool(r) and r['treekit'] and r['treeLOD'] and r['undergrowth'] and r['ugMeshes']>0 and r['grass'] and r['far'] and r['oldTrees']==0
        if not MEASURE:
            check('the tree kit, the undergrowth, the grass and the far grass are loaded and built',built,r)
            check('no page or console errors while loading',bool(r) and not errs,errs[:5])
        else: print('built',r,errs[:5])

        lay=None
        if r:
            lay=await timed('layout',ev(LAYOUT),90)
            if MEASURE: print('LAYOUT',json.dumps(lay))
            else: check('layout (trees, colliders, ferns, bushes, flowers, counts) is the one on main',bool(lay) and lay['hash']==LAYOUT_HASH,{'got':lay,'want':LAYOUT_HASH})
            g=await timed('ground hash',ev(GROUND),90)
            if MEASURE: print('GROUND',g)
            else: check('ground sample (height, walkable, groundY) matches main',g==GROUND_HASH,{'got':g,'want':GROUND_HASH})
        else:
            for n in ('layout is the one on main','ground sample matches main'): skip(n,'the page did not boot')

        # ---- quality switching and the triangle / draw budgets from two viewpoints ----
        fig={}
        if LAYOUT_ONLY: r=None
        if r:
            await ev("document.getElementById('title').hidden=true; G.setMode('play'); G.headless&&(G.headless.hold=true); 0")
            boot_id=await ev('window.__boot')
            for i,lv in enumerate(('high','balanced','saver','balanced')):
                n0=len(errs)
                ms=await timed('quality '+lv,ev(f"(()=>{{ const t=performance.now(); G.setQuality('{lv}'); G.step(1/30,2); return performance.now()-t; }})()"),90)
                if ms is None: continue
                for v in VIEWS:
                    c=await timed(f'{lv} {v}',ev(place(v)),60)
                    if c: fig.setdefault(v,{})[lv if i<3 else 'balanced2']=c
                same=await ev('window.__boot')==boot_id
                if not MEASURE: check(f'{lv}: switched without errors or reload ({ms:.0f} ms)',same and len(errs)==n0 and await ev('G.quality.level')==lv,{'errs':errs[n0:n0+3],'same page':same})
            print('figures',json.dumps(fig)); sys.stdout.flush()
            if MEASURE:
                print('MAIN',json.dumps({v:{l:{'tris':d[l]['tris'],'draws':d[l]['draws']} for l in ('saver','balanced','high') if l in d} for v,d in fig.items()}))
            else:
                for v in VIEWS:
                    d=fig.get(v,{})
                    if not all(l in d for l in ('saver','balanced','high')): skip(f'{v}: fewer triangles per lower level','a level did not report'); continue
                    s,bl,h=d['saver']['tris'],d['balanced']['tris'],d['high']['tris']
                    check(f'{v}: plant triangles saver {s} < balanced {bl} < high {h}',s<bl<h,d)
                    if 'balanced2' in d: check(f'{v}: back on balanced draws what balanced drew before',d['balanced2']['tris']==bl and d['balanced2']['draws']==d['balanced']['draws'],[d['balanced'],d['balanced2']])
                    M=MAIN.get(v)
                    if not M: skip(f'{v}: budgets against main','no figures from main'); continue
                    check(f'{v}: saver plant triangles {s} below main\'s {M["saver"]["tris"]}',s<M['saver']['tris'])
                    check(f'{v}: balanced plant triangles {bl} within main\'s {M["balanced"]["tris"]} + 5 %',bl<=M['balanced']['tris']*1.05)
                    check(f'{v}: high plant triangles {h} within 1.6 x main\'s balanced',h<=M['balanced']['tris']*1.6)
                    for l in ('saver','balanced','high'):
                        check(f'{v} {l}: plant draw calls {d[l]["draws"]} within main\'s {M[l]["draws"]} + 12',d[l]['draws']<=M[l]['draws']+12)
            if not MEASURE: check('no page or console errors in the run with every plant module',not errs,errs[:6])
            await pg.close()
        else: skip('quality switching and budgets','the page did not boot')

        # ---- the fallbacks: each kit's data blocked, the old plants are built and the layout is the same ----
        if not MEASURE and lay:
            for f,what,good in (('treekit_data.js','trees',lambda r:not r['treekit'] and not r['treeLOD'] and r['oldTrees']>0 and r['undergrowth']),
                                ('bushkit_data.js','ferns and bushes',lambda r:not r['undergrowth'] and r['ugMeshes']==0 and r['treekit'])):
                res=await timed('boot without '+f,boot(f),240)
                if not res: continue
                pg2,e2,r2=res
                check(f'without {f}: the {what} are built the old way, no errors',good(r2) and r2['grass'] and not e2,{'r':r2,'errs':e2[:4]})
                l2=await timed('layout without '+f,pg2.evaluate(LAYOUT),90)
                check(f'without {f}: the layout is the same',bool(l2) and l2['hash']==LAYOUT_HASH,{'got':l2,'want':LAYOUT_HASH})
                await pg2.close()
        elif not MEASURE: skip('fallbacks','the first run did not give a layout')
        await b.close()
    print('\n%d failed, %d skipped (%.0f s)'%(len(FAIL),len(SKIPS),time.time()-t0)+('' if not FAIL else ': '+', '.join(FAIL)))
    sys.exit(1 if FAIL else 0)
asyncio.run(main())
