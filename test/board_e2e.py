# The Keepers' Board (js/board.js) against a fake of the Lighthouse save service (records, boards and saves), answered
# here in Python through Playwright's request routing. The page gets window.BQ_CONFIG the way the release build sets it.
# Spec: RECORD.md (section 5).
# Usage: python3 test/board_e2e.py "http://localhost:PORT/dev.html?headless"   (?headless only skips drawing; ?debug turns the board off)
# Screenshots go to $SHOTS (default /tmp/claude-0/s6).
import asyncio, json, os, re, sys, time
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8816/dev.html?headless"
API = "https://save.test"
CFG = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false};" % API
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/s6')
ONLY = [x for x in os.environ.get('ONLY', '').split(',') if x]
BUDGET = 240  # seconds a single check may take before the rest are skipped
MS = ['ashore', 'plain-flame', 'stag', 'lantern', 'staff', 'lamp-cured', 'gloaming', 'undertow', 'crane', 'answer', 'sailed', 'giant']
NAME_RE = re.compile(r"^[A-Za-z0-9 _'\-]{3,16}$")

class Fake:
    """saves and records by sync key; boards built from seeded rows plus the named records"""
    def __init__(self):
        self.saves = {}; self.records = {}; self.log = []; self.other = []; self.down = False
        self.force_no_save = False; self.rate_once = 0
        # seeded keepers: 30 on Act 1 (so a slow time lands outside the top 25), a few elsewhere, three in crew FRIENDS1
        self.seed = []
        for i in range(30):
            self.seed.append({'name': 'Keeper %02d' % i, 'crew': 'FRIENDS1' if i in (3, 7, 12) else '', 'rank': i % 4, 'badges': 3 + i % 9,
                              'act1': 1000 + i * 100, 'full': (3000 + i * 400) if i < 3 else None, 'deaths': (i * 2) if i < 3 else None,
                              'pct': 90 - i * 3, 'boss': {'stag': 60 + i * 5} if i < 6 else {}})
        self.seed[0]['name'] = 'Taken Name'
    def reqs(self, method=None, path=None): return [r for r in self.log if (method is None or r['m'] == method) and (path is None or r['p'] == path)]
    def taken(self, key, name):
        low = name.lower()
        return any(s['name'].lower() == low for s in self.seed) or any(k != key and r.get('name', '').lower() == low for k, r in self.records.items())
    def rows(self, b, crew):
        ent = []
        for s in self.seed:
            v = s['boss'].get(b[5:]) if b.startswith('boss:') else s.get(b)
            ent.append({'key': None, 'name': s['name'], 'crew': s['crew'], 'value': v, 'rank': s['rank'], 'badges': s['badges']})
        for k, r in self.records.items():
            sp = r.get('splits') or {}
            v = {'act1': sp.get('gloaming'), 'full': sp.get('giant'), 'pct': r.get('pct'), 'deaths': r.get('deaths') if sp.get('giant') is not None else None}.get(b)
            if b.startswith('boss:'): v = (r.get('bosses') or {}).get(b[5:])
            ent.append({'key': k, 'name': r.get('name', ''), 'crew': r.get('crew', ''), 'value': v, 'rank': r.get('rank', 0), 'badges': r.get('badges', 0)})
        ent = [e for e in ent if e['value'] is not None]
        ent.sort(key=lambda e: -e['value'] if b == 'pct' else e['value'])
        return ent
    async def handle(self, route):
        rq = route.request; u = urlparse(rq.url); path = u.path; q = parse_qs(u.query)
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After'}
        async def send(status, body=None, extra=None):
            h = dict(cors, **{'Content-Type': 'application/json'}); h.update(extra or {})
            await route.fulfill(status=status, headers=h, body=json.dumps(body) if body is not None else '')
        if rq.method != 'OPTIONS':
            body = None
            try: body = json.loads(rq.post_data) if rq.post_data else None
            except Exception: body = None
            self.log.append({'m': rq.method, 'p': path, 'q': {k: v[0] for k, v in q.items()}, 'b': body, 't': time.time(), 'auth': bool(rq.headers.get('authorization'))})
        if self.down: return await route.abort()
        if rq.method == 'OPTIONS': return await send(204)
        key = (rq.headers.get('authorization') or '').replace('Bearer ', '').replace('-', '').upper()
        if path == '/v1/save' and rq.method == 'GET':
            return await send(200, self.saves[key]) if key in self.saves else await send(404, {'error': 'no_save'})
        if path == '/v1/save' and rq.method == 'PUT':
            b = json.loads(rq.post_data or '{}'); old = self.saves.get(key)
            if old and old['at'] >= b['at']: return await send(409, {'error': 'stale', 'at': old['at']})
            self.saves[key] = b; return await send(200, {'ok': True, 'at': b['at']})
        if path == '/v1/event' and rq.method == 'POST': return await send(204)
        if path == '/v1/record' and rq.method == 'PUT':
            if self.rate_once:
                s = self.rate_once; self.rate_once = 0; return await send(429, {'error': 'rate_limited'}, {'Retry-After': str(s)})
            if not key: return await send(401, {'error': 'bad_key'})
            if self.force_no_save or key not in self.saves: return await send(404, {'error': 'no_save'})
            b = json.loads(rq.post_data or '{}'); rec = dict(self.records.get(key, {'name': '', 'crew': ''}))
            if b.get('name') is not None:
                n = re.sub(r'\s+', ' ', str(b['name']).strip())
                if n:
                    if not NAME_RE.match(n) or 'badword' in n.lower(): return await send(400, {'error': 'name_invalid'})
                    if self.taken(key, n): return await send(409, {'error': 'name_taken'})
                rec['name'] = n
            if b.get('crew') is not None:
                c = str(b['crew']).strip().upper()
                if c and not re.match(r'^[A-Z0-9]{4,12}$', c): return await send(400, {'error': 'bad_request'})
                rec['crew'] = c
            for k in ('build', 'play', 'deaths', 'pct', 'badges', 'rank', 'days', 'splits', 'bosses'): rec[k] = b.get(k)
            self.records[key] = rec; return await send(200, {'ok': True, 'name': rec['name']})
        if path == '/v1/record' and rq.method == 'GET':
            r = self.records.get(key)
            return await send(200, r) if r else await send(404, {'error': 'no_record'})
        if path == '/v1/board' and rq.method == 'GET':
            b = q.get('b', ['act1'])[0]; crew = q.get('crew', [''])[0].upper(); lim = int(q.get('limit', ['25'])[0])
            ent = self.rows(b, crew); rows = []; pos = 0; you = None
            for e in ent:
                listed = bool(e['name']) and (not crew or e['crew'] == crew)
                if listed: pos += 1
                if listed and pos <= lim: rows.append({'pos': pos, 'name': e['name'], 'value': e['value'], 'rank': e['rank'], 'badges': e['badges'], 'at': 1})
                if key and e['key'] == key: you = {'pos': pos if listed else None, 'value': e['value']}
            out = {'b': b, 'crew': crew, 'rows': rows}
            if key: out['you'] = you
            return await send(200, out)
        self.other.append(rq.method + ' ' + path); await send(404, {'error': 'not_found'})

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    fails = []; skipped = []
    def check(name, ok, info):
        print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info, default=str)[:500])
        if not ok: fails.append(name)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        fake = Fake(); pages = []
        async def device(url=URL, cfg=True, w=1100, h=700):
            ctx = await b.new_context(viewport={'width': w, 'height': h})
            if cfg: await ctx.add_init_script(CFG)
            await ctx.route(API + '/**', fake.handle)
            pg = await ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e))); pages.append(pg)
            pg.set_default_navigation_timeout(180000); pg.set_default_timeout(90000)
            await pg.goto(url, wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled", timeout=180000)
            await pg.wait_for_timeout(1500)
            return ctx, pg
        async def step(name, fn):
            if ONLY and name not in ONLY and name not in ('links', 'firstOpen', 'join'):
                print('SKIP ' + name + ' : not in ONLY'); return
            if name in DEPENDS and any(d in fails or d in skipped for d in DEPENDS[name]):
                print('SKIP ' + name + ' : needs ' + ', '.join(DEPENDS[name])); skipped.append(name); return
            try: await asyncio.wait_for(fn(), BUDGET)
            except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})
        DEPENDS = {'firstOpen': ['links'], 'join': ['firstOpen'], 'routine': ['join'], 'throttle': ['join'], 'noSave': ['join'], 'rate': ['join'],
                   'hidden': ['join'], 'boards': ['join'], 'crew': ['boards'], 'leave': ['join'], 'dnt': ['leave'], 'down': ['join']}
        CARD = """() => { const c=document.getElementById('boardCard'); if(!c)return {open:false};
            const vis=e=>!!e&&!e.hidden&&e.getClientRects().length>0;
            return {open:!c.hidden, buttons:[...c.querySelectorAll('button')].filter(vis).map(x=>x.textContent), note:c.querySelector('.savenote').textContent,
              text:[...c.querySelectorAll('p,li')].filter(vis).map(x=>x.textContent).join(' | '), input:vis(c.querySelector('[data-view=join] input')),
              rows:[...c.querySelectorAll('.kb-row')].map(r=>({pos:r.querySelector('.kb-pos').textContent, name:r.querySelector('.kb-name b').textContent,
                small:(r.querySelector('.kb-name small')||{}).textContent||'', val:r.querySelector('.kb-val').textContent, me:r.classList.contains('me')})),
              gap:!!c.querySelector('.kb-gap'), state:G.board.state, pad:c.dataset.padBack, title:!document.getElementById('title').hidden,
              pause:!document.getElementById('pause').hidden, mode:G.state.mode, focus:document.activeElement&&document.activeElement.textContent}; }"""
        async def card(): return await pg.evaluate(CARD)
        async def click(text):   # a visible button on the board card, by its exact text
            await pg.evaluate("t => { const b=[...document.querySelectorAll('#boardCard button')].find(x=>x.textContent===t&&!x.hidden&&x.getClientRects().length); if(!b)throw new Error('no button '+t); b.click(); }", text)
        async def settle(): await pg.wait_for_function("document.querySelector('#boardCard .savenote').textContent!=='One moment…'&&!/Fetching/.test(document.querySelector('#boardCard [data-view=board] [role=status]').textContent)", timeout=60000, polling=200)
        PUTS = lambda: fake.reqs('PUT', '/v1/record')

        ctx, pg = await device()

        async def links():
            r = await pg.evaluate("() => ({row:[...document.querySelectorAll('#title .bq-links button')].map(b=>b.textContent), pause:[...document.querySelectorAll('#pause .bq-links button')].map(b=>b.textContent), board:!!window.G.board, enabled:G.board&&G.board.state.enabled})")
            check('links', r['row'] == ['Sync devices', 'Send feedback', 'Keepers’ Board'] and r['pause'] == r['row'] and r['enabled'], r)
            await pg.wait_for_timeout(1000)
            check('nothingSentOnTitle', not fake.reqs(path='/v1/record') and not fake.reqs(path='/v1/board'), {'log': [x['m'] + ' ' + x['p'] for x in fake.log]})
        await step('links', links)

        async def firstOpen():
            await pg.click('#title [data-board-link]'); await pg.wait_for_timeout(400)
            c = await card()
            check('firstOpenJoin', c['open'] and not c['title'] and c['input'] and 'Turn on sync and join' in c['buttons'] and 'Not now' in c['buttons'] and 'Back' not in c['buttons']
                  and 'Keepers’ Board lists' in c['text'] and 'needs sync' in c['text'] and 'without a name unless you join' in c['text'] and c['pad'] == 'boardNotNow', c)
            await pg.screenshot(path=SHOTS + '/join_desktop.png')
            await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(500)
            await pg.screenshot(path=SHOTS + '/join_phone.png')
            sw = await pg.evaluate("() => { const s=document.querySelector('#boardCard .sheet'); return {sw:s.scrollWidth, cw:s.clientWidth, doc:document.documentElement.scrollWidth}; }")
            check('joinFitsPhone', sw['sw'] <= sw['cw'] + 1 and sw['doc'] <= 391, sw)
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(300)
            await click('Not now'); await settle()
            c = await card()
            check('notNowShowsBoard', c['state']['view'] == 'board' and c['state']['asked'] and 'Join the board' in c['buttons'] and 'Times are reported by each player’s browser.' in c['text'] and c['pad'] == 'boardBack', c)
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            c = await card()
            check('escapeBackToTitle', not c['open'] and c['title'], c)
        await step('firstOpen', firstOpen)

        async def join():
            await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(1500)
            await pg.evaluate("""() => { G.board.debug.gap(1500); const D=G.record.debug; D.addPlay(5000); D.reach('ashore',30); D.reach('plain-flame',400); D.reach('stag',600);
                D.set('boss.stag',{tries:2,best:95,hurt:1,draughts:0}); D.reach('gloaming',4000); G.flow.writeSave(); }""")
            await pg.evaluate("document.getElementById('pauseBtn').click()"); await pg.wait_for_timeout(400)
            await pg.click('#pause [data-board-link]'); await settle()
            c = await card()
            check('pauseOpensBoard', c['open'] and not c['pause'] and c['mode'] == 'paused' and c['state']['view'] == 'board' and not c['state']['code'], c)
            await click('Join the board'); await pg.wait_for_timeout(300)
            await pg.fill('#boardCard [data-view=join] input', 'ab'); await click('Turn on sync and join'); await pg.wait_for_timeout(300)
            n0 = len(PUTS()); c = await card()
            check('joinTooShortLocal', '3 to 16' in c['note'] and not c['state']['code'] and n0 == 0, c)
            await pg.fill('#boardCard [data-view=join] input', 'taken name'); await click('Turn on sync and join'); await settle()
            c = await card(); named = [x for x in PUTS() if x['b'] and 'name' in x['b']]
            check('joinTaken', 'taken' in c['note'] and c['state']['code'] and not c['state']['name'] and c['state']['view'] == 'join' and len(named) >= 1, dict(c, named=len(named)))
            await pg.fill('#boardCard [data-view=join] input', 'Badword Keeper'); await click('Join the board'); await settle()
            c = await card()
            check('joinInvalid', 'isn’t allowed' in c['note'] and not c['state']['name'], c)
            await pg.fill('#boardCard [data-view=join] input', '  Fog   Walker '); await click('Join the board'); await settle()
            c = await card(); key = (await pg.evaluate("localStorage.getItem('bq-sync-key')")); rec = fake.records.get(key, {})
            check('join', c['state']['name'] == 'Fog Walker' and c['state']['joined'] and rec.get('name') == 'Fog Walker' and 'Welcome to the board, Fog Walker' in c['note']
                  and c['state']['view'] == 'board' and 'Change name' in c['buttons'] and 'sent with your name' in c['text'], dict(c, rec=rec))
            last = [x for x in PUTS() if x['b'] and x['b'].get('name') == 'Fog Walker'][-1]['b']
            check('uploadBody', last['build'] == '9.9.9-test' and last['play'] >= 5000 and last['splits'].get('gloaming') == 4000 and last['splits'].get('ashore') == 30
                  and last['bosses'] == {'stag': 95} and isinstance(last['badges'], int) and last['badges'] >= 1 and isinstance(last['rank'], int) and 'crew' not in last and set(['deaths', 'pct', 'days']) <= set(last), last)
            fake.state_key = key
        await step('join', join)

        async def boards():
            await pg.evaluate("G.board.debug.cache(600000)")   # a slow machine can take over a minute for this check
            n0 = len(fake.reqs('GET', '/v1/board'))
            await pg.evaluate("G.board.debug.tab('act1')"); await settle()
            c = await card(); r = c['rows']
            me = [x for x in r if x['me']]
            check('boardAct1', len(r) == 26 and c['gap'] and r[0]['name'] == 'Taken Name' and r[0]['val'] == '16:40' and r[0]['pos'] == '1' and len(me) == 1 and me[0]['pos'] == '31'
                  and me[0]['name'] == 'Fog Walker' and me[0]['val'] == '1:06:40' and r[-1]['me'] and 'badge' in r[1]['small'] and any(rk in r[1]['small'] for rk in ('Castaway', 'Lamplighter', 'Keeper', 'Warden')), {'n': len(r), 'first': r[:2], 'me': me})
            await pg.screenshot(path=SHOTS + '/board_desktop.png')
            await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(500)
            await pg.screenshot(path=SHOTS + '/board_phone.png')
            await pg.evaluate("document.querySelector('#boardCard').scrollTop=99999"); await pg.wait_for_timeout(200)
            await pg.screenshot(path=SHOTS + '/board_phone_bottom.png')
            sw = await pg.evaluate("() => { const s=document.querySelector('#boardCard .sheet'); return {sw:s.scrollWidth, cw:s.clientWidth, doc:document.documentElement.scrollWidth}; }")
            check('boardFitsPhone', sw['sw'] <= sw['cw'] + 1 and sw['doc'] <= 391, sw)
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(300)
            await click('Full game'); await settle(); c = await card()
            check('boardFull', [x['name'] for x in c['rows']] == ['Taken Name', 'Keeper 01', 'Keeper 02'] and c['rows'][0]['val'] == '50:00' and not any(x['me'] for x in c['rows']), c['rows'])
            await click('Fewest deaths'); await settle(); c = await card()
            check('boardDeaths', [x['val'] for x in c['rows']] == ['0 deaths', '2 deaths', '4 deaths'] and 'finished full games' in c['text'], {'rows': c['rows'], 'text': c['text'][-200:]})
            await click('Most complete'); await settle(); c = await card(); me = [x for x in c['rows'] if x['me']]
            check('boardPct', len(me) == 1 and me[0]['val'] == '1%' and me[0]['pos'] == '31' and c['gap'] and c['rows'][0]['val'] == '90%', {'me': me, 'first': c['rows'][:1]})
            await click('Bosses'); await settle(); c = await card()
            spoil = [w for w in ('Undertow', 'Tithe', 'The Answer', 'Wreck Giant') if w in ' '.join(c['buttons']) + c['text']]
            check('bossesOnlyBeaten', 'The Hollow Stag' in c['buttons'] and 'The Gloaming' in c['buttons'] and not spoil and c['state']['boss'] == 'stag'
                  and any(x['me'] and x['val'] == '1:35' for x in c['rows']) and c['rows'][0]['val'] == '1:00', {'buttons': c['buttons'], 'spoil': spoil, 'rows': c['rows'][:3]})
            await click('The Gloaming'); await settle(); c = await card()
            check('bossEmpty', 'No keepers here yet.' in c['text'] and fake.reqs('GET', '/v1/board')[-1]['q'].get('b') == 'boss:gloaming', {'text': c['text'][:300]})
            n1 = len(fake.reqs('GET', '/v1/board'))
            await click('Act 1'); await settle(); await click('Full game'); await settle()
            n2 = len(fake.reqs('GET', '/v1/board'))
            check('boardCached', n2 == n1 and n1 - n0 == 5, {'fetched': n1 - n0, 'again': n2 - n1})
            await click('Act 1'); await settle()
        await step('boards', boards)

        async def routine():
            await pg.evaluate("G.board.debug.gap(1500)"); await pg.wait_for_timeout(1700)
            n0 = len(PUTS())
            await pg.evaluate("G.record.debug.reach('lantern',700)")
            for _ in range(40):
                if len(PUTS()) > n0: break
                await pg.wait_for_timeout(250)
            new = PUTS()[n0:]; named = [x for x in PUTS() if x['b'] and ('name' in x['b'])]
            routine = [x for x in PUTS() if x['b'] and 'name' not in x['b'] and 'crew' not in x['b']]
            check('routineUpload', len(new) >= 1 and new[0]['b'].get('splits', {}).get('lantern') == 700 and 'name' not in new[0]['b'] and 'crew' not in new[0]['b'], {'new': len(new)})
            check('routineNeverNamed', len(routine) >= 2 and all('name' not in x['b'] for x in routine) and len(named) >= 3, {'routine': len(routine), 'named': len(named)})
        await step('routine', routine)

        async def throttle():
            await pg.evaluate("G.board.debug.gap(5000)"); await pg.wait_for_timeout(5200)
            n0 = len(PUTS()); t0 = time.time()
            await pg.evaluate("() => { const D=G.record.debug; D.reach('staff',800); D.reach('lamp-cured',2000); G.emit('badge:earned',{id:'x'}); G.emit('record:boss',{id:'stag',win:true}); }")
            await pg.wait_for_timeout(2500); mid = len(PUTS()) - n0
            for _ in range(120):   # a busy page can take seconds to settle each request
                if len(PUTS()) - n0 >= 2: break
                await pg.wait_for_timeout(250)
            ts = [x['t'] - t0 for x in PUTS()[n0:]]
            st = await pg.evaluate("G.board.state")
            check('throttle', mid == 1 and len(ts) == 2 and ts[1] - ts[0] >= 4.5 and PUTS()[-1]['b']['splits'].get('lamp-cured') == 2000, {'mid': mid, 'times': ts, 'state': {k: st[k] for k in ('dirty', 'timer', 'sinceTry', 'last', 'uploads', 'bad')}})
            await pg.evaluate("G.board.debug.gap(1500)")
        await step('throttle', throttle)

        async def noSave():
            await pg.wait_for_timeout(1700); fake.force_no_save = True; n0 = len(PUTS())
            await pg.evaluate("G.record.debug.reach('undertow',4500)")
            await pg.wait_for_function("G.board.state.waitSave", timeout=60000, polling=200)
            await pg.wait_for_timeout(2500); n1 = len(PUTS())
            fake.force_no_save = False
            await pg.evaluate("G.emit('cloud:saved',{at:Date.now()})")   # what cloud.js says when a save has landed (the fake already holds one)
            for _ in range(120):
                if fake.records[fake.state_key]['splits'].get('undertow') == 4500: break
                await pg.wait_for_timeout(250)
            try: await pg.wait_for_function("G.board.state.last&&G.board.state.last.status===200", timeout=60000, polling=200)   # the page reads the answer later than the fake sends it
            except Exception: pass
            s = await pg.evaluate("G.board.state")
            check('noSaveRetry', n1 - n0 == 1 and fake.records[fake.state_key]['splits'].get('undertow') == 4500 and not s['waitSave'] and s['last']['status'] == 200,
                  {'waited': n1 - n0, 'state': {k: s[k] for k in ('dirty', 'timer', 'sinceTry', 'last', 'waitSave')}, 'puts': [(round(x['t'] - time.time(), 1), x['p']) for x in fake.log[-8:]], 'saves': len(fake.reqs('PUT', '/v1/save'))})
        await step('noSave', noSave)

        async def rate():
            await pg.wait_for_timeout(1700); fake.rate_once = 3; n0 = len(PUTS()); t0 = time.time()
            await pg.evaluate("G.record.debug.reach('crane',4800)")
            await pg.wait_for_function("G.board.state.blocked>0", timeout=60000, polling=100)
            for _ in range(60):
                if len(PUTS()) - n0 >= 2: break
                await pg.wait_for_timeout(250)
            ts = [x['t'] - t0 for x in PUTS()[n0:]]
            check('retryAfter', len(ts) == 2 and ts[1] - ts[0] >= 2.8 and fake.records[fake.state_key]['splits'].get('crane') == 4800, {'times': ts})
        await step('rate', rate)

        async def hidden():
            await pg.evaluate("G.board.debug.gap(600000)"); await pg.wait_for_timeout(300)
            await pg.evaluate("G.record.debug.reach('answer',5000)"); await pg.wait_for_timeout(800)
            n0 = len(PUTS()); s = await pg.evaluate("G.board.state")
            await pg.evaluate("() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange')); }")
            for _ in range(20):
                if len(PUTS()) > n0: break
                await pg.wait_for_timeout(250)
            await pg.evaluate("() => { delete document.hidden; }")
            check('hiddenFlush', s['dirty'] and len(PUTS()) == n0 + 1 and fake.records[fake.state_key]['splits'].get('answer') == 5000 and 'name' not in PUTS()[-1]['b'], dict(s, puts=len(PUTS()) - n0))
            await pg.evaluate("G.board.debug.gap(1500)")
        await step('hidden', hidden)

        async def crew():
            await click('Crew'); await pg.wait_for_timeout(300); c = await card()
            check('crewCard', 'Make a crew' in c['buttons'] and 'Join crew' in c['buttons'] and 'Leave crew' not in c['buttons'], c['buttons'])
            await click('Make a crew'); await settle(); c = await card(); made = fake.records[fake.state_key].get('crew', '')
            last = PUTS()[-1]['b']
            check('crewMake', re.match(r'^[0-9A-Z]{6}$', made) and c['state']['crew'] == made and c['state']['crewView'] and 'Crew ' + made in c['buttons'] and 'Everyone' in c['buttons']
                  and last.get('crew') == made and 'name' not in last and fake.reqs('GET', '/v1/board')[-1]['q'].get('crew') == made and [x['name'] for x in c['rows']] == ['Fog Walker'], dict(c['state'], rows=c['rows'], made=made))
            await click('Crew ' + made); await pg.wait_for_timeout(100)
            # the scope button and the crew button share the label: the second is the one in the actions row
            await pg.evaluate("() => { const bs=[...document.querySelectorAll('#boardCard [data-view=board] .actions button')]; bs.find(b=>b.id==='boardCrew').click(); }"); await pg.wait_for_timeout(300)
            c = await card()
            check('crewShown', made in c['text'] and 'Leave crew' in c['buttons'] and 'Make a crew' not in c['buttons'], c['text'][:300])
            await click('Leave crew'); await settle(); c = await card(); last = PUTS()[-1]['b']
            check('crewLeave', last.get('crew') == '' and 'name' not in last and fake.records[fake.state_key]['crew'] == '' and not c['state']['crew'] and 'Make a crew' in c['buttons'], dict(c['state'], last=last.get('crew')))
            await pg.fill('#boardCard [data-view=crew] input', 'ab'); await click('Join crew'); await pg.wait_for_timeout(200); c = await card()
            check('crewInvalidLocal', '4 to 12' in c['note'], c['note'])
            await pg.fill('#boardCard [data-view=crew] input', 'friends1'); await click('Join crew'); await settle(); c = await card()
            check('crewJoin', c['state']['crew'] == 'FRIENDS1' and c['state']['crewView'] and fake.records[fake.state_key]['crew'] == 'FRIENDS1'
                  and [x['name'] for x in c['rows']] == ['Keeper 03', 'Keeper 07', 'Keeper 12', 'Fog Walker'] and c['rows'][-1]['me'], dict(c['state'], rows=[x['name'] for x in c['rows']]))
            await click('Everyone'); await settle(); c = await card()
            check('crewFilterOff', not c['state']['crewView'] and 'crew' not in fake.reqs('GET', '/v1/board')[-1]['q'] and len(c['rows']) == 26, {'q': fake.reqs('GET', '/v1/board')[-1]['q'], 'n': len(c['rows'])})
        await step('crew', crew)

        async def leave():
            await click('Change name'); await pg.wait_for_timeout(300); c = await card()
            check('changeNameCard', 'Save name' in c['buttons'] and 'Leave the board' in c['buttons'] and 'Back' in c['buttons'] and await pg.input_value('#boardCard [data-view=join] input') == 'Fog Walker', c['buttons'])
            await pg.fill('#boardCard [data-view=join] input', 'Fog Walker Two'); await click('Save name'); await settle(); c = await card()
            check('changeName', c['state']['name'] == 'Fog Walker Two' and fake.records[fake.state_key]['name'] == 'Fog Walker Two' and 'now Fog Walker Two' in c['note'], c['state'])
            await click('Change name'); await pg.wait_for_timeout(200); await click('Leave the board'); await settle(); c = await card()
            check('leaveBoard', not c['state']['name'] and PUTS()[-1]['b'].get('name') == '' and fake.records[fake.state_key]['name'] == '' and 'left the board' in c['note'] and 'Join the board' in c['buttons']
                  and not any(x['me'] for x in c['rows']) and 'not on the board' in c['text'], dict(c['state'], text=c['text'][-200:]))
        await step('leave', leave)

        async def dnt():
            await pg.wait_for_timeout(1700)
            await pg.evaluate("() => Object.defineProperty(navigator,'doNotTrack',{configurable:true,get:()=>'1'})")
            n0 = len(PUTS()); await pg.evaluate("G.record.debug.reach('sailed',5200)"); await pg.wait_for_timeout(2500)
            s = await pg.evaluate("({s:G.board.state, can:G.board.debug.canUpload()})")
            await pg.evaluate("() => G.board.debug.tab('act1')"); await settle(); c = await card()
            check('dntNoUploads', len(PUTS()) == n0 and s['s']['dnt'] and not s['can'] and 'nothing is sent from this device unless you join' in c['text'], dict(s, puts=len(PUTS()) - n0))
            await pg.evaluate("() => { delete navigator.doNotTrack; }")
        await step('dnt', dnt)

        async def down():
            fake.down = True
            try:
                await pg.evaluate("G.board.debug.dropCache()"); await click('Most complete'); await settle(); c = await card()
                check('downCardSays', 'Couldn’t reach the board' in c['text'] and 'Yours:' in c['text'], {'text': c['text'][:300]})
                await pg.evaluate("G.record.debug.reach('giant',6000)"); await pg.wait_for_timeout(2500)
                await click('Back'); await pg.wait_for_timeout(300); c = await card()
                check('backToPause', not c['open'] and c['pause'] and c['mode'] == 'paused', c)
                await pg.evaluate("document.getElementById('resume').click()"); await pg.wait_for_timeout(300)
                r = await pg.evaluate("async () => { G.headless.hold=true; const t=G.record.play(); G.step(1/10,50); await new Promise(r=>setTimeout(r,0)); return {mode:G.state.mode, dt:G.record.play()-t, last:G.board.state.last}; }")
                check('downPlayGoesOn', r['mode'] == 'play' and r['dt'] > 4 and r['last']['status'] == 0, r)
            finally:
                fake.down = False
        await step('down', down)

        await ctx.close()
        # ---- without BQ_CONFIG: nothing; with it under ?debug: nothing either ----
        async def noConfig():
            c2, p2 = await device(cfg=False)
            r = await p2.evaluate("() => ({board:!!(window.G&&G.board), link:!!document.querySelector('[data-board-link]'), card:!!document.getElementById('boardCard')})")
            check('noConfigNothing', not r['board'] and not r['link'] and not r['card'], r)
            await c2.close()
        await step('noConfig', noConfig)
        async def debugQuiet():
            n0 = len(fake.log)
            dbg = URL + ('&' if '?' in URL else '?') + 'debug'
            c3, p3 = await device(url=dbg)
            r = await p3.evaluate("async () => { const s=G.board.state; G.record&&G.record.debug.reach('ashore',30); const ok=await G.board.push(); return {enabled:s.enabled, link:!!document.querySelector('[data-board-link]'), ok}; }")
            await p3.wait_for_timeout(1500)
            sent = [x['m'] + ' ' + x['p'] for x in fake.log[n0:] if x['p'] in ('/v1/record', '/v1/board')]
            check('debugQuiet', not r['enabled'] and not r['link'] and r['ok'] is False and not sent, dict(r, sent=sent))
            await c3.close()
        await step('debugQuiet', debugQuiet)

        errs = [e for q in pages for e in q.errs]
        check('onlyKnownEndpoints', not fake.other, fake.other[:5])
        check('noPageErrors', not errs, errs[:3])
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)) + (' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''))
    sys.exit(1 if fails else 0)
asyncio.run(main())
