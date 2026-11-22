"""The Thornback (js/thornback.js, a monsters.js kind): the deep wood's bramble-backed boar. Spec: THORNBACK.md.
Covers, reading state through G.thornback / G.monsters / G.oils / G.alchemy:
- none exist before the core loop; three after, at homes that keep their distances (deep wood, among the trees, clear of the
  Resisting Tree, the Vigil's hollow, the kiln, the Blighted Grove and every heart shard and cache);
- the hide: staff blows and bolts land for half and glance (no flinch); a real staff swing glances; 3 s of Kilnfire burning
  strips it; two shockwave blows (one of them a real Skyfall Slam) crack and then break it off; a burst never counts;
  bare, blows land in full and it flinches;
- the charge: a readable wind-up (snort, ~0.9 s), then a run that hurts (3 half-hearts) and throws you back; a real roll aside
  avoids it; the tusk swipe up close;
- a charge into a tree stuns it, and blows on a stunned one do x1.5;
- killable with the plain staff in a sane number of blows, and clearly fewer with Kilnfire; 3 ichor on death;
- leash (it walks home and heals), respawn (minutes later, only out of sight), save -> reload -> Continue (a dead one stays
  dead), an older save without the key; the sounds; the Test tools start point 'thornback'.
Each check has its own time budget; a check whose groundwork failed is reported SKIP (and counts as failed).
usage: python3 test/thornback_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)
Screenshots go to /tmp/claude-0/thornback-tests/."""
import asyncio, sys, json, os, time
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
OUT='/tmp/claude-0/thornback-tests'; os.makedirs(OUT,exist_ok=True)
CHROME=dict(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
failed=set(); ok_all=True; counts={'ok':0,'fail':0}
def check(name,ok,info):
    global ok_all
    ok_all=ok_all and bool(ok); counts['ok' if ok else 'fail']+=1
    if not ok: failed.add(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name:22s} {json.dumps(info,default=str)[:600]}",flush=True)
def skip(name,why):
    global ok_all
    ok_all=False; failed.add(name); counts['fail']+=1; print(f"SKIP {name:22s} {why}",flush=True)

# helpers installed in the page after every load
LIB=r"""
window.T=(()=>{
const P=()=>G.player, TB=()=>G.thornback, D=()=>G.thornback.debug;
const SPOT={x:150,y:42.2,z:-14,yaw:Math.PI*.5};          // the open headland: room to charge, far from every monster zone
const step=s=>G.step(1/30,Math.max(1,Math.round(s*30)));
const ev=[];
const pick=(n,e)=>{ const o={n,t:+G.time.toFixed(2)}; if(e)for(const k of ['how','atk','kind','id','name','damage'])if(e[k]!==undefined)o[k]=e[k]; if(e&&e.n!==undefined)o.num=e.n;
  if(e&&e.info&&e.info.kind)o.kind=e.info.kind; return o; };
for(const n of ['thornback:sfx','thornback:glance','thornback:crack','thornback:hide','thornback:windup','thornback:charge','thornback:stun','thornback:respawn','monster:killed','player:hurt','oil:ignite'])
  G.on(n,e=>ev.push(pick(n,e)));
function of(n){ return ev.filter(e=>e.n===n); }
function flush(){ ev.length=0; }
function play(){ const p=P(); if(G.state.mode==='dead'||p.alive===false)p.respawn(p.pos.clone(),p.heading); if(!document.getElementById('pause').hidden)document.getElementById('resume').click(); if(G.talk&&G.talk.isOpen)G.talk.close(); if(G.state.mode!=='play'&&G.state.mode!=='dead')G.setMode('play'); }
function hold(){ const p=P(); if(p.alive!==false)p.hp=p.maxHp; }
function settle(n){ play(); for(let i=0;i<(n||10);i++){ hold(); G.step(1/30,1); } if(G.progress&&G.progress.endReward)G.progress.endReward(); play(); }
function clear(r,at){ const c=at||P().pos; let n=0; for(const m of G.monsters.list.slice())if(m.alive&&!m.dying&&Math.hypot(m.pos.x-c.x,m.pos.z-c.z)<(r||40)){ G.monsters.despawn(m); n++; } return n; }
function home(){ play(); clear(60); const p=P(); p.teleport(SPOT.x,null,SPOT.z,SPOT.yaw); if(p.aimCamera)p.aimCamera(SPOT.yaw,.26); hold(); step(.3); clear(60); }
/** a Thornback d m in front of the player, facing it; quiet (no attacks) unless cool is given */
function foe(d,o){ o=o||{}; const p=P(), h=p.heading; const x=p.pos.x+Math.sin(h)*(d||2.4), z=p.pos.z+Math.cos(h)*(d||2.4);
  const m=D().spawnAt(x,z,Object.assign({heading:h+Math.PI},o)); m.cool=o.cool!=null?o.cool:99; m.mat.uniforms.uFade.value=1; return m; }
/** the Traveler's own blow (a bolt's source is a bolt) */
function hit(m,kind,dmg){ const src=kind==='bolt'?{team:'player',kind:'bolt',test:true}:P();
  return G.combat.strike({x:m.pos.x,y:m.pos.y+1,z:m.pos.z,radius:.8,team:'player',damage:dmg||2,knockback:2,kind:kind||'melee',source:src}).length; }
function info(m){ return D().info(m); }
/** a straight lane through one tree trunk in the deep wood: open walkable ground ~11 m before it, room for the player behind it */
function lane(){ const TR=G.world.treeLOD.trees;
  for(const t of TR){ if(t.x>-140||t.x<-205)continue;
    const c=G.collidersNear(t.x,t.z).find(o=>o.r>.25&&Math.hypot(o.x-t.x,o.z-t.z)<.35); if(!c)continue;
    for(let k=0;k<8;k++){ const a=k*Math.PI/4, dx=Math.sin(a), dz=Math.cos(a); let ok=true; const h0=G.world.height(c.x,c.z);
      for(let d=-(c.r+1.2);d>=-11&&ok;d-=.5){ const x=c.x+dx*d, z=c.z+dz*d; if(!G.world.walkable(x,z)||Math.abs(G.world.height(x,z)-h0)>1.6){ok=false;break;}
        for(const o of G.collidersNear(x,z))if(o!==c&&Math.hypot(o.x-x,o.z-z)<o.r+1.4){ok=false;break;} }
      for(let d=c.r+.6;d<=c.r+3.5&&ok;d+=.5){ const x=c.x+dx*d, z=c.z+dz*d; if(!G.world.walkable(x,z))ok=false; for(const o of G.collidersNear(x,z))if(o!==c&&Math.hypot(o.x-x,o.z-z)<o.r+.6)ok=false; }
      if(ok)return {x:c.x,z:c.z,r:c.r,dx,dz}; } }
  return null; }
/** step until fn() is true (at most s seconds); returns seconds taken or -1 */
function until(fn,s){ for(let i=0;i<s*30;i++){ if(fn())return +(i/30).toFixed(2); G.step(1/30,1); } return fn()?s:-1; }
function ichor(){ try{ return G.alchemy.debug.info().drops; }catch(e){ return -1; } }
return {P,TB,D,SPOT,step,ev,of,flush,play,hold,settle,clear,home,foe,hit,info,lane,until,ichor};
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
    await run(pg,'modules',30,"""(()=>{ const B=G.thornback, M=G.monsters;
        return {api:!!B&&typeof B.list==='function'&&typeof B.startSpot==='function'&&!!(B.debug&&B.debug.spawnAt&&B.debug.info),define:typeof M.define,
          params:M.params&&M.params.thornback===B.T, T:B&&B.T, burns:!!(G.oils&&G.oils.burning)}; })()""",
        lambda r:r['api'] and r['define']=='function' and r['params'] and r['burns'] and r['T']['hp']==26 and r['T']['walk']==2.4 and r['T']['aggro']==16
                 and r['T']['chargeSpeed']==9.5 and r['T']['chargeLen']==14 and r['T']['chargeDmg']==3 and r['T']['swipeDmg']==2 and r['T']['drops']==3
                 and r['T']['stun']==2.2 and r['T']['stunMul']==1.5 and r['T']['hideBurn']==3 and r['T']['hideSlams']==2 and r['T']['chargeWind']==.9 and r['T']['swipeWind']==.5)

    await run(pg,'none-before-loop',60,"""(()=>{ T.hold(); T.step(3); return {loop:!!G.loop.active,n:G.thornback.list().length,filled:G.thornback.debug.homes().filter(h=>h.filled).length}; })()""",
        lambda r:not r['loop'] and r['n']==0 and r['filled']==0,MOD)

    await run(pg,'loop-start',90,"(()=>{ G.debugStartLoop(); T.settle(30); return {loop:!!G.loop.active,mode:G.state.mode,n:G.thornback.list().length,homes:G.thornback.debug.homes()}; })()",
        lambda r:r['loop'] and r['mode']=='play' and r['n']==3 and all(h['alive'] for h in r['homes']),MOD)
    LOOP=MOD+('loop-start',)

    # the homes keep their distances, sampled live from the world (tree, hollow, kiln, grove, every shard and cache)
    await run(pg,'homes-placed',60,"""(()=>{ const out=[]; const W=G.world, LM=W.landmarks;
        const avoid=[['tree',LM.resistingTree.x,LM.resistingTree.z],['vigil',-192,2],['kiln',G.forage?G.forage.kiln.pos.x:-104,G.forage?G.forage.kiln.pos.z:-7],
          ['grove',...(()=>{ const b=(G.blights||[]).find(q=>q.id==='grove'); return b?[b.pos.x,b.pos.z]:[-126,-30]; })()]];
        for(const s of G.progress.spots)avoid.push(['shard:'+s.id,s.pos.x,s.pos.z]); for(const c of G.progress.caches)if(c.pos)avoid.push(['cache:'+c.id,c.pos.x,c.pos.z]);
        for(const h of G.thornback.homes){ let near=null,dmin=1e9; for(const a of avoid){ const d=Math.hypot(a[1]-h.x,a[2]-h.z); if(d<dmin){dmin=d;near=a[0];} }
          let trees=0; for(const t of W.treeLOD.trees)if(Math.hypot(t.x-h.x,t.z-h.z)<16)trees++;
          const m=h.m; out.push({id:h.id,x:h.x,z:h.z,walk:W.walkable(h.x,h.z),forest:W.inForest(h.x),dmin:+dmin.toFixed(1),near,trees,at:m?+Math.hypot(m.pos.x-h.x,m.pos.z-h.z).toFixed(1):null}); }
        let spread=1e9; for(let i=0;i<out.length;i++)for(let j=i+1;j<out.length;j++)spread=Math.min(spread,Math.hypot(out[i].x-out[j].x,out[i].z-out[j].z));
        return {homes:out,spread:+spread.toFixed(1)}; })()""",
        lambda r:len(r['homes'])==3 and all(h['walk'] and h['forest'] and -215<=h['x']<=-130 and h['dmin']>=25 and h['trees']>=15 and h['at'] is not None and h['at']<12 for h in r['homes']) and r['spread']>=30,LOOP)

    # the hide: blows and bolts land for half and glance; no flinch
    await run(pg,'hide-halves',60,"""(()=>{ T.home(); T.flush(); const m=T.foe(2.4); G.step(1/30,2); const h0=m.hp, out=[];
        for(const [k,d] of [['melee',2],['melee',3],['bolt',4],['bolt',6],['melee',1]]){ const b=m.hp; T.hit(m,k,d); G.step(1/30,1); out.push({k,d,took:+(b-m.hp).toFixed(2),state:m.state}); }
        const r={out,glances:T.of('thornback:glance').length,sfx:T.of('thornback:sfx').filter(e=>e.name==='glance').length,hide:T.info(m).hide}; G.monsters.despawn(m); return r; })()""",
        lambda r:[o['took'] for o in r['out']]==[1,1,2,3,1] and all(o['state']!='hurt' for o in r['out']) and r['glances']==5 and r['sfx']>=5 and r['hide']['on'],LOOP)

    # a real staff swing (the attack button) glances off it
    await run(pg,'real-swing-glances',60,"""(()=>{ T.home(); T.flush(); const m=T.foe(1.7); G.step(1/30,2); const h0=m.hp;
        G.input.setVirtual('attack',true); G.step(1/30,2); G.input.setVirtual('attack',false); T.until(()=>m.hp<h0,1.2); T.step(.4);
        const r={took:+(h0-m.hp).toFixed(2),state:m.state,glance:T.of('thornback:glance').length,mods:G.player.mods.dmg}; G.monsters.despawn(m); return r; })()""",
        lambda r:r['glance']>=1 and r['took']>=1 and r['took']<=max(1,(2+r['mods'])//2)*2 and r['state']!='hurt',LOOP)

    # Kilnfire: a lit blow sets it burning; 3 s of burning strips the hide in embers; then blows land in full and it flinches
    await run(pg,'burn-strips-hide',90,"""(()=>{ T.home(); T.flush(); G.oils.debug.coat('kilnfire',90); G.step(1/30,2); const m=T.foe(2.4); G.step(1/30,2);
        const h0=m.hp; T.hit(m,'melee',2); const lit=G.oils.burning(m); const mid=[]; for(let i=0;i<4;i++){ T.step(.5); mid.push(T.info(m).hide.burn); }
        const t=T.until(()=>!T.info(m).hide.on,2); const after=T.info(m); T.step(.2);
        const b=m.hp; T.hit(m,'melee',2); G.step(1/30,1); const full=+(b-m.hp).toFixed(2), st=m.state;
        G.oils.clear&&G.oils.clear('test'); const r={lit,mid,t,after,full,st,hideEv:T.of('thornback:hide'),sfx:T.of('thornback:sfx').filter(e=>e.name==='hide').map(e=>e.how),burnDmg:+(h0-b-1).toFixed(2)}; G.monsters.despawn(m); return r; })()""",
        lambda r:r['lit'] and r['t']>=0 and not r['after']['hide']['on'] and r['after']['hide']['how']=='burn' and 2.9<=r['after']['hide']['burn']<=3.3
                 and r['full']==2 and r['st']=='hurt' and len(r['hideEv'])==1 and r['hideEv'][0].get('how')=='burn' and 'burn' in r['sfx'] and r['burnDmg']>=2,LOOP)

    # two shockwave blows: the first cracks it, the second breaks it off; a burst (blast) never counts
    await run(pg,'slams-break-hide',90,"""(()=>{ T.home(); T.flush(); const m=T.foe(2.4); G.step(1/30,2);
        T.hit(m,'blast',3); G.step(1/30,2); const afterBlast=T.info(m).hide;
        T.hit(m,'shockwave',3); G.step(1/30,2); const one=T.info(m).hide, st1=m.state; T.step(.5);
        T.hit(m,'shockwave',3); G.step(1/30,2); const two=T.info(m).hide, falls=G.thornback.debug.falls(); T.step(.6);
        const b=m.hp; T.hit(m,'melee',2); G.step(1/30,1); const full=+(b-m.hp).toFixed(2), st=m.state;
        T.step(8); const gone=G.thornback.debug.falls();
        const r={afterBlast,one,st1,two,falls,full,st,gone,cracks:T.of('thornback:crack').length,hideEv:T.of('thornback:hide').map(e=>e.how)}; G.monsters.despawn(m); return r; })()""",
        lambda r:r['afterBlast']['on'] and r['afterBlast']['slams']==0 and r['one']['on'] and r['one']['slams']==1 and r['cracks']==1
                 and not r['two']['on'] and r['two']['how']=='break' and r['falls']==2 and r['full']==2 and r['st']=='hurt' and r['gone']==0 and r['hideEv']==['break'],LOOP)

    # a real Skyfall Slam (jump, then strike) next to one counts as a shockwave blow
    await run(pg,'real-slam-cracks',60,"""(()=>{ T.home(); T.flush(); const m=T.foe(1.9); G.step(1/30,2); const h0=m.hp;
        G.input.setVirtual('jump',true); G.step(1/30,2); G.input.setVirtual('jump',false); T.step(.22);
        G.input.setVirtual('attack',true); G.step(1/30,2); G.input.setVirtual('attack',false);
        T.until(()=>G.player.grounded&&!G.player.move.id,2.5); T.step(.3);
        const r={hide:T.info(m).hide,took:+(h0-m.hp).toFixed(2),cracks:T.of('thornback:crack').length,combo:G.player.move.id}; G.monsters.despawn(m); return r; })()""",
        lambda r:r['hide']['slams']==1 and r['hide']['on'] and r['cracks']==1 and r['took']>=3,LOOP)

    # the charge: a readable wind-up (snort, ~0.9 s), then it hurts (3 half-hearts) and throws you back
    await run(pg,'charge-telegraph-hits',90,"""(()=>{ T.home(); T.flush(); const p=G.player; p.hp=p.maxHp; const m=T.foe(11,{cool:0}); m.aggro=true; m.state='chase';
        const tW=T.until(()=>m.state==='windCharge',3); const w0=G.time; const tC=T.until(()=>m.state==='charge',2); const wind=+(G.time-w0).toFixed(2);
        const hp0=p.hp, x0=p.pos.clone(); const tH=T.until(()=>T.of('player:hurt').length>0,3); T.step(.4);
        const r={tW,wind,tH,lost:hp0-p.hp,moved:+Math.hypot(p.pos.x-x0.x,p.pos.z-x0.z).toFixed(2),snort:T.of('thornback:sfx').filter(e=>e.name==='snort').length,
          gallop:T.of('thornback:sfx').filter(e=>e.name==='gallop').length,windEv:T.of('thornback:windup').map(e=>e.atk),hurtKind:(T.of('player:hurt')[0]||{}).kind}; p.hp=p.maxHp; G.monsters.despawn(m); return r; })()""",
        lambda r:r['tW']>=0 and .85<=r['wind']<=1.0 and r['tH']>=0 and r['lost']==3 and r['moved']>=2.5 and r['snort']>=1 and r['gallop']>=1 and 'charge' in r['windEv'],LOOP)

    # read it and roll aside: a real roll (stick sideways + roll) as the wind-up ends takes no damage
    await run(pg,'charge-roll-aside',90,"""(()=>{ T.home(); T.flush(); const p=G.player; p.hp=p.maxHp; const m=T.foe(11,{cool:0}); m.aggro=true; m.state='chase';
        T.until(()=>m.state==='windCharge',3); T.until(()=>m.st>=.68,1);
        G.input.setVirtual('left',true); G.input.setVirtual('roll',true); G.step(1/30,2); G.input.setVirtual('roll',false); T.step(.5); G.input.setVirtual('left',false);
        T.until(()=>m.state!=='charge',3); T.step(.3);
        const r={lost:p.maxHp-p.hp,hurts:T.of('player:hurt').length,state:m.state,charged:T.of('thornback:charge').length}; p.hp=p.maxHp; G.monsters.despawn(m); return r; })()""",
        lambda r:r['charged']>=1 and r['lost']==0 and r['hurts']==0,LOOP)

    # the tusk swipe up close: a short wind-up, then 2 half-hearts
    await run(pg,'tusk-swipe',60,"""(()=>{ T.home(); T.flush(); const p=G.player; p.hp=p.maxHp; const m=T.foe(2.0,{cool:0}); m.aggro=true; m.state='chase';
        const tW=T.until(()=>m.state==='swipeWind',2); const w0=G.time; T.until(()=>m.state==='swipe',1.5); const wind=+(G.time-w0).toFixed(2); const hp0=p.hp;
        T.until(()=>T.of('player:hurt').length>0,1); T.step(.3);
        const r={tW,wind,lost:hp0-p.hp,tusk:T.of('thornback:sfx').filter(e=>e.name==='tusk').length}; p.hp=p.maxHp; G.monsters.despawn(m); return r; })()""",
        lambda r:r['tW']>=0 and .45<=r['wind']<=.6 and r['lost']==2 and r['tusk']>=1,LOOP)

    # a charge into a tree: stunned ~2.2 s, blows on it do x1.5 (after the hide's half)
    await run(pg,'tree-stun',120,"""(()=>{ T.play(); const L=T.lane(); if(!L)return {lane:null}; const p=G.player; T.clear(45,{x:L.x,z:L.z}); T.flush();
        const pd=L.r+3.0; p.teleport(L.x+L.dx*pd,null,L.z+L.dz*pd,Math.atan2(-L.dx,-L.dz)); p.hp=p.maxHp; G.step(1/30,3); T.clear(45,{x:L.x,z:L.z});
        const bd=L.r+8.5; const m=G.thornback.debug.spawnAt(L.x-L.dx*bd,L.z-L.dz*bd,{heading:Math.atan2(L.dx,L.dz)}); m.mat.uniforms.uFade.value=1; m.cool=0; m.aggro=true; m.state='chase';
        const tC=T.until(()=>m.state==='charge',4); const tS=T.until(()=>m.state==='stunned',3); const s0=G.time;
        const b=m.hp; T.hit(m,'melee',2); G.step(1/30,1); const took=+(b-m.hp).toFixed(2), during=m.state;
        const tE=T.until(()=>m.state!=='stunned',4); const dur=+(G.time-s0).toFixed(2);
        const r={lane:L,tC,tS,took,during,dur,hurt:T.of('player:hurt').map(e=>e.kind),stunEv:T.of('thornback:stun').length,sfx:T.of('thornback:sfx').filter(e=>e.name==='stun').length,
          dTree:+(Math.hypot(m.pos.x-L.x,m.pos.z-L.z)).toFixed(2)};
        p.hp=p.maxHp; G.monsters.despawn(m); return r; })()""",
        lambda r:r['lane'] and r['tC']>=0 and r['tS']>=0 and r['took']==1.5 and r['during']=='stunned' and 2.1<=r['dur']<=2.4 and r['stunEv']==1 and r['sfx']>=1 and 'charge' not in r['hurt'],LOOP)

    # killable with the plain staff in a sane number of blows: two slams take the hide, then ordinary 2/2/3 combos; 3 ichor
    await run(pg,'plain-staff-kill',90,"""(()=>{ T.home(); T.flush(); G.oils.clear&&G.oils.clear('test'); const m=T.foe(2.4); G.step(1/30,2); const i0=T.ichor()+G.inv.count('ichor'); let blows=0;
        for(let k=0;k<2;k++){ T.hit(m,'shockwave',3); blows++; T.step(.6); }
        const combo=[2,2,3]; while(m.alive&&!m.dying&&blows<60){ T.hit(m,'melee',combo[blows%3]); blows++; T.step(.35); }
        T.step(2); const killed=T.of('monster:killed').filter(e=>e.kind==='thornback').length;
        return {blows,killed,ichor:T.ichor()+G.inv.count('ichor')-i0,dead:!m.alive}; })()""",
        lambda r:r['killed']==1 and r['dead'] and 8<=r['blows']<=14 and r['ichor']==3,LOOP)

    # Kilnfire makes it clearly easier: plain swings only (no slams, no stun) against a lit staff
    await run(pg,'kilnfire-easier',150,"""(()=>{ const combo=[2,2,3], fight=(coat)=>{ T.home(); if(coat)G.oils.debug.coat('kilnfire',90); else G.oils.clear&&G.oils.clear('test'); G.step(1/30,2);
          const m=T.foe(2.4); G.step(1/30,2); let blows=0; while(m.alive&&!m.dying&&blows<80){ T.hit(m,'melee',combo[blows%3]); blows++; T.step(blows%3?.35:1.6); } const r=blows; if(m.alive)G.monsters.despawn(m); return r; };
        const plain=fight(false), kiln=fight(true); G.oils.clear&&G.oils.clear('test'); return {plain,kiln}; })()""",
        lambda r:r['plain']>=20 and r['kiln']<=r['plain']*.6,LOOP)

    # leash: lure it off and run; it gives up, walks home and heals
    await run(pg,'leash',120,"""(()=>{ T.play(); const h=G.thornback.homes[2]; let m=h.m; if(!m||!m.alive){ G.thornback.debug.fill(); m=h.m; } const p=G.player; T.flush();
        p.teleport(h.x+9,null,h.z,-Math.PI/2); p.hp=p.maxHp; G.step(1/30,2); T.clear(30,{x:h.x+30,z:h.z});
        const tA=T.until(()=>m.state!=='idle'&&m.state!=='return',4); m.hp=m.maxHp-6; m.cool=99;
        p.teleport(h.x+60,null,h.z-20,Math.PI/2); G.step(1/30,2);
        T.hold(); const tR=T.until(()=>m.state==='return',6); const tI=T.until(()=>m.state==='idle',40);
        return {tA,tR,tI,hp:m.hp,maxHp:m.maxHp,dHome:+Math.hypot(m.pos.x-h.x,m.pos.z-h.z).toFixed(2)}; })()""",
        lambda r:r['tA']>=0 and r['tR']>=0 and r['tI']>=0 and r['hp']==r['maxHp'] and r['dHome']<2.5,LOOP)

    # respawn: minutes after a kill, and only out of sight
    await run(pg,'respawn',120,"""(()=>{ T.play(); T.hold(); const h=G.thornback.homes[0]; if(!h.m)G.thornback.debug.fill(); const p=G.player; T.flush();
        p.teleport(h.x+14,null,h.z,-Math.PI/2); G.step(1/30,2); G.monsters.kill(h.m,{}); T.step(2);
        const w0=G.thornback.debug.homes()[0]; h.wait=.5; T.step(2); const near=G.thornback.debug.homes()[0];
        p.teleport(h.x+70,null,h.z,-Math.PI/2); G.step(1/30,2); T.step(1); const away=G.thornback.debug.homes()[0];
        return {w0,near,away,ev:T.of('thornback:respawn').map(e=>e.id),T:G.thornback.T.respawn}; })()""",
        lambda r:not r['w0']['alive'] and r['T']-3<=r['w0']['wait']<=r['T'] and r['T']>=120 and not r['near']['alive'] and r['away']['alive'] and 'north' in r['ev'],LOOP)

    # save -> reload -> Continue: a dead one stays dead with its timer, the others are there
    saved=await run(pg,'save',60,"""(()=>{ T.home(); G.thornback.debug.fill(); T.step(.2); const h=G.thornback.homes[1]; G.monsters.kill(h.m,{}); T.step(2);
        const ok=G.flow.writeSave(); const d=JSON.parse(localStorage.getItem('bq-save-v1'));
        return {ok,tb:d.mods.thornback,homes:G.thornback.debug.homes()}; })()""",
        lambda r:r['ok'] and r['tb'] and r['tb'].get('v')==1 and 280<=r['tb']['wait'].get('southwest',0)<=300 and 'north' not in r['tb']['wait'],LOOP)
    if saved and 'save' not in failed:
        try: await asyncio.wait_for(reload_continue(pg),300)
        except Exception as e: check('reload',False,{'error':str(e)[:200]})
        await run(pg,'reload-keeps',60,"""(()=>{ T.step(.5); return {mode:G.state.mode,loop:!!G.loop.active,homes:G.thornback.debug.homes(),n:G.thornback.list().filter(m=>m.alive&&!m.dying).length}; })()""",
            lambda r:r['mode']=='play' and r['loop'] and r['n']==2 and [h['alive'] for h in r['homes']]==[True,False,True] and 270<=r['homes'][1]['wait']<=300,LOOP+('save',))
        made=await ev(pg,"""(()=>{ T.play(); G.flow.writeSave(); G.setMode('paused'); const d=JSON.parse(localStorage.getItem('bq-save-v1')); delete d.mods.thornback;
            localStorage.setItem('bq-save-v1',JSON.stringify(d)); return true; })()""")
        if made is True:
            try: await asyncio.wait_for(reload_continue(pg),300)
            except Exception as e: check('reload-old',False,{'error':str(e)[:200]})
            await run(pg,'old-save-loads',60,"""(()=>{ T.step(.5); return {mode:G.state.mode,loop:!!G.loop.active,homes:G.thornback.debug.homes(),n:G.thornback.list().filter(m=>m.alive&&!m.dying).length}; })()""",
                lambda r:r['mode']=='play' and r['loop'] and r['n']==3 and all(h['alive'] for h in r['homes']),LOOP+('save',))
        else: skip('old-save-loads','could not write the old save')
    else:
        skip('reload-keeps','needs save'); skip('old-save-loads','needs save')

    await run(pg,'sounds',30,"""(()=>{ const A=G.audio&&G.audio.thornback; return {has:!!A,synth:A?A.synth:[]}; })()""",
        lambda r:r['has'] and all(k in r['synth'] for k in ['snort','gallop','tusk','glance','hide','hurt','death','stun']),MOD)

# ------------------------------------------------------------------ the Test tools start point (a fresh page)
async def start_suite(b):
    ctx,pg,errs=await boot(b)
    try:
        await ev(pg,LIB)
        await run(pg,'start:thornback',150,"""(()=>{ G.devtools.start('thornback'); G.step(1/30,30); T.settle(10); const p=G.player.pos;
            const near=G.thornback.list().filter(m=>m.alive&&!m.dying).map(m=>+Math.hypot(m.pos.x-p.x,m.pos.z-p.z).toFixed(1)).sort((a,b)=>a-b);
            return {mode:G.state.mode,loop:!!G.loop.active,test:!!G.testSaves,n:G.oils.count('kilnfire'),known:G.alchemy.known.has('kilnfire'),maxHp:G.player.maxHp,hp:G.player.hp,
              near,up:Object.keys((G.progress&&G.progress.state&&G.progress.state.upgrades)||{}).length}; })()""",
            lambda r:r['mode']=='play' and r['loop'] and r['test'] and r['n']==3 and r['known'] and r['maxHp']>=12 and r['hp']==r['maxHp'] and r['near'] and 15<=r['near'][0]<=25 and r['up']>=1)
        await shot(pg,'start-thornback')
    finally:
        real=[e for e in errs if '404' not in e]
        check('start: no page errors',not real,real[:6])
        await ctx.close()

async def main():
    t0=time.time()
    only=os.environ.get('ONLY')   # e.g. ONLY=starts runs just that part (main, starts)
    want=lambda k:not only or k in only.split(',')
    async with async_playwright() as p:
        b=await p.chromium.launch(**CHROME)
        for k,fn,budget in [('main',lambda:main_suite(b),1800),('starts',lambda:start_suite(b),500)]:
            if not want(k): continue
            try: await asyncio.wait_for(fn(),budget)
            except asyncio.TimeoutError: check(k+'-suite',False,{'timeout':budget})
            except Exception as e: check(k+'-suite',False,{'error':str(e)[:300]})
        await b.close()
    print('RESULT', 'PASS' if ok_all else 'FAIL '+', '.join(sorted(failed)), f"{counts['ok']} ok, {counts['fail']} failed", f'{time.time()-t0:.0f}s', flush=True)
    sys.exit(0 if ok_all else 1)

asyncio.run(main())
