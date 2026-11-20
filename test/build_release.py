# Builds the public beta: a self-contained dist/ folder (and a zip of it for itch.io) that makes no request to
# any CDN. Everything the page loads is in the folder: the game modules, Three.js from vendor/, the fonts from
# vendor/fonts/, the music, the sound effects, the icons (icons/, manifest.webmanifest) and the privacy page (privacy.html).
#
#   python3 test/build_release.py --api https://bravequest-api.saturnsites.com
#   python3 test/build_release.py --api ... --version 0.9.0-beta.2 --direct https://nattyman.github.io/bravequest-lighthouse-3d/
#
# --api      the Lighthouse save service (server/). Turns on Sync devices, Send feedback and the progress pings
#            (js/cloud.js, js/beta.js). Leave it out for a build with none of those.
# --version  shown small on the title and pause cards, and sent with feedback. The short git commit is appended.
# --accounts turns on Keeper Accounts (sign in, the account card; js/account.js): BQ_CONFIG.accounts=true. Needs --api.
# --direct   the game's own address (not the itch.io page), for link previews.
# --out      output folder (default dist). The zip is written next to it.
#
# The build turns the Test tools panel off (window.BQ_CONFIG.devtools=false); ?debug in the address still opens it.
import argparse, json, os, re, shutil, subprocess, sys, zipfile

here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
ap = argparse.ArgumentParser()
ap.add_argument('--api', default='')
ap.add_argument('--version', default='0.9.0-beta.1')
ap.add_argument('--direct', default='')
ap.add_argument('--accounts', action='store_true')
ap.add_argument('--out', default=os.path.join(root, 'dist'))
a = ap.parse_args()

def fail(msg):
    print('build_release: ' + msg, file=sys.stderr); sys.exit(1)

if a.api and not re.match(r'^https://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$', a.api) and not a.api.startswith('http://localhost'):
    fail('--api must be an https:// address (or http://localhost for a local test)')
try:
    sha = subprocess.check_output(['git', '-C', root, 'rev-parse', '--short', 'HEAD'], text=True, stderr=subprocess.DEVNULL).strip()
except Exception:
    sha = ''
version = a.version + ('+' + sha if sha else '')

s = open(os.path.join(root, 'index.html'), encoding='utf-8').read()

