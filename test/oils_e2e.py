"""Staff oils and forage, slices 1 and 2 (Kilnfire, Burst Oil, Holly Ward): oils.js, forage.js, the alchemy recipes, the sounds, the start points. Spec: OILS.md.
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
- slice 2: the holly bushes (spread out, far west, picked by walking in, regrowing, nothing before the loop); the cave bench's page
  (a real E press, only inside the cave, saved); Wren's holly choice at the well (only once she is home, a real E press, gone after);
  brewing both new oils; the picker with two and three kinds (real V, Escape, 3); Holly Ward slowing a hollow and wearing off, never
  the stag; one coat swapping for another; Burst Oil with a real charged bolt (strike held, let go), a full charge, no coat, what the
  bolt struck spared, the moth swarm untouched; the Gloaming burning only while solid and the Wreck Giant never, through a real
  strike; a reload with each new coat on;
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
for(const n of ['oils:change','oil:apply','oil:on','oil:off','oil:ignite','oil:burn','oil:burst','oil:slow','forage:pick','forage:note','brew','potion:drink','player:attack','inv:change','wren:holly','recipe:learned','projectile:end'])
  G.on(n,e=>{ const o=pick(n,e); if(e&&e.radius!=null)o.radius=e.radius; if(e&&e.great!=null)o.great=!!e.great; if(e&&Array.isArray(e.hits))o.hits=e.hits.length;
    if(n==='projectile:end'&&e&&e.p){ o.team=e.p.team; o.kind=e.p.kind; o.great=!!e.p.great; o.pos=[+e.p.pos.x.toFixed(1),+e.p.pos.y.toFixed(1),+e.p.pos.z.toFixed(1)]; }
    ev.push(o); });
// monsters held where they were put (after the monsters' own update), for checks that need fixed distances
const frozen=new Map(); G.system('testFreeze',{order:99,modes:['play','paused','dead'],update(){ for(const [m,p] of frozen){ if(!m.alive||m.dying){ frozen.delete(m); continue; } m.pos.x=p.x; m.pos.z=p.z; m.kv&&m.kv.set(0,0,0); } }});
function freeze(m){ frozen.set(m,{x:m.pos.x,z:m.pos.z}); return m; }
/** every hit() a monster's hurtbox takes: [{kind,damage}] */
function logHits(m){ const L=[], h0=m.hb.hit; m.hb.hit=i=>{ L.push({kind:i&&i.kind,damage:i&&i.damage}); return h0(i); }; m.hits=L; return m; }
/** a monster of kind at (forward f, right r) metres from the player, standing idle */
function at(kind,f,r,o){ const p=P(), h=p.heading!=null?p.heading:SPOT.yaw, x=p.pos.x+Math.sin(h)*f+Math.cos(h)*r, z=p.pos.z+Math.cos(h)*f-Math.sin(h)*r;
  const m=G.monsters.spawn(kind,{x,y:G.floorAt(x,z,p.pos.y+4),z},Object.assign({aggro:false},o||{})); m.cool=99; return m; }
/** the burst rig: the bolt's mark 8 m ahead, one foe 1.5 m to its side, one 3.6 m to the other (inside a full charge's reach only), one 6 m off; all held still, 40 hp */
function rig(){ home(); const r={mark:at('hollow',8,0),near:at('hollow',8,1.5),mid:at('hollow',8,-3.6),far:at('hollow',8,6)};
  for(const k in r){ const m=r[k]; m.hp=m.maxHp=40; freeze(logHits(m)); } G.step(1/30,2); return r; }
function unrig(r){ for(const k in r){ frozen.delete(r[k]); if(r[k].alive)G.monsters.despawn(r[k]); } G.step(1/30,2); }
function dmg(m,kind){ return m.hits.filter(h=>!kind||h.kind===kind).reduce((a,h)=>a+(h.damage||0),0); }
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
function card(pick){ const out=[]; for(let i=0;i<80&&G.talk.isOpen;i++){ const s=G.talk.state(); if(s.line&&out[out.length-1]!==s.line)out.push(s.line);
    if(s.choices.length){ const k=pick(s.choices); out.push({choices:s.choices.slice(),took:s.choices[k]}); G.talk.choose(k); } else G.talk.advance(); G.step(1/30,2); } return out; }
return {P,O,F,SPOT,step,ev,of,flush,said,toasts,play,hold,settle,clear,home,foe,hit,burning,near,spots,face,walkTo,st,freeze,frozen,logHits,at,rig,unrig,dmg,card};
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
        const h0=G.inv.count('holly'), hs=T.spots('holly')[0]; let walkH=null; if(hs)walkH=T.walkTo(hs,2.5); const hm=G.forage.debug.mesh.holly;
        const k=G.forage.kiln.pos; G.forage.debug.tp('kiln'); G.step(1/30,3); const offers=T.near(k,/pitch|note/i,4).map(x=>x.l);
        const pg=G.forage.debug.page; G.forage.debug.readPage(); G.step(1/30,2);
        return {loop,gorse:G.inv.count('gorse')-g0,pitch:G.inv.count('pitch')-p0,holly:G.inv.count('holly')-h0,hollySpot:!!hs,hollyShown:!!(hm&&hm.visible),picks:T.of('forage:pick').length,offers,walk,walkH,
          total:G.oils.total(),armed:G.oils.armed(),burst:G.alchemy.known.has('burst'),notes:T.of('forage:note').length}; })()""",
        lambda r:not r['loop'] and r['gorse']==0 and r['pitch']==0 and r['holly']==0 and r['hollySpot'] and not r['hollyShown'] and r['picks']==0 and not r['offers']
                 and r['total']==0 and not r['armed'] and not r['burst'] and r['notes']==0,MOD)

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

    await slice2_checks(pg,COAT)

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
        await run(pg,'reload-keeps-slice2',60,"""(()=>{ const n=G.forage.debug.state().notes; return {page:!!n.cavePage,burst:G.alchemy.known.has('burst'),holly:G.alchemy.known.has('holly'),
            wren:!!G.undercroftPeople.state.wren.holly,hollyDown:G.forage.spots.filter(q=>q.item==='holly'&&!q.ready).length}; })()""",
            lambda r:r['page'] and r['burst'] and r['holly'] and r['wren'] and r['hollyDown']>=1,COAT+('save','cave-page','wren-holly','holly-pick'))
        # a reload with each of the new coats on: it comes back with its time left, and works
        for oid,chk in (('burst',"(()=>{ const r=T.rig(); const p={team:'player',kind:'bolt',pos:r.mark.pos.clone().setY(r.mark.pos.y+1),exclude:new Set([r.mark.hb]),great:false};"
                                  " G.emit('projectile:end',{p,hits:[r.mark.hb]}); G.step(1/30,2); const out={near:T.dmg(r.near,'blast')}; T.unrig(r); return out; })()"),
                        ('holly',"(()=>{ T.home(); const m=T.foe('hollow'); m.hp=m.maxHp=40; T.hit(m,'melee',2); const out={slowed:G.oils.slowed(m)}; G.monsters.despawn(m); return out; })()")):
            made=await ev(pg,f"(()=>{{ T.home(); G.oils.debug.coat('{oid}',40); G.step(1/30,2); return G.flow.writeSave(); }})()")
            if not made: check(f'reload-coat:{oid}',False,{'save':made}); continue
            try: await asyncio.wait_for(reload_continue(pg),300)
            except Exception as e: check(f'reload-coat:{oid}',False,{'error':str(e)[:200]}); continue
            await run(pg,f'reload-coat:{oid}',60,f"(()=>({{st:T.st(),has:G.oils.has('{oid}'),strength:G.oils.strength('{oid}'),works:{chk}}}))()",
                lambda r,oid=oid:r['st']['active'] and r['st']['active']['id']==oid and 37<=r['st']['active']['left']<=40.01 and r['has'] and r['strength']=='coat'
                     and (r['works']['near']==3 if oid=='burst' else r['works']['slowed'] is True),COAT+('save',))
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

