# The test tools follow the account's role (js/devtools.js, the 'roles' gate) on a page that looks like the public build with
# accounts on: window.BQ_CONFIG = {api, devtools:false, accounts:true}, set the way test/beta_e2e.py sets it. A small stand-in
# G.account (this file only; it never ships) is put on window.G as core.js creates it, before any other module runs, so the
# tests choose who is signed in and when the account answers. The save service is a fake answered here.
# Also: the public build with accounts off still opens the tools with ?debug, and a dev build (no BQ_CONFIG) is unchanged
# (test/devtools_e2e.py is the full proof of that).
# Usage: python3 test/roles_e2e.py "http://localhost:PORT/dev.html?headless"
import asyncio, json, re, sys
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8826/dev.html?headless"
API = "https://save.test"
CFG_ON = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false,accounts:true};" % API
CFG_OFF = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false};" % API
BUDGET = 300  # seconds a single check may take
ALL = ['start', 'cheats', 'give', 'map', 'teleport', 'monsters']
TESTER = ['start', 'give', 'map', 'teleport']

# the stand-in account: signed-in state comes from localStorage 'rt-acct' (a `me`), the first answer (ready) after 'rt-delay' ms
STANDIN = r"""
(()=>{
  const S={state:'checking',me:null,readyAt:0,modeAtReady:null,stashAtReady:null}; let G0=null;
  let stored=null, delay=0; try{ stored=JSON.parse(localStorage.getItem('rt-acct')||'null'); delay=+(localStorage.getItem('rt-delay')||0); }catch(_){}
  const emit=(n,d)=>{ if(G0&&G0.emit)G0.emit(n,d); };
  const A={on:true, get state(){return S.state;}, get me(){return S.me;}, ready:null,
    can(g){ return S.state==='in'&&!!S.me&&(S.me.tools||[]).includes(g); }};
  A.ready=new Promise(res=>{ addEventListener('load',()=>setTimeout(()=>{
    S.modeAtReady=G0&&G0.state?G0.state.mode:null; try{ S.stashAtReady=sessionStorage.getItem('bq-devtools-boot')||localStorage.getItem('bq-devtools-boot'); }catch(_){}
    if(stored){ S.me=stored; S.state='in'; } else S.state='out';
    S.readyAt=performance.now(); res();
    if(stored)emit('account:in',{me:stored,fresh:false}); else emit('account:out',{});
  },delay)); });
  window.__acct={S,A,
    set(tools,role){ const me={id:'t1',email:'t@example.test',name:'',role:role||'tester',tools:tools.slice(),hasPassword:false,created:0};
      const was=S.state; S.me=me; S.state='in'; emit(was==='in'?'account:me':'account:in',{me,fresh:was!=='in'}); },
    out(){ S.state='out'; S.me=null; emit('account:out',{}); }};
  Object.defineProperty(window,'G',{configurable:true,enumerable:true,get(){return undefined;},set(v){
    Object.defineProperty(window,'G',{value:v,writable:true,configurable:true,enumerable:true}); G0=v;
    Object.defineProperty(v,'account',{configurable:false,enumerable:true,get(){return A;},set(){}}); }});
})();
"""

# what the panel shows: which groups have their controls in the DOM
LIB = r"""
window.RT={
  groups(){ const c=document.getElementById('devtools'); if(!c)return null; const q=s=>!!c.querySelector(s);
    const g={start:q('[data-start]'),cheats:q('[data-cheat]')||q('[data-speed]'),give:q('[data-give]')||q('[data-tide]')||q('[data-capspeed]')||q('[data-prog]'),
      map:q('[data-act="mapReveal"]'),teleport:q('[data-tp]'),monsters:q('[data-spawn]')||q('[data-act="kill"]')};
    return Object.keys(g).filter(k=>g[k]); },
  heads(){ const c=document.getElementById('devtools'); return c?[...c.querySelectorAll('.dt-h')].map(e=>e.textContent):null; },
  view(){ const c=document.getElementById('devtools');
    return {mode:G.state.mode, title:!!document.querySelector('#title [data-dt-open]'), pauseLink:!!document.querySelector('#pause [data-dt-open]'),
      open:!!(c&&!c.hidden), dtOpen:!!(G.devtools&&G.devtools.open), gate:G.devtools?G.devtools.gate:null, active:G.devtools?G.devtools.active:null,
      pauseCard:!document.getElementById('pause').hidden, groups:RT.groups(), heads:RT.heads(), test:!!G.testSaves}; }
}; 0
"""
READY = "window.G&&G.flow&&G.devtools!==undefined&&document.getElementById('loading').textContent.startsWith('Ready')"
READY_DEV = "window.G&&G.flow&&document.getElementById('loading').textContent.startsWith('Ready')"