# 1. local Three.js and local fonts
s = s.replace('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'vendor/three/three.min.js')
s = s.replace('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/', 'vendor/three/examples/')
s, n = re.subn(r'<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\n?', '', s)
if n == 0: fail('expected the Google Fonts links in index.html')

# 2. every module on disk must be in the page (index.html is the list; a forgotten one would ship a broken game)
listed = re.findall(r'<script src="(js/[^"]+\.js)"></script>', s)
missing = [m for m in listed if not os.path.exists(os.path.join(root, m))]
unlisted = sorted('js/' + f for f in os.listdir(os.path.join(root, 'js')) if f.endswith('.js') and 'js/' + f not in listed)
if missing: fail('index.html names modules that are not on disk: ' + ', '.join(missing))
if unlisted: fail('modules on disk that index.html does not load: ' + ', '.join(unlisted))

# 3. the beta's settings, before the first module
cfg = {'version': version, 'devtools': False}
if a.api: cfg['api'] = a.api.rstrip('/')
if a.direct: cfg['direct'] = a.direct
if a.accounts:
    if not a.api: fail('--accounts needs --api')
    cfg['accounts'] = True
first = '<script src="vendor/three/three.min.js"></script>'
if first not in s: fail('could not find the Three.js script tag')
s = s.replace(first, '<script>window.BQ_CONFIG=' + json.dumps(cfg) + ';</script>\n' + first, 1)

# 4. a proper document: index.html is a fragment (title, style, then the page)
cut = s.find('</style>')
if cut < 0: fail('could not find the end of the style block')
head, body = s[:cut + 8], s[cut + 8:]
desc = 'A gentle gothic adventure in your browser. The great lamp is dark, the fog is coming in, and the moths were never after the light.'
meta = ['<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
        '<meta name="description" content="' + desc + '">',
        '<meta name="theme-color" content="#1c1520">',
        '<meta property="og:title" content="Brave Quest: Lighthouse">',
        '<meta property="og:description" content="' + desc + '">',
        '<meta property="og:type" content="website">',
        '<link rel="stylesheet" href="vendor/fonts/fonts.css">',
        # the lantern icon: browser tab, bookmarks, and the home-screen icon on phones (iOS reads apple-touch-icon,
        # not the favicon; Android reads the manifest)
        '<link rel="icon" href="icons/favicon.ico" sizes="48x48">',
        '<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">',
        '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
        '<link rel="manifest" href="manifest.webmanifest">',
        '<meta name="apple-mobile-web-app-title" content="Lighthouse">']
if a.direct: meta.append('<meta property="og:url" content="' + a.direct + '">')
doc = '<!doctype html>\n<html lang="en">\n<head>\n' + '\n'.join(meta) + '\n' + head + '\n</head>\n<body>\n' + body.strip() + '\n</body>\n</html>\n'

# 5. nothing may load from another site (the save service is called by script, not loaded)
ext = sorted(set(re.findall(r'(?:src|href)="(https?://[^"]+)"', doc)))
if ext: fail('the page still loads from other sites: ' + ', '.join(ext))

# 6. write dist/: the page and only what it needs at run time
out = os.path.abspath(a.out)
if os.path.exists(out):
    if not os.path.exists(os.path.join(out, '.bq-release')): fail(out + ' exists and was not made by this script; remove it or pass --out')
    shutil.rmtree(out)
os.makedirs(out)
open(os.path.join(out, '.bq-release'), 'w').write(version + '\n')
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(doc)
files = listed + re.findall(r'<script src="(vendor/[^"]+)"></script>', doc)
for d in ('audio', 'sfx', 'icons', os.path.join('vendor', 'fonts')):
    for dp, _, fs in os.walk(os.path.join(root, d)):
        files += [os.path.relpath(os.path.join(dp, f), root) for f in fs if not f.startswith('.')]
files.append('manifest.webmanifest')
files.append('privacy.html')   # the privacy page the account card links to (static: no scripts, nothing from other sites)
files.append(os.path.join('vendor', 'three', 'LICENSE'))   # Three.js is MIT: its licence text travels with it
for f in files:
    src = os.path.join(root, f)
    if not os.path.exists(src): fail('missing file: ' + f)
    dst = os.path.join(out, f); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)

# 6b. the privacy page must stay self-contained, like the game
pv = open(os.path.join(root, 'privacy.html'), encoding='utf-8').read()
if re.search(r'<script|(?:src|href)="(?:https?:)?//', pv, re.I): fail('privacy.html must have no scripts and load nothing from other sites')

# 7. the zip for itch.io (index.html at the top level)
zname = os.path.join(os.path.dirname(out), 'bravequest-lighthouse-' + re.sub(r'[^A-Za-z0-9._-]', '-', a.version) + '.zip')
total = 0; count = 0
with zipfile.ZipFile(zname, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, _, fs in os.walk(out):
        for f in sorted(fs):
            if f == '.bq-release': continue
            p = os.path.join(dp, f); z.write(p, os.path.relpath(p, out)); total += os.path.getsize(p); count += 1
print('version   ' + version)
print('save api  ' + (cfg.get('api') or '(none: no sync, feedback or pings)'))
print('folder    ' + out + '  (' + str(count) + ' files, ' + ('%.1f' % (total / 1e6)) + ' MB)')
print('zip       ' + zname + '  (' + ('%.1f' % (os.path.getsize(zname) / 1e6)) + ' MB)')
if count > 1000 or total > 500e6: fail('over itch.io limits for a browser game (1,000 files, 500 MB)')
