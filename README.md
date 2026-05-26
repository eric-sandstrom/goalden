# Goalden

FIFA World Cup 2026 prediction app — match scores, podium picks, friend leagues, and global leaderboards. Built with **Angular 21** (zoneless, signals, Material 3) on a **Firebase** backend (Firestore, Cloud Functions, Auth, Hosting). PWA-installable.

> Name is a portmanteau of *goal* + *golden*. Theme colours follow.

---

## Quick start

```bash
git clone <repo-url>
cd goalden
npm install
npm --prefix functions install
npm run emulators        # Firebase emulators (Auth, Firestore, Functions, Hosting)
npm start                # Angular dev server (separate terminal)
```

Open <http://localhost:4200> — the app talks to the emulator suite at <http://localhost:4000>.

First run: click **Poll fixtures** and **Poll teams** in the `/dev` page so the emulator has data. After that, sign in with any test email + password and you're off.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ (24 for functions) | `nvm`-recommended, matches CI |
| npm | 10+ | comes with Node |
| Java JDK | 21 | required by the Firestore emulator |
| Firebase CLI | latest | `npm i -g firebase-tools` |
| Football-data.org API key | free tier | sign up at [football-data.org](https://www.football-data.org/) |

---

## Initial setup

### 1. Install dependencies

```bash
npm ci                       # root deps (Angular, Material, etc.)
npm --prefix functions ci    # Cloud Functions deps
```

### 2. Configure Firebase project

The project is wired to `goalden-693dc` in `.firebaserc`. If you're forking, swap that out:

```bash
firebase use --add
```

…and pick your own Firebase project.

### 3. Set the football-data API key

The cron functions read fixtures and squads from football-data.org. The token is stored as a Firebase Functions secret, not in source code.

```bash
firebase functions:secrets:set FOOTBALL_DATA_TOKEN
```

Paste your API key when prompted. The emulators read the secret value from `.secret.local` — see [Firebase docs on secrets](https://firebase.google.com/docs/functions/config-env#secret-emulator) if you need to override it for local testing.

### 4. Optional: seed the emulator with fixtures

```bash
npm run seed:fixtures
```

This populates the local Firestore emulator with the World Cup match schedule so the UI has something to render without waiting on a real API call.

---

## Development workflow

### Run the app locally

Two terminals:

```bash
# Terminal 1 — emulators
npm run emulators
```

This starts:

| Service | Port |
|---|---|
| Hosting | 5000 |
| Functions | 5001 |
| Auth | 9099 |
| Firestore | 8080 |
| Pub/Sub (cron triggers) | 8085 |
| Emulator UI | 4000 |

Data persists between runs via `.emulator-data/` (auto-imported on start, auto-exported on Ctrl+C).

```bash
# Terminal 2 — Angular dev server
npm start
```

`http://localhost:4200` with hot reload.

### Dev tools page

`/dev` (visible only outside production builds) gives you buttons to:

- **Poll fixtures / Poll teams** — manually trigger the football-data crons (don't wait for the scheduled run)
- **Set fixture state** — move any fixture between `TIMED` / `IN_PLAY` / `PAUSED` / `FINISHED` with arbitrary scores
- **Move kickoff time** — test lock countdowns without waiting in real time
- **One-click scenarios** — "finish a match I predicted exactly (+3)", "kick off live 0-0", etc.
- **Reset state** — wipe your own predictions / totals to replay the journey from scratch

Calls are emulator-only — the corresponding Cloud Functions refuse to run anywhere else.

### Generating PWA icons

The PWA logo lives at `public/icons/icon.svg` (the source of truth). Re-rasterize all PNG sizes after editing:

```bash
npm run icons:generate
```

This regenerates all 8 PWA icon sizes (72-512px) from the SVG using `sharp`.

### Other useful scripts

| Script | What it does |
|---|---|
| `npm run build` | Production Angular build → `dist/goalden/browser/` |
| `npm test` | Vitest unit tests |
| `npm --prefix functions run build` | Compile TS Cloud Functions to `functions/lib/` |
| `npm run emulators:kill` | Force-free emulator ports if a previous run hung |
| `npm run snapshot` | Save the current emulator state into `.emulator-data/` |

---

## Deployment

### Automatic (recommended)

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds and deploys **everything** (hosting, functions, Firestore rules, Firestore indexes).

**Required GitHub secrets** (set under repo Settings → Secrets and variables → Actions):

| Secret | How to get it |
|---|---|
| `FIREBASE_TOKEN` | Locally: `firebase login:ci` — copy the token it prints |

You can also re-deploy without a commit via **Actions tab → Deploy to Firebase → Run workflow**.

### Manual deploy (for emergencies)

```bash
firebase deploy --only hosting,functions,firestore:rules,firestore:indexes
```

Or scope to one thing at a time:

```bash
firebase deploy --only hosting
firebase deploy --only functions:pollTeams
firebase deploy --only firestore:rules
```

---

## Project structure

```
.
├── .github/workflows/      CI/CD: deploy.yml
├── functions/              Cloud Functions (Node 24, TypeScript)
│   └── src/
│       ├── poll-football-data.ts    Hourly cron: fixtures + rollup
│       ├── poll-teams.ts            Hourly cron: teams + rollup
│       ├── score-match.ts           Firestore trigger: scoring engine
│       ├── leagues.ts               Callables for league CRUD
│       └── dev-*.ts                 Emulator-only dev callables
├── public/
│   ├── icons/              PWA icons + master SVG
│   └── manifest.webmanifest
├── src/
│   ├── app/
│   │   ├── core/           Models, services, guards, Firebase providers
│   │   ├── features/       One folder per route (home, predict, leaderboard, leagues, profile, teams, dev, auth)
│   │   └── shared/         Reusable components (shell, bottom-nav, skel, install-banner)
│   ├── environments/
│   └── styles.scss
├── tools/
│   └── generate-icons.mjs  Sharp-based icon rasterizer
├── firebase.json           Emulator + deploy config
├── firestore.rules         Security rules
├── firestore.indexes.json  Composite indexes
├── .firebaserc             Project alias
└── package.json
```

---

## Tech stack

- **Angular 21** standalone components, zoneless, signals, `OnPush` everywhere
- **Angular Material 3** with `light-dark()` tokens; runtime theme generation via [`@material/material-color-utilities`](https://github.com/material-foundation/material-color-utilities) lets users theme the app in any World Cup country's colours
- **Firebase JS SDK (raw)** — wrapped via custom DI providers in `src/app/core/firebase/firebase.providers.ts` (AngularFire skipped due to peer-dep mismatch with Angular 21)
- **Cloud Functions 2nd gen** in `europe-west1` (close to the football-data.org origin)
- **Firestore** with both per-doc and rollup-cache patterns to minimise read costs (see services for caching strategies)
- **PWA** via `@angular/service-worker` — installable on iOS 16.4+ home screen, Android, desktop
- **Hosting** on Firebase Hosting CDN

---

## How the data flows

```
football-data.org API
   ↓  (every 10 min)
Cloud Function pollFootballData ──► fixtures/{id} docs + cache/fixtures rollup
                              \
                               └─► Firestore trigger scoreMatch on status='FINISHED'
                                       ↓
                                  predictions/{uid}/matches/{id}.points
                                  users/{uid}.totals  (denormalised)

football-data.org /teams
   ↓  (every 60 min)
Cloud Function pollTeams ──────► teams/{id} docs + cache/teams rollup
```

Clients cache the rollup docs in `localStorage` with a short TTL (5 min for fixtures, 24 h for teams). The live scoreboard maintains a separate small `onSnapshot` listener filtered to `IN_PLAY` / `PAUSED` matches only, so real-time scoring works without paying for the full 104-doc listener.

---

## Scoring system

| Source | Rule | Max points |
|---|---|---|
| Per match (104 total) | 3 pts exact score / 1 pt correct outcome / 0 otherwise | 312 |
| Podium picks | Winner +25 / 2nd +15 / 3rd +10 | 50 |
| Bracket (Phase 2) | R32 +1 ×16 / R16 +2 ×8 / QF +4 ×4 / SF +6 ×2 / Final +10 | 70 |
| **Grand total** | | **432** |

Tiebreakers: `totalPoints` → `exactScoreHits` → `correctOutcomeHits` → `bracketPoints` → `displayName` alphabetical.

---

## Hard deadlines

| Date | Event |
|---|---|
| 2026-06-11 | Group stage kickoff — Phase 1 must ship |
| 2026-06-27 | Group stage ends — bracket locks at first R32 |
| 2026-07-19 | Final |

See `CLAUDE.md` for the day-by-day implementation plan and cut-list.
