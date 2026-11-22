"""Staff oils and forage, first slice (Kilnfire): oils.js, forage.js, the alchemy recipe, the sounds, the start points. Spec: OILS.md.
Covers, each check reading its state through G.oils / G.forage / G.alchemy / G.inv:
- forage: nothing is offered before the core loop starts; the gorse bushes (spread out, on walkable ground) are picked by
  walking into them (real stick input) and grow back on their timer; the kiln gives two pitch to a real E press and refills;
- the kiln's note teaches the recipe; brewing takes the ingredients and puts a flask on the belt, which holds 3 and then
  refuses another brew;
- dressing the staff with a real V keypress and with a real held H (past .3 s); a quick H tap still drinks a draught, and with
  no flasks H drinks at once; the coat's timer runs only in play; a new coat replaces the old; the coat runs out;
- a struck hollow burns (its total, no flinch or shove from the ticks, a second blow restarts the burn and never stacks), a real
  staff swing lights one, a vigilant and a neutral / non-monster target never burn;
- save -> reload -> Continue keeps the flasks, the coat and the forage timers; an older save without these keys loads clean;
- the Test tools start points 'oils' and 'oils-fight'.
Each check has its own time budget; a check whose groundwork failed is reported SKIP (and counts as failed).
usage: python3 test/oils_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)
Screenshots go to /tmp/claude-0/oils-tests/."""
import asyncio, sys, json, os, time
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
OUT='/tmp/claude-0/oils-tests'; os.makedirs(OUT,exist_ok=True)
CHROME=dict(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
failed=set(); ok_all=True
def check(name,ok,info):
    global ok_all
    ok_all=ok_all and bool(ok)
    if not ok: failed.add(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name:22s} {json.dumps(info,default=str)[:600]}",flush=True)
def skip(name,why):
    global ok_all
    ok_all=False; failed.add(name); print(f"SKIP {name:22s} {why}",flush=True)

# helpers installed in the page after every load
LIB=r"""
window.T=(()=>{
const P=()=>G.player, O=()=>G.oils, F=()=>G.forage;
const SPOT={x:150,y:42.2,z:-14,yaw:Math.PI*.5};          // the open headland: room to fight, far from every monster zone
const step=s=>G.step(1/30,Math.max(1,Math.round(s*30)));
const ev=[];   // events seen since the last T.flush()
const pick=(n,e)=>{ const o={n}; if(e&&e.n!==undefined)o.num=e.n; if(e)for(const k of ['id','item','reason','damage','recipe','oil','dur','total','count'])if(e[k]!==undefined)o[k]=e[k];
  if(e&&e.target)o.target=e.target; if(e&&e.pos)o.pos=[+e.pos.x.toFixed(1),+e.pos.y.toFixed(1),+e.pos.z.toFixed(1)]; o.t=+G.time.toFixed(2); return o; };
for(const n of ['oils:change','oil:apply','oil:on','oil:off','oil:ignite','oil:burn','forage:pick','forage:note','brew','potion:drink','player:attack','inv:change'])
  G.on(n,e=>ev.push(pick(n,e)));
const said=[], toasts=[];
{ const s=G.ui.say; G.ui.say=function(t,who,...a){ said.push({t:String(t),who:typeof who==='string'?who:(who&&who.who)||null}); return s.call(this,t,who,...a); };
  const ts=G.ui.toast; G.ui.toast=function(a,b){ toasts.push(String(a||'')+' | '+String(b||'')); return ts.apply(this,arguments); }; }
function of(n){ return ev.filter(e=>e.n===n); }
function flush(){ ev.length=0; said.length=0; toasts.length=0; }
function play(){ if(!document.getElementById('pause').hidden)document.getElementById('resume').click(); if(G.talk&&G.talk.isOpen)G.talk.close(); if(G.state.mode!=='play'&&G.state.mode!=='dead')G.setMode('play'); }
function hold(){ const p=P(); if(p.alive!==false)p.hp=p.maxHp; }
function settle(n){ play(); for(let i=0;i<(n||10);i++){ hold(); G.step(1/30,1); } if(G.progress&&G.progress.endReward)G.progress.endReward(); play(); }
function clear(r){ let n=0; for(const m of G.monsters.list.slice())if(m.alive&&!m.dying&&m.pos.distanceTo(P().pos)<(r||40)){ G.monsters.despawn(m); n++; } return n; }
function home(){ play(); clear(60); const p=P(); p.teleport(SPOT.x,null,SPOT.z,SPOT.yaw); if(p.aimCamera)p.aimCamera(SPOT.yaw,.26); hold(); step(.3); clear(60); }
/** a monster of `kind` d m in front of the player (headland), standing still until struck */
function foe(kind,d){ const p=P(), h=p.heading!=null?p.heading:SPOT.yaw; const x=p.pos.x+Math.sin(h)*(d||2.2), z=p.pos.z+Math.cos(h)*(d||2.2);
  const m=G.monsters.spawn(kind,{x,y:p.pos.y,z},{aggro:false}); m.cool=99; return m; }
// the Traveler's own blow (a bolt's source is the bolt itself, as a real one's is)
function hit(m,kind,dmg){ const src=kind==='bolt'?{team:'player',kind:'bolt',test:true}:P();
  return G.combat.strike({x:m.pos.x,y:m.pos.y+1,z:m.pos.z,radius:.7,team:'player',damage:dmg||2,knockback:2,kind:kind||'melee',source:src}).length; }
function burning(m){ const o=O(); try{ return !!(o.burning(m)||(m.hb&&o.burning(m.hb))); }catch(e){ return 'ERR '+e.message; } }
function near(pos,re,r){ const out=[]; for(const o of G.interact.list){ if(o.enabled&&!o.enabled())continue; const q=typeof o.pos==='function'?o.pos():o.pos; if(!q)continue;
  if(Math.hypot(q.x-pos.x,q.z-pos.z)>(r||5))continue; const l=G.interact.label(o); if(!re||re.test(String(l)))out.push({o,l}); } return out; }
function spots(item){ return F().spots.filter(s=>s.item===item); }
/** stand d m from p, facing it */
function face(p,d){ const pl=P(); let best=null;
  for(let k=0;k<8;k++){ const a=k*Math.PI/4, x=p.x+Math.sin(a)*d, z=p.z+Math.cos(a)*d, f=G.floorAt(x,z,p.y+2);
    if(!(Math.abs(f-p.y)<1.2))continue; if(G.world.walkable&&G.world.walkable(x,z)===false)continue; best={x,z}; break; }
  if(!best)best={x:p.x+d,z:p.z};
  const yaw=Math.atan2(p.x-best.x,p.z-best.z); pl.teleport(best.x,null,best.z,yaw); if(pl.aimCamera)pl.aimCamera(yaw,.26); G.step(1/30,2); return yaw; }
/** walk (real stick) toward a spot until something is picked there, at most s seconds */
function walkTo(s,max){ face(s.pos,3.2); const n0=of('forage:pick').length; G.input.setVirtual('forward',true); let k=0;
  for(;k<(max||4)*30;k++){ G.step(1/30,1); if(of('forage:pick').length>n0)break; }
  G.input.setVirtual('forward',false); G.step(1/30,3); return {frames:k,dist:+Math.hypot(P().pos.x-s.pos.x,P().pos.z-s.pos.z).toFixed(2)}; }
function st(){ const o=O(), a=o.active; return {total:o.total(),n:o.count('kilnfire'),full:o.full(),armed:o.armed(),active:a?{id:a.id,left:+(+a.left).toFixed(2)}:null,
  has:o.has('kilnfire'),strength:o.strength('kilnfire'),fixed:o.fixed,mode:G.state.mode}; }
return {P,O,F,SPOT,step,ev,of,flush,said,toasts,play,hold,settle,clear,home,foe,hit,burning,near,spots,face,walkTo,st};
})();
if(G.headless)G.headless.hold=true;   // only G.step moves the game: timings are exact however slow the machine
G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{};
'lib'
"""

async def ev(pg,js,budget=60):
    return await asyncio.wait_for(pg.evaluate(js),budget)

async def run(pg,name,budget,js,test,needs=()):
    """one check with its own time budget; SKIP when a check it depends on failed"""
    bad=[n for n in needs if n in failed]
    if bad: skip(name,'needs '+','.join(bad)); return None
    try: r=await ev(pg,js,budget)
    except asyncio.TimeoutError: check(name,False,{'timeout':budget}); return None
    except Exception as e: check(name,False,{'error':str(e).split('\n')[0][:300]}); return None
    try: ok=test(r)
    except Exception as e: ok=False; r={'r':r,'test_error':str(e)}
    check(name,ok,r); return r

async def boot(b):
    errs=[]
    ctx=await b.new_context(viewport={'width':1000,'height':620})
    pg=await ctx.new_page(); pg.set_default_timeout(240000)
    pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
    pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
    await pg.goto(URL,timeout=180000)
    await pg.evaluate("['bq-save-v1','bq-save-test-v1'].forEach(k=>localStorage.removeItem(k))")
    await pg.reload(timeout=180000)
    await ready(pg)
    return ctx,pg,errs

async def ready(pg):
    await pg.wait_for_function("window.G&&G.flow&&document.getElementById('loading').textContent.startsWith('Ready')",timeout=180000)
    await pg.wait_for_timeout(800)

async def reload_continue(pg):
    await pg.reload(timeout=180000); await ready(pg)
    await ev(pg,LIB)
    await ev(pg,"(()=>{ document.getElementById('continue').click(); G.step(1/30,30); T.settle(10); return 1; })()",120)

async def shot(pg,name):
    try:
        await ev(pg,"G.headless&&G.headless.draw(3); 0"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'{OUT}/{name}.png',timeout=60000)
    except Exception as e: print('   (screenshot',name,'failed:',str(e)[:120],')')

# ------------------------------------------------------------------ the main run: one game, real save slot
async def main_suite(b):
    ctx,pg,errs=await boot(b)
    try: await main_checks(pg)
    finally:
        real=[e for e in errs if '404' not in e]
        check('main: no page errors',not real,real[:6])
        await ctx.close()

async def main_checks(pg):
    await ev(pg,"(()=>{ document.getElementById('begin').click(); G.step(1/30,40); return 1; })()",120)
    await ev(pg,LIB)
    await ev(pg,"(()=>{ if(G._onb)G._onb.S.seen.opening=1; if(G.progress&&G.progress.endReward)G.progress.endReward(); T.play(); G.step(1/30,5); return 1; })()")

    MOD=('modules',)
    await run(pg,'modules',30,"""(()=>{ const O=G.oils, F=G.forage, A=G.alchemy;
        const fn=(o,ks)=>!!o&&ks.every(k=>typeof o[k]==='function');
        return {oils:fn(O,['count','total','full','add','take','list','armed','apply','clear','has','strength','burning','openPicker'])&&!!(O.debug&&O.debug.give&&O.debug.coat&&O.debug.expire),
          max:O&&O.max, kiln:!!(O&&O.OILS&&O.OILS.kilnfire), color:O&&O.OILS&&O.OILS.kilnfire&&O.OILS.kilnfire.color,
          forage:!!(F&&Array.isArray(F.spots)&&F.kiln&&F.kiln.pos&&F.debug&&F.debug.ripen),
          items:!!(G.inv.ITEMS.pitch&&G.inv.ITEMS.gorse), recipe:!!(A.recipes&&A.recipes.kilnfire&&A.recipes.kilnfire.oil==='kilnfire'),
          bind:G.input.BIND.oil, audio:!!(G.audio&&G.audio.oils) }; })()""",
        lambda r:r['oils'] and r['max']==3 and r['kiln'] and r['forage'] and r['items'] and r['recipe'] and r['bind']==['KeyV'] and r['audio'])

    # before the core loop: no pitch to scrape, no gorse to pick
    await run(pg,'dormant-before-loop',60,"""(()=>{ T.flush(); const loop=!!G.loop.active, g0=G.inv.count('gorse'), p0=G.inv.count('pitch');
        const g=T.spots('gorse')[0]; let walk=null; if(g)walk=T.walkTo(g,2.5);
        const k=G.forage.kiln.pos; G.forage.debug.tp('kiln'); G.step(1/30,3); const offers=T.near(k,/pitch|note/i,4).map(x=>x.l);
        return {loop,gorse:G.inv.count('gorse')-g0,pitch:G.inv.count('pitch')-p0,picks:T.of('forage:pick').length,offers,walk,total:G.oils.total(),armed:G.oils.armed()}; })()""",
        lambda r:not r['loop'] and r['gorse']==0 and r['pitch']==0 and r['picks']==0 and not r['offers'] and r['total']==0 and not r['armed'],MOD)

    await run(pg,'loop-start',90,"(()=>{ G.debugStartLoop(); T.settle(30); return {loop:!!G.loop.active,mode:G.state.mode}; })()",
        lambda r:r['loop'] and r['mode']=='play',MOD)
    LOOP=MOD+('loop-start',)

    await run(pg,'gorse-spots',30,"""(()=>{ const s=T.spots('gorse'); let min=1e9, bad=[];
        for(let i=0;i<s.length;i++)for(let j=i+1;j<s.length;j++)min=Math.min(min,Math.hypot(s[i].pos.x-s[j].pos.x,s[i].pos.z-s[j].pos.z));
        for(const q of s){ const f=G.floorAt(q.pos.x,q.pos.z,q.pos.y+3), w=G.world.walkable?G.world.walkable(q.pos.x,q.pos.z):true;
          if(!(Math.abs(f-q.pos.y)<1.2)||w===false||q.pos.y<.3)bad.push({id:q.id,y:+q.pos.y.toFixed(2),f:+(+f).toFixed(2),w}); }
        const ids=new Set(s.map(q=>q.id));
        return {n:s.length,min:+min.toFixed(1),bad,unique:ids.size===s.length,ready:s.every(q=>q.ready),idsAreText:s.every(q=>typeof q.id==='string')}; })()""",
        lambda r:10<=r['n']<=14 and r['min']>=18 and not r['bad'] and r['unique'] and r['ready'] and r['idsAreText'],LOOP)

    await run(pg,'gorse-pick',60,"""(()=>{ T.flush(); const s=T.spots('gorse')[0], g0=G.inv.count('gorse'); const w=T.walkTo(s,4); window.__gorse=s.id;
        const p=T.of('forage:pick')[0]; return {walk:w,got:G.inv.count('gorse')-g0,ev:p,ready:s.ready,left:+(+s.left).toFixed(1)}; })()""",
        lambda r:r['ev'] and r['ev']['item']=='gorse' and 1<=r['got']<=2 and r['ev']['num']==r['got'] and not r['ready'] and 230<=r['left']<=240.5 and r['walk']['dist']<=1.6,LOOP)
    await run(pg,'gorse-regrow',60,"""(()=>{ const s=G.forage.spots.find(q=>q.id===__gorse); const l0=+s.left; T.play(); T.step(2); const l1=+s.left;
        G.setMode('paused'); G.step(1/30,60); const lp=+s.left; T.play();
        T.home(); s.left=.5; T.step(1.2); const ready=s.ready;   /* away from the bush first: standing in it would pick it as it regrows */ T.flush(); const g0=G.inv.count('gorse'); T.walkTo(s,4);
        return {ran:+(l0-l1).toFixed(2),pausedRan:+(l1-lp).toFixed(2),ready,again:G.inv.count('gorse')-g0}; })()""",
        lambda r:1.8<=r['ran']<=2.2 and abs(r['pausedRan'])<.05 and r['ready'] and r['again']>=1,LOOP+('gorse-pick',))

    # the kiln: a real E press scrapes two pitch; the pot is empty until it refills
    await run(pg,'kiln-scrape',60,"""(()=>{ T.flush(); const k=G.forage.kiln.pos; G.forage.debug.tp('kiln'); G.step(1/30,3); const c=G.interact.pick(G.player.pos), lab=c&&G.interact.label(c), p0=G.inv.count('pitch');
        window.__kilnLab=lab; return {lab,p0}; })()""",lambda r:bool(r['lab']) and 'pitch' in r['lab'].lower(),LOOP)
    if 'kiln-scrape' not in failed:
        await shot(pg,'kiln-full')
        await pg.keyboard.press('KeyE')
        await run(pg,'kiln-scrape-gives',60,"""(()=>{ G.step(1/30,4); const s=T.spots('pitch')[0]||null; const p=T.of('forage:pick').find(e=>e.item==='pitch');
            return {ev:p,pitch:G.inv.count('pitch'),spot:s&&{id:s.id,ready:s.ready,left:+(+s.left).toFixed(1)},offer:T.near(G.forage.kiln.pos,/pitch/i,4).map(x=>x.l)}; })()""",
            lambda r:r['ev'] and r['ev']['num']==2 and r['pitch']==2 and r['spot'] and not r['spot']['ready'] and 230<=r['spot']['left']<=240.5,LOOP+('kiln-scrape',))
    else: skip('kiln-scrape-gives','needs kiln-scrape')
    await shot(pg,'kiln')
    await run(pg,'kiln-refill',60,"""(()=>{ const s=T.spots('pitch')[0]; T.home(); s.left=.5; T.step(1.2); const ready=s.ready;   /* away from the bush first: standing in it would pick it as it regrows */ const k=G.forage.kiln.pos; G.forage.debug.tp('kiln'); G.step(1/30,3);
        const c=G.interact.pick(G.player.pos), lab=c&&G.interact.label(c); const p0=G.inv.count('pitch'); if(c&&/pitch/i.test(lab))c.use(); G.step(1/30,3);
        return {ready,lab,got:G.inv.count('pitch')-p0}; })()""",
        lambda r:r['ready'] and r['got']==2,LOOP+('kiln-scrape-gives',))

    await run(pg,'kiln-note',60,"""(()=>{ const K=G.forage.kiln; let used=null;
        if(!K.noteRead){ const n=T.near(K.pos,/note|read/i,5)[0]; if(n){ used=n.l; T.face(K.pos,1.4); n.o.use(); G.step(1/30,4); } }
        const note=T.said.concat([]).find(s=>/charcoal/i.test(s.who||''));
        return {read:K.noteRead,known:G.alchemy.known.has('kilnfire'),used,ev:T.of('forage:note').map(e=>e.id),who:note&&note.who,len:note?note.t.length:0}; })()""",
        lambda r:r['read'] and r['known'] and r['ev'] and r['who'] and r['len']>40,LOOP)
    while_open="(()=>{ for(let i=0;i<10&&G.talk&&G.talk.isOpen;i++){ G.talk.close(); G.step(1/30,1);} T.settle(5); return 1; })()"
    await ev(pg,while_open)

    # brewing: takes the ingredients, puts a flask on the belt; the belt holds three, then the recipe can't start
    await run(pg,'brew',60,"""(()=>{ T.flush(); G.inv.add('pitch',Math.max(0,4-G.inv.count('pitch')),{silent:true}); G.inv.add('gorse',Math.max(0,8-G.inv.count('gorse')),{silent:true});
        const p0=G.inv.count('pitch'), g0=G.inv.count('gorse'), can=G.alchemy.canBrew('kilnfire'), ok=G.alchemy.brew('kilnfire',{instant:true}); G.step(1/30,3);
        const b=T.of('brew')[0]; return {can,ok,pitch:p0-G.inv.count('pitch'),gorse:g0-G.inv.count('gorse'),n:G.oils.count('kilnfire'),ev:b,list:G.oils.list()}; })()""",
        lambda r:r['can'] and r['ok'] and r['pitch']==1 and r['gorse']==2 and r['n']==1 and r['ev'] and r['ev'].get('oil')=='kilnfire' and r['list'][0]['id']=='kilnfire',LOOP+('kiln-note',))
    await run(pg,'belt-full',60,"""(()=>{ for(let i=0;i<2;i++){ G.alchemy.brew('kilnfire',{instant:true}); G.step(1/30,2); }
        const n=G.oils.total(), full=G.oils.full(), p0=G.inv.count('pitch'), g0=G.inv.count('gorse'), can=G.alchemy.canBrew('kilnfire'), ok=G.alchemy.brew('kilnfire',{instant:true}); G.step(1/30,2);
        const added=G.oils.add('kilnfire',1); return {n,full,can,ok,kept:[p0-G.inv.count('pitch'),g0-G.inv.count('gorse')],added,after:G.oils.total()}; })()""",
        lambda r:r['n']==3 and r['full'] and not r['can'] and not r['ok'] and r['kept']==[0,0] and r['added']==0 and r['after']==3,LOOP+('brew',))
    await run(pg,'first-flask-hint',30,"(()=>({toasts:T.toasts.filter(t=>/V\\b/.test(t)&&/hold/i.test(t))}))()",
        lambda r:len(r['toasts'])==1,LOOP+('brew',))
    BELT=LOOP+('belt-full',)

    # dressing the staff: a real V keypress (one kind carried: straight on, no picker); no swinging while dressing
    await ev(pg,"(()=>{ T.home(); T.flush(); return 1; })()",60)
    await pg.keyboard.press('KeyV')
    await run(pg,'apply-v',60,"""(()=>{ G.step(1/30,2); const a=T.of('oil:apply').length, mid=T.st(); G.input.setVirtual('attack',true); G.step(1/30,1); G.input.setVirtual('attack',false);
        G.step(1/30,4); const swung=T.of('player:attack').length; T.step(1.3); const on=T.of('oil:on')[0];
        return {apply:a,mid,swung,on,after:T.st(),picker:!!document.querySelector('.card.oil-picker:not([hidden])')}; })()""",
        lambda r:r['apply']==1 and r['mid']['total']==2 and r['mid']['active'] is None and r['swung']==0 and r['on'] and r['on'].get('id')=='kilnfire'
                 and r['after']['active'] and r['after']['active']['id']=='kilnfire' and 88<=r['after']['active']['left']<=90.01 and r['after']['has'] and r['after']['strength']=='coat',BELT)
    await shot(pg,'coat')
    COAT=BELT+('apply-v',)
    await run(pg,'timer-play-only',60,"""(()=>{ T.play(); const l0=+G.oils.active.left; T.step(2); const l1=+G.oils.active.left; G.setMode('paused'); G.step(1/30,90); const lp=+G.oils.active.left; T.play();
        return {ran:+(l0-l1).toFixed(2),paused:+(l1-lp).toFixed(3)}; })()""",
        lambda r:1.8<=r['ran']<=2.2 and abs(r['paused'])<.01,COAT)

    # a struck hollow burns: 1 a second for 3 s after a 2-damage blow (6 hp -> 1)
    await run(pg,'burn-hollow',90,"""(()=>{ T.home(); T.flush(); const m=T.foe('hollow'); const hp0=m.hp; T.hit(m,'melee',2); const lit=T.burning(m); const ign=T.of('oil:ignite').length;
        for(let i=0;i<120;i++){ T.hold(); G.step(1/30,1); } const ticks=T.of('oil:burn'); const out={hp0,hp:m.hp,alive:m.alive&&!m.dying,lit,ign,ticks:ticks.length,
        dmg:ticks.reduce((a,e)=>a+(e.damage||0),0),after:T.burning(m)}; G.monsters.despawn(m); return out; })()""",
        lambda r:r['hp0']==6 and r['lit'] is True and r['ign']==1 and r['ticks']==3 and r['dmg']==3 and r['hp']==1 and r['alive'] and r['after'] is False,COAT)
    # the ticks only take health: no flinch, no shove
    await run(pg,'burn-no-stun',90,"""(()=>{ T.home(); T.flush(); const m=T.foe('hollow'); m.hp=m.maxHp=40; T.hit(m,'melee',2); let stun=0, shove=0, ticks=0;
        for(let i=0;i<120;i++){ T.hold(); const s0=m.state, k0=Math.hypot(m.kv.x,m.kv.z), n0=T.of('oil:burn').length; G.step(1/30,1);
          if(T.of('oil:burn').length>n0){ ticks++; if(s0!=='hurt'&&m.state==='hurt')stun++; if(Math.hypot(m.kv.x,m.kv.z)>k0+.05)shove++; } }
        const out={ticks,stun,shove,hp:m.hp}; G.monsters.despawn(m); return out; })()""",
        lambda r:r['ticks']==3 and r['stun']==0 and r['shove']==0 and r['hp']==35,COAT)
    # a second blow restarts the burn (3 s from the new blow), never two burns at once
    await run(pg,'burn-restart',90,"""(()=>{ T.home(); T.flush(); const m=T.foe('hollow'); m.hp=m.maxHp=40; T.hit(m,'melee',2); const t0=G.time;
        for(let i=0;i<45;i++){ T.hold(); G.step(1/30,1); } const t1=G.time; T.hit(m,'melee',2);
        for(let i=0;i<120;i++){ T.hold(); G.step(1/30,1); } const ts=T.of('oil:burn').map(e=>e.t); let gap=99; for(let i=1;i<ts.length;i++)gap=Math.min(gap,ts[i]-ts[i-1]);
        const out={before:ts.filter(t=>t<=t1+1e-3).length,after:ts.filter(t=>t>t1+1e-3).length,last:ts.length?+(ts[ts.length-1]-t1).toFixed(2):null,gap:+gap.toFixed(2),hp:m.hp,ign:T.of('oil:ignite').length};
        G.monsters.despawn(m); return out; })()""",
        lambda r:r['before']==1 and r['after']==3 and 2.7<=r['last']<=3.3 and r['gap']>=.6 and r['hp']==40-4-4,COAT)
    await run(pg,'burn-kinds',90,"""(()=>{ T.home(); const out={}; for(const k of ['bolt','shockwave','swarm']){ T.flush(); const m=T.foe('hollow'); m.hp=m.maxHp=40; T.hit(m,k,1);
          out[k]=T.burning(m); G.monsters.despawn(m); G.step(1/30,2); } return out; })()""",
        lambda r:r['bolt'] is True and r['shockwave'] is True and r['swarm'] is False,COAT)
    # a real swing of the staff (J) lights a hollow in front
    await ev(pg,"(()=>{ T.home(); T.flush(); window.__sw=T.foe('hollow',1.4); window.__sw.hp=window.__sw.maxHp=40; G.step(1/30,1); return 1; })()")
    await pg.keyboard.press('KeyJ')
    await run(pg,'swing-ignites',60,"""(()=>{ for(let i=0;i<20;i++){ T.hold(); G.step(1/30,1); } const m=__sw; const out={atk:T.of('player:attack').length,hp:m.hp,lit:T.burning(m),ign:T.of('oil:ignite').length};
        G.monsters.despawn(m); return out; })()""",
        lambda r:r['atk']>=1 and r['hp']<40 and r['lit'] is True and r['ign']==1,COAT)
    await run(pg,'vigilant-immune',90,"""(()=>{ T.home(); T.flush(); let m; try{ m=T.foe('vigilant'); }catch(e){ return {err:String(e)}; } let burnHits=0; const h0=m.hb.hit; m.hb.hit=i=>{ if(i&&i.kind==='burn')burnHits++; return h0(i); };
        const hits=T.hit(m,'melee',2); const lit=T.burning(m); for(let i=0;i<110;i++){ T.hold(); G.step(1/30,1); }
        const out={kind:m.kind,hits,lit,burnHits,ign:T.of('oil:ignite').length,ticks:T.of('oil:burn').length}; G.monsters.despawn(m); return out; })()""",
        lambda r:r.get('kind')=='vigilant' and r['hits']>=1 and r['lit'] is False and r['burnHits']==0 and r['ign']==0 and r['ticks']==0,COAT)
    await run(pg,'npc-immune',60,"""(()=>{ T.home(); T.flush(); const p=G.player.pos, out={};
        for(const team of ['neutral','enemy']){ let burn=0, any=0; const hb={team,pos:new THREE.Vector3(p.x+2,p.y,p.z),radius:.5,height:1.7,alive:()=>true,name:'test '+team,
            hit:i=>{ any++; if(i&&i.kind==='burn')burn++; }};
          G.combat.add(hb); G.combat.strike({x:hb.pos.x,y:hb.pos.y+1,z:hb.pos.z,radius:.5,team:'player',damage:1,kind:'melee',hitNeutral:true});
          const lit=(()=>{ try{ return !!G.oils.burning(hb); }catch(e){ return 'ERR'; } })(); for(let i=0;i<110;i++)G.step(1/30,1); G.combat.remove(hb); out[team]={any,burn,lit}; }
        out.ign=T.of('oil:ignite').length; return out; })()""",
        lambda r:r['neutral']['any']==1 and r['enemy']['any']==1 and r['neutral']['burn']==0 and r['enemy']['burn']==0 and r['neutral']['lit'] is False and r['enemy']['lit'] is False and r['ign']==0,COAT)

    await run(pg,'replace-coat',60,"""(()=>{ T.home(); T.flush(); const l0=+G.oils.active.left, n0=G.oils.total(); const ok=G.oils.apply('kilnfire'); T.step(1.4);
        return {l0:+l0.toFixed(1),ok,spent:n0-G.oils.total(),on:T.of('oil:on').length,st:T.st()}; })()""",
        lambda r:r['ok'] and r['spent']==1 and r['on']==1 and r['l0']<87 and r['st']['active']['id']=='kilnfire' and r['st']['active']['left']>=88.5,COAT)

    # the draught key: held past .3 s it dresses the staff (real keyboard, game clock held)
    await ev(pg,"(()=>{ T.home(); T.flush(); if(!G.oils.total())G.oils.debug.give('kilnfire',1); G.step(1/30,2); window.__n0=G.oils.total(); return 1; })()")
    await pg.keyboard.down('KeyH')
    await ev(pg,"(()=>{ G.step(1/30,13); return 1; })()")
    await pg.keyboard.up('KeyH')
    await run(pg,'hold-h-dresses',60,"""(()=>{ G.step(1/30,3); const a=T.of('oil:apply').length, d=T.of('potion:drink').length; T.step(1.4); return {apply:a,drink:d,spent:__n0-G.oils.total(),on:T.of('oil:on').length}; })()""",
        lambda r:r['apply']==1 and r['drink']==0 and r['spent']==1 and r['on']==1,COAT)
    # a quick tap while armed is still the drink, sent on release
    await ev(pg,"(()=>{ T.flush(); G.oils.debug.give('kilnfire',1); if(G.potions.count<1)G.potions.add(1,{silent:true}); G.player.hp=G.player.maxHp-4; G.step(1/30,2); window.__n0=G.oils.total(); return 1; })()")
    await pg.keyboard.down('KeyH')
    await ev(pg,"(()=>{ G.step(1/30,3); window.__early=T.of('potion:drink').length; return 1; })()")
    await pg.keyboard.up('KeyH')
    await run(pg,'tap-h-drinks',60,"""(()=>{ G.step(1/30,3); const out={armed:__n0>0,early:__early,drink:T.of('potion:drink').length,apply:T.of('oil:apply').length,flasks:G.oils.total()-__n0};
        T.step(3); return out; })()""",
        lambda r:r['armed'] and r['early']==0 and r['drink']==1 and r['apply']==0 and r['flasks']==0,COAT)
    # with no flasks the draught acts on the press, as it always has
    await ev(pg,"(()=>{ T.flush(); G.oils.take('kilnfire',G.oils.count('kilnfire')); if(G.potions.count<1)G.potions.add(1,{silent:true}); G.player.hp=G.player.maxHp-4; G.step(1/30,2); return 1; })()")
    await pg.keyboard.down('KeyH')
    await run(pg,'no-flasks-h-drinks',60,"(()=>{ G.step(1/30,1); return {armed:G.oils.armed(),drink:T.of('potion:drink').length,apply:T.of('oil:apply').length}; })()",
        lambda r:not r['armed'] and r['drink']==1 and r['apply']==0,COAT)
    await pg.keyboard.up('KeyH')
    await ev(pg,"(()=>{ T.step(3); T.hold(); return 1; })()")

    await run(pg,'coat-runs-out',60,"""(()=>{ T.home(); G.oils.debug.coat('kilnfire',1); G.step(1/30,2); T.flush(); const on=T.st(); T.step(1.5); const off=T.of('oil:off');
        const m=T.foe('hollow'); m.hp=m.maxHp=40; T.hit(m,'melee',2); const lit=T.burning(m); G.monsters.despawn(m);
        return {on:on.active,after:T.st(),off,lit}; })()""",
        lambda r:r['on'] and r['after']['active'] is None and not r['after']['has'] and r['after']['strength'] in (0,None,False) and len(r['off'])==1 and r['off'][0].get('id')=='kilnfire' and r['lit'] is False,COAT)

    # save -> reload -> Continue: the flasks, the coat (with its time left) and the forage timers come back
    saved=await run(pg,'save',60,"""(()=>{ T.home(); G.oils.debug.give('kilnfire',2); G.oils.debug.coat('kilnfire',50); G.step(1/30,2);
        const g=T.spots('gorse')[1]; if(g.ready)G.forage.debug.pick(g.id); G.step(1/30,2); const k=T.spots('pitch')[0];
        const ok=G.flow.writeSave(); const d=JSON.parse(localStorage.getItem('bq-save-v1'));
        return {ok,n:G.oils.total(),left:+G.oils.active.left,gid:g.id,gleft:+g.left,kid:k.id,kready:k.ready,kleft:+k.left,keys:Object.keys(d.mods).filter(k=>k==='oils'||k==='forage'),
          oils:d.mods.oils}; })()""",
        lambda r:r['ok'] and r['n']==2 and sorted(r['keys'])==['forage','oils'] and r['oils'] and r['oils'].get('v')==1,COAT)
    if saved and 'save' not in failed:
        try: await asyncio.wait_for(reload_continue(pg),300)
        except Exception as e: check('reload',False,{'error':str(e)[:200]})
        S=json.dumps(saved)
        await run(pg,'reload-keeps',60,f"""(()=>{{ const s={S}; const g=G.forage.spots.find(q=>q.id===s.gid), k=G.forage.spots.find(q=>q.id===s.kid);
            return {{mode:G.state.mode,loop:!!G.loop.active,st:T.st(),dl:G.oils.active?+(s.left-G.oils.active.left).toFixed(2):null,g:g&&{{ready:g.ready,d:+(s.gleft-g.left).toFixed(2)}},
              k:k&&{{ready:k.ready,d:+(s.kleft-k.left).toFixed(2)}},kready0:s.kready,note:G.forage.kiln.noteRead,known:G.alchemy.known.has('kilnfire')}}; }})()""",
            lambda r:r['mode']=='play' and r['loop'] and r['st']['total']==2 and r['st']['active'] and r['st']['active']['id']=='kilnfire' and -0.01<=r['dl']<=2
                     and r['g'] and not r['g']['ready'] and -0.01<=r['g']['d']<=3 and r['k'] and r['k']['ready']==r['kready0'] and (r['kready0'] or -0.01<=r['k']['d']<=3)
                     and r['note'] and r['known'],COAT+('save',))
        # an older save, written before oils and forage existed: loads with nothing carried and every bush ready
        made=await ev(pg,"""(()=>{ T.play(); G.flow.writeSave(); G.setMode('paused'); const d=JSON.parse(localStorage.getItem('bq-save-v1')); delete d.mods.oils; delete d.mods.forage;
            localStorage.setItem('bq-save-v1',JSON.stringify(d)); return true; })()""")
        if made is True:
            try: await asyncio.wait_for(reload_continue(pg),300)
            except Exception as e: check('reload-old',False,{'error':str(e)[:200]})
            await run(pg,'old-save-loads',60,"""(()=>({mode:G.state.mode,loop:!!G.loop.active,st:T.st(),ready:G.forage.spots.every(q=>q.ready),note:G.forage.kiln.noteRead}))()""",
                lambda r:r['mode']=='play' and r['loop'] and r['st']['total']==0 and r['st']['active'] is None and r['st']['fixed'] in (None,False) and r['ready'] and not r['note'],COAT+('save',))
        else: skip('old-save-loads','could not write the old save')
    else:
        skip('reload-keeps','needs save'); skip('old-save-loads','needs save')

# ------------------------------------------------------------------ the picker and the draught button with a controller and on touch
PAD_JS=r"""
window.__pad={id:'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',index:0,connected:true,mapping:'standard',timestamp:0,axes:[0,0,0,0],
  buttons:Array.from({length:17},()=>({pressed:false,touched:false,value:0}))};
window.__btn=(i,on)=>{ __pad.buttons[i]={pressed:!!on,touched:!!on,value:on?1:0}; __pad.timestamp++; };
navigator.getGamepads=()=>[__pad,null,null,null];
"""
# two kinds on the belt (a Kilnfire and a Burst flask), so the long hold opens the picker
TWO_KINDS="(()=>{ G.oils.take('kilnfire',G.oils.count('kilnfire')); G.oils.debug.give('kilnfire',1); G.oils.debug.give('burst',1); T.flush(); G.step(1/30,2); return G.oils.list().map(o=>o.id); })()"
PICKER="(()=>{ const pk=document.getElementById('oilPicker'); return {open:!!(pk&&!pk.hidden),mode:G.state.mode,opts:pk?[...pk.querySelectorAll('.opt')].map(b=>b.dataset.oil):[],focus:document.activeElement&&document.activeElement.dataset?document.activeElement.dataset.oil||document.activeElement.id:null}; })()"

async def pad_suite(b):
    errs=[]
    ctx=await b.new_context(viewport={'width':1000,'height':620}); await ctx.add_init_script(PAD_JS)
    pg=await ctx.new_page(); pg.set_default_timeout(240000)
    pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
    pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
    try:
        await pg.goto(URL,timeout=180000); await ready(pg); await ev(pg,LIB)
        await run(pg,'pad:start',120,"(()=>{ G.devtools.start('oils-fight'); G.step(1/30,30); T.settle(10); T.home(); return {n:G.oils.total(),pad:G.input.gamepad.connected}; })()",
            lambda r:r['n']==3 and r['pad'])
        N=('pad:start',)
        # D-pad up held: the staff is dressed straight away with one kind (and nothing is drunk); mid-dress screenshot
        await run(pg,'pad:hold-dresses',60,"""(()=>{ T.flush(); G.player.hp=G.player.maxHp-4; __btn(12,true); G.step(1/30,12); __btn(12,false); G.step(1/30,12);
            const out={apply:T.of('oil:apply').map(e=>e.id),drink:T.of('potion:drink').length,pose:G.player.state}; return out; })()""",
            lambda r:r['apply']==['kilnfire'] and r['drink']==0,N)
        await shot(pg,'dressing-pose')
        await ev(pg,"(()=>{ T.step(1.5); return 1; })()")
        await ev(pg,TWO_KINDS)
        await run(pg,'pad:picker-opens',60,"(()=>{ __btn(12,true); G.step(1/30,12); const r="+PICKER+"; __btn(12,false); G.step(1/30,4); return Object.assign(r,{after:"+PICKER+"}); })()",
            lambda r:r['open'] and r['mode']=='paused' and r['opts']==['kilnfire','burst'] and r['after']['open'] and r['after']['focus']=='kilnfire',N+('pad:hold-dresses',))
        await shot(pg,'picker-pad')
        await run(pg,'pad:picker-choose',60,"""(()=>{ __btn(13,true); G.step(1/30,2); __btn(13,false); G.step(1/30,3); const f=document.activeElement&&document.activeElement.dataset.oil;
            __btn(0,true); G.step(1/30,2); __btn(0,false); G.step(1/30,2); const p="""+PICKER+"""; T.step(1.4);
            return {f,closed:!p.open,mode:G.state.mode,apply:T.of('oil:apply').map(e=>e.id),active:G.oils.active&&G.oils.active.id,drink:T.of('potion:drink').length,left:G.oils.list().map(o=>o.id)}; })()""",
            lambda r:r['f']=='burst' and r['closed'] and r['mode']=='play' and r['apply']==['burst'] and r['active']=='burst' and r['drink']==0 and r['left']==['kilnfire'],N+('pad:picker-opens',))
        await run(pg,'pad:picker-back',60,"""(()=>{ G.oils.debug.give('burst',1); T.flush(); __btn(12,true); G.step(1/30,12); __btn(12,false); G.step(1/30,3); const o="""+PICKER+""";
            __btn(1,true); G.step(1/30,2); __btn(1,false); G.step(1/30,3); return {opened:o.open,after:"""+PICKER+""",apply:T.of('oil:apply').length,n:G.oils.total()}; })()""",
            lambda r:r['opened'] and not r['after']['open'] and r['after']['mode']=='play' and r['apply']==0 and r['n']==2,N+('pad:picker-opens',))
    finally:
        real=[e for e in errs if '404' not in e]
        check('pad: no page errors',not real,real[:6])
        await ctx.close()

TOUCH_JS=r"""
window.TB=()=>document.querySelector('#touch button[data-act=potion]');
window.TP=t=>TB().dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerType:'touch',pointerId:9,isPrimary:true}));
'ok'"""
async def touch_suite(b):
    errs=[]
    ctx=await b.new_context(viewport={'width':844,'height':390},is_mobile=True,has_touch=True,device_scale_factor=2)
    pg=await ctx.new_page(); pg.set_default_timeout(240000)
    pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
    pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
    try:
        await pg.goto(URL,timeout=180000); await ready(pg); await ev(pg,LIB); await ev(pg,TOUCH_JS)
        await run(pg,'touch:start',120,"(()=>{ G.devtools.start('oils-fight'); G.step(1/30,30); T.settle(10); T.home(); const b=TB(); return {n:G.oils.total(),btn:!!(b&&!b.hidden&&b.getClientRects().length),device:G.input.device}; })()",
            lambda r:r['n']==3 and r['btn'])
        N=('touch:start',)
        # a tap on the bottle still drinks while a flask is carried; a long press dresses the staff
        await run(pg,'touch:tap-drinks',60,"""(()=>{ T.flush(); G.player.hp=G.player.maxHp-4; if(G.potions.count<1)G.potions.add(1,{silent:true}); TP('pointerdown'); G.step(1/30,3); const early=T.of('potion:drink').length;
            TP('pointerup'); G.step(1/30,3); const out={early,drink:T.of('potion:drink').length,apply:T.of('oil:apply').length,n:G.oils.total()}; T.step(3); return out; })()""",
            lambda r:r['early']==0 and r['drink']==1 and r['apply']==0 and r['n']==3,N)
        await run(pg,'touch:long-press-dresses',60,"""(()=>{ T.flush(); G.player.hp=G.player.maxHp-4; TP('pointerdown'); G.step(1/30,12); TP('pointerup'); G.step(1/30,3); const a=T.of('oil:apply').map(e=>e.id), d=T.of('potion:drink').length;
            T.step(1.5); return {apply:a,drink:d,active:G.oils.active&&G.oils.active.id,n:G.oils.total()}; })()""",
            lambda r:r['apply']==['kilnfire'] and r['drink']==0 and r['active']=='kilnfire' and r['n']==2,N)
        await ev(pg,TWO_KINDS)
        await run(pg,'touch:picker-opens',60,"(()=>{ TP('pointerdown'); G.step(1/30,12); TP('pointerup'); G.step(1/30,3); return "+PICKER+"; })()",
            lambda r:r['open'] and r['mode']=='paused' and r['opts']==['kilnfire','burst'],N+('touch:long-press-dresses',))
        await shot(pg,'picker-touch')
        if 'touch:picker-opens' not in failed:
            try: await pg.tap('#oilPicker .opt[data-oil=burst]',timeout=30000); ok=True
            except Exception as e: check('touch:picker-tap',False,{'error':str(e)[:200]}); ok=False
            if ok:
                await run(pg,'touch:picker-tap',60,"(()=>{ const p="+PICKER+"; T.step(1.4); return {closed:!p.open,mode:G.state.mode,apply:T.of('oil:apply').map(e=>e.id),active:G.oils.active&&G.oils.active.id,drink:T.of('potion:drink').length}; })()",
                    lambda r:r['closed'] and r['mode']=='play' and r['apply']==['burst'] and r['active']=='burst' and r['drink']==0,N)
        else: skip('touch:picker-tap','needs touch:picker-opens')
    finally:
        real=[e for e in errs if '404' not in e]
        check('touch: no page errors',not real,real[:6])
        await ctx.close()

# ------------------------------------------------------------------ the Test tools start points (each on a fresh page)
async def start_suite(b,sid,js,test):
    ctx,pg,errs=await boot(b)
    try:
        await ev(pg,LIB)
        await run(pg,'start:'+sid,120,"(()=>{ G.devtools.start('"+sid+"'); G.step(1/30,30); T.settle(10); return "+js+"; })()",test)
        await shot(pg,'start-'+sid)
    finally:
        real=[e for e in errs if '404' not in e]
        check('start:'+sid+' no page errors',not real,real[:6])
        await ctx.close()

START_OILS="""(()=>{ const t=G.alchemy.table, p=G.player.pos, c=G.interact.pick(p); return {mode:G.state.mode,loop:!!G.loop.active,test:!!G.testSaves,
    known:G.alchemy.known.has('kilnfire'),pitch:G.inv.count('pitch'),gorse:G.inv.count('gorse'),can:G.alchemy.canBrew('kilnfire'),
    d:t?+Math.hypot(t.world.x-p.x,t.world.z-p.z).toFixed(2):null,lab:c&&G.interact.label(c),flasks:G.oils.total()}; })()"""
START_FIGHT="""(()=>{ const p=G.player.pos; const near=G.monsters.list.filter(m=>m.alive&&!m.dying&&m.kind==='hollow'&&m.pos.distanceTo(p)<30).length;
    return {mode:G.state.mode,loop:!!G.loop.active,test:!!G.testSaves,n:G.oils.count('kilnfire'),armed:G.oils.armed(),hollows:near,known:G.alchemy.known.has('kilnfire')}; })()"""

async def main():
    t0=time.time()
    only=os.environ.get('ONLY')   # e.g. ONLY=pad,touch runs just those parts (main, pad, touch, starts)
    want=lambda k:not only or k in only.split(',')
    async with async_playwright() as p:
        b=await p.chromium.launch(**CHROME)
        parts=[('main',lambda:main_suite(b),1500),('pad',lambda:pad_suite(b),500),('touch',lambda:touch_suite(b),500),
          ('starts',lambda:start_suite(b,'oils',START_OILS,
              lambda r:r['mode']=='play' and r['loop'] and r['test'] and r['known'] and r['pitch']>=1 and r['gorse']>=2 and r['can'] and r['d'] is not None and r['d']<2.8 and r['lab']=='Work the alchemy table'),400),
          ('starts',lambda:start_suite(b,'oils-fight',START_FIGHT,
              lambda r:r['mode']=='play' and r['loop'] and r['test'] and r['n']==3 and r['armed'] and r['hollows']>=1 and r['known']),400)]
        for k,fn,budget in parts:
            if not want(k): continue
            try: await asyncio.wait_for(fn(),budget)
            except asyncio.TimeoutError: check(k+'-suite',False,{'timeout':budget})
            except Exception as e: check(k+'-suite',False,{'error':str(e)[:300]})
        await b.close()
    print('RESULT', 'PASS' if ok_all else 'FAIL '+', '.join(sorted(failed)), f'{time.time()-t0:.0f}s', flush=True)
    sys.exit(0 if ok_all else 1)

asyncio.run(main())
