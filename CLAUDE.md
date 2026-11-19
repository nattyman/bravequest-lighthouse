# Notes for agents working on this repo

Read `DEVELOPMENT.md` for the full working process (decisions, delegation, git, PRs, testing, CI,
publishing) and `CONTRACT.md` for the engine API before writing code.
The design specs (act and dungeon specs, story bible) live in a private repo that agents are given
separately; they are not in this repo.

## Testing
- **GitHub's runners are free and fast here** (the repo is public): use them. The full set of suites runs
  side by side in about 13 minutes, against an hour or more one at a time on an agent's own machine. Push
  your branch and run the `tests` workflow on it (`workflow_dispatch`, with the `suites` input for a
  targeted run), or open the pull request and let its run tell you. Work-in-progress branches are fine.
  `DEVELOPMENT.md` has the commands.
- Keep local runs for the fast loop: serve the repo with `python3 -m http.server <port>`, build `dev.html`
  with `python test/build_dev.py`, and run `python test/<suite>.py "http://localhost:<port>/dev.html<query>"`
  (the query string each suite expects is in `.github/workflows/tests.yml`) for the one or two suites that
  cover what you changed, and for screenshots, which the runners can't show you. Run local suites one at a time.
- No self-hosted runners: this repo is public, and anyone's pull request could run code on one.

## Licence
All rights reserved (see LICENSE). Don't add an open-source licence or third-party assets
whose licences don't allow redistribution.
