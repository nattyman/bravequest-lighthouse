# Keeper Accounts in the game (js/account.js) against a fake of the save service's sign-in and account routes, answered
# here in Python through Playwright's request routing. Spec: ACCOUNTS.md (sections 1, 3 and 6a).
# The page is served under https://game.bq.test (its files come from the local server in the URL given) and the fake
# service is https://api.bq.test: two origins on one site, as the real game and service are, so the session cookie
# (HttpOnly, Secure, SameSite=Lax) is set by the fake's answers and really travels with credentials:'include'.
# Usage: python3 test/account_e2e.py "http://localhost:PORT/dev.html?headless"
# Screenshots go to $SHOTS (default /tmp/claude-0/a4).
import asyncio, json, os, re, secrets, sys, time
from urllib.parse import urlparse
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8824/dev.html?headless"
U = urlparse(URL); BASE = U.scheme + '://' + U.netloc
GAME = 'https://game.bq.test'; API = 'https://api.bq.test'
PAGE = GAME + U.path + ('?' + U.query if U.query else '')
CFG = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false,accounts:true};window.BQ_ACCOUNTS_TEST=true;" % API
CFG_NOACC = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false};" % API
CFG_NOOPT = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false,accounts:true};" % API
EVENTS = """window.__acEv=[]; (function hook(){ if(window.G&&G.on){ ['account:in','account:out','account:me'].forEach(n=>G.on(n,d=>__acEv.push({n,fresh:d&&d.fresh,
  name:d&&d.me?d.me.name:null,email:d&&d.me?d.me.email:null}))); } else setTimeout(hook,5); })();"""
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/a4')
BUDGET = 300  # seconds a single check may take before the rest are skipped
NAME_RE = re.compile(r"^[A-Za-z0-9 _'\-]{3,16}$")
SYNC = 'ABCD1234EFGH'

