# Brave Quest: Lighthouse — module contract

Read this whole file before writing code. Several agents build modules in parallel; this contract is how they fit together. **Never edit `js/core.js`, `index.html`, or another agent's module.** If you need something core lacks, implement it inside your own module (namespaced under your module) and mention it in your final report.

## Project layout
```
index.html        page shell + HUD DOM (owned by lead)
dev.html          generated for local tests: python3 test/build_dev.py   (never edit by hand)
js/core.js        engine + shared API (lead)           -> window.G
js/world.js       island terrain, sea, sky, vegetation, buildings  (World agent)
js/lighthouse.js  tower on the cliff, interior stairs, staff, lamp cure  (Lighthouse agent)
js/combat.js      technique table, names/pause list, aim reticle + raycast, ether bursts (loaded before player.js)
js/player.js      the Traveler, controller, camera, combat, lantern + staff models  (Player agent)
js/creatures.js   moths, corruption patches, passive negatives, Halloran  (Creatures agent)
js/monsters.js    hostile monsters + boss  (Creatures agent)
js/flow.js        quest beats, checkpoints, pickups, title/attract camera  (lead)
js/hud.js         HUD, menus, touch buttons  (lead)
vendor/three      local Three.js r128 + examples/js (for dev.html only)
```
Load order: three → postprocessing → core → world → lighthouse → combat → player → creatures → monsters → flow → hud → … → undercroft_boss → companions → … → the north modules → record → badges → board → account → slots → cloud → beta → `G.start()`.
Every module is a plain script wrapped in an IIFE: `(function(){ 'use strict'; const G=window.G, THREE=G.THREE; ... })();`
Three.js is **r128** (UMD global). No ES modules, no imports, no other libraries, no network assets. All textures are procedural (canvas) — see `G.canvasTex`.

## Art direction — "The Gentle Gothic"
Style guides (already read by the lead; summary here):
- **Soft cel shading, readable silhouettes, warm refuge / cold wilderness.** Fairytale melancholy, not horror.
- Dusk: violet-plum sky with a pink horizon glow, slate-blue fog, sea stacks and rock spires offshore. Warm amber light only from human places (cottage windows, hanging lanterns). Ether is luminous violet; corruption is matte black void with oily sheen.
- Palette (`G.PAL`): fogIvory #e8e2d4, slateBlue #4d5a6a, pineBlack #18241f, stone #8b857b, amber #e3a13a, ether #9150ff, corruption #0a090c; character: deepViolet #4b3863, duskyPlum #6c3f5f, umber #6a4a2e, gold #c8a24c.
- Materials: rounded weathered stone, dark timber, slate roofs, matte wool. Twisted old oaks with spreading canopies, dark pines, violet and white wildflowers, mossy stone walls.
- Use `G.toon(color, opts)` (MeshToonMaterial with the shared 4-band gradient) for almost everything. Add outlines with `G.outline(mesh,{thickness})` on characters, creatures and key props (not on terrain/grass/instanced foliage).
- Bloom is on (threshold ~0.72): only ether, lanterns, windows and magic should exceed it.

## Geography (shared coordinates — everyone uses these)
+x = east, +z = south, y up, sea level y=0. The island is long east–west.
| place | where |
|---|---|
| Island extent | x ≈ −230…230, z ≈ −95…95, irregular coast, beaches on the south side of the moor |
| **Forest** (west end) | x < −70. Dense twisted oaks + pines, undergrowth, mossy rocks, fog thicker. Gentle hills, ground y ≈ 6–14 |
| **Resisting Tree** clearing | (−165, ·, 5), clearing radius 14, no trees inside except the giant old tree at the centre; faint warm/violet glow. The lantern lies at its roots: `lanternSpot` ≈ (−160, ·, 9) |
| **Moor** (middle) | x −70…110, rolling heath, y ≈ 6–16. Ruined **hamlet** of 3–4 broken cottages at (−20, ·, 30). Standing stones at (40, ·, −35) |
| **Cliff path** | switchback ramp from `cliffPathBottom` (95, ·, 12) up to `cliffPathTop` (135, 42, 2), walkable (slope < 50°) |
| **Headland** (east end) | plateau x 130…215, z −45…45, flat top at **y = 42**, sheer cliffs on N, E, S down to the sea |
| **Lighthouse** | centre (180, 42, 0). World keeps a flat stone apron radius 9 at exactly y=42. **Door faces west (−x)**. |
| Keeper's cottage | (158, 42, 24), warm windows, chimney; small alchemy shed (150, 42, 33) |
| Player start | (164, 42, −4), facing the door (yaw toward +x) |
| Halloran | near the top of the cliff path (124, ·, 16) |
| Finale arena | cliff top around the lighthouse, centre (165, 42, 0), r 28 |

