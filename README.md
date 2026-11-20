# Brave Quest: Lighthouse

A 3D adventure in the browser, built with Three.js (r128) and the Web Audio API. A gentle Gothic fairytale: you
wake at the foot of a dead lighthouse on a sea cliff, the great lamp is dark and the fog is rolling in.

Play the public beta at https://bravequest.numinexstudio.com/ (rebuilt from `main` on every push).

All rights reserved (see `LICENSE`). The code is public so the checks run in the open; it is not open source.

## Run it locally

Browsers block module loading from `file://`, so serve the folder:

```sh
python3 -m http.server 8800
```

- `http://localhost:8800/dev.html` uses the bundled copy of Three.js in `vendor/` (works offline)
- `http://localhost:8800/index.html` loads Three.js from public CDNs
- add `?debug` to either for test helpers (`G.step`, `G.debugStartLoop`, …)
- **Test tools (God Mode)**: the small "Test tools" link on the title card or in the pause menu, or the backquote key (`` ` ``). Start points for each part of the game, cheats, items, tide, time speed, teleports, monsters. Anything used there sends that session's saves to a separate test slot (`bq-save-test-v1`), never the real one. `js/devtools.js`; hide it with `G.DEVTOOLS=false` in `core.js`. Test: `python3 test/devtools_e2e.py`

`dev.html` is generated: run `python3 test/build_dev.py` after changing `index.html` or adding a module.

The public beta build (Three.js and fonts bundled, Test tools off) is `python3 test/build_release.py --api <save service>`; it writes `dist/`. The save service is in `server/` (see its README).

## Tests

The browser suites need Python Playwright and Chrome. Build `dev.html`, serve the folder, and run one suite at a time:

```sh
python3 test/build_dev.py
python3 -m http.server 8996 &
python3 test/quick.py "http://localhost:8996/dev.html?debug&headless"
```

Every suite and the query string it expects is listed in `.github/workflows/tests.yml`; CI runs them all on each pull request.
The save service has its own tests: `cd server && npm ci && npm test`. How the work is done (branches, pull requests, testing)
is in `DEVELOPMENT.md`; the engine API is in `CONTRACT.md`.

## Controls

| | Keyboard and mouse | Touch | Xbox controller |
|---|---|---|---|
| Move | WASD | left thumb | left stick |
| Camera | mouse | right thumb | right stick |
| Sprint | Shift | | LB |
| Jump, hold to glide | Space | Jump | A |
| Roll | C | Roll | B |
| Strike, hold to charge | click | Strike | X |
| Interact | E | Use | Y |
| Lock on | Q | Lock | LT |
| Lantern shutter | F | Shut | RB |
| Drink a Mender’s Draught | H | bottle button | D-pad up |
| Ember: go (at a fox spot) / come to heel | R | fox button | D-pad left |
| Corvin: go (at a raven spot) / scout | T | raven button | D-pad right |
| Pause | Esc | pause button | Menu |

Jump again in the air for a **double jump** (a moth-wing flutter of the Traveler's Cloak; once per jump, needs the cloak). Holding jump still glides afterwards. Roll in the air to **dive**. While you hold strike to charge the staff, the camera moves over your shoulder and a violet reticle appears: aim with the camera (mouse, right stick, right-thumb drag) and release to send an ether bolt to the reticle (a full charge sends a stronger bolt; aim at the ground close by for the spin attack instead). While locked on, the bolt seeks the target.

### Techniques

Combos come from sequencing the normal buttons; each is named on screen the first time you find it and listed in the pause menu. Numbers live in one table at the top of `js/combat.js` (damage in half-hearts).

| technique | input | damage | feel |
|---|---|---|---|
| Rolling Lunge | roll, then strike (during the roll or just after) | 3 | a fast two-handed thrust out of the roll |
| Dashing Sweep | sprint, then strike | 3, all around | a low whirl that slides on your momentum (costs stamina) |
| Skyfall Slam | jump, then strike | 3, 2.4 m shockwave | hang, then drive the staff into the ground |
| Moth-Wing Spin | double jump, then strike | 2, all around | a whirling spin in the air |
| Starfall Plunge | jump, roll in the air, then strike | 5 (7 after a double jump, more from higher), 3–4.4 m | a spinning plunge: big knockback, hit-stop, shake, a burst of ether light |

## Code layout

Every file in `js/` is one plain-script module talking to the others through `window.G` (see `CONTRACT.md`). The main ones:

| file | what it does |
|---|---|
| `core.js` | renderer, cel shading, input, physics queries, combat, events, systems |
| `ink.js` | the corruption look: living ink shader, smoke, drips, pools |
| `world.js` | the island: terrain, sea, sky, forest, moor, hamlet, cottage, shed |
| `lighthouse.js` | the tower, spiral stairs, staff and lamp room |
| `combat.js` | technique numbers, names and pause-menu list, aim reticle and aim raycast, ether bursts |
| `player.js` | the Traveler: model, controller, camera, combat, lantern |
| `creatures.js` | moths, corruption patches, negatives, Halloran |
| `monsters.js` | hollows, shade hounds and the larger foes |
| `flow.js` | quest beats, checkpoints, saving, title and pause |
| `hud.js` | hearts, prompts, captions, objective marker, touch buttons |
| `audio.js` | adaptive score from the Bravequest Theme stems, ambience, sound effects |
| `fog.js`, `alchemy.js`, `moths.js` | the core loop: fog, gathering and brewing, the moth swarm |
| `potions.js` | Mender’s Draught: the carried healing potion |
| `companions.js` | Ember the fox and Corvin the raven: following, commands, companion spots, scouting |

Assets: `audio/` holds the processed theme stems, `sfx/` the processed sound effects, `vendor/` Three.js and the fonts.
