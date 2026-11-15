"""Charset check (~30 s): loads index.html itself (not dev.html) from the plain `python3 -m http.server`, which sends
`Content-Type: text/html` with no charset. Without a <meta charset="utf-8"> in index.html the browser falls back to
windows-1252 and every curly quote, dash and middle dot (in the page and in the js/*.js modules, which are decoded
with the page's encoding) turns into junk like ’ and Â·.
usage: python3 test/charset_e2e.py [url]   (default http://localhost:8800/dev.html?debug&headless)
The url may name dev.html (as CI passes it); the suite swaps it for index.html. The CDN copies of Three.js are served
from vendor/ so the check needs no network; Google Fonts are blocked (not needed here).
"""
import asyncio, sys, os, time, json
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8800/dev.html?debug&headless'
URL=URL.replace('/dev.html','/index.html')
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CDN=[('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js','vendor/three/three.min.js'),
     ('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/','vendor/three/examples/')]
JUNK=['â€','Â']   # how ’ “ — … and · look when UTF-8 bytes are read as windows-1252
async def main():
    t0=time.time(); errs=[]; fails=[]
    def check(name,ok,info):
        print(('ok  ' if ok else 'FAIL'),f'{name:22s}',json.dumps(info,ensure_ascii=False)[:300])
        if not ok: fails.append(name)
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg=await b.new_page(viewport={'width':960,'height':600})
        pg.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
        async def route(r):
            u=r.request.url
            for pre,loc in CDN:
                if u.startswith(pre):
                    return await r.fulfill(path=os.path.join(ROOT,loc+u[len(pre):]),content_type='application/javascript')
            await r.abort()
        await pg.route('https://**/*',route)
        resp=await pg.goto(URL,timeout=180000); await pg.wait_for_timeout(4000)
        print('     served as', resp.headers.get('content-type'))
        cs=await pg.evaluate('document.characterSet')
        check('document is UTF-8',cs.lower()=='utf-8',cs)
        chip=await pg.evaluate("(document.getElementById('staffChip')||{}).textContent||''")
        check('page text intact','Keeper\'s Staff · hold attack' in chip and not any(j in chip for j in JUNK),chip)
        # a string that lives in a module (js/flow.js), shown once the game begins
        txt=await pg.evaluate("document.getElementById('begin').click(); G.step(1/30,90); document.body.innerText")
        hit=[l for l in txt.split('\n') if 'keeper’s cottage' in l]
        check('module text intact',bool(hit),hit[:1] or [l for l in txt.split('\n') if 'keeper' in l][:2])
        bad=[l for l in txt.split('\n') if any(j in l for j in JUNK)]
        check('no mojibake on screen',not bad,bad[:3])
        await b.close()
    for e in errs[:10]: print('  ',e[:300])
    ok=not fails and not errs
    print('RESULT',('PASS' if ok else 'FAIL'),f'{time.time()-t0:.0f}s'); sys.exit(0 if ok else 1)
asyncio.run(main())
