"""The opening cut scene (onboarding.js 'opening', after flow.js's 'wake:done'): a new game on the south beach shows the way up
the cliff path to the lighthouse and the cottage once Rowan's opening lines have finished, wherever he has run to by then.
Each case is a fresh new game, driven with real input (the virtual stick, T.walk from test/cave_e2e.py's LIB):
  short      a few steps off the sand              -> the full climb from where he stands; Continue after a reload: no replay
  path45     onto the cliff path, past 45 m         -> the shot picks up the climb on the path
  path70     halfway up the first leg, past 70 m    -> the lines are all still said, then the shot
  nearTop    up the second leg, near the edge       -> what is left of the climb, then the reveal
  plateau    over the edge onto the headland        -> the reveal alone
  beachFar   far west along the beach               -> from him, along the beach to the path's foot, then the climb
  cottage    all the way to the cottage door        -> nothing left to show: no shot (the record still marks him ashore)
  waits      a card open, in the air, dead          -> it waits and plays when it can
  fallback   the lighthouse start (no beach)        -> no shot
Every shot is watched frame by frame: the camera stays clear of the ground and the rock (cliffs.js / cliffkit.js), sees its
look point, ends with the lighthouse and the cottage in view, and hands back facing on along the route (a step forward makes
progress toward the goal).
usage: python3 test/opening_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, os, re, json, time
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
HERE=os.path.dirname(os.path.abspath(__file__))
LIB=re.search(r'LIB=r"""(.*?)"""',open(os.path.join(HERE,'cave_e2e.py')).read(),re.S).group(1)

# O: the opening's helpers on top of cave_e2e's T
EXTRA=r"""(()=>{
  T.talkAuto.on=false; G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{};
  const V=G.THREE.Vector3, P=()=>G.player, ON=()=>G._onb;
  const O=window.O={ev:[]};
  G.on('wake:done',e=>O.ev.push(['wake',!!(e&&e.early),!!(e&&e.windows)])); G.on('cine',e=>{ if(e&&e.id==='opening')O.ev.push(['cine',e.on]); });
  O.begin=fallback=>{ G.headless&&(G.headless.hold=true); if(fallback)delete G.world.landmarks.wreckStart; document.getElementById('begin').click(); G.step(1/30,3);
    const p=P().pos; O.start=p.clone(); return {step:G.quest.step,at:[+p.x.toFixed(1),+p.z.toFixed(1)]}; };
  O.R=()=>ON().routeUp();
  O.walk=(pts,max)=>{ const r=T.walk(pts,{max:max||2400}); T.release(); G.step(1/30,2); return r; };
  O.far=()=>+Math.hypot(P().pos.x-O.start.x,P().pos.z-O.start.z).toFixed(1);
  O.where=()=>ON().openingWhere(O.R(),P().pos);
  // the opening's lines, read through (a press every half second), until the shot starts or the lines are over and it's let go
  O.lines=(max)=>{ let n=0; const C=G.cine; while(!C.on&&n<(max||3600)){ if(n%15===0&&G.ui.advance)G.ui.advance(); G.step(1/30,1); n++;
      if(!C.on&&O.ev.some(e=>e[0]==='wake')&&!ON().owed&&n>30)break; }
    const M=G.ui.messages().map(m=>m.text), said=[/Cold sand/,/wasn’t the lighthouse/,/spring fair/].map(re=>M.some(t=>re.test(t)));
    return {on:C.on&&C.id==='opening',frames:n,said,wake:O.ev.filter(e=>e[0]==='wake'),owed:ON().owed}; };
  // which way is on from where he stands (the shot's own rule, worked out here from the route): a step that way makes progress
  O.progress=()=>{ const R=O.R(), p=P().pos, w=O.where(), L=G.world.landmarks, d=L.cottageDoor||L.cottage, f=R[0];
    if(w.at==='top')return -Math.hypot(p.x-d.x,p.z-d.z);
    if(w.at==='path')return ON().alongRoute(R,p).s;
    return -Math.hypot(p.x-f.x,p.z-f.z); };
  // the shot, frame by frame: clearance over the ground, rock in the way, the goal in view near the end, the hand-back
  O.watch=()=>{ const C=G.cine, cam=G.camera, H=(x,z)=>Math.max(G.world.height(x,z),G.floorAt(x,z,1e9)), rocks=ON().rocks(), lp=ON().C.lp;
    const w=O.where(), dur=C.dur; let low=1e9, lowAt=null, blocked=0, frames=0, end=null, g=0;
    while(C.on&&g<900){ G.step(1/30,1); g++; if(!C.on)break; frames++;
      const c=cam.position; let h=-1e9; for(let a=0;a<8;a++)for(const r of [0,1.5,3])h=Math.max(h,H(c.x+Math.cos(a)*r,c.z+Math.sin(a)*r));
      if(C.t>.4&&c.y-h<low){ low=c.y-h; lowAt=[+c.x.toFixed(1),+c.y.toFixed(1),+c.z.toFixed(1),+C.t.toFixed(2)]; }
      if(frames%3===0&&ON().rockHit(lp.clone(),c.clone(),rocks))blocked++;
      if(!end&&C.t>=dur-1.1){ cam.updateMatrixWorld(); const L=G.world.landmarks, inView=p=>{ const q=p.clone().project(cam); return Math.abs(q.x)<.95&&Math.abs(q.y)<.95&&q.z<1; };
        end={lh:inView(new V(L.lighthouse.x,L.lighthouse.y+8,L.lighthouse.z)),lhTop:inView(new V(L.lighthouse.x,L.lighthouse.y+20,L.lighthouse.z)),cot:inView(new V(L.cottage.x,L.cottage.y+2,L.cottage.z))}; } }
    G.step(1/30,3); const Pl=P(), ctl=Pl.inputEnabled, music=G.audio&&G.audio.music?G.audio.music.override:null, camNear=+cam.position.distanceTo(Pl.pos).toFixed(1);
    const p0=O.progress(), q0=Pl.pos.clone(); G.input.setVirtual('forward',true); G.step(1/30,30); G.input.setVirtual('forward',false); G.step(1/30,2);
    const gain=+(O.progress()-p0).toFixed(2), moved=+Pl.pos.distanceTo(q0).toFixed(2);
    const r={where:w.at,dur:+dur.toFixed(1),frames,low:+low.toFixed(1),lowAt,blocked,end,ctl,music,camNear,gain,moved,seen:C.seen('opening')};
    r.okShot=low>2&&blocked===0&&!!end&&end.lh&&end.lhTop&&end.cot;
    r.okBack=!C.on&&ctl!==false&&camNear<12&&gain>.8&&moved>.8&&music!=='wistful'&&r.seen;
    return r; };
  O.ms=()=>G.record&&G.record.ms?G.record.ms('ashore'):null;
  return 'O'; })()"""

CASES=[
 ("short", False, [
  ("walk", 120, r"""(()=>{ const b=O.begin(), f=O.R()[0], s=O.start, d=Math.hypot(f.x-s.x,f.z-s.z); const r=O.walk([[s.x+(f.x-s.x)*15/d, s.z+(f.z-s.z)*15/d]]);
     return {ok:r.ok&&b.step==='cottage'&&O.where().at==='below',b,far:O.far(),where:O.where().at}; })()"""),
  ("lines", 240, r"""(()=>{ const r=O.lines(); r.ok=r.on&&r.said.every(Boolean)&&r.wake.length===1&&!r.wake[0][1]&&G.player.inputEnabled===false&&G.cine.safe; return r; })()"""),
  ("shot", 120, r"""(()=>{ const r=O.watch(); r.ok=r.where==='below'&&r.okShot&&r.okBack&&r.dur>=12; return r; })()"""),
  ("ashore", 30, r"""(()=>{ const m=O.ms(); return {ok:!!m&&m.t!=null,m}; })()"""),
  ("save", 30, r"""(()=>{ G.testSaves=false; G.setMode('paused'); document.getElementById('saveBtn').click(); G.setMode('play'); const d=JSON.parse(localStorage.getItem('bq-save-v1')||'null'), o=d&&d.mods&&d.mods.onboarding;
     return {ok:!!(o&&o.seen&&o.seen.opening),seen:o&&o.seen}; })()"""),
  ("RELOAD", 0, None),
  ("noReplay", 60, r"""(()=>{ G.headless&&(G.headless.hold=true); G.step(1/30,30); const a=G.cine.on; G.emit('wake:done',{from:G.player.pos.clone(),windows:true}); G.step(1/30,30);
     return {ok:G.state.mode==='play'&&!a&&!G.cine.on&&G.cine.seen('opening')&&!G._onb.owed,a,on:G.cine.on,owed:G._onb.owed}; })()"""),
 ]),
 ("path45", False, [
  ("walk", 150, r"""(()=>{ O.begin(); const R=O.R(); const r=O.walk([[R[0].x,R[0].z],[R[1].x,R[1].z],[R[1].x+(R[2].x-R[1].x)*.08,R[1].z+(R[2].z-R[1].z)*.08]]);
     const w=O.where(); return {ok:r.ok&&O.far()>45&&w.at==='path',far:O.far(),w,cine:G.cine.on}; })()"""),
  ("lines", 240, r"""(()=>{ const r=O.lines(); r.ok=r.on&&r.said.every(Boolean)&&r.wake.length===1; return r; })()"""),
  ("shot", 120, r"""(()=>{ const r=O.watch(); r.ok=r.where==='path'&&r.okShot&&r.okBack; return r; })()"""),
 ]),
 ("path70", False, [
  ("walk", 150, r"""(()=>{ O.begin(); const R=O.R(); const r=O.walk([[R[0].x,R[0].z],[R[1].x,R[1].z],[R[1].x+(R[2].x-R[1].x)*.5,R[1].z+(R[2].z-R[1].z)*.5]]);
     const w=O.where(); return {ok:r.ok&&O.far()>70&&w.at==='path',far:O.far(),w,said:G.ui.messages().length,cine:G.cine.on}; })()"""),
  ("lines", 240, r"""(()=>{ const r=O.lines(); r.ok=r.on&&r.said.every(Boolean)&&r.wake.length===1&&!r.wake[0][1]; return r; })()"""),
  ("shot", 120, r"""(()=>{ const r=O.watch(); r.ok=r.where==='path'&&r.okShot&&r.okBack; return r; })()"""),
  ("ashore", 30, r"""(()=>{ const m=O.ms(); return {ok:!!m&&m.t!=null,m}; })()"""),
 ]),
 ("nearTop", False, [
  ("walk", 180, r"""(()=>{ O.begin(); const R=O.R(); let sw=0; for(let i=1;i<R.length;i++)if(R[i].z<R[sw].z)sw=i; const pts=R.slice(0,sw+2).map(p=>[p.x,p.z]); const a=R[sw+1], b=R[sw+2];
     pts.push([a.x+(b.x-a.x)*.75,a.z+(b.z-a.z)*.75]); const r=O.walk(pts,3600); const w=O.where(); return {ok:r.ok&&w.at==='path'&&w.s>w.len*.5,far:O.far(),w,cine:G.cine.on}; })()"""),
  ("lines", 240, r"""(()=>{ const r=O.lines(); r.ok=r.on&&r.said.every(Boolean); return r; })()"""),
  ("shot", 120, r"""(()=>{ const r=O.watch(); r.ok=r.where==='path'&&r.okShot&&r.okBack; return r; })()"""),
 ]),
 ("plateau", False, [
  ("walk", 200, r"""(()=>{ O.begin(); const R=O.R(), L=G.world.landmarks, t=R[R.length-1]; const pts=R.map(p=>[p.x,p.z]); pts.push([t.x+8,t.z+2]); const r=O.walk(pts,4200);
     const w=O.where(); return {ok:r.ok&&w.at==='top'&&!G._onb.atCottage(G.player.pos)&&G.quest.step==='cottage',far:O.far(),w,cine:G.cine.on}; })()"""),
  ("lines", 240, r"""(()=>{ const r=O.lines(); r.ok=r.on&&r.said.every(Boolean); return r; })()"""),
  ("shot", 120, r"""(()=>{ const r=O.watch(); r.ok=r.where==='top'&&r.okShot&&r.okBack&&r.dur<12; return r; })()"""),
 ]),
 ("beachFar", False, [
  ("walk", 200, r"""(()=>{ O.begin(); const r=O.walk([[50,66],[20,68],[-10,67]],3600); const w=O.where(); return {ok:r.ok&&w.at==='below'&&O.far()>70,far:O.far(),w,cine:G.cine.on}; })()"""),
  ("lines", 240, r"""(()=>{ const r=O.lines(); r.ok=r.on&&r.said.every(Boolean); return r; })()"""),
  ("shot", 120, r"""(()=>{ const r=O.watch(); r.ok=r.where==='below'&&r.okShot&&r.okBack; return r; })()"""),
 ]),
 ("cottage", False, [
  ("walk", 240, r"""(()=>{ O.begin(); const R=O.R(), L=G.world.landmarks, d=L.cottageDoor; const pts=R.map(p=>[p.x,p.z]); pts.push([d.x-1,d.z-6]);
     const r=O.walk(pts,6000); return {r,at:[G.player.pos.x,G.player.pos.y,G.player.pos.z].map(v=>+v.toFixed(1)),door:[d.x,d.z],ok:r.ok&&G._onb.atCottage(G.player.pos)&&!G.cine.on,far:O.far(),cine:G.cine.on,step:G.quest.step,wake:O.ev.filter(e=>e[0]==='wake').length}; })()"""),
  ("noShot", 240, r"""(()=>{ const r=O.lines(); const m=O.ms(); r.m=m; r.seen=G.cine.seen('opening'); r.ok=!r.on&&!r.seen&&!r.owed&&r.wake.length===1&&!!m&&m.t!=null; return r; })()"""),
 ]),
 ("waits", False, [
  # a card open as the last line goes: the shot waits for it to close
  ("card", 300, r"""(()=>{ O.begin(); let n=0; while(!/cottage windows/.test((G.ui.captions().cur||{}).text||'')&&n<3600){ if(n%15===0)G.ui.advance(); G.step(1/30,1); n++; }
     // the card holds the captions, so the last line waits under it; the shot comes after the card and the line
     const opened=G.talk.open({who:'Test',name:'A stranger',lines:['A test card.']}); G.step(1/30,90); const during={card:G.talk.isOpen,on:G.cine.on};
     G.talk.close(); let k=0; while(!G.cine.on&&k<1800){ if(k%15===0)G.ui.advance(); G.step(1/30,1); k++; } const after=G.cine.on&&G.cine.id==='opening'; G.cine.skip(); G.step(1/30,3);
     // and the shot owed while a card is up: it waits for the card to close
     delete G._onb.S.seen.opening; G.talk.open({who:'Test',name:'A stranger',lines:['A test card.']}); G.emit('wake:done',{from:G.player.pos.clone(),windows:true}); G.step(1/30,30);
     const owedCard={card:G.talk.isOpen,on:G.cine.on,owed:G._onb.owed}; G.talk.close(); G.step(1/30,5); const after2=G.cine.on; G.cine.skip(); G.step(1/30,3);
     return {ok:opened&&during.card&&!during.on&&after&&owedCard.card&&!owedCard.on&&owedCard.owed&&after2,n,k,during,after,owedCard,after2}; })()"""),
  # in the air: waits for the landing
  ("airborne", 60, r"""(()=>{ delete G._onb.S.seen.opening; const P=G.player; G.input.setVirtual('jump',true); let k=0; while(P.grounded&&k<30){ G.step(1/30,1); k++; } G.input.setVirtual('jump',false);
     const air=!P.grounded; G.emit('wake:done',{from:P.pos.clone(),windows:true}); G.step(1/30,1); const during={on:G.cine.on,owed:G._onb.owed};
     let j=0; while(!G.cine.on&&j<150){ G.step(1/30,1); j++; } const after=G.cine.on, grounded=P.grounded; G.cine.skip(); G.step(1/30,3);
     return {ok:air&&!during.on&&during.owed&&after&&grounded,air,during,after,j}; })()"""),
  # dead: waits for him to rise again (on the beach checkpoint), then plays
  ("dead", 90, r"""(()=>{ delete G._onb.S.seen.opening; const P=G.player; P.hurt({damage:99,ignoreIframes:true,kind:'melee'}); G.step(1/30,10); const dead=G.state.mode;
     G.emit('wake:done',{from:P.pos.clone(),windows:true}); G.step(1/30,30); const during={on:G.cine.on,owed:G._onb.owed};
     document.getElementById('rise').click(); let j=0; while(!G.cine.on&&j<300){ G.step(1/30,1); j++; } const after=G.cine.on; G.cine.skip(); G.step(1/30,3);
     return {ok:dead==='dead'&&!during.on&&during.owed&&after,dead,during,after,j}; })()"""),
 ]),
 ("fallback", True, [
  ("noShot", 240, r"""(()=>{ const b=O.begin(true); const r=O.lines(1800); r.b=b; r.m=O.ms(); r.ok=b.step==='cottage'&&!r.on&&!G.cine.seen('opening')&&r.wake.length===1&&!r.wake[0][2]&&!!r.m; return r; })()"""),
 ]),
]

async def main():
    fails=[]; t00=time.time()
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await (await b.new_context(viewport={'width':1000,'height':600})).new_page(); pg.set_default_timeout(480000)
        errs=[]; pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
        async def boot():
            await pg.evaluate(LIB); await pg.evaluate(EXTRA)
        only=[c for c in os.environ.get('OPENING_CASES','').split(',') if c]   # a quick local look at one case
        for case,_fb,steps in CASES:
            if only and case not in only: continue
            await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(4000)
            await pg.evaluate("localStorage.removeItem('bq-save-v1'); localStorage.removeItem('bq-save-test-v1')")
            await pg.reload(); await pg.wait_for_timeout(4000); await boot()
            broken=False
            for name,budget,js in steps:
                t0=time.time(); label=f'{case}:{name}'
                if broken: print(f'SKIP {label}',flush=True); continue
                try:
                    if name=='RELOAD':
                        await pg.reload(); await pg.wait_for_timeout(4000)
                        vis=await pg.evaluate("!document.getElementById('continue').hidden")
                        await pg.click('#continue'); await pg.wait_for_timeout(1500); await boot(); r={'ok':vis,'continueShown':vis}
                    else: r=await asyncio.wait_for(pg.evaluate(js),budget)
                except Exception as e: r={'ok':False,'exc':(str(e).split('\n')[0][:300]) or type(e).__name__}
                ok=bool(r.get('ok')) if isinstance(r,dict) else False
                if not ok: fails.append(label); broken=True
                print(('PASS ' if ok else 'FAIL ')+f'{label:22s} {time.time()-t0:5.1f}s',':',json.dumps(r,ensure_ascii=False)[:700],flush=True)
        errs=[e for e in errs if '404' not in e and 'favicon' not in e]
        if errs: print('console errors:\n  '+'\n  '.join(errs[:12]))
        await b.close()
    print(f'\nRESULT ({time.time()-t00:.0f}s):', 'ALL PASS' if not fails and not errs else 'FAILED '+', '.join(fails)+(' + console errors' if errs else ''))
    sys.exit(1 if fails or errs else 0)
asyncio.run(main())
