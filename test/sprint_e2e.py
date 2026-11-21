"""Touch Sprint (~3-5 min): the Sprint button in the touch cluster, driven with real input (the stick through G.input.setVirtual,
the button through pointer events on the element itself, never screen coordinates, since the layout is owned elsewhere).
- a tap latches sprint: sprint speed, the 'sprint' state, stamina drains; a second tap drops it;
- stopping (stick near centre a moment) drops it, a quick direction change through centre doesn't;
- a press held past the tap threshold sprints while held and stops on the lift;
- running dry: exhaustion drops the latch and dims the button, and a tap while exhausted doesn't latch;
- the latch drops when the game takes control: a cut scene, a talk card, the pause menu, death, a scripted move;
- the Dashing Sweep (sprint, then strike) comes out of a touch sprint; lock-on and a charged strike hold the latch armed
  (no sprint while they last) and the run picks up again after;
- the pause menu's touch legend lists Sprint; the one-time touch nudge on a long walk;
- keyboard Shift and controller LB sprint as before; without touch the button isn't shown; nothing is kept over a reload.
Screenshots of the button's three looks (idle, latched, dimmed) go to /tmp/claude-0/sprint-shots/.
usage: python3 test/sprint_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)
"""
import asyncio, sys, json, os
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
OUT='/tmp/claude-0/sprint-shots'; os.makedirs(OUT,exist_ok=True)
CHROME=dict(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
ok_all=True; failed=set()
def check(name,ok,info):
    global ok_all
    ok_all=ok_all and bool(ok)
    if not ok: failed.add(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name:26s} {json.dumps(info)[:420]}",flush=True)
def skip(name,why): print(f"SKIP {name:26s} {why}",flush=True)

LIB=r"""
window.SP=(()=>{
const P=()=>G.player, I=()=>G.input, B=()=>document.querySelector('#touch button[data-act=sprint]');
const KEYS=['forward','back','left','right','sprint','attack','lock','jump','roll'];
const SPOT={x:150,y:42.2,z:-14,yaw:Math.PI*.5};          // the open headland (hud_e2e's spot), facing inland
const pe=t=>B().dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerType:'touch',pointerId:7,isPrimary:true}));
const step=s=>G.step(1/30,Math.max(1,Math.round(s*30)));
const st=()=>{ const p=P(); return Object.assign({},G.ui.touchSprint(),{sprinting:!!p.sprinting,state:p.state,spd:+Math.hypot(p.vel.x,p.vel.z).toFixed(2),
  stam:+p.stamina.toFixed(3),exh:!!p.exhausted,down:I().down('sprint'),mode:G.state.mode,cls:B().className,move:p.move&&p.move.id}); };
function play(){ if(!document.getElementById('pause').hidden){ document.getElementById('resume').click(); } if(G.talk&&G.talk.isOpen)G.talk.close(); if(G.state.mode!=='play')G.setMode('play'); }
function fresh(){ play(); for(const k of KEYS)I().setVirtual(k,false); pe('pointercancel'); step(.1);
  const p=P(); p.setControl(true); p.hp=p.maxHp; p.stamina=1; p.exhausted=false; p.lockTarget=null;
  p.teleport(SPOT.x,SPOT.y,SPOT.z,SPOT.yaw); p.aimCamera&&p.aimCamera(SPOT.yaw,.26); step(.5); return st(); }
// keep running without leaving the open ground: back to the spot once 25 m out (teleport zeroes the speed, so 'top' is
// the fastest speed seen in the run and 'spd' the speed at its end)
function run(s,each){ let top=0; const n=Math.round(s*30); for(let k=0;k<n;k++){ const p=P();
  if(Math.hypot(p.pos.x-SPOT.x,p.pos.z-SPOT.z)>25){ p.teleport(SPOT.x,SPOT.y,SPOT.z,SPOT.yaw); }
  p.aimCamera&&p.aimCamera(SPOT.yaw,.26); G.step(1/30,1); top=Math.max(top,Math.hypot(p.vel.x,p.vel.z)); if(each&&each(k))break; }
  return Object.assign(st(),{top:+top.toFixed(2)}); }
function tap(){ pe('pointerdown'); pe('pointerup'); return st(); }
return {P,I,B,pe,step,st,play,fresh,run,tap,SPOT};
})();
if(G.headless)G.headless.hold=true;   // only G.step moves the game: frame counts are exact whatever the machine
G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{};
window.__said=[]; { const o=G.ui.say; G.ui.say=function(t,...a){ __said.push(String(t)); return o.call(this,t,...a); }; }
'lib'
"""

PAD_JS=r"""
window.__pad={id:'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',index:0,connected:true,mapping:'standard',timestamp:0,axes:[0,0,0,0],
  buttons:Array.from({length:17},()=>({pressed:false,touched:false,value:0}))};
window.__btn=(i,on)=>{ __pad.buttons[i]={pressed:!!on,touched:!!on,value:on?1:0}; __pad.timestamp++; };
window.__axis=(i,v)=>{ __pad.axes[i]=v; __pad.timestamp++; };
navigator.getGamepads=()=>[__pad,null,null,null];
"""

async def ev(pg,js,budget=60):
    return await asyncio.wait_for(pg.evaluate(js),budget)

async def run(pg,name,budget,js,test,needs=()):
    """one check with its own time budget; SKIP when a check it depends on failed"""
    bad=[n for n in needs if n in failed]
    if bad: skip(name,'needs '+','.join(bad)); failed.add(name); return None
    try: r=await ev(pg,js,budget)
    except asyncio.TimeoutError: check(name,False,{'timeout':budget}); return None
    except Exception as e: check(name,False,{'error':str(e)[:300]}); return None
    try: ok=test(r)
    except Exception as e: ok=False; r={'r':r,'test_error':str(e)}
    check(name,ok,r); return r

async def boot(b,mobile=True,pad=False,view=None):
    errs=[]
    kw=dict(viewport=view or ({'width':844,'height':390} if mobile else {'width':1280,'height':760}))
    if mobile: kw.update(is_mobile=True,has_touch=True,device_scale_factor=2)
    ctx=await b.new_context(**kw)
    if pad: await ctx.add_init_script(PAD_JS)
    pg=await ctx.new_page()
    pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
    pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
    await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(4000)
    return ctx,pg,errs

async def begin(pg):
    await ev(pg,"(()=>{ localStorage.removeItem('bq-save-v1'); document.getElementById('begin').click(); G.step(1/30,40); return 1; })()",120)
    await ev(pg,LIB)
    # the opening's camera move and the progress reward would take control in the middle of the checks: mark them done
    await ev(pg,"(()=>{ if(G._onb)G._onb.S.seen.opening=1; G.progress&&G.progress.endReward&&G.progress.endReward(); G.items.staff.owned=true; SP.fresh(); return 1; })()")

async def shot(pg,name,setup):
    await ev(pg,setup)
    await ev(pg,"(()=>{ const b=SP.B(); b.style.setProperty('--x','-120px'); b.style.setProperty('--y','-215px'); "   # shot only: clear of Strike
               "for(const a of document.getAnimations()){ try{ a.finish(); }catch(_){} } G.headless&&G.headless.draw(3); return 1; })()")
    await pg.wait_for_timeout(400)
    box=await pg.evaluate("(()=>{ const r=SP.B().getBoundingClientRect(); return {x:r.left-14,y:r.top-14,width:r.width+28,height:r.height+28}; })()")
    await pg.screenshot(path=f'{OUT}/{name}.png',clip=box,timeout=60000)
    await ev(pg,"(()=>{ const b=SP.B(); b.style.removeProperty('--x'); b.style.removeProperty('--y'); return 1; })()")

async def touch_suite(b):
    ctx,pg,errs=await boot(b)
    try:
        await begin(pg)
    except Exception as e:
        check('boot',False,{'error':str(e)[:300]}); await ctx.close(); return
    r=await run(pg,'boot',30,"(()=>Object.assign(SP.st(),{device:G.input.device,ctl:G.player.inputEnabled,touchVis:getComputedStyle(document.getElementById('touch')).display}))()",
        lambda r:r['shown'] and r['pressed']=='false' and not r['latched'] and r['device']=='touch' and r['ctl'] and r['mode']=='play')
    N=('boot',)
    await shot(pg,'sprint-idle',"SP.fresh()")

    await run(pg,'tap-latches',60,r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.step(.3); const walk=SP.st();
        const t=SP.tap(); const s=SP.run(1.5); return {walk:walk.spd,tap:{latched:t.latched,pressed:t.pressed},run:s}; })()""",
        lambda r:r['tap']['latched'] and r['tap']['pressed']=='true' and r['run']['sprinting'] and r['run']['state']=='sprint'
                 and r['run']['top']>8.0 and r['run']['stam']<.8 and r['run']['latched'] and r['run']['down'],N)
    await shot(pg,'sprint-latched',"SP.st()")
    await run(pg,'tap-again-drops',60,r"""(()=>{ const t=SP.tap(); const s=SP.run(.8); return {tap:t.latched,pressed:s.pressed,run:s}; })()""",
        lambda r:not r['tap'] and r['pressed']=='false' and not r['run']['sprinting'] and not r['run']['down'] and r['run']['spd']<5.6,N+('tap-latches',))

    await run(pg,'turn-keeps-latch',60,r"""(()=>{ SP.fresh(); const I=SP.I(); I.setVirtual('forward',true); SP.tap(); SP.run(1);
        I.setVirtual('forward',false); SP.step(.1); I.setVirtual('back',true); const s=SP.run(.8); I.setVirtual('back',false); return s; })()""",
        lambda r:r['latched'] and r['sprinting'],N+('tap-latches',))
    await run(pg,'stop-drops-latch',60,r"""(()=>{ const s=SP.run(.6); SP.I().setVirtual('forward',true); const a=SP.run(.5); SP.I().setVirtual('forward',false); return {stopped:s,after:a}; })()""",
        lambda r:not r['stopped']['latched'] and r['stopped']['pressed']=='false' and not r['after']['sprinting'],N+('turn-keeps-latch',))
    await run(pg,'tap-before-moving',60,r"""(()=>{ SP.fresh(); SP.tap(); const w=SP.run(.8); SP.I().setVirtual('forward',true); const s=SP.run(1);
        SP.I().setVirtual('forward',false); const idle=SP.run(2.2); return {wait:w.latched,run:s,idle:idle.latched}; })()""",
        lambda r:r['wait'] and r['run']['sprinting'] and not r['idle'],N)

    # a hold: the lift comes after more than the tap threshold of real time (pointer timing is the browser's clock)
    r=await run(pg,'hold-sprints',60,r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.pe('pointerdown'); window.__holdAt=performance.now(); return SP.run(1); })()""",
        lambda r:r['held'] and r['sprinting'] and r['top']>8.0 and not r['latched'],N)
    await pg.wait_for_timeout(350)
    await run(pg,'hold-release-stops',60,r"""(()=>{ const ms=performance.now()-__holdAt; SP.pe('pointerup'); const s=SP.run(.8); SP.I().setVirtual('forward',false); return Object.assign(s,{ms:Math.round(ms)}); })()""",
        lambda r:r['ms']>=250 and not r['latched'] and not r['held'] and not r['sprinting'] and not r['down'],N+('hold-sprints',))
    await pg.wait_for_timeout(150)
    await run(pg,'hold-ends-latch',60,r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.tap(); SP.run(.5); SP.pe('pointerdown'); window.__holdAt=performance.now(); return SP.run(.5); })()""",
        lambda r:r['held'] and r['sprinting'],N)
    await pg.wait_for_timeout(350)
    await run(pg,'hold-ends-latch:lift',60,r"""(()=>{ SP.pe('pointerup'); const s=SP.run(.6); SP.I().setVirtual('forward',false); return s; })()""",
        lambda r:not r['latched'] and not r['sprinting'],N+('hold-ends-latch',))

    r=await run(pg,'exhaustion-drops',90,r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.tap(); const s0=SP.st().stam; let at=-1;
        const s=SP.run(15,k=>{ if(SP.P().exhausted){ at=k; return true; } }); const after=SP.run(.3); SP.I().setVirtual('forward',false);
        return {s0,secs:+(at/30).toFixed(2),at:s,after}; })()""",
        lambda r:r['secs']>2 and not r['after']['latched'] and r['after']['tired'] and 'tired' in r['after']['cls'] and r['after']['pressed']=='false'
                 and not r['after']['sprinting'] and not r['after']['down'],N)
    await shot(pg,'sprint-dimmed',"SP.st()")
    await run(pg,'tap-while-exhausted',60,r"""(()=>{ SP.I().setVirtual('forward',true); const t=SP.tap(); const s=SP.run(.5); SP.I().setVirtual('forward',false); return {tap:t.latched,run:s}; })()""",
        lambda r:not r['tap'] and not r['run']['latched'] and not r['run']['sprinting'] and r['run']['tired'],N+('exhaustion-drops',))
    await run(pg,'undimmed-when-rested',60,r"""(()=>{ const p=SP.P(); p.stamina=.99; SP.step(.5); return SP.st(); })()""",
        lambda r:not r['exh'] and not r['tired'] and 'tired' not in r['cls'],N+('exhaustion-drops',))

    LOSS=r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.tap(); const a=SP.run(.6); %s; SP.step(.2); const b=SP.st(); %s; SP.step(.1); SP.play(); SP.step(.3); const c=SP.st(); SP.I().setVirtual('forward',false); return {before:a.sprinting&&a.latched,during:b,back:c}; })()"""
    lost=lambda r:r['before'] and not r['during']['latched'] and r['during']['pressed']=='false' and not r['back']['latched'] and not r['back']['down']
    await run(pg,'drop:cutscene',60,LOSS%("G.cine.play('sprintTest',{dur:3,shot:(k,t,o)=>{ const p=SP.P().pos; o.cp.set(p.x+6,p.y+4,p.z+6); o.lp.copy(p); }})","G.cine.skip(); SP.step(.1)"),
        lambda r:lost(r) and r['during']['mode']=='play',N)
    await run(pg,'drop:card',60,LOSS%("G.talk.open({who:'page',name:'A note',lines:['A test card.']})","G.talk.close()"),lambda r:lost(r) and r['during']['mode']=='paused',N)
    await run(pg,'drop:pause',60,LOSS%("document.getElementById('pauseBtn').click()","0"),lambda r:lost(r) and r['during']['mode']=='paused',N)
    await run(pg,'drop:scripted',60,LOSS%("SP.P().setControl(false)","SP.P().setControl(true)"),lost,N)
    await run(pg,'drop:death',60,LOSS%("SP.P().hurt({damage:99,ignoreIframes:true,kind:'magic'})","SP.P().respawn(null,SP.SPOT.yaw); G.setMode('play')"),
        lambda r:lost(r) and r['during']['mode']=='dead',N)
    await run(pg,'drop:held-press',60,r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.pe('pointerdown'); SP.run(.4); document.getElementById('pauseBtn').click(); SP.step(.1); const b=SP.st();
        SP.play(); SP.step(.2); SP.pe('pointerup'); const c=SP.run(.4); SP.I().setVirtual('forward',false); return {during:b,after:c}; })()""",
        lambda r:not r['during']['held'] and not r['during']['down'] and not r['after']['latched'] and not r['after']['sprinting'],N)

    await run(pg,'sweep-from-touch',60,r"""(()=>{ SP.fresh(); const I=SP.I(); I.setVirtual('forward',true); SP.tap(); const s=SP.run(1.5); let seen=null;
        I.setVirtual('attack',true); SP.run(.1,()=>{ seen=SP.P().move.id||seen; }); I.setVirtual('attack',false); SP.run(.3,()=>{ seen=SP.P().move.id||seen; });
        I.setVirtual('forward',false); return {spd:s.top,move:seen,found:!!(G.moves&&G.moves.isFound&&G.moves.isFound('sweep'))}; })()""",
        lambda r:r['spd']>6.4 and r['move']=='sweep' and r['found'],N)

    # lock-on: a stand-in foe kept 3 m ahead (lock-on lets go past ~5 m); the latch stays armed and the run resumes after
    await run(pg,'lockon-keeps-armed',60,r"""(()=>{ SP.fresh(); const P=SP.P(), I=SP.I();
        const hb={team:'enemy',pos:P.pos.clone(),radius:.5,height:1.6,alive:()=>true,hit(){},targetable:true}; G.combat.add(hb);
        G.system('testFoeAhead',{order:19,update(){ const f=P.facing?P.facing():{x:1,z:0}; hb.pos.set(P.pos.x+3*Math.sin(SP.SPOT.yaw),P.pos.y,P.pos.z+3*Math.cos(SP.SPOT.yaw)); }});
        I.setVirtual('forward',true); SP.tap(); SP.run(.8); P.lockTarget=hb; const on=SP.run(1,()=>{ P.lockTarget=hb; }); P.lockTarget=null; const off=SP.run(.8);
        G.combat.remove(hb); G.systems.splice(G.systems.findIndex(s=>s.name==='testFoeAhead'),1); I.setVirtual('forward',false);
        return {locked:on,after:off}; })()""",
        lambda r:not r['locked']['sprinting'] and r['locked']['latched'] and r['locked']['spd']<4.5 and r['after']['sprinting'] and r['after']['latched'],N)
    # a strike out of a running sprint is the Dashing Sweep, so the charge starts from rest with the latch armed, then walks
    await run(pg,'charge-keeps-armed',60,r"""(()=>{ SP.fresh(); const I=SP.I(); SP.tap(); I.setVirtual('attack',true); SP.run(.6); I.setVirtual('forward',true);
        let charged=false; const on=SP.run(1,()=>{ if(SP.P().state==='charge')charged=true; }); I.setVirtual('attack',false); SP.run(.8); const off=SP.run(1); I.setVirtual('forward',false);
        return {charged,during:on,after:off}; })()""",
        lambda r:r['charged'] and not r['during']['sprinting'] and r['during']['top']<2.5 and r['during']['latched'] and r['after']['sprinting'] and r['after']['latched'],N)
    await run(pg,'legend-lists-sprint',60,r"""(()=>{ SP.fresh(); document.getElementById('pauseBtn').click(); SP.step(.1); const t=document.querySelector('#pause [data-touch-legend]');
        const txt=t?t.innerText.replace(/\s+/g,' '):''; SP.play(); return {vis:!!t&&!t.hidden,txt}; })()""",
        lambda r:r['vis'] and 'Sprint sprint, tap to keep running' in r['txt'],N)
    await run(pg,'touch-nudge',90,r"""(()=>{ SP.fresh(); G._onb.S.said.sprint=0; __said.length=0; SP.I().setVirtual('forward',true); SP.run(9.5); SP.I().setVirtual('forward',false);
        const lines=__said.filter(t=>/Sprint/.test(t)); __said.length=0; SP.I().setVirtual('forward',true); G._onb.S.said.sprint=0; SP.tap(); SP.run(1); SP.tap(); SP.run(9.5);
        SP.I().setVirtual('forward',false); return {lines,again:__said.filter(t=>/Sprint/.test(t)).length,said:G._onb.S.said.sprint}; })()""",
        lambda r:len(r['lines'])==1 and r['again']==0 and r['said']==1,N)

    # nothing about the latch is kept: latched, saved, reloaded, continued -> off
    try:
        r0=await ev(pg,r"""(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); SP.tap(); SP.run(.5); const s=SP.st(); G.flow.writeSave(); return {latched:s.latched,save:!!localStorage.getItem(G.flow.keys.active)}; })()""")
        await pg.reload(); await pg.wait_for_timeout(4000)
        await ev(pg,"(()=>{ document.getElementById('continue').click(); G.step(1/30,40); return 1; })()",120); await ev(pg,LIB)
        await run(pg,'reload-not-latched',60,"(()=>Object.assign(SP.st(),{r0:%s}))()"%json.dumps(r0),
            lambda r:r['r0']['latched'] and r['r0']['save'] and not r['latched'] and r['pressed']=='false' and not r['down'] and r['mode']=='play',N)
    except Exception as e: check('reload-not-latched',False,{'error':str(e)[:300]})
    check('touch:errors',not errs,errs[:5])
    await ctx.close()

