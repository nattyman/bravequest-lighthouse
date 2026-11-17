"""Badges and the keeper rank (js/badges.js, spec RECORD.md section 2): the table, earning in each category live (story, skill
from a real timed boss win, collection, hidden); no card during a boss fight or a cut scene, then shown after; unearned hidden
badges show no name; the two father badges exclude each other until both are earned; save -> reload keeps them; a new game
keeps them; an old save is granted its story and collection badges quietly (no cards, no pings, no skill badges); rank steps;
nearest().
usage: python3 test/badges_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, json, time
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'

HELP="""
window.T={
  clear(){ for(const m of (G.monsters&&G.monsters.list||[]).slice())if(m.alive&&!m.boss)G.monsters.kill(m,{dir:new THREE.Vector3(0,0,1)}); },
  play(){ if(G.state.mode==='paused'&&!document.getElementById('pause').hidden)document.getElementById('resume').click();
    if(G.state.mode==='ending'){ const k=document.getElementById('keep'); if(k)k.click(); } if(G.cine&&G.cine.on)G.cine.skip(); },
  busy(n,dt){ G.input.setVirtual('lock',true); G.step(dt||1/30,n); G.input.setVirtual('lock',false); G.step(1/30,1); },
  // step up to s seconds, noting each badge / rank shown (badges.js's own list), each reward card (finished at once) and each new toast
  drain(s,stopWhenEmpty){ const cards=[], toasts=[]; let last=''; const n0=G.badges.debug.shown.length;
    for(let i=0;i<s*2;i++){ T.busy(15); T.play(); T.clear();
      const r=G.progress.rewarding; if(r){ cards.push(r); G.progress.endReward(); }
      const el=document.getElementById('toast'); const tx=el&&el.classList.contains('show')?el.textContent:''; if(tx&&tx!==last)toasts.push(tx); last=tx;
      if(stopWhenEmpty&&!G.badges.debug.queue.length&&!G.progress.busy&&i>6)break; }
    const sh=G.badges.debug.shown.slice(n0);
    return {cards:sh.filter(c=>c.startsWith('badge:')),ranks:sh.filter(c=>c.startsWith('rank:')),rewards:cards,toasts}; },
  ent(id){ return G.badges.list().find(b=>b.id===id)||null; },
  evs:[], pings:[]
};
G.beta={ping:n=>T.pings.push(n)};       // dev.html has no beta.js: count the pings badges.js sends
if(!window.__bEv){ window.__bEv=1; ['badge:earned','rank:up'].forEach(n=>G.on(n,e=>T.evs.push([n,JSON.parse(JSON.stringify(e||{}))]))); }
if(!window.__talkAuto){ window.__talkAuto=1; G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{}; G.on('talk:open',()=>{ let n=0; while(G.talk.isOpen&&n<80){ const s=G.talk.state(); if(s.choices.length)G.talk.choose(0); else G.talk.advance(); n++; } }); }
if(G.headless)G.headless.hold=true;
'ok'"""

EARNED="T.evs.filter(e=>e[0]==='badge:earned').map(e=>e[1])"

STEPS1=[
 # the table: 25 badges with the contract's ids; unearned hidden ones are "???" with no hint; unearned story ones show no name
 ("table", 30, "(()=>{ const L=G.badges.list(); return {n:L.length, total:G.badges.total(), count:G.badges.count(), ids:G.badges.BADGES.map(b=>b.id),"
   " hidden:L.filter(b=>b.hidden).map(b=>[b.name,b.hint,b.desc,b.shown]), story:L.filter(b=>b.cat==='story').map(b=>[b.name,!!b.hint,b.shown]),"
   " skill:L.filter(b=>b.cat==='skill').map(b=>[b.name,!!b.hint]), rank:G.badges.rank(), ranks:G.badges.RANKS, mode:G.state.mode}; })()",
   lambda r: r['n']==25 and r['total']==25 and r['count']==0 and len(set(r['ids']))==25
             and r['ids'][:9]==['ashore','staff','stag','light','gloaming','undertow','crane','answer','giant']
             and r['hidden']==[['???',None,'',False]]*3 and all(s==['???',True,False] for s in r['story'])
             and all(s[0]!='???' and s[1] for s in r['skill']) and r['rank']['i']==0 and r['rank']['name']=='Castaway'
             and r['rank']['next']['name']=='Lamplighter' and len(r['ranks'])==6),
 # a new game: the opening lines finish -> 'ashore', earned live (the opening shot holds its card back until it ends)
 ("story-live", 150, "(()=>{ document.getElementById('begin').click(); G.step(1/30,3);"
   " for(let i=0;i<120&&!G.badges.has('ashore');i++){ if(G.ui.advance)G.ui.advance(); T.busy(15); }"
   " const e="+EARNED+".filter(x=>x.id==='ashore'); const d=T.drain(30,true); return {e, cards:d.cards, rewards:d.rewards, toasts:d.toasts, pings:T.pings.slice(), ent:T.ent('ashore')}; })()",
   lambda r: len(r['e'])==1 and 'Worst Docking EverKeeper’s record · Badge 1 of 25' in r['toasts'] and not any(x.startswith('badge') for x in r['rewards']) and r['e'][0]['restored'] is False and r['cards']==['badge:ashore'] and r['pings']==['badge:ashore']
             and r['ent']['name']=='Worst Docking Ever' and r['ent']['desc'] and r['ent']['got']>0),
 # no card while a cut scene is on; it comes after
 ("cine-holds", 90, "(()=>{ T.play(); T.clear(); G.cine.play('badges-test-shot',{dur:30,shot(k,t,out){ out.cp=G.camera.position.clone(); out.lp=G.player.pos.clone(); }});"
   " G.record.debug.reach('staff'); T.busy(150); const during={on:G.cine.on, card:G.progress.rewarding, q:G.badges.debug.queue.map(q=>q.id), got:G.badges.has('staff')};"
   " G.cine.skip(); G.step(1/30,3); const d=T.drain(20,true); return {during, cards:d.cards}; })()",
   lambda r: r['during']['on'] is True and r['during']['card'] is None and r['during']['q']==['staff'] and r['during']['got'] and r['cards']==['badge:staff']),
 # a boss fight: a hidden badge earned mid-fight waits; the timed win with no damage and no draught gives the skill badges
 ("fight-holds", 120, "(()=>{ T.play(); T.clear(); const before=T.ent('wren'); G.emit('undercroft:bossStart',{}); T.busy(30); const att=!!G.record.attempt;"
   " G.emit('undercroft:saved',{who:'wren'}); T.busy(120); const during={card:G.progress.rewarding, q:G.badges.debug.queue.map(q=>q.id), att:!!G.record.attempt};"
   " G.emit('undercroft:bossDead',{pos:G.player.pos.clone()}); G.step(1/30,3); const b=G.record.boss('crane'); const d=T.drain(60,true);"
   " return {before, att, during, b, cards:d.cards, after:T.ent('wren'), pings:T.pings.slice()}; })()",
   lambda r: r['before']['name']=='???' and r['before']['hint'] is None and r['att'] and r['during']['card'] is None and r['during']['att']
             and r['during']['q']==['wren'] and r['b']['hurt']==0 and r['b']['draughts']==0
             and r['cards']==['badge:wren','badge:crane','badge:untouched','badge:dry'] and r['after']['name']=='Sorry, Who Are You Again?'
             and r['pings']==['badge:ashore','badge:staff','badge:wren','badge:crane','badge:untouched','badge:dry']),
 # a win with damage taken and a draught drunk gives neither skill badge (revoked first so they could be earned again)
 ("skill-strict", 90, "(()=>{ T.play(); T.clear(); G.badges.debug.revoke('untouched'); G.badges.debug.revoke('dry'); G.emit('temple:bossStart',{}); T.busy(30);"
   " G.player.hp=G.player.maxHp; G.player.hurt({damage:1,ignoreIframes:true,kind:'melee'}); G.potions.add(1,{silent:true}); G.potions.drink(); T.busy(30);"
   " G.emit('temple:bossDead',{pos:G.player.pos.clone()}); G.step(1/30,3); const b=G.record.boss('answer'); T.drain(30,true);"
   " return {b, u:G.badges.has('untouched'), d:G.badges.has('dry'), answer:G.badges.has('answer')}; })()",
   lambda r: r['b']['hurt']>0 and r['b']['draughts']==1 and r['u'] is False and r['d'] is False and r['answer'] is True),
 # nearest(): the smallest countable gap; a collection badge earned live when the last heart shard is found
 ("collect-nearest", 120, "(()=>{ T.play(); const tot=G.record.completion().parts.shards[1]; const have=G.record.completion().parts.shards[0]; G.progress.give('shard',tot-have-1); G.progress.endReward(); T.busy(60);"
   " const P=G.record.completion().parts, near=G.badges.nearest(), gaps=Object.entries(P).map(([k,v])=>v[1]-v[0]).filter(g=>g>0);"
   " const pre=G.badges.has('shards'); G.progress.give('shard',1); const d=T.drain(40,true);"
   " return {near, minGap:Math.min(...gaps), pre, got:G.badges.has('shards'), cards:d.cards, ev:"+EARNED+".filter(e=>e.id==='shards')}; })()",
   lambda r: r['near']=={'id':'shards','name':'Heart Hoarder','text':'1 heart shard from Heart Hoarder'} and r['minGap']==1 and r['pre'] is False
             and r['got'] and r['cards']==['badge:shards'] and len(r['ev'])==1 and r['ev'][0]['restored'] is False),
 # the father rule: one ending drops the other slot; the other ending (a later run) shows both as earned
 ("father", 90, "(()=>{ T.play(); const ids=()=>G.badges.list().map(b=>b.id); const t0=G.badges.total(), a0=ids().filter(i=>i.startsWith('father'));"
   " G.emit('northFire:finish',{outcome:'died'}); const t1=G.badges.total(), a1=ids().filter(i=>i.startsWith('father')), died=T.ent('father-died');"
   " T.drain(20,true); G.emit('northFire:finish',{outcome:'lived'}); const t2=G.badges.total(), a2=ids().filter(i=>i.startsWith('father')); T.drain(20,true);"
   " G.badges.debug.revoke('father-died'); G.badges.debug.revoke('father-lived'); G.badges.debug.grant('father-lived'); const t3=G.badges.total(), a3=ids().filter(i=>i.startsWith('father'));"
   " G.badges.debug.grant('father-died'); T.drain(20,true); return {t0,a0,t1,a1,died,t2,a2,t3,a3}; })()",
   lambda r: r['t0']==25 and r['a0']==['father-died','father-lived'] and r['t1']==24 and r['a1']==['father-died'] and r['died']['name']=='Dad to the Rescue'
             and r['t2']==25 and r['a2']==['father-died','father-lived'] and r['t3']==24 and r['a3']==['father-lived']),
 # rank: the light restored -> Lamplighter (one toast); the Gloaming won on the first try, with 8+ badges -> Keeper.
 # Both milestones are live and timed from the opening, with no deaths: Unbothered. Alive., Left the Oven On, No Notes.
 ("rank", 180, "(()=>{ T.play(); T.clear(); const r0=G.badges.rank(); G.record.debug.reach('lamp-cured'); const d1=T.drain(30,true); const r1=G.badges.rank();"
   " G.emit('gloaming:start',{}); T.busy(60); G.emit('boss:dead',{who:'gloaming'}); G.step(1/30,3); const d2=T.drain(40,true); T.play(); const r2=G.badges.rank();"
   " return {r0,r1,r2,c:G.badges.count(),d1,d2,ups:T.evs.filter(e=>e[0]==='rank:up').map(e=>e[1]),deaths:G.record.state.n.deaths,"
   " has:['light','surefooted','gloaming','swift','firsttry'].map(id=>G.badges.has(id))}; })()",
   lambda r: r['r0']['i']==0 and r['r1']['i']==1 and r['r1']['name']=='Lamplighter' and 'first night' in r['r1']['next']['need']
             and r['r2']['i']==2 and r['r2']['name']=='Keeper' and r['r2']['next']['name']=='Warden of the Isle' and r['c']>=8 and r['deaths']==0
             and r['has']==[True]*5 and r['ups']==[{'i':1,'name':'Lamplighter'},{'i':2,'name':'Keeper'}]
             and 'badge:light' in r['d1']['cards'] and 'badge:surefooted' in r['d1']['cards']
             and r['d1']['ranks']==['rank:1'] and r['d2']['ranks']==['rank:2']
             and sorted(set(t for t in r['d1']['toasts']+r['d2']['toasts'] if 'New rank' in t))==['KeeperKeeper’s record · New rank','LamplighterKeeper’s record · New rank'] and set(['badge:gloaming','badge:swift','badge:firsttry'])<=set(r['d2']['cards'])),
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
    print(('ok  ' if ok else 'FAIL'), name, f'({time.time()-t:.0f}s)', ':', json.dumps(r)[:900])
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
        await pg.evaluate("['bq-save-v1','bq-save-test-v1','bq-combos','bq-badges','bq-badges-test'].forEach(k=>localStorage.removeItem(k))")
        await pg.reload(); await pg.wait_for_timeout(5000)
        await pg.evaluate(HELP)
        res={}
        for name,budget,js,check in STEPS1:
            dep_failed = name!='table' and name!='story-live' and res.get('story-live') is None
            res[name]=await run(pg,name,budget,js,check,fails,skipped=dep_failed)

        # save -> reload -> Continue: the badges come back as they were; nothing is shown, pinged or earned again
        before=await ev(pg,"(()=>{ T.play(); T.busy(10); G.setMode('paused'); document.getElementById('saveBtn').click(); return G.badges.state.got; })()",60)
        ok_before=isinstance(before,dict) and len(before)>=10
        if ok_before: await reload(pg,'continue')
        await run(pg,'reload',90,"(()=>{ const d=T.drain(10); return {got:G.badges.state.got, ev:"+EARNED+", pings:T.pings, cards:d.cards, q:G.badges.debug.queue.length, rank:G.badges.rank().i}; })()",
                  lambda r: all(r['got'].get(k)==v for k,v in before.items()) and all(e['restored'] for e in r['ev']) and r['pings']==[] and r['cards']==[] and r['q']==0 and r['rank']==2, fails, skipped=not ok_before)

        # a new game in the same browser (even with this browser's own copy gone): every badge stays; the rank starts again
        stored=await ev(pg,"(()=>{ T.play(); G.setMode('paused'); document.getElementById('saveBtn').click(); localStorage.removeItem('bq-badges'); return JSON.parse(localStorage.getItem('bq-save-v1')).mods.badges; })()",60)
        ok_stored=isinstance(stored,dict) and len(stored.get('got',{}))>=10
        if ok_stored: await reload(pg,'begin')
        await run(pg,'new-game',90,"(()=>{ T.drain(5); return {got:G.badges.state.got, run:G.record.state.run, rank:G.badges.rank(), ev:"+EARNED+", ups:T.evs.filter(e=>e[0]==='rank:up'), ls:!!localStorage.getItem('bq-badges')}; })()",
                  lambda r: r['got']==stored['got'] and r['run']==2 and r['rank']['i']==0 and r['ev']==[] and r['ups']==[] and r['ls'], fails, skipped=not ok_stored)

        # an old save (before badges and the record existed): story, collection and hidden badges come quietly; no skill badges
        made=await ev(pg,"""(()=>{ T.play(); G.progress.give('shard',99); G.progress.endReward(); T.busy(10); G.setMode('paused'); document.getElementById('saveBtn').click(); const d=JSON.parse(localStorage.getItem('bq-save-v1'));
            delete d.mods.record; delete d.mods.badges; d.stagDead=true; d.staff=true; d.lampCured=true; d.bossDead=true; d.loop=true; d.step='done';
            if(d.mods.undercroftPeople&&d.mods.undercroftPeople.wren)d.mods.undercroftPeople.wren.saved=true;
            localStorage.setItem('bq-save-v1',JSON.stringify(d)); localStorage.removeItem('bq-badges'); G.badges.debug.reset(); return true; })()""",60)
        if made is True: await reload(pg,'continue')
        await run(pg,'old-save',90,"(()=>{ const d=T.drain(10); const e="+EARNED+"; return {ids:e.map(x=>x.id).sort(), allQuiet:e.every(x=>x.restored), pings:T.pings, cards:d.cards, q:G.badges.debug.queue.length,"
                  " skill:G.badges.list().filter(b=>b.cat==='skill'&&b.got).map(b=>b.id), gl:G.record.ms('gloaming'), rank:G.badges.rank().i, ups:T.evs.filter(x=>x[0]==='rank:up')}; })()",
                  lambda r: {'ashore','staff','stag','light','gloaming','shards'}<=set(r['ids']) and r['allQuiet'] and r['pings']==[] and r['cards']==[] and r['q']==0
                            and r['skill']==[] and r['gl']=={'t':None,'at':None} and r['rank']>=1 and r['ups']==[], fails, skipped=made is not True)

        try:
            await pg.evaluate('G.headless&&G.headless.draw(3); 0'); await pg.wait_for_timeout(250)
            import os; os.makedirs('/tmp/claude-0/badges',exist_ok=True)
            await pg.screenshot(path='/tmp/claude-0/badges/e2e_end.png',timeout=60000)
        except Exception as e: print('  (no screenshot)',str(e)[:120])
        real=[e for e in errs if '404' not in e]
        for e in real[:10]: print('  ERR',e[:300])
        if real: fails.append('console errors')
        await b.close()
    print(('PASS' if not fails else 'FAIL '+', '.join(fails)), f'{time.time()-t0:.0f}s'); sys.exit(1 if fails else 0)
asyncio.run(main())
