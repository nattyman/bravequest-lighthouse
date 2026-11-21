"""HUD e2e (~4-6 min): the stacked caption cards (back cards, +N badge, the slide when the front card goes, reduced motion),
the stamina wheel (hidden at full, green / amber / exhausted / refill pulse) and the controller status (standard pad,
non-standard Xbox layout, a ghost pad listed first, a null entry, a SecurityError, a permissions policy that forbids
'gamepad', no pads), including A starting the game from the title; the touch buttons on a phone (where each sits, sizes,
nothing overlapping, clear of the objective, the map/pause buttons and the safe areas, at four landscape phone sizes, a
landscape tablet and portrait, each firing its own action) and the pause menu's touch legend.
Screenshots go to /tmp/claude-0/hud/ (desktop 1280x760, phone portrait 390x844 and landscape 844x390, the touch cluster at each size).
usage: python3 test/hud_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)
"""
import asyncio, sys, time, json, os
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
OUT='/tmp/claude-0/hud'; os.makedirs(OUT,exist_ok=True)
CHROME=dict(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
results=[]; ok_all=True
def check(name,ok,info):
    global ok_all
    ok_all=ok_all and bool(ok); results.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name:22s} {json.dumps(info)[:420]}",flush=True)

HELPERS=r"""
window.T={
  // stamina pinned after player.js (order 20) so regen in the real-time loop doesn't move it between steps and screenshots
  pin:null,
  stam(v,ex,n){ T.pin={s:v,e:!!ex}; G.step(1/30,n||20); return G.ui.staminaWheel(); },
  unpin(){ T.pin=null; },
  lines(n){ G.ui.setCaptionSpeed('hold'); G.ui.clearCaptions(); const who=['Halloran','Hesper','','Wren','Halloran','Corwin'];
    for(let i=0;i<n;i++)G.ui.say(['The fog came in off the water before dawn, and it has not lifted since.','Keep the lantern shut near the patches.',
      'Something moves on the moor.','The bell in the hamlet rang once, then stopped.','The tower door faces west.','Mind the stair.'][i%6],who[i%6]);
    G.step(1/30,3); return G.ui.captionStack(); },
  // place the player on the open headland, facing away from the tower so the wheel sits over the sky and grass
  spot(){ G.player.teleport(150,42.2,-14,Math.PI*.5); G.step(1/30,20); },
  rect(el){ if(!el)return null; const r=el.getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom}; },
  overlap(a,b){ return a&&b&&a.l<b.r&&b.l<a.r&&a.t<b.b&&b.t<a.b; },
};
G.system('testPinStamina',{order:21,update(){ const p=T.pin; if(p&&G.player){ G.player.stamina=p.s; G.player.exhausted=p.e; } }});
G.input.lockPointer=()=>{}; G.input.unlockPointer=()=>{};
"""

def pad_js(kind):
    """an init script that stubs navigator.getGamepads before the game loads"""
    base=r"""
window.__mk=(id,mapping,nb,axes,index)=>({id,index,connected:true,mapping,timestamp:0,axes:axes.slice(),buttons:Array.from({length:nb},()=>({pressed:false,touched:false,value:0}))});
window.__btn=(p,i,on)=>{ p.buttons[i]={pressed:!!on,touched:!!on,value:on?1:0}; p.timestamp++; };
"""
    if kind=='standard': body="window.__pad=__mk('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)','standard',17,[0,0,0,0],0); navigator.getGamepads=()=>[__pad,null,null,null];"
    elif kind=='nonstandard': body="window.__pad=__mk('045e-02ea-Microsoft X-Box One S pad','',11,[0,0,-1,0,0,-1,0,0],0); navigator.getGamepads=()=>[__pad,null,null,null];"
    elif kind=='ghost': body="window.__ghost=__mk('Virtual Gamepad (STANDARD GAMEPAD)','standard',17,[0,0,0,0],0); window.__pad=__mk('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)','standard',17,[0,0,0,0],2); navigator.getGamepads=()=>[__ghost,null,__pad,null];"
    elif kind=='none': body="navigator.getGamepads=()=>[null,null,null,null];"
    elif kind=='throw': body="navigator.getGamepads=()=>{ throw new DOMException(\"Failed to execute 'getGamepads' on 'Navigator': Access to the feature \\\"gamepad\\\" is disallowed by permissions policy.\",'SecurityError'); };"
    elif kind=='policy': body="Object.defineProperty(document,'permissionsPolicy',{configurable:true,value:{allowsFeature:f=>f!=='gamepad'}}); Object.defineProperty(document,'featurePolicy',{configurable:true,value:undefined}); navigator.getGamepads=()=>[null,null,null,null];"
    return base+body

