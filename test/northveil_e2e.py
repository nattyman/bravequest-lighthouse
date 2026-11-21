"""The north island's far silhouette (northveil.js): a soft shape on the northern horizon, seen from home.
- a new game: it is in the scene and showing; looking north from the headland and from the lamp-room gallery it
  changes the pixels where the island is (drawn, not hidden behind anything), and it stays in the sky/sea's colours;
- it lines up with the real island: its tower plane and x are northisle.js's tower's, and north.js's light sits on top;
- the island itself hides it: from the south beach looking north it changes nothing on screen;
- thick fog hides it (the forest's murk, and out beyond the fog wall once the loop runs); it comes back in the light;
- inside the sea cave and the Vigil it is hidden;
- the crossing: showing as the boat pulls out, gone on the fog leg, gone on the north island, back after sailing home;
- a save made on the north island reloads with it hidden; sailing home brings it back. No page errors.
usage: python3 test/northveil_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, json
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'

LIB=r"""
window.T={
  play(){ if(G.state.mode==='paused'&&!document.getElementById('pause').hidden)document.getElementById('resume').click(); if(G.state.mode!=='play'&&G.state.mode!=='dead')G.setMode('play'); },
  calm(){ for(let i=0;i<10&&G.talk&&G.talk.isOpen;i++)G.talk.advance(); for(let i=0;i<14;i++)G.ui.advance&&G.ui.advance(); if(G.cine&&G.cine.on)G.cine.skip(); T.play(); },
  run(s){ for(let i=0;i<Math.round(s*30);i++)G.step(1/30,1); },
  st(){ return G.northVeil.debug.state(); },
  // a fixed camera (applied after the follow camera every step)
  cam(p,l){ window.SHOT={p,l}; G.step(1/30,3); },
  // how much the silhouette changes the picture around a world point: render the scene (no post) into a small target with
  // and without it and sum the colour difference in a box round the point's projection. Also the colour there with it.
  diff(pt){ const R=G.renderer, W=320, H=180, rt=T._rt||(T._rt=new THREE.WebGLRenderTarget(W,H)), m=G.northVeil.debug.mesh, cam=G.camera;
    const a0=cam.aspect; cam.aspect=W/H; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const v=new THREE.Vector3(pt[0],pt[1],pt[2]).project(cam), cx=Math.round((v.x*.5+.5)*W), cy=Math.round((v.y*.5+.5)*H), B=10;
    const read=()=>{ R.setRenderTarget(rt); R.render(G.scene,cam); const buf=new Uint8Array((2*B)*(2*B)*4); R.readRenderTargetPixels(rt,cx-B,cy-B,2*B,2*B,buf); R.setRenderTarget(null); return buf; };
    const was=m.visible, on=read(); m.visible=false; const off=read(); m.visible=was;
    cam.aspect=a0; cam.updateProjectionMatrix();
    let d=0, r=0, g=0, b=0; for(let i=0;i<on.length;i+=4){ d+=Math.abs(on[i]-off[i])+Math.abs(on[i+1]-off[i+1])+Math.abs(on[i+2]-off[i+2]); r+=on[i]; g+=on[i+1]; b+=on[i+2]; }
    const n=on.length/4; return {d:+(d/n).toFixed(2),inView:v.z<1&&cx>B&&cy>B&&cx<W-B&&cy<H-B,rgb:[r/n|0,g/n|0,b/n|0]}; },
};
G.system('veilTestCam',{order:99,modes:'always',update(){ const S=window.SHOT; if(!S)return; G.camera.position.set(S.p[0],S.p[1],S.p[2]); G.camera.lookAt(S.l[0],S.l[1],S.l[2]); }});
'ok'"""

ISLE='[150,18,-690]'   # a point on the island's south face, as the silhouette shows it
STEPS=[
 ("newGameShows", "(()=>{ document.getElementById('begin')&&document.getElementById('begin').click(); G.step(1/30,30); T.calm(); T.run(3); T.calm();"
   " G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,30,-700]); T.run(5); const m=G.northVeil.debug.mesh;"
   " return Object.assign(T.st(),{vis:G.northVeil.visible,inScene:!!G.scene.getObjectByName('northVeil'),depthTest:m.material.depthTest,depthWrite:m.material.depthWrite,fog:m.material.fog,ro:m.renderOrder,loop:!!(G.loop&&G.loop.active),light:G.north.vis}); })()",
   lambda r: r['vis'] and r['inScene'] and r['depthTest'] and not r['depthWrite'] and not r['fog'] and r['ro']<0 and r['opacity']>.9 and not r['loop'] and r['light']<.01),
 ("drawnFromHeadland", "T.diff("+ISLE+")", lambda r: r['inView'] and r['d']>3 and max(r['rgb'])<200),
 ("drawnFromGallery", "(()=>{ T.cam([178,68.2,-4.6],[150,30,-700]); T.run(1); return T.diff("+ISLE+"); })()", lambda r: r['inView'] and r['d']>3),
 ("linesUp", "(()=>{ const N=G.northIsle, Tw=N.tower, P=G.north.pos, L=G.northVeil.layers, mid=L.find(l=>l.name==='mid');"
   " return {tx:Tw.x,tz:Tw.z,px:P.x,pz:P.z,py:P.y,top:Tw.base+Tw.h,mid:mid&&mid.z,towerZ:G.northVeil.towerZ}; })()",
   lambda r: abs(r['tx']-r['px'])<.01 and abs(r['tz']-r['pz'])<.01 and r['mid']==r['pz'] and r['towerZ']==r['pz'] and 0<r['py']-r['top']<4),
 ("occludedFromSouthBeach", "(()=>{ G.player.teleport(80,null,72,Math.PI); T.cam([80,4,74],[150,25,-700]); T.run(2); return Object.assign(T.diff("+ISLE+"),{shown:T.st().shown}); })()",
   lambda r: r['d']<.5),
 ("forestFogHides", "(()=>{ G.player.teleport(-95,null,-60,Math.PI); T.cam([-95,14,-62],[150,20,-700]); T.run(6); return T.st(); })()",
   lambda r: r['opacity']<.05 and r['fogK']<.05),
 ("backInClearAir", "(()=>{ G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,30,-700]); T.run(6); return T.st(); })()",
   lambda r: r['opacity']>.9),
 ("hiddenInSeaCave", "(()=>{ window.SHOT=null; G.cave.enter('mouth',{instant:true}); T.run(1); T.calm(); const s=T.st(); return Object.assign(s,{inside:!!G.cave.inside}); })()",
   lambda r: r['inside'] and not r['shown'] and r['why']=='interior'),
 ("hiddenInVigil", "(()=>{ G.cave.exit({instant:true}); T.run(1); G.temple.enter('vestibule',{instant:true}); T.run(1); T.calm(); return Object.assign(T.st(),{inside:!!G.temple.inside}); })()",
   lambda r: r['inside'] and not r['shown']),
 ("loopOutsideLightHides", "(()=>{ G.temple.exit&&G.temple.exit({instant:true}); T.run(1); G.debugStartLoop(); T.run(1); T.calm(); G.lamp.ether=10; G.fog.radius=G.fog.targetRadius=60;"
   " G.player.teleport(20,null,-84,Math.PI); T.cam([20,3.2,-84],[150,14,-700]); T.run(8); return Object.assign(T.st(),{temple:!!G.temple.inside,depth:Math.round(G.fog.depth(G.player.pos))}); })()",
   lambda r: not r['temple'] and r['depth']>20 and r['opacity']<.05),
 ("loopInLightShows", "(()=>{ G.lamp.ether=100; G.fog.radius=G.fog.targetRadius; G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,30,-700]); T.run(8);"
   " return Object.assign(T.st(),{light:+G.north.vis.toFixed(2)}); })()",
   lambda r: r['opacity']>.9 and r['light']>.5),
 ("crossingHandsOver", "(()=>{ window.SHOT=null; G.north.debug.see(); G.boat.debug.start(); G.boat.debug.build(); T.run(7); T.calm(); const N=G.northIsle;"
   " if(!N.cross('north'))return {started:false}; let out=null, leg=null, isle=null; for(let i=0;i<30*30&&N.crossing;i++){ G.step(1/30,1); const s=T.st();"
   " if(N.crossPhase===0&&i===45)out=s.vis; if(N.crossPhase===1)leg=Math.max(leg||0,s.vis); }"
   " T.run(3); T.calm(); isle=T.st(); return {started:true,out,leg,at:N.at,isle:isle.shown,why:isle.why}; })()",
   lambda r: r['started'] and r['out'] is not None and r['out']>.5 and r['leg']==0 and r['at']=='north' and not r['isle'] and r['why']=='northIsland'),
 ("saveOnIsland", "(()=>{ G.flow.writeSave(); return {at:G.northIsle.at,saved:!!localStorage.getItem(G.flow.keys.save)}; })()",
   lambda r: r['at']=='north' and r['saved']),
]
AFTER=[
 ("reloadedOnIsland", "(()=>{ T.calm(); T.run(2); return Object.assign(T.st(),{at:G.northIsle.at}); })()",
   lambda r: r['at']=='north' and not r['shown']),
 ("sailHomeBrings", "(()=>{ G.northIsle.cross('home',{instant:true}); T.run(1); T.calm(); G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,30,-700]); T.run(8);"
   " return Object.assign(T.st(),{at:G.northIsle.at}); })()",
   lambda r: r['at']=='home' and r['opacity']>.9),
]

async def run(pg,steps,fails):
  for name,js,ok in steps:
    try: r=await asyncio.wait_for(pg.evaluate(js),240); good=bool(ok(r))
    except Exception as e: r=str(e)[:300]; good=False
    print(('ok  ' if good else 'FAIL'),name,':',json.dumps(r)[:460])
    if not good: fails.append(name)

async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    ctx=await b.new_context(viewport={'width':960,'height':540}); pg=await ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' and 'Failed to load resource' not in m.text else None)
    await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
    await pg.evaluate("localStorage.removeItem('bq-save-v1')"); await pg.evaluate('G.headless&&(G.headless.hold=true);0')
    await pg.evaluate(LIB); fails=[]
    await run(pg,STEPS,fails)
    if 'saveOnIsland' in fails: print('SKIP reloadedOnIsland, sailHomeBrings : no save on the island')
    else:
      await pg.reload(timeout=180000); await pg.wait_for_timeout(5000); await pg.evaluate('G.headless&&(G.headless.hold=true);0')
      await pg.evaluate("document.getElementById('continue').click(); G.step(1/30,60); 0"); await pg.evaluate(LIB)
      await run(pg,AFTER,fails)
    print('ok  ' if not errs else 'FAIL','noConsoleErrors :',errs[:3])
    if errs: fails.append('noConsoleErrors')
    print('RESULT:', 'PASSED' if not fails else 'FAILED '+', '.join(fails))
    await b.close(); sys.exit(1 if fails else 0)
asyncio.run(main())
