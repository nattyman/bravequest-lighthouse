"""Screenshots of the opening cut scene from three places (local only: the runners can't show frames):
  sand      where he woke          path     halfway up the cliff path's first leg          beach    far west along the beach
Eight frames across each shot and the hand-back frame after it, to /tmp/claude-0/opening-shots/<case>-<n>.png.
usage: python3 test/opening_shots.py [url] [case,...]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, os, re, json
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
ONLY=[c for c in (sys.argv[2] if len(sys.argv)>2 else '').split(',') if c]
OUT='/tmp/claude-0/opening-shots'; os.makedirs(OUT,exist_ok=True)
HERE=os.path.dirname(os.path.abspath(__file__))
LIB=re.search(r'LIB=r"""(.*?)"""',open(os.path.join(HERE,'cave_e2e.py')).read(),re.S).group(1)
WALK={'sand':'[]',
      'path':'(()=>{ const R=G._onb.routeUp(); return [[R[0].x,R[0].z],[R[1].x,R[1].z],[R[1].x+(R[2].x-R[1].x)*.5,R[1].z+(R[2].z-R[1].z)*.5]]; })()',
      'beach':'[[50,66],[20,68],[-10,67]]'}
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await (await b.new_context(viewport={'width':1000,'height':600})).new_page(); pg.set_default_timeout(480000)
        for case,walk in WALK.items():
            if ONLY and case not in ONLY: continue
            await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(4000)
            await pg.evaluate("localStorage.removeItem('bq-save-v1')"); await pg.reload(); await pg.wait_for_timeout(4000); await pg.evaluate(LIB)
            r=await pg.evaluate("""(()=>{ T.talkAuto.on=false; G.headless&&(G.headless.hold=true); document.getElementById('begin').click(); G.step(1/30,3);
              const pts=%s; if(pts.length){ T.walk(pts,{max:3600}); T.release(); }
              let n=0; while(!G.cine.on&&n<3600){ if(n%%15===0)G.ui.advance(); G.step(1/30,1); n++; }
              const w=G._onb.openingWhere(G._onb.routeUp(),G.player.pos); return {on:G.cine.on,dur:G.cine.dur,where:w}; })()""" % walk)
            print(case,json.dumps(r),flush=True)
            if not r['on']: continue
            dur=r['dur']
            for i in range(8):
                t=dur*(.05+i*.9/7)
                await pg.evaluate("(t=>{ let g=0; while(G.cine.on&&G.cine.t<t&&g<900){ G.step(1/30,1); g++; } G.headless&&G.headless.draw(3); })(%f)" % t)
                await pg.wait_for_timeout(300); await pg.screenshot(path=f'{OUT}/{case}-{i}.png')
            await pg.evaluate("(()=>{ let g=0; while(G.cine.on&&g<900){ G.step(1/30,1); g++; } G.step(1/30,20); G.headless&&G.headless.draw(3); })()")
            await pg.wait_for_timeout(1200); await pg.screenshot(path=f'{OUT}/{case}-handback.png'); print('  shots',case,flush=True)
        await b.close()
asyncio.run(main())
