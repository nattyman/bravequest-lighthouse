"""Staff oils, third slice: sap from the Resisting Tree and an oil fixed in the staff (forage.js, world.js, oils.js,
progression.js, audio.js, devtools.js). Spec: OILS.md.
Covers, each check reading its state through G.forage / G.world.resistingTree / G.oils / G.progress / G.inv:
- the tree: no "Draw sap" before the core loop; three draws with a real E press (a Heartsap each, the light, halo and motes a
  clear step dimmer each time, a caption each); after three the prompt warns and opens a card, whose two answers are taken
  with real keys (leave it: nothing changes; take it: the tree dies, its light, halo and motes go out, the canopy greys);
  no prompt once it is dead; restore() puts every handle back exactly as built;
- save -> reload -> Continue at two draws and when dead; an older save loads with the tree whole and nothing fixed;
- the Temper tab's Fix section: a row only for known oils, the seven upgrades unchanged, what is missing spelled out, the exact
  cost taken (3 flasks, 1 Heartsap, 3 Marks), the progress banner visible while it works; the fixed Kilnfire burns 2 s with no
  coat, a Kilnfire coat burns the full 3 s, a Burst coat on top keeps the fixed burn; fixing another oil replaces it and costs
  again; the Journal's line, the staff's tint and the HUD's mark; save -> reload with an oil fixed;
- the sounds for these events; the Fix row driven by a controller and by touch; the 'oils-tree' Test tools start point.
Each check has its own time budget; a check whose groundwork failed is reported SKIP (and counts as failed).
usage: python3 test/oils_fixed_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)
Screenshots go to /tmp/claude-0/oils-fixed-tests/."""
import asyncio, sys, json, os, time
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
OUT='/tmp/claude-0/oils-fixed-tests'; os.makedirs(OUT,exist_ok=True)
CHROME=dict(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
failed=set(); ok_all=True
def check(name,ok,info):
    global ok_all
    ok_all=ok_all and bool(ok)
    if not ok: failed.add(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name:24s} {json.dumps(info,default=str)[:700]}",flush=True)
def skip(name,why):
    global ok_all
    ok_all=False; failed.add(name); print(f"SKIP {name:24s} {why}",flush=True)

# helpers installed in the page after every load
LIB=r"""
window.T=(()=>{
const P=()=>G.player, O=()=>G.oils, F=()=>G.forage, RT=()=>G.world.resistingTree;
const SPOT={x:150,y:42.2,z:-14,yaw:Math.PI*.5};          // the open headland: room to fight, far from every monster zone
const step=s=>G.step(1/30,Math.max(1,Math.round(s*30)));
const ev=[];
const pick=(n,e)=>{ const o={n}; if(e)for(const k of ['id','prev','draws','item','reason','damage'])if(e[k]!==undefined)o[k]=e[k]; o.t=+G.time.toFixed(2); return o; };
for(const n of ['tree:sap','tree:dead','tree:restored','oil:fixed','progress:fix','oil:burn','oil:ignite','inv:change'])G.on(n,e=>ev.push(pick(n,e)));
const said=[];
{ const s=G.ui.say; G.ui.say=function(t,who,...a){ said.push({t:String(t),who:typeof who==='string'?who:(who&&who.who)||null}); return s.call(this,t,who,...a); }; }
function of(n){ return ev.filter(e=>e.n===n); }
function flush(){ ev.length=0; said.length=0; }
function play(){ if(!document.getElementById('pause').hidden)document.getElementById('resume').click(); if(G.talk&&G.talk.isOpen)G.talk.close();
  if(G.alchemy&&G.alchemy.closeTable&&!document.getElementById('alchemy').hidden)G.alchemy.closeTable();
  if(G.state.mode!=='play'&&G.state.mode!=='dead')G.setMode('play'); }
function hold(){ const p=P(); if(p.alive!==false)p.hp=p.maxHp; }
function settle(n){ play(); for(let i=0;i<(n||10);i++){ hold(); G.step(1/30,1); } if(G.progress&&G.progress.endReward)G.progress.endReward(); play(); }
function clear(r){ let n=0; for(const m of G.monsters.list.slice())if(m.alive&&!m.dying&&m.pos.distanceTo(P().pos)<(r||40)){ G.monsters.despawn(m); n++; } return n; }
function home(){ play(); clear(60); const p=P(); p.teleport(SPOT.x,null,SPOT.z,SPOT.yaw); if(p.aimCamera)p.aimCamera(SPOT.yaw,.26); hold(); step(.3); clear(60); }
function foe(kind,d){ const p=P(), h=p.heading!=null?p.heading:SPOT.yaw; const x=p.pos.x+Math.sin(h)*(d||2.2), z=p.pos.z+Math.cos(h)*(d||2.2);
  const m=G.monsters.spawn(kind,{x,y:p.pos.y,z},{aggro:false}); m.cool=99; return m; }
function hit(m){ return G.combat.strike({x:m.pos.x,y:m.pos.y+1,z:m.pos.z,radius:.7,team:'player',damage:2,knockback:2,kind:'melee',source:P()}).length; }
/** a 40 hp hollow struck once: how many burn ticks follow (and the damage they do) */
function burnTicks(){ home(); flush(); const m=foe('hollow'); m.hp=m.maxHp=40; hit(m); for(let i=0;i<150;i++){ hold(); G.step(1/30,1); }
  const t=of('oil:burn'); const out={ticks:t.length,dmg:t.reduce((a,e)=>a+(e.damage||0),0),hp:m.hp}; G.monsters.despawn(m); return out; }
function sapOffers(r){ const p=F().tree.pos, out=[]; for(const o of G.interact.list){ if(o.enabled&&!o.enabled())continue; const q=typeof o.pos==='function'?o.pos():o.pos; if(!q)continue;
  if(Math.hypot(q.x-p.x,q.z-p.z)>(r||1))continue; const l=G.interact.label(o); if(/sap/i.test(String(l)))out.push(l); } return out; }
function picked(){ const c=G.interact.pick(P().pos); return c?String(G.interact.label(c)):null; }
function look(){ const R=RT(); return {life:+R.life.toFixed(3),glow:+(R.glow!=null?R.glow:R.life).toFixed(3),dead:R.dead,light:+(R.light?R.light.intensity:0).toFixed(3),
  dist:R.light?+R.light.distance.toFixed(2):null,halo:+R.halo.material.opacity.toFixed(3),haloV:R.halo.visible,haloS:+R.halo.scale.x.toFixed(3),
  motes:R.motes.visible,uLife:+R.motes.material.uniforms.uLife.value.toFixed(3),em:+R.trunk.material.emissiveIntensity.toFixed(3)}; }
/** a checksum of everything set() touches, to compare against the tree as built */
function sig(){ const R=RT(), a=R.canopy.geometry.attributes.color.array, b=R.trunk.geometry.attributes.color.array; let s1=0, s2=0;
  for(let i=0;i<a.length;i++)s1+=a[i]*((i%7)+1); for(let i=0;i<b.length;i++)s2+=b[i]*((i%5)+1);
  return {leaf:+s1.toFixed(4),wood:+s2.toFixed(4),lem:R.canopy.material.emissive.getHexString(),lemI:+R.canopy.material.emissiveIntensity.toFixed(3),
    tem:R.trunk.material.emissive.getHexString(),temI:+R.trunk.material.emissiveIntensity.toFixed(3),halo:+R.halo.material.opacity.toFixed(4),haloS:[R.halo.scale.x,R.halo.scale.y].map(v=>+v.toFixed(4)),
    haloV:R.halo.visible,motes:R.motes.visible,uLife:R.motes.material.uniforms.uLife.value,dist:R.light.distance}; }
/** mean grey-ness of the canopy (0 = as green as built) */
function ash(){ const a=RT().canopy.geometry.attributes.color.array; let sat=0, lum=0, n=0; for(let i=0;i<a.length;i+=3){ const mx=Math.max(a[i],a[i+1],a[i+2]), mn=Math.min(a[i],a[i+1],a[i+2]); sat+=mx-mn; lum+=a[i]*.3+a[i+1]*.55+a[i+2]*.15; n++; }
  return {sat:+(sat/n).toFixed(4),lum:+(lum/n).toFixed(4)}; }
function atTree(){ play(); clear(80); F().debug.tpTree(); G.step(1/30,4); }
function marks(n){ const d=n-G.progress.marks; if(d>0)G.progress.give('mark',d); return G.progress.marks; }
function setFlasks(id,n){ O().take(id,O().count(id)); if(n)O().debug.give(id,n); return O().count(id); }
function setSap(n){ G.inv.take('sap',G.inv.count('sap')); if(n)G.inv.add('sap',n,{silent:true}); return G.inv.count('sap'); }
function openFix(){ play(); G.alchemy.openTable(); G.step(1/30,3); document.getElementById('tabTemper').click(); G.step(1/30,2); return !document.getElementById('alchemy').hidden; }
function fixRow(id){ const r=document.querySelector('#temperList [data-fix-row="'+id+'"]'); if(!r)return null; const b=r.querySelector('[data-fix]'), m=r.querySelector('.miss');
  return {cls:r.className,btn:!!b,enabled:!!b&&!b.disabled,miss:m?m.textContent:'',own:(r.querySelector('.own')||{}).textContent||''}; }
function temperRows(){ const L=[...document.querySelectorAll('#temperList .tmp-up')]; return {all:L.length,up:L.filter(e=>!e.classList.contains('fix')).length,fix:L.filter(e=>e.classList.contains('fix')).map(e=>e.dataset.fixRow)}; }
function busy(){ const b=document.querySelector('#temperList .tmp-busy'); if(!b)return null; const r=b.getBoundingClientRect(), pr=document.getElementById('alchemy').getBoundingClientRect();
  const sec=[...document.querySelectorAll('#temperList .tmp-sec')].pop(), afterSec=!!sec&&!!(sec.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);
  let sc=b.parentElement, clipTop=pr.top, clipBot=pr.bottom; while(sc&&sc!==document.body){ const s=getComputedStyle(sc); if(/(auto|scroll|hidden)/.test(s.overflowY)){ const q=sc.getBoundingClientRect(); clipTop=Math.max(clipTop,q.top); clipBot=Math.min(clipBot,q.bottom); } sc=sc.parentElement; }
  return {text:b.textContent,inView:r.top>=Math.max(0,clipTop)-2&&r.bottom<=Math.min(innerHeight,clipBot)+2&&r.height>0,afterSec,top:Math.round(r.top),bot:Math.round(r.bottom),clip:[Math.round(clipTop),Math.round(clipBot)]}; }
/** measure the working banner the moment the bench starts (and once more a second in) */
function watchBusy(){ window.__busy=null; window.__busy2=null; if(!window.__bw){ window.__bw=1; G.on('progress:tempering',()=>{ window.__busy=busy(); setTimeout(()=>{ window.__busy2=busy(); },1000); }); } }
function st(){ const o=O(); return {fixed:o.fixed,str:o.strength('kilnfire'),has:o.has('kilnfire'),k:o.count('kilnfire'),b:o.count('burst'),sap:G.inv.count('sap'),marks:G.progress.marks,active:o.active&&o.active.id}; }
return {P,O,F,RT,SPOT,step,ev,of,flush,said,play,hold,settle,clear,home,foe,hit,burnTicks,sapOffers,picked,look,sig,ash,atTree,marks,setFlasks,setSap,openFix,fixRow,temperRows,busy,watchBusy,st};
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

def watch(pg,errs):
    pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
    pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)

async def boot(b,**kw):
    errs=[]
    init=kw.pop('init',None)
    ctx=await b.new_context(**(kw or {'viewport':{'width':1000,'height':620}}))
    if init: await ctx.add_init_script(init)
    pg=await ctx.new_page(); pg.set_default_timeout(240000); watch(pg,errs)
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

async def key(pg,code,frames=4):
    await pg.keyboard.press(code)
    await ev(pg,f"(()=>{{ G.step(1/30,{frames}); return 1; }})()")

async def save_reload(pg,name,js_setup,needs):
    """write the save after js_setup, reload and Continue; returns True when the reload went through"""
    if any(n in failed for n in needs): return False
    try:
        ok=await ev(pg,"(()=>{ "+js_setup+"; T.settle(5); return G.flow.writeSave(); })()",60)
        await asyncio.wait_for(reload_continue(pg),300); return bool(ok)
    except Exception as e:
        check(name+' (reload)',False,{'error':str(e)[:200]}); return False

# ------------------------------------------------------------------ the main run: one game, real save slot
async def main_suite(b):
    ctx,pg,errs=await boot(b)
    try: await main_checks(pg)
    finally:
        real=[e for e in errs if '404' not in e]
        check('main: no page errors',not real,real[:6])
        await ctx.close()

DRAW_SAY=['slow and violet','Less this time','A few drops']

async def main_checks(pg):
    await ev(pg,"(()=>{ document.getElementById('begin').click(); G.step(1/30,40); return 1; })()",120)
    await ev(pg,LIB)
    await ev(pg,"(()=>{ if(G._onb)G._onb.S.seen.opening=1; if(G.progress&&G.progress.endReward)G.progress.endReward(); T.play(); G.step(1/30,5); return 1; })()")

    MOD=('modules',)
    built=await run(pg,'modules',30,"""(()=>{ const F=G.forage, R=G.world.resistingTree, PF=G.progress.fix, O=G.oils, A=G.audio&&G.audio.oils;
        window.__sig0=T.sig(); window.__ash0=T.ash(); window.__look0=T.look();
        return {tree:!!(F&&F.tree&&F.tree.pos&&typeof F.tree.restore==='function'),draws:F.tree.draws,dead:F.tree.dead,rt:!!(R&&typeof R.set==='function'&&R.light&&R.halo&&R.motes&&R.canopy),
          fix:!!(PF&&['now','can','missing','temper','rows'].every(k=>typeof PF[k]==='function')&&PF.cost),cost:PF&&PF.cost,oils:typeof O.fix==='function'&&typeof O.unfix==='function',
          sap:!!G.inv.ITEMS.sap,sounds:!!(A&&A.synth&&['sap','dead','restored','fixed'].every(k=>typeof A.synth[k]==='function')),look:__look0}; })()""",
        lambda r:r['tree'] and r['draws']==0 and not r['dead'] and r['rt'] and r['fix'] and r['cost']=={'flask':3,'sap':1,'mark':3} and r['oils'] and r['sap'] and r['sounds']
                 and r['look']['life']==1 and r['look']['haloV'] and r['look']['motes'])

    # before the core loop: the roots offer nothing
    await run(pg,'no-sap-before-loop',60,"""(()=>{ T.flush(); const loop=!!G.loop.active; T.atTree(); const offers=T.sapOffers(), lab=T.picked(), s0=G.inv.count('sap');
        const d=G.forage.debug.draw(); G.step(1/30,3); return {loop,offers,lab,drew:d,sap:G.inv.count('sap')-s0,draws:G.forage.tree.draws,ev:T.of('tree:sap').length}; })()""",
        lambda r:not r['loop'] and not r['offers'] and not (r['lab'] and 'sap' in r['lab'].lower()) and not r['drew'] and r['sap']==0 and r['draws']==0 and r['ev']==0,MOD)
    await run(pg,'loop-start',90,"(()=>{ G.debugStartLoop(); T.settle(30); return {loop:!!G.loop.active,mode:G.state.mode}; })()",
        lambda r:r['loop'] and r['mode']=='play',MOD)
    LOOP=MOD+('loop-start',)

    # three draws, each with a real E press at the roots
    await run(pg,'sap-offered',60,"(()=>{ T.atTree(); T.flush(); window.__sap0=G.inv.count('sap'); window.__looks=[T.look()]; window.__ashes=[T.ash()]; return {lab:T.picked(),offers:T.sapOffers()}; })()",
        lambda r:r['lab']=='Draw sap' and r['offers']==['Draw sap'],LOOP)
    for i in range(3):
        if 'sap-offered' in failed: skip(f'draw-{i+1}','needs sap-offered'); continue
        await key(pg,'KeyE',4)
        await run(pg,f'draw-{i+1}',60,f"""(()=>{{ const l=T.look(); __looks.push(l); __ashes.push(T.ash()); const e=T.of('tree:sap').map(x=>x.draws), s=T.said.map(x=>x);
            const out={{draws:G.forage.tree.draws,ev:e,sap:G.inv.count('sap')-__sap0,look:l,said:s.map(x=>x.t.slice(0,40)),who:s.map(x=>x.who),lab:T.picked(),card:!!(G.talk&&G.talk.isOpen)}};
            T.settle(40); T.atTree(); return out; }})()""",
            (lambda i:lambda r:r['draws']==i+1 and r['ev'][-1]==i+1 and len(r['ev'])==i+1 and r['sap']==i+1 and any(DRAW_SAY[i] in s for s in r['said'])
                     and all(w in (None,'') for w in r['who']) and not r['card'] and r['lab']==('Draw sap (the tree will not survive)' if i==2 else 'Draw sap'))(i),LOOP+('sap-offered',))
        if i==1: await shot(pg,'tree-two-draws')
    # each draw a clear step down: the light, its reach, the halo (and its size), the motes and the violet in the wood
    await run(pg,'dimming-steps',30,"(()=>({looks:__looks,ashes:__ashes}))()",
        lambda r:len(r['looks'])==4 and all(abs(r['looks'][k]['life']-(1-.22*k))<.011 for k in range(4))
                 and all(r['looks'][k+1]['glow']<=r['looks'][k]['glow']*.7 for k in range(3))
                 and all(r['looks'][k+1]['halo']<=r['looks'][k]['halo']*.7 and r['looks'][k+1]['haloS']<r['looks'][k]['haloS'] for k in range(3))
                 and all(r['looks'][k+1]['uLife']<=r['looks'][k]['uLife']*.7 and r['looks'][k+1]['em']<r['looks'][k]['em'] for k in range(3))
                 and all(r['looks'][k+1]['dist']<r['looks'][k]['dist'] for k in range(3))
                 and r['looks'][3]['glow']<.2 and r['looks'][3]['haloV'] and r['looks'][3]['motes'] and not r['looks'][3]['dead'],LOOP+('draw-3',))
    await shot(pg,'tree-three-draws')

    # the fourth: the prompt opens the warning card; "Leave it be" (real keys) changes nothing
    WARN=LOOP+('draw-3',)
    async def open_card():
        await key(pg,'KeyE',4)
        # finish the typing and reach the choices with real Enter presses
        for _ in range(8):
            n=await ev(pg,"(()=>{ const s=G.talk&&G.talk.isOpen?G.talk.state():null; return s?s.choices.length:-1; })()")
            if n!=0: break
            await key(pg,'Enter',3)
    if 'draw-3' not in failed:
        await ev(pg,"(()=>{ T.flush(); window.__s3=G.inv.count('sap'); return 1; })()")
        await open_card()
        await run(pg,'warning-card',30,"""(()=>{ const s=G.talk.isOpen?G.talk.state():null; return {open:G.talk.isOpen,who:s&&(s.who||s.name),shown:s&&s.shown,choices:s&&s.choices,mode:G.state.mode}; })()""",
            lambda r:r['open'] and 'Rowan' in str(r['who']) and r['choices']==['Leave it be','Take the last of it'] and 'tree dies' in (r['shown'] or ''),WARN)
        await shot(pg,'tree-warning')
        await key(pg,'Digit1',4)
        await run(pg,'warning-leave',30,"""(()=>{ G.step(1/30,4); const out={open:G.talk.isOpen,draws:G.forage.tree.draws,dead:G.forage.tree.dead,sap:G.inv.count('sap')-__s3,ev:T.of('tree:dead').length,look:T.look()};
            T.settle(10); T.atTree(); out.lab=T.picked(); return out; })()""",
            lambda r:not r['open'] and r['draws']==3 and not r['dead'] and r['sap']==0 and r['ev']==0 and r['look']['haloV'] and r['lab']=='Draw sap (the tree will not survive)',WARN+('warning-card',))
        # again, and "Take the last of it" with the arrow key and Enter: the tree dies
        await ev(pg,"(()=>{ T.flush(); return 1; })()")
        await open_card()
        await key(pg,'ArrowDown',2)
        await key(pg,'Enter',4)
        await run(pg,'tree-dies',60,"""(()=>{ G.step(1/30,4); const l=T.look(), a=T.ash(); const out={open:G.talk.isOpen,draws:G.forage.tree.draws,dead:G.forage.tree.dead,sap:G.inv.count('sap')-__s3,
            dead_ev:T.of('tree:dead').length,sap_ev:T.of('tree:sap').map(e=>e.draws),said:T.said.map(x=>x.t.slice(0,44)),look:l,ash:a,ash0:__ash0,
            em:{leaf:+G.world.resistingTree.canopy.material.emissiveIntensity.toFixed(3),hex:G.world.resistingTree.canopy.material.emissive.getHexString()},log:G.audio.oils.log.slice(-4)};
            return out; })()""",
            lambda r:not r['open'] and r['dead'] and r['draws']==4 and r['sap']==1 and r['dead_ev']==1 and r['sap_ev']==[4] and any('light goes out' in s for s in r['said'])
                     and r['look']['light']==0 and not r['look']['haloV'] and not r['look']['motes'] and r['look']['em']==0
                     and r['ash']['sat']<r['ash0']['sat'] and r['ash']['lum']>r['ash0']['lum']*2.5,WARN+('warning-card',))
    else:
        for n in ('warning-card','warning-leave','tree-dies'): skip(n,'needs draw-3')
    await ev(pg,"(()=>{ T.settle(20); T.atTree(); return 1; })()")
    await shot(pg,'tree-dead')
    DEAD=WARN+('tree-dies',)
    await ev(pg,"(()=>{ T.flush(); window.__sd=G.inv.count('sap'); return 1; })()")
    await key(pg,'KeyE',4)
    await run(pg,'no-prompt-when-dead',30,"""(()=>({offers:T.sapOffers(),lab:T.picked(),card:G.talk.isOpen,sap:G.inv.count('sap')-__sd,ev:T.of('tree:sap').length,drew:G.forage.debug.draw()}))()""",
        lambda r:not r['offers'] and not (r['lab'] and 'sap' in r['lab'].lower()) and not r['card'] and r['sap']==0 and r['ev']==0 and not r['drew'],DEAD)

    # restore(): every handle back exactly as the tree was built
    await run(pg,'restore',30,"""(()=>{ T.flush(); G.forage.tree.restore(); G.step(1/30,3); const s=T.sig();
        return {draws:G.forage.tree.draws,dead:G.forage.tree.dead,ev:T.of('tree:restored').length,same:JSON.stringify(s)===JSON.stringify(__sig0),sig:s,sig0:__sig0,look:T.look(),lab:(T.atTree(),T.picked())}; })()""",
        lambda r:r['draws']==0 and not r['dead'] and r['ev']==1 and r['same'] and r['look']['life']==1 and r['look']['haloV'] and r['lab']=='Draw sap',MOD)

    # save at two draws -> reload -> Continue
    if await save_reload(pg,'save-two',"T.atTree(); G.forage.debug.draw(); G.forage.debug.draw(); T.settle(30); window.__l2=0",LOOP+('restore',)):
        await run(pg,'reload-two-draws',60,"""(()=>{ T.atTree(); return {draws:G.forage.tree.draws,dead:G.forage.tree.dead,look:T.look(),lab:T.picked()}; })()""",
            lambda r:r['draws']==2 and not r['dead'] and abs(r['look']['life']-.56)<.011 and r['look']['haloV'] and r['lab']=='Draw sap',LOOP+('restore',))
    else: skip('reload-two-draws','save did not go through')
    if await save_reload(pg,'save-dead',"G.forage.debug.kill(); T.settle(30)",LOOP+('restore',)):
        await run(pg,'reload-dead',60,"""(()=>{ T.atTree(); return {draws:G.forage.tree.draws,dead:G.forage.tree.dead,look:T.look(),ash:T.ash(),offers:T.sapOffers()}; })()""",
            lambda r:r['dead'] and r['draws']==4 and r['look']['light']==0 and not r['look']['haloV'] and not r['look']['motes'] and not r['offers'],LOOP+('restore',))
    else: skip('reload-dead','save did not go through')
    await ev(pg,"(()=>{ G.forage.tree.restore(); window.__sig0=window.__sig0||T.sig(); return 1; })()")

    # the Fix section: rows only for known oils; what is missing is spelled out
    FIX=LOOP
    await run(pg,'fix-rows',60,"""(()=>{ T.home(); const A=G.alchemy; if(!A.known.has('kilnfire'))A.learn('kilnfire',{silent:true});
        T.setFlasks('kilnfire',1); T.setFlasks('burst',0); T.setSap(0); const m0=G.progress.marks; window.__m0=m0;
        const open=T.openFix(); const rows=T.temperRows(), row=T.fixRow('kilnfire');
        return {open,rows,row,ups:G.progress.UPGRADES.length,api:G.progress.fix.rows(),can:G.progress.fix.can('kilnfire'),missing:G.progress.fix.missing('kilnfire'),marks:m0,
          known:['kilnfire','burst','holly'].filter(k=>A.known.has(k))}; })()""",
        lambda r:r['open'] and r['ups']==7 and r['rows']['up']==7 and r['rows']['fix']==r['api']==r['known'] and r['rows']['fix']==['kilnfire']
                 and r['row'] and r['row']['btn'] and not r['row']['enabled'] and not r['can'] and '2 more Kilnfire flasks' in r['row']['miss'] and 'Heartsap' in r['row']['miss']
                 and any(m['k']=='flask' and m['n']==2 for m in r['missing']) and any(m['k']=='sap' and m['n']==1 for m in r['missing']),FIX)
    await shot(pg,'fix-missing')
    # exactly enough: 3 flasks, 1 sap, 3 Marks; a real mouse click on Fix; the working banner is in view, then the cost is taken
    ready_fix=await run(pg,'fix-ready',60,"""(()=>{ T.setFlasks('kilnfire',3); T.setSap(2); const m=T.marks(3); G.step(1/30,2); T.openFix(); window.__before=T.st();
        return {row:T.fixRow('kilnfire'),can:G.progress.fix.can('kilnfire'),before:__before,rows:T.temperRows()}; })()""",
        lambda r:r['can'] and r['row']['enabled'] and not r['row']['miss'] and r['before']['marks']>=3 and r['rows']['up']==7,FIX+('fix-rows',))
    if ready_fix and 'fix-ready' not in failed:
        await ev(pg,"(()=>{ T.flush(); T.watchBusy(); const l=document.getElementById('temperList'); let s=l; while(s&&s!==document.body){ s.scrollTop=0; s=s.parentElement; } document.getElementById('alchemy').scrollTop=0; return 1; })()")
        try:
            await pg.click('#temperList [data-fix=kilnfire]',timeout=30000); clicked=True
        except Exception as e: check('fix-click',False,{'error':str(e)[:200]}); clicked=False
        if clicked:
            await pg.wait_for_timeout(700)
            await run(pg,'fix-working-banner',30,"(()=>({busy:__busy,later:__busy2}))()",
                lambda r:r['busy'] and 'Kilnfire' in r['busy']['text'] and r['busy']['afterSec'] and r['busy']['inView'] and (r['later'] is None or r['later']['inView']),FIX+('fix-ready',))
            await shot(pg,'fix-working')
            await pg.wait_for_timeout(3200)
            await run(pg,'fix-cost',60,"""(()=>{ const a=T.st(), b=__before; const out={after:a,spent:{flask:b.k-a.k,sap:b.sap-a.sap,mark:b.marks-a.marks},ev:T.of('oil:fixed'),pev:T.of('progress:fix'),
                row:T.fixRow('kilnfire'),rows:T.temperRows(),log:G.audio.oils.log.slice(-3)}; T.settle(10); return out; })()""",
                lambda r:r['after']['fixed']=='kilnfire' and r['spent']=={'flask':3,'sap':1,'mark':3} and len(r['ev'])==1 and r['ev'][0].get('id')=='kilnfire' and r['ev'][0].get('prev') is None
                         and len(r['pev'])==1 and r['row']['own']=='Fixed' and r['rows']['up']==7 and 'fixed' in r['log'],FIX+('fix-ready',))
    else:
        for n in ('fix-working-banner','fix-cost'): skip(n,'needs fix-ready')
    FIXED=FIX+('fix-cost',)
    # the fixed Kilnfire: always on, the gentler burn; a Kilnfire coat gives the full burn; a Burst coat on top keeps the fixed one
    await run(pg,'fixed-burn',120,"""(()=>{ G.oils.clear('debug'); const s0=T.st(); const plain=T.burnTicks();
        G.oils.debug.coat('kilnfire',60); const s1=T.st(); const coat=T.burnTicks(); G.oils.clear('debug');
        if(!G.alchemy.known.has('burst'))G.alchemy.learn('burst',{silent:true}); G.oils.debug.coat('burst',60); const s2=T.st(); const burst=T.burnTicks(); G.oils.clear('debug');
        return {s0,plain,s1,coat,s2,burst}; })()""",
        lambda r:r['s0']['str']=='fixed' and r['s0']['has'] and r['s0']['active'] is None and r['plain']['ticks']==2 and r['plain']['hp']==36
                 and r['s1']['str']=='coat' and r['coat']['ticks']==3 and r['coat']['hp']==35
                 and r['s2']['active']=='burst' and r['s2']['str']=='fixed' and r['burst']['ticks']==2 and r['burst']['hp']==36,FIXED)
    # the Journal's "What you carry", the staff's faint tint, the HUD's mark
    await run(pg,'journal-hud',60,"""(()=>{ T.play(); G.step(1/30,4); const chip=document.querySelector('.oil-chip'), fx=chip&&chip.querySelector('.fx'); const so=G.player.staffOil;
        G.setMode('paused'); G.progress.journal.open(); G.progress.journal.tab('carry'); const on=[...document.querySelectorAll('#journalBody .jr-fixed span')].map(s=>({t:s.textContent,on:s.classList.contains('on'),id:s.dataset.oil}));
        const d=G.progress.journal.data(); G.progress.journal.close(); T.play();
        return {d:{fixed:d.fixed,oils:d.oils},on,chip:!!chip&&!chip.hidden,fx:fx&&{cls:fx.className,title:fx.title,text:fx.textContent},staff:so&&{color:so.color,k:so.k}}; })()""",
        lambda r:r['d']['fixed']=='kilnfire' and any(s['id']=='kilnfire' and s['on'] and 'fixed' in s['t'] for s in r['on']) and not any(s['on'] for s in r['on'] if s['id']!='kilnfire')
                 and r['chip'] and r['fx'] and ' on' in r['fx']['cls'] and 'Kilnfire' in r['fx']['title'] and r['staff'] and r['staff']['color'].lower()=='#e3a13a' and 0<r['staff']['k']<1,FIXED)
    await ev(pg,"(()=>{ T.home(); G.step(1/30,4); return 1; })()")
    await shot(pg,'hud-fixed')
    # fixing another oil takes Kilnfire's place, and costs again
    await run(pg,'fix-replaces',60,"""(()=>{ T.flush(); T.setFlasks('burst',3); T.setSap(1); T.marks(3); const b=T.st(); const ok=G.progress.fix.now('burst'); T.settle(10); const a=T.st();
        return {ok,b,a,spent:{flask:b.b-a.b,sap:b.sap-a.sap,mark:b.marks-a.marks},kept:a.k-b.k,ev:T.of('oil:fixed'),str:G.oils.strength('burst'),kil:G.oils.strength('kilnfire'),
          again:G.progress.fix.can('kilnfire')}; })()""",
        lambda r:r['ok'] and r['a']['fixed']=='burst' and r['spent']=={'flask':3,'sap':1,'mark':3} and r['kept']==0 and len(r['ev'])==1 and r['ev'][0].get('id')=='burst'
                 and r['ev'][0].get('prev')=='kilnfire' and r['str']=='fixed' and r['kil'] in (0,None,False),FIXED)
    # save with an oil fixed -> reload: still fixed, and still gentle
    if 'fix-replaces' not in failed and await save_reload(pg,'save-fixed',"G.progress.fix.now('kilnfire',{free:true,silent:true}); window.__x=1",FIXED+('fix-replaces',)):
        await run(pg,'reload-fixed',120,"(()=>{ const s=T.st(); const b=T.burnTicks(); return {s,b,journal:G.progress.journal.data().fixed}; })()",
            lambda r:r['s']['fixed']=='kilnfire' and r['s']['str']=='fixed' and r['s']['active'] is None and r['b']['ticks']==2 and r['journal']=='kilnfire',FIXED+('fix-replaces',))
    else: skip('reload-fixed','needs fix-replaces and the save')

    # an older save, written before slice 3: no tree state, nothing fixed
    made=await ev(pg,"""(()=>{ T.play(); G.forage.debug.kill(); G.flow.writeSave(); G.setMode('paused'); const d=JSON.parse(localStorage.getItem('bq-save-v1'));
        if(d.mods.forage)delete d.mods.forage.tree; if(d.mods.oils)delete d.mods.oils.fixed; localStorage.setItem('bq-save-v1',JSON.stringify(d)); return true; })()""")
    if made is True:
        try: await asyncio.wait_for(reload_continue(pg),300); okr=True
        except Exception as e: check('reload-old',False,{'error':str(e)[:200]}); okr=False
        if okr:
            await run(pg,'old-save-loads',60,"""(()=>{ T.atTree(); return {mode:G.state.mode,loop:!!G.loop.active,draws:G.forage.tree.draws,dead:G.forage.tree.dead,look:T.look(),fixed:G.oils.fixed,
                lab:T.picked()}; })()""",
                lambda r:r['mode']=='play' and r['loop'] and r['draws']==0 and not r['dead'] and r['look']['life']==1 and r['look']['haloV'] and r['fixed'] is None and r['lab']=='Draw sap',LOOP)
    else: skip('old-save-loads','could not write the old save')

# ------------------------------------------------------------------ the Fix row with a controller, and on touch (the 'oils-tree' start point)
PAD_JS=r"""
window.__pad={id:'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',index:0,connected:true,mapping:'standard',timestamp:0,axes:[0,0,0,0],
  buttons:Array.from({length:17},()=>({pressed:false,touched:false,value:0}))};
window.__btn=(i,on)=>{ __pad.buttons[i]={pressed:!!on,touched:!!on,value:on?1:0}; __pad.timestamp++; };
window.__tap=(i,f)=>{ __btn(i,true); G.step(1/30,f||2); __btn(i,false); G.step(1/30,f||2); };
navigator.getGamepads=()=>[__pad,null,null,null];
"""
START_TREE="""(()=>{ G.devtools.start('oils-tree'); G.step(1/30,30); T.settle(10); const t=G.forage.tree.pos, p=G.player.pos;
    return {mode:G.state.mode,loop:!!G.loop.active,test:!!G.testSaves,n:G.oils.count('kilnfire'),total:G.oils.total(),marks:G.progress.marks,known:G.alchemy.known.has('kilnfire'),
      d:+Math.hypot(t.x-p.x,t.z-p.z).toFixed(2),lab:T.picked(),draws:G.forage.tree.draws,dead:G.forage.tree.dead,sap:G.inv.count('sap'),fixed:G.oils.fixed}; })()"""
def start_ok(r):
    return r['mode']=='play' and r['loop'] and r['test'] and r['n']==3 and r['total']==3 and r['marks']==3 and r['known'] and r['d']<6.2 and r['lab']=='Draw sap' \
        and r['draws']==0 and not r['dead'] and r['sap']==0 and r['fixed'] is None

async def pad_suite(b):
    ctx,pg,errs=await boot(b,viewport={'width':1000,'height':620},init=PAD_JS)
    try:
        await ev(pg,LIB)
        await run(pg,'pad:start',120,START_TREE,start_ok)
        N=('pad:start',)
        # Y at the roots draws the sap
        await run(pg,'pad:draw',60,"(()=>{ T.flush(); __tap(3,3); G.step(1/30,4); return {draws:G.forage.tree.draws,sap:G.inv.count('sap'),pad:G.input.device}; })()",
            lambda r:r['draws']==1 and r['sap']==1,N)
        # the Temper tab: the D-pad walks down to the Fix button, A presses it
        await run(pg,'pad:to-fix',60,"""(()=>{ T.settle(20); T.openFix(); let f=null, n=0;
            for(;n<24;n++){ f=document.activeElement; if(f&&f.dataset&&f.dataset.fix==='kilnfire')break; __tap(13,2); }
            return {focus:f&&f.dataset?(f.dataset.fix||f.dataset.buy||f.id):null,presses:n,padFocus:!!(f&&f.classList.contains('pad-focus')),enabled:!!(f&&!f.disabled)}; })()""",
            lambda r:r['focus']=='kilnfire' and r['enabled'] and r['padFocus'],N+('pad:draw',))
        if 'pad:to-fix' not in failed:
            await ev(pg,"(()=>{ window.__before=T.st(); T.watchBusy(); __tap(0,2); return 1; })()")
            await pg.wait_for_timeout(600)
            await run(pg,'pad:banner',30,"(()=>({busy:__busy}))()",lambda r:r['busy'] and r['busy']['inView'] and r['busy']['afterSec'],N+('pad:to-fix',))
            await shot(pg,'pad-fix-working')
            await pg.wait_for_timeout(3200)
            await run(pg,'pad:fixed',30,"(()=>{ const a=T.st(), b=__before; return {a,spent:{flask:b.k-a.k,sap:b.sap-a.sap,mark:b.marks-a.marks}}; })()",
                lambda r:r['a']['fixed']=='kilnfire' and r['spent']=={'flask':3,'sap':1,'mark':3},N+('pad:to-fix',))
        else:
            for n in ('pad:banner','pad:fixed'): skip(n,'needs pad:to-fix')
    finally:
        real=[e for e in errs if '404' not in e]
        check('pad: no page errors',not real,real[:6])
        await ctx.close()

TOUCH_JS=r"""
window.TBA=a=>document.querySelector('#touch button[data-act='+a+']');
window.TPA=(a,t)=>TBA(a).dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerType:'touch',pointerId:9,isPrimary:true}));
'ok'"""
async def touch_suite(b):
    ctx,pg,errs=await boot(b,viewport={'width':844,'height':390},is_mobile=True,has_touch=True,device_scale_factor=2)
    try:
        await ev(pg,LIB); await ev(pg,TOUCH_JS)
        await run(pg,'touch:start',120,START_TREE,start_ok)
        N=('touch:start',)
        await run(pg,'touch:draw',60,"""(()=>{ T.flush(); const b=TBA('interact'); if(!b)return {btn:false}; TPA('interact','pointerdown'); G.step(1/30,3); TPA('interact','pointerup'); G.step(1/30,4);
            return {btn:true,draws:G.forage.tree.draws,sap:G.inv.count('sap')}; })()""",
            lambda r:r['btn'] and r['draws']==1 and r['sap']==1,N)
        await run(pg,'touch:open',60,"(()=>{ T.settle(20); T.openFix(); window.__before=T.st(); T.watchBusy(); return {row:T.fixRow('kilnfire')}; })()",
            lambda r:r['row'] and r['row']['enabled'],N+('touch:draw',))
        if 'touch:open' not in failed:
            # a real touch on the Fix button where it is drawn (page.tap's own waiting never settles on this busy page)
            try:
                xy=await ev(pg,"(()=>{ const b=document.querySelector('#temperList [data-fix=kilnfire]'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); const x=(r.left+r.right)/2, y=(r.top+r.bottom)/2; const top=document.elementFromPoint(x,y); return {x,y,hit:top===b}; })()")
                if not xy['hit']: raise Exception('the Fix button is covered: '+json.dumps(xy))
                await asyncio.wait_for(pg.touchscreen.tap(xy['x'],xy['y']),30); ok=True
            except Exception as e: check('touch:tap-fix',False,{'error':str(e)[:200]}); ok=False
            if ok:
                await pg.wait_for_timeout(600)
                await run(pg,'touch:banner',30,"(()=>({busy:__busy}))()",lambda r:r['busy'] and r['busy']['inView'] and r['busy']['afterSec'],N+('touch:open',))
                await shot(pg,'touch-fix-working')
                await pg.wait_for_timeout(3200)
                await run(pg,'touch:fixed',30,"(()=>{ const a=T.st(), b=__before; return {a,spent:{flask:b.k-a.k,sap:b.sap-a.sap,mark:b.marks-a.marks}}; })()",
                    lambda r:r['a']['fixed']=='kilnfire' and r['spent']=={'flask':3,'sap':1,'mark':3},N+('touch:open',))
        else:
            for n in ('touch:banner','touch:fixed'): skip(n,'needs touch:open')
    finally:
        real=[e for e in errs if '404' not in e]
        check('touch: no page errors',not real,real[:6])
        await ctx.close()

async def main():
    t0=time.time()
    only=os.environ.get('ONLY')   # e.g. ONLY=pad,touch runs just those parts (main, pad, touch)
    want=lambda k:not only or k in only.split(',')
    async with async_playwright() as p:
        b=await p.chromium.launch(**CHROME)
        parts=[('main',lambda:main_suite(b),1500),('pad',lambda:pad_suite(b),500),('touch',lambda:touch_suite(b),500)]
        for k,fn,budget in parts:
            if not want(k): continue
            try: await asyncio.wait_for(fn(),budget)
            except asyncio.TimeoutError: check(k+'-suite',False,{'timeout':budget})
            except Exception as e: check(k+'-suite',False,{'error':str(e)[:300]})
        await b.close()
    print('RESULT', 'PASS' if ok_all else 'FAIL '+', '.join(sorted(failed)), f'{time.time()-t0:.0f}s', flush=True)
    sys.exit(0 if ok_all else 1)

asyncio.run(main())
