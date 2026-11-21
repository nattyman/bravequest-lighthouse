"""Screenshots of the north island's far silhouette (northveil.js), for review by eye (the CI runners can't show them).
usage: python3 test/northveil_shots.py [url] [outdir] [only,these,shots]
       (default http://localhost:8800/dev.html?debug&headless  /tmp/claude-0/northveil-shots)
Each shot sets the game up through G.* calls, then holds the camera at a fixed spot for a few steps and saves a PNG
(HUD hidden). The phone-portrait and laptop frames use their own page size."""
import asyncio, sys, os
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
OUT=sys.argv[2] if len(sys.argv)>2 else '/tmp/claude-0/northveil-shots'
ONLY=set(sys.argv[3].split(',')) if len(sys.argv)>3 and sys.argv[3] else None

LIB=r"""
window.T={
  calm(){ for(let i=0;i<10&&G.talk&&G.talk.isOpen;i++)G.talk.advance(); for(let i=0;i<14;i++)G.ui.advance&&G.ui.advance();
    if(G.cine&&G.cine.on)G.cine.skip(); if(G.state.mode!=='play')G.setMode('play'); },
  // a fixed camera: position, look-at point, fov (applied after the follow camera every step)
  cam(p,l,fov){ window.SHOT={p,l,fov:fov||58}; },
  free(){ window.SHOT=null; },
  settle(n){ G.step(1/30,n||45); T.calm(); G.step(1/30,10); G.headless&&G.headless.draw(3); return G.northVeil.debug.state(); },
  newGame(){ document.getElementById('begin')&&document.getElementById('begin').click(); G.step(1/30,30); T.calm(); G.step(1/30,60); T.calm(); },
};
G.system('shotCam',{order:99,modes:'always',update(){ const S=window.SHOT; if(!S)return; const c=G.camera;
  c.position.set(S.p[0],S.p[1],S.p[2]); c.lookAt(S.l[0],S.l[1],S.l[2]); if(c.fov!==S.fov){ c.fov=S.fov; c.updateProjectionMatrix(); } }});
document.head.insertAdjacentHTML('beforeend','<style>body>*:not(#c){visibility:hidden!important}</style>');
'ok'"""

# (name, viewport, js). The island's middle is (150, ·, -700); the tower (146, 26..55.5, -708); the lighthouse (180, 42, 0).
SHOTS=[
 ('01-headland-start',(1100,650),"T.newGame(); G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,30,-700],58); T.settle()"),
 ('02-gallery',(1100,650),"T.cam([178,68.2,-4.6],[150,30,-700],58); T.settle()"),
 ('03-north-shore',(1100,650),"G.player.teleport(20,null,-84,Math.PI); T.cam([20,3.2,-84],[150,14,-700],58); T.settle()"),
 ('04-zoom',(1100,650),"T.cam([176,46.5,-30],[148,30,-700],12); T.settle()"),
 ('05-south-beach',(1100,650),"G.player.teleport(80,null,72,Math.PI); T.cam([80,4,74],[150,25,-700],58); T.settle()"),
 ('06-opening-end',(1100,650),"T.cam([118,57,7],[170.8,52,10],50); T.settle()"),
 ('07-phone',(430,932),"T.cam([176,46.5,-30],[150,30,-700],58); T.settle()"),
 ('08-laptop',(1440,900),"T.cam([176,46.5,-30],[150,30,-700],58); T.settle()"),
 ('09-forest-fog',(1100,650),"G.player.teleport(-95,null,-60,Math.PI); T.cam([-95,14,-62],[150,20,-700],58); T.settle()"),
 ('10-cured-light',(1100,650),"G.debugStartLoop(); G.step(1/30,10); T.calm(); G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,34,-700],58); T.settle(420)"),
 ('11-cured-zoom',(1100,650),"T.cam([176,46.5,-30],[148,32,-700],14); T.settle()"),
 ('13-cured-fed',(1100,650),"G.lamp.feed(200); G.fog.radius=G.fog.targetRadius; G.player.teleport(176,42,-30,Math.PI); T.cam([176,46.5,-30],[150,34,-700],58); T.settle(120)"),
 ('14-cured-fed-zoom',(1100,650),"T.cam([176,46.5,-30],[148,32,-700],14); T.settle()"),
 ('15-cured-gallery-laptop',(1440,900),"T.cam([178,68.2,-4.6],[150,30,-700],58); T.settle()"),
 ('16-cured-phone',(430,932),"T.cam([176,46.5,-30],[150,34,-700],58); T.settle()"),
 ('17-align-nowall-zoom',(1100,650),"G.fog._wall.material.visible=false; T.cam([176,46.5,-30],[148,34,-700],10); T.settle()"),
 ('18-align-nowall',(1100,650),"T.cam([176,46.5,-30],[150,34,-700],58); T.settle()"),
 ('12-outside-light',(1100,650),"G.fog._wall.material.visible=true; G.lamp.ether=40; G.fog.radius=G.fog.targetRadius=70; G.player.teleport(20,null,-84,Math.PI); T.cam([20,3.2,-84],[150,14,-700],58); T.settle(90)"),
]

async def main():
  os.makedirs(OUT,exist_ok=True)
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
    pg=await b.new_page(viewport={'width':1100,'height':650}); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' and '404' not in m.text else None)
    await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
    await pg.evaluate("localStorage.removeItem('bq-save-v1'); G.headless&&(G.headless.hold=true); 0")
    await pg.evaluate(LIB)
    vp=(1100,650)
    for name,size,js in SHOTS:
      if size!=vp: await pg.set_viewport_size({'width':size[0],'height':size[1]}); vp=size; await pg.wait_for_timeout(500)
      r=await pg.evaluate(js)
      if ONLY and name not in ONLY: continue
      await pg.evaluate("G.headless&&G.headless.draw(3); 0"); await pg.wait_for_timeout(1200)
      path=os.path.join(OUT,name+'.png'); await pg.screenshot(path=path,timeout=120000)
      print(name, r)
    print('errors:',errs[:5])
    await b.close()
asyncio.run(main())