async def shot(pg,name):
    # headless frames are rare, so CSS transitions can sit at their start for a while: settle the finite ones first
    await pg.evaluate("document.getElementById('toast').classList.remove('show')") # the 'Controller connected' toast from the stub pad
    await pg.evaluate("(()=>{ for(const a of document.getAnimations()){ try{ if(a.effect&&a.effect.getTiming().iterations!==Infinity)a.finish(); }catch(_){} } G.headless&&G.headless.draw(3); })()"); await pg.wait_for_timeout(300)
    await pg.screenshot(path=f'{OUT}/{name}.png',timeout=120000)

async def boot(b,kind=None,view=None,mobile=False,reduce=False,insets=None):
    errs=[]
    kw=dict(viewport=view or {'width':1280,'height':760})
    if mobile: kw.update(is_mobile=True,has_touch=True,device_scale_factor=2)
    if reduce: kw.update(reduced_motion='reduce')
    ctx=await b.new_context(**kw)
    if kind: await ctx.add_init_script(pad_js(kind))
    pg=await ctx.new_page()
    if insets:   # a notched phone's safe areas (top,right,bottom,left), so env(safe-area-inset-*) is what the phone reports
        t,r,bt,l=insets; await (await ctx.new_cdp_session(pg)).send('Emulation.setSafeAreaInsetsOverride',{'insets':{'top':t,'right':r,'bottom':bt,'left':l}})
    pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
    pg.on('console',lambda m:errs.append('console: '+m.text) if m.type=='error' and '404' not in m.text else None)
    await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(5000)
    return ctx,pg,errs

async def play(pg):
    await pg.evaluate("(()=>{ document.getElementById('begin').click(); G.step(1/30,40); })()")
    await pg.evaluate(HELPERS)

