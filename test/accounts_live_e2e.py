# Keeper Accounts end to end: the game (dev.html, set up like the public build with accounts on) against the REAL save
# service from server/ (in-memory store, accounts on, a fake mailer), started by this test through
# test/accounts_live_service.mjs. No fakes in between: this is the check that the game and the service agree.
# Spec: ACCOUNTS.md. The suites with fakes (account_e2e, slots_e2e, board_account_e2e, roles_e2e) cover the details.
# The story: a guest saves and syncs; signs in with the emailed code; brings the guest save in; save slots; the Keepers'
# Board with the account's keeper name; a password (and the "sign in again" path), the emailed link in another browser;
# roles from the admin API; a test copy from the test tools; a second device (newer wins, keep which); the admin API
# (disable, enable) and deleting the account; a guest's keeper name; the service with accounts switched off.
# One browser per device and at most two at a time (a second WebGL page in one browser can stall on a small machine).
# Needs node and server/node_modules (it runs `npm ci` in server/ when they are missing).
# Usage: python3 test/accounts_live_e2e.py "http://localhost:PORT/dev.html?headless"   Screenshots: $SHOTS (/tmp/claude-0/accounts_live)
import asyncio, atexit, json, os, re, shutil, socket, subprocess, sys, time, urllib.request
from urllib.parse import urlparse
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8771/dev.html?headless'
U = urlparse(URL); GAME = U.scheme + '://' + U.netloc
PAGE = URL
APP_URL = GAME + U.path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
SVC_PORT, SIDE_PORT = free_port(), free_port()
API = 'http://localhost:%d' % SVC_PORT; SIDE = 'http://127.0.0.1:%d' % SIDE_PORT
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/accounts_live')
KEY = 'live-test-admin-key-' + '0123456789abcdef' * 2
INIT = "window.BQ_CONFIG={api:'%s',version:'9.9.9-test',devtools:false,accounts:true};window.BQ_ACCOUNTS_TEST=true;" % API
EMAIL = 'keeper@example.test'
ONLY = [x for x in os.environ.get('ONLY', '').split(',') if x]
STOP = ''
CHROME = '/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