async def desktop_suite(b):
    ctx,pg,errs=await boot(b,mobile=False,pad=True)
    try: await begin(pg)
    except Exception as e: check('desktop:boot',False,{'error':str(e)[:300]}); await ctx.close(); return
    await run(pg,'no-touch:hidden',30,"(()=>Object.assign(SP.st(),{isMobile:G.isMobile}))()",lambda r:not r['shown'] and not r['isMobile'])
    await ev(pg,"(()=>{ SP.fresh(); SP.I().setVirtual('forward',true); return 1; })()")
    await pg.keyboard.down('Shift')
    await run(pg,'keyboard-shift',60,"SP.run(1.2)",lambda r:r['sprinting'] and r['top']>8.0 and r['state']=='sprint' and not r['latched'])
    await pg.keyboard.up('Shift')
    await run(pg,'keyboard-release',60,"(()=>{ const s=SP.run(.8); return s; })()",lambda r:not r['sprinting'] and not r['down'] and r['spd']<5.6)
    await run(pg,'keyboard-stop',60,"(()=>{ SP.I().setVirtual('forward',false); return SP.run(.5); })()",lambda r:not r['sprinting'])
    await run(pg,'pad-lb',60,"(()=>{ SP.fresh(); __axis(1,-1); __btn(4,true); const s=SP.run(1.2); return Object.assign(s,{device:G.input.device}); })()",
        lambda r:r['sprinting'] and r['top']>8.0 and r['device']=='gamepad' and not r['latched'])
    await run(pg,'pad-release',60,"(()=>{ __btn(4,false); const s=SP.run(.8); __axis(1,0); SP.run(.3); return s; })()",lambda r:not r['sprinting'] and not r['down'])
    await run(pg,'pad-ls-click',60,"(()=>{ SP.fresh(); __axis(1,-1); __btn(10,true); const s=SP.run(1.2); __btn(10,false); __axis(1,0); SP.run(.3); return s; })()",lambda r:r['sprinting'])
    check('desktop:errors',not [e for e in errs if 'Gamepad' not in e],errs[:5])
    await ctx.close()

async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(**CHROME)
        try:
            await asyncio.wait_for(touch_suite(b),900)
        except asyncio.TimeoutError: check('touch-suite',False,{'timeout':900})
        try:
            await asyncio.wait_for(desktop_suite(b),400)
        except asyncio.TimeoutError: check('desktop-suite',False,{'timeout':400})
        await b.close()
    print('RESULT', 'PASS' if ok_all else 'FAIL', flush=True)
    sys.exit(0 if ok_all else 1)

asyncio.run(main())
