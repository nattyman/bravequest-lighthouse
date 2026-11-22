"""Staff oils against the bosses (Spec: OILS.md, the boss pass): what an oil's burn tick (kind 'burn') and a burst (kind 'blast')
do to each boss and its parts. Each section reaches its fight through the devtools start points / boss debug hooks, then calls
the hurtboxes' hit() directly, the way js/oils.js does.
usage: python3 test/oils_bosses_e2e.py [url] [--only giant,crane,undertow,answer,gloaming]
       (default http://localhost:8915/dev.html?debug&headless)
Each section runs on a fresh page. A check that fails makes the later checks of its section SKIP."""
import asyncio, sys, json, time, os
from playwright.async_api import async_playwright
ARGS=[a for i,a in enumerate(sys.argv[1:]) if not a.startswith('--') and not (i>0 and sys.argv[i]=='--only')]
URL=ARGS[0] if ARGS else 'http://localhost:8915/dev.html?debug&headless'
ONLY=None
for i,a in enumerate(sys.argv[1:]):
    if a.startswith('--only'): ONLY=set((a.split('=',1)[1] if '=' in a else sys.argv[i+2]).split(','))
CHECK_S=float(os.environ.get('CHECK_TIMEOUT','240'))   # wall-clock budget per check
OUT='/tmp/claude-0/oils-bosses'

HELP=r"""(()=>{
  window.T={n:{},
    play(){ const t=document.getElementById('title'); if(t&&!t.hidden&&G.state.mode==='title'){ t.hidden=true; } if(G.state.mode!=='play'&&G.state.mode!=='dead')G.setMode('play'); },
    until(f,max){ let k=0; while(!f()&&k<max){ G.step(1/30,1); k++; } return k; },
    hold(){ const P=G.player; P.hp=P.maxHp; },
    god(on){ if(G.devtools&&G.devtools.cheats)G.devtools.cheats.god=!!on; },
    dir(){ return new THREE.Vector3(0,0,1); },
    burn(hb){ hb.hit({damage:1,kind:'burn',element:'fire',knockback:0,dir:T.dir(),source:'oil'}); },
    blast(hb,d){ hb.hit({damage:d||3,kind:'blast',element:'burst',knockback:5,dir:T.dir(),source:'oil'}); },
    hit(hb,d,kind){ hb.hit({damage:d||2,kind:kind||'melee',element:null,knockback:2,dir:T.dir(),source:null}); },
    c(name){ return T.n[name]||0; },
    shared(list){ const k=list[0]&&list[0].oilKey; return !!k&&typeof k==='object'&&list.every(h=>h.oilKey===k); },
  };
  for(const e of ['northFire:hit','undercroft:bossHit','undercroft:bossCopy','undercroft:bossStagger','cave:bossHit','temple:bossHit','gloaming:solid'])
    G.on(e,()=>{ T.n[e]=(T.n[e]||0)+1; });
  G.on('temple:hand',e=>{ const k='hand:'+(e&&e.what); T.n[k]=(T.n[k]||0)+1; });
  return 'ok'; })()"""

r2=lambda x: round(x,2)

# ------------------------------------------------------------------ the Wreck Giant: never burns; a burst is an ordinary hit
GIANT=[
 ("giant:start", r"""(()=>{ G.devtools.start('north-fight'); T.play(); T.god(true); const g=G.northFire.giant; const k=T.until(()=>g.state==='fight',600); G.step(1/30,10);
   return {ok:g.state==='fight',state:g.state,frames:k,hp:g.hp}; })()"""),
 ("giant:optin", r"""(()=>{ const HB=G.northFire.debug.HB; return {ok:!!HB.oilKey&&typeof HB.oilKey==='object'&&!!HB.oil&&HB.oil.burn===false,oil:HB.oil}; })()"""),
 ("giant:burnHot", r"""(()=>{ const HB=G.northFire.debug.HB, g=G.northFire.giant, h0=g.hp, n0=T.c('northFire:hit'); for(let i=0;i<3;i++){ T.burn(HB); G.step(1/30,2); }
   return {ok:g.hp===h0&&T.c('northFire:hit')===n0&&g.state==='fight',h0,hp:g.hp,events:T.c('northFire:hit')-n0}; })()"""),
 ("giant:burnDoused", r"""(()=>{ const HB=G.northFire.debug.HB, g=G.northFire.giant; g.douse(6.5); G.step(1/30,2); const h0=g.hp, n0=T.c('northFire:hit'); for(let i=0;i<3;i++){ T.burn(HB); G.step(1/30,2); }
   return {ok:g.doused&&g.hp===h0&&T.c('northFire:hit')===n0,doused:g.doused,h0,hp:g.hp}; })()"""),
 ("giant:blastDoused", r"""(()=>{ const HB=G.northFire.debug.HB, g=G.northFire.giant, D=G.northFire.debug, h0=g.hp; T.blast(HB,3); const d=h0-g.hp;
   return {ok:g.doused&&Math.abs(d-3*D.T.cold)<1e-6,dmg:+d.toFixed(3),want:3*D.T.cold}; })()"""),
 ("giant:blastHot", r"""(()=>{ const g=G.northFire.giant, D=G.northFire.debug, HB=D.HB; D.B.doused=0; G.step(1/30,3); const h0=g.hp; T.blast(HB,3); const d=h0-g.hp;
   return {ok:!g.doused&&Math.abs(d-3*D.T.chip)<1e-6,dmg:+d.toFixed(3),want:3*D.T.chip,state:g.state}; })()"""),
]

