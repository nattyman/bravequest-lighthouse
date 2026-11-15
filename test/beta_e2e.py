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
    def __init__(self): self.saves = {}; self.events = []; self.feedback = []; self.puts = 0; self.down = False; self.other = []
    async def handle(self, route):
        rq = route.request; path = re.sub(r'^https://save\.test', '', rq.url); cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS'}
        async def send(status, body=None): await route.fulfill(status=status, headers=dict(cors, **{'Content-Type': 'application/json'}), body=json.dumps(body) if body is not None else '')
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
        b = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        fake = Fake()
        async def device():
            ctx = await b.new_context(viewport={'width': 1100, 'height': 700})
            await ctx.add_init_script(CFG); await ctx.route(API + '/**', fake.handle)
            pg = await ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)))
            pg.outside = []
            pg.on('request', lambda r: pg.outside.append(r.url) if not (r.url.startswith(URL.split('/dev.html')[0].split('/index.html')[0]) or r.url.startswith(API) or r.url.startswith('data:') or r.url.startswith('blob:')) else None)
            pg.set_default_navigation_timeout(180000)   # two WebGL pages share a slow machine
            await pg.goto(URL, wait_until='domcontentloaded'); await pg.wait_for_function("window.G && G.cloud && G.beta && document.getElementById('loading') && getComputedStyle(document.getElementById('loading')).display==='none' || (window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled)", timeout=180000)
            await pg.wait_for_timeout(1500)
            return ctx, pg
        async def step(name, fn):
            if fails and name in DEPENDS and any(d in fails or d in skipped for d in DEPENDS[name]):
                print('SKIP ' + name + ' : needs ' + ', '.join(DEPENDS[name])); skipped.append(name); return
            try: await asyncio.wait_for(fn(), BUDGET)
            except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})
        DEPENDS = {'syncOn': ['links'], 'upload': ['syncOn'], 'join': ['upload'], 'stale': ['join'], 'syncOff': ['stale'], 'outage': ['links']}

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
            await pg.evaluate("document.querySelector('#pause .bq-links button').click()"); await pg.wait_for_timeout(200)
            muted0 = await pg.evaluate("() => JSON.parse(localStorage.getItem('bq-audio')||localStorage.getItem('bq-settings')||'{}').muted||false")
            await pg.fill('#feedbackCard textarea', 'nine men ran and jumped in the fog'); await pg.focus('#feedbackCard textarea'); await pg.keyboard.press('End')
            for k in [' ', '`', 'm', ' ', 'n']: await pg.keyboard.press(k)   # real keys: space (the game eats it), backquote (test tools), m (map), n (mute)
            await pg.wait_for_timeout(200)
            r1 = await pg.evaluate("() => ({text:document.querySelector('#feedbackCard textarea').value, mode:G.state.mode, map:!!(G.map&&G.map.isOpen), toast:document.getElementById('toast').textContent})")
            await pg.click('#feedbackCard button:has-text("Send")'); await pg.wait_for_function("document.querySelector('#feedbackCard .savenote').textContent!=='Sending…'", timeout=60000)
            r2 = await pg.evaluate("() => ({note:document.querySelector('#feedbackCard .savenote').textContent, text:document.querySelector('#feedbackCard textarea').value})")
            fb = fake.feedback[-1] if fake.feedback else {}
            check('typingIsNotGameInput', r1['text'] == 'nine men ran and jumped in the fog `m n' and r1['mode'] == 'paused' and not r1['map'] and 'Sound' not in r1['toast'], r1)
            check('feedback', r0['mode'] == 'paused' and r0['link'] == ['Send feedback'] and fb.get('text') == 'nine men ran and jumped in the fog `m n' and fb.get('build') == '9.9.9-test' and bool(fb.get('progress')) and 'Sent' in r2['note'] and r2['text'] == '', {'fb': fb, 'note': r2['note']})
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
            await pg.click('#title .bq-links button:has-text("Sync devices")'); await pg.click('#syncCard button:has-text("Turn on sync")'); await pg.wait_for_function("document.querySelector('#syncCard .savenote').textContent!=='One moment…'", timeout=60000)
            r = await pg.evaluate("() => ({note:document.querySelector('#syncCard .savenote').textContent, state:G.cloud.state})")
            check('outageSync', 'couldn’t be reached' in r['note'] and r['state'] == 'off', r)
            await pg.click('#syncCard button:has-text("Back")')
            await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(1500)
            r = await pg.evaluate("async () => { const ok=G.flow.writeSave(); await G.cloud.flush(); return {ok, local:!!localStorage.getItem('bq-save-v1'), mode:G.state.mode}; }")
            check('outageLocalSave', r['ok'] and r['local'] and r['mode'] == 'play', r)
            fake.down = False
        await step('outage', outage)

        check('noOtherSites', not pg.outside, {'requests': pg.outside[:5]})
        check('onlyKnownEndpoints', not fake.other, fake.other[:5])
        check('noPageErrors', not pg.errs, pg.errs[:3])
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)) + (' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''))
    sys.exit(1 if fails else 0)
asyncio.run(main())
