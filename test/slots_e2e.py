# Save slots for signed-in keepers (js/slots.js) against a fake of the save service's /v1/saves* routes (server/README.md),
# answered here in Python through Playwright's request routing, as test/account_e2e.py does. Spec: ACCOUNTS.md (section 6b).
# The page is served under https://game.bq.test and the fake service is https://api.bq.test (one site), so the session cookie
# travels with credentials:'include'. Sign-in is done by giving the browser a session cookie and calling G.account.refresh().
# Usage: python3 test/slots_e2e.py "http://localhost:PORT/dev.html?headless"
# Screenshots go to $SHOTS (default /tmp/claude-0/a5).
import asyncio, json, os, secrets, sys, time
from urllib.parse import urlparse
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8825/dev.html?headless"
U = urlparse(URL); BASE = U.scheme + '://' + U.netloc
GAME = 'https://game.bq.test'; API = 'https://api.bq.test'
PAGE = GAME + U.path + ('?' + U.query if U.query else '')
CFG = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false,accounts:true};window.BQ_ACCOUNTS_TEST=true;" % API
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/a5')
BUDGET = 600
CODE = 'ABCD1234EFGH'

def guest_save(objective, at=None, play=600):
    at = at or int(time.time() * 1000) - 3600 * 1000
    return {'v': 1, 'at': at, 'step': 'loop', 'objective': objective, 'sub': '', 'target': None, 'targetName': '', 'cp': [164, 42, -4], 'cpYaw': 0,
            'cpName': 'the lighthouse', 'flags': {}, 'pos': [164, 42, -4], 'yaw': 0, 'hp': 4, 'maxHp': 4,
            'lantern': {'found': False, 'carried': False, 'shut': False, 'cured': False, 'inCradle': False, 'pos': None},
            'staff': False, 'cloak': False, 'storm': {'found': False, 'carried': False, 'inCradle': False, 'failed': False, 'spent': False, 'pos': None},
            'stagDead': False, 'lampCured': False, 'bossDead': False, 'freed': [], 'loop': False,
            'rec': {'play': play, 'pct': 12, 'rank': 'Lamplighter', 'ri': 1}, 'mods': {}}