async def views(b):
    """stack + stamina + pause controller line at three sizes; the touch checks on phones"""
    for tag,view,mobile in [('desktop',{'width':1280,'height':760},False),('portrait',{'width':390,'height':844},True),('landscape',{'width':844,'height':390},True)]:
        ctx,pg,errs=await boot(b,'standard',view,mobile)
        await play(pg)
        await pg.evaluate("T.spot(); G.ui.clearCaptions(); G.ui.clearMessages()")
        # 1. stack: five lines -> front + two edges + '+4'; Enter moves the next one forward (a leaving copy slides off)
        if tag=='desktop':
            r=await pg.evaluate("""(()=>{ const s0=T.lines(5); const c0=G.ui.captions();
              G.ui.advance(); G.ui.advance(); G.step(1/30,2); const s1=G.ui.captionStack(), c1=G.ui.captions();
              G.ui.advance(); G.ui.advance(); G.step(1/30,2); const s2=G.ui.captionStack();
              G.ui.advance(); G.ui.advance(); G.step(1/30,2); const s3=G.ui.captionStack();
              G.ui.advance(); G.ui.advance(); G.step(1/30,2); const s4=G.ui.captionStack();
              G.ui.advance(); G.ui.advance(); G.step(1/30,2); const s5=G.ui.captionStack(), c5=G.ui.captions();
              return {s0,q0:c0.queue.length,cur0:c0.cur.text.slice(0,12),s1,cur1:c1.cur.text.slice(0,12),q1:c1.queue.length,s2,s3,s4,s5,end:!c5.cur,
                hint:document.querySelector('#cap .capnext').textContent}; })()""")
            ok=(r['s0']['depth']==2 and r['s0']['count']=='+4' and r['s0']['who']==['Hesper',''] and r['q0']==4
                and r['s1']['depth']==2 and r['s1']['count']=='+3' and r['s1']['leaving']>=1 and r['cur1'].startswith('Keep') and r['s1']['who']==['','Wren']
                and r['s2']['depth']==2 and r['s2']['count']=='' and r['s3']['depth']==1 and r['s4']['depth']==0 and r['s5']['depth']==0 and r['end'])
            check('stack:advance',ok,r)
            # the timed modes still pace the queue: a Standard queue drains on its own, the stack shrinking as it goes
            r=await pg.evaluate("""(()=>{ G.ui.setCaptionSpeed('standard'); G.ui.clearCaptions(); for(const t of ['One line.','Two line.','Three line.'])G.ui.say(t,'Halloran');
              G.step(1/30,2); const d0=G.ui.captionStack().depth; let seen=[]; for(let k=0;k<40;k++){ G.step(1/30,15); const c=G.ui.captions(); seen.push(G.ui.captionStack().depth); if(!c.cur&&!c.queue.length)break; }
              const out={d0,seen:[...new Set(seen)],done:!G.ui.captions().cur}; G.ui.setCaptionSpeed('hold'); return out; })()""")
            check('stack:timed',r['d0']==2 and 1 in r['seen'] and 0 in r['seen'] and r['done'],r)
            # a same-key update rewrites the front card in place (no slide); low lines still never wait behind real ones
            r=await pg.evaluate("""(()=>{ G.ui.clearCaptions(); G.ui.say('3 moths left',{key:'m'}); G.step(1/30,2); const l0=document.querySelectorAll('.caption.leaving').length;
              G.ui.say('2 moths left',{key:'m'}); G.step(1/30,1); const l1=document.querySelectorAll('.caption.leaving').length;
              G.ui.say('Real line.'); G.ui.say('a flavour aside',{priority:'low'}); G.step(1/30,2);
              return {l0,l1,cur:G.ui.captions().cur.text,q:G.ui.captions().queue.map(q=>q.text)}; })()""")
            check('stack:inplace',r['l1']==r['l0'] and r['cur']=='2 moths left' and r['q']==['Real line.'],r)
        # the 3-deep stack (front + two edges, +3) for the screenshot; on phones it must stay clear of the touch buttons
        await pg.wait_for_timeout(800)
        r=await pg.evaluate("""(()=>{ const s=T.lines(4); G.ui.advance(); G.step(1/30,2); const st=document.getElementById('capStack');
          const backs=[...st.querySelectorAll('.capback.on')].map(T.rect), cnt=T.rect(document.getElementById('capCount')), front=T.rect(document.getElementById('cap'));
          const btns=[...document.querySelectorAll('#touch button')].filter(b=>b.getClientRects().length&&!b.hidden).map(T.rect);
          const hearts=T.rect(document.querySelector('#hud .hud-top'));
          const all=[front,...backs,cnt].filter(Boolean);
          return {s:G.ui.captionStack(), hitsTouch:all.some(a=>btns.some(b=>T.overlap(a,b))), btns:btns.length,
            inView:all.every(a=>a.l>=0&&a.t>=0&&a.r<=innerWidth&&a.b<=innerHeight), hitsTop:backs.concat(cnt?[cnt]:[]).some(a=>T.overlap(a,hearts)), front, backs, cnt}; })()""")
        check(f'stack:{tag}',r['s']['depth']==2 and r['s']['count']=='+3' and not r['hitsTouch'] and r['inView'] and not r['hitsTop'] and (r['btns']>0)==mobile,r)
        await pg.wait_for_timeout(1500)
        await shot(pg,f'stack-{tag}')
        await pg.evaluate("G.ui.clearCaptions()"); await pg.wait_for_timeout(1200)
        # 2. stamina: hidden at full, green at 50%, amber at 20%, flashing while exhausted, a pulse when it refills, then gone
        if tag=='desktop':
            r=await pg.evaluate("""(()=>{ const full=T.stam(1,false,30), half=T.stam(.5,false), w=document.getElementById('stamina').getBoundingClientRect().width, low=T.stam(.2,false), exh=T.stam(.1,true);
              const arc=getComputedStyle(document.getElementById('stamArc')).animationName;
              T.stam(.97,false,10); T.pin={s:1,e:false}; G.step(1/30,3); const pulse=G.ui.staminaWheel(); G.step(1/30,90); const after=G.ui.staminaWheel(); T.unpin();
              return {full,half,low,exh,arc,pulse,after,w}; })()""")
            ok=(not r['full']['shown'] and r['half']['shown'] and r['half']['state']=='ok' and abs(r['half']['frac']-.5)<.02 and r['low']['state']=='low'
                and r['exh']['state']=='exh' and r['arc']=='stamExh' and r['pulse']['shown'] and r['pulse']['state']=='full' and not r['after']['shown'] and 48<=r['w']<=60)
            check('stamina:states',ok,r)
        await pg.evaluate("T.stam(.5,false)"); await shot(pg,f'stamina50-{tag}')
        await pg.evaluate("T.stam(.18,true)"); await shot(pg,f'stamina-exhausted-{tag}')
        r=await pg.evaluate("(()=>{ const w=G.ui.staminaWheel(), e=T.rect(document.getElementById('stamina')); return {w,inView:e.l>=0&&e.t>=0&&e.r<=innerWidth&&e.b<=innerHeight}; })()")
        check(f'stamina:{tag}',r['w']['shown'] and r['w']['state']=='exh' and r['inView'],r)
        await pg.evaluate("T.unpin(); T.stam(1,false,5); T.unpin()")
        # 3. pause menu with the controller line
        await pg.evaluate("(()=>{ document.getElementById('pauseBtn').click(); G.step(1/30,2); })()")
        await pg.wait_for_timeout(700)
        r=await pg.evaluate("(()=>{ const e=document.querySelector('#pause [data-pad-status]'); const r=e.getBoundingClientRect(); return {mode:G.state.mode,text:e.textContent,state:e.dataset.state,vis:r.height>0}; })()")
        check(f'pause:{tag}',r['mode']=='paused' and r['state']=='connected' and 'Xbox Wireless Controller — connected' in r['text'] and r['vis'],r)
        # a controller in use: its legend, never the touch one (on a phone too)
        r=await pg.evaluate(LEGEND_JS)
        check(f'pause-legend:{tag}',r['pad'] and not r['touch'] and not r['kb'] and r['device']=='gamepad',{k:r[k] for k in ('device','pad','touch','kb')})
        await pg.evaluate("(()=>{ const e=document.querySelector('#pause [data-pad-status]'); e.scrollIntoView({block:'center'}); })()")
        await shot(pg,f'pause-controller-{tag}')
        check(f'errors:{tag}',not errs,errs[:5])
        await ctx.close()

