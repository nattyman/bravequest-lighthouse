# The Keepers' Board (js/board.js) in a build with Keeper Accounts on (js/account.js), against a fake of the save service's
# record, board and account routes answered here in Python through Playwright's request routing. Spec: ACCOUNTS.md (6d).
# Like test/account_e2e.py, the page is served under https://game.bq.test (files from the local server in the URL given) and
# the fake service is https://api.bq.test: two origins on one site, so the session cookie really travels.
# The build without accounts is test/board_e2e.py (unchanged: G.account.fetch is then a plain call with the sync code).
# Usage: python3 test/board_account_e2e.py "http://localhost:PORT/dev.html?headless"
# Screenshots go to $SHOTS (default /tmp/claude-0/a9).
import asyncio, json, os, re, secrets, sys, time
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8829/dev.html?headless"
U = urlparse(URL); BASE = U.scheme + '://' + U.netloc
GAME = 'https://game.bq.test'; API = 'https://api.bq.test'
PAGE = GAME + U.path + ('?' + U.query if U.query else '')
CFG = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false,accounts:true};window.BQ_ACCOUNTS_TEST=true;" % API
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/a9')
BUDGET = 300
NAME_RE = re.compile(r"^[A-Za-z0-9 _'\-]{3,16}$")
GUEST = 'ABCD1234EFGH'