def with_debug(u): return u + ('&' if '?' in u else '?') + 'debug'
def without_debug(u): return re.sub(r'[?&]debug(?=&|$)', '', u).replace('.html&', '.html?')

async def fake(route):
    rq = route.request; path = re.sub(r'^https://save\.test', '', rq.url)
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-BQ-Client', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Content-Type': 'application/json'}
    async def send(st, body=None): await route.fulfill(status=st, headers=cors, body=json.dumps(body) if body is not None else '')
    if rq.method == 'OPTIONS': return await send(204)
    if path.startswith('/v1/me'): return await send(401, {'error': 'signed_out'})
    if path in ('/v1/event', '/v1/feedback'): return await send(204)
    if path == '/v1/board': return await send(200, {'b': 'act1', 'crew': '', 'rows': []})
    return await send(404, {'error': 'not_found'})

async def main():
    fails = []; skipped = []; errs = []
    def check(name, ok, info=''):
        print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info, default=str)[:400])
        if not ok: fails.append(name)
    DEPENDS = {'player': ['signedOut'], 'tester': ['player'], 'testerPause': ['tester'], 'roleChange': ['testerPause'], 'roleDrop': ['roleChange'],
               'signOut': ['roleDrop'], 'reloadStart': [], 'reloadDrop': [], 'accountsOff': [], 'devBuild': []}
    async def step(name, fn):
        if name in DEPENDS and any(d in fails or d in skipped for d in DEPENDS[name]):
            print('SKIP ' + name + ' : needs ' + ', '.join(DEPENDS[name])); skipped.append(name); return
        try: await asyncio.wait_for(fn(), BUDGET)
        except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})

    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        async def page(cfg, url, acct=None, delay=0, ready=READY):
            ctx = await b.new_context(viewport={'width': 1100, 'height': 700})
            if cfg: await ctx.add_init_script(cfg)
            await ctx.add_init_script(STANDIN); await ctx.route(API + '/**', fake)
            pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.set_default_navigation_timeout(240000); pg.set_default_timeout(120000)
            await pg.goto(url, wait_until='domcontentloaded')
            await pg.evaluate("([a,d])=>{ localStorage.removeItem('bq-save-test-v1'); if(a)localStorage.setItem('rt-acct',JSON.stringify(a)); else localStorage.removeItem('rt-acct'); localStorage.setItem('rt-delay',String(d)); }", [acct, delay])
            if acct or delay: await pg.reload(wait_until='domcontentloaded')
            await pg.wait_for_function(ready, timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(500); await pg.evaluate(LIB)
            return ctx, pg
        def me(tools, role='tester'): return {'id': 't1', 'email': 't@example.test', 'name': '', 'role': role, 'tools': tools, 'hasPassword': False, 'created': 0}

        # ---- one page: the public build with accounts on, opened with ?debug (which must not matter)
        ctx = pg = None
        async def signedOut():
            nonlocal ctx, pg
            ctx, pg = await page(CFG_ON, with_debug(URL))
            v0 = await pg.evaluate("RT.view()")
            await pg.keyboard.press('Backquote'); await pg.wait_for_timeout(300)
            v1 = await pg.evaluate("(()=>{ G.devtools.openPanel(); return RT.view(); })()")
            check('signedOut', v0['gate'] == 'roles' and not v0['active'] and not v0['title'] and not v0['pauseLink'] and not v1['open'] and not v1['dtOpen'] and v0['mode'] == 'title', {'before': v0, 'after': v1})
        await step('signedOut', signedOut)

        async def player():
            v = await pg.evaluate("(()=>{ __acct.set([],'player'); return RT.view(); })()")
            await pg.keyboard.press('Backquote'); await pg.wait_for_timeout(300)
            v1 = await pg.evaluate("RT.view()")
            check('player', not v['active'] and not v['title'] and not v1['open'], {'v': v, 'after': v1})
        await step('player', player)

        async def tester():
            v = await pg.evaluate("(()=>{ __acct.set(%s); return RT.view(); })()" % json.dumps(TESTER))
            await pg.evaluate("document.querySelector('#title [data-dt-open]').click()"); await pg.wait_for_timeout(400)
            v1 = await pg.evaluate("RT.view()")
            await pg.screenshot(path='/tmp/claude-0/roles-tester-title.png', timeout=180000)
            check('testerTitleLink', v['active'] and v['title'], v)
            check('testerSections', v1['open'] and v1['groups'] == TESTER and v1['heads'] == ['Start from', 'Give', 'Map', 'Teleport'], v1)
            line = await pg.evaluate("(document.querySelector('#devtools .dt-slot')||{}).textContent||''")   # signed in: the account's save slots, not the guest save
            check('testerSlotLine', 'save slot' in line and 'real save' not in line, line)
            await pg.keyboard.press('Backquote'); await pg.wait_for_timeout(300)
            v2 = await pg.evaluate("RT.view()")
            await pg.keyboard.press('Backquote'); await pg.wait_for_timeout(300)
            v3 = await pg.evaluate("RT.view()")
            check('testerBackquote', not v2['open'] and v3['open'], {'closed': v2['open'], 'reopened': v3['open']})
            # a start point from the title: applies straight away
            await pg.evaluate("document.querySelector('#devtools [data-start=\"loop\"]').click()"); await pg.wait_for_timeout(1500)
            v4 = await pg.evaluate("(()=>{ G.step(1/30,10); return Object.assign(RT.view(),{loop:!!G.loop.active}); })()")
            check('testerStart', v4['mode'] == 'play' and v4['loop'] and v4['test'] and not v4['open'], v4)
        await step('tester', tester)

        async def testerPause():
            await pg.evaluate("document.getElementById('pauseBtn').click()"); await pg.wait_for_timeout(400)
            v = await pg.evaluate("RT.view()")
            await pg.evaluate("document.querySelector('#pause [data-dt-open]').click()"); await pg.wait_for_timeout(400)
            v1 = await pg.evaluate("RT.view()")
            check('testerPause', v['mode'] == 'paused' and v['pauseLink'] and v1['open'] and v1['groups'] == TESTER, {'v': v, 'v1': v1})
        await step('testerPause', testerPause)

        async def roleChange():
            v = await pg.evaluate("(()=>{ __acct.set(%s,'admin'); return RT.view(); })()" % json.dumps(ALL))
            await pg.screenshot(path='/tmp/claude-0/roles-admin-pause.png', timeout=180000)
            check('adminAllSections', v['open'] and v['groups'] == ALL and v['heads'] == ['Start from', 'Cheats', 'Give', 'Map', 'Teleport', 'Monsters'], v)
            # god mode on, then the cheats group taken away while open: it goes, and so does what it switched on
            v1 = await pg.evaluate("(()=>{ G.devtools.toggle('god'); G.devtools.setSpeed(4); const on=G.devtools.cheats.god; __acct.set(%s); return Object.assign(RT.view(),{was:on,god:G.devtools.cheats.god,speed:G.timeScale}); })()" % json.dumps(['give', 'monsters']))
            check('roleChangeWhileOpen', v1['open'] and v1['groups'] == ['give', 'monsters'] and v1['was'] and not v1['god'] and v1['speed'] == 1, v1)
        await step('roleChange', roleChange)

        async def roleDrop():
            v = await pg.evaluate("(()=>{ __acct.set([],'player'); return RT.view(); })()")
            check('roleDropClosesPanel', not v['open'] and not v['dtOpen'] and not v['title'] and not v['pauseLink'] and v['mode'] == 'paused' and v['pauseCard'], v)
            v1 = await pg.evaluate("(()=>{ __acct.set(%s); return RT.view(); })()" % json.dumps(['map']))
            check('roleBack', v1['pauseLink'] and v1['title'] and not v1['open'], v1)
        await step('roleDrop', roleDrop)

        async def signOut():
            await pg.evaluate("document.querySelector('#pause [data-dt-open]').click()"); await pg.wait_for_timeout(300)
            v0 = await pg.evaluate("RT.view()")
            v = await pg.evaluate("(()=>{ __acct.out(); return RT.view(); })()")
            await pg.keyboard.press('Backquote'); await pg.wait_for_timeout(300)
            v1 = await pg.evaluate("RT.view()")
            check('signOut', v0['open'] and v0['groups'] == ['map'] and not v['open'] and not v['pauseLink'] and not v['title'] and not v['active'] and not v1['open'] and v['pauseCard'], {'v0': v0, 'v': v, 'v1': v1})
        await step('signOut', signOut)
        if ctx: await ctx.close()

        # ---- the mid-game start point reloads the page; the account answers only 2.5 s after load
        async def reloadStart():
            c, q = await page(CFG_ON, without_debug(URL), acct=me(TESTER), delay=0)
            try:
                await q.evaluate("document.querySelector('#title [data-dt-open]').click()"); await q.wait_for_timeout(300)
                await q.evaluate("document.querySelector('#devtools [data-start=\"loop\"]').click()"); await q.wait_for_timeout(1500)
                await q.evaluate("localStorage.setItem('rt-delay','2500'); document.getElementById('pauseBtn').click()"); await q.wait_for_timeout(300)
                await q.evaluate("document.querySelector('#pause [data-dt-open]').click()"); await q.wait_for_timeout(300)
                async with q.expect_navigation(wait_until='domcontentloaded', timeout=240000):
                    await q.evaluate("document.querySelector('#devtools [data-start=\"stag\"]').click()")
                await q.wait_for_function(READY, timeout=240000)
                await q.wait_for_function("G.state.mode==='play'", timeout=120000); await q.wait_for_timeout(500)
                r = await q.evaluate("({obj:document.getElementById('obj').textContent, test:!!G.testSaves, S:G.account?{modeAtReady:__acct.S.modeAtReady,stash:!!__acct.S.stashAtReady}:null, link:!!document.querySelector('#pause [data-dt-open]')||!!document.querySelector('#title [data-dt-open]')})")
                check('reloadStartWaitsForAccount', r['obj'] == 'Find Hesper’s lantern' and r['test'] and r['S']['modeAtReady'] == 'title' and r['link'], r)
            finally: await c.close()
        await step('reloadStart', reloadStart)

        async def reloadDrop():
            # a stashed start, but the account that comes back after the reload has no 'start' group: dropped, not run
            c, q = await page(CFG_ON, without_debug(URL), acct=me(['give']), delay=0)
            try:
                await q.evaluate("sessionStorage.setItem('bq-devtools-boot',JSON.stringify({id:'stag',cheats:{god:true,easy:false,stamina:false,ether:false,fps:false},timeScale:4})); localStorage.setItem('rt-delay','2500')")
                await q.reload(wait_until='domcontentloaded'); await q.wait_for_function(READY, timeout=240000)
                await q.evaluate("G.account.ready"); await q.wait_for_timeout(2500)
                r = await q.evaluate("""({mode:G.state.mode, test:!!G.testSaves, god:G.devtools.cheats.god, speed:G.timeScale, obj:document.getElementById('obj').textContent,
                    stash:sessionStorage.getItem('bq-devtools-boot'), link:!!document.querySelector('#title [data-dt-open]'), groups:G.devtools.groups})""")
                check('reloadDropWithoutStart', r['mode'] == 'title' and not r['test'] and not r['god'] and r['speed'] == 1 and r['stash'] is None and r['link'] and r['groups'] == ['give'], r)
            finally: await c.close()
        await step('reloadDrop', reloadDrop)

        # ---- the public build with accounts off: ?debug opens the tools as before (the stand-in account is ignored)
        async def accountsOff():
            c, q = await page(CFG_OFF, with_debug(URL))
            try:
                await q.evaluate(LIB)
                v = await q.evaluate("RT.view()")
                await q.keyboard.press('Backquote'); await q.wait_for_timeout(300)
                v1 = await q.evaluate("RT.view()")
                check('accountsOffDebugOpens', v['gate'] == 'all' and v['title'] and v1['open'] and v1['groups'] == ALL, {'v': v, 'v1': v1})
            finally: await c.close()
        await step('accountsOff', accountsOff)

        # ---- a dev build (no BQ_CONFIG), even with a signed-out account present: everything, as always
        async def devBuild():
            c, q = await page(None, without_debug(URL), ready=READY_DEV)
            try:
                await q.evaluate(LIB)
                v = await q.evaluate("RT.view()")
                await q.keyboard.press('Backquote'); await q.wait_for_timeout(300)
                v1 = await q.evaluate("RT.view()")
                check('devBuildUnchanged', v['gate'] == 'all' and v['title'] and v1['open'] and v1['groups'] == ALL and v1['heads'] == ['Start from', 'Cheats', 'Give', 'Map', 'Teleport', 'Monsters'], {'v': v, 'v1': v1})
            finally: await c.close()
        await step('devBuild', devBuild)

        check('noPageErrors', not errs, errs[:3])
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)) + (' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''))
    sys.exit(1 if fails else 0)
asyncio.run(main())