# ------------------------------------------------------------------ Aldous Crane: burns, takes bursts; the ledger counts bolts only
CRANE=[
 ("crane:start", r"""(()=>{ T.play(); G.debugStartLoop&&G.debugStartLoop(); G.step(1/30,10); const U=G.undercroftBoss; U.debug.enter('store'); G.step(1/30,5);
   U.debug.start(); U.debug.hold(true); T.god(true); G.step(1/30,10); T.hold();
   return {ok:U.state==='fight'&&U.phase===1,state:U.state,phase:U.phase,hp:U.hp}; })()"""),
 ("crane:optin", r"""(()=>{ const U=G.undercroftBoss, hbs=[...G.hurtboxes].filter(h=>h.crane||h.ledger||h.fig);
   const crane=hbs.find(h=>h.crane), ledger=hbs.find(h=>h.ledger), figs=hbs.filter(h=>h.fig);
   return {ok:hbs.length===6&&T.shared(hbs)&&crane.oil.burn===true&&ledger.oil.burn===false&&figs.every(h=>h.oil.burn===true),n:hbs.length,shared:T.shared(hbs)}; })()"""),
 ("crane:burn", r"""(()=>{ const U=G.undercroftBoss, B=U.crane, hb=[...G.hurtboxes].find(h=>h.crane), h0=U.hp, n0=T.c('undercroft:bossHit'), lt=B.lastHitT, lk=B.lastKind;
   T.burn(hb); const d1=h0-U.hp; G.step(1/30,1); T.burn(hb); const d2=h0-U.hp;
   return {ok:d1===1&&d2===2&&T.c('undercroft:bossHit')===n0&&B.lastHitT===lt&&B.lastKind===lk&&B.staggerT===0,d1,d2,events:T.c('undercroft:bossHit')-n0,stag:B.staggerT}; })()"""),
 ("crane:blastOnce", r"""(()=>{ const U=G.undercroftBoss, hb=[...G.hurtboxes].find(h=>h.crane), led=[...G.hurtboxes].find(h=>h.ledger);
   G.step(1/30,6); const h0=U.hp; T.blast(hb,3); T.blast(led,3); T.blast(hb,3); const d1=h0-U.hp; G.step(1/30,6); T.blast(hb,3); const d2=h0-U.hp;
   return {ok:d1===3&&d2===6,d1,d2}; })()"""),
 ("crane:copies", r"""(()=>{ const U=G.undercroftBoss, B=U.crane; U.debug.phase(2); U.debug.hold(true); G.step(1/30,60); T.hold();
   const figs=U.figures, real=figs.find(f=>f.real), copies=figs.filter(f=>!f.real&&f.alive);
   if(!real||copies.length<3)return {ok:false,why:'figures not formed',alive:figs.filter(f=>f.alive).length};
   const h0=U.hp, c0=T.c('undercroft:bossCopy'), p0=G.combat.projectiles.filter(p=>p.team==='enemy').length, sh0=B.shuffleAt, st0=B.staggerT;
   for(const f of copies)T.burn(f.hb); T.burn(real.hb); G.step(1/30,10);
   const p1=G.combat.projectiles.filter(p=>p.team==='enemy').length;
   return {ok:copies.every(f=>f.alive)&&T.c('undercroft:bossCopy')===c0&&p1<=p0&&h0-U.hp===1&&B.shuffleAt===sh0&&B.staggerT<=st0,
     copiesAlive:copies.filter(f=>f.alive).length,copyEvents:T.c('undercroft:bossCopy')-c0,proj:[p0,p1],dmg:h0-U.hp,shuffle:[sh0,B.shuffleAt],stag:[st0,B.staggerT]}; })()"""),
 ("crane:blastFigure", r"""(()=>{ const U=G.undercroftBoss, real=U.figures.find(f=>f.real&&f.alive); if(!real)return {ok:false,why:'no real figure'};
   G.step(1/30,6); const h0=U.hp; T.blast(real.hb,3); T.blast(real.hb,3); return {ok:h0-U.hp===3,dmg:h0-U.hp}; })()"""),
 ("crane:ledger", r"""(()=>{ const U=G.undercroftBoss, B=U.crane; U.debug.phase(3); U.debug.hold(true); G.step(1/30,40); B.staggerT=0; if(!B.ledger.open){ U.debug.openLedger(); G.step(1/30,2); }
   const led=[...G.hurtboxes].find(h=>h.ledger), s0=T.c('undercroft:bossStagger');
   for(let i=0;i<4;i++){ T.burn(led); T.blast(led,4); G.step(1/30,6); }
   const after=B.ledger.hits, open1=B.ledger.open, stag1=B.staggerT;
   const bolts=[]; for(let i=0;i<3;i++){ T.hit(led,4,'bolt'); bolts.push(B.ledger.hits); G.step(1/30,3); }
   return {ok:after===0&&open1&&stag1===0&&T.c('undercroft:bossStagger')===s0+1&&B.staggerT>2&&!B.ledger.open,afterOils:after,bolts,stag:+B.staggerT.toFixed(2)}; })()"""),
 ("crane:burnGuarded", r"""(()=>{ const U=G.undercroftBoss, B=U.crane; B.staggerT=0; U.debug.openLedger(); G.step(1/30,2); const hb=[...G.hurtboxes].find(h=>h.crane), h0=U.hp, s0=T.c('undercroft:bossStagger');
   T.burn(hb); const d=h0-U.hp; return {ok:B.ledger.open&&Math.abs(d-U.T.guardMul)<1e-6&&T.c('undercroft:bossStagger')===s0&&B.staggerT===0,dmg:d,open:B.ledger.open}; })()"""),
]