class Fake:
    """records and boards for guests (Bearer sync code) and accounts (session cookie), the account's /v1/me, sign-out"""
    def __init__(self):
        self.log = []; self.other = []; self.sessions = {}; self.saves = {}; self.records = {}
        self.account = {'id': 'acc1', 'email': 'keeper@example.com', 'name': '', 'role': 'player', 'tools': []}
        self.slots = True   # the account has a save slot that is not a test save
        self.off = False    # the service has accounts switched off: account paths answer 503 accounts_off
        self.seed = [{'name': 'Keeper %02d' % i, 'act1': 1000 + i * 100} for i in range(5)] + [{'name': 'Taken Name', 'act1': 900}]
    def reqs(self, method=None, path=None): return [r for r in self.log if (method is None or r['m'] == method) and (path is None or r['p'] == path)]
    def new_session(self): t = secrets.token_urlsafe(24); self.sessions[t] = True; return t
    def taken(self, owner, n):
        low = n.lower()
        return any(s['name'].lower() == low for s in self.seed) or any(k != owner and r.get('name', '').lower() == low for k, r in self.records.items())
    async def handle(self, route):
        rq = route.request; u = urlparse(rq.url); path = u.path; q = parse_qs(u.query)
        h = await rq.all_headers(); origin = h.get('origin', '')
        cors = {'Access-Control-Allow-Origin': origin or GAME, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-BQ-Client', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
                'Access-Control-Expose-Headers': 'Retry-After', 'Cache-Control': 'no-store'}
        async def send(status, body=None, extra=None):
            hh = dict(cors, **{'Content-Type': 'application/json'}); hh.update(extra or {})
            await route.fulfill(status=status, headers=hh, body=json.dumps(body) if body is not None else '')
        cookie = dict(x.strip().split('=', 1) for x in (h.get('cookie') or '').split(';') if '=' in x)
        body = None
        try: body = json.loads(rq.post_data) if rq.post_data else None
        except Exception: body = None
        sess = cookie.get('bq_s') in self.sessions
        bearer = (h.get('authorization') or '').replace('Bearer ', '').upper()
        if rq.method != 'OPTIONS':
            self.log.append({'m': rq.method, 'p': path, 'q': {k: v[0] for k, v in q.items()}, 'b': body, 't': time.time(), 'cookie': sess, 'auth': bearer, 'x': h.get('x-bq-client')})
        if rq.method == 'OPTIONS': return await send(204)
        if sess and rq.method not in ('GET', 'HEAD') and (h.get('x-bq-client') != '1' or origin != GAME): return await send(403, {'error': 'bad_origin'})
        if self.off and (path == '/v1/me' or path.startswith('/v1/auth') or path.startswith('/v1/saves')): return await send(503, {'error': 'accounts_off'})
        A = self.account
        owner = 'a:' + A['id'] if sess else (bearer or None)
        if path == '/v1/me':
            if not sess: return await send(401, {'error': 'signed_out'})
            me = dict(A, hasPassword=False, created=0)
            if rq.method == 'GET': return await send(200, me)
            if rq.method == 'PUT' and 'name' in (body or {}):
                n = re.sub(r'\s+', ' ', str(body['name']).strip())
                if n and self.taken(owner, n): return await send(409, {'error': 'name_taken'})
                A['name'] = n
                if owner in self.records: self.records[owner]['name'] = n
                return await send(200, {'ok': True, 'me': dict(A, hasPassword=False, created=0)})
        if path == '/v1/auth/signout' and rq.method == 'POST':
            self.sessions.pop(cookie.get('bq_s'), None)
            return await send(200, {'ok': True}, {'Set-Cookie': 'bq_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'})
        if path == '/v1/save' and rq.method == 'GET': return await send(404, {'error': 'no_save'})
        if path == '/v1/event' and rq.method == 'POST': return await send(204)
        if path == '/v1/record' and rq.method == 'PUT':
            if not owner: return await send(401, {'error': 'bad_key'})
            b = body or {}
            if b.get('test') is True and sess: return await send(400, {'error': 'bad_request'})
            if sess and not self.slots: return await send(404, {'error': 'no_save'})
            if not sess and owner not in self.saves: return await send(404, {'error': 'no_save'})
            rec = dict(self.records.get(owner, {'name': A['name'] if sess else '', 'crew': ''}))
            if b.get('name') is not None:
                n = re.sub(r'\s+', ' ', str(b['name']).strip())
                if not sess and n and n.lower() != rec.get('name', '').lower(): return await send(403, {'error': 'account_needed'})
                if n:
                    if not NAME_RE.match(n): return await send(400, {'error': 'name_invalid'})
                    if self.taken(owner, n): return await send(409, {'error': 'name_taken'})
                rec['name'] = n
                if sess: A['name'] = n
            if b.get('crew') is not None: rec['crew'] = str(b['crew']).upper()
            for k in ('play', 'splits', 'pct', 'deaths', 'badges', 'rank'): rec[k] = b.get(k)
            self.records[owner] = rec
            return await send(200, {'ok': True, 'name': rec['name']})
        if path == '/v1/record' and rq.method == 'GET':
            r = self.records.get(owner)
            if sess and r: r = dict(r, name=A['name'])
            return await send(200, r) if r else await send(404, {'error': 'no_record'})
        if path == '/v1/board' and rq.method == 'GET':
            ent = [{'k': None, 'name': s['name'], 'value': s['act1']} for s in self.seed]
            for k, r in self.records.items():
                v = (r.get('splits') or {}).get('gloaming')
                if v is not None: ent.append({'k': k, 'name': r.get('name', ''), 'value': v})
            ent.sort(key=lambda e: e['value']); rows = []; pos = 0; you = None
            for e in ent:
                listed = bool(e['name'])
                if listed: pos += 1; rows.append({'pos': pos, 'name': e['name'], 'value': e['value'], 'rank': 0, 'badges': 1})
                if owner and e['k'] == owner: you = {'pos': pos if listed else None, 'value': e['value']}
            out = {'b': q.get('b', ['act1'])[0], 'crew': '', 'rows': rows}
            if owner: out['you'] = you
            return await send(200, out)
        if path == '/v1/saves' and rq.method == 'GET':   # slots.js reads the slot list when an account signs in
            if not sess: return await send(401, {'error': 'signed_out'})
            return await send(200, {'max': 10, 'slots': []})
        self.other.append(rq.method + ' ' + path); await send(404, {'error': 'not_found'})

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    fails = []; skipped = []
    def check(name, ok, info):
        print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info, default=str)[:600])
        if not ok: fails.append(name)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        fake = Fake(); pages = []
        async def game(route):
            u = urlparse(route.request.url)
            try:
                r = await route.fetch(url=BASE + u.path + ('?' + u.query if u.query else '')); await route.fulfill(response=r)
            except Exception:
                try: await route.abort()
                except Exception: pass
        async def device(pre='', w=1100, h=700):
            ctx = await b.new_context(viewport={'width': w, 'height': h})
            await ctx.add_init_script(CFG + pre)
            await ctx.route(GAME + '/**', game); await ctx.route(API + '/**', fake.handle)
            pg = await ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e))); pages.append(pg)
            pg.set_default_navigation_timeout(180000); pg.set_default_timeout(90000)
            await pg.goto(PAGE, wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled", timeout=180000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(500)
            return ctx, pg
        async def step(name, fn, needs=()):
            if any(d in fails or d in skipped for d in needs):
                print('SKIP ' + name + ' : needs ' + ', '.join(needs)); skipped.append(name); return
            n0 = len(fails)
            try: await asyncio.wait_for(fn(), BUDGET)
            except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})
            if len(fails) > n0 and name not in fails: fails.append(name)
        CARD = """() => { const c=document.getElementById('boardCard'); if(!c)return {open:false};
            const vis=e=>!!e&&!e.hidden&&e.getClientRects().length>0;
            return {open:!c.hidden, buttons:[...c.querySelectorAll('button')].filter(vis).map(x=>x.textContent), note:c.querySelector('.savenote').textContent,
              text:[...c.querySelectorAll('p,li')].filter(vis).map(x=>x.textContent).join(' | '), input:vis(c.querySelector('[data-view=join] input')),
              who:(c.querySelector('.kb-who-line')||{}).textContent, me:[...c.querySelectorAll('.kb-row.me')].map(r=>r.querySelector('.kb-name b').textContent),
              state:G.board.state, acct:G.account.state, name:G.account.me&&G.account.me.name, acView:G.account.debug.view,
              focus:document.activeElement&&document.activeElement.id}; }"""
        async def settle(pg):
            await pg.wait_for_function("document.querySelector('#boardCard .savenote').textContent!=='One moment…'&&!/Fetching/.test(document.querySelector('#boardCard [data-view=board] [role=status]').textContent)", timeout=60000, polling=200)
            await pg.wait_for_timeout(300)
        async def click(pg, text):
            await pg.evaluate("t => { const b=[...document.querySelectorAll('#boardCard button')].find(x=>x.textContent===t&&!x.hidden&&x.getClientRects().length); if(!b)throw new Error('no button '+t); b.click(); }", text)
        async def shots(pg, name):
            await pg.screenshot(path=SHOTS + '/' + name + '_desktop.png')
            await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(500)
            await pg.screenshot(path=SHOTS + '/' + name + '_phone.png')
            r = await pg.evaluate("() => { const s=document.querySelector('#boardCard .sheet'); return {sw:s.scrollWidth, cw:s.clientWidth, doc:document.documentElement.scrollWidth}; }")
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(300)
            return r['sw'] <= r['cw'] + 1 and r['doc'] <= 391
        async def signIn(pg, ctx):
            tok = fake.new_session()
            await ctx.add_cookies([{'name': 'bq_s', 'value': tok, 'domain': 'api.bq.test', 'path': '/', 'httpOnly': True, 'secure': True, 'sameSite': 'Lax'}])
            await pg.evaluate("G.account.refresh()")

        # ---- a guest with no keeper name, then signing in from the board ----
        ctx, pg = await device()
        async def guestNoName():
            await pg.click('#title [data-board-link]'); await settle(pg)
            c = await card(pg)
            check('guestNeedsAccount', c['open'] and c['acct'] == 'out' and c['state']['needsAccount'] and 'A keeper name needs an account' in c['text']
                  and 'Sign in' in c['buttons'] and 'Not now' in c['buttons'] and not c['input'] and 'Turn on sync and join' not in c['buttons']
                  and 'Join the board' not in c['buttons'] and 'needs sync' not in c['text'] and 'With sync on' not in c['text'] and c['focus'] == 'boardSignIn', c)
            check('guestNameFits', await shots(pg, 'board_guest_needs_account'), '')
            await click(pg, 'Sign in'); await pg.wait_for_timeout(400)
            c = await card(pg)
            check('signInOpensAccount', not c['open'] and c['acView'] == 'email', c)
            await pg.evaluate("G.account.close()"); await pg.wait_for_timeout(400)
            c = await card(pg)
            check('accountCardBackToBoard', c['open'] and c['acView'] == '' and 'Sign in' in c['buttons'], c)
            await click(pg, 'Not now'); await settle(pg); c = await card(pg)
            check('guestBoardView', c['state']['view'] == 'board' and 'a keeper name needs an account' in c['who'] and 'Join the board' in c['buttons'] and not c['me'], c)
            await click(pg, 'Join the board'); await pg.wait_for_timeout(300); c = await card(pg)
            check('guestJoinAsksAccount', 'Sign in' in c['buttons'] and not c['input'], c['buttons'])
        async def card(pg): return await pg.evaluate(CARD)
        await step('guestNoName', guestNoName)

        async def signInRefresh():
            n0 = len(fake.log)
            await signIn(pg, ctx)
            await pg.wait_for_function("G.account.state==='in'", timeout=60000); await pg.wait_for_timeout(800)
            c = await card(pg)
            check('signInRefreshesJoin', c['open'] and c['state']['signedIn'] and c['input'] and 'Join the board' in c['buttons'] and 'Sign in' not in c['buttons']
                  and 'Turn on sync and join' not in c['buttons'] and 'account’s keeper name' in c['text'], c)
            await pg.fill('#boardCard [data-view=join] input', 'Taken Name'); await click(pg, 'Join the board'); await settle(pg); c = await card(pg)
            check('signedInTaken', 'taken' in c['note'] and fake.account['name'] == '', c['note'])
            await pg.evaluate("G.record.debug.addPlay(5000); G.record.debug.reach('gloaming',4000)")
            await pg.fill('#boardCard [data-view=join] input', ' Fog  Walker'); await click(pg, 'Join the board'); await settle(pg)
            await pg.wait_for_function("G.account.me&&G.account.me.name==='Fog Walker'", timeout=30000)
            c = await card(pg)
            puts = [x for x in fake.reqs('PUT', '/v1/record')[0:] if x['b'] and x['b'].get('name') == 'Fog Walker']
            key = await pg.evaluate("localStorage.getItem('bq-sync-key')")
            check('signedInJoin', c['state']['name'] == 'Fog Walker' and c['name'] == 'Fog Walker' and fake.account['name'] == 'Fog Walker' and 'Welcome to the board, Fog Walker' in c['note']
                  and c['state']['view'] == 'board' and len(puts) == 1 and puts[0]['cookie'] and not puts[0]['auth'] and puts[0]['x'] == '1' and not key
                  and not fake.reqs('PUT', '/v1/save') and fake.reqs('GET', '/v1/me')[-1]['t'] > puts[0]['t'], dict(c, key=key, puts=len(puts)))
            check('signedInMeRow', c['me'] == ['Fog Walker'] and 'on the board as Fog Walker' in c['who'], {'me': c['me'], 'who': c['who']})
            check('signedInBoardFits', await shots(pg, 'board_signed_in'), '')
        await step('signInRefresh', signInRefresh, ('guestNoName',))

        async def uploads():
            await pg.evaluate("G.board.debug.gap(0)")
            n0 = len(fake.reqs('PUT', '/v1/record'))
            ok = await pg.evaluate("G.board.push()")
            new = fake.reqs('PUT', '/v1/record')[n0:]
            check('uploadCookieNoBearer', ok and len(new) == 1 and new[0]['cookie'] and not new[0]['auth'] and new[0]['x'] == '1' and 'name' not in new[0]['b'] and 'test' not in new[0]['b'], new)
            # a test slot active: nothing goes up; a name change says why
            await pg.evaluate("window.__slot={slot:2,test:true,name:'Save 2'}; G.slots={active:()=>window.__slot}")
            n0 = len(fake.reqs('PUT', '/v1/record'))
            r = await pg.evaluate("async () => { G.record.debug.reach('lantern',700); await new Promise(r=>setTimeout(r,800)); return {ok:await G.board.push(), s:G.board.state, can:G.board.debug.canUpload()}; }")
            await pg.wait_for_timeout(500)
            check('noUploadFromTestSlot', r['ok'] is False and r['s']['testSlot'] and not r['can'] and len(fake.reqs('PUT', '/v1/record')) == n0, r)
            await click(pg, 'Change name'); await pg.wait_for_timeout(200)
            await pg.fill('#boardCard [data-view=join] input', 'Other Name'); await click(pg, 'Save name'); await settle(pg); c = await card(pg)
            check('testSlotNameChangeRefused', 'test save' in c['note'] and len(fake.reqs('PUT', '/v1/record')) == n0 and fake.account['name'] == 'Fog Walker', c['note'])
            await click(pg, 'Back'); await settle(pg)
            # back on a real slot: the waiting upload goes
            await pg.evaluate("window.__slot={slot:1,test:false,name:'Save 1'}; G.emit('slots:active',window.__slot)")
            for _ in range(40):
                if len(fake.reqs('PUT', '/v1/record')) > n0: break
                await pg.wait_for_timeout(250)
            new = fake.reqs('PUT', '/v1/record')[n0:]
            check('uploadAfterRealSlot', len(new) == 1 and new[0]['b']['splits'].get('lantern') == 700 and new[0]['cookie'], [x['b'].get('splits') for x in new])
            # no non-test slot on the service: 404 no_save waits for the next slot upload
            fake.slots = False; n0 = len(fake.reqs('PUT', '/v1/record'))
            await pg.evaluate("G.record.debug.reach('staff',800); G.board.push()")
            await pg.wait_for_function("G.board.state.waitSave", timeout=30000, polling=200)
            fake.slots = True
            await pg.evaluate("G.emit('cloud:saved',{at:Date.now()})")
            for _ in range(40):
                if fake.records.get('a:acc1', {}).get('splits', {}).get('staff') == 800: break
                await pg.wait_for_timeout(250)
            try: await pg.wait_for_function("G.board.state.last&&G.board.state.last.status===200", timeout=30000, polling=200)
            except Exception: pass
            s = await pg.evaluate("G.board.state")
            check('noSaveWaitsForSlot', fake.records['a:acc1']['splits'].get('staff') == 800 and not s['waitSave'] and len(fake.reqs('PUT', '/v1/record')) - n0 == 2, {k: s[k] for k in ('waitSave', 'last', 'dirty')})
            await pg.evaluate("delete G.slots")
        await step('uploads', uploads, ('signInRefresh',))

        async def accountRename():
            st = await pg.evaluate("async () => { await G.account.fetch('/v1/me',{method:'PUT',body:{name:'Lamp Keeper'}}); await G.account.refresh(); await new Promise(r=>setTimeout(r,1200)); return G.board.state; }")
            await settle(pg); c = await card(pg)
            check('accountRenameReachesBoard', st['name'] == 'Lamp Keeper' and 'Lamp Keeper' in c['who'] and c['me'] == ['Lamp Keeper'], {'state': st['name'], 'who': c['who'], 'me': c['me']})
        await step('accountRename', accountRename, ('signInRefresh',))

        async def signOutRefresh():
            await pg.evaluate("G.account.signOut()")
            await pg.wait_for_function("G.account.state==='out'", timeout=30000); await pg.wait_for_timeout(1200); await settle(pg)
            c = await card(pg); last = fake.reqs('GET', '/v1/board')[-1]
            check('signOutRefreshes', c['open'] and not c['state']['signedIn'] and not c['state']['name'] and not c['me'] and 'a keeper name needs an account' in c['who']
                  and not last['cookie'] and 'Lamp Keeper' not in c['who'], dict(c, last=last))
            await signIn(pg, ctx)
            await pg.wait_for_function("G.account.state==='in'", timeout=30000); await pg.wait_for_timeout(1200); await settle(pg)
            c = await card(pg)
            check('signInAgainRefreshes', c['state']['name'] == 'Lamp Keeper' and c['me'] == ['Lamp Keeper'] and fake.reqs('GET', '/v1/board')[-1]['cookie'], {'who': c['who'], 'me': c['me']})
        await step('signOutRefresh', signOutRefresh, ('signInRefresh',))
        await ctx.close()

        # ---- a guest who already has a keeper name: the board as before; a NEW name gets account_needed ----
        async def guestWithName():
            fake.saves[GUEST] = True
            fake.records[GUEST] = {'name': 'Old Name', 'crew': '', 'splits': {'gloaming': 3000}}
            c2, p2 = await device(pre="try{ if(!sessionStorage.getItem('pre')){ localStorage.setItem('bq-sync-key','%s'); sessionStorage.setItem('pre','1'); } }catch(_){}" % GUEST)
            await p2.click('#title [data-board-link]'); await settle(p2); c = await card(p2)
            check('guestWithNameAsToday', c['state']['view'] == 'board' and 'on the board as Old Name' in c['who'] and c['me'] == ['Old Name'] and 'Change name' in c['buttons']
                  and not c['state']['needsAccount'] and fake.reqs('GET', '/v1/record')[-1]['auth'] == GUEST and not fake.reqs('GET', '/v1/record')[-1]['cookie'], c)
            n0 = len(fake.reqs('PUT', '/v1/record'))
            await click(p2, 'Change name'); await p2.wait_for_timeout(200)
            c = await card(p2)
            check('guestChangeNameForm', c['input'] and 'Save name' in c['buttons'] and 'Leave the board' in c['buttons'] and 'Sign in' not in c['buttons'], c['buttons'])
            await p2.fill('#boardCard [data-view=join] input', 'New Name'); await click(p2, 'Save name'); await settle(p2); c = await card(p2)
            put = fake.reqs('PUT', '/v1/record')[n0:]
            check('accountNeededHandled', len(put) == 1 and put[0]['b'].get('name') == 'New Name' and put[0]['auth'] == GUEST and fake.records[GUEST]['name'] == 'Old Name'
                  and 'needs an account' in c['note'] and 'Sign in' in c['buttons'] and c['focus'] == 'boardSignIn' and c['state']['name'] == 'Old Name' and not c['state']['bad']
                  and 'are sent with your name' not in c['text'], c)
            await shots(p2, 'board_guest_account_needed')
            await click(p2, 'Leave the board'); await settle(p2); c = await card(p2)
            check('guestMayLeave', fake.records[GUEST]['name'] == '' and not c['state']['name'] and 'left the board' in c['note'], c['note'])
            await c2.close()
        await step('guestWithName', guestWithName)

        # ---- the service has accounts switched off (a build with accounts): the board is the board of a build without them ----
        async def accountsOff():
            fake.off = True
            c3, p3 = await device()
            links = await p3.evaluate("[...document.querySelectorAll('#title .bq-links button')].filter(b=>!b.hidden&&b.getClientRects().length).map(b=>b.textContent)")
            await p3.click('#title [data-board-link]'); await settle(p3); c = await card(p3)
            check('accountsOffBoardAsGuest', 'Sign in' not in links and not c['state']['needsAccount'] and 'Sign in' not in c['buttons'] and 'needs an account' not in c['text']
                  and 'Turn on sync and join' in c['buttons'] and c['input'], dict(c, links=links))
            # such a service refuses the account header and credentials on its guest routes (CORS): the board's calls are plain ones
            n0 = len(fake.reqs('GET', '/v1/board'))
            await click(p3, 'Not now'); await settle(p3)
            bq = fake.reqs('GET', '/v1/board')[n0:]
            check('accountsOffPlainCalls', bq and bq[-1]['x'] is None and not bq[-1]['cookie'], bq[-1:])
            fake.off = False
            await c3.close()
        await step('accountsOff', accountsOff)

        errs = [e for q in pages for e in q.errs]
        check('onlyKnownEndpoints', not fake.other, fake.other[:5])
        check('noPageErrors', not errs, errs[:3])
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)) + (' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''))
    sys.exit(1 if fails else 0)
asyncio.run(main())
