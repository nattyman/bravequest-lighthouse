"""The Journal's Record and Badges tabs, the Continue card's record line and the welcome-back card (js/progression.js, js/flow.js;
spec RECORD.md, section 3). Without G.badges the Record shows no rank and there is no Badges tab; with a stand-in G.badges (made
here, in the page: js/badges.js is its own module) the rank and the badge grid appear. A reached milestone is named, an unreached
one is not. Keyboard and controller (LB / RB) change tabs. The Continue card shows time played from the stored save. Welcome back
appears for a save last played over 12 h ago, not for a recent one, not with the setting off, and never in a test session unless the
test asks for it (G.progress.welcome.allowInTests).
Screenshots (desktop and 390x844): /tmp/claude-0/s4/ (or the folder given as the second argument).
usage: python3 test/journal_e2e.py [url] [shots]   (default http://localhost:8800/dev.html?debug&headless)"""
import asyncio, sys, json, time, os
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
SHOTS=sys.argv[2] if len(sys.argv)>2 else '/tmp/claude-0/s4'
DESK={'width':1280,'height':800}; PHONE={'width':390,'height':844}

HELP="""
window.T={
  clear(){ for(const m of (G.monsters&&G.monsters.list||[]).slice())if(m.alive&&!m.boss)G.monsters.kill(m,{dir:new THREE.Vector3(0,0,1)}); },
  play(){ if(G.state.mode==='paused'&&!document.getElementById('pause').hidden)document.getElementById('resume').click(); if(G.cine&&G.cine.on)G.cine.skip(); },
  journal(){ T.play(); G.setMode('paused'); document.getElementById('pause').hidden=false; document.getElementById('journalBtn').click(); G.step(1/30,1); },
  shut(){ document.getElementById('journalClose').click(); if(!document.getElementById('pause').hidden)document.getElementById('resume').click(); G.step(1/30,2); },
  tabs(){ return [...document.querySelectorAll('#journalTabs [data-jt]')].filter(b=>!b.hidden&&b.getClientRects().length).map(b=>b.dataset.jt); },
  sel(){ const b=document.querySelector('#journalTabs [aria-selected="true"]'); return b&&b.dataset.jt; },
  text(id){ const e=document.getElementById(id); return e&&!e.hidden?e.innerText:''; },
  wb(){ const w=document.getElementById('welcomeBack'); return {shown:!!w&&!w.hidden, mode:G.state.mode, text:w?w.innerText:''}; },
  // a stand-in for js/badges.js, built to the G.badges contract (tests only)
  badges(){
    const now=Date.now(), got={first:now-86400e3*2, stick:now-3600e3, clean:now-600e3};
    const L=[['first','story','First Footing','You arrived, more or less.','Reach the island.',false,'ashore'],
             ['stick','story','Stick Found','A stick, but important.','Find what the keeper left on the stairs.',false,'staff'],
             ['deer','story','Antlers Optional','It had it coming.','Take back what the wood guards.',false,'stag'],
             ['clean','skill','Spotless','Not a mark on you.','Beat a boss without being hit.',false,null],
             ['sober','skill','Clear Head','No draughts needed.','Beat a boss without a draught.',false,null],
             ['hoard','collect','Shard Keeper','Every shard, kept.','Find every heart shard.',false,null],
             ['who','hidden','A Stranger','You met someone.','',true,null],
             ['fate','hidden','A Choice','You chose.','',true,null]];
    const list=()=>L.map(([id,cat,name,desc,hint,hidden,ms])=>({id,cat,name,desc,hint,hidden,got:got[id]||0,shown:!!got[id]||(!hidden&&(cat!=='story'||!!(ms&&G.record.ms(ms))))}));
    window.G.badges={ list, has:id=>!!got[id], count:()=>Object.keys(got).length, total:()=>L.length, RANKS:['Castaway','Lamplighter','Keeper'],
      nearest:()=>({id:'hoard',name:'Shard Keeper',text:'3 heart shards from Shard Keeper'}),
      rank:()=>({i:1,name:'Lamplighter',next:{name:'Keeper',need:'the Gloaming and 5 more badges'}}), debug:{} };
    return true;
  }
};
if(!window.__talkAuto){ window.__talkAuto=1; G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{}; G.on('talk:open',()=>{ let n=0; while(G.talk.isOpen&&n<80){ const s=G.talk.state(); if(s.choices.length)G.talk.choose(0); else G.talk.advance(); n++; } }); }
if(G.headless)G.headless.hold=true;
'ok'"""

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