`G.world.landmarks` (world.js fills **synchronously at script-evaluation time**, all y = ground height):
```
start:{x,y,z,yaw}  lighthouse:{x,y,z}  cottage:{x,y,z}  shed:{x,y,z}  halloran:{x,y,z}
resistingTree:{x,y,z,r}  lanternSpot:{x,y,z}  hamlet:{x,y,z}  stones:{x,y,z}
cliffPathBottom:{x,y,z}  cliffPathTop:{x,y,z}  finale:{x,y,z,r}
patches:[{x,y,z}]            // 8–10 corruption patches on moor + forest, none within 20 m of the lighthouse
mushrooms:[{x,y,z}]          // glowing violet mushroom clusters (healing pickups), ~14, near forest edges/ruins
negativeHomes:[{x,y,z,kind}] // 8 passive negatives: kind 'stag'|'fox'|'hare'|'heron' (companions.js adds a 9th, the raven, on the standing stones)
monsterZones:[{name,x,z,r,kinds:[...],count}]  // e.g. forest {x:-130,z:0,r:50,kinds:['hollow','hound'],count:6}, hamlet {x:-20,z:30,r:22,kinds:['hollow'],count:3}, moor {x:55,z:-10,r:30,kinds:['hound'],count:3}
path:[{x,z}]                 // centreline of the trail from lighthouse → cliff path → hamlet → Resisting Tree
```

## Core API (window.G) — summary; read js/core.js for details
- `G.scene, G.camera, G.renderer, G.lights.{hemi,sun,sunDir}, G.focus` (Vector3: player sets it every frame; sun shadow follows it)
- `G.U` utils: clamp, lerp, smooth, damp, angDiff, dampAngle, dist2, hash, vnoise, fbm, rng(seed), col(hex→linear Color)
- `G.PAL`, `G.tex.{soft,flame,moth}`, `G.canvasTex(size,draw,srgb)`, `G.toon(c,opts)`, `G.outline(mesh,opts)`, `G.negMaterial({rim,strength})` (uniforms uFade 1→0 dissolve, uFlash hit flash)
- Events: `G.on(name,fn)`, `G.emit(name,data)`
- Systems: `G.system(name,{order,modes,init(),update(dt)})`. `modes` default `['play','dead']`; use `'always'` for ambient animation (water, grass, moths drifting) that should also run on the title screen. `init()` runs once after all scripts load — build meshes there.
  - Orders: world 0–9 · lighthouse 10 · player 20 · creatures 30 · monsters 40 · projectiles 45 · flow 60 · camera 80 (player.js) · hud 90 · sunFollow 95
- Modes (`G.state.mode`): `'title'` (attract camera owned by flow.js) · `'play'` · `'paused'` · `'dead'` · `'ending'`. `G.setMode(m)` emits `'mode'`.
- Flags: `G.flag('lanternFound', true)`; `G.flag('x')` reads.
- Atmosphere: `G.atmo.darkTarget` (lighthouse sets 1 when the player is inside the unlit tower body), `G.atmo.dark` (core damps it), `G.atmo.cured` 0..1 (lighthouse animates during the cure). world.js reads these every frame to set fog/sky/hemi.
- Items: `G.items.lantern {found,carried,shut,cured,inCradle,pos,world,lit()}` and `G.items.staff {owned,pos}`.
  `G.items.storm {found,carried,inCradle,failed,spent,pos,world,lit()}` (lighthouse.js): Halloran's plain storm lantern; it opens the doorway like the keeper's, moths ignore it.