class Fake:
    def __init__(self):
        self.accounts = {}; self.sessions = {}; self.slots = {}; self.guest = {}; self.log = []; self.other = []; self.down = False
    def reqs(self, method=None, path=None, since=0):
        return [r for r in self.log[since:] if (method is None or r['m'] == method) and (path is None or r['p'] == path)]
    def account(self, email):
        if email not in self.accounts:
            self.accounts[email] = {'id': secrets.token_hex(8), 'email': email, 'name': '', 'role': 'player', 'tools': [], 'password': None}
            self.slots[self.accounts[email]['id']] = {}
        return self.accounts[email]
    def cookie(self, email):
        a = self.account(email); tok = secrets.token_urlsafe(24); self.sessions[tok] = a['email']
        return {'name': 'bq_s', 'value': tok, 'domain': 'api.bq.test', 'path': '/', 'httpOnly': True, 'secure': True, 'sameSite': 'Lax'}
    def me(self, a): return {'id': a['id'], 'email': a['email'], 'name': a['name'], 'role': a['role'], 'tools': [], 'hasPassword': False, 'created': 1763546400000}
    def put_slot(self, email, n, save, name=None, test=False):
        a = self.account(email); s = json.dumps(save)
        self.slots[a['id']][n] = {'name': name or 'Save %d' % n, 'test': test, 'at': save['at'], 'objective': save['objective'], 'rec': save.get('rec'), 'body': s, 'updated': int(time.time() * 1000)}
    async def handle(self, route):
        rq = route.request; u = urlparse(rq.url); path = u.path
        h = await rq.all_headers(); origin = h.get('origin', '')
        cors = {'Access-Control-Allow-Origin': origin or GAME, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-BQ-Client', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
                'Access-Control-Expose-Headers': 'Retry-After', 'Cache-Control': 'no-store'}
        async def send(status, body=None, extra=None):
            hh = dict(cors, **{'Content-Type': 'application/json'}); hh.update(extra or {})
            await route.fulfill(status=status, headers=hh, body=json.dumps(body) if body is not None else '')
        cookie = dict(x.strip().split('=', 1) for x in (h.get('cookie') or '').split(';') if '=' in x)
        try: body = json.loads(rq.post_data) if rq.post_data else None
        except Exception: body = None
        if rq.method != 'OPTIONS':
            self.log.append({'m': rq.method, 'p': path, 'b': body, 't': time.time(), 'cookie': 'bq_s' in cookie, 'auth': h.get('authorization') or ''})
        if self.down: return await route.abort()
        if rq.method == 'OPTIONS': return await send(204)
        email = self.sessions.get(cookie.get('bq_s', '')); acct = self.accounts.get(email) if email else None
        writes = rq.method not in ('GET', 'HEAD')
        if writes and acct and (h.get('x-bq-client') != '1' or origin != GAME): return await send(403, {'error': 'bad_origin'})
        if path == '/v1/me':
            if not acct: return await send(401, {'error': 'signed_out'})
            return await send(200, self.me(acct))
        if path == '/v1/auth/signout':
            self.sessions.pop(cookie.get('bq_s', ''), None)
            return await send(200, {'ok': True}, {'Set-Cookie': 'bq_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'})
        if path == '/v1/save':
            code = (h.get('authorization') or '').replace('Bearer ', '')
            if rq.method == 'GET':
                g = self.guest.get(code)
                return await send(200, g) if g else await send(404, {'error': 'no_save'})
            if rq.method == 'PUT':
                g = self.guest.get(code)
                if g and g['at'] >= body['at']: return await send(409, {'error': 'stale', 'at': g['at']})
                self.guest[code] = {'v': 1, 'at': body['at'], 'objective': body['objective'], 'save': body['save']}
                return await send(200, {'ok': True, 'at': body['at']})
        if path.startswith('/v1/saves'):
            if not acct: return await send(401, {'error': 'signed_out'})
            S = self.slots[acct['id']]
            parts = path.split('/')[3:]
            if path == '/v1/saves' and rq.method == 'GET':
                return await send(200, {'max': 10, 'slots': [{'slot': n, 'name': v['name'], 'test': v['test'], 'at': v['at'], 'objective': v['objective'], 'rec': v['rec'], 'updated': v['updated']} for n, v in sorted(S.items())]})
            if path == '/v1/saves/claim' and rq.method == 'POST':
                code = str((body or {}).get('code', ''))
                g = self.guest.get(code)
                if not g: return await send(404, {'error': 'no_save'})
                free = [n for n in range(1, 11) if n not in S]
                if not free: return await send(409, {'error': 'full'})
                n = free[0]; S[n] = {'name': 'Save %d' % n, 'test': False, 'at': g['at'], 'objective': g['objective'], 'rec': None, 'body': g['save'], 'updated': int(time.time() * 1000)}
                del self.guest[code]
                return await send(200, {'ok': True, 'slot': n, 'name': acct['name']})
            try: n = int(parts[0])
            except Exception: return await send(400, {'error': 'bad_slot'})
            if n < 1 or n > 10: return await send(400, {'error': 'bad_slot'})
            if len(parts) == 2 and parts[1] == 'rename' and rq.method == 'POST':
                if n not in S: return await send(404, {'error': 'no_save'})
                S[n]['name'] = str(body['name']).strip()[:24]; return await send(200, {'ok': True})
            if len(parts) == 1 and rq.method == 'GET':
                if n not in S: return await send(404, {'error': 'no_save'})
                v = S[n]; return await send(200, {'slot': n, 'name': v['name'], 'test': v['test'], 'at': v['at'], 'objective': v['objective'], 'rec': v['rec'], 'body': v['body'], 'updated': v['updated']})
            if len(parts) == 1 and rq.method == 'PUT':
                b = body or {}
                if not isinstance(b.get('at'), int) or not isinstance(b.get('save') or b.get('body'), str): return await send(400, {'error': 'bad_request'})
                old = S.get(n)
                if old and old['at'] >= b['at']: return await send(409, {'error': 'stale', 'at': old['at']})
                S[n] = {'name': b.get('name') or (old and old['name']) or 'Save %d' % n, 'test': bool((old and old['test']) or b.get('test')), 'at': b['at'],
                        'objective': b.get('objective', ''), 'rec': b.get('rec', old and old['rec']), 'body': b.get('save') or b.get('body'), 'updated': int(time.time() * 1000)}
                return await send(200, {'ok': True, 'at': b['at'], 'test': S[n]['test']})
            if len(parts) == 1 and rq.method == 'DELETE':
                S.pop(n, None); return await send(200, {'ok': True})
        if path == '/v1/event': return await send(204)
        if path == '/v1/record' or path == '/v1/board': return await send(404, {'error': 'no_save'})
        self.other.append(rq.method + ' ' + path); await send(404, {'error': 'not_found'})