# ------------------------------------------------------------------ the Undertow: burns only where a blow lands; one burst once
UNDERTOW=[
 ("undertow:start", r"""(()=>{ G.devtools.start('cave:arena'); T.play(); T.god(true); G.step(1/30,10); const CB=G.caveBoss, B=CB.undertow;
   const w=G.cave.toWorld(60,0,-30); G.player.teleport(w.x,G.floorAt(w.x,w.z,w.y+8),w.z,Math.PI); const k0=T.until(()=>B.state!=='sunk',300);
   const k1=T.until(()=>B.rise>.9&&B.state!=='rise',600); T.hold();
   return {ok:B.state!=='sunk'&&B.rise>.9&&CB.debug.hbs.length===16,state:B.state,rise:+B.rise.toFixed(2),frames:[k0,k1],hp:B.hp}; })()"""),
 ("undertow:optin", r"""(()=>{ const D=G.caveBoss.debug, lens=[...G.hurtboxes].find(h=>h.name==='The Undertow’s lens'), all=[...D.hbs,lens];
   return {ok:!!lens&&T.shared(all)&&all.every(h=>h.oil&&h.oil.burn===true),n:all.length,shared:T.shared(all)}; })()"""),
 ("undertow:burnSolid", r"""(()=>{ const CB=G.caveBoss, B=CB.undertow, D=CB.debug, i=12; B.state='idle'; B.cool=99; B.vis=1; D.sampW[i]=1;
   const h0=B.hp, n0=T.c('cave:bossHit'), lt=B.lastHitT, lk=B.lastHitKind; T.burn(D.hbs[i]);
   return {ok:h0-B.hp===1&&T.c('cave:bossHit')===n0&&B.lastHitT===lt&&B.lastHitKind===lk&&B.state==='idle',dmg:h0-B.hp,events:T.c('cave:bossHit')-n0}; })()"""),
 ("undertow:burnThrough", r"""(()=>{ const CB=G.caveBoss, B=CB.undertow, D=CB.debug, i=12; B.vis=1; D.sampW[i]=0; const h0=B.hp; T.burn(D.hbs[i]); const a=h0-B.hp;
   D.sampW[i]=1; B.vis=0; T.burn(D.hbs[i]); const b=h0-B.hp; B.vis=1; return {ok:a===0&&b===0,passThin:a,passDark:b}; })()"""),
 ("undertow:burnNoRelease", r"""(()=>{ const CB=G.caveBoss, B=CB.undertow, D=CB.debug; const st=B.state; B.state='dragWind'; B.drag=.5; B.vis=1; D.sampW[1]=1; const h0=B.hp;
   T.burn(D.hbs[1]); const r={state:B.state,drag:B.drag,dmg:h0-B.hp}; B.state=st; B.drag=0; return {ok:r.state==='dragWind'&&r.drag===.5&&r.dmg===1,...r}; })()"""),
 ("undertow:blastOnce", r"""(()=>{ const CB=G.caveBoss, B=CB.undertow, D=CB.debug, lens=[...G.hurtboxes].find(h=>h.name==='The Undertow’s lens');
   G.step(1/30,12); D.expose(); B.vis=1; for(let i=0;i<16;i++)D.sampW[i]=1; const h0=B.hp, n0=T.c('cave:bossHit');
   for(const hb of D.hbs)T.blast(hb,3); T.blast(lens,3); const d=h0-B.hp;
   return {ok:d===3&&T.c('cave:bossHit')===n0+1,dmg:d,events:T.c('cave:bossHit')-n0,state:B.state}; })()"""),
 ("undertow:burnCore", r"""(()=>{ const CB=G.caveBoss, B=CB.undertow, lens=[...G.hurtboxes].find(h=>h.name==='The Undertow’s lens'); if(B.state!=='miss'||B.expose<=0){ CB.debug.expose(); }
   const e0=B.expose, h0=B.hp, n0=T.c('cave:bossHit'); T.burn(lens); const d=h0-B.hp;
   return {ok:Math.abs(d-CB.params.coreMul)<1e-6&&B.expose===e0&&T.c('cave:bossHit')===n0,dmg:d,expose:[e0,B.expose]}; })()"""),
]

