"""The Keeper's Record (js/record.js, spec RECORD.md): play time counts only in play (not on the title, paused or in a cut scene)
and stops after 120 s without input; a milestone is set once and never changes; a boss's tries and best win (time, damage taken,
draughts); completion totals match the Journal's; save -> reload -> Continue keeps the record; a new game on the same browser
keeps the finished run in runs[] (and the techniques found); an old save without a record loads and back-fills its milestones.
usage: python3 test/record_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, json, time
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'

HELP="""
window.T={
  clear(){ for(const m of (G.monsters&&G.monsters.list||[]).slice())if(m.alive&&!m.boss)G.monsters.kill(m,{dir:new THREE.Vector3(0,0,1)}); },
  play(){ if(G.state.mode==='paused'&&!document.getElementById('pause').hidden)document.getElementById('resume').click(); if(G.cine&&G.cine.on)G.cine.skip(); },
  // input held (so the idle clock stays at 0) while the game steps
  busy(n,dt){ G.input.setVirtual('lock',true); G.step(dt||1/30,n); G.input.setVirtual('lock',false); G.step(1/30,1); },
  rec(){ return JSON.parse(JSON.stringify(G.record.state)); },
  evs:[]
};
if(!window.__recEv){ window.__recEv=1; ['record:milestone','record:boss','record:newgame'].forEach(n=>G.on(n,e=>T.evs.push([n,JSON.parse(JSON.stringify(e||{}))]))); }
if(!window.__talkAuto){ window.__talkAuto=1; G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{}; G.on('talk:open',()=>{ let n=0; while(G.talk.isOpen&&n<80){ const s=G.talk.state(); if(s.choices.length)G.talk.choose(0); else G.talk.advance(); n++; } }); }
if(G.headless)G.headless.hold=true;   // the game moves only by G.step: play-time sums are exact
'ok'"""

def near(a,b,eps=.15): return a is not None and b is not None and abs(a-b)<=eps

STEPS1=[
 # on the title nothing counts
 ("title", 30, "(()=>{ const p0=G.record.play(); G.step(1/30,90); return {mode:G.state.mode, p0, p1:G.record.play()}; })()",
   lambda r: r['mode']=='title' and r['p0']==0 and r['p1']==0),
 # a new game from the title (no save in this browser): run 1, one session, today in days
 ("begin", 60, "(()=>{ document.getElementById('begin').click(); G.step(1/30,3); T.play(); const s=T.rec(); return {mode:G.state.mode, run:s.run, sessions:s.sessions, days:s.days.length, runs:s.runs.length, ms:Object.keys(s.ms)}; })()",
   lambda r: r['mode']=='play' and r['run']==1 and r['sessions']==1 and r['days']==1 and r['runs']==0 and r['ms']==[]),
 # the opening lines finish on the beach -> 'ashore', a live time
 ("ashore", 120, "(()=>{ for(let i=0;i<120&&!G.record.ms('ashore');i++){ if(G.ui.advance)G.ui.advance(); T.busy(15); T.play(); } T.play(); return G.record.ms('ashore'); })()",
   lambda r: r is not None and isinstance(r['t'],(int,float)) and r['t']>0 and r['at']),
 # play counts in play, not paused, not in a cut scene
 ("play-counts", 60, "(()=>{ T.play(); T.clear(); const a=G.record.play(); T.busy(60); const b=G.record.play();"
   " G.setMode('paused'); G.step(1/30,90); const c=G.record.play(); G.setMode('play');"
   " const cine=G.cine.play('record-test-shot',{dur:8,shot(k,t,out){ out.cp=G.camera.position.clone(); out.lp=G.player.pos.clone(); }}); G.step(1/30,90); const d=G.record.play(), on=G.cine.on; G.cine.skip(); G.step(1/30,3);"
   " return {played:+(b-a).toFixed(3), paused:+(c-b).toFixed(3), cine, on, inCine:+(d-c).toFixed(3)}; })()",
   lambda r: near(r['played'],2.0,.1) and r['paused']==0 and r['cine'] is True and r['on'] is True and r['inCine']==0),
 # idle: with no input for 120 s play stops counting; any input starts it again
 ("idle", 180, "(()=>{ T.play(); T.clear(); T.busy(2); const a=G.record.play(); G.step(.25,560); const b=G.record.play(), idle=G.record.debug.idle; G.step(.25,40); const c=G.record.play();"
   " T.busy(60); const d=G.record.play(); return {idled:+(b-a).toFixed(2), idle, after:+(c-b).toFixed(3), back:+(d-c).toFixed(3), mode:G.state.mode}; })()",
   lambda r: r['mode']=='play' and 119<=r['idled']<=120.6 and r['idle']>=120 and r['after']==0 and near(r['back'],2.0,.1)),
 # a milestone is set once: the real event stamps it; the same event later, or a restored replay, changes nothing
 ("milestone-once", 30, "(()=>{ T.play(); const p=G.record.play(); G.emit('lamp:failed'); const a=G.record.ms('plain-flame'); G.record.debug.addPlay(50); G.emit('lamp:failed'); const b=G.record.ms('plain-flame');"
   " G.emit('boat:sail',{ready:false}); G.step(1/30,3); const cured=G.record.ms('sailed'); const split=G.record.split('plain-flame'), sa=G.record.ms('ashore').t;"
   " return {p,a,b,cured,split,sa,ev:T.evs.filter(e=>e[0]==='record:milestone'&&e[1].id==='plain-flame').length}; })()",
   lambda r: near(r['a']['t'],r['p'],.11) and r['b']==r['a'] and r['cured'] is None and r['ev']==1 and near(r['split'],r['a']['t']-r['sa'],.11)),
 # the Hollow Stag for real: it engages when Rowan walks in armed, a death is a try, the kill is the win
 ("stag-try", 120, "(()=>{ T.play(); if(G.lighthouse&&G.lighthouse.restoreStaff)G.lighthouse.restoreStaff(); G.items.staff.owned=true; G.emit('staff:pickup');"
   " const A=G.monsters.stagArena(); G.player.teleport(A.x+A.r+8,null,A.z,-Math.PI/2); G.step(1/30,3); G.monsters.startStag(); T.busy(100); T.clear();"
   " for(let i=0;i<40&&!G.record.attempt;i++){ G.player.teleport(A.x+4,null,A.z,-Math.PI/2); T.busy(4); }"
   " const att=G.record.attempt; T.busy(30); G.player.hp=G.player.maxHp; G.player.hurt({damage:1,ignoreIframes:true,kind:'melee'}); G.potions.add(2,{silent:true}); const dr=G.potions.drink(); T.busy(60);"
   " G.player.hurt({damage:99,ignoreIframes:true,kind:'melee'}); G.step(1/30,10); const b=G.record.boss('stag'), dead=G.record.state.n.deaths; document.getElementById('rise').click(); G.step(1/30,3); T.play(); return {att, dr, b, dead, cur:G.record.attempt, staff:G.record.ms('staff')}; })()",
   lambda r: r['att'] and r['att']['id']=='stag' and r['dr'] is True and r['b'] and r['b']['tries']==1 and r['b']['best'] is None and r['dead']==1 and r['staff'] and r['staff']['t'] is not None and r['cur'] is None),
 ("stag-win", 120, "(()=>{ T.play(); const A=G.monsters.stagArena(); T.clear(); for(let i=0;i<60&&!G.record.attempt;i++){ G.player.teleport(A.x+4,null,A.z,-Math.PI/2); T.busy(4); }"
   " const att=!!G.record.attempt; const t0=G.record.attempt&&G.record.attempt.time; T.busy(90); G.player.hp=G.player.maxHp; G.player.hurt({damage:2,ignoreIframes:true,kind:'melee'}); T.busy(30);"
   " const p=G.record.attempt&&G.record.attempt.time; const m=G.monsters.boss; if(m)G.monsters.kill(m,{dir:new THREE.Vector3(0,0,1)}); for(let i=0;i<40&&!G.record.ms('stag');i++)G.step(1/30,10); T.play();"
   " const ev=T.evs.filter(e=>e[0]==='record:boss'&&e[1].id==='stag').map(e=>e[1]); return {att,t0,p,boss:!!m,b:G.record.boss('stag'),ms:G.record.ms('stag'),ev,flowDead:G.flow.stagDead}; })()",
   lambda r: r['att'] and r['boss'] and r['flowDead'] and r['b']['tries']==2 and r['p']<=r['b']['best']<=r['p']+6 and r['ev'][1]['time']==r['b']['best'] and r['b']['hurt']==2 and r['b']['draughts']==0
             and r['ms'] and r['ms']['t'] is not None and len(r['ev'])==2 and r['ev'][0]['win'] is False and r['ev'][1]['win'] is True),
 # completion: read live, the same totals the Journal shows
 ("completion", 30, "(()=>{ const c=G.record.completion(), d=G.progress.journal.data(), W=G.map.waypoints;"
   " return {c, j:{bosses:[d.bosses.filter(b=>b.done).length,d.bosses.length], shards:[d.shards,d.shardTotal], caches:[d.caches,d.cacheTotal], negatives:[d.freed,d.freedTotal],"
   " blights:[d.blights.filter(b=>b.cured).length,d.blights.length], tempered:[d.upgrades.length,G.progress.UPGRADES.length], waystones:[W.filter(w=>w.unlocked).length,W.length],"
   " companions:[['ember','corvin'].filter(id=>G.companions.has(id)).length,2]}, sum:G.record.summary()}; })()",
   lambda r: all(r['c']['parts'].get(k)==v for k,v in r['j'].items()) and set(r['c']['parts'])==set(r['j'])
             and r['c']['total']==sum(v[1] for v in r['j'].values()) and r['c']['done']==sum(v[0] for v in r['j'].values())
             and r['c']['pct']==int(r['c']['done']*100//r['c']['total']) and r['sum']['pct']==r['c']['pct'] and r['c']['parts']['bosses'][0]>=1
             and r['sum']['bosses'].get('stag') is not None and r['sum']['act1'] is False and r['sum']['deaths']==1),
 ("fmt", 10, "[G.record.fmt(725), G.record.fmt(5025), G.record.fmt(0), G.record.fmt(59.9)]",
   lambda r: r==['12:05','1:23:45','0:00','0:59']),
]

async def ev(pg, js, budget):
    try: return await asyncio.wait_for(pg.evaluate(js), timeout=budget)
    except asyncio.TimeoutError: return 'EXC timeout after %ss'%budget
    except Exception as e: return 'EXC '+str(e).split('\n')[0][:300]

async def run(pg, name, budget, js, check, fails, skipped=False):
    if skipped:
        print('SKIP', name); return None
    t=time.time(); r=await ev(pg,js,budget); ok=False
    try: ok=bool(check(r)) if not (isinstance(r,str) and r.startswith('EXC')) else False
    except Exception: ok=False
    print(('ok  ' if ok else 'FAIL'), name, f'({time.time()-t:.0f}s)', ':', json.dumps(r)[:700])
    if not ok: fails.append(name)
    return r if ok else None

async def reload(pg, click):
    await asyncio.wait_for(pg.reload(), timeout=180); await pg.wait_for_timeout(4000); await pg.evaluate(HELP)
    await pg.evaluate(f"document.getElementById('{click}').click(); G.step(1/30,30); T.play(); G.step(1/30,3); 0")

async def main():
    t0=time.time(); fails=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await (await b.new_context(viewport={'width':1000,'height':620})).new_page(); pg.set_default_timeout(240000)
        errs=[]; pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' and '404' not in m.text else None)
        await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
        await pg.evaluate("localStorage.removeItem('bq-save-v1'); localStorage.removeItem('bq-save-test-v1'); localStorage.removeItem('bq-combos')")
        await pg.reload(); await pg.wait_for_timeout(5000)
        await pg.evaluate(HELP)
        for name,budget,js,check in STEPS1: await run(pg,name,budget,js,check,fails)

        # save -> reload -> Continue: the record comes back as it was (and one more session)
        before=await ev(pg,"(()=>{ T.play(); G.moves.performed('lunge'); G.step(1/30,2); G.setMode('paused'); document.getElementById('saveBtn').click(); return T.rec(); })()",60)
        ok_before=isinstance(before,dict)
        if ok_before: await reload(pg,'continue')
        print('   before:',json.dumps(before)[:900])
        await run(pg,'reload',60,"(()=>{ G.step(1/30,10); const s=T.rec(); s.ms=JSON.stringify(s.ms); return s; })()",
                  lambda r: before['play']<=r['play']<=before['play']+2 and json.loads(r['ms'])==before['ms'] and r['boss']==before['boss'] and r['n']['deaths']==before['n']['deaths']
                            and r['n']['hurt']==before['n']['hurt'] and r['sessions']==before['sessions']+1 and 'lunge' in r['combos'] and r['run']==1, fails, skipped=not ok_before)

        # a new game on the same browser: the finished run goes into runs[], the techniques found stay (even with bq-combos gone)
        stored=await ev(pg,"(()=>{ T.play(); T.busy(30); G.setMode('paused'); document.getElementById('saveBtn').click(); localStorage.removeItem('bq-combos'); return JSON.parse(localStorage.getItem('bq-save-v1')).mods.record; })()",60)
        ok_stored=isinstance(stored,dict) and stored.get('play',0)>0
        if ok_stored: await reload(pg,'begin')
        await run(pg,'new-game',60,"(()=>{ G.step(1/30,5); const s=T.rec(); return {s, ls:JSON.parse(localStorage.getItem('bq-combos')||'[]'), found:G.moves.isFound('lunge'), best:G.record.best('plain-flame'), ev:T.evs.filter(e=>e[0]==='record:newgame')}; })()",
                  lambda r: r['s']['run']==2 and len(r['s']['runs'])==1 and near(r['s']['runs'][0]['play'],stored['play'],.2) and r['s']['runs'][0]['deaths']==1
                            and r['s']['runs'][0]['ms'].get('stag') is not None and r['s']['play']<5 and r['s']['ms'].get('stag') is None and r['s']['boss']=={}
                            and 'lunge' in r['s']['combos'] and 'lunge' in r['ls'] and r['found'] and r['s']['sessions']==stored['sessions']+1
                            and r['best'] is not None and len(r['ev'])==1, fails, skipped=not ok_stored)

        # an old save (before the record existed): it loads, and what it holds is granted quietly with no times
        made=await ev(pg,"""(()=>{ T.play(); T.busy(10); G.setMode('paused'); document.getElementById('saveBtn').click(); const d=JSON.parse(localStorage.getItem('bq-save-v1'));
            delete d.mods.record; d.stagDead=true; d.flags.undertowDead=true; d.staff=true; d.step='forest';
            if(d.mods.caveBoss)d.mods.caveBoss.defeated=true; else d.mods.caveBoss={v:1,pages:[1,2,3],defeated:true,discovered:true,hal:false,entered:true,bossSeen:true,said:[]};
            localStorage.setItem('bq-save-v1',JSON.stringify(d)); return true; })()""",60)
        if made is True: await reload(pg,'continue')
        await run(pg,'old-save',60,"(()=>{ G.step(1/30,10); const s=T.rec(); return {s, ev:T.evs.filter(e=>e[0]==='record:milestone').map(e=>e[1]), mode:G.state.mode}; })()",
                  lambda r: r['mode']=='play' and all(r['s']['ms'].get(k)=={'t':None,'at':None} for k in ['ashore','plain-flame','stag','lantern','staff','lamp-cured','gloaming','undertow'])
                            and r['s']['ms'].get('crane') is None and r['s']['ms'].get('giant') is None and r['s']['runs']==[] and r['s']['sessions']==1
                            and len(r['ev'])==8 and all(e['restored'] and e['t'] is None for e in r['ev']), fails, skipped=made is not True)
        # ... and from there on a real milestone gets a real time, after the restored ones
        await run(pg,'old-save-live',60,"(()=>{ T.play(); T.busy(30); G.emit('undercroft:bossStart',{}); T.busy(45); G.emit('undercroft:bossDead',{pos:G.player.pos.clone()}); G.step(1/30,3); T.play();"
                  " return {ms:G.record.ms('crane'), b:G.record.boss('crane'), split:G.record.split('crane'), sum:G.record.summary()}; })()",
                  lambda r: r['ms']['t'] is not None and r['ms']['t']>0 and r['b']['tries']==1 and near(r['b']['best'],1.5,.2) and near(r['split'],r['ms']['t'],.01)
                            and r['sum']['splits']=={'crane':round(r['ms']['t'])} and r['sum']['act1'] is True, fails, skipped=made is not True)

        try:
            await pg.evaluate('G.headless&&G.headless.draw(3); 0'); await pg.wait_for_timeout(250)
            import os; os.makedirs('/tmp/claude-0/record',exist_ok=True)
            await pg.screenshot(path='/tmp/claude-0/record/e2e_end.png',timeout=60000)
        except Exception as e: print('  (no screenshot)',str(e)[:120])
        real=[e for e in errs if '404' not in e]
        for e in real[:10]: print('  ERR',e[:300])
        if real: fails.append('console errors')
        await b.close()
    print(('PASS' if not fails else 'FAIL '+', '.join(fails)), f'{time.time()-t0:.0f}s'); sys.exit(1 if fails else 0)
asyncio.run(main())