async def reduced(b):
    ctx,pg,errs=await boot(b,None,{'width':844,'height':390},True,reduce=True)
    await play(pg)
    r=await pg.evaluate("(()=>{ const s0=T.lines(3); const typing=G.ui.captions().cur.typing; G.ui.advance(); G.step(1/30,1); return {s0,typing,s1:G.ui.captionStack(),cur:G.ui.captions().cur.text.slice(0,8)}; })()")
    check('stack:reduced-motion',r['s0']['depth']==2 and not r['typing'] and r['s1']['depth']==1 and r['s1']['leaving']==0 and r['cur']=='Keep the',r)
    await ctx.close()

async def pads(b):
    # A on the title starts the game (the Begin button), and the Controls screen names the pad
    for kind,name in [('standard','Xbox Wireless Controller'),('nonstandard','Xbox Wireless Controller'),('ghost','Xbox Wireless Controller')]:
        ctx,pg,errs=await boot(b,kind)
        r=await pg.evaluate("""(()=>{ G.step(1/30,2); const before=G.input.gamepad;
          __btn(__pad,0,true); G.step(1/30,3); __btn(__pad,0,false); G.step(1/30,30);
          const c=document.querySelector('#controlsCard [data-pad-status]');
          return {mode0:'title',before,ctl:c.textContent,ctlState:c.dataset.state,mode1:G.state.mode,after:G.input.gamepad,title:!document.getElementById('title').hidden}; })()""")
        await pg.evaluate(HELPERS)
        extra={}
        if kind=='nonstandard':
            # at rest the -1 triggers must not turn the camera; the right stick (axis 3) does; LT (axis 2) reads as lock-on
            extra=await pg.evaluate("""(()=>{ const looks=[]; G.input.endFrame(); G.input.poll(1/30); looks.push(G.input.look().x); G.input.endFrame();
              __pad.axes[3]=.9; G.input.poll(1/30); const turn=G.input.look().x; G.input.endFrame(); __pad.axes[3]=0;
              __pad.axes[2]=1; G.input.poll(1/30); const lt=G.input.down('lock'); G.input.endFrame(); __pad.axes[2]=-1; G.input.poll(1/30); G.input.endFrame();
              __pad.axes[0]=.9; G.input.poll(1/30); const mv=G.input.move(); G.input.endFrame(); __pad.axes[0]=0;
              return {rest:looks[0],turn,lt,mx:+mv.x.toFixed(2)}; })()""")
        ok=(r['mode0']=='title' and r['ctlState']=='connected' and (name+' — connected') in r['ctl'] and r['mode1']=='play' and not r['title'])
        if kind=='nonstandard': ok=ok and 'remapped' in r['ctl'] and extra['rest']==0 and extra['turn']>5 and extra['lt'] and extra['mx']>.5
        if kind=='ghost': ok=ok and r['after']['index']==2
        check(f'pad:{kind}',ok,{**r,**extra})
        check(f'pad:{kind}:errors',not errs,errs[:5])
        await ctx.close()
    # no controller / blocked by a SecurityError / blocked by the permissions policy
    for kind,state,want in [('none','none','No controller found — connect it and press A'),
                            ('throw','blocked','Controllers are blocked in this embedded page — open the game in its own tab'),
                            ('policy','blocked','Controllers are blocked in this embedded page — open the game in its own tab')]:
        ctx,pg,errs=await boot(b,kind)
        r=await pg.evaluate("""(()=>{ G.step(1/30,2); const n=document.getElementById('padNote'); if(document.activeElement)document.activeElement.blur();
          document.getElementById('controlsBtn').click(); G.step(1/30,4); const c=document.querySelector('#controlsCard [data-pad-status]');
          const out={note:n.hidden?'':n.textContent,ctl:c.textContent,state:c.dataset.state,pad:G.input.gamepad};
          document.getElementById('controlsBack').click(); G.step(1/30,2); return out; })()""")
        ok=r['state']==state and r['ctl'].startswith(want)
        if kind=='none': ok=ok and 'Press A' in r['note']
        if kind=='throw': ok=ok and 'SecurityError' in r['ctl'] and r['pad']['blocked']
        if kind!='none': ok=ok and 'blocked' in r['note']
        check(f'pad:{kind}',ok,r)
        if kind=='throw': await shot(pg,'title-blocked-desktop')
        if kind=='none': await shot(pg,'title-nopad-desktop')
        check(f'pad:{kind}:errors',not [e for e in errs if 'Gamepad' not in e],errs[:5])
        await ctx.close()