async def shot(pg, name, size):
    await pg.set_viewport_size(size); await pg.evaluate("G.headless&&G.headless.draw(3)"); await pg.wait_for_timeout(700)
    path=os.path.join(SHOTS,name+'.png'); await pg.screenshot(path=path); print('   shot', path)

async def main():
    os.makedirs(SHOTS,exist_ok=True); fails=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await (await b.new_context(viewport=DESK)).new_page(); pg.set_default_timeout(240000)
        errs=[]; pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' and '404' not in m.text else None)
        await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
        await pg.evaluate("['bq-save-v1','bq-save-test-v1','bq-combos','bq-welcome'].forEach(k=>localStorage.removeItem(k))")
        await pg.reload(); await pg.wait_for_timeout(5000)
        await pg.evaluate(HELP)

        # a new game with two milestones reached (and one finished run behind it, for "best")
        await run(pg,'setup',90,"""(()=>{ document.getElementById('begin').click(); G.step(1/30,3); T.play(); T.clear();
            G.record.debug.addPlay(400); G.record.debug.reach('ashore',62); G.record.debug.reach('staff',395.4);
            G.record.debug.set('n.deaths',3); G.record.debug.set('n.kills',17); G.record.debug.set('n.draughts',2);
            G.record.debug.set('runs',[{play:5400,ms:{ashore:48,staff:300,stag:900},deaths:5,at:Date.now()-864e5*3}]);
            return {mode:G.state.mode, ms:Object.keys(G.record.state.ms), badges:!!G.badges}; })()""",
            lambda r: r['mode']=='play' and r['ms']==['ashore','staff'], fails)

        # without G.badges: Record and the carry page, no Badges tab, no rank
        r=await run(pg,'noBadges',60,"""(()=>{ const had=G.badges; delete G.badges; T.journal(); const t0=T.tabs(), s0=T.sel(), carry=T.text('journalBody');
            document.getElementById('jrTab-record').click(); G.step(1/30,1); const rec=T.text('journalRecord');
            const off=document.querySelectorAll('#journalRecord .jr-dot').length, on=[...document.querySelectorAll('#journalRecord .jr-ms.on:not(.jr-boss)')].map(e=>e.dataset.ms);
            const best=[...document.querySelectorAll('#journalRecord .jr-ms.on .best')].map(e=>e.innerText.replace(/\\s+/g,' '));
            T.shut(); if(had)G.badges=had; return {t0,s0,carry:/hearts/i.test(carry),rec,off,on,best,title:document.getElementById('journalTitle').textContent}; })()""",
            lambda r: r['t0']==['carry','record'] and r['s0']=='carry' and r['carry'] and r['on']==['ashore','staff'] and r['off']==10
                      and 'Washed ashore' in r['rec'] and 'Keeper’s Staff' in r['rec'] and 'Hollow Stag' not in r['rec'] and 'Gloaming' not in r['rec']
                      and 'rank' not in r['rec'].lower() and '6:35' in r['rec'] and 'time played' in r['rec'].lower() and '%' in r['rec'] and 'foes cleared' in r['rec'].lower()
                      and [x.lower() for x in r['best']]==['best 0:48','best 4:12'], fails)

        # with a stand-in G.badges: three tabs, the rank on the Record, the badge grid by category
        await ev(pg,"T.badges()",10)
        r=await run(pg,'tabs',60,"""(()=>{ T.journal(); const t=T.tabs(); document.getElementById('jrTab-record').click(); G.step(1/30,1); const rec=T.text('journalRecord');
            document.getElementById('jrTab-badges').click(); G.step(1/30,1); const bad=T.text('journalBadges');
            const tile=id=>{ const e=document.querySelector(`#journalBadges [data-badge="${id}"]`); return e?{got:e.classList.contains('got'),nm:e.querySelector('.nm').innerText,ds:(e.querySelector('.ds')||{}).innerText||'',dt:(e.querySelector('.dt')||{}).innerText||''}:null; };
            return {t, sel:T.sel(), rank:/Lamplighter/.test(rec)&&/Keeper/.test(rec)&&/5 more badges/.test(rec), title:document.getElementById('journalTitle').textContent,
              count:(document.querySelector('.jr-bcount')||{}).innerText, cats:[...document.querySelectorAll('#journalBadges .eyebrow.sec')].map(e=>e.innerText),
              first:tile('first'), deer:tile('deer'), sober:tile('sober'), who:tile('who'), names:/Antlers Optional|A Stranger|A Choice/.test(bad)}; })()""",
            lambda r: r['t']==['carry','record','badges'] and r['sel']=='badges' and r['rank'] and r['title']=='Badges' and r['count'].startswith('3 of 8')
                      and len(r['cats'])==4 and r['first']['got'] and r['first']['nm']=='First Footing' and r['first']['dt'].lower().startswith('earned')
                      and not r['deer']['got'] and 'Not yet revealed' in r['deer']['nm'] and 'wood' in r['deer']['ds']
                      and r['sober']['nm']=='Clear Head' and 'draught' in r['sober']['ds'] and r['who']['nm']=='???' and not r['names'], fails)
        # a boss beaten: its tries and best time under "Bosses beaten" (only bosses already beaten are listed)
        await run(pg,'bossBeaten',30,"""(()=>{ G.record.debug.reach('stag',812); G.record.debug.set('boss.stag',{tries:3,best:94.2,hurt:4,draughts:1});
            document.getElementById('jrTab-record').click(); G.step(1/30,1); const b=[...document.querySelectorAll('#journalRecord .jr-boss')].map(e=>e.dataset.boss+' '+e.innerText.replace(/\\s+/g,' '));
            return {b, off:document.querySelectorAll('#journalRecord .jr-dot').length}; })()""",
            lambda r: len(r['b'])==1 and r['b'][0].lower().startswith('stag the hollow stag') and '3' in r['b'][0] and '1:34' in r['b'][0] and r['off']==9, fails)
        if 'tabs' not in fails:
            await ev(pg,"(()=>{ document.getElementById('jrTab-record').click(); G.step(1/30,1); return 1; })()",10)
            await shot(pg,'record-desktop',DESK); await shot(pg,'record-phone',PHONE)
            await ev(pg,"(()=>{ document.getElementById('jrTab-badges').click(); G.step(1/30,1); return 1; })()",10)
            await shot(pg,'badges-desktop',DESK); await shot(pg,'badges-phone',PHONE)
            await pg.set_viewport_size(DESK)

        # keyboard: arrows change tabs (from the Back button too); the controller: RB / LB
        await run(pg,'keysAndPad',60,"""(()=>{ const out={}; document.getElementById('journalClose').focus();
            const key=c=>{ document.getElementById('journalClose').dispatchEvent(new KeyboardEvent('keydown',{code:c,key:c,bubbles:true})); return T.sel(); };
            out.right=key('ArrowRight'); out.left=key('ArrowLeft');
            const ps=G.input.padState; let B=[]; const pad=i=>{ B=Array.from({length:17},(_,k)=>({pressed:k===i,value:k===i?1:0})); };
            G.input.padState=()=>({B,A:[0,0,0,0]});
            pad(5); G.step(1/30,1); out.rb=T.sel(); pad(-1); G.step(1/30,1); pad(5); G.step(1/30,1); out.rb2=T.sel(); pad(-1); G.step(1/30,1); pad(4); G.step(1/30,1); out.lb=T.sel(); pad(-1); G.step(1/30,1);
            G.input.padState=ps; T.shut(); out.closed=document.getElementById('journal').hidden; out.mode=G.state.mode; return out; })()""",
            lambda r: r['right']=='carry' and r['left']=='badges' and r['rb']=='carry' and r['rb2']=='record' and r['lb']=='carry' and r['closed'] and r['mode']=='play', fails)

        # the Continue card: rank, time played and completion from the stored save, before the game starts
        made=await ev(pg,"(()=>{ T.play(); const ok=G.flow.writeSave(); const d=JSON.parse(localStorage.getItem('bq-save-v1')); return {ok, play:d.mods.record.play, rec:d.rec}; })()",30)
        print('   saved:',json.dumps(made)[:300])
        ok_made=isinstance(made,dict) and made.get('ok')
        if ok_made:
            await asyncio.wait_for(pg.reload(),timeout=180); await pg.wait_for_timeout(5000); await pg.evaluate(HELP)
        r=await run(pg,'continueCard',30,"""(()=>{ const e=document.getElementById('saveRec'); return {mode:G.state.mode, shown:!!e&&!e.hidden&&e.getClientRects().length>0, text:e?e.innerText:'',
            want:G.record.fmt(JSON.parse(localStorage.getItem('bq-save-v1')).mods.record.play)+' played'}; })()""",
            lambda r: r['mode']=='title' and r['shown'] and r['want'] in r['text'] and 'Lamplighter' in r['text'] and '% complete' in r['text'], fails, skipped=not ok_made)
        if r:
            await shot(pg,'continue-desktop',DESK); await shot(pg,'continue-phone',PHONE); await pg.set_viewport_size(DESK)

        # welcome back: a save last played 13 h ago, Continue clicked for real -> the card, then Enter carries on
        age="h=>{ const d=JSON.parse(localStorage.getItem('bq-save-v1')); d.mods.record.last=Date.now()-h*3600e3; localStorage.setItem('bq-save-v1',JSON.stringify(d)); return true; }"
        await ev(pg,f"({age})(13)",10)
        r=await run(pg,'welcomeShown',60,"""(()=>{ T.badges(); G.progress.welcome.allowInTests=true; document.getElementById('continue').click(); G.step(1/30,4); const w=T.wb();
            const g=document.getElementById('welcomeGo'); return Object.assign(w,{focus:document.activeElement===g, play:G.record.fmt(G.record.play()), obj:document.getElementById('wbObj').textContent}); })()""",
            lambda r: r['shown'] and r['mode']=='paused' and r['focus'] and 'Welcome back' in r['text'] and '13 hours' in r['text'] and r['play'] in r['text']
                      and r['obj'] and r['obj'] in r['text'] and 'Lamplighter' in r['text'] and '3 heart shards' in r['text'] and 'Carry on' in r['text'], fails, skipped=not ok_made)
        if r:
            await shot(pg,'welcome-desktop',DESK); await shot(pg,'welcome-phone',PHONE); await pg.set_viewport_size(DESK)
            await run(pg,'welcomeCarryOn',30,"(()=>{ document.getElementById('welcomeGo').dispatchEvent(new KeyboardEvent('keydown',{code:'Enter',key:'Enter',bubbles:true})); G.step(1/30,2); return T.wb(); })()",
                lambda r: not r['shown'] and r['mode']=='play', fails)

        # not for a recent save, not in a test session unless asked, not with the setting off (begin(true) is Continue's own path)
        cont="(()=>{ G.flow.begin(true); G.step(1/30,4); const w=T.wb(); if(w.shown)G.progress.welcome.close(); T.play(); return w; })()"
        await ev(pg,f"({age})(1)",10)
        await run(pg,'welcomeNotRecent',30,cont,lambda r: not r['shown'] and r['mode']=='play',fails,skipped=not ok_made)
        await ev(pg,f"(()=>{{ G.progress.welcome.allowInTests=false; return ({age})(30); }})()",10)
        await run(pg,'welcomeNotInTests',30,cont,lambda r: not r['shown'] and r['mode']=='play',fails,skipped=not ok_made)
        await ev(pg,f"(()=>{{ G.progress.welcome.allowInTests=true; return ({age})(30); }})()",10)
        await run(pg,'welcomeSettingOff',30,"""(()=>{ T.play(); G.setMode('paused'); document.getElementById('pause').hidden=false; document.querySelector('#welcomeSeg [data-welcome="off"]').click();
            const pressed=document.querySelector('#welcomeSeg [data-welcome="off"]').getAttribute('aria-pressed'), stored=localStorage.getItem('bq-welcome');
            document.getElementById('resume').click(); G.step(1/30,2); const w=""" + cont + """;
            document.querySelector('#welcomeSeg [data-welcome="on"]').click(); return Object.assign(w,{pressed,stored,back:G.progress.welcome.enabled}); })()""",
            lambda r: not r['shown'] and r['mode']=='play' and r['pressed']=='true' and json.loads(r['stored'])=={'show':False} and r['back'] is True, fails, skipped=not ok_made)
        await run(pg,'welcomeOnAgain',30,cont,lambda r: r['shown'],fails,skipped=not ok_made)

        bad=[e for e in errs if 'favicon' not in e]
        print('errors:',bad[:5])
        if bad: fails.append('page-errors')
        await b.close()
    print('RESULT:', 'ALL PASS' if not fails else 'FAILED '+', '.join(fails))
    sys.exit(1 if fails else 0)

asyncio.run(main())