# ------------------------------------------------------------------ the Answer and its hands
ANSWER=[
 ("answer:start", r"""(()=>{ T.play(); const TB=G.templeBoss; TB.debug.start(); TB.debug.hold(true); T.god(true); G.step(1/30,90); T.hold();
   return {ok:TB.debug.B.state==='fight'&&TB.debug.B.phase===1,state:TB.debug.B.state,phase:TB.debug.B.phase}; })()"""),
 ("answer:optin", r"""(()=>{ const TB=G.templeBoss, ans=[...G.hurtboxes].find(h=>h.answer), hands=TB.hands.map(h=>h.hb), all=[ans,...hands];
   return {ok:!!ans&&hands.length===4&&T.shared(all)&&ans.oil.burn===true&&TB.hands.every(h=>h.hb.oil.burn===!h.skinOn),shared:T.shared(all),skins:TB.hands.map(h=>[h.skinOn,h.hb.oil.burn])}; })()"""),
 ("answer:skinned", r"""(()=>{ const TB=G.templeBoss; TB.debug.B.forceSkin=true; TB.debug.hold(false); TB.debug.spawnHand(); TB.debug.spawnHand(); TB.debug.hold(true);
   T.until(()=>TB.hands.filter(h=>h.state==='reach').length>=2,200); const hs=TB.hands.filter(h=>h.state==='reach'); if(hs.length<2)return {ok:false,why:'hands did not rise',st:TB.hands.map(h=>h.state)};
   if(!hs.every(h=>h.skinOn))return {ok:false,why:'no skins (no Lens here?)',skins:hs.map(h=>h.skinOn)};
   const g0=T.c('hand:glance'), hp0=hs.map(h=>h.hp); for(const h of hs)T.burn(h.hb); const gBurn=T.c('hand:glance')-g0;
   for(const h of hs)T.blast(h.hb,3); const gBlast=T.c('hand:glance')-g0-gBurn;
   return {ok:gBurn===0&&gBlast===1&&hs.every((h,i)=>h.hp===hp0[i]&&h.skinOn)&&hs.every(h=>h.hb.oil.burn===false),gBurn,gBlast,hp:hs.map(h=>h.hp)}; })()"""),
 ("answer:bare", r"""(()=>{ const TB=G.templeBoss, hs=TB.hands.filter(h=>h.state==='reach'); for(const h of hs)TB.debug.burnHand(h); G.step(1/30,6);
   const hp0=hs.map(h=>h.hp), B0=TB.debug.B.hp, e0=T.c('temple:bossHit'); T.burn(hs[0].hb); const burnD=hp0[0]-hs[0].hp;
   G.step(1/30,6); const hp1=hs.map(h=>h.hp); for(const h of hs)T.blast(h.hb,3); const blastD=hs.map((h,i)=>hp1[i]-h.hp);
   return {ok:hs.every(h=>h.hb.oil.burn===true)&&burnD===1&&blastD.filter(x=>x>0).length===1&&TB.debug.B.hp===B0&&T.c('temple:bossHit')===e0,burnD,blastD,optIn:hs.map(h=>h.hb.oil.burn)}; })()"""),
 ("answer:body", r"""(()=>{ const TB=G.templeBoss, B=TB.debug.B; TB.debug.phase(2); TB.debug.hold(true); G.step(1/30,30); const ans=[...G.hurtboxes].find(h=>h.answer);
   B.solid=1; const h0=B.hp, e0=T.c('temple:bossHit'), lt=B.lastHitT; T.burn(ans); const solidD=h0-B.hp, solidEv=T.c('temple:bossHit')-e0;
   B.solid=0; const h1=B.hp; T.burn(ans); const glareD=h1-B.hp, glareEv=T.c('temple:bossHit')-e0-solidEv;
   B.solid=1; G.step(1/30,6); B.solid=1; const h2=B.hp; T.blast(ans,3); T.blast(ans,3); const blastD=h2-B.hp;
   return {ok:solidD===1&&solidEv===0&&glareD===0&&glareEv===0&&B.lastHitT!==lt&&blastD===3,solidD,solidEv,glareD,glareEv,blastD,phase:B.phase}; })()"""),
 ("answer:phase3", r"""(()=>{ const TB=G.templeBoss, B=TB.debug.B; TB.debug.phase(3); TB.debug.hold(true); G.step(1/30,10); const ans=[...G.hurtboxes].find(h=>h.answer); B.solid=1; const h0=B.hp; T.burn(ans);
   return {ok:B.phase===3&&B.hp===h0,phase:B.phase,dmg:h0-B.hp}; })()"""),
]