# ------------------------------------------------------------------ the second slice: Burst Oil, Holly Ward, the holly, the cave page, Wren
async def slice2_checks(pg,COAT):
    LOOP=('modules','loop-start')
    # holly berries on the deep wood's holly: spread out, on walkable ground, more of them far west; picked by walking in; regrow
    await run(pg,'holly-spots',30,"""(()=>{ const s=T.spots('holly'); let min=1e9, bad=[];
        for(let i=0;i<s.length;i++)for(let j=i+1;j<s.length;j++)min=Math.min(min,Math.hypot(s[i].pos.x-s[j].pos.x,s[i].pos.z-s[j].pos.z));
        for(const q of s){ const f=G.floorAt(q.pos.x,q.pos.z,q.pos.y+3), w=G.world.walkable?G.world.walkable(q.pos.x,q.pos.z):true;
          if(!(Math.abs(f-q.pos.y)<1.2)||w===false)bad.push({id:q.id,y:+q.pos.y.toFixed(2),f:+(+f).toFixed(2),w}); }
        const west=s.filter(q=>q.pos.x<-150).length, wood=s.every(q=>q.pos.x<-76), ids=new Set(s.map(q=>q.id)), hm=G.forage.debug.mesh.holly;
        return {n:s.length,min:+min.toFixed(1),bad,west,wood,unique:ids.size===s.length,ready:s.every(q=>q.ready),idsAreText:s.every(q=>typeof q.id==='string'),shown:!!(hm&&hm.visible),
          inv:!!G.inv.ITEMS.holly}; })()""",
        lambda r:8<=r['n']<=12 and r['min']>=14 and not r['bad'] and r['wood'] and r['west']*2>r['n'] and r['unique'] and r['ready'] and r['idsAreText'] and r['shown'] and r['inv'],LOOP)
    await run(pg,'holly-pick',60,"""(()=>{ T.flush(); const s=T.spots('holly')[0], h0=G.inv.count('holly'); const w=T.walkTo(s,4); window.__holly=s.id;
        const p=T.of('forage:pick')[0]; return {walk:w,got:G.inv.count('holly')-h0,ev:p,ready:s.ready,left:+(+s.left).toFixed(1)}; })()""",
        lambda r:r['ev'] and r['ev']['item']=='holly' and 1<=r['got']<=2 and r['ev']['num']==r['got'] and not r['ready'] and 230<=r['left']<=240.5 and r['walk']['dist']<=1.6,LOOP+('holly-spots',))
    await run(pg,'holly-regrow',60,"""(()=>{ const s=G.forage.spots.find(q=>q.id===__holly); const l0=+s.left; T.play(); T.step(2); const l1=+s.left;
        T.home(); s.left=.5; T.step(1.2); const ready=s.ready; T.flush(); const h0=G.inv.count('holly'); T.walkTo(s,4); const again=G.inv.count('holly')-h0;
        const t=T.spots('holly')[1]; G.forage.debug.pick(t.id); window.__holly2=t.id; return {ran:+(l0-l1).toFixed(2),ready,again,second:!t.ready}; })()""",
        lambda r:1.8<=r['ran']<=2.2 and r['ready'] and r['again']>=1 and r['second'],LOOP+('holly-pick',))

    # the keeper's page on the sea cave's bench: nothing outside the cave; inside, a real E press reads it and teaches Burst Oil
    await run(pg,'cave-page-outside',30,"""(()=>{ T.home(); T.flush(); G.forage.debug.readPage(); G.step(1/30,2); const pg=G.forage.debug.page;
        const offer=pg?G.interact.list.filter(o=>/keeper.s page/i.test(String(G.interact.label(o)))&&(!o.enabled||o.enabled())).length:0;
        return {inside:!!G.cave.inside,burst:G.alchemy.known.has('burst'),notes:T.of('forage:note').length,said:T.said.length,offer}; })()""",
        lambda r:not r['inside'] and not r['burst'] and r['notes']==0 and r['said']==0 and r['offer']==0,LOOP)
    r=await run(pg,'cave-page-reach',120,"""(()=>{ T.clear(60); G.cave.enter('mouth',{instant:true}); for(let i=0;i<60&&!G.cave.inside;i++)G.step(1/30,1); G.step(1/30,10);
        const pg=G.forage.debug.page; if(!pg)return {inside:!!G.cave.inside,page:false}; T.clear(40);
        /* walk up to the page as a player would: somewhere close to it on open floor where its prompt is the one offered (the bench's own prompt
           covers the rest of the bench) */
        let c=null, lab=null, tries=0;
        for(const d of [.6,.8,1,1.2]){ for(let k=0;k<16;k++){ const a=k/16*Math.PI*2, x=pg.pos.x+Math.sin(a)*d, z=pg.pos.z+Math.cos(a)*d, f=G.floorAt(x,z,pg.pos.y+2);
            if(!(Math.abs(f-pg.pos.y)<1.2))continue; if(G.collidersNear(x,z).some(q=>Math.hypot(q.x-x,q.z-z)<q.r+.35))continue; tries++;
            G.player.teleport(x,f,z,Math.atan2(pg.pos.x-x,pg.pos.z-z)); G.step(1/30,3); c=G.interact.pick(G.player.pos); lab=c&&G.interact.label(c); if(lab==='Read the keeper’s page')break; }
          if(lab==='Read the keeper’s page')break; }
        T.clear(40); G.step(1/30,2); T.flush(); c=G.interact.pick(G.player.pos); lab=c&&G.interact.label(c);
        return {inside:!!G.cave.inside,page:true,lab,tries,d:+Math.hypot(pg.pos.x-G.player.pos.x,pg.pos.z-G.player.pos.z).toFixed(2),room:G.cave.room?G.cave.room(G.player.pos):null}; })()""",
        lambda r:r['inside'] and r['page'] and r['lab']=='Read the keeper’s page',LOOP+('cave-page-outside',))
    if 'cave-page-reach' not in failed:
        await shot(pg,'cave-page')
        await pg.keyboard.press('KeyE')
        await run(pg,'cave-page',60,"""(()=>{ G.step(1/30,4); const n=T.said.find(s=>/keeper/i.test(s.who||''));
            const out={burst:G.alchemy.known.has('burst'),notes:T.of('forage:note').map(e=>e.id),who:n&&n.who,len:n?n.t.length:0,saved:!!G.forage.debug.save().notes.cavePage,
              learned:T.of('recipe:learned').map(e=>e.id)};
            G.forage.debug.readPage(); G.step(1/30,2); out.again=T.of('forage:note').length; out.learnedAgain=T.of('recipe:learned').length; return out; })()""",
            lambda r:r['burst'] and r['notes']==['cavePage'] and r['who'] and r['len']>40 and r['saved'] and r['learned']==['burst'] and r['again']==1 and r['learnedAgain']==1,LOOP+('cave-page-reach',))
    else: skip('cave-page','needs cave-page-reach')
    await ev(pg,"(()=>{ for(let i=0;i<10&&G.talk&&G.talk.isOpen;i++){ G.talk.close(); G.step(1/30,1);} if(G.cave.inside)G.cave.exit({instant:true}); for(let i=0;i<60&&G.cave.inside;i++)G.step(1/30,1); T.settle(10); T.home(); return !G.cave.inside; })()",120)

    # Wren at the well: no holly choice before she is saved and home; then a real E press, the choice teaches Holly Ward, and it is gone after
    await run(pg,'wren-absent',30,"""(()=>{ const up=G.undercroftPeople, w=up.debug.hamletWren(); const offer=G.interact.list.filter(o=>G.interact.label(o)==='Talk to Wren'&&(!o.enabled||o.enabled())).length;
        return {saved:!!up.state.wren.saved,wren:!!(w&&w.root.visible),offer,holly:G.alchemy.known.has('holly')}; })()""",
        lambda r:not r['saved'] and not r['wren'] and r['offer']==0 and not r['holly'],LOOP)
    r=await run(pg,'wren-reach',60,"""(()=>{ const up=G.undercroftPeople; up.state.wren.saved=true; up.state.wren.stage='saved'; G.emit('undercroft:exit',{}); G.step(1/30,10);
        const w=up.debug.hamletWren(); if(!w)return {wren:false}; T.clear(40); T.face(w.pos,1.5); T.clear(40); G.step(1/30,4); T.flush();
        const c=G.interact.pick(G.player.pos); return {wren:!!w.root.visible,left:!!up.state.wren.left,lab:c&&G.interact.label(c)}; })()""",
        lambda r:r['wren'] and r['left'] and r['lab']=='Talk to Wren',LOOP+('wren-absent',))
    if 'wren-reach' not in failed:
        await pg.keyboard.press('KeyE')
        await run(pg,'wren-holly',60,"""(()=>{ G.step(1/30,4); const open=G.talk.isOpen; const seen=T.card(c=>{ const i=c.indexOf('Ask about the holly'); return i>=0?i:c.length-1; });
            const ch=seen.filter(x=>x&&x.choices); const lines=seen.filter(x=>typeof x==='string'); T.settle(5);
            return {open,offered:ch.length?ch[0].choices:[],took:ch.length?ch[0].took:null,tamsin:lines.some(l=>/holly over every door/.test(l)),mixing:lines.some(l=>/glowcap/.test(l)),
              holly:G.alchemy.known.has('holly'),ev:T.of('wren:holly').length,flag:!!G.undercroftPeople.state.wren.holly,mode:G.state.mode}; })()""",
            lambda r:r['open'] and 'Ask about the holly' in r['offered'] and r['took']=='Ask about the holly' and r['tamsin'] and r['mixing'] and r['holly'] and r['ev']==1 and r['flag'] and r['mode']=='play',LOOP+('wren-reach',))
        await run(pg,'wren-holly-gone',60,"""(()=>{ const c=G.interact.pick(G.player.pos); if(c)c.use(); G.step(1/30,4); const seen=T.card(c=>c.length-1); T.settle(5);
            const ch=seen.filter(x=>x&&x.choices); return {offered:ch.length?ch[0].choices:[],ev:T.of('wren:holly').length}; })()""",
            lambda r:len(r['offered'])>=1 and 'Ask about the holly' not in r['offered'] and r['ev']==1,LOOP+('wren-holly',))
    else: skip('wren-holly','needs wren-reach'); skip('wren-holly-gone','needs wren-reach')
    await ev(pg,"(()=>{ for(let i=0;i<10&&G.talk&&G.talk.isOpen;i++){ G.talk.close(); G.step(1/30,1);} T.settle(5); T.home(); return 1; })()")

    # brewing the two new oils: each takes its own ingredients and puts its own flask on the belt
    await run(pg,'brew-new-oils',60,"""(()=>{ T.flush(); G.oils.take('kilnfire',G.oils.count('kilnfire')); G.oils.take('burst',G.oils.count('burst')); G.oils.take('holly',G.oils.count('holly'));
        const need={pitch:2,brine:2,ichor:1,holly:2,glowcap:1}; for(const k in need)G.inv.add(k,Math.max(0,need[k]-G.inv.count(k)),{silent:true});
        const c0={}; for(const k in need)c0[k]=G.inv.count(k);
        const can=[G.alchemy.canBrew('burst'),G.alchemy.canBrew('holly')], ok=[G.alchemy.brew('burst',{instant:true})]; G.step(1/30,3); ok.push(G.alchemy.brew('holly',{instant:true})); G.step(1/30,3);
        const used={}; for(const k in need)used[k]=c0[k]-G.inv.count(k);
        return {can,ok,used,list:G.oils.list().map(o=>o.id+':'+o.n),brews:T.of('brew').map(e=>e.oil)}; })()""",
        lambda r:r['can']==[True,True] and r['ok']==[True,True] and r['used']=={'pitch':2,'brine':2,'ichor':1,'holly':2,'glowcap':1}
                 and r['list']==['burst:1','holly:1'] and r['brews']==['burst','holly'],LOOP+('cave-page','wren-holly'))
    NEW=LOOP+('brew-new-oils',)
    # the picker: two kinds -> V opens it with both (Escape closes, nothing spent); three kinds -> all three, 3 picks Holly Ward
    await ev(pg,"(()=>{ T.home(); T.flush(); return 1; })()")
    await pg.keyboard.press('KeyV')
    await run(pg,'picker-two',60,"(()=>{ G.step(1/30,2); return "+PICKER+"; })()",
        lambda r:r['open'] and r['mode']=='paused' and r['opts']==['burst','holly'],NEW)
    await shot(pg,'picker-two')
    await pg.keyboard.press('Escape')
    await run(pg,'picker-two-back',30,"(()=>{ G.step(1/30,2); return Object.assign("+PICKER+",{n:G.oils.total(),apply:T.of('oil:apply').length}); })()",
        lambda r:not r['open'] and r['mode']=='play' and r['n']==2 and r['apply']==0,NEW+('picker-two',))
    await ev(pg,"(()=>{ G.oils.debug.give('kilnfire',1); T.flush(); G.step(1/30,2); return 1; })()")
    await pg.keyboard.press('KeyV')
    await run(pg,'picker-three',60,"(()=>{ G.step(1/30,2); return "+PICKER+"; })()",
        lambda r:r['open'] and r['mode']=='paused' and r['opts']==['kilnfire','burst','holly'],NEW)
    await shot(pg,'picker-three')
    await pg.keyboard.press('Digit3')
    await run(pg,'picker-three-pick',60,"""(()=>{ G.step(1/30,2); const p="""+PICKER+"""; T.step(1.4);
        return {closed:!p.open,mode:G.state.mode,apply:T.of('oil:apply').map(e=>e.id),active:G.oils.active&&G.oils.active.id,left:G.oils.list().map(o=>o.id)}; })()""",
        lambda r:r['closed'] and r['mode']=='play' and r['apply']==['holly'] and r['active']=='holly' and r['left']==['kilnfire','burst'],NEW+('picker-three',))
    await shot(pg,'coat-holly')

    # Holly Ward: a struck hollow closes in at about three quarters of the pace of one struck without it, and the slow wears off
    await run(pg,'holly-slows',150,"""(()=>{ const trial=side=>{ T.home(); T.flush(); G.oils.debug.coat('holly'); const a=T.at('hollow',0,14*side,{aggro:true}), b=T.at('hollow',0,-14*side,{aggro:true}); for(const m of [a,b]){ m.hp=m.maxHp=40; }
          T.hit(a,'melee',2); const slowA=G.oils.slowed(a), k=a.oilSlow&&a.oilSlow.k, t=a.oilSlow&&+a.oilSlow.t.toFixed(2), sev=T.of('oil:slow').length;
          G.oils.debug.expire(); T.hit(b,'melee',2); const slowB=G.oils.slowed(b);
          const run={a:0,b:0,f:0}, last={a:a.pos.clone(),b:b.pos.clone()}; let at35=null;
          for(let i=0;i<126;i++){ T.hold(); const sa=a.state, sb=b.state; G.step(1/30,1);
            const da=Math.hypot(a.pos.x-last.a.x,a.pos.z-last.a.z), db=Math.hypot(b.pos.x-last.b.x,b.pos.z-last.b.z); last.a.copy(a.pos); last.b.copy(b.pos);
            if(i<100&&sa==='chase'&&a.state==='chase'&&sb==='chase'&&b.state==='chase'&&a.pos.distanceTo(G.player.pos)>7.5&&b.pos.distanceTo(G.player.pos)>7.5){ run.a+=da; run.b+=db; run.f++; }   /* closer in, a hollow waiting its turn hovers at a slower pace */
            if(i===104)at35=G.oils.slowed(a); }
          const out={slowA,slowB,k,t,sev,frames:run.f,ratio:run.b>0?+(run.a/run.b).toFixed(3):null,at35,after:G.oils.slowed(a),slowNow:a.oilSlow||null};
          G.monsters.despawn(a); G.monsters.despawn(b); G.step(1/30,2); return out; };
        /* both sides of the headland in turn (the slowed one first on the left, then on the right), so the ground's slope cancels out */
        const t1=trial(1), t2=trial(-1); return {t1,t2,ratio:t1.ratio&&t2.ratio?+Math.sqrt(t1.ratio*t2.ratio).toFixed(3):null}; })()""",
        lambda r:all(t['slowA'] is True and t['slowB'] is False and t['k']==.75 and 3.9<=t['t']<=4 and t['sev']==1 and t['frames']>=20
                     and t['at35'] is True and t['after'] is False and t['slowNow'] is None for t in (r['t1'],r['t2'])) and .7<=r['ratio']<=.8,NEW)
    await run(pg,'holly-not-stag',90,"""(()=>{ T.home(); T.flush(); G.oils.debug.coat('holly'); const m=T.foe('stag',4); m.hp=m.maxHp=200; const n=T.hit(m,'melee',2);
        const out={kind:m.kind,n,slowed:G.oils.slowed(m),field:m.oilSlow||null,ev:T.of('oil:slow').length}; G.monsters.despawn(m); G.step(1/30,2); return out; })()""",
        lambda r:r['kind']=='stag' and r['n']>=1 and r['slowed'] is False and r['field'] is None and r['ev']==0,NEW)
    # one coat replacing another swaps the effect: Holly Ward -> Kilnfire (a real dressing) burns and no longer slows; and back
    await run(pg,'swap-coat',90,"""(()=>{ T.home(); T.flush(); G.oils.debug.coat('holly'); if(!G.oils.count('kilnfire'))G.oils.debug.give('kilnfire',1); const ok=G.oils.apply('kilnfire'); T.step(1.4);
        const st1={active:G.oils.active&&G.oils.active.id,holly:G.oils.has('holly'),kiln:G.oils.has('kilnfire')};
        const m=T.foe('hollow'); m.hp=m.maxHp=40; T.hit(m,'melee',2); const a={burning:T.burning(m),slowed:G.oils.slowed(m)}; G.monsters.despawn(m); G.step(1/30,2);
        G.oils.debug.coat('holly'); const m2=T.foe('hollow'); m2.hp=m2.maxHp=40; T.hit(m2,'melee',2); const b={burning:T.burning(m2),slowed:G.oils.slowed(m2)}; G.monsters.despawn(m2); G.step(1/30,2);
        return {ok,st1,a,b,off:T.of('oil:off').map(e=>e.id+':'+e.reason)}; })()""",
        lambda r:r['ok'] and r['st1']=={'active':'kilnfire','holly':False,'kiln':True} and r['a']=={'burning':True,'slowed':False} and r['b']=={'burning':False,'slowed':True}
                 and r['off'][:1]==['holly:replaced'],NEW)

    # Burst Oil, with a real charged bolt (strike held, then let go) locked on a hollow 8 m off: the foe 1.5 m from it takes the
    # burst, the struck one only the bolt, nothing 6 m off; a full charge bursts bigger (the foe 3.6 m off too); no coat, no burst
    async def bolt(name,hold_frames,coat,test):
        await ev(pg,"(()=>{ T.flush(); "+("G.oils.debug.coat('burst');" if coat else "G.oils.debug.expire(); G.oils.clear('test');")+" window.__rig=T.rig(); const P=G.player; P.lockTarget=__rig.mark.hb; T.hold(); G.step(1/30,4); T.flush(); return 1; })()")
        await pg.keyboard.down('KeyJ')
        mid=await ev(pg,f"(()=>{{ for(let i=0;i<{hold_frames};i++){{ T.hold(); G.step(1/30,1); }} return {{state:G.player.state,lock:G.player.lockTarget===__rig.mark.hb}}; }})()")
        await pg.keyboard.up('KeyJ')
        await run(pg,name,60,"""(()=>{ const r=__rig; for(let i=0;i<45&&!T.of('projectile:end').some(e=>e.team==='player');i++){ T.hold(); G.step(1/30,1); } G.step(1/30,3);
            const pe=T.of('projectile:end').filter(e=>e.team==='player'), b=T.of('oil:burst');
            const out={mid:"""+json.dumps(mid)+""",bolts:pe.length,great:pe[0]&&pe[0].great,burst:b.map(e=>({r:e.radius,great:e.great,hits:e.hits})),
              mark:{bolt:r.mark.hits.filter(h=>h.kind==='bolt').length,blast:r.mark.hits.filter(h=>h.kind==='blast').length},
              near:T.dmg(r.near,'blast'),mid3:T.dmg(r.mid,'blast'),far:T.dmg(r.far),nearAll:r.near.hits.length};
            T.unrig(r); G.player.lockTarget=null; T.step(.5); return out; })()""",test,NEW+('picker-three-pick',))
    await bolt('burst-bolt',24,True,lambda r:r['mid']['state']=='charge' and r['mid']['lock'] and r['bolts']==1 and r['great'] is False and r['burst']==[{'r':2.5,'great':False,'hits':1}]
               and r['mark']=={'bolt':1,'blast':0} and r['near']==3 and r['mid3']==0 and r['far']==0)
    await shot(pg,'burst')
    await bolt('burst-great',50,True,lambda r:r['mid']['state']=='charge' and r['bolts']==1 and r['great'] is True and r['burst']==[{'r':3.5,'great':True,'hits':2}]
               and r['mark']=={'bolt':1,'blast':0} and r['near']==4 and r['mid3']==4 and r['far']==0)
    await bolt('burst-no-coat',24,False,lambda r:r['bolts']==1 and r['burst']==[] and r['mark']['bolt']==1 and r['near']==0 and r['mid3']==0 and r['nearAll']==0)
    # a pierced line: what the bolt struck before it ended is spared too (the exclude set), only the bystander takes the burst
    await run(pg,'burst-spares-struck',60,"""(()=>{ T.flush(); G.oils.debug.coat('burst'); const r=T.rig(); const p={team:'player',kind:'bolt',pos:r.mark.pos.clone().setY(r.mark.pos.y+1),exclude:new Set([r.mark.hb,r.near.hb]),great:true};
        G.emit('projectile:end',{p,hits:[]}); G.step(1/30,2); const out={mark:T.dmg(r.mark),near:T.dmg(r.near),mid3:T.dmg(r.mid,'blast'),far:T.dmg(r.far)}; T.unrig(r); return out; })()""",
        lambda r:r['mark']==0 and r['near']==0 and r['mid3']==4 and r['far']==0,NEW)
    # the moth swarm round the lantern: a full burst among them harms none and drives none off
    await run(pg,'burst-swarm',120,"""(()=>{ T.home(); T.flush(); G.oils.debug.coat('burst'); G.devtools.giveSwarm(40); for(let i=0;i<60;i++){ T.hold(); G.step(1/30,1); }
        const n0=G.creatures.lanternCount, L=G.items.lantern.world.clone(); const p={team:'player',kind:'bolt',pos:L,exclude:new Set(),great:true};
        G.emit('projectile:end',{p,hits:[]}); for(let i=0;i<30;i++){ T.hold(); G.step(1/30,1); } const n1=G.creatures.lanternCount, b=T.of('oil:burst');
        return {n0,n1,burst:b.length,hits:b[0]&&b[0].hits}; })()""",
        lambda r:r['n0']>3 and r['burst']==1 and r['hits']==0 and r['n1']>=r['n0'],NEW)
    # leave the belt as the slice-1 save checks expect it: nothing carried, no coat
    await ev(pg,"(()=>{ G.oils.debug.expire(); for(const o of G.oils.list())G.oils.take(o.id,o.n); T.home(); T.flush(); return G.oils.total(); })()")