class Fake:
    """the contract's sign-in and account routes, with a real session cookie"""
    def __init__(self):
        self.accounts = {}; self.sessions = {}; self.chal = {}; self.log = []; self.other = []
        self.down = False; self.rate = {}; self.fresh_secs = 900
    def reqs(self, method=None, path=None): return [r for r in self.log if (method is None or r['m'] == method) and (path is None or r['p'] == path)]
    def new_chal(self, email, expired=False):
        cid = secrets.token_hex(8); code = '%06d' % secrets.randbelow(1000000); link = secrets.token_urlsafe(24)
        if code == '000000': code = '000001'
        self.chal[cid] = {'email': email, 'code': code, 'link': link, 'tries': 0, 'exp': time.time() + (-1 if expired else 900), 'used': False}
        return cid
    def last(self, email): return [c for c in self.chal.values() if c['email'] == email][-1]
    def me(self, a): return {'id': a['id'], 'email': a['email'], 'name': a['name'], 'role': a['role'], 'tools': a['tools'], 'hasPassword': bool(a['password']), 'created': '2026-11-19T10:00:00Z'}
    def account_for(self, email):
        if email not in self.accounts:
            self.accounts[email] = {'id': secrets.token_hex(8), 'email': email, 'name': '', 'role': 'player', 'tools': [], 'password': None}
        return self.accounts[email]
    def session(self, a):
        tok = secrets.token_urlsafe(32); self.sessions[tok] = {'email': a['email'], 'created': time.time()}; return tok
    async def handle(self, route):
        rq = route.request; u = urlparse(rq.url); path = u.path
        h = await rq.all_headers()
        origin = h.get('origin', '')
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
        if rq.method != 'OPTIONS':
            self.log.append({'m': rq.method, 'p': path, 'b': body, 't': time.time(), 'cookie': 'bq_s' in cookie, 'x': h.get('x-bq-client'),
                             'auth': h.get('authorization') or '', 'origin': origin})
        if self.down: return await route.abort()
        if rq.method == 'OPTIONS': return await send(204)
        SET = lambda tok: {'Set-Cookie': 'bq_s=' + tok + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=5184000'}
        CLEAR = {'Set-Cookie': 'bq_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'}
        sess = self.sessions.get(cookie.get('bq_s', ''))
        acct = self.accounts.get(sess['email']) if sess else None
        if sess and not acct: sess = None
        writes = rq.method not in ('GET', 'HEAD')
        if path.startswith('/v1/auth/') or (writes and sess and path.startswith('/v1/')):
            if h.get('x-bq-client') != '1' or origin != GAME: return await send(403, {'error': 'bad_origin'})
        rl = self.rate.pop(path, 0)
        if rl: return await send(429, {'error': 'rate_limited'}, {'Retry-After': str(rl)})
        if path == '/v1/auth/start' and rq.method == 'POST':
            em = str((body or {}).get('email', '')).strip().lower()
            if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', em): return await send(400, {'error': 'bad_email'})
            return await send(200, {'ok': True, 'id': self.new_chal(em)})
        if path == '/v1/auth/code' and rq.method == 'POST':
            c = self.chal.get(str((body or {}).get('id', '')))
            if not c or c['used'] or c['exp'] < time.time() or c['tries'] >= 5: return await send(410, {'error': 'expired'})
            if str(body.get('code')) != c['code']:
                c['tries'] += 1
                if c['tries'] >= 5: return await send(410, {'error': 'expired'})
                return await send(400, {'error': 'bad_code', 'left': 5 - c['tries']})
            c['used'] = True; a = self.account_for(c['email'])
            return await send(200, {'ok': True, 'me': self.me(a)}, SET(self.session(a)))
        if path == '/v1/auth/link' and rq.method == 'POST':
            t = str((body or {}).get('token', ''))
            c = next((x for x in self.chal.values() if x['link'] == t), None)
            if not c or c['used'] or c['exp'] < time.time(): return await send(410, {'error': 'expired'})
            c['used'] = True; a = self.account_for(c['email'])
            return await send(200, {'ok': True, 'me': self.me(a)}, SET(self.session(a)))
        if path == '/v1/auth/password' and rq.method == 'POST':
            em = str((body or {}).get('email', '')).strip().lower(); a = self.accounts.get(em)
            if not a or not a['password'] or a['password'] != (body or {}).get('password'): return await send(401, {'error': 'bad_login'})
            return await send(200, {'ok': True, 'me': self.me(a)}, SET(self.session(a)))
        if path == '/v1/auth/signout' and rq.method == 'POST':
            if sess:
                if (body or {}).get('everywhere'):
                    for k in [k for k, v in self.sessions.items() if v['email'] == sess['email']]: del self.sessions[k]
                else: self.sessions.pop(cookie.get('bq_s'), None)
            return await send(200, {'ok': True}, CLEAR)
        if path == '/v1/me':
            if not sess: return await send(401, {'error': 'signed_out'})
            if rq.method == 'GET': return await send(200, self.me(acct))
            fresh = time.time() - sess['created'] <= self.fresh_secs
            if rq.method == 'PUT':
                b = body or {}
                if 'name' in b:
                    n = re.sub(r'\s+', ' ', str(b['name']).strip())
                    if n and (not NAME_RE.match(n) or 'badword' in n.lower()): return await send(400, {'error': 'name_invalid'})
                    if n.lower() == 'taken name' or any(x is not acct and x['name'].lower() == n.lower() for x in self.accounts.values() if n): return await send(409, {'error': 'name_taken'})
                    acct['name'] = n
                if 'password' in b:
                    p = b['password'] or {}; new = str(p.get('new', ''))
                    if len(new) < 10 or new in ('password123', '1234567890'): return await send(400, {'error': 'weak_password'})
                    if acct['password']:
                        if p.get('current') != acct['password']: return await send(401, {'error': 'bad_login'})
                    elif not fresh: return await send(403, {'error': 'reauth'})
                    acct['password'] = new
                    for k in [k for k, v in self.sessions.items() if v['email'] == acct['email'] and k != cookie.get('bq_s')]: del self.sessions[k]
                return await send(200, {'ok': True, 'me': self.me(acct)})
            if rq.method == 'DELETE':
                if not fresh: return await send(403, {'error': 'reauth'})
                del self.accounts[acct['email']]
                for k in [k for k, v in self.sessions.items() if v['email'] == acct['email']]: del self.sessions[k]
                return await send(200, {'ok': True}, CLEAR)
        if path == '/v1/echo': return await send(200, {'ok': True})
        # the guest routes the rest of the beta calls (cloud.js, beta.js, board.js): accepted so they are not "unknown" traffic
        if path == '/v1/save' and rq.method == 'GET': return await send(404, {'error': 'no_save'})
        if path == '/v1/event' and rq.method == 'POST': return await send(204)
        if path == '/v1/record': return await send(404, {'error': 'no_save'})
        if path == '/v1/saves' and rq.method == 'GET': return await send(200 if sess else 401, {'max': 10, 'slots': []} if sess else {'error': 'signed_out'})   # slots.js reads the list on sign-in
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
        async def game(route):   # the game's files, from the local server, under the game's own https address
            u = urlparse(route.request.url)
            try:
                r = await route.fetch(url=BASE + u.path + ('?' + u.query if u.query else ''))
                await route.fulfill(response=r)
            except Exception:
                try: await route.abort()
                except Exception: pass
        async def device(url=PAGE, cfg=CFG, w=1100, h=700, ctx=None):
            if ctx is None:
                ctx = await b.new_context(viewport={'width': w, 'height': h})
                if cfg: await ctx.add_init_script(cfg)
                await ctx.add_init_script(EVENTS)
                await ctx.route(GAME + '/**', game)
                await ctx.route(API + '/**', fake.handle)
            pg = await ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e))); pages.append(pg)
            pg.set_default_navigation_timeout(180000); pg.set_default_timeout(90000)
            await pg.goto(url, wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled", timeout=180000)
            await pg.evaluate("G.account&&G.account.ready")
            await pg.wait_for_timeout(500)
            return ctx, pg
        DEPENDS = {}
        ONLY = [x for x in os.environ.get('ONLY', '').split(',') if x]
        async def step(name, fn, needs=()):
            if ONLY and name not in ONLY:
                print('SKIP ' + name + ' : not in ONLY'); return
            if any(d in fails or d in skipped for d in needs):
                print('SKIP ' + name + ' : needs ' + ', '.join(needs)); skipped.append(name); return
            n0 = len(fails)
            try: await asyncio.wait_for(fn(), BUDGET)
            except Exception as e: check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:300]})
            if len(fails) > n0 and name not in fails: fails.append(name)
        CARD = """() => { const c=document.getElementById('accountCard'); if(!c)return {open:false,exists:false,state:G.account.state,me:G.account.me,ev:window.__acEv.slice(),
              links:[...document.querySelectorAll('[data-account-link]')].map(x=>x.textContent+(x.hidden?' (hidden)':''))};
            const vis=e=>!!e&&!e.hidden&&e.getClientRects().length>0;
            const v=c.querySelector('[data-view]:not([hidden])');
            return {open:!c.hidden, exists:true, view:v?v.dataset.view:'', title:c.querySelector('h2').textContent, note:c.querySelector('.savenote').textContent,
              bad:c.querySelector('.savenote').classList.contains('bad'),
              buttons:[...c.querySelectorAll('button')].filter(vis).map(x=>(x.childNodes[0]&&x.childNodes[0].nodeType===3?x.childNodes[0].textContent:x.textContent)),
              disabled:[...c.querySelectorAll('button')].filter(x=>vis(x)&&x.disabled).map(x=>x.textContent),
              tags:[...c.querySelectorAll('.ac-last')].filter(vis).map(t=>t.parentNode.id),
              text:[...c.querySelectorAll('p,small,b')].filter(vis).map(x=>x.textContent).join(' | '),
              state:G.account.state, me:G.account.me, pad:c.dataset.padBack, title_shown:!document.getElementById('title').hidden,
              pause_shown:!document.getElementById('pause').hidden, mode:G.state.mode, focus:document.activeElement&&(document.activeElement.id||document.activeElement.name||document.activeElement.textContent),
              ev:window.__acEv.slice(), links:[...document.querySelectorAll('[data-account-link]')].map(x=>x.textContent+(x.hidden?' (hidden)':'')) }; }"""
        async def card(): return await pg.evaluate(CARD)
        async def click(sel):
            await pg.evaluate("s => { const b=document.querySelector(s); if(!b||b.hidden||!b.getClientRects().length)throw new Error('not shown '+s); b.click(); }", sel)
        async def settle():
            await pg.wait_for_function("document.querySelector('#accountCard .savenote').textContent!=='One moment…'", timeout=60000, polling=100)
            await pg.wait_for_timeout(150)
        async def fill(sel, v): await pg.fill('#accountCard ' + sel, v)
        async def shot(name, w=1100, h=700):
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(250)
            await pg.screenshot(path=SHOTS + '/' + name + '_desktop.png')
            await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(400)
            await pg.screenshot(path=SHOTS + '/' + name + '_phone.png')
            r = await pg.evaluate("() => { const s=document.querySelector('#accountCard .sheet'); return {sw:s.scrollWidth, cw:s.clientWidth, doc:document.documentElement.scrollWidth}; }")
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(250)
            return r
        fits = lambda r: r['sw'] <= r['cw'] + 1 and r['doc'] <= 391
        EMAIL = 'keeper@example.com'
        ROW = ['Sync devices', 'Send feedback', 'Keepers’ Board']

        # ---- off: no accounts flag, and the flag without the test opt-in under ?headless ----
        async def noFlag():
            n0 = len(fake.log)
            for cfg, label in ((CFG_NOACC, 'noFlag'), (CFG_NOOPT, 'headlessQuiet')):
                c2, p2 = await device(cfg=cfg)
                r = await p2.evaluate("""() => ({on:G.account.on, state:G.account.state, link:!!document.querySelector('[data-account-link]'), card:!!document.getElementById('accountCard'),
                    style:[...document.querySelectorAll('style')].some(s=>s.textContent.includes('accountCard')), row:[...document.querySelectorAll('#title .bq-links button')].map(b=>b.textContent),
                    text:/sign in|account/i.test(document.body.innerText)})""")
                await p2.wait_for_timeout(800)
                sent = [x['m'] + ' ' + x['p'] for x in fake.log[n0:] if x['p'].startswith('/v1/auth') or x['p'] == '/v1/me']
                xh = [x for x in fake.log[n0:] if x['x'] or x['cookie']]
                check(label, not r['on'] and r['state'] == 'off' and not r['link'] and not r['card'] and not r['style'] and r['row'] == ROW and not r['text'] and not sent and not xh, dict(r, sent=sent, xh=len(xh)))
                f = await p2.evaluate(f"async () => {{ localStorage.setItem('bq-sync-key','{SYNC}'); const r=await G.account.fetch('/v1/echo'); return r.status; }}")
                last = fake.reqs(path='/v1/echo')[-1]
                check(label + 'Fetch', f == 200 and last['auth'] == 'Bearer ' + SYNC and not last['x'] and not last['cookie'], last)
                await c2.close()
        await step('noFlag', noFlag)

        ctx, pg = await device()
        await pg.evaluate(f"localStorage.setItem('bq-sync-key','{SYNC}')")

        async def links():
            r = await pg.evaluate("() => ({row:[...document.querySelectorAll('#title .bq-links button')].map(b=>b.textContent), pause:[...document.querySelectorAll('#pause .bq-links button')].map(b=>b.textContent), state:G.account.state, on:G.account.on})")
            me = fake.reqs('GET', '/v1/me')
            check('links', r['on'] and r['state'] == 'out' and r['row'] == ROW + ['Sign in'] and r['pause'] == r['row'], r)
            check('meOnLoad', len(me) == 1 and me[0]['x'] == '1' and me[0]['origin'] == GAME and not me[0]['cookie'], me)
            lay = await pg.evaluate("""() => { const row=document.querySelector('#title .bq-links'), st=document.querySelector('#title .studio'); const a=row.getBoundingClientRect(), s=st.getBoundingClientRect();
                const tops=new Set([...row.children].filter(x=>!x.hidden).map(x=>Math.round(x.getBoundingClientRect().top))); return {rowBottom:a.bottom, studioTop:s.top, lines:tops.size, right:a.right}; }""")
            await pg.screenshot(path=SHOTS + '/title_desktop.png')
            await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(400)
            lp = await pg.evaluate("""() => { const row=document.querySelector('#title .bq-links'), st=document.querySelector('#title .studio'); const a=row.getBoundingClientRect(), s=st.getBoundingClientRect();
                const bs=[...row.children].filter(x=>!x.hidden).map(x=>x.getBoundingClientRect()); return {rowBottom:a.bottom, studioTop:s.top, right:Math.max(...bs.map(x=>x.right)), doc:document.documentElement.scrollWidth,
                  broken:[...row.querySelectorAll('button')].filter(b=>b.getClientRects().length>1).map(b=>b.textContent)}; }""")
            await pg.screenshot(path=SHOTS + '/title_phone.png')
            await pg.set_viewport_size({'width': 1100, 'height': 700}); await pg.wait_for_timeout(300)
            check('rowClearOfCredit', lay['rowBottom'] <= lay['studioTop'] and lp['rowBottom'] <= lp['studioTop'] and lp['right'] <= 390 and lp['doc'] <= 391 and not lp['broken'], {'desk': lay, 'phone': lp})
        await step('links', links)

        async def signInCard():
            await click('#title [data-account-link]'); await pg.wait_for_timeout(300); c = await card()
            check('opensSignIn', c['open'] and c['view'] == 'email' and not c['title_shown'] and c['buttons'][:3] == ['Send link to email', 'Use password', 'Keep playing as a guest'] and c['pad'] == 'acGuest' and c['focus'] == 'email' and not c['tags'], c)
            r1 = await shot('signin')
            check('signInFitsPhone', fits(r1), r1)
        await step('signInCard', signInCard, ('links',))

        async def passwordCard():
            await click('#acUsePw'); await pg.wait_for_timeout(200); c = await card()
            check('passwordView', c['view'] == 'password' and 'Forgot password?' in c['buttons'] and 'Sign in' in c['buttons'] and 'Email me a sign-in link instead' in c['buttons'] and c['pad'] == 'acPwBack', c)
            await pg.fill('#accountCard [data-view=password] input[name=password]', 'secret')
            await click('#accountCard [data-view=password] .ac-eye'); t1 = await pg.evaluate("document.querySelector('#accountCard [data-view=password] input[name=password]').type")
            await click('#accountCard [data-view=password] .ac-eye'); t2 = await pg.evaluate("document.querySelector('#accountCard [data-view=password] input[name=password]').type")
            check('showHide', t1 == 'text' and t2 == 'password', [t1, t2])
            r2 = await shot('password')
            check('passwordFitsPhone', fits(r2), r2)
            # typed keys in the password field stay out of the game: N toggles the sound (audio.js), Space is jump (core.js's input),
            # and no key reaches a listener past core.js's guard. First a control with nothing focused, to show the probes see a key that does reach the game.
            probe = """() => { if(!window.__keys){ window.__keys=[]; document.addEventListener('keydown',e=>__keys.push(e.code)); } return {muted:!!(G.audio&&G.audio.settings&&G.audio.settings.muted), keys:__keys.length}; }"""
            await pg.evaluate(probe)
            await pg.evaluate("document.activeElement&&document.activeElement.blur()"); c0 = await pg.evaluate(probe)
            await pg.keyboard.down('Space'); ctlJump = await pg.evaluate("G.input.down('jump')"); await pg.keyboard.up('Space')
            await pg.keyboard.press('KeyN'); c1 = await pg.evaluate(probe); await pg.keyboard.press('KeyN'); c2 = await pg.evaluate(probe)
            control = ctlJump and c1['muted'] != c0['muted'] and c2['muted'] == c0['muted'] and c2['keys'] >= c0['keys'] + 3
            await pg.focus('#accountCard [data-view=password] input[name=password]'); b0 = await pg.evaluate(probe)
            await pg.keyboard.down('Space'); pwJump = await pg.evaluate("G.input.down('jump')"); await pg.keyboard.up('Space')
            await pg.keyboard.type('nN'); await pg.keyboard.press('KeyN')
            b1 = await pg.evaluate(probe); v = await pg.evaluate("document.querySelector('#accountCard [data-view=password] input[name=password]').value")
            check('passwordTyping', control and not pwJump and b1['muted'] == b0['muted'] and b1['keys'] == b0['keys'] and v == 'secret nNn',
                  {'control': control, 'ctlJump': ctlJump, 'c': [c0, c1, c2], 'pwJump': pwJump, 'before': b0, 'after': b1, 'value': v})
            await pg.keyboard.press('Tab'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200); c = await card()
            check('escapeBack', c['view'] == 'email' and c['open'], c)
            await pg.focus('#acSendLink'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200); c = await card()   # (in a text field the field keeps Escape)
            check('escapeClose', not c['open'] and c['title_shown'], c)
        await step('passwordCard', passwordCard, ('signInCard',))

        async def linkFlow():
            await pg.evaluate("G.account.close()"); await pg.wait_for_timeout(200)
            await pg.evaluate("G.account.debug.resend(60000)")
            await click('#title [data-account-link]'); await pg.wait_for_timeout(200)
            await fill('[data-view=email] input', 'not-an-email'); await click('#acSendLink'); await pg.wait_for_timeout(200); c = await card()
            check('badEmailLocal', c['view'] == 'email' and 'doesn’t look like an email' in c['note'] and not fake.reqs('POST', '/v1/auth/start'), c['note'])
            await fill('[data-view=email] input', '  ' + EMAIL + ' '); await pg.press('#accountCard [data-view=email] input', 'Enter'); await settle(); c = await card()
            st = fake.reqs('POST', '/v1/auth/start')
            check('codeView', c['view'] == 'code' and c['title'] == 'Check your email' and EMAIL in c['text'] and 'If that address is right' in c['text'] and len(st) == 1 and st[0]['b'] == {'email': EMAIL}
                  and st[0]['x'] == '1' and any(x.startswith('Send it again in') for x in c['disabled']) and c['pad'] == 'acOther', dict(c, st=st))
            r = await shot('code')
            check('codeFitsPhone', fits(r), r)
            code = fake.last(EMAIL)['code']
            await fill('[data-view=code] input', '000000'); await settle(); c = await card()
            cr = fake.reqs('POST', '/v1/auth/code')
            check('wrongCode', c['view'] == 'code' and '4 tries left' in c['note'] and c['bad'] and len(cr) == 1 and cr[0]['b']['code'] == '000000' and c['state'] == 'out', {'note': c['note'], 'n': len(cr)})
            for ch in fake.chal.values(): ch['exp'] = time.time() - 1
            await fill('[data-view=code] input', code); await settle(); c = await card()
            check('expiredCode', 'expired' in c['note'] and c['state'] == 'out' and 'Send it again' in c['buttons'] and 'Send it again' not in c['disabled'], c)
            await pg.evaluate("G.account.debug.resend(1500)")
            await click('#acResend'); await settle(); c = await card()
            st = fake.reqs('POST', '/v1/auth/start')
            check('resend', len(st) == 2 and st[-1]['b'] == {'email': EMAIL} and 'Sent again' in c['note'], c['note'])
            await pg.wait_for_timeout(1700); c = await card()
            check('resendWakes', 'Send it again' in c['buttons'] and 'Send it again' not in c['disabled'], c['disabled'])
            code = fake.last(EMAIL)['code']
            await pg.fill('#accountCard [data-view=code] input', code[:3] + ' ' + code[3:]); await settle(); c = await card()   # pasted with a space: still six digits
            ck = await ctx.cookies(API)
            check('codeSignIn', c['state'] == 'in' and c['view'] == 'account' and c['me']['email'] == EMAIL and 'signed in' in c['note'] and c['ev'][-1] == {'n': 'account:in', 'fresh': True, 'name': '', 'email': EMAIL}
                  and any(k['name'] == 'bq_s' and k['httpOnly'] for k in ck) and c['links'] == ['Account', 'Account'] and await pg.evaluate("G.account.debug.last") == 'link', dict(c, cookies=len(ck)))
        await step('linkFlow', linkFlow, ('signInCard',))

        async def fetchIn():
            n = await pg.evaluate("async () => { const r=await G.account.fetch('/v1/echo',{method:'POST',body:{a:1}}); return r.status; }")
            e = fake.reqs(path='/v1/echo')[-1]
            check('fetchSignedIn', n == 200 and e['cookie'] and e['x'] == '1' and e['origin'] == GAME and not e['auth'] and e['b'] == {'a': 1}, e)
            check('can', await pg.evaluate("[G.account.can('start'), G.account.can('give')]") == [False, False], 'player has no tools')
        await step('fetchIn', fetchIn, ('linkFlow',))

        async def accountCard():
            c = await card()
            check('accountCard', c['title'] == 'Your account' and EMAIL in c['text'] and 'Account since' in c['text'] and 'Role:' not in c['text']
                  and all(x in c['buttons'] for x in ('Save name', 'Set a password', 'Sign out', 'Sign out everywhere', 'Delete my account', 'Back')) and c['pad'] == 'acBack', c)
            priv = await pg.evaluate("(() => { const a=document.querySelector('#accountCard a[href]'); return a?a.getAttribute('href'):''; })()")
            check('privacyLink', priv == 'privacy.html', priv)
            r = await shot('account')
            check('accountFitsPhone', fits(r), r)
            await fill('[data-view=account] input', 'Taken Name'); await click('#acSaveName'); await settle(); c = await card()
            check('nameTaken', 'taken' in c['note'] and c['me']['name'] == '', c['note'])
            await fill('[data-view=account] input', 'badword man'); await click('#acSaveName'); await settle(); c = await card()
            check('nameInvalid', 'isn’t allowed' in c['note'] and fake.reqs('PUT', '/v1/me')[-1]['b'] == {'name': 'badword man'}, c['note'])
            await fill('[data-view=account] input', 'ab'); await click('#acSaveName'); await pg.wait_for_timeout(200); c = await card()
            check('nameShortLocal', '3 to 16' in c['note'] and len(fake.reqs('PUT', '/v1/me')) == 2, c['note'])
            await fill('[data-view=account] input', '  Fog   Walker '); await click('#acSaveName'); await settle(); c = await card()
            put = fake.reqs('PUT', '/v1/me')[-1]
            check('nameOk', c['me']['name'] == 'Fog Walker' and 'now Fog Walker' in c['note'] and put['b'] == {'name': 'Fog Walker'} and put['cookie'] and put['x'] == '1'
                  and c['ev'][-1]['n'] == 'account:me' and c['ev'][-1]['name'] == 'Fog Walker', dict(c['ev'][-1], note=c['note']))
        await step('accountCard', accountCard, ('linkFlow',))

        async def setPassword():
            fake.fresh_secs = 0
            await click('#acPassword'); await pg.wait_for_timeout(200); c = await card()
            check('setPwView', c['view'] == 'setpw' and c['title'] == 'Set a password' and 'Current password' not in c['text'], c)
            await fill('[data-view=setpw] input[name=new-password]', 'short'); await click('#acPwSave'); await pg.wait_for_timeout(200); c = await card()
            check('weakLocal', 'at least 10' in c['note'], c['note'])
            await fill('[data-view=setpw] input[name=new-password]', 'lantern in the fog'); await click('#acPwSave'); await settle(); c = await card()
            check('reauthAsked', c['view'] == 'reauth' and c['title'] == 'Sign in again' and EMAIL in c['text'] and fake.reqs('PUT', '/v1/me')[-1]['b'] == {'password': {'new': 'lantern in the fog'}}, c)
            await click('#acReGo'); await settle(); c = await card()
            check('reauthCode', c['view'] == 'code' and fake.reqs('POST', '/v1/auth/start')[-1]['b'] == {'email': EMAIL} and 'Back' in c['buttons'], c)
            fake.fresh_secs = 900
            await fill('[data-view=code] input', fake.last(EMAIL)['code']); await settle(); c = await card()
            check('reauthBack', c['view'] == 'setpw' and c['state'] == 'in' and 'choose your password' in c['note'] and c['ev'][-1]['n'] == 'account:me', c)
            await fill('[data-view=setpw] input[name=new-password]', 'lantern in the fog'); await click('#acPwSave'); await settle(); c = await card()
            check('passwordSet', c['view'] == 'account' and c['me']['hasPassword'] and 'Password set' in c['note'] and 'Change password' in c['buttons'] and fake.accounts[EMAIL]['password'] == 'lantern in the fog', c)
            await click('#acPassword'); await pg.wait_for_timeout(200); c = await card()
            await fill('[data-view=setpw] input[name=current]', 'wrong one'); await fill('[data-view=setpw] input[name=new-password]', 'a new lantern'); await click('#acPwSave'); await settle(); c = await card()
            check('changeWrongCurrent', 'current password isn’t right' in c['note'] and fake.reqs('PUT', '/v1/me')[-1]['b'] == {'password': {'new': 'a new lantern', 'current': 'wrong one'}}, c['note'])
            await click('#acPwCancel'); await pg.wait_for_timeout(200)
        await step('setPassword', setPassword, ('accountCard',))

        async def signOut():
            await click('#acSignOut'); await settle(); c = await card()
            so = fake.reqs('POST', '/v1/auth/signout')[-1]
            ck = [k for k in await ctx.cookies(API) if k['name'] == 'bq_s']
            check('signOut', c['state'] == 'out' and c['view'] == 'email' and 'signed out' in c['note'] and so['b'] == {} and so['cookie'] and not ck and c['ev'][-1]['n'] == 'account:out' and c['links'] == ['Sign in', 'Sign in']
                  and c['tags'] == ['acSendLink'], dict(c, so=so))
            r = await shot('lastused')
            check('lastUsedFitsPhone', fits(r), r)
            n = await pg.evaluate("async () => (await G.account.fetch('/v1/echo')).status")
            e = fake.reqs(path='/v1/echo')[-1]
            check('fetchSignedOut', n == 200 and e['auth'] == 'Bearer ' + SYNC and e['x'] == '1' and not e['cookie'], e)
            n = await pg.evaluate("async () => (await G.account.fetch('/v1/echo',{auth:false})).status")
            check('fetchNoAuth', not fake.reqs(path='/v1/echo')[-1]['auth'], fake.reqs(path='/v1/echo')[-1])
        await step('signOut', signOut, ('setPassword',))

        async def password():
            await click('#acUsePw'); await pg.wait_for_timeout(200)
            v = await pg.input_value('#accountCard [data-view=password] input[name=email]')
            await fill('[data-view=password] input[name=password]', 'not it'); await click('#acPwSignIn'); await settle(); c = await card()
            pw = fake.reqs('POST', '/v1/auth/password')[-1]
            check('passwordWrong', v == EMAIL and c['state'] == 'out' and 'don’t match' in c['note'] and pw['b'] == {'email': EMAIL, 'password': 'not it'} and pw['x'] == '1', dict(c, pw=pw))
            n0 = len(fake.reqs('POST', '/v1/auth/start'))
            await click('#acForgot'); await settle(); c = await card()
            check('forgot', c['view'] == 'code' and len(fake.reqs('POST', '/v1/auth/start')) == n0 + 1 and fake.reqs('POST', '/v1/auth/start')[-1]['b'] == {'email': EMAIL}, c['view'])
            await click('#acOther'); await pg.wait_for_timeout(200); await click('#acUsePw'); await pg.wait_for_timeout(200)
            await fill('[data-view=password] input[name=password]', 'lantern in the fog'); await click('#acPwSignIn'); await settle(); c = await card()
            check('passwordSignIn', c['state'] == 'in' and c['view'] == 'account' and c['me']['name'] == 'Fog Walker' and await pg.evaluate("G.account.debug.last") == 'password' and c['ev'][-1]['fresh'] is True, c)
            await pg.evaluate("G.account.signOut()"); await pg.wait_for_timeout(300)
            await pg.evaluate("G.account.open('title')"); await pg.wait_for_timeout(300); c = await card()
            check('lastUsedSwitched', c['tags'] == ['acUsePw'] and c['view'] == 'email', c['tags'])
            await click('#acUsePw'); await fill('[data-view=password] input[name=password]', 'lantern in the fog'); await click('#acPwSignIn'); await settle()
        await step('password', password, ('signOut',))

        async def restored():
            nonlocal pg
            await pg.reload(wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled", timeout=180000)
            st = await pg.evaluate("G.account.ready.then(()=>G.account.state)")
            await pg.wait_for_timeout(300); c = await card()
            me = fake.reqs('GET', '/v1/me')[-1]
            check('restoredSession', st == 'in' and c['me']['email'] == EMAIL and me['cookie'] and c['ev'] == [{'n': 'account:in', 'fresh': False, 'name': 'Fog Walker', 'email': EMAIL}] and c['links'] == ['Account', 'Account'] and not c['open'], c)
            await click('#title [data-account-link]'); await pg.wait_for_timeout(300)
            await click('#acSignOutAll'); await settle(); c = await card()
            so = fake.reqs('POST', '/v1/auth/signout')[-1]
            check('signOutEverywhere', so['b'] == {'everywhere': True} and c['state'] == 'out' and not [s for s in fake.sessions.values() if s['email'] == EMAIL] and 'every device' in c['note'], so)
        await step('restored', restored, ('password',))

        async def signin_pw():
            if (await card())['view'] != 'email': await pg.evaluate("G.account.close(); G.account.open('title')"); await pg.wait_for_timeout(200)
            await click('#acUsePw'); await fill('[data-view=password] input[name=email]', EMAIL); await fill('[data-view=password] input[name=password]', 'lantern in the fog'); await click('#acPwSignIn'); await settle()

        async def flip401():
            await signin_pw(); c = await card()
            assert c['state'] == 'in', c
            fake.sessions.clear()
            n = await pg.evaluate("async () => (await G.account.fetch('/v1/me')).status"); await pg.wait_for_timeout(200); c = await card()
            check('signedOut401', n == 401 and c['state'] == 'out' and c['ev'][-1]['n'] == 'account:out' and c['view'] == 'email' and 'signed out' in c['note'] and c['links'] == ['Sign in', 'Sign in'], c)
        await step('flip401', flip401, ('restored',))

        async def delete():
            await signin_pw(); await click('#acDelete'); await pg.wait_for_timeout(200); c = await card()
            check('deleteView', c['view'] == 'delete' and 'Delete my account' in c['disabled'] and c['pad'] == 'acDelBack', c)
            await fill('[data-view=delete] input', 'DELET'); c = await card()
            ok1 = 'Delete my account' in c['disabled']
            await fill('[data-view=delete] input', 'DELETE'); c = await card()
            check('deleteTyped', ok1 and 'Delete my account' not in c['disabled'], c['disabled'])
            fake.fresh_secs = 0
            await click('#acDelGo'); await settle(); c = await card()
            check('deleteReauth', c['view'] == 'reauth' and 'deleting your account' in c['text'] and EMAIL in fake.accounts, c)
            await click('#acReBack'); await pg.wait_for_timeout(200); fake.fresh_secs = 900
            await fill('[data-view=delete] input', 'delete'); await click('#acDelGo'); await settle(); c = await card()
            d = fake.reqs('DELETE', '/v1/me')
            check('deleted', c['state'] == 'out' and EMAIL not in fake.accounts and len(d) == 2 and d[-1]['cookie'] and d[-1]['x'] == '1' and 'deleted' in c['note'] and c['view'] == 'email' and c['ev'][-1]['n'] == 'account:out', c)
        await step('delete', delete, ('flip401',))

        async def rate():
            await pg.evaluate("(async () => { if(G.account.state==='in')await G.account.signOut(); G.account.close(); G.account.open('title'); })()"); await pg.wait_for_timeout(300)
            fake.rate['/v1/auth/start'] = 120
            await fill('[data-view=email] input', EMAIL); await click('#acSendLink'); await settle(); c = await card()
            check('rateLimited', c['view'] == 'email' and 'Wait 2 minutes' in c['note'], c['note'])
            fake.rate['/v1/auth/password'] = 30
            await click('#acUsePw'); await fill('[data-view=password] input[name=password]', 'whatever123'); await click('#acPwSignIn'); await settle(); c = await card()
            check('rateLimitedSeconds', 'Wait 30 seconds' in c['note'], c['note'])
            await click('#acPwBack')
        await step('rate', rate, ('links',))

        async def down():
            fake.down = True
            try:
                await fill('[data-view=email] input', EMAIL); await click('#acSendLink'); await settle(); c = await card()
                check('downSays', 'Couldn’t reach' in c['note'] and c['state'] == 'out', c['note'])
            finally:
                fake.down = False
        await step('down', down, ('links',))

        async def pause():
            await pg.evaluate("(async () => { if(G.account.state==='in')await G.account.signOut(); G.account.close(); })()"); await pg.wait_for_timeout(200)
            await pg.evaluate("document.getElementById('begin').click()"); await pg.wait_for_timeout(1500)
            await pg.evaluate("document.getElementById('pauseBtn').click()"); await pg.wait_for_timeout(400)
            r = await pg.evaluate("[...document.querySelectorAll('#pause .bq-links button')].map(b=>b.textContent)")
            await click('#pause [data-account-link]'); await pg.wait_for_timeout(300); c = await card()
            ok = c['open'] and not c['pause_shown'] and c['view'] == 'email'
            await click('#acGuest'); await pg.wait_for_timeout(300); c2 = await card()
            check('pauseButton', r == ROW + ['Sign in'] and ok and not c2['open'] and c2['pause_shown'] and c2['mode'] == 'paused', {'row': r, 'c2': c2})
        await step('pause', pause, ('links',))
        await ctx.close()

        # ---- a link opened in the browser ----
        async def linkGood():
            cid = fake.new_chal('reader@example.com'); tok = fake.chal[cid]['link']
            c2, p2 = await device(url=PAGE + ('&' if '?' in PAGE else '?') + 'signin=' + tok)
            nonlocal pg
            pg = p2
            await p2.wait_for_function("document.getElementById('accountCard')&&!document.getElementById('accountCard').hidden", timeout=30000); c = await card()
            loc = await p2.evaluate("location.search")
            lk = fake.reqs('POST', '/v1/auth/link')[-1]
            check('signinLink', c['pad'] == 'acLinkedGo' and c['state'] == 'in' and c['title'] == 'Signed in' and 'reader@example.com' in c['text'] and lk['b'] == {'token': tok} and lk['x'] == '1' and loc == ('?' + U.query if U.query else '')
                  and c['ev'][0]['n'] == 'account:in' and c['ev'][0]['fresh'] is True and await p2.evaluate("G.account.debug.last") == 'link', dict(c, loc=loc))
            await p2.screenshot(path=SHOTS + '/linked_desktop.png')
            await click('#acLinkedGo'); await p2.wait_for_timeout(200); c = await card()
            check('signinLinkClose', not c['open'] and c['title_shown'], c)
            await c2.close()
        await step('linkGood', linkGood)
        async def linkExpired():
            c2, p2 = await device(url=PAGE + ('&' if '?' in PAGE else '?') + 'signin=nope-' + secrets.token_hex(4))
            nonlocal pg
            pg = p2
            await p2.wait_for_function("document.getElementById('accountCard')&&!document.getElementById('accountCard').hidden", timeout=30000); c = await card()
            loc = await p2.evaluate("location.search")
            check('signinExpired', c['state'] == 'out' and c['title'] == 'That link has expired' and loc == ('?' + U.query if U.query else '') and 'Send a new link' in c['buttons'] and 'Not now' in c['buttons'], dict(c, loc=loc))
            await p2.screenshot(path=SHOTS + '/expired_desktop.png')
            await click('#acLinkedGo'); await p2.wait_for_timeout(200); c = await card()
            check('expiredToEmail', c['view'] == 'email' and c['open'], c['view'])
            await c2.close()
        await step('linkExpired', linkExpired)
        async def bootDown():
            fake.down = True
            try:
                c2, p2 = await device()
                r = await p2.evaluate("({s:G.account.state, off:G.account.debug.offline, row:[...document.querySelectorAll('#title .bq-links button')].map(b=>b.textContent), begin:!document.getElementById('begin').disabled})")
                check('serverDownOnLoad', r['s'] == 'out' and r['off'] and r['row'][-1] == 'Sign in' and r['begin'], r)
                await c2.close()
            finally: fake.down = False
        await step('bootDown', bootDown)

        errs = [e for q in pages for e in q.errs]
        check('onlyKnownEndpoints', not fake.other, fake.other[:5])
        check('noPageErrors', not errs, errs[:3])
        await b.close()
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)) + (' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''))
    sys.exit(1 if fails else 0)
asyncio.run(main())