# ------------------------------------------------------------------ the Gloaming: body, hands and roots
GLOAMING=[
 ("gloaming:start", r"""(()=>{ G.devtools.start('finale'); T.play(); G.step(1/30,30); const L=G.world.lighthouse; G.player.teleport(L.x-14,42,L.z-6,-2.3); T.god(true);
   const FB=G.finaleBoss, B=FB.debug.B; T.until(()=>FB.active,200); for(const m of G.monsters.list.slice())if(m.finale&&m.alive&&!m.gloaming)G.monsters.despawn(m);
   T.until(()=>B.state==='fight',500); for(const m of G.monsters.list.slice())if(m.finale&&m.alive&&!m.gloaming)G.monsters.despawn(m); B.cool=1e9;
   return {ok:FB.active&&B.state==='fight',state:B.state,hp:B.hp}; })()"""),
 ("gloaming:optin", r"""(()=>{ const D=G.finaleBoss.debug, body=D.bodyHB, hands=D.arms.filter(a=>a.hb).map(a=>a.hb), roots=D.roots.map(r=>r.hb), all=[body,...hands,...roots];
   return {ok:hands.length===2&&roots.length===3&&T.shared(all)&&body.oil.burn===true&&hands.every(h=>h.oil.burn===true)&&roots.every(h=>h.oil.burn===false),n:all.length,shared:T.shared(all)}; })()"""),
 ("gloaming:burnFog", r"""(()=>{ const D=G.finaleBoss.debug, B=D.B; B.solidT=0; B.staggerT=0; const h0=B.hp, r0=B.recoil; T.burn(D.bodyHB);
   return {ok:!G.finaleBoss.solid&&B.hp===h0&&B.recoil===r0,hp:[h0,B.hp]}; })()"""),
 ("gloaming:burnSolid", r"""(()=>{ const D=G.finaleBoss.debug, B=D.B; D.solidNow(5); const h0=B.hp, r0=B.recoil, ht=B.hitT; T.burn(D.bodyHB);
   return {ok:h0-B.hp===1&&B.recoil===r0&&B.hitT===ht,dmg:h0-B.hp,recoil:[r0,B.recoil]}; })()"""),
 ("gloaming:blastBody", r"""(()=>{ const D=G.finaleBoss.debug, B=D.B; G.step(1/30,6); D.solidNow(5); const h0=B.hp; T.blast(D.bodyHB,3); T.blast(D.bodyHB,3); const d1=h0-B.hp;
   G.step(1/30,6); D.solidNow(5); T.blast(D.bodyHB,3); const d2=h0-B.hp; return {ok:d1===3&&d2===6,d1,d2}; })()"""),
 ("gloaming:hand", r"""(()=>{ const D=G.finaleBoss.debug, B=D.B, ar=D.arms.find(a=>a.hb); ar.hardT=5; ar.hp=0; const h0=B.hp, hand0=ar.hand; T.burn(ar.hb);
   const d=h0-B.hp; return {ok:d>0&&Math.abs(ar.hp-d)<1e-6&&ar.hand===hand0,dmg:+d.toFixed(3),handHp:+ar.hp.toFixed(3),hand:[hand0,ar.hand]}; })()"""),
 ("gloaming:roots", r"""(()=>{ const D=G.finaleBoss.debug, B=D.B; for(const a of D.arms)a.hardT=0; D.setHp(17); G.step(1/30,60); const rs=D.roots; if(!rs.every(r=>r.active&&!r.cut))return {ok:false,why:'roots not up',roots:rs.map(r=>[r.active,r.cut])};
   const hp0=rs.map(r=>r.hp), s0=T.c('gloaming:solid'); for(const r of rs){ T.burn(r.hb); T.burn(r.hb); T.burn(r.hb); T.burn(r.hb); } const burnt=rs.map((r,i)=>hp0[i]-r.hp);
   G.step(1/30,6); D.solidNow(5); const bh=B.hp, rh=rs[0].hp; T.blast(rs[0].hb,3); T.blast(D.bodyHB,3); const rootD=rh-rs[0].hp, bodyD=bh-B.hp;
   return {ok:burnt.every(x=>x===0)&&rs.every(r=>!r.cut||r===rs[0])&&T.c('gloaming:solid')>=s0&&((rootD>0)!==(bodyD>0)),burnt,rootD,bodyD,staggerT:+B.staggerT.toFixed(2)}; })()"""),
]