TOUCH_JS=r"""(()=>{ const R=b=>{ const r=b.getBoundingClientRect(); return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,w:r.width,l:r.left,t:r.top,r:r.right,b:r.bottom}; };
  const btn=a=>document.querySelector(`#touch button[data-act="${a}"]`);
  // the longest objective sub-line in the game (two lines on a phone), so the block is as tall as it gets
  G.ui.objective('Get out of the cold','Tamsin in the cellars · Corwin at the chapel door · Wren in the vestry · Hob at the mill');
  const env=document.createElement('div'); env.style.cssText='position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(env); const cs=getComputedStyle(env), safe={t:parseFloat(cs.paddingTop),r:parseFloat(cs.paddingRight),b:parseFloat(cs.paddingBottom),l:parseFloat(cs.paddingLeft)}; env.remove();
  const s=R(btn('attack')), off={}; for(const a of ['jump','interact','roll','lock','shutter'])off[a]=(o=>({dx:Math.round(o.x-s.x),dy:Math.round(o.y-s.y),w:o.w}))(R(btn(a)));
  const top=[...document.querySelectorAll('#pauseBtn,#mapBtn,#hud .hud-top,#hud .quest')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect());
  const quest=document.querySelector('#hud .quest').getBoundingClientRect();
  // the layout as it starts (no optional buttons) and with every contextual button shown at once (positions are fixed, so
  // that covers every mix of them): no two circles may touch, all on screen and inside the safe areas, none in the stick's
  // left 42%, none over the objective or the map/pause buttons
  const sets={}, hid=[...document.querySelectorAll('#touch button')].filter(b=>b.hidden);
  for(const st of ['basic','all']){
    if(st==='all')hid.forEach(b=>b.hidden=false);
    const all=[...document.querySelectorAll('#touch button')].filter(b=>b.getClientRects().length&&getComputedStyle(b).display!=='none').map(b=>({a:b.dataset.act,...R(b)}));
    const close=[]; for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){ const g=Math.hypot(all[i].x-all[j].x,all[i].y-all[j].y)-(all[i].w+all[j].w)/2; if(g<4)close.push([all[i].a,all[j].a,Math.round(g)]); }
    const offscreen=all.filter(b=>b.l<safe.l||b.t<safe.t||b.r>innerWidth-safe.r||b.b>innerHeight-safe.b).map(b=>b.a);
    const core=all.filter(b=>['attack','jump','interact','roll','lock','shutter','potion'].includes(b.a));
    const inStick=core.filter(b=>b.l<innerWidth*.42).map(b=>b.a);
    const overTop=all.filter(b=>top.some(t=>b.l<t.right&&t.left<b.r&&b.t<t.bottom&&t.top<b.b)).map(b=>b.a);
    sets[st]={n:all.length,acts:all.map(b=>b.a),close,offscreen,inStick,overTop,highest:Math.round(Math.min(...all.map(b=>b.t)))};
  }
  hid.forEach(b=>b.hidden=true);
  // each button fires its own action: the button on top at its centre takes the press, and only its action goes down
  const ACTS=['attack','jump','interact','roll','lock','shutter'], fires={};
  for(const a of ACTS){ const c=R(btn(a)), hit=document.elementFromPoint(c.x,c.y), b=hit&&hit.closest('#touch button');
    if(!b){ fires[a]='nothing at its centre'; continue; }
    b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));
    const down=ACTS.filter(x=>G.input.down(x)); b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch'}));
    fires[a]=b.dataset.act===a&&down.length===1&&down[0]===a?'ok':{hit:b.dataset.act,down}; }
  return {strike:s.w,off,sets,safe,questBottom:Math.round(quest.bottom),rollTop:Math.round(R(btn('roll')).t),fires,device:G.input.device}; })()"""

