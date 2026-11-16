# The public beta's extras (js/beta.js, the sync-code half of js/cloud.js, the DEVTOOLS switch and the typing guard in
# core.js) against a fake of the Lighthouse save service, answered here in Python through Playwright's request routing.
# The page gets window.BQ_CONFIG the way the release build sets it.
# Usage: python3 test/beta_e2e.py "http://localhost:PORT/dev.html?headless"   (?headless only skips drawing; ?debug would turn the test tools back on)
import asyncio, json, re, sys, time
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8990/dev.html?headless"
API = "https://save.test"
CFG = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false};" % API
BUDGET = 240  # seconds a single check may take before the rest are skipped

class Fake:
    """saves by sync key, plus the events and feedback it was sent"""
    def __init__(self): self.saves = {}; self.events = []; self.feedback = []; self.puts = 0; self.down = False; self.other = []; self.save_reqs = 0
    async def handle(self, route):
        rq = route.request; path = re.sub(r'^https://save\.test', '', rq.url); cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS'}
        async def send(status, body=None): await route.fulfill(status=status, headers=dict(cors, **{'Content-Type': 'application/json'}), body=json.dumps(body) if body is not None else '')
        if path == '/v1/save' and rq.method != 'OPTIONS': self.save_reqs += 1   # every try at the save endpoint, answered or not
        if self.down: return await route.abort()
        if rq.method == 'OPTIONS': return await send(204)
        key = (rq.headers.get('authorization') or '').replace('Bearer ', '').replace('-', '').upper()
        if path == '/v1/save' and rq.method == 'GET':
            return await send(200, self.saves[key]) if key in self.saves else await send(404, {'error': 'no_save'})
        if path == '/v1/save' and rq.method == 'PUT':
            b = json.loads(rq.post_data or '{}'); old = self.saves.get(key)
            if old and old['at'] >= b['at']: return await send(409, {'error': 'stale', 'at': old['at']})
            self.saves[key] = b; self.puts += 1; return await send(200, {'ok': True, 'at': b['at']})
        if path == '/v1/event' and rq.method == 'POST': self.events.append(json.loads(rq.post_data or '{}')); return await send(204)
        if path == '/v1/feedback' and rq.method == 'POST': self.feedback.append(json.loads(rq.post_data or '{}')); return await send(204)
        self.other.append(rq.method + ' ' + path); await send(404, {'error': 'not_found'})