SECTIONS={'giant':GIANT,'crane':CRANE,'undertow':UNDERTOW,'answer':ANSWER,'gloaming':GLOAMING}

async def run(pg, name, js, fails):
    try: r=await asyncio.wait_for(pg.evaluate(js),CHECK_S)
    except asyncio.TimeoutError:
        print('FAIL', name, f': timed out after {CHECK_S:.0f}s, the page is stuck; stopping here', flush=True); os._exit(1)
    except Exception as e: r={'ok':False,'exc':str(e).split('\n')[0][:300]}
    ok=isinstance(r,dict) and r.get('ok') is True
    print(('ok  ' if ok else 'FAIL'), name, ':', json.dumps(r)[:700], flush=True)
    if not ok: fails.append(name)
    return ok

async def main():
    t0=time.time(); fails=[]; passed=0; skipped=0
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await (await b.new_context(viewport={'width':960,'height':600})).new_page(); pg.set_default_timeout(300000)
        errs=[]; pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' and '404' not in m.text else None)
        for sec,steps in SECTIONS.items():
            if ONLY and sec not in ONLY: continue
            await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
            await pg.evaluate("localStorage.removeItem('bq-save-v1')"); await pg.evaluate(HELP)
            broken=None
            for name,js in steps:
                if broken: print('SKIP', name, ': needs', broken, flush=True); skipped+=1; continue
                if await run(pg,name,js,fails): passed+=1
                else: broken=name
            os.makedirs(OUT,exist_ok=True)
            try: await pg.evaluate('G.headless&&G.headless.draw(3); 0'); await pg.screenshot(path=f'{OUT}/{sec}.png',timeout=120000)
            except Exception as e: print('  (no screenshot:',str(e)[:120],')')
        real=[e for e in errs if '404' not in e]
        for e in real[:10]: print('  ERR',e[:300])
        if real: fails.append('console errors')
        await b.close()
    print(f'{passed} passed, {len(fails)} failed, {skipped} skipped')
    print(('PASS' if not fails else 'FAIL '+', '.join(fails)), f'{time.time()-t0:.0f}s'); sys.exit(1 if fails else 0)
asyncio.run(main())