LEGEND_JS=r"""(()=>{ const p=document.getElementById('pause'), t=p.querySelector('[data-touch-legend]'), k=p.querySelector('[data-kb-legend]'), pl=p.querySelector('[data-pad-legend]');
  const vis=e=>!!e&&!e.hidden&&e.getClientRects().length>0;
  return {mode:G.state.mode,device:G.input.device,touch:vis(t),kb:vis(k),pad:vis(pl),text:t?t.innerText.replace(/\s+/g,' '):'',
    chips:t?[...t.querySelectorAll('.tb')].map(c=>c.textContent.trim()||'icon'):[]}; })()"""

async def touch(b):
    """the thumb cluster on a touch phone (no controller): Strike in the corner, Jump right above it and Roll above Jump in one
    column under the right thumb, in portrait and landscape (a playtester on a big phone found Roll too far left in landscape);
    Jump and Roll a size up but under Strike; in landscape Use / Lock / Shut in a column beside them; nothing touching, nothing
    over the objective (at its tallest) or the map/pause buttons, nothing in the safe areas; each button fires its own action;
    the pause menu lists the touch controls on touch and the keyboard legend again once a keyboard is used"""
    only=os.environ.get('TOUCH_ONLY','')
    # landscape phones with their safe areas (top,right,bottom,left): 6.9", 6.7", 6.1" notched, then the smallest (no notch);
    # a landscape tablet; portrait (unchanged)
    for tag,view,ins in [('landscape',{'width':844,'height':390},(0,47,21,47)),('land956',{'width':956,'height':440},(0,62,21,62)),
                         ('land932',{'width':932,'height':430},(0,59,21,59)),('small',{'width':667,'height':375},None),
                         ('tablet',{'width':1180,'height':820},(24,0,20,0)),('portrait',{'width':390,'height':844},(47,0,34,0))]:
        if only and tag not in only: continue
        ctx,pg,errs=await boot(b,'none',view,True,insets=ins)
        await play(pg)
        await pg.evaluate("T.spot(); G.ui.clearCaptions()")
        r=await pg.evaluate(TOUCH_JS)
        o=r['off']; near=lambda v,w,tol=4: abs(v-w)<=tol
        land=tag!='portrait'
        if land:
            pos=(near(o['jump']['dx'],0) and near(o['roll']['dx'],0)                    # one column: Roll above Jump above Strike
                 and o['roll']['dy']<o['jump']['dy']-60 and o['jump']['dy']<=-80
                 and near(o['interact']['dx'],-92) and near(o['interact']['dy'],0)      # Use / Lock / Shut: the next column, same rows
                 and near(o['lock']['dx'],-92) and near(o['lock']['dy'],-86)
                 and near(o['shutter']['dx'],-92) and near(o['shutter']['dy'],-168))
        else:
            pos=(near(o['jump']['dx'],0) and near(o['jump']['dy'],-96)                  # portrait as it was: Jump right above Strike,
                 and near(o['roll']['dx'],0) and near(o['roll']['dy'],-174)             # Roll above Jump,
                 and near(o['interact']['dx'],-96) and near(o['interact']['dy'],0)      # Use left of Strike,
                 and near(o['lock']['dx'],-68) and near(o['lock']['dy'],-68)            # Lock on the diagonal,
                 and near(o['shutter']['dx'],-83) and near(o['shutter']['dy'],-144))    # Shut above it
        check(f'touch:layout:{tag}',pos and r['device']=='touch',{k:r[k] for k in ('off','device')})
        sizes=(r['strike']>=80 and o['jump']['w']>60 and o['roll']['w']>60 and r['strike']-o['jump']['w']>=12 and r['strike']-o['roll']['w']>=12
               and o['interact']['w']==60 and o['lock']['w']==60)
        check(f'touch:sizes:{tag}',sizes,{'strike':r['strike'],**{a:o[a]['w'] for a in o}})
        clear=all(not v['close'] and not v['offscreen'] and not v['inStick'] and not v['overTop'] for v in r['sets'].values()) and r['sets']['all']['n']>=10
        check(f'touch:clear:{tag}',clear and r['rollTop']>=r['questBottom']+8,{'sets':r['sets'],'safe':r['safe'],'questBottom':r['questBottom'],'rollTop':r['rollTop']})
        check(f'touch:fires:{tag}',all(v=='ok' for v in r['fires'].values()),r['fires'])
        await pg.evaluate("G.headless.draw(3)"); await pg.wait_for_timeout(300); await shot(pg,f'touch-cluster-{tag}')
        # the pause menu: the touch legend, with the button names and the held moves, and no keyboard rows
        await pg.evaluate("(()=>{ document.getElementById('pauseBtn').click(); G.step(1/30,2); })()"); await pg.wait_for_timeout(500)
        r=await pg.evaluate(LEGEND_JS)
        want=['Strike strike, hold to charge','Jump jump, hold to glide','Roll dodge roll','Lock lock on','Use interact','Shut lantern shutter','drag to move','drag to look around','next message']
        check(f'pause-touch:{tag}',r['mode']=='paused' and r['touch'] and not r['kb'] and not r['pad'] and all(w in r['text'] for w in want),r)
        if tag=='landscape':
            await pg.evaluate("(()=>{ const p=document.getElementById('pause'); (p.querySelector('[data-touch-legend]:not([hidden])')||p.querySelector('[data-kb-legend]')).scrollIntoView({block:'start'}); document.activeElement&&document.activeElement.blur(); })()")
            await shot(pg,'pause-touch-landscape')
            # a keyboard on the phone takes over: the keyboard legend comes back (the existing device rule); a touch brings the touch one back
            await pg.keyboard.press('ShiftLeft'); await pg.evaluate("G.step(1/30,2)")
            k=await pg.evaluate(LEGEND_JS)
            await pg.evaluate("window.dispatchEvent(new TouchEvent('touchstart',{bubbles:true})); G.step(1/30,2)")
            t2=await pg.evaluate(LEGEND_JS)
            check('pause-touch:keyboard-on-phone',k['device']=='keyboard' and k['kb'] and not k['touch'] and t2['device']=='touch' and t2['touch'] and not t2['kb'],{'kb':k,'back':{x:t2[x] for x in ('device','touch','kb')}})
        check(f'touch:errors:{tag}',not errs,errs[:5])
        await ctx.close()
    # desktop, no controller: the keyboard legend as before, no touch legend
    ctx,pg,errs=await boot(b,'none')
    await play(pg)
    await pg.evaluate("(()=>{ document.getElementById('pauseBtn').hidden=false; document.getElementById('pauseBtn').click(); G.step(1/30,2); })()"); await pg.wait_for_timeout(300)
    r=await pg.evaluate(LEGEND_JS)
    check('pause-touch:desktop-keyboard',r['mode']=='paused' and r['kb'] and not r['touch'] and r['device']=='keyboard',r)
    check('touch:errors:desktop',not errs,errs[:5])
    await ctx.close()

async def main():
    t0=time.time()
    async with async_playwright() as p:
        b=await p.chromium.launch(**CHROME)
        only=os.environ.get('HUD_ONLY','')
        if not only or 'pads' in only: await pads(b)
        if not only or 'reduced' in only: await reduced(b)
        if not only or 'views' in only: await views(b)
        if not only or 'touch' in only: await touch(b)
        await b.close()
    print(('PASS' if ok_all else 'FAIL'),f'{len(results)} checks',f'{time.time()-t0:.0f}s'); sys.exit(0 if ok_all else 1)
asyncio.run(main())