- Beam: `G.lighthouse.beam = {yaw(), lit, arms:2, origin, dir(out), gutter(seconds), guttering}` — heading convention: one arm points along (sin yaw, 0, cos yaw), the other along yaw()+π; before the cure it's the anti-light beam (`lit` false), after it the warm beam. `gutter(s)` makes the warm beam stutter and dim for s seconds.
- Act 1 hooks: `G.monsters.startStag()` / `stagArena()`, `G.creatures.halloranAt(pos|null, yaw)`, `G.flow.stagDead`, `G.flow.stagEdge()`.
- World queries: `G.world.height(x,z)`, `G.world.walkable(x,z)`, `G.floorAt(x,z,y)` (terrain + floor providers), `G.floorProviders.push(fn(x,z,y)->h|null)`, `G.constrainers.push(fn(prev,next,y,radius,who)->blocked)`, `G.cameraConstrainers.push(fn(cam,target))`, `G.addCollider({x,z,r,y0,y1})`, `G.addBoxCollider({x,z,hw,hd,yaw,y0,y1})`. `G.world.plantClearings.push({x,z,r})` at script-evaluation time keeps ferns and bushes out of a small place (both the plant kit and the old plants honour it).
- **Movement for every character:** `G.moveCharacter(pos, dx, dz, radius, who)` → handles circles, boxes, constrainers, walkability, max step 0.65 m and steep slopes (>~54° blocks — cliffs are walls). Then set `pos.y` from `G.floorAt(pos.x,pos.z,pos.y)` with your own gravity. A collider stands only where something is drawn: if a mesh is hidden (a quality cut, a prop not there yet), take its collider out with it (`G.removeCollider`). `test/barriers_e2e.py` sweeps the home island for colliders with nothing drawn inside them, on every quality level.
- Interaction: `G.interact.add({pos|()=>pos, radius, label|()=>label, priority, enabled:()=>bool, use()})`. player.js calls `G.interact.pick(playerPos)` each frame and `use()`s the current one on the interact action. HUD shows `G.interact.current`. Extra per-frame prompt rows: `G.hint('F','Close the shutter')`.
- Combat: hurtbox `{team:'player'|'enemy'|'neutral', pos:Vector3 (feet), radius, height, alive:()=>bool, hit(info), targetable, name, corrupt:bool, lockOffset}` registered with `G.combat.add(hb)`. `G.combat.strike({x,y,z,radius,team,damage,knockback,kind,source,element,exclude:Set})`, `G.combat.nearestTarget(from,maxDist,dirVec)`, `G.combat.spawnProjectile({pos,vel,radius,team,damage,life,kind,mesh,knockback,gravity,element,onHit,onEnd})`. `element` names what a blow is made of (e.g. `'fire'`, null for a plain one); a projectile hands its own `element` to every strike it makes.
  - `info = {damage, dir (unit Vector3 from attacker to target, horizontal), knockback, kind:'melee'|'bolt'|'shockwave'|'swarm'|'charge'|'bite'|'burn'|'blast', source, element}`
  - `kind:'burn'` (an oil's burn tick, oils.js) takes health only: no flinch, knockback or re-aggro; it can kill, and the kill is the player's. `kind:'blast'` (a burst) is treated like `shockwave`. Who reacts to either is up to the module that owns the hurtbox.
  - **Damage units are half-hearts.** Player starts with maxHp 4 (2 hearts); progression.js derives maxHp (max 14, 7 hearts).
- UI calls (hud.js implements): `G.ui.say(text, who?, {priority:'high'|'normal'|'low', key})` (every line is also kept in the message log, pause menu > Messages; reading time is the player's choice: `G.ui.captionSpeed` 'relaxed'|'standard'|'hold'; `G.ui.advance()` = Enter / D-pad down / a tap on the caption), `G.ui.objective(text, sub?)`, `G.ui.toast(title, small?)`, `G.ui.bossBar(name|null, frac)`, `G.ui.flash()`, `G.ui.shake(amount)`.
- HUD read-outs for tests (hud.js): `G.ui.captionStack()` → `{depth (back cards showing, 0–2), count ('+N' when 3+ lines wait, else ''), who:[names on the back cards], leaving}` — waiting captions show as a stack of card edges behind the front one (decoration only; the queue/pacing rules are unchanged); `G.ui.staminaWheel()` → `{shown, state:'ok'|'low'|'exh'|'full'|'', opacity, frac}`; `G.ui.padStatus()` → `{state:'connected'|'none'|'blocked'|'unsupported', text}` (the controller line in the pause menu and on the Controls screen, `[data-pad-status]`).
- Cut scenes (onboarding.js): `G.cine.play(id,{dur,shot(k,t,out),onEnd,...})` letterboxed, plays once per save (`seen` is in the save),
  skipped by any key, tap, or the attack/jump/interact/roll/lock/sprint/shutter/potion/pause/advance actions (so any pad button), after 0.4 s.
  `shot` sets `out.cp`/`out.lp`/`out.fov` each frame. `G.cine.path(id,{path:[V3],look:[V3],fromCamera,fov,dur,hold,...})` drives the camera
  along a Catmull-Rom spline (eased by arc length; `fromCamera` starts at the follow camera, looking at Rowan). Options for both:
  `safe` (Rowan takes no hits, prompt rows hidden), `hud:false` (hearts, objective, pause button, quest marker hidden), `music` (a
  `G.audio.music.setOverride` state for the shot, e.g. `'wistful'`, restored after), `handBack:{yaw,pitch}` (or a fn) for the follow camera,
  `fadeOut` (s, dip to black at the end). Read-outs: `G.cine.on/id/safe/clean/t/dur/seen(id)`, `G.cine.skip()`. Event `cine` {on,id}.
  Game time only (deterministic under `G.step`, runs under `?headless`). Tests skip shots with `G.cine.skip()`.
  The opening shot (`'opening'`, after `wake:done` with `windows`) is owed until it plays: it waits for a calm moment (no card, boss,
  map, fall, roll, hurt or death) and plays wherever Rowan is (from the sand, partway up the cliff path, or on the headland: the reveal
  alone), handing back facing on along the route. It is let go once he is at the cottage or the step has moved past `cottage`.
- Pickups (flow.js implements): `G.pickups.spawn('heart'|'mushroom', pos)`.
- Companions (js/companions.js, COMPANIONS.md): `G.companions = {ember, corvin, has(id), send(id), call(id), spots, shardSpots, names, raven, debug}`;
  `send('ember')` = R (at a fox spot: go; else heel), `send('corvin')` = T (at a raven spot: go; else scout, 45 s cooldown). Hooks it uses:
  `G.creatures.claimFreed(n, rig)` (the first freed fox), `G.creatures.addCustom(n)` / `freeCustom(n)` (the raven negative), `G.creatures.halloranHooks`,
  `G.monsters.interrupt(m)` / `delay(m, s)` (never bosses), `G.progress.grantShard(id)`, `G.map.markSeen(id)` / `isSeen(id)`, `G.ui.padRowHooks`,
  `G.ui.refreshLegends()`, `G.devtools.teleports`. Persist key `companions`. Neither companion has a hurtbox.
- Map + fast travel (js/map.js): `G.map.open()/close()`, `G.map.addMarker({...})`, `G.map.waypoints`, `G.map.travelBlock(id)` → reason
  string or null, `G.map.travel(id)`. Eight waystones (lighthouse, cottage, cliff-path foot, standing stones, hamlet road, Resisting
  Tree, sea cave, the Undercroft) unlock when first visited; travel is chosen in the open map (click/tap, Tab+Enter, LB/RB+A) through a confirm card.
  Travel uses `G.player.teleport` and, for the sea cave, `G.cave.enter('mouth',{instant:true})` / `G.cave.exit({instant:true})`;
  for the Undercroft, `G.undercroft.enter('stair',{instant:true})` / `G.undercroft.exit({instant:true})` (UNDERCROFT.md).
  It refuses during boss fights (the Tithe-Keeper's too), the Act 1 finale, while Hesper's corrupted lantern or a swarm follows you, while the lantern rides
  the cave raft, with monsters hunting you within 30 m, mid-air, and to a destination under the fog.
- Input actions: `forward back left right jump sprint roll attack lock interact shutter potion pause advance glass fox raven oil` (oil = V: dress the staff with a carried flask (oils.js); while at least one flask is carried (`G.oils.armed()`), the draught action (H, D-pad up, the touch bottle) also waits for its release: let go within .3 s and it drinks as before, hold it .3 s and it is `oil` once; with no flask the draught acts on the press; advance = Enter or controller D-pad down: next caption; glass = hold G, or hold Y on a controller once the Remembering Glass is owned — a Y tap stays interact, sent on release; touch: the Glass button; fox = R / D-pad left / the fox touch button, raven = T / D-pad right / the raven touch button — companions.js, shown once each companion is earned). Sprint on touch: the Sprint button (hud.js) drives the same `sprint` input with `setVirtual` — a tap (lifted within .25 s) latches it until another tap, the stick resting near centre for .35 s (1.5 s if tapped before moving), exhaustion, or the game taking control (not `play`, `G.cine.on`, dead, `P.inputEnabled` off); a longer press sprints until the lift. Lock-on and charging keep the latch armed (player.js just doesn't sprint through them). Not saved. `aria-pressed` shows the latch, `.tired` the exhaustion; `G.ui.touchSprint()` → `{latched, held, tired, pressed, shown}` for tests. The D-pad no longer walks. `G.input.down(a)`, `G.input.pressed(a)`, `G.input.released(a)`, `G.input.move()` → {x,y,mag}, `G.input.gamepad` → `{connected,id,name,blocked,error,policy,supported,count,index,mapping,remap}` (policy false = the page's permissions policy forbids 'gamepad'; remap 'xpad'|'generic' for a pad without the standard mapping), `G.input.padState()` → the pad in use in the standard layout `{B,A}` or null, `G.input.look()` → pixel delta this frame, `G.input.wheel`, `G.input.locked`.
- Techniques (`js/combat.js`, loaded before player.js): `G.moves.T` is the tuning table (lunge, sweep, slam, spin, plunge, dive, doubleJump, buffer, aim). `G.moves.performed(id)` names a technique on screen (toast the first time; remembered in localStorage `bq-combos`, listed in the pause menu). `G.moves.raycast(from,dir,max,{start})` → `{point,dist,hb,surface}` against floors, walls (constrainers), colliders, cave ceilings and enemy hurtboxes. `G.moves.burst(pos,{radius,color,life,lightI})` ether ring + flash. `G.moves.noDoubleJump.push(fn(pos)->bool)` forbids the double jump where it returns true. `G.player.move` → `{id, phase, doubleJumped, dived, aiming, aimK, aimPoint, cooldowns}`.
- Keeper Accounts (js/account.js; spec ACCOUNTS.md): `G.account = {on, available, state:'off'|'checking'|'out'|'in', me, ready, can(group), fetch(path,opts),
  open(from), close(), signOut(everywhere), refresh(), debug}`. `on` only with `BQ_CONFIG.api` + `BQ_CONFIG.accounts===true` and the page on the
  service's site (and, under `?headless`, `window.BQ_ACCOUNTS_TEST=true` set before load); otherwise `state` is 'off', nothing shows and `ready`
  is already resolved. `available` is `on` until the service answers `503 accounts_off` (then the Sign in button hides and
  the board treats the player as a guest of a build without accounts). `me = {id,email,name,role,tools,hasPassword,created}`; `can(g)` is true when signed in and `me.tools` has `g`. `ready`
  resolves (with the state) once the first `GET /v1/me` (or a `?signin=` link) has answered. `fetch` is the one way to call the service: a path
  like `'/v1/saves/2'`, fetch options plus `auth:false` (no sync code) and `timeout` (ms, default 15 s); a plain-object `body` is sent as JSON.
  With accounts on it adds `credentials:'include'` and `X-BQ-Client: 1`; unless signed in it adds `Authorization: Bearer <sync code>` when there
  is one; a `401 signed_out` while signed in turns the state to 'out'. With accounts off it is a plain call with the sync code.
- Keepers' Board (js/board.js): `G.board = {open(from), close(), push(), state, debug}`. Every call goes through `G.account.fetch`. Signed in,
  the board belongs to the account (no sync code needed; the keeper name is the account's, re-read with `G.account.refresh()` after a change;
  nothing is uploaded while `G.slots.active()` is a test slot; a `404 no_save` waits for `cloud:saved` / `slots:saved` / `slots:active`).
  With accounts on, a guest with no name is offered **Sign in** (`G.account.open('boardCard')`), also on a `403 account_needed`.
  `account:in` / `account:out` / `account:me` re-read the name and the boards. `state.signedIn / needsAccount / testSlot` for tests.
- Typing: core.js stops game keys in every field that takes typed text (`textarea`, `input` of type text/password/email/search/tel/url/number
  or no type, `contenteditable`); a module never needs its own guard for that.
- `privacy.html` (repo root, static, no scripts) is copied into the release build; the account card links to it.
- Save slots (js/slots.js, after account.js; spec ACCOUNTS.md): `G.slots = {on, list(), active() → {slot,test,name}|null, open(from), close(), use(slot),
  newGame(), rename(slot,name), remove(slot), flush(), debug}`; events `slots:change {}`, `slots:active {slot,test}` (also on the move into a test copy; slot 0 = local test slot), `slots:uploaded {slot,test}` (after every successful upload or claim). Only while signed in: a game
  begun signed in saves into an account slot (localStorage `bq-save-s<n>-<account id>`, uploaded with PUT /v1/saves/<n>); signed out or with
  accounts off every hook answers null/false and saves are exactly as before. `active()` is null for a guest game; `test` is true for a test slot
  and for the local test fallback (`slot:0`). Anything that must not run from a test save (the board, pings) checks `G.testSaves` (set for test
  slots too) or `G.slots.active().test`. `G.flow.keys.active` is the key the game is saving to now; `G.flow.saveRecord(save)` the rank · time ·
  completion spans for a stored save.
- The Keeper's Record (js/record.js; spec RECORD.md): `G.record = {state, MILESTONES, BOSSES, play(), ms(id), split(id), best(id), boss(id),
  completion() → {done,total,pct,parts}, summary(), fmt(s), attempt, debug}` — play time, counters, milestone times and boss attempts, in the save
  (persist key `record`). Badges and rank (js/badges.js): `G.badges = {list() → [{id,cat,name,desc,hint,hidden,got,shown}], has(id), count(), total(),
  nearest() → {id,name,text}|null, rank() → {i,name,next:{name,need}|null}, RANKS, debug}` (persist key `badges`). Both may be missing: guard every use.
- Journal (progression.js): tabs "What you carry" / Record / Badges (`G.progress.journal.tab(t)`; LB / RB or ◀ ▶ switch tabs, the right stick
  scrolls; no Badges tab without `G.badges`). Welcome back: Continue after 12 h away (the save's `record.last`) shows one card before play
  (`G.progress.welcome` = `{due(save), show(save), close(), open, enabled, allowInTests}`; setting in the pause menu, localStorage `bq-welcome`);
  never in `?debug` / headless / test-save sessions unless a test sets `allowInTests`. The title's Continue card shows rank · time played ·
  completion from the stored save (`rec` in the save, written by flow.js's snapshot).
- Test tools (js/devtools.js): `G.devtools` = `{open, cheats, starts, start(id), teleports, openPanel(), closePanel(), toggle(k), setSpeed(n), give(id),
  spawn(kind), kill(), setTide(k), giveSwarm(n), gate, active, groups, can(group), undercroftHooks, templeHooks}`. `gate`: `'all'` in dev builds
  (no `BQ_CONFIG`) and in a public build opened with `?debug`; `'roles'` in a public build with accounts (`G.DEVTOOLS_ROLES`, core.js: `BQ_CONFIG.devtools===false`
  and `BQ_CONFIG.accounts===true`, with `G.account.on`), where `?debug` and the backquote key do nothing by themselves and the panel, its links and
  its sections follow `G.account.can(group)` for the groups `start cheats give map teleport monsters` (re-read on `account:in` / `account:out` /
  `account:me`); `'pending'` until `ready` in such a build; `'none'` if it has no accounts module and no `?debug`. `groups` lists what is shown now.
  In a public build with accounts, `G.devtools` exists even for players (so modules can add teleports and start hooks); check `G.devtools.active`
  before offering anything of your own.
- Staff oils (js/oils.js; spec OILS.md): `G.oils = {OILS, max:3, count(id), total(), full(), add(id,n)->added, take(id,n)->bool, list()->[{id,n,name}],
  armed(), active (null | {id,left}: seconds of play left), fixed (null | id), apply(id)->bool, clear(reason), has(id), strength(id)->0|'fixed'|'coat',
  fix(id), unfix(), burning(target), slowed(target), openPicker(), debug:{give(id,n), coat(id,secs), expire(), state()}}`. `OILS` is a table keyed by
  oil id (`kilnfire` first); flasks are carried on the belt (up to `max`, any mix) and brewed at an alchemy table. Dressing takes about 1.2 s (the
  flask is spent when it starts; no attacking, half speed); the coat then lasts 90 s of play and a new coat replaces it. Effects key a target by
  `hb.oilKey || hb.monster || hb`. Dormant until `G.loop.active`. Persist key `oils`.
- Forage (js/forage.js): `G.forage = {ITEMS, spots:[{id,item,pos,ready,left}], kiln:{pos,noteRead}, tree, debug:{ripen(), pick(id), near(item), tp(id)}}`.
  Spots are saved by `id`, never by index; `left` counts down in play. Kiln pitch (Interact at the old charcoal kiln in the wood, +2) and gorse
  (walk into a bush on the moor or headland, +1-2) both come back after 240 s. Dormant until `G.loop.active`. Persist key `forage`.
- Alchemy and oils: a recipe with `oil:'<id>'` brews a flask (`G.oils.add`) and cannot start while `G.oils.full()`; its `brew` event carries `oil`.
- The Thornback (js/thornback.js, loaded after monsters.js): a big bramble-backed boar of ink, three of them in the deep wood from `loop:start`. It is a monsters.js kind added through `G.monsters.define(kind,{params,name,lockOffset,build,fx,init,update,anim,hit})`, which returns the shared helpers (tokens, movement, leash, `die`); everything else about it lives in its own file. Its bramble hide halves `melee` and `bolt` blows (they glance, no flinch) until it burns off (Kilnfire) or two `shockwave` blows break it; a charge into a tree, rock or wall stuns it (blows x1.5). `G.thornback = {T, homes, list(), startSpot(), debug}`; events `thornback:sfx` {name,pos,how} (audio.js plays them), `thornback:hide` {how:'burn'|'break'}, `thornback:crack`, `thornback:glance`, `thornback:windup` {atk}, `thornback:charge`, `thornback:stun`, `thornback:respawn` {id}. Persist key `thornback` (respawn timers by home id). `monster:killed` {kind:'thornback'} drops 3 ichor (alchemy.js).
- Models: `G.models.lantern()` and `G.models.staff()` are defined by player.js at script-evaluation time and return fresh Object3Ds (other modules may call them in init()).
- The north island from home (js/northveil.js, after north.js): a soft, hazy silhouette of the real island (northisle.js's
  height and sea stacks, traced once into three depth layers plus a band of sea mist; the tower in its true plane, so north.js's
  light at `G.north.pos` sits on it), there from a new game. One mesh, one draw call, one canvas texture; `fog:false`, depth-tested,
  no depth write, `renderOrder` -5 (after the sky, before every other transparent thing). Colour from `G.scene.fog` each frame;
  fades out as the fog thickens (forest, beyond the fog wall, the dark tower), and is hidden in every interior, on the crossing's fog
  leg, on the north island, and when the camera is within ~480 m of it. `G.northVeil = {visible, opacity, built, layers:[{name,z}],
  towerZ, debug:{show(on|null), state(), mesh}}`; `show(true|false)` forces it, `show(null)` hands back. Nothing is saved.

## Events (names are fixed)
| event | data | emitted by |
|---|---|---|
| `ready` | — | core after init |
| `mode` | {mode,prev} | core |
| `player:hurt` | {hp,damage,info} | player |
| `player:dead` / `player:respawn` | {pos} | player |
| `player:attack` | {combo, charged} (combo is 1–3 for swings, or a technique id: 'lunge','sweep','slam','spin','plunge'; bolts add {bolt, great}) | player |
| `player:combo` | {id, name, first} | combat (a technique was performed) |
| `player:doublejump` / `player:dive` | {pos} | player |
| `player:plunge` | {pos, damage, radius, hits, drop, high} | player (the plunge landed) |
| `lantern:pickup` / `lantern:drop` | {pos} | player |
| `staff:pickup` | — | lighthouse (player listens and equips) |
| `door:blocked` | {reason:'dark'|'shut'} | lighthouse |
| `tower:enter` / `tower:exit` | — | lighthouse |
| `lamp:placed` / `lamp:cured` | — | lighthouse |
| `talk` | {who, line, index} | creatures (Halloran) |
| `negative:freed` | {kind,pos} | creatures |
| `monster:killed` | {kind,pos,boss} | monsters |
| `strike` | {hits, team, kind, element, source, x, y, z, radius} | core (`G.combat.strike`, when it hit something) |
| `projectile:end` | {p, hits} | core (a projectile ended: `hits` = what it hit on its last frame, maybe none; `p.exclude` = everything it hit, `p.great` = full charge, `p.pos` = where) |
| `oils:change` | {id, n, total} | oils (flasks on the belt changed) |
| `oil:apply` / `oil:on` / `oil:off` | {id} / {id, dur} / {id, reason} | oils (dressing starts / the coat is on / the coat ends) |
| `oil:ignite` / `oil:burn` | {pos, target} / {pos, target, damage} | oils (a struck target catches / each burn tick) |
| `forage:pick` / `forage:note` | {id, item, n, pos} / {id} | forage (something gathered, kiln pitch included / a note read) |
| `brew` | {recipe, units, oil} | alchemy (`oil` set when the recipe makes a flask) |
| `storm:pickup` | {first} | lighthouse (Halloran's storm lantern, `G.items.storm`) |
| `storm:placed` / `lamp:failed` | — | lighthouse (the plain flame in the cradle; the ink drinks it) |
| `lamp:pulse` | — | lighthouse (after the failure the ink surges at whoever is in the lamp room) |
| `logbook:read` | — | lighthouse (Hesper's logbook on the lamp-room sill) |
| `stag:engage` | — | monsters (the Hollow Stag leaves its guard over Hesper's lantern) |
| `finale:start` | — | flow (when you step outside after lamp:cured); finale_boss.js answers it — the Stag no longer does |
| `boss:dead` | {who:'stag'\|'gloaming'} | monsters (stag) / finale_boss (gloaming). Only `who:'gloaming'` ends Act 1 |
| `wake:done` | {from, windows, early} | flow (the new game's opening lines have finished, wherever he is; `early` when the rest were dropped because the game moved on or something else was said; `windows` = the beach start before the cloak. onboarding.js owes the opening shot; record.js marks 'ashore') |
| `map:waypoint` | {id, quiet} | map (a waystone unlocked; quiet = granted from an old save / home) |
| `map:travel` | {id, phase:'start'\|'arrive'\|'done'} | map (fast travel: fade out → moved → faded back in) |
| `companion:earned` | {id:'ember'\|'corvin', quiet} | companions (quiet = granted from an old save / a load) |
| `companion:sent` / `companion:spot` | {id, spot} / {id} | companions (sent to a spot / a spot solved) |
| `companion:scout` | {found, ids} | companions (Corvin circled; ids are map collectible ids pinned) |
| `companion:heel` / `companion:caw` | {} / {why:'warn'\|'cooldown'} | companions |
| `companion:nip` / `companion:dive` | {kind, interrupted} / {kind, delayed} | companions (the small fight help) |
| `companion:dodge` | {id} | companions (a blow would have landed: they hop / flap aside) |
| `record:milestone` | {id, t, restored} | record (first reach of a milestone; restored = back-filled from an old save, t null) |
| `record:boss` / `record:change` / `record:newgame` | {id,win,time,hurt,draughts,tries} / {} / {run} | record |
| `badge:earned` / `rank:up` | {id, name, restored} / {i, name} | badges |
| `journal:tab` / `welcome:open` / `welcome:close` | {tab} / {} / {} | progression (the Journal's tabs, the welcome-back card) |
| `account:in` / `account:out` / `account:me` | {me, fresh} / {why, id} / {me} | account (fresh: signed in on this page load, not a restored session; `why`: 'expired' (the service ended the session), 'signout', 'deleted', 'off'; `id`: the account that was signed in; `account:me`: `me` changed while signed in) |

## Module briefs (who owns what)
**world.js** — `G.world.height/walkable/landmarks` (synchronous), terrain mesh(es) with vertex colours (cel-shaded), sea (animated), sky dome (dusk gradient + moon + stars faint), fog, sea stacks, forest (instanced trunks/canopies; colliders for trunks), moor heath + wildflowers, local grass that follows `G.focus` for density, rocks, ruined hamlet, standing stones, stone walls, keeper's cottage + shed with warm windows, the cliff-path ramp, the Resisting Tree, path rendering, mushrooms visuals, atmosphere application (reads `G.atmo`), hemi/sun colours. Registers colliders for trees, rocks, buildings.
**lighthouse.js** — tower at landmarks.lighthouse, interior spiral stairs (logic ported from an earlier single-file prototype: floor provider, wall constrainer, hatch, darkness veil in the doorway that only lets you through with a lit lantern), the Keeper's Staff in a glowing wall bracket on the stairs about halfway up, lamp room with cradle/lens/corruption blob, cure sequence (`G.atmo.cured`, beam, lamp light) → emits events. Fills `G.world.lighthouse = {x,z,baseY,topY,outerR,innerR,colR,doorAngle,doorOut:Vector3,doorIn:Vector3,lampCenter:Vector3,glassPoints:[Vector3],inBody(v),inRoom(v),inside(v)}` at script-evaluation time.
**player.js** — the Traveler (model per style guide), controller, Zelda-like camera, lock-on, roll, glide, sprint/stamina, staff combat, lantern carry/drop/shutter, `G.player` API, `G.models.lantern/staff`, hurt/death/respawn. Sets `G.focus` every frame.
**creatures.js** — moth swarm (on the lamp-room glass from the start; drawn to corruption: lantern, patches, negatives, monsters), patch decals, passive negatives (freed by the swarm), Halloran (Unmade NPC with dialogue). **monsters.js** — hostile monsters + the Hollow Stag boss.

## Testing
The test machine is small (2 cores, software-rendered Chrome), so testing is tiered — don't run the full suites after every change:
1. **While working**: `node --check` your files, `python3 test/quick.py [url]` (~1–2 min smoke test: boot, loop, every cave room,
   no errors), plus your own targeted script for the feature (start from a state with `G.debugStartLoop()`,
   `G.debugEnterCave(room)` or the test tools' start points instead of replaying the story).
2. **Once, at the end of a task**: the full suites that cover what you touched — `test/e2e.py` (Act 1), `test/loop_e2e.py`
   (core loop), `test/cave_e2e.py` (the cave). The lead runs all of them again after merging.
- Add `&headless` to test URLs (the suites do): the game still updates in real time but only draws frames after a `G.step()`
  and ~2 a second otherwise. Before a screenshot of something animating, call `G.headless.draw(3)` and wait ~250 ms.
- Several agents may share the machine: use your own server port (`python3 -m http.server <port>` in your checkout) and pass
  the URL to the suites (`python3 test/cave_e2e.py http://localhost:<port>/dev.html?debug&headless`).
- Server: `http://localhost:8800/dev.html?debug` (if not running: `sh test/serve.sh &`). Rebuild dev.html after changing index.html or adding a module: `python3 test/build_dev.py`.
- Screenshot helper: `python3 test/snap.py --out /tmp/claude-0/yourname.png --begin --js "G.player.teleport(160,42,0,0)" --js "..."` (see its docstring). Put your screenshots under `/tmp/claude-0/<module>/`.
- Headless WebGL is software-rendered: a few fps. For movement/AI tests, step deterministically with `G.step(1/30, n)` inside `--js`, then screenshot.
- To get into play without flow.js: `document.getElementById('title').hidden=true; G.setMode('play')`.
- Always `node --check js/yourmodule.js` before finishing. Your module must not throw if other modules are missing (guard with `G.world.lighthouse && ...`, `G.models.lantern ? ... : fallback`).
- Performance budget: aim for 60 fps on an M-series MacBook. Use InstancedMesh for anything repeated, merge static geometry where easy, keep shadow-casting objects reasonable, keep draw calls in the low hundreds.

## Reference files
- The design doc and the art style guides (Gentle Gothic world guide, Traveler character guide) are kept with the design specs in the private studio repo. Ask the lead for them if your task needs them.
