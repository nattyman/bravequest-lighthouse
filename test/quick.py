"""Quick smoke test (~1–2 min): loads the game headless, runs the title -> play, the core loop and every cave room for a few
seconds of game time each, and fails on any page error or console error. Run this while working; the full suites
(e2e.py, loop_e2e.py, cave_e2e.py) are for the end of a task — see CONTRACT.md "Testing".
usage: python3 test/quick.py [url]   (default http://localhost:8800/dev.html?debug&headless)
"""
import asyncio, sys, time, json
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
COMBOS="""(async()=>{
 dispatchEvent(new Event('pointerdown'));   // what a first click does: start the audio (and decode the recordings) now, before counting
 const R=G.renderer, raf=()=>new Promise(r=>requestAnimationFrame(r)), V=(a,on)=>G.input.setVirtual(a,on);
 const H=G.headless, hold0=H&&H.hold; if(H)H.hold=true;
 const st=n=>G.step(1/30,n);   // game time only, no drawing (a drawn frame costs seconds in software GL)
 const draw=async()=>{ G.step(1/30,1); await raf(); await raf(); };   // one step, then the frame is drawn (headless draws after a step)
 const watch=async()=>{ for(let i=0;i<7;i++){ st(4); await draw(); } };   // ~1 s after the strike, drawn every 5th step (rings live .3-.65 s)
 const seq={
  lunge:async()=>{V('roll',true);st(4);V('roll',false);V('attack',true);st(2);V('attack',false);await watch();},
  sweep:async()=>{V('forward',true);V('sprint',true);st(25);V('attack',true);st(2);V('attack',false);await watch();V('forward',false);V('sprint',false);},
  slam:async()=>{V('jump',true);st(4);V('jump',false);st(1);V('attack',true);st(2);V('attack',false);await watch();},
  spin:async()=>{V('jump',true);st(3);V('jump',false);st(3);V('jump',true);await draw();st(1);V('jump',false);st(1);V('attack',true);st(2);V('attack',false);await watch();},
  plunge:async()=>{V('jump',true);st(4);V('jump',false);st(1);V('roll',true);st(2);V('roll',false);st(1);V('attack',true);st(2);V('attack',false);await watch();},
 };
 const did=[]; const off=G.on('player:combo',e=>did.push(e.id));
 st(20); await draw();
 for(let k=0,d=-1,q=0;k<120&&q<3;k++){ q=(d===window.__abuf.decode&&!window.__abuf.pending)?q+1:0; d=window.__abuf.decode; st(15); await new Promise(r=>setTimeout(r,500)); }   // let music and recordings finish decoding first (some start on game time once others are done)
 const p0=R.info.programs.length, a0=Object.assign({},window.__abuf), out=[];
 try{ for(const id of G.moves.order){ const n=did.length, p=R.info.programs.length, a=Object.assign({},window.__abuf); await seq[id]();
   out.push([id, did.slice(n).includes(id), R.info.programs.length-p, window.__abuf.create-a.create, window.__abuf.decode-a.decode]); st(15); } }
 finally{ off(); if(H)H.hold=hold0; ['roll','attack','jump','forward','sprint'].forEach(a=>V(a,false)); }
 const bad=out.filter(r=>!r[1]||r[2]||r[3]||r[4]);
 if(!G.audio.ready||bad.length)throw new Error('first use of a technique: '+JSON.stringify({audio:G.audio.ready,bad,all:out}));
 return out;   // [technique, performed, new shader programs, new audio buffers, decodes]
})()"""
STEPS=[
 ("boot",   "[!!window.G, G.state.mode, !!G.headless]"),
 ("begin",  "document.getElementById('begin').click(); G.step(1/30,90); [G.state.mode, G.quest.step]"),
 ("walk",   "G.input.setVirtual('forward',true); G.step(1/30,90); G.input.setVirtual('forward',false); [G.player.pos.x.toFixed(1), G.player.pos.z.toFixed(1)]"),
 ("loop",   "G.debugStartLoop(); G.step(1/30,150); [G.loop.active, Math.round(G.lamp.ether)]"),
 ("strike", "G.input.setVirtual('attack',true); G.step(1/30,4); G.input.setVirtual('attack',false); G.step(1/30,30); G.state.mode"),
]+[(f"cave:{r}", f"G.debugEnterCave('{r}'); G.step(1/30,120); [G.cave.inside, G.cave.room(G.player.pos)]")
   for r in ['mouth','gallery','stair','channel','drafts','arena']]+[
 ("exit",   "G.cave.exit&&G.cave.exit(); G.step(1/30,120); [!G.cave.inside, G.state.mode]"),
 # playtest: "the first time you do a combo it locks up for a second". The first Skyfall Slam / Starfall Plunge used to add its
 # flash light to the scene, which recompiled every lit material in that frame. Doing each technique for the first time, drawing
 # every frame, must compile no new shader program and create / decode no new audio buffer.
 ("combos", COMBOS),
]
async def main():
    t0=time.time(); errs=[]; ok=True
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await b.new_page(viewport={'width':960,'height':600})
        # count audio buffers made / decoded (the "combos" step checks a first technique makes none)
        await pg.add_init_script("""window.__abuf={create:0,decode:0,pending:0}; (()=>{ const B=window.BaseAudioContext&&BaseAudioContext.prototype; if(!B)return;
          const c=B.createBuffer, d=B.decodeAudioData; B.createBuffer=function(){__abuf.create++; return c.apply(this,arguments);};
          B.decodeAudioData=function(){__abuf.decode++; __abuf.pending++; const p=d.apply(this,arguments);
            const done=()=>{__abuf.pending--;}; if(p&&p.then)p.then(done,done); else done(); return p;}; })();""")
        pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
        pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
        await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
        for name,js in STEPS:
            try: r=await pg.evaluate(js); print(f'ok   {name:14s} {json.dumps(r)}')
            except Exception as e: ok=False; print(f'FAIL {name:14s} {str(e)[:300]}')
        await b.close()
    for e in errs[:10]: print('  ',e[:300])
    ok=ok and not errs
    print(('PASS' if ok else 'FAIL'), f'{time.time()-t0:.0f}s'); sys.exit(0 if ok else 1)
asyncio.run(main())