# ------------------------------------------------------------------ the bosses through the real path: a real strike with Kilnfire on, then its ticks
BOSS_LIB=r"""
window.TB={ log(hb,read){ const L=[], h0=hb.hit; hb.hit=i=>{ const a=read(); h0(i); L.push({kind:i&&i.kind,before:a,d:+(a.hp-read().hp).toFixed(3)}); }; return L; },
  strike(hb){ const ex=new Set([...G.hurtboxes].filter(h=>h!==hb)), y=hb.pos.y+(hb.height||2)*.5;
    return G.combat.strike({x:hb.pos.x,y,z:hb.pos.z,radius:(hb.radius||1)+.5,team:'player',damage:2,knockback:2,kind:'melee',source:G.player,exclude:ex}).length; } };
'ok'"""
async def boss_suite(b):
    ctx,pg,errs=await boot(b)
    try:
        await ev(pg,LIB); await ev(pg,BOSS_LIB)
        # the Gloaming: a tick lands only while it is solid (as a staff blow would), never while it is fog
        await run(pg,'boss:gloaming-start',180,"""(()=>{ G.devtools.start('finale'); T.play(); G.step(1/30,30); const L=G.world.lighthouse; G.player.teleport(L.x-14,42,L.z-6,-2.3); if(G.devtools.cheats)G.devtools.cheats.god=true;
            const FB=G.finaleBoss, B=FB.debug.B; for(let i=0;i<200&&!FB.active;i++)G.step(1/30,1); const cl=()=>{ for(const m of G.monsters.list.slice())if(m.finale&&m.alive&&!m.gloaming)G.monsters.despawn(m); }; cl();
            for(let i=0;i<500&&B.state!=='fight';i++)G.step(1/30,1); cl(); B.cool=1e9; G.oils.debug.coat('kilnfire'); window.__gl=TB.log(FB.debug.bodyHB,()=>({hp:B.hp,solid:!!FB.solid}));
            return {active:FB.active,state:B.state,coat:G.oils.active&&G.oils.active.id}; })()""",
            lambda r:r['active'] and r['state']=='fight' and r['coat']=='kilnfire')
        await run(pg,'boss:gloaming-burns',120,"""(()=>{ const FB=G.finaleBoss, D=FB.debug, B=D.B; T.flush(); B.cool=1e9;
            B.solidT=0; B.staggerT=0; const n1=TB.strike(D.bodyHB); for(let i=0;i<110;i++){ T.hold(); B.cool=1e9; B.solidT=0; B.staggerT=0; G.step(1/30,1); }   /* kept fog: no beam crossing */
            D.solidNow(12); const n2=TB.strike(D.bodyHB); for(let i=0;i<110;i++){ T.hold(); B.cool=1e9; G.step(1/30,1); }
            const L=__gl, melee=L.filter(x=>x.kind==='melee'), burn=L.filter(x=>x.kind==='burn');
            return {n1,n2,melee:melee.map(x=>[x.before.solid,x.d]),burnFog:burn.filter(x=>!x.before.solid).map(x=>x.d),burnSolid:burn.filter(x=>x.before.solid).map(x=>x.d),
              ign:T.of('oil:ignite').length,ticks:T.of('oil:burn').length}; })()""",
            lambda r:r['n1']>=1 and r['n2']>=1 and len(r['melee'])==2 and r['melee'][0]==[False,0] and r['melee'][1][0] is True and r['melee'][1][1]>0
                     and len(r['burnFog'])>=2 and all(d==0 for d in r['burnFog']) and len(r['burnSolid'])>=2 and all(d==1 for d in r['burnSolid']) and r['ign']==2 and r['ticks']==6,('boss:gloaming-start',))
        await shot(pg,'boss-gloaming')
    finally:
        real=[e for e in errs if '404' not in e]
        check('boss:gloaming no page errors',not real,real[:6])
        await ctx.close()
    ctx,pg,errs=await boot(b)
    try:
        await ev(pg,LIB); await ev(pg,BOSS_LIB)
        # the Wreck Giant is made of fire: a Kilnfire blow lands as a blow, never sets it burning, hot or doused
        await run(pg,'boss:giant-start',180,"""(()=>{ G.devtools.start('north-fight'); T.play(); if(G.devtools.cheats)G.devtools.cheats.god=true; const g=G.northFire.giant; for(let i=0;i<600&&g.state!=='fight';i++)G.step(1/30,1); G.step(1/30,10);
            G.oils.debug.coat('kilnfire'); window.__gi=TB.log(G.northFire.debug.HB,()=>({hp:g.hp})); return {state:g.state,coat:G.oils.active&&G.oils.active.id}; })()""",
            lambda r:r['state']=='fight' and r['coat']=='kilnfire')
        await run(pg,'boss:giant-never-burns',120,"""(()=>{ const g=G.northFire.giant, HB=G.northFire.debug.HB; T.flush(); const out={};
            for(const k of ['hot','doused']){ if(k==='doused'){ g.douse(6.5); G.step(1/30,2); } const n=TB.strike(HB); G.step(1/30,1); const h=g.hp; for(let i=0;i<110;i++){ T.hold(); G.step(1/30,1); }
              out[k]={n,hp:+(h-g.hp).toFixed(3),doused:!!g.doused}; }
            out.melee=__gi.filter(x=>x.kind==='melee').length; out.burnCalls=__gi.filter(x=>x.kind==='burn').length; out.ign=T.of('oil:ignite').length; out.ticks=T.of('oil:burn').length;
            out.burning=G.oils.burning(HB); return out; })()""",
            lambda r:r['hot']['n']>=1 and r['doused']['n']>=1 and r['doused']['doused'] and r['melee']==2 and r['burnCalls']==0 and r['ign']==0 and r['ticks']==0
                     and r['hot']['hp']==0 and r['doused']['hp']==0 and r['burning'] is False,('boss:giant-start',))
    finally:
        real=[e for e in errs if '404' not in e]
        check('boss:giant no page errors',not real,real[:6])
        await ctx.close()

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
    d:t?+Math.hypot(t.world.x-p.x,t.world.z-p.z).toFixed(2):null,lab:c&&G.interact.label(c),flasks:G.oils.total(),
    newOils:['burst','holly'].map(id=>G.alchemy.known.has(id)&&G.alchemy.canBrew(id)),holly:G.inv.count('holly')}; })()"""
START_FIGHT="""(()=>{ const p=G.player.pos; const near=G.monsters.list.filter(m=>m.alive&&!m.dying&&m.kind==='hollow'&&m.pos.distanceTo(p)<30).length;
    return {mode:G.state.mode,loop:!!G.loop.active,test:!!G.testSaves,n:G.oils.count('kilnfire'),armed:G.oils.armed(),hollows:near,known:G.alchemy.known.has('kilnfire'),
      knownAll:['burst','holly'].every(id=>G.alchemy.known.has(id))}; })()"""

async def main():
    t0=time.time()
    only=os.environ.get('ONLY')   # e.g. ONLY=pad,touch runs just those parts (main, pad, touch, starts)
    want=lambda k:not only or k in only.split(',')
    async with async_playwright() as p:
        b=await p.chromium.launch(**CHROME)
        parts=[('main',lambda:main_suite(b),2400),('bosses',lambda:boss_suite(b),900),('pad',lambda:pad_suite(b),500),('touch',lambda:touch_suite(b),500),
          ('starts',lambda:start_suite(b,'oils',START_OILS,
              lambda r:r['mode']=='play' and r['loop'] and r['test'] and r['known'] and r['pitch']>=1 and r['gorse']>=2 and r['can'] and r['d'] is not None and r['d']<2.8 and r['lab']=='Work the alchemy table' and r['newOils']==[True,True] and r['holly']>=2),400),
          ('starts',lambda:start_suite(b,'oils-fight',START_FIGHT,
              lambda r:r['mode']=='play' and r['loop'] and r['test'] and r['n']==3 and r['armed'] and r['hollows']>=1 and r['known'] and r['knownAll']),400)]
        for k,fn,budget in parts:
            if not want(k): continue
            try: await asyncio.wait_for(fn(),budget)
            except asyncio.TimeoutError: check(k+'-suite',False,{'timeout':budget})
            except Exception as e: check(k+'-suite',False,{'error':str(e)[:300]})
        await b.close()
    print('RESULT', 'PASS' if ok_all else 'FAIL '+', '.join(sorted(failed)), f'{time.time()-t0:.0f}s', flush=True)
    sys.exit(0 if ok_all else 1)

asyncio.run(main())