async def main():
    fails = []; skipped = []
    def check(name, ok, info):
        print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info, default=str)[:400])
        if not ok: fails.append(name)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])   # the same Chrome as the other suites: the bundled headless shell's GL is slow and outgrew memory here
        fake = Fake()
        async def device():
            ctx = await b.new_context(viewport={'width': 1100, 'height': 700})
            await ctx.add_init_script(CFG); await ctx.route(API + '/**', fake.handle)
            pg = await ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)))
            pg.outside = []
            pg.on('request', lambda r: pg.outside.append(r.url) if not (r.url.startswith(URL.split('/dev.html')[0].split('/index.html')[0]) or r.url.startswith(API) or r.url.startswith('data:') or r.url.startswith('blob:')) else None)
            pg.set_default_navigation_timeout(180000)   # two WebGL pages share a slow machine
            pg.set_default_timeout(90000)               # a click waits for steady frames, and a busy machine can take seconds per frame
            await pg.goto(URL, wait_until='domcontentloaded'); await pg.wait_for_function("window.G && G.cloud && G.beta && document.getElementById('loading') && getComputedStyle(document.getElementById('loading')).display==='none' || (window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled)", timeout=180000)
            await pg.wait_for_timeout(1500)
            return ctx, pg
        async def step(name, fn):
            if fails and name in DEPENDS and any(d in fails or d in skipped for d in DEPENDS[name]):
                print('SKIP ' + name + ' : needs ' + ', '.join(DEPENDS[name])); skipped.append(name); return
            try: await asyncio.wait_for(fn(), BUDGET)
            except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})
        DEPENDS = {'syncOn': ['links'], 'upload': ['syncOn'], 'join': ['upload'], 'stale': ['join'], 'syncOff': ['stale'], 'outage': ['links'],
                   'autoWait': ['links'], 'autoStart': ['autoWait'], 'autoPauseCard': ['autoStart'], 'autoReload': ['autoStart'],
                   'autoOff': ['autoReload'], 'manualAfterOff': ['autoOff'], 'autoOutage': ['links']}

        ctx1, pg = await device()

        async def links():
            r = await pg.evaluate("""() => { const row=[...document.querySelectorAll('#title .bq-links button')].map(b=>b.textContent);
                return {row, ver:(document.querySelector('#title .bq-ver')||{}).textContent, devtools:G.DEVTOOLS, debug:G.debug,
                        testTools:!!document.querySelector('[data-dt-open]'), sync:G.cloud.sync.available, state:G.cloud.state, mode:G.cloud.mode}; }""")
            check('links', r['row'] == ['Sync devices', 'Send feedback'] and r['ver'] == '9.9.9-test' and r['sync'] and r['state'] == 'off', r)
            check('devtoolsOff', r['devtools'] is False and r['debug'] is False and not r['testTools'], r)
            await pg.keyboard.press('Backquote'); await pg.wait_for_timeout(300)
            r = await pg.evaluate("() => ({panel:!!document.querySelector('.dt-card:not([hidden]), #devtools:not([hidden])'), open:!!(G.devtools&&G.devtools.open)})")
            check('backquoteDoesNothing', not r['panel'] and not r['open'], r)
        await step('links', links)

        code = {}
        async def syncOn():
            await pg.click('#title .bq-links button:has-text("Sync devices")'); await pg.wait_for_timeout(200)
            r0 = await pg.evaluate("() => ({card:!document.getElementById('syncCard').hidden, title:document.getElementById('title').hidden})")
            await pg.click('#syncCard button:has-text("Turn on sync")'); await pg.wait_for_function("document.querySelector('#syncCard .savenote').textContent!=='One moment…'", timeout=60000)
            r = await pg.evaluate("() => ({code:document.querySelector('#syncCard .bq-code').textContent, state:G.cloud.state, mode:G.cloud.mode, note:document.querySelector('#syncCard .savenote').textContent, stored:localStorage.getItem('bq-sync-key')})")
            code['v'] = r['code']
            check('syncOn', r0['card'] and r0['title'] and bool(re.match(r'^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$', r['code'])) and r['state'] == 'on' and r['mode'] == 'sync' and 'on' in r['note'], dict(r, **r0))
            await pg.click('#syncCard button:has-text("Back")'); await pg.wait_for_timeout(200)
            r = await pg.evaluate("() => ({card:document.getElementById('syncCard').hidden, title:!document.getElementById('title').hidden, note:document.getElementById('cloudNote').textContent})")
            check('syncBack', r['card'] and r['title'] and 'sync code' in r['note'], r)
        await step('syncOn', syncOn)

        async def upload():
            await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(1500)
            r = await pg.evaluate("async () => { G.flow.writeSave(); await G.cloud.flush(); return {at:JSON.parse(localStorage.getItem('bq-save-v1')).at}; }")
            key = code['v'].replace('-', ''); sv = fake.saves.get(key)
            check('upload', bool(sv) and sv['at'] == r['at'] and sv['v'] == 1 and isinstance(sv['save'], str) and len(sv['save']) > 100, {'puts': fake.puts, 'has': bool(sv), 'size': len(sv['save']) if sv else 0})
            ev = [e['name'] for e in fake.events]
            check('pings', 'session' in ev and 'play' in ev and all(e['build'] == '9.9.9-test' and re.match(r'^[a-z0-9]{8,24}$', e['sid']) and e['platform'] in ('touch', 'keyboard', 'pad', 'unknown') for e in fake.events), {'events': ev})
        await step('upload', upload)

        async def feedback():
            await pg.evaluate("document.getElementById('pauseBtn').click()"); await pg.wait_for_timeout(400)
            r0 = await pg.evaluate("() => ({mode:G.state.mode, link:[...document.querySelectorAll('#pause .bq-links button')].map(b=>b.textContent)})")
            await pg.evaluate("[...document.querySelectorAll('#pause .bq-links button')].find(b=>b.textContent==='Send feedback').click()"); await pg.wait_for_timeout(200)
            muted0 = await pg.evaluate("() => JSON.parse(localStorage.getItem('bq-audio')||localStorage.getItem('bq-settings')||'{}').muted||false")
            await pg.fill('#feedbackCard textarea', 'nine men ran and jumped in the fog'); await pg.focus('#feedbackCard textarea'); await pg.keyboard.press('End')
            for k in [' ', '`', 'm', ' ', 'n']: await pg.keyboard.press(k)   # real keys: space (the game eats it), backquote (test tools), m (map), n (mute)
            await pg.wait_for_timeout(200)
            r1 = await pg.evaluate("() => ({text:document.querySelector('#feedbackCard textarea').value, mode:G.state.mode, map:!!(G.map&&G.map.isOpen), toast:document.getElementById('toast').textContent})")
            await pg.click('#feedbackCard button:has-text("Send")'); await pg.wait_for_function("document.querySelector('#feedbackCard .savenote').textContent!=='Sending…'", timeout=60000)
            r2 = await pg.evaluate("() => ({note:document.querySelector('#feedbackCard .savenote').textContent, text:document.querySelector('#feedbackCard textarea').value})")
            fb = fake.feedback[-1] if fake.feedback else {}
            check('typingIsNotGameInput', r1['text'] == 'nine men ran and jumped in the fog `m n' and r1['mode'] == 'paused' and not r1['map'] and 'Sound' not in r1['toast'], r1)
            check('feedback', r0['mode'] == 'paused' and r0['link'] == ['Sync devices', 'Send feedback'] and fb.get('text') == 'nine men ran and jumped in the fog `m n' and fb.get('build') == '9.9.9-test' and bool(fb.get('progress')) and 'Sent' in r2['note'] and r2['text'] == '', {'fb': fb, 'note': r2['note']})
            await pg.click('#feedbackCard button:has-text("Back")'); await pg.wait_for_timeout(200)
            r = await pg.evaluate("() => ({pause:!document.getElementById('pause').hidden, card:document.getElementById('feedbackCard').hidden})")
            check('feedbackBack', r['pause'] and r['card'], r)
        await step('feedback', feedback)

        READY = "window.G&&G.cloud&&G.beta&&G.state&&G.state.mode==='title'&&!!document.querySelector('#title .bq-links')"
        async def other_device(keep_key=False):
            # the same page with its storage wiped stands in for a second device (two live WebGL pages starve each other here)
            await pg.evaluate("k => { const key=localStorage.getItem('bq-sync-key'); localStorage.clear(); if(k&&key)localStorage.setItem('bq-sync-key',key); }", keep_key)
            await pg.reload(wait_until='domcontentloaded'); await pg.wait_for_function(READY, timeout=180000); await pg.wait_for_timeout(1500)

        async def join():
            await other_device()
            r = await pg.evaluate("() => ({state:G.cloud.state, cont:!document.getElementById('continue').hidden, key:localStorage.getItem('bq-sync-key')})")
            check('freshDeviceIsEmpty', r['state'] == 'off' and not r['cont'] and not r['key'], r)
            await pg.click('#title .bq-links button:has-text("Sync devices")'); await pg.click('#syncCard button:has-text("I have a code")')
            await pg.fill('#syncCard input', 'ABCD-1234-EFGH'); await pg.click('#syncCard button:has-text("Use this code")'); await pg.wait_for_function("document.querySelector('#syncCard .savenote').textContent!=='One moment…'", timeout=60000)
            r = await pg.evaluate("() => ({note:document.querySelector('#syncCard .savenote').textContent, state:G.cloud.state, key:localStorage.getItem('bq-sync-key')})")
            check('joinWrongCode', 'no save under that code' in r['note'] and r['state'] == 'off' and not r['key'], r)
            await pg.fill('#syncCard input', 'not a code'); await pg.click('#syncCard button:has-text("Use this code")'); await pg.wait_for_timeout(300)
            r = await pg.evaluate("() => ({note:document.querySelector('#syncCard .savenote').textContent})")
            check('joinBadFormat', '12 letters and numbers' in r['note'], r)
            await pg.fill('#syncCard input', code['v'].lower().replace('-', ' ')); await pg.click('#syncCard button:has-text("Use this code")'); await pg.wait_for_function("document.querySelector('#syncCard .savenote').textContent!=='One moment…'", timeout=60000)
            r = await pg.evaluate("() => ({note:document.querySelector('#syncCard .savenote').textContent, state:G.cloud.state, code:G.cloud.sync.code(), local:!!localStorage.getItem('bq-save-v1'), shown:document.querySelector('#syncCard .bq-code').textContent})")
            check('join', 'Linked' in r['note'] and r['state'] == 'on' and r['code'] == code['v'] and r['local'] and r['shown'] == code['v'], r)
            await pg.click('#syncCard button:has-text("Back")'); await pg.wait_for_timeout(200)
            r = await pg.evaluate("() => ({cont:!document.getElementById('continue').hidden, note:document.getElementById('cloudNote').textContent})")
            check('joinContinue', r['cont'] and 'another device' in r['note'], r)
            # a later visit on that device: only the code is kept (as if the browser dropped the save); it comes back linked with the save
            await other_device(keep_key=True); await pg.wait_for_function("G.cloud.state==='on'||G.cloud.state==='off'&&!document.getElementById('cloudNote').hidden", timeout=60000)
            r = await pg.evaluate("() => ({state:G.cloud.state, mode:G.cloud.mode, cont:!document.getElementById('continue').hidden, note:document.getElementById('cloudNote').textContent, key:!!localStorage.getItem('bq-sync-key')})")
            check('saveComesBackFromCode', r['state'] == 'on' and r['mode'] == 'sync' and r['cont'], r)
        await step('join', join)

        async def stale():
            # another device saved later than this one: this device's save must not replace it, and sync stays on
            key = code['v'].replace('-', ''); far = dict(fake.saves[key], at=4102444800000); fake.saves[key] = far
            await pg.evaluate("document.getElementById('continue').click()"); await pg.wait_for_timeout(1500)
            r = await pg.evaluate("async () => { G.flow.writeSave(); await G.cloud.flush(); return {state:G.cloud.state, mode:G.state.mode}; }")
            check('stale', fake.saves[key] is far and r['state'] == 'on' and r['mode'] == 'play', {'stored': fake.saves[key]['at'], 'state': r['state']})
        await step('stale', stale)

        async def syncOff():
            await pg.evaluate("document.getElementById('pauseBtn').click()"); await pg.wait_for_timeout(300)
            await pg.evaluate("document.getElementById('quitBtn').click()"); await pg.wait_for_timeout(1000)
            await pg.wait_for_function(READY, timeout=180000); await pg.wait_for_timeout(1500)
            await pg.click('#title .bq-links button:has-text("Sync devices")'); await pg.click('#syncCard button:has-text("Turn off on this device")'); await pg.wait_for_timeout(200)
            puts = fake.puts
            r = await pg.evaluate("async () => { const s=G.cloud.state; G.emit('save:written',{}); await G.cloud.flush(); return {state:s, key:localStorage.getItem('bq-sync-key'), local:!!localStorage.getItem('bq-save-v1')}; }")
            check('syncOff', r['state'] == 'off' and not r['key'] and r['local'] and fake.puts == puts and code['v'].replace('-', '') in fake.saves, r)
            await pg.click('#syncCard button:has-text("Back")')
        await step('syncOff', syncOff)

        async def outage():
            # the service is unreachable: turning sync on says so and the game still saves locally
            await other_device(); fake.down = True
            try:
                await pg.click('#title .bq-links button:has-text("Sync devices")'); await pg.click('#syncCard button:has-text("Turn on sync")'); await pg.wait_for_function("document.querySelector('#syncCard .savenote').textContent!=='One moment…'", timeout=60000)
                r = await pg.evaluate("() => ({note:document.querySelector('#syncCard .savenote').textContent, state:G.cloud.state})")
                check('outageSync', 'couldn’t be reached' in r['note'] and r['state'] == 'off', r)
                await pg.click('#syncCard button:has-text("Back")')
                await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(1500)
                r = await pg.evaluate("async () => { const ok=G.flow.writeSave(); await G.cloud.flush(); return {ok, local:!!localStorage.getItem('bq-save-v1'), mode:G.state.mode}; }")
                check('outageLocalSave', r['ok'] and r['local'] and r['mode'] == 'play', r)
            finally:
                fake.down = False   # a failure above must not leave the fake down for the checks after it
        await step('outage', outage)

        # ---- automatic backup: after 60 s of play a device with no code backs its save up by itself ----
        # A fresh browser context (a new device, and a fresh page: one page reloaded many times grows until it crashes here)
        pages = [pg]
        async def new_device():
            nonlocal ctx1, pg
            await ctx1.close(); ctx1, pg = await device(); pages.append(pg)
        # Play time is driven with G.step under G.headless.hold (both work without ?debug), so the machine's speed can't add play time.
        HOOK = """() => { if(window.__hooked)return; window.__hooked=1; window.__said=[]; window.__claimed=false;
            const o=G.ui.say; G.ui.say=function(t){ window.__said.push(String(t)); return o.apply(this,arguments); };
            setInterval(()=>{ if(G.cloud.sync.code()||G.cloud.state==='on')window.__claimed=true; },50); }"""
        TOLD = "() => window.__said.filter(t=>/backed up online/.test(t)).length"
        async def play(sec):   # sec seconds of play time, in 1/10 s steps
            await pg.evaluate("""async s => { G.headless.hold=true; let n=Math.round(s*10);
                while(n>0){ const k=Math.min(n,100); G.step(1/10,k); n-=k; await new Promise(r=>setTimeout(r,0)); } }""", sec)
        AUTO = "() => ({played:(G.cloud.sync.auto||{}).played, state:G.cloud.state, key:localStorage.getItem('bq-sync-key'), off:localStorage.getItem('bq-sync-off'), told:localStorage.getItem('bq-sync-auto'), save:!!localStorage.getItem('bq-save-v1'), mode:G.state.mode})"
        auto = {}

        async def autoWait():
            await new_device(); await pg.evaluate(HOOK); base = fake.save_reqs
            await pg.wait_for_timeout(2500)
            r = await pg.evaluate(AUTO)
            check('autoTitleNotCounted', r['played'] == 0 and r['state'] == 'off' and not r['key'], r)
            await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(800)
            await play(30)
            await pg.evaluate("document.getElementById('pauseBtn').click()")
            await pg.evaluate("() => { G.headless.hold=true; G.step(1/10,300); }")   # 30 s while paused
            r = await pg.evaluate(AUTO)
            check('autoPauseNotCounted', r['mode'] == 'paused' and 29.9 <= r['played'] < 33, r)
            await pg.evaluate("document.getElementById('resume').click()")
            await play(59 - r['played'])
            r = await pg.evaluate(AUTO)
            check('autoNothingBefore60s', r['save'] and r['played'] < 60 and fake.save_reqs == base and not r['key'] and r['state'] == 'off', dict(r, reqs=fake.save_reqs - base))
            await pg.evaluate("localStorage.removeItem('bq-save-v1')"); await play(2); await pg.wait_for_timeout(1500)
            r = await pg.evaluate(AUTO)
            check('autoWaitsForASave', r['played'] >= 60 and not r['save'] and fake.save_reqs == base and not r['key'] and r['state'] == 'off', dict(r, reqs=fake.save_reqs - base))
            if fails and any(n in fails for n in ('autoNothingBefore60s', 'autoWaitsForASave')): fails.append('autoWait')
        await step('autoWait', autoWait)

        async def autoStart():
            await pg.evaluate("G.flow.writeSave()")
            await pg.wait_for_function("!!localStorage.getItem('bq-sync-key') && G.cloud.state==='on'", timeout=60000, polling=250)
            r = await pg.evaluate(AUTO); key = r['key']; auto['key'] = key; sv = fake.saves.get(key)
            at = await pg.evaluate("JSON.parse(localStorage.getItem('bq-save-v1')).at")
            check('autoStart', bool(re.match(r'^[0-9A-HJKMNP-TV-Z]{12}$', key or '')) and bool(sv) and sv['at'] == at and r['state'] == 'on' and not r['off'], dict(r, has=bool(sv)))
            for _ in range(20):
                if await pg.evaluate(TOLD): break
                await play(1)
            n1 = await pg.evaluate(TOLD); await play(10); n2 = await pg.evaluate(TOLD)
            r = await pg.evaluate("() => ({told:localStorage.getItem('bq-sync-auto'), log:window.__said.filter(t=>/backed up/.test(t)), mode:G.state.mode, card:!!document.querySelector('.card:not(#title):not([hidden]) .sheet')})")
            check('autoToldOnce', n1 == 1 and n2 == 1 and r['told'] == 'told' and r['mode'] == 'play' and not r['card'], dict(r, n1=n1, n2=n2))
            await pg.evaluate("async () => { G.flow.writeSave(); await G.cloud.flush(); }")
            at = await pg.evaluate("JSON.parse(localStorage.getItem('bq-save-v1')).at")
            check('autoMirrors', fake.saves[key]['at'] == at, {'stored': fake.saves[key]['at'], 'local': at})
        await step('autoStart', autoStart)

        async def autoPauseCard():
            await pg.evaluate("document.getElementById('pauseBtn').click()")
            await pg.click('#pause .bq-links button:has-text("Sync devices")'); await pg.wait_for_timeout(200)
            vis = "s => { const e=document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display!=='none'; }"
            r = await pg.evaluate("""() => { const c=document.getElementById('syncCard'), v=b=>[...c.querySelectorAll('button')].filter(x=>!x.hidden).map(x=>x.textContent);
                return {card:!c.hidden, pause:document.getElementById('pause').hidden, code:c.querySelector('.bq-code').textContent, buttons:v(), want:G.cloud.sync.code()}; }""")
            check('syncFromPause', r['card'] and r['pause'] and r['code'] == r['want'] and r['code'] and 'I have a code' not in r['buttons'] and 'Turn off on this device' in r['buttons'], r)
            await pg.click('#syncCard button:has-text("Back")'); await pg.wait_for_timeout(200)
            r = await pg.evaluate("() => ({pause:!document.getElementById('pause').hidden, card:document.getElementById('syncCard').hidden, mode:G.state.mode})")
            check('syncFromPauseBack', r['pause'] and r['card'] and r['mode'] == 'paused', r)
            await pg.evaluate("document.getElementById('resume').click()")
        await step('autoPauseCard', autoPauseCard)

        async def autoReload():
            await pg.evaluate("G.flow.writeSave()")
            await pg.reload(wait_until='domcontentloaded'); await pg.wait_for_function(READY, timeout=180000); await pg.evaluate(HOOK)
            await pg.wait_for_function("G.cloud.state==='on'", timeout=60000, polling=250)
            await pg.evaluate("document.getElementById('continue').click()"); await pg.wait_for_timeout(800); await play(15)
            r = await pg.evaluate(AUTO); n = await pg.evaluate(TOLD)
            check('autoReload', r['state'] == 'on' and r['key'] == auto['key'] and n == 0, dict(r, told_n=n))
        await step('autoReload', autoReload)

        async def autoOff():
            await pg.evaluate("document.getElementById('pauseBtn').click()")
            await pg.click('#pause .bq-links button:has-text("Sync devices")'); await pg.click('#syncCard button:has-text("Turn off on this device")'); await pg.wait_for_timeout(200)
            CARD = """() => { const c=document.getElementById('syncCard'); return {buttons:[...c.querySelectorAll('button')].filter(x=>!x.hidden).map(x=>x.textContent),
                text:[...c.querySelectorAll('p')].filter(x=>!x.hidden).map(x=>x.textContent).join(' | ')}; }"""
            c = await pg.evaluate(CARD); r = await pg.evaluate(AUTO)
            check('autoOff', not r['key'] and r['off'] == '1' and r['state'] == 'off' and 'off on this device' in c['text'] and 'Turn on sync' in c['buttons'] and 'I have a code' not in c['buttons'] and 'title screen' in c['text'], dict(r, **c))
            await pg.click('#syncCard button:has-text("Back")'); await pg.evaluate("document.getElementById('resume').click()")
            base = fake.save_reqs
            await pg.evaluate("async () => { G.flow.writeSave(); await G.cloud.flush(); }"); await play(2); await pg.wait_for_timeout(1000)
            check('autoOffNoUploads', fake.save_reqs == base, {'reqs': fake.save_reqs - base})
            await pg.reload(wait_until='domcontentloaded'); await pg.wait_for_function(READY, timeout=180000); await pg.wait_for_timeout(1000)
            await pg.click('#title .bq-links button:has-text("Sync devices")'); c = await pg.evaluate(CARD); await pg.click('#syncCard button:has-text("Back")')
            await pg.evaluate("document.getElementById('continue').click()"); await pg.wait_for_timeout(800); await play(62)
            await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(1500)
            r = await pg.evaluate(AUTO)
            check('autoOffSticks', r['played'] >= 60 and not r['key'] and r['off'] == '1' and r['state'] == 'off' and fake.save_reqs == base
                  and 'off on this device' in c['text'] and 'Turn on sync' in c['buttons'] and 'I have a code' in c['buttons'] and 'There’s no account' in c['text'], dict(r, card=c, reqs=fake.save_reqs - base))
        await step('autoOff', autoOff)

        async def manualAfterOff():
            await pg.evaluate("G.flow.writeSave()"); await pg.reload(wait_until='domcontentloaded'); await pg.wait_for_function(READY, timeout=180000); await pg.wait_for_timeout(1000)
            await pg.click('#title .bq-links button:has-text("Sync devices")'); await pg.click('#syncCard button:has-text("Turn on sync")')
            await pg.wait_for_function("document.querySelector('#syncCard .savenote').textContent!=='One moment…'", timeout=60000)
            r = await pg.evaluate(AUTO); sv = fake.saves.get(r['key'] or '')
            check('manualAfterOff', r['state'] == 'on' and bool(r['key']) and r['key'] != auto['key'] and not r['off'] and bool(sv), dict(r, has=bool(sv)))
            await pg.click('#syncCard button:has-text("Back")')
        await step('manualAfterOff', manualAfterOff)

        async def autoOutage():
            await new_device(); await pg.evaluate(HOOK); fake.down = True; base = fake.save_reqs
            try:
                await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(800)
                await play(61)    # the 45 s autosave has written a save by now, so the threshold tries at once
                await pg.wait_for_function("!(G.cloud.sync.auto&&G.cloud.sync.auto.trying)", timeout=30000, polling=250); await pg.wait_for_timeout(500)
                tries = fake.save_reqs - base
                r = await pg.evaluate("""() => ({key:localStorage.getItem('bq-sync-key'), state:G.cloud.state, note:document.getElementById('cloudNote').textContent,
                    toast:document.getElementById('toast').textContent, said:window.__said.filter(t=>/reach|couldn|sync|online|error/i.test(t)), ok:G.flow.writeSave(), save:!!localStorage.getItem('bq-save-v1')})""")
                check('autoOutageSilent', tries >= 1 and not r['key'] and r['state'] == 'off' and not r['note'] and not r['toast'] and not r['said'] and r['ok'] and r['save'], dict(r, tries=tries))
                await pg.wait_for_timeout(1500); tries2 = fake.save_reqs - base
                await pg.evaluate("document.getElementById('pauseBtn').click()")
                await pg.click('#pause .bq-links button:has-text("Sync devices")')
                c = await pg.evaluate("() => { const c=document.getElementById('syncCard'); return {code:c.querySelector('.bq-code').hidden?'':c.querySelector('.bq-code').textContent, buttons:[...c.querySelectorAll('button')].filter(x=>!x.hidden).map(x=>x.textContent), note:c.querySelector('.savenote').textContent}; }")
                await pg.click('#syncCard button:has-text("Back")'); await pg.evaluate("document.getElementById('resume').click()")
                check('autoOutageRetryWaits', tries2 == tries and not c['code'] and 'Turn on sync' in c['buttons'] and 'on' not in c['note'].lower(), dict(c, tries=tries, tries2=tries2))
                claimed = await pg.evaluate("window.__claimed")
                check('autoOutageNeverClaimedOn', claimed is False, {'claimed': claimed})
            finally:
                fake.down = False
            await pg.wait_for_timeout(61000)     # the next try waits a minute of wall-clock time
            await pg.evaluate("G.flow.writeSave()")
            await pg.wait_for_function("!!localStorage.getItem('bq-sync-key') && G.cloud.state==='on'", timeout=60000, polling=250)
            r = await pg.evaluate(AUTO); sv = fake.saves.get(r['key'])
            check('autoOutageRetried', bool(sv) and r['state'] == 'on', dict(r, has=bool(sv)))
        await step('autoOutage', autoOutage)

        outside = [u for q in pages for u in q.outside]; errs = [e for q in pages for e in q.errs]
        check('noOtherSites', not outside, {'requests': outside[:5]})
        check('onlyKnownEndpoints', not fake.other, fake.other[:5])
        check('noPageErrors', not errs, errs[:3])
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)) + (' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''))
    sys.exit(1 if fails else 0)
asyncio.run(main())