ST = """() => { const S=G.slots, c=document.getElementById('slotsCard'), vis=e=>!!e&&!e.hidden&&e.getClientRects().length>0;
  const v=c&&c.querySelector('[data-view]:not([hidden])');
  return {mode:G.state.mode, acc:G.account.state, sess:S.debug.sess, active:S.active(), test:!!G.testSaves, key:S.saveKey(),
    card:c&&!c.hidden?(v?v.dataset.view:''):'', title:c?c.querySelector('h2').textContent:'', note:c?c.querySelector('.savenote').textContent:'',
    rows:c?[...c.querySelectorAll('.sl-row')].map(r=>({n:+r.dataset.slot,empty:r.classList.contains('empty'),text:r.innerText.replace(/\\s+/g,' ').trim(),cur:r.classList.contains('cur')})):[],
    buttons:c?[...c.querySelectorAll('button')].filter(vis).map(b=>b.textContent):[], pad:c?c.dataset.padBack:'',
    tcont:vis(document.getElementById('continue')), tbegin:document.getElementById('begin').textContent, info:document.getElementById('saveInfo').textContent,
    slotNote:(document.getElementById('slotNote')||{}).textContent||'', titleShown:!document.getElementById('title').hidden,
    guest:localStorage.getItem('bq-save-v1'), code:localStorage.getItem('bq-sync-key'), focus:document.activeElement&&(document.activeElement.id||document.activeElement.textContent.slice(0,40)),
    toast:document.getElementById('toast').textContent, list:S.list()}; }"""

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    fails = []; skipped = []
    def check(name, ok, info):
        print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info, default=str)[:700])
        if not ok: fails.append(name)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        fake = Fake()
        async def game(route):
            u = urlparse(route.request.url)
            try:
                r = await route.fetch(url=BASE + u.path + ('?' + u.query if u.query else ''))
                await route.fulfill(response=r)
            except Exception:
                try: await route.abort()
                except Exception: pass
        async def context(seed=None):
            ctx = await b.new_context(viewport={'width': 1100, 'height': 700})
            await ctx.add_init_script(CFG)
            if seed: await ctx.add_init_script("if(!sessionStorage.getItem('seeded')){ sessionStorage.setItem('seeded','1'); " + seed + " }")
            await ctx.route(GAME + '/**', game); await ctx.route(API + '/**', fake.handle)
            return ctx
        async def load(pg, reload=False):
            if reload: await pg.reload(wait_until='domcontentloaded')
            else: await pg.goto(PAGE, wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(600)
            await pg.evaluate("G.slots.debug.gap(0)")
        async def page(ctx):
            pg = await ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)))
            pg.set_default_navigation_timeout(240000); pg.set_default_timeout(120000)
            return pg
        async def signin(ctx, pg, email):
            await ctx.add_cookies([fake.cookie(email)])
            await pg.evaluate("G.account.refresh()")
            await pg.wait_for_function("e => G.account.me&&G.account.me.email===e", arg=email, timeout=60000, polling=100)
            try: await pg.wait_for_function("!G.slots.debug.log.length||G.slots.debug.log.slice(-1)[0].p!=='/v1/saves'||true", timeout=5000)
            except Exception: pass
            await pg.wait_for_timeout(1200)
        async def st(pg): return await pg.evaluate(ST)
        async def click(pg, sel):
            await pg.evaluate("s => { const b=document.querySelector(s); if(!b||b.hidden||!b.getClientRects().length)throw new Error('not shown '+s); b.click(); }", sel)
        async def row(pg, n, act='use'):
            await click(pg, '#slotsCard .sl-row[data-slot="%d"] [data-act="%s"]' % (n, act))
        async def settle(pg):
            await pg.wait_for_function("!document.getElementById('slotsCard')||document.querySelector('#slotsCard .savenote').textContent!=='One moment…'", timeout=60000, polling=100)
            await pg.wait_for_timeout(200)
        async def card(pg, v, t=60000):
            try: await pg.wait_for_function("v => G.slots.debug.ui===v", arg=v, timeout=t, polling=100)
            except Exception: pass
            await pg.wait_for_timeout(250)
        async def until(fn, t=25):
            end = time.time() + t
            while time.time() < end:
                if fn(): return True
                await asyncio.sleep(0.3)
            return False
        async def play(pg): await pg.wait_for_function("G.state.mode==='play'", timeout=120000); await pg.wait_for_timeout(800)
        async def shot(pg, name):
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(300)
            await pg.evaluate("G.headless&&G.headless.draw&&G.headless.draw(2)"); await pg.wait_for_timeout(300)
            await pg.screenshot(path=SHOTS + '/' + name + '_desktop.png')
            await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(500)
            await pg.evaluate("G.headless&&G.headless.draw&&G.headless.draw(2)"); await pg.wait_for_timeout(300)
            await pg.screenshot(path=SHOTS + '/' + name + '_phone.png')
            r = await pg.evaluate("() => { const s=document.querySelector('#slotsCard .sheet'); return {sw:s.scrollWidth, cw:s.clientWidth, doc:document.documentElement.scrollWidth}; }")
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(300)
            return r
        fits = lambda r: r['sw'] <= r['cw'] + 1 and r['doc'] <= 391
        ONLY = [x for x in os.environ.get('ONLY', '').split(',') if x]
        async def step(name, fn, needs=()):
            if ONLY and name not in ONLY: print('SKIP ' + name + ' : not in ONLY'); return
            if any(d in fails or d in skipped for d in needs): print('SKIP ' + name + ' : needs ' + ', '.join(needs)); skipped.append(name); return
            n0 = len(fails); t0 = time.time()
            try: await asyncio.wait_for(fn(), BUDGET)
            except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})
            if len(fails) > n0 and name not in fails: fails.append(name)
            print('     (%s: %.0f s)' % (name, time.time() - t0))
        A = 'a@example.com'; B = 'b@example.com'; C = 'c@example.com'; D = 'd@example.com'
        G1 = guest_save('Guest game: find a light')
        W = {}

        # ---- device 1: a guest save, no sync code ----
        async def setup1():
            W['ctx'] = await context("localStorage.setItem('bq-save-v1', %s);" % json.dumps(json.dumps(G1)))
            W['pg'] = await page(W['ctx']); await load(W['pg'])
        await step('setup1', setup1)

        async def guestUnchanged():
            pg = W['pg']; s = await st(pg)
            n0 = len(fake.log)
            check('guestTitle', s['acc'] == 'out' and s['tcont'] and 'Guest game' in s['info'] and s['tbegin'] == 'New game' and s['key'] is None and s['active'] is None and not s['card'], s)
            r = await pg.evaluate("[G.slots.intercept('continue'), G.flow.keys.active, G.slots.list().length]")
            check('guestHooks', r == [False, 'bq-save-v1', 0] and not fake.reqs(path='/v1/saves', since=n0), r)
        await step('guestUnchanged', guestUnchanged, ('setup1',))

        async def claimOffer():
            pg = W['pg']; await signin(W['ctx'], pg, A); await card(pg, 'claim'); s = await st(pg)
            check('claimOffered', s['acc'] == 'in' and s['card'] == 'claim' and 'Guest game' in str(s['buttons']) + s['note'] + str(await pg.evaluate("document.querySelector('#slotsCard [data-view=claim] .sl-box').innerText"))
                  and 'Bring this save into your account' in s['buttons'] and s['pad'] == 'slClaimNo' and not s['titleShown'], s)
            r = await shot(pg, 'claim'); check('claimFitsPhone', fits(r), r)
            await click(pg, '#slClaimNo'); await pg.wait_for_timeout(300); s = await st(pg)
            asked = await pg.evaluate("JSON.parse(localStorage.getItem('bq-claim')||'{}')")
            check('claimDeclined', not s['card'] and s['titleShown'] and s['guest'] and len(asked) == 1 and not s['tcont'] and s['tbegin'] == 'Begin' and 'Signed in' in s['info']
                  and not fake.reqs('POST', '/v1/saves/claim'), dict(s, asked=asked))
        await step('claimOffer', claimOffer, ('setup1',))

        async def newGame():
            pg = W['pg']; n0 = len(fake.log)
            await click(pg, '#begin'); await play(pg); s = await st(pg)
            aid = fake.accounts[A]['id']
            check('newGameSlot1', s['sess'] and s['sess']['slot'] == 1 and not s['sess']['test'] and s['key'] == 'bq-save-s1-' + aid and s['active'] == {'slot': 1, 'test': False, 'name': 'Save 1'}, s['sess'])
            await pg.evaluate("G.flow.writeSave()")
            await until(lambda: fake.reqs('PUT', '/v1/saves/1', since=n0) and 1 in fake.slots[aid])
            puts = fake.reqs('PUT', '/v1/saves/1', since=n0)
            if not puts: print('     log', await pg.evaluate("JSON.stringify({log:G.slots.debug.log,sess:G.slots.debug.sess,key:G.flow.keys.active,saved:!!localStorage.getItem(G.flow.keys.active),acc:G.account.state,mode:G.state.mode})"))
            loc = await pg.evaluate("(k)=>JSON.parse(localStorage.getItem(k))", s['key'])
            check('autosaveUploads', puts and 'test' not in puts[-1]['b'] and puts[-1]['b']['at'] == loc['at'] and puts[-1]['cookie'] and not puts[-1]['auth']
                  and fake.slots[aid][1]['at'] == loc['at'] and isinstance(puts[-1]['b'].get('rec'), dict) and json.loads(puts[-1]['b']['save'])['at'] == loc['at'], [x['b'] and {k: v for k, v in x['b'].items() if k != 'save'} for x in puts])
            check('guestUntouched', s['guest'] == json.dumps(G1) and not fake.reqs('PUT', '/v1/save', since=n0), 'guest save kept')
        await step('newGame', newGame, ('claimOffer',))

        async def offline():
            pg = W['pg']; aid = fake.accounts[A]['id']
            fake.down = True
            await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(5000)
            v = await pg.evaluate("G.slots.debug.view(1)")
            check('offlineUnsent', v['unsent'] and fake.slots[aid][1]['at'] < v['la'], {'la': v['la'], 'srv': fake.slots[aid][1]['at']})
            fake.down = False
            await pg.evaluate("window.dispatchEvent(new Event('online'))")
            await until(lambda: fake.slots[aid][1]['at'] == v['la'])
            try: await pg.wait_for_function("!G.slots.debug.view(1).unsent", timeout=30000, polling=200)
            except Exception: pass
            v = await pg.evaluate("G.slots.debug.view(1)")
            dbg = await pg.evaluate("JSON.stringify({m:G.slots.debug.meta().s[1],log:G.slots.debug.log.slice(-8)})")
            check('uploadOnReconnect', not v['unsent'] and fake.slots[aid][1]['at'] == v['la'], {'la': v['la'], 'srv': fake.slots[aid][1]['at'], 'v': {k: v[k] for k in ('unsent', 'sa', 'conflict')}, 'dbg': dbg})
        await step('offline', offline, ('newGame',))

        async def testTools():
            pg = W['pg']; aid = fake.accounts[A]['id']; n0 = len(fake.log)
            before = dict(fake.slots[aid][1])
            await pg.evaluate("G.testSaves=true"); await pg.wait_for_timeout(300)
            await pg.evaluate("G.flow.writeSave()")
            await until(lambda: fake.reqs('PUT', '/v1/saves/2', since=n0))
            s = await st(pg)
            puts = fake.reqs('PUT', '/v1/saves/2', since=n0)
            check('testCopy', s['sess']['slot'] == 2 and s['sess']['test'] and s['active']['test'] and fake.slots[aid].get(2, {}).get('test') is True
                  and puts and puts[-1]['b'].get('test') is True and fake.slots[aid][1] == before and not fake.reqs('PUT', '/v1/saves/1', since=n0), dict(sess=s['sess'], puts=len(puts)))
        await step('testTools', testTools, ('newGame',))

        async def signOutMidGame():
            pg = W['pg']
            async with pg.expect_navigation(wait_until='domcontentloaded', timeout=90000):
                await pg.evaluate("G.account.signOut()")
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(600); await pg.evaluate("G.slots.debug.gap(0)")
            s = await st(pg)
            check('signOutTitle', s['acc'] == 'out' and s['tcont'] and 'Guest game' in s['info'] and 'signed out' in s['slotNote'] and s['key'] is None and s['guest'] == json.dumps(G1), s)
        await step('signOutMidGame', signOutMidGame, ('newGame',))

        async def slotList():
            pg = W['pg']; aid = fake.accounts[A]['id']
            await signin(W['ctx'], pg, A); s = await st(pg)
            check('noSecondOffer', not s['card'] and s['tcont'] and 'Last played: Save 1 (test) ·' in s['info'], s)
            await click(pg, '#continue'); await settle(pg); s = await st(pg)
            used = [dict(r, text=r['text'].lower()) for r in s['rows'] if not r['empty']]
            check('slotList', s['card'] == 'list' and len(s['rows']) == 10 and [r['n'] for r in used] == [1, 2] and 'test' in used[1]['text'].replace('(test)', '') and 'test' not in used[0]['text']
                  and used[1]['cur'] and 'last played' in used[1]['text'] and 'complete' in used[0]['text'] and s['pad'] == 'slotsBack' and 'of 10 save slots used' in await pg.evaluate("document.querySelector('#slotsCard .sl-fine').textContent"), s['rows'][:3])
            # keyboard: Escape closes, Continue reopens
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200); s2 = await st(pg)
            check('escapeCloses', not s2['card'] and s2['titleShown'], s2['card'])
            await click(pg, '#continue'); await settle(pg)
            # rename
            await row(pg, 1, 'rename'); await pg.wait_for_timeout(200)
            await pg.fill('#slotsCard input[name=slotname]', '  Lantern   run '); await click(pg, '#slRenameSave'); await settle(pg); s = await st(pg)
            rn = fake.reqs('POST', '/v1/saves/1/rename')
            check('rename', s['card'] == 'list' and rn and rn[-1]['b'] == {'name': 'Lantern run'} and fake.slots[aid][1]['name'] == 'Lantern run' and 'Lantern run' in s['rows'][0]['text'], s['note'])
            r = await shot(pg, 'slotlist'); check('listFitsPhone', fits(r), r)
            # the ten-slot limit
            for n in range(3, 11): fake.put_slot(A, n, guest_save('Filler %d' % n, at=int(time.time() * 1000) - n * 60000))
            await pg.evaluate("G.slots.debug.refresh()"); await pg.wait_for_timeout(300)
            await click(pg, '#slotsNew'); await pg.wait_for_timeout(300); s = await st(pg)
            check('tenLimit', s['card'] == 'list' and 'All ten save slots are in use' in s['note'] and s['mode'] == 'title' and s['focus'] == 'Delete', {'note': s['note'], 'focus': s['focus']})
            # delete (asks first)
            await row(pg, 10, 'delete'); await pg.wait_for_timeout(200); s = await st(pg)
            check('deleteAsks', s['card'] == 'delete' and 'can’t be undone' in await pg.evaluate("document.querySelector('#slotsCard [data-view=delete] p').textContent") and s['pad'] == 'slDelNo' and 10 in fake.slots[aid], s['buttons'])
            await click(pg, '#slDelGo'); await settle(pg); s = await st(pg)
            check('deleted', s['card'] == 'list' and 10 not in fake.slots[aid] and fake.reqs('DELETE', '/v1/saves/10') and s['rows'][9]['empty'], s['note'])
            # the keep-which card: this device has unsent progress, the account has a newer copy
            k1 = 'bq-save-s1-' + aid
            loc = await pg.evaluate("(k)=>JSON.parse(localStorage.getItem(k))", k1)
            loc['at'] += 1000; loc['objective'] = 'Device progress'
            await pg.evaluate("([k,v])=>localStorage.setItem(k,v)", [k1, json.dumps(loc)])
            acc = json.loads(fake.slots[aid][1]['body']); acc['at'] = loc['at'] + 5000; acc['objective'] = 'Account progress'
            fake.put_slot(A, 1, acc, name='Lantern run')
            await pg.evaluate("G.slots.debug.refresh()"); await pg.wait_for_timeout(300); s = await st(pg)
            check('conflictFlag', 'changed on another device too' in s['rows'][0]['text'], s['rows'][0])
            await row(pg, 1); await pg.wait_for_timeout(300); s = await st(pg)
            check('keepCard', s['card'] == 'keep' and any('This device' in x and 'Device progress' in x for x in s['buttons']) and any('Your account' in x and 'Account progress' in x for x in s['buttons'])
                  and s['pad'] == 'slKeepBack', dict(buttons=s['buttons'], card=s['card'], mode=s['mode'], note=s['note'], v=await pg.evaluate("G.slots.debug.view(1)")))
            r = await shot(pg, 'keep'); check('keepFitsPhone', fits(r), r)
            await click(pg, '#slKeepBack'); await pg.wait_for_timeout(200)
            check('keepBack', (await st(pg))['card'] == 'list' and fake.slots[aid][1]['objective'] == 'Account progress', 'back to the list, nothing changed')
            await row(pg, 1); await pg.wait_for_timeout(300); n0 = len(fake.log)
            await click(pg, '#slKeepDevice'); await play(pg); s = await st(pg)
            put = fake.reqs('PUT', '/v1/saves/1', since=n0)
            check('keepDevice', s['sess']['slot'] == 1 and not s['sess']['test'] and put and fake.slots[aid][1]['objective'] == 'Device progress' and fake.slots[aid][1]['at'] > acc['at']
                  and 'Device progress' in await pg.evaluate("document.getElementById('obj').textContent"), {'srv': fake.slots[aid][1]['objective'], 'obj': await pg.evaluate("document.getElementById('obj').textContent")})
        await step('slotList', slotList, ('signOutMidGame',))

        async def keepAccount():
            pg = W['pg']; aid = fake.accounts[A]['id']
            await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(1500)
            # slot 2 (the test copy): unsent progress here, a newer copy in the account
            k2 = 'bq-save-s2-' + aid
            loc = await pg.evaluate("(k)=>JSON.parse(localStorage.getItem(k))", k2)
            loc['at'] += 1000; await pg.evaluate("([k,v])=>localStorage.setItem(k,v)", [k2, json.dumps(loc)])
            acc = json.loads(fake.slots[aid][2]['body']); acc['at'] = loc['at'] + 5000; acc['objective'] = 'Account test progress'
            fake.put_slot(A, 2, acc, name=fake.slots[aid][2]['name'], test=True)
            await load(pg, reload=True)
            s = await st(pg)
            check('reloadSignedIn', s['acc'] == 'in' and s['tcont'] and 'Last played: Lantern run' in s['info'], s['info'])
            await click(pg, '#continue'); await settle(pg); s = await st(pg)
            check('lastPlayedMarked', s['rows'][0]['cur'] and 'last played' in s['rows'][0]['text'].lower(), s['rows'][0])
            await row(pg, 2); await pg.wait_for_timeout(300)
            check('keepCard2', (await st(pg))['card'] == 'keep', 'shown')
            await click(pg, '#slKeepAccount'); await play(pg); s = await st(pg)
            cache = await pg.evaluate("(k)=>JSON.parse(localStorage.getItem(k))", k2)
            check('keepAccount', s['sess']['slot'] == 2 and s['sess']['test'] and s['test'] and cache['at'] == acc['at'] and cache['objective'] == 'Account test progress'
                  and 'Account test progress' in await pg.evaluate("document.getElementById('obj').textContent"), s['sess'])
        await step('keepAccount', keepAccount, ('slotList',))

        async def twoAccounts():
            ctx = await context(); pg = await page(ctx)
            # device 1's storage is not shared with a new context, so copy A's cached slots in, then sign in as C
            store = await W['pg'].evaluate("JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])))")
            await ctx.add_init_script("if(!sessionStorage.getItem('copied')){ sessionStorage.setItem('copied','1'); const s=%s; for(const k in s)localStorage.setItem(k,s[k]); }" % store)
            await load(pg); W['pg2'] = pg; W['ctx2'] = ctx
            await signin(ctx, pg, C); s = await st(pg)
            check('otherAccountEmpty', s['acc'] == 'in' and all(not x['used'] for x in s['list']) and not s['tcont'] and s['tbegin'] == 'Begin', [x['used'] for x in s['list']])
            await pg.evaluate("G.account.signOut()"); await pg.wait_for_timeout(500)
            await signin(ctx, pg, A); s = await st(pg)
            check('ownSlotsBack', s['acc'] == 'in' and [x['slot'] for x in s['list'] if x['used']][:2] == [1, 2] and s['tcont'], dict(acc=s['acc'], tcont=s['tcont'], info=s['info'], used=[x['used'] for x in s['list']]))
            await ctx.close()
        await step('twoAccounts', twoAccounts, ('keepAccount',))

        # ---- device 2: a guest save with a sync code ----
        async def claimCode():
            G2 = guest_save('Coded guest game', at=int(time.time() * 1000) - 7200 * 1000)
            fake.guest[CODE] = {'v': 1, 'at': G2['at'], 'objective': G2['objective'], 'save': json.dumps(G2)}
            ctx = await context("localStorage.setItem('bq-save-v1', %s); localStorage.setItem('bq-sync-key','%s');" % (json.dumps(json.dumps(G2)), CODE))
            pg = await page(ctx); await load(pg)
            await signin(ctx, pg, B); await card(pg, 'claim'); s = await st(pg)
            check('claimOfferCode', s['card'] == 'claim' and 'sync code' in await pg.evaluate("document.querySelector('#slotsCard [data-view=claim] .sl-box').innerText"), s['card'])
            await click(pg, '#slClaimGo'); await settle(pg); await pg.wait_for_timeout(800); s = await st(pg)
            bid = fake.accounts[B]['id']; cl = fake.reqs('POST', '/v1/saves/claim')
            check('claimWithCode', cl and cl[-1]['b'] == {'code': CODE} and cl[-1]['cookie'] and CODE not in fake.guest and 1 in fake.slots[bid] and s['code'] is None and s['guest'] is None
                  and s['card'] == 'list' and 'slot 1' in s['note'] and not s['rows'][0]['empty'] and 'Coded guest game' in s['rows'][0]['text'], dict(note=s['note'], code=s['code'], row=s['rows'][0]))
            await ctx.close()
        await step('claimCode', claimCode, ('setup1',))

        # ---- device 3: a guest save, no code; offline first; then a full account and the test tools ----
        async def claimNoCode():
            G3 = guest_save('Local guest game')
            ctx = await context("localStorage.setItem('bq-save-v1', %s);" % json.dumps(json.dumps(G3)))
            pg = await page(ctx); await load(pg); W['pg3'] = pg
            await signin(ctx, pg, D); await card(pg, 'claim')
            fake.down = True
            await click(pg, '#slClaimGo'); await settle(pg); s = await st(pg)
            check('claimOffline', s['card'] == 'claim' and 'Couldn’t reach' in s['note'] and s['guest'], s['note'])
            fake.down = False
            await click(pg, '#slClaimGo'); await settle(pg); s = await st(pg)
            did = fake.accounts[D]['id']; put = fake.reqs('PUT', '/v1/saves/1')
            check('claimNoCode', put and put[-1]['b']['objective'] == 'Local guest game' and fake.slots[did][1]['at'] == G3['at'] and s['guest'] is None and s['card'] == 'list', s['note'])
            for n in range(2, 11): fake.put_slot(D, n, guest_save('Full %d' % n))
            await click(pg, '#slotsBack'); await pg.wait_for_timeout(200)
            await click(pg, '#continue'); await settle(pg)
            await row(pg, 1); await play(pg); n0 = len(fake.log)
            await pg.evaluate("G.testSaves=true"); await pg.wait_for_timeout(1200)
            await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(1500); s = await st(pg)
            check('noFreeLocalTest', s['sess']['local'] and s['key'] == 'bq-save-test-v1' and 'No free save slot' in s['toast'] and not fake.reqs('PUT', since=n0)
                  and await pg.evaluate("!!localStorage.getItem('bq-save-test-v1')"), dict(sess=s['sess'], toast=s['toast']))
        await step('claimNoCode', claimNoCode, ('setup1',))

        for pg in [W.get('pg'), W.get('pg3')]:
            if pg and pg.errs: check('noPageErrors', False, pg.errs[:5])
        check('noUnknownRequests', not fake.other, fake.other[:10])
        await b.close()
    print('\n%d failed%s' % (len(fails), (': ' + ', '.join(fails)) if fails else ''))
    if skipped: print('skipped: ' + ', '.join(skipped))
    sys.exit(1 if fails else 0)

if __name__ == "__main__": asyncio.run(main())
