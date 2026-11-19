"""The headland cliffs: the rock skin, its stone material, the sculpted rock pieces and the dressing (surf, edge grass).
- all four modules are loaded and built, with no page or console errors;
- triangles and draw calls per quality level stay inside the cliffs' budgets (each part and all together), and switching
  quality rebuilds them without errors; every kind of rock piece is drawn on 'balanced';
- nothing the cliffs add stands above the plateau top where you can walk on it (the edge grass only right at the edge, low);
- the ground the game walks on is unchanged: a fixed sample of G.world.height / walkable / groundY hashes to the value
  measured on main before the cliffs work;
- the two Test tools start points for the cliffs put you on the dry sand bar at low tide and at the east edge of the headland.
usage: python3 test/cliffs_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, time, json
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'

# measured on main before the cliffs work (git show origin/main:js/world.js), with the same sample as GROUND below
GROUND_HASH='750d31fc:12567'
GROUND="""(()=>{ const W=G.world, t0=W.tide; W.tide=0; let h=2166136261>>>0, n=0;
  const mix=v=>{ h=Math.imul(h^(v|0),16777619)>>>0; };
  const one=(x,z)=>{ mix(Math.round(W.height(x,z)*1000)); mix(W.walkable(x,z)?1:2); if(W.groundY)mix(Math.round(W.groundY(x,z)*1000)); n++; };
  try{ for(let x=-300;x<=300;x+=7.3)for(let z=-210;z<=210;z+=6.1)one(x,z);          // the whole island, coarse
       for(let x=88;x<=240;x+=1.7)for(let z=-72;z<=72;z+=1.9)one(x,z); }            // the headland, fine
  finally{ W.tide=t0; }
  return (h>>>0).toString(16)+':'+n; })()"""

BUDGET={'high':{'skin':70000,'kit':60000,'dress':20000,'all':150000},
        'balanced':{'skin':70000,'kit':36000,'dress':20000,'all':90000},
        'saver':{'skin':70000,'kit':18000,'dress':20000,'all':45000}}
STATS="""(()=>{ const C=G.cliffs, K=G.cliffkit, D=G.cliffdress;
  return {level:G.quality.level, skin:{tris:C.stats.tris,draws:C.stats.draws}, kit:{tris:K.stats.tris,draws:K.stats.draws,kinds:K.stats.levels[G.quality.level].kinds},
    dress:{tris:D.stats.tris,draws:D.stats.draws,foam:D.stats.foam.tris,grass:D.stats.grass.tris},
    tex:G.cliffmat?G.cliffmat.stats.textures:0}; })()"""
# every vertex the cliffs draw: none above the plateau top where the plateau is walkable (edge grass: low, at the edge only)
ABOVE="""(()=>{ const W=G.world, TOP=W.plateauY||42, v=new G.THREE.Vector3(), m=new G.THREE.Matrix4(), bad=[], lip=G.cliffs.lip;
  const onTop=(x,z)=>W.onPlateau(x,z)&&W.walkable(x,z);
  const nearLip=(x,z)=>lip.some(l=>Math.hypot(l.x-x,l.z-z)<2.6);
  const test=(o,k,mat)=>{ const P=o.geometry.attributes.position, step=Math.max(1,Math.floor(P.count/4000));
    for(let i=0;i<P.count;i+=step){ v.fromBufferAttribute(P,i).applyMatrix4(mat); if(v.y<=TOP+.05)continue;
      if(k==='grass'){ if(v.y<TOP+1.1&&nearLip(v.x,v.z))continue; }
      if(onTop(v.x,v.z)){ bad.push([k,+v.x.toFixed(1),+v.y.toFixed(2),+v.z.toFixed(1)]); if(bad.length>8)return; } } };
  for(const o of G.cliffs.meshes){ o.updateMatrixWorld(true); test(o,'skin',o.matrixWorld); }
  for(const o of G.cliffkit.group.children){ if(!o.visible)continue; o.updateMatrixWorld(true);
    if(o.isInstancedMesh){ for(let i=0;i<o.count;i++){ o.getMatrixAt(i,m); m.premultiply(o.matrixWorld); test(o,'kit:'+o.name,m); } }
    else test(o,'kit:'+o.name,o.matrixWorld); }
  if(G.cliffdress.lipGrass)test(G.cliffdress.lipGrass,'grass',G.cliffdress.lipGrass.matrixWorld);
  return bad; })()"""

FAIL=[]; SKIPS=[]
def check(name,cond,info=''):
    print(('PASS ' if cond else 'FAIL ')+name+('' if cond else '  '+str(info)[:500])); sys.stdout.flush()
    if not cond: FAIL.append(name)
def skip(name,why): print('SKIP '+name+'  ('+why+')'); SKIPS.append(name)

async def timed(name,coro,budget):
    t=time.time()
    try: r=await asyncio.wait_for(coro,budget)
    except asyncio.TimeoutError: check(name+' (within '+str(budget)+' s)',False,'timed out'); return None
    print('  ['+name+' %.0f s]'%(time.time()-t)); return r

async def main():
    t0=time.time(); errs=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg=await b.new_page(viewport={'width':960,'height':600})
        pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
        pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
        ev=lambda js:pg.evaluate(js)

        async def boot():
            await pg.goto(URL,timeout=240000)
            await pg.wait_for_function("window.G&&G.flow&&document.getElementById('loading').textContent.startsWith('Ready')",timeout=240000)
            return await ev("""({cliffs:!!(G.cliffs&&G.cliffs.mesh&&G.cliffs.mesh.parent&&G.cliffs.lip.length>50&&G.cliffs.foot.length===G.cliffs.lip.length),
              mat:!!(G.cliffmat&&G.cliffmat.rock), kit:!!(G.cliffkit&&G.cliffkit.group.parent&&G.cliffkit.placements.length>10),
              foam:!!(G.cliffdress&&G.cliffdress.foam&&G.cliffdress.foam.parent), grass:!!(G.cliffdress&&G.cliffdress.lipGrass&&G.cliffdress.lipGrass.parent),
              level:G.quality.level})""")
        r=await timed('boot',boot(),300)
        built=bool(r) and all(r[k] for k in ('cliffs','mat','kit','foam','grass'))
        check('the four cliff modules are loaded and built',built,r)
        check('no page or console errors while loading',not errs,errs[:5])

        # the ground the game walks on is the same as on main
        if r:
            g=await timed('ground hash',ev(GROUND),120)
            check('ground sample (height, walkable, groundY) matches main',g==GROUND_HASH,{'got':g,'want':GROUND_HASH})
        else: skip('ground sample matches main','the page did not boot')

        # budgets per quality level; switching rebuilds without errors
        if built:
            await ev("document.getElementById('title').hidden=true; G.setMode('play'); 0")
            for lv in ('high','balanced','saver','balanced'):
                n0=len(errs)
                s=await timed('quality '+lv,ev(f"(()=>{{ G.setQuality('{lv}'); G.step(1/30,3); G.headless&&G.headless.draw(1); return {STATS}; }})()"),180)
                if not s: continue
                B=BUDGET[lv]; tot=s['skin']['tris']+s['kit']['tris']+s['dress']['tris']; draws=s['skin']['draws']+s['kit']['draws']+s['dress']['draws']
                check(f'{lv}: rebuilt to the level without errors',s['level']==lv and len(errs)==n0,{'s':s,'errs':errs[n0:n0+3]})
                check(f'{lv}: skin within budget',s['skin']['tris']<=B['skin'] and s['skin']['draws']<=2,s['skin'])
                check(f'{lv}: rock pieces within budget',s['kit']['tris']<=B['kit'] and s['kit']['draws']<=6,s['kit'])
                check(f'{lv}: dressing within budget',s['dress']['tris']<=B['dress'] and s['dress']['draws']<=2,s['dress'])
                check(f'{lv}: the cliffs together within budget ({tot} triangles, {draws} draws)',tot<=B['all'] and draws<=10 and s['tex']<=3,s)
                if lv=='balanced':
                    kinds=s['kit']['kinds'] or {}
                    check('balanced: every kind of rock piece is drawn',all(kinds.get(k,0)>0 for k in ('buttress','lipcrag','slab','scree','boulders','stackSquat')),kinds)
                    above=await timed('above the plateau',ev(ABOVE),240)
                    check('nothing stands above the plateau top where it is walkable',above==[],above)
                if lv=='saver': saver=s
                if lv=='high': high=s
            try: check('the dressing is lighter on saver than on high',saver['dress']['tris']<high['dress']['tris'],[saver['dress'],high['dress']])
            except NameError: skip('dressing lighter on saver','a level did not report')
        else:
            for n in ('budgets per quality level','nothing above the plateau top'): skip(n,'the cliffs did not build')

        # the Test tools start points for the cliffs
        if built:
            for sid,want in (('cliffs-sandbar','low'),('cliffs-lip','top')):
                n0=len(errs)
                s=await timed('start '+sid,ev(f"""(()=>{{ G.devtools.start('{sid}'); G.step(1/30,30); const p=G.player.pos, W=G.world;
                  return {{x:p.x,y:p.y,z:p.z,mode:G.state.mode,low:!!(G.tide&&G.tide.low),loop:!!(G.loop&&G.loop.active),
                    top:W.onPlateau(p.x,p.z)&&Math.abs(p.y-(W.plateauY||42))<.6, ok:G.player.alive}}; }})()"""),180)
                if not s: continue
                good=s['mode']=='play' and s['loop'] and s['ok'] and len(errs)==n0 and (s['low'] and s['y']<1 and s['z']>50 if want=='low' else s['top'])
                check(f'{sid}: puts you where it says',good,{'s':s,'errs':errs[n0:n0+3]})
        else: skip('cliff start points','the cliffs did not build')

        check('no page or console errors in the whole run',not errs,errs[:6])
        await b.close()
    print('\n%d failed, %d skipped (%.0f s)'%(len(FAIL),len(SKIPS),time.time()-t0)+('' if not FAIL else ': '+', '.join(FAIL)))
    sys.exit(1 if FAIL else 0)
asyncio.run(main())