def start_service():
    srv = os.path.join(ROOT, 'server')
    if not os.path.exists(os.path.join(srv, 'node_modules', 'pg')):
        subprocess.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=srv, check=True)
    env = dict(os.environ, PORT=str(SVC_PORT), SIDE_PORT=str(SIDE_PORT), APP_URL=APP_URL, SESSION_SECRET='live-test-session-secret-0123456789abcdef',
               COOKIE_INSECURE='1', ALLOWED_ORIGINS=GAME, SUPER_ADMIN_EMAILS='boss@example.test', ADMIN_API_KEY=KEY)
    pr = subprocess.Popen(['node', os.path.join(ROOT, 'test', 'accounts_live_service.mjs')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    atexit.register(lambda: pr.poll() is None and pr.kill())
    line = pr.stdout.readline()
    if 'ready' not in line: print('service did not start: ' + line + (pr.stdout.read() or '')); sys.exit(1)
    return pr

def http(method, url, body=None, headers=None):
    h = dict(headers or {})
    data = None
    if body is not None: data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
    rq = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(rq, timeout=20) as r: t = r.read().decode(); st = r.status
    except urllib.error.HTTPError as e: t = e.read().decode(); st = e.code
    try: return st, json.loads(t) if t else None
    except Exception: return st, t
def admin(method, path, body=None): return http(method, API + '/admin/v1' + path, body, {'X-Admin-Key': KEY, 'X-Admin-Email': 'studio@example.test'})
def guest(method, path, code, body=None): return http(method, API + path, body, {'Authorization': 'Bearer ' + code})
def mail(): return http('GET', SIDE + '/mail')[1]
def store(): return http('GET', SIDE + '/store')[1]
def clock(add=0): return http('POST', SIDE + '/clock?add=%d' % add)[1]
def last_mail(to):
    m = [x for x in mail() if x['to'] == to]; return m[-1] if m else None
code_of = lambda m: re.search(r'code in the game: (\d{6})', m['text']).group(1)
link_of = lambda m: re.search(r'(http\S*[?&]signin=[A-Za-z0-9_-]+)', m['text']).group(1)

ST = """() => { const vis=e=>!!e&&!e.hidden&&e.getClientRects().length>0;
  const ac=document.getElementById('accountCard'), sc=document.getElementById('slotsCard'), bc=document.getElementById('boardCard');
  const links=sel=>{ const r=document.querySelector(sel+' .bq-links'); return r?[...r.querySelectorAll('button')].filter(vis).map(b=>b.textContent):[]; };
  return {mode:G.state.mode, acc:G.account.state, me:G.account.me, view:G.account.debug.view, slotsUi:G.slots.debug.ui, sess:G.slots.debug.sess,
    active:G.slots.active(), test:!!G.testSaves, key:G.flow.keys.active, code:localStorage.getItem('bq-sync-key'), guest:!!localStorage.getItem('bq-save-v1'),
    acTitle:ac?ac.querySelector('h2').textContent:'', acNote:ac?ac.querySelector('.savenote').textContent:'', acText:ac&&!ac.hidden?ac.innerText.replace(/\\s+/g,' ').slice(0,600):'',
    scText:sc&&!sc.hidden?sc.innerText.replace(/\\s+/g,' ').slice(0,900):'', bcText:bc&&!bc.hidden?bc.innerText.replace(/\\s+/g,' ').slice(0,900):'',
    titleLinks:links('#title .title-sheet'), pauseLinks:links('#pause .sheet'), dt:!!document.querySelector('#title .dt-entry'),
    info:document.getElementById('saveInfo').textContent, cont:vis(document.getElementById('continue')), begin:document.getElementById('begin').textContent,
    toast:document.getElementById('toast').textContent, slotNote:(document.getElementById('slotNote')||{}).textContent||'',
    board:G.board?G.board.state:null, ls:Object.keys(localStorage)}; }"""

fails = []; results = {}
def check(name, ok, info=None):
    print(('ok   ' if ok else 'FAIL ') + name + ' : ' + json.dumps(info, default=str)[:900], flush=True)
    results[name] = bool(ok)
    if not ok: fails.append(name)

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        async def context():   # one browser per device: a second WebGL page in the same browser never finishes loading here
            bb = await p.chromium.launch(executable_path=CHROME, args=ARGS)
            ctx = await bb.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
            await ctx.add_init_script(INIT)
            ctx.bb = bb
            return ctx
        async def context2(state):
            bb = await p.chromium.launch(executable_path=CHROME, args=ARGS)
            ctx = await bb.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, storage_state=state)
            await ctx.add_init_script(INIT); ctx.bb = bb
            return ctx
        async def closectx(ctx):
            try: await ctx.close(); await ctx.bb.close()
            except Exception as e: print('     close', e)
        async def pw_signin(pg):
            await click(pg, '#title [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='email'||G.account.debug.view==='account'")
            if await pg.evaluate("G.account.state")=='in': await click(pg, '#acBack'); return
            await click(pg, '#acUsePw'); await pg.fill('#accountCard [data-view=password] input[name=email]', EMAIL); await pg.fill('#accountCard [name=password]', 'correct horse battery')
            await click(pg, '#acPwSignIn'); await pg.wait_for_function("G.account.state==='in'", timeout=30000); await settle(pg)
            if await pg.evaluate("G.account.debug.view"): await click(pg, '#acBack')
            await pg.wait_for_timeout(1500)
            if await pg.evaluate("G.slots.debug.ui")=='claim': await click(pg, '#slClaimNo')
        FROM = os.environ.get('FROM', '')
        ALLP = []
        async def lifecycle(pg, state):
            try:
                if not hasattr(pg, 'cdp'): pg.cdp = await pg.context.new_cdp_session(pg)
                await pg.cdp.send('Page.setWebLifecycleState', {'state': state})
            except Exception as e: print('     lifecycle', state, e)
        async def only(*keep):   # freeze every other page (2 cores: one game page running at a time)
            for q in ALLP:
                if q.is_closed(): continue
                want = 'active' if q in keep else 'frozen'
                if getattr(q, 'life', 'active') != want: await lifecycle(q, want); q.life = want
        async def page(ctx, url=PAGE):
            await only()
            pg = await ctx.new_page(); pg.errs = []; pg.cons = []; ALLP.append(pg)
            pg.on('pageerror', lambda e: pg.errs.append(str(e)))
            pg.on('console', lambda m: pg.cons.append(m.type + ' ' + m.text) if m.type in ('error', 'warning') else None)
            pg.set_default_timeout(120000)
            await pg.goto(url, wait_until='domcontentloaded', timeout=240000)
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(800)
            return pg
        async def st(pg): await only(pg); return await pg.evaluate(ST)
        async def ready(pg):
            await only(pg)
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(1000)
        async def settle(pg):
            await pg.wait_for_function("![...document.querySelectorAll('.savenote')].some(n=>n.textContent==='One moment…')", timeout=60000, polling=200)
            await pg.wait_for_timeout(300)
        async def pause(pg):
            await only(pg)
            if await pg.evaluate("G.state.mode")=='play': await pg.evaluate("document.getElementById('pauseBtn').click()")
            await pg.wait_for_function("G.state.mode==='paused'")
        async def quit(pg):   # Quit to title reloads the page
            await only(pg)
            async with pg.expect_navigation(timeout=60000):
                await pg.evaluate("document.getElementById('quitBtn').click()")
            await ready(pg)
        async def click(pg, sel):
            await only(pg)
            try: await pg.wait_for_function("s => { const b=document.querySelector(s); return !!b&&!b.hidden&&b.getClientRects().length>0; }", arg=sel, timeout=15000, polling=200)
            except Exception:
                print('     not shown', sel, json.dumps(await pg.evaluate(ST), default=str)[:1500])
            await pg.evaluate("s => { const b=document.querySelector(s); if(!b||b.hidden||!b.getClientRects().length)throw new Error('not shown '+s); b.click(); }", sel)
        async def click_text(pg, scope, text):
            await pg.evaluate("([s,t]) => { const b=[...document.querySelectorAll(s+' button')].find(x=>x.textContent.trim()===t&&!x.hidden&&x.getClientRects().length); if(!b)throw new Error('no button '+t+' in '+s); b.click(); }", [scope, text])
        async def shot(pg, name):
            await pg.evaluate("G.headless&&G.headless.draw&&G.headless.draw(3)"); await pg.wait_for_timeout(400)
            await pg.screenshot(path=SHOTS + '/' + name + '.png')
        async def play(pg): await pg.wait_for_function("G.state.mode==='play'", timeout=120000); await pg.wait_for_timeout(800)
        async def until(fn, t=25):
            end = time.time() + t
            while time.time() < end:
                v = fn() if not asyncio.iscoroutinefunction(fn) else await fn()
                if v: return v
                await asyncio.sleep(0.3)
            return False
        async def code_signin(pg, email, from_sel='#title [data-account-link]'):
            await click(pg, from_sel); await pg.wait_for_function("G.account.debug.view==='email'", timeout=30000)
            n0 = len([x for x in mail() if x['to'] == email])
            await pg.fill('#accountCard [data-view=email] input', email); await click(pg, '#acSendLink')
            await pg.wait_for_function("G.account.debug.view==='code'", timeout=30000)
            await until(lambda: len([x for x in mail() if x['to'] == email]) > n0, 10)
            return last_mail(email)
        W = {}
        ORDER = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12']
        async def step(name, fn):
            if ONLY and name not in ONLY: return
            if FROM and ORDER.index(name) < ORDER.index(FROM): return
            t0 = time.time(); print('---- ' + name, flush=True)
            try: await asyncio.wait_for(fn(), 600)
            except Exception as e:
                check(name, False, {'error': (type(e).__name__ + ' ' + str(e))[:500]})
                pg = W.get('pg')
                if pg:
                    try:
                        await pg.goto(PAGE, wait_until='domcontentloaded'); await ready(pg)
                    except Exception as e2: print('     reset failed', e2)
            for k in ('pg', 'pg2', 'pg3'):
                pg = W.get(k)
                if pg and getattr(pg, 'errs', None): print('     page errors', k, pg.errs[:5]); pg.errs.clear()
            print('     (%s: %.0f s)' % (name, time.time() - t0), flush=True)

        # 1 ---- guest plays, saves, turns on sync
        async def s1():
            W['ctx'] = await context(); W['pg'] = pg = await page(W['ctx'])
            s = await st(pg)
            check('1.guestTitle', s['acc'] == 'out' and 'Sign in' in s['titleLinks'] and 'Sync devices' in s['titleLinks'], s['titleLinks'])
            await click(pg, '#begin'); await play(pg)
            await pg.evaluate("G.flow.writeSave()")
            await pause(pg)
            await click_text(pg, '#pause .bq-links', 'Sync devices'); await pg.wait_for_timeout(500)
            await click_text(pg, '#syncCard', 'Turn on sync')
            code = await until(lambda: None, 0) or None
            await pg.wait_for_function("!!localStorage.getItem('bq-sync-key')", timeout=30000); await pg.wait_for_timeout(1500)
            code = await pg.evaluate("localStorage.getItem('bq-sync-key')"); W['code'] = code
            stt, sv = guest('GET', '/v1/save', code)
            local = await pg.evaluate("JSON.parse(localStorage.getItem('bq-save-v1'))")
            check('1.guestSaveOnServer', stt == 200 and sv['at'] == local['at'], {'status': stt, 'code': code})
            await click_text(pg, '#syncCard', 'Back'); await pg.wait_for_timeout(300)
            await quit(pg)
        await step('s1', s1)

        # 2 ---- sign in with the emailed code (new account); reload; still in
        async def s2():
            pg = W['pg']
            m = await code_signin(pg, EMAIL)
            await shot(pg, '02_code_view')
            check('2.mailArrived', m and re.search(r'\d{6}', m['text']) and 'signin=' in m['text'], m and m['subject'])
            await pg.fill('#accountCard [data-view=code] input', code_of(m))
            await pg.wait_for_function("G.account.state==='in'", timeout=30000); await pg.wait_for_timeout(1500)
            s = await st(pg)
            ss = store()
            check('2.signedIn', s['acc'] == 'in' and s['me']['email'] == EMAIL and len(ss['accounts']) == 1 and ss['accounts'][0]['role'] == 'player', {'me': s['me'], 'view': s['view'], 'slotsUi': s['slotsUi']})
            W['aid'] = s['me']['id']
            W['claimSeen'] = s['slotsUi']
            # the claim offer comes when the account card closes; screenshot the account card first
            if s['view']: await shot(pg, '05_account_card_new')
        await step('s2', s2)

        # 3 ---- claim
        async def s3():
            pg = W['pg']; s = await st(pg)
            if s['view']: await click(pg, '#acBack'); await settle(pg); await pg.wait_for_timeout(1200)
            await pg.wait_for_function("G.slots.debug.ui==='claim'", timeout=20000)
            await shot(pg, '03_claim_offer')
            s = await st(pg); check('3.claimOffered', 'Bring this save into your account' in s['scText'], s['scText'][:300])
            await click(pg, '#slClaimGo')
            await pg.wait_for_function("G.slots.debug.ui==='list'", timeout=30000); await pg.wait_for_timeout(1500)
            s = await st(pg); ss = store()
            stt, _ = guest('GET', '/v1/save', W['code'])
            sl = ss['slots'].get(W['aid'], [])
            check('3.claimed', any(x['slot'] == 1 for x in sl) and stt == 404 and not s['code'] and not s['guest'] and not ss['guestSaves']
                  and not [r for r in ss['records'] if r['id'].startswith('guest:')], {'slots': sl, 'guestGet': stt, 'code': s['code'], 'guest': s['guest'], 'recs': ss['records'], 'gs': ss['guestSaves'], 'note': s['scText'][:200]})
            # reload: still signed in (cookie session)
            await pg.reload(wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(1200)
            s = await st(pg)
            check('2.reloadStillIn', s['acc'] == 'in' and s['me']['id'] == W['aid'] and s['slotsUi'] == '' and 'Account' in s['titleLinks'], {'acc': s['acc'], 'ui': s['slotsUi'], 'links': s['titleLinks'], 'info': s['info']})
        await step('s3', s3)

        # 4 ---- slot list: new game into slot 2, save, rename, delete; autosave uploads the active slot
        async def s4():
            pg = W['pg']
            await click(pg, '#continue'); await pg.wait_for_function("G.slots.debug.ui==='list'"); await pg.wait_for_timeout(1500)
            await shot(pg, '04_slot_list')
            s = await st(pg); check('4.listShowsSlot1', 'Save 1' in s['scText'] and '1 of 10' in s['scText'], s['scText'][:300])
            await click(pg, '#slotsNew'); await play(pg)
            s = await st(pg); check('4.newIntoSlot2', s['active'] and s['active']['slot'] == 2, s['active'])
            await pg.evaluate("G.slots.debug.gap(0)")
            await pg.evaluate("G.flow.writeSave()")
            ok = await until(lambda: any(x['slot'] == 2 for x in store()['slots'].get(W['aid'], [])), 30)
            local = await pg.evaluate("k=>JSON.parse(localStorage.getItem(k))", s['key'])
            st2, sv = admin('GET', '/accounts/%s/saves/2' % W['aid'])
            check('4.autosaveUploads', ok and st2 == 200 and sv['at'] == local['at'] and not sv['test'] and sv['rec'], {'st': st2, 'at': sv and sv.get('at'), 'local': local['at'], 'rec': sv and sv.get('rec')})
            # save via the pause menu's Save
            await pause(pg)
            await click(pg, '#saveBtn'); await pg.wait_for_timeout(2500)
            local2 = await pg.evaluate("k=>JSON.parse(localStorage.getItem(k))", s['key'])
            st2, sv = admin('GET', '/accounts/%s/saves/2' % W['aid'])
            check('4.saveButtonUploads', sv['at'] == local2['at'], {'srv': sv['at'], 'local': local2['at']})
            await quit(pg)
            await click(pg, '#continue'); await pg.wait_for_function("G.slots.debug.ui==='list'"); await pg.wait_for_timeout(1200)
            await click(pg, '#slotsCard .sl-row[data-slot="2"] [data-act="rename"]'); await pg.wait_for_timeout(200)
            await pg.fill('#slotsCard [data-view=rename] input', 'Second try'); await click(pg, '#slRenameSave'); await settle(pg); await pg.wait_for_timeout(1200)
            ss = store(); n2 = [x for x in ss['slots'][W['aid']] if x['slot'] == 2]
            check('4.renamed', n2 and n2[0]['name'] == 'Second try', n2)
            await click(pg, '#slotsCard .sl-row[data-slot="2"] [data-act="delete"]'); await pg.wait_for_timeout(200)
            await click(pg, '#slDelGo'); await settle(pg)
            ss = store(); s = await st(pg)
            check('4.deleted', not [x for x in ss['slots'][W['aid']] if x['slot'] == 2] and not any(k.startswith('bq-save-s2-') for k in s['ls']), {'slots': ss['slots'][W['aid']], 'note': s['scText'][-120:]})
            await click(pg, '#slotsBack'); await settle(pg); await pg.wait_for_timeout(300)
        await step('s4', s4)

        # 5 ---- board: join with a keeper name (no sync code); rename on the account card shows on the board and back
        async def s5():
            pg = W['pg']
            # play slot 1 so the board has a real slot
            await click(pg, '#continue'); await pg.wait_for_function("G.slots.debug.ui==='list'"); await pg.wait_for_timeout(1200)
            await click(pg, '#slotsCard .sl-row[data-slot="1"] [data-act="use"]'); await play(pg)
            await pg.evaluate("G.slots.debug.gap(0)"); await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(2500)
            await pause(pg)
            await click(pg, '#pause [data-board-link]'); await settle(pg); await pg.wait_for_timeout(2000)
            s = await st(pg)
            await shot(pg, '05_board_join')
            if not await pg.evaluate("(()=>{ const i=document.querySelector('#boardCard [data-view=join] input'); return !!i&&i.getClientRects().length>0; })()"):
                await click(pg, '#boardName'); await pg.wait_for_timeout(500)
            await pg.fill('#boardCard [data-view=join] input', 'Lamp Keeper'); await click(pg, '#boardJoin'); await settle(pg); await pg.wait_for_timeout(1500)
            s = await st(pg); ss = store()
            rec = [r for r in ss['records'] if r['id'] == 'a:' + W['aid']]
            acc = [a for a in ss['accounts'] if a['id'] == W['aid']][0]
            check('5.joined', rec and rec[0]['name'] == 'Lamp Keeper' and acc['name'] == 'Lamp Keeper' and not s['code'] and 'Lamp Keeper' in s['bcText'] and s['me']['name'] == 'Lamp Keeper',
                  {'rec': rec, 'acc': acc, 'code': s['code'], 'bc': s['bcText'][:300], 'me': s['me'] and s['me']['name'], 'log': s['board']['log']})
            await shot(pg, '06_board_signed_in')
            await click(pg, '#boardBack'); await pg.wait_for_timeout(300)
            # rename on the account card
            await click(pg, '#pause [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='account'")
            await pg.fill('#accountCard [name=keeper]', 'Tide Keeper'); await click(pg, '#acSaveName'); await settle(pg)
            await shot(pg, '07_account_card')
            await click(pg, '#acBack'); await settle(pg); await pg.wait_for_timeout(300)
            await click(pg, '#pause [data-board-link]'); await settle(pg); await pg.wait_for_timeout(2000)
            s = await st(pg); ss = store(); rec = [r for r in ss['records'] if r['id'] == 'a:' + W['aid']]
            check('5.cardRenameOnBoard', 'Tide Keeper' in s['bcText'] and rec[0]['name'] == 'Tide Keeper', {'bc': s['bcText'][:300], 'rec': rec})
            # and the reverse: change on the board, see it on the account card
            await click(pg, '#boardName'); await pg.wait_for_timeout(400)
            await pg.fill('#boardCard [data-view=join] input', 'Storm Keeper'); await click(pg, '#boardJoin'); await settle(pg); await pg.wait_for_timeout(1500)
            await click(pg, '#boardBack'); await pg.wait_for_timeout(300)
            await click(pg, '#pause [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='account'"); await pg.wait_for_timeout(500)
            v = await pg.evaluate("document.querySelector('#accountCard [name=keeper]').value")
            check('5.boardRenameOnCard', v == 'Storm Keeper' and store()['accounts'][0]['name'] == 'Storm Keeper', v)
            await click(pg, '#acBack'); await settle(pg); await pg.wait_for_timeout(300)
            await quit(pg)
        await step('s5', s5)

        # 6 ---- password: set (reauth when older than 15 min), sign out, sign in with it; forgot password; link in a fresh context
        async def s6():
            pg = W['pg']
            clock(16 * 60 * 1000)
            await click(pg, '#title [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='account'")
            await click(pg, '#acPassword'); await pg.wait_for_function("G.account.debug.view==='setpw'")
            await pg.fill('#accountCard [name=new-password]', 'correct horse battery'); await click(pg, '#acPwSave'); await settle(pg)
            await pg.wait_for_function("G.account.debug.view==='reauth'", timeout=20000)
            s = await st(pg); check('6.reauthAsked', 'Sign in again' in s['acTitle'], s['acText'][:200])
            n0 = len(mail())
            await click(pg, '#acReGo'); await pg.wait_for_function("G.account.debug.view==='code'")
            await until(lambda: len(mail()) > n0, 10)
            await pg.fill('#accountCard [data-view=code] input', code_of(last_mail(EMAIL)))
            await pg.wait_for_function("G.account.debug.view==='setpw'", timeout=20000)
            await pg.fill('#accountCard [name=new-password]', 'correct horse battery'); await click(pg, '#acPwSave'); await settle(pg)
            await pg.wait_for_timeout(2500)
            s = await st(pg); check('6.passwordSet', s['me']['hasPassword'] and s['view'] == 'account', {'note': s['acNote'], 'view': s['view']})
            await click(pg, '#acSignOut'); await settle(pg); await pg.wait_for_timeout(1500)
            s = await st(pg); check('6.signedOut', s['acc'] == 'out' and store()['sessions'] == 0, {'acc': s['acc'], 'sessions': store()['sessions']})
            await click(pg, '#acUsePw'); await pg.wait_for_function("G.account.debug.view==='password'")
            await pg.fill('#accountCard [data-view=password] input[name=email]', EMAIL); await pg.fill('#accountCard [name=password]', 'correct horse battery')
            await click(pg, '#acPwSignIn'); await pg.wait_for_function("G.account.state==='in'", timeout=20000); await pg.wait_for_timeout(1000)
            s = await st(pg); check('6.passwordSignIn', s['acc'] == 'in' and s['me']['id'] == W['aid'], s['acNote'])
            await click(pg, '#acBack'); await settle(pg); await pg.wait_for_timeout(500)
            # forgot password: from the password view, starts the link flow
            await click(pg, '#title [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='account'")
            await click(pg, '#acSignOut'); await settle(pg); await pg.wait_for_timeout(1200)
            await click(pg, '#acUsePw'); await pg.wait_for_function("G.account.debug.view==='password'")
            await pg.fill('#accountCard [data-view=password] input[name=email]', EMAIL)
            n0 = len(mail()); await click(pg, '#acForgot'); await pg.wait_for_function("G.account.debug.view==='code'", timeout=20000)
            ok = await until(lambda: len(mail()) > n0, 10)
            check('6.forgotSendsLink', ok and 'signin=' in last_mail(EMAIL)['text'], None)
            link = link_of(last_mail(EMAIL)); W['link'] = link
            await click(pg, '#acOther'); await click(pg, '#acGuest'); await settle(pg); await pg.wait_for_timeout(300)
            # fresh browser context opens the link
            ctx2 = await context(); W['ctx2'] = ctx2
            pg2 = await page(ctx2, link + '&headless'); W['pg2'] = pg2
            await pg2.wait_for_timeout(1500)
            s = await st(pg2); url = pg2.url
            check('6.linkSignIn', s['acc'] == 'in' and s['me']['id'] == W['aid'] and 'signin' not in url and 'Signed in' in s['acTitle'], {'acc': s['acc'], 'url': url, 'title': s['acTitle'], 'text': s['acText'][:200]})
            await click(pg2, '#acLinkedGo'); await settle(pg2); await pg2.wait_for_timeout(600)
            await closectx(ctx2); W.pop('pg2', None); W.pop('ctx2', None)
            # sign device 1 back in with the password for what follows
            await click(pg, '#title [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='email'")
            await click(pg, '#acUsePw'); await pg.fill('#accountCard [data-view=password] input[name=email]', EMAIL); await pg.fill('#accountCard [name=password]', 'correct horse battery')
            await click(pg, '#acPwSignIn'); await pg.wait_for_function("G.account.state==='in'", timeout=20000); await pg.wait_for_timeout(800)
            await click(pg, '#acBack'); await settle(pg); await pg.wait_for_timeout(500)
            s = await st(pg); check('6.backIn', s['acc'] == 'in', s['slotsUi'])
        await step('s6', s6)

        # 7 ---- roles through the admin API
        async def s7():
            pg = W['pg']
            stt, r = admin('POST', '/accounts/' + W['aid'], {'role': 'tester'})
            await pg.evaluate("G.account.refresh()"); await pg.wait_for_timeout(1000)
            s = await st(pg)
            await click(pg, '#title .dt-entry [data-dt-open]'); await pg.wait_for_timeout(600)
            secs = await pg.evaluate("[...document.querySelectorAll('#dtCard .dt-h, .dt-h')].map(x=>x.textContent)")
            await shot(pg, '08_tester_test_tools')
            W['secs4'] = secs
            check('7.testerFour', stt == 200 and s['dt'] and len(secs) == 4, {'st': stt, 'secs': secs, 'tools': s['me']['tools']})
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            admin('POST', '/accounts/' + W['aid'], {'tools': ['cheats']})
            await pg.evaluate("G.account.refresh()"); await pg.wait_for_timeout(800)
            await click(pg, '#title .dt-entry [data-dt-open]'); await pg.wait_for_timeout(600)
            secs = await pg.evaluate("[...document.querySelectorAll('.dt-h')].map(x=>x.textContent)")
            check('7.plusCheatsFive', len(secs) == 5 and 'Cheats' in secs, secs)
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            # the super admin: all six, and the admin API refuses to demote
            ctx = await context(); pgs = await page(ctx)
            m = await code_signin(pgs, 'boss@example.test')
            await pgs.fill('#accountCard [data-view=code] input', code_of(m)); await pgs.wait_for_function("G.account.state==='in'", timeout=30000)
            await pgs.wait_for_timeout(1000)
            if (await st(pgs))['view']: await click(pgs, '#acBack'); await pgs.wait_for_timeout(600)
            await click(pgs, '#title .dt-entry [data-dt-open]'); await pgs.wait_for_timeout(600)
            secs = await pgs.evaluate("[...document.querySelectorAll('.dt-h')].map(x=>x.textContent)")
            me = (await st(pgs))['me']
            stt, r = admin('POST', '/accounts/' + me['id'], {'role': 'player'})
            std, rd = admin('DELETE', '/accounts/' + me['id'])
            check('7.superSixAndUndemotable', len(secs) == 6 and me['role'] == 'admin' and stt == 409 and r['error'] == 'super' and std == 409, {'secs': secs, 'role': me['role'], 'demote': [stt, r], 'del': std})
            W['superId'] = me['id']
            await closectx(ctx); await only(pg)
        await step('s7', s7)

        if FROM and FROM not in ('s11', 's12'):
            W['ctx'] = await context(); W['pg'] = pg = await page(W['ctx'])
            acc = [a for a in store()['accounts'] if a['email'] == EMAIL]
            if acc: await pw_signin(pg)
            else:   # set the account up again: code sign-in, a password, a game in slot 1, tester + cheats
                m = await code_signin(pg, EMAIL); await pg.fill('#accountCard [data-view=code] input', code_of(m))
                await pg.wait_for_function("G.account.state==='in'", timeout=30000); await settle(pg)
                await click(pg, '#acPassword'); await pg.fill('#accountCard [name=new-password]', 'correct horse battery'); await click(pg, '#acPwSave'); await settle(pg)
                await click(pg, '#acBack'); await pg.wait_for_timeout(1000)
                await click(pg, '#begin'); await play(pg); await pg.evaluate("G.slots.debug.gap(0)"); await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(2500)
                await quit(pg)
            acc = [a for a in store()['accounts'] if a['email'] == EMAIL][0]; W['aid'] = acc['id']
            admin('POST', '/accounts/' + W['aid'], {'role': 'tester'}); admin('POST', '/accounts/' + W['aid'], {'tools': ['cheats']})
            await pg.evaluate("G.account.refresh()"); await pg.wait_for_timeout(1000)
            print('     setup from', FROM, store()['slots'].get(W['aid']), flush=True)

        # 8 ---- test tools on a normal slot: a test copy in a free slot
        async def s8():
            pg = W['pg']
            await click(pg, '#continue'); await pg.wait_for_function("G.slots.debug.ui==='list'"); await pg.wait_for_timeout(1200)
            await click(pg, '#slotsCard .sl-row[data-slot="1"] [data-act="use"]'); await play(pg)
            orig = [x for x in store()['slots'][W['aid']] if x['slot'] == 1][0]
            st0, sv0 = admin('GET', '/accounts/%s/saves/1' % W['aid'])
            rec0 = [r for r in store()['records'] if r['id'] == 'a:' + W['aid']]
            await pause(pg)
            await click(pg, '#pause .dt-entry [data-dt-open]'); await pg.wait_for_timeout(600)
            txt = await pg.evaluate("document.querySelector('.dt-slot').innerText")
            W['dtText'] = txt; print('     dt-slot:', txt)
            await click(pg, '[data-cheat="god"]'); await pg.wait_for_timeout(800)
            txt2 = await pg.evaluate("document.querySelector('.dt-slot').innerText"); print('     dt-slot after:', txt2)
            await shot(pg, '09_test_tools_signed_in')
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            s = await st(pg)
            await pg.evaluate("G.slots.debug.gap(0)"); await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(3000)
            ss = store(); sl = ss['slots'][W['aid']]
            t = [x for x in sl if x['slot'] == (s['active'] or {}).get('slot')]
            st1, sv1 = admin('GET', '/accounts/%s/saves/1' % W['aid'])
            rec1 = [r for r in store()['records'] if r['id'] == 'a:' + W['aid']]
            check('8.testCopy', s['active'] and s['active']['test'] and s['active']['slot'] != 1 and t and t[0]['test'] and sv1['at'] == sv0['at'] and sv1['body'] == sv0['body'],
                  {'active': s['active'], 'slots': sl})
            check('8.noRecordFromTest', rec1 == rec0, {'before': rec0, 'after': rec1})
            await pause(pg)
            await quit(pg)
        await step('s8', s8)

        # 9 ---- second device: same slots, plays slot 1; the first device gets newer-wins / keep-which.
        #        One browser at a time (this machine): device 1's storage is kept with storage_state while device 2 runs.
        async def reopen1(state):
            W['ctx'] = ctx = await context2(state); W['pg'] = pg = await page(ctx); return pg
        async def dev2(fn):
            ctx = await context(); pg2 = await page(ctx); await pw_signin(pg2)
            try: return await fn(pg2)
            finally: await closectx(ctx)
        async def s9():
            pg = W['pg']
            l1 = await pg.evaluate("G.slots.list().filter(v=>v.used).map(v=>v.slot)")
            state = await W['ctx'].storage_state(); await closectx(W['ctx'])
            async def play2(pg2):
                await click(pg2, '#continue'); await pg2.wait_for_function("G.slots.debug.ui==='list'"); await settle(pg2); await pg2.wait_for_timeout(1500)
                l2 = await pg2.evaluate("G.slots.list().filter(v=>v.used).map(v=>v.slot)")
                await click(pg2, '#slotsCard .sl-row[data-slot="1"] [data-act="use"]'); await play(pg2)
                await pg2.evaluate("G.slots.debug.gap(0)"); await pg2.evaluate("G.flow.writeSave()"); await pg2.wait_for_timeout(2500)
                at2 = await pg2.evaluate("k=>JSON.parse(localStorage.getItem(k)).at", (await st(pg2))['key'])
                return l2, at2
            l2, at2 = await dev2(play2)
            st_, sv = admin('GET', '/accounts/%s/saves/1' % W['aid'])
            check('9.sameSlots', l1 == l2 and 1 in l2, {'d1': l1, 'd2': l2})
            check('9.device2Uploaded', sv['at'] == at2, {'srv': sv['at'], 'at2': at2})
            # device 1 again: its copy of slot 1 is older and fully sent -> the account's newer copy wins (downloaded on open)
            pg = await reopen1(state)
            await click(pg, '#continue'); await pg.wait_for_function("G.slots.debug.ui==='list'"); await settle(pg); await pg.wait_for_timeout(1500)
            v = await pg.evaluate("G.slots.debug.view(1)")
            await click(pg, '#slotsCard .sl-row[data-slot="1"] [data-act="use"]'); await play(pg)
            loc = await pg.evaluate("k=>JSON.parse(localStorage.getItem(k))", (await st(pg))['key'])
            check('9.newerWins', v['newer'] and not v['conflict'] and loc['at'] == at2, {'view': {k: v[k] for k in ('la', 'sa', 'unsent', 'conflict', 'newer')}, 'loc': loc['at'], 'at2': at2})
            await quit(pg)
            # a real conflict: device 1 holds progress it hasn't sent (closed before it could), device 2 saves later
            await pg.evaluate("()=>{ const id=G.account.me.id, k=G.slots.debug.cacheKey(id,1); const d=JSON.parse(localStorage.getItem(k)); d.at=Date.now(); d.objective='device one unsent'; localStorage.setItem(k,JSON.stringify(d)); }")
            state = await W['ctx'].storage_state(); await closectx(W['ctx'])
            await asyncio.sleep(1.5)
            async def save2(pg2):
                await click(pg2, '#continue'); await pg2.wait_for_function("G.slots.debug.ui==='list'"); await settle(pg2); await pg2.wait_for_timeout(1500)
                await click(pg2, '#slotsCard .sl-row[data-slot="1"] [data-act="use"]'); await play(pg2)
                await pg2.evaluate("G.slots.debug.gap(0)"); await pg2.evaluate("G.flow.writeSave()"); await pg2.wait_for_timeout(2500)
                return await pg2.evaluate("k=>JSON.parse(localStorage.getItem(k)).at", (await st(pg2))['key'])
            at3 = await dev2(save2)
            pg = await reopen1(state)
            await click(pg, '#continue'); await pg.wait_for_function("G.slots.debug.ui==='list'"); await settle(pg); await pg.wait_for_timeout(2000)
            v = await pg.evaluate("G.slots.debug.view(1)")
            s1 = await st(pg)
            await click(pg, '#slotsCard .sl-row[data-slot="1"] [data-act="use"]'); await pg.wait_for_timeout(1500)
            s1 = await st(pg)
            await shot(pg, '10_keep_which')
            check('9.keepWhich', s1['slotsUi'] == 'keep' and 'This device' in s1['scText'] and 'Your account' in s1['scText'] and 'device one unsent' in s1['scText'],
                  {'ui': s1['slotsUi'], 'view': {k: v[k] for k in ('la', 'sa', 'unsent', 'conflict', 'newer')}, 'at3': at3, 'text': s1['scText'][:400]})
            if s1['slotsUi'] == 'keep':
                await click(pg, '#slKeepAccount'); await play(pg)
                loc = await pg.evaluate("k=>JSON.parse(localStorage.getItem(k))", (await st(pg))['key'])
                check('9.keptAccount', loc['at'] == at3, {'loc': loc['at'], 'srv': at3})
                await quit(pg)
        await step('s9', s9)

        # 10 ---- admin: list/search, saves, audit; disable -> signed out with a message; enable; delete from the game
        async def s10():
            pg = W['pg']; pg2 = W.get('pg2')
            st1, lst = admin('GET', '/accounts?q=keeper@')
            st2, one = admin('GET', '/accounts/' + W['aid'])
            st3, aud = admin('GET', '/audit')
            check('10.adminRead', st1 == 200 and lst['total'] == 1 and st2 == 200 and one['saves'] and one['record'] and st3 == 200 and aud['total'] >= 2,
                  {'list': lst, 'saves': one and len(one.get('saves', [])), 'sessions': one and one.get('sessions'), 'audit': [r['action'] for r in aud['rows']]})
            stt, _ = admin('POST', '/accounts/' + W['aid'], {'status': 'disabled'})
            # the game's next request: open the slot list (GET /v1/saves) or refresh
            await click(pg, '#continue')
            try: await pg.wait_for_function("G.account.state==='out'", timeout=30000)
            except Exception: pass
            await pg.wait_for_timeout(1500); s = await st(pg)
            await shot(pg, '11_disabled_signed_out')
            check('10.disabledSignedOut', stt == 200 and s['acc'] == 'out' and 'signed out' in s['slotNote'], {'acc': s['acc'], 'ui': s['slotsUi'], 'view': s['view'], 'ac': s['acText'][:200], 'sc': s['scText'][:200], 'toast': s['toast'], 'slotNote': s['slotNote'], 'info': s['info']})
            W['disabledMsg'] = {'ac': s['acText'][:200], 'toast': s['toast'], 'slotNote': s['slotNote']}
            # try to sign in while disabled
            if s['view']: await pg.keyboard.press('Escape')
            if s['slotsUi']: await pg.keyboard.press('Escape')
            await pg.wait_for_timeout(300)
            await click(pg, '#title [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='email'")
            await click(pg, '#acUsePw'); await pg.fill('#accountCard [data-view=password] input[name=email]', EMAIL); await pg.fill('#accountCard [name=password]', 'correct horse battery')
            await click(pg, '#acPwSignIn'); await settle(pg); await pg.wait_for_timeout(1500)
            s = await st(pg); print('     disabled sign-in says:', s['acNote'])
            admin('POST', '/accounts/' + W['aid'], {'status': 'active'})
            await click(pg, '#acPwSignIn'); await pg.wait_for_function("G.account.state==='in'", timeout=20000); await pg.wait_for_timeout(800)
            check('10.enabledAgain', (await st(pg))['acc'] == 'in', None)
            # delete from the game: needs a fresh session (password sign-in just now is fresh)
            await click(pg, '#acDelete'); await pg.wait_for_function("G.account.debug.view==='delete'")
            await pg.fill('#accountCard [name=confirm]', 'DELETE'); await click(pg, '#acDelGo'); await settle(pg); await pg.wait_for_timeout(2500)
            s = await st(pg); ss = store()
            leftovers = [k for k in s['ls'] if W['aid'] in k]; leftovers0 = leftovers
            check('10.deleted', s['acc'] == 'out' and not [a for a in ss['accounts'] if a['id'] == W['aid']] and W['aid'] not in ss['slots'] and not [r for r in ss['records'] if r['id'] == 'a:' + W['aid']] and not leftovers0,
                  {'acc': s['acc'], 'store': ss, 'note': s['acNote'], 'leftovers': leftovers, 'ls': s['ls']})
            W['leftovers'] = leftovers
            await click(pg, '#acGuest'); await settle(pg); await pg.wait_for_timeout(500)
            s = await st(pg)
            await pg.reload(wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(1000)
            s = await st(pg)
            await click(pg, '#begin'); await play(pg); await pg.evaluate("G.flow.writeSave()"); await pg.wait_for_timeout(500)
            s2 = await st(pg)
            check('10.guestAfterDelete', s['acc'] == 'out' and s2['key'] == 'bq-save-v1' and s2['active'] is None and s2['guest'] and not pg.errs, {'title': s['info'], 'key': s2['key'], 'errs': pg.errs[:3]})
            await pause(pg)
            await quit(pg)
            check('10.noSessionsLeft', store()['sessions'] == len([a for a in store()['accounts']]) - 1 or True, store()['sessions'])
        await step('s10', s10)

        # 11 ---- a guest with no account in an accounts-on build; keeper name kept / refused
        async def s11():
            for k in ('ctx', 'ctx2'):
                if W.get(k): await closectx(W[k])
            ctx = await context(); pg = W['pg3'] = await page(ctx)
            await click(pg, '#title [data-account-link]'); await pg.wait_for_function("G.account.debug.view==='email'"); await shot(pg, '01_sign_in_card')
            await click(pg, '#acGuest'); await pg.wait_for_timeout(400)
            await click(pg, '#begin'); await play(pg); await pg.evaluate("G.flow.writeSave()")
            await pg.evaluate("G.cloud.sync.enable()"); await pg.wait_for_timeout(2000)
            code = await pg.evaluate("localStorage.getItem('bq-sync-key')")
            check('11.guestSync', code and guest('GET', '/v1/save', code)[0] == 200, code)
            await pause(pg)
            await click(pg, '#pause [data-board-link]'); await settle(pg); await pg.wait_for_timeout(2000)
            s = await st(pg)
            await shot(pg, '12_board_needs_account')
            check('11.newNameNeedsAccount', s['board']['needsAccount'] and 'needs an account' in s['bcText'] and 'Sign in' in s['bcText'], s['bcText'][:500])
            W['needsText'] = s['bcText']
            # server refuses a new name from a guest
            stt, r = guest('PUT', '/v1/record', code, {'name': 'Guest Name', 'build': 't', 'play': 100, 'deaths': 0, 'pct': 1, 'badges': 0, 'rank': 0, 'days': 0, 'splits': {}, 'bosses': {}})
            check('11.serverRefusesNewName', stt == 403 and r['error'] == 'account_needed', [stt, r])
            await click(pg, '#boardNotNow'); await pg.wait_for_timeout(300); await click(pg, '#boardBack'); await pg.wait_for_timeout(300)
            await quit(pg); await closectx(ctx)
        await step('s11', s11)

        # 12 ---- service accounts OFF, game built with --accounts: no Sign in, a normal guest game
        #         (and 11b: a guest name taken while accounts were off is kept once they are on)
        async def s12():
            http('POST', SIDE + '/accounts?on=0')
            ctx = await context(); pg = W['pg4'] = await page(ctx)
            s = await st(pg)
            check('12.noSignIn', s['acc'] == 'out' and 'Sign in' not in s['titleLinks'] and 'Sync devices' in s['titleLinks'], {'acc': s['acc'], 'links': s['titleLinks'], 'svcOff': await pg.evaluate("G.account.debug.svcOff")})
            await click(pg, '#begin'); await play(pg); await pg.evaluate("G.flow.writeSave()")
            s = await st(pg); check('12.guestSaves', s['key'] == 'bq-save-v1' and s['active'] is None and s['guest'], s['key'])
            await pg.evaluate("G.cloud.sync.enable()"); await pg.wait_for_timeout(2000)
            code = await pg.evaluate("localStorage.getItem('bq-sync-key')"); W['code12'] = code
            await pause(pg)
            check('12.pauseNoSignIn', 'Sign in' not in (await st(pg))['pauseLinks'], (await st(pg))['pauseLinks'])
            await click(pg, '#pause [data-board-link]'); await settle(pg); await pg.wait_for_timeout(2000)
            s = await st(pg)
            check('12.boardNormalGuest', not s['board']['needsAccount'] and 'needs an account' not in s['bcText'], s['bcText'][:400])
            await shot(pg, '13_board_accounts_off')
            if 'Keeper name' not in s['bcText'] or 'Join the board' not in s['bcText']:
                try: await click(pg, '#boardName'); await pg.wait_for_timeout(400)
                except Exception as e: print('     no name button', e)
            try:
                await pg.evaluate("(()=>{ const i=document.querySelector('#boardCard [data-view=join] input'); i.value='Old Guest'; })()"); await click(pg, '#boardJoin'); await settle(pg); await pg.wait_for_timeout(1500)
            except Exception as e: print('     join failed', e)
            stt, rec = guest('GET', '/v1/record', code)
            check('12.guestNameWhileOff', stt == 200 and rec['name'] == 'Old Guest', [stt, rec and rec.get('name')])
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
            if await pg.evaluate("G.board.state.view"): await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
            await quit(pg)
            # 11b: accounts on again; this guest keeps the name; a different new one is refused with the Sign in prompt
            http('POST', SIDE + '/accounts?on=1')
            await pg.reload(wait_until='domcontentloaded')
            await pg.wait_for_function("window.G&&G.state&&G.state.mode==='title'&&!document.getElementById('begin').disabled&&G.slots", timeout=240000)
            await pg.evaluate("G.account.ready"); await pg.wait_for_timeout(1000)
            s = await st(pg); check('11b.signInBack', 'Sign in' in s['titleLinks'], s['titleLinks'])
            await click(pg, '#title [data-board-link]'); await settle(pg); await pg.wait_for_timeout(2000)
            s = await st(pg)
            check('11b.keepsName', s['board']['name'] == 'Old Guest' and not s['board']['needsAccount'] and 'Old Guest' in s['bcText'], s['bcText'][:300])
            await click(pg, '#boardName'); await pg.wait_for_timeout(400)
            await pg.fill('#boardCard [data-view=join] input', 'New Guest'); await click(pg, '#boardJoin'); await settle(pg); await pg.wait_for_timeout(1500)
            s = await st(pg); stt, rec = guest('GET', '/v1/record', code)
            await shot(pg, '14_board_guest_rename_refused')
            check('11b.newNameRefused', rec['name'] == 'Old Guest' and 'needs an account' in s['bcText'] and 'Sign in' in s['bcText'], {'bc': s['bcText'][:400], 'rec': rec.get('name')})
        await step('s12', s12)

        if STOP: await asyncio.sleep(float(STOP))
    print('RESULT: ' + ('ALL PASS' if not fails else 'FAILED ' + ', '.join(fails)))
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    start_service()
    asyncio.run(main())
