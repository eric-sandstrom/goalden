# Goalden

FIFA World Cup 2026 prediction app — match scores, podium picks, friend leagues, global leaderboards, and an AI-generated "predictor personality" for each user. Built with **Angular 21** (zoneless, signals, Material 3) on a **Firebase** backend (Firestore, Cloud Functions, Auth, Hosting). PWA-installable.

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
| Gemini API key | free tier (optional) | sign up at [aistudio.google.com](https://aistudio.google.com/) — powers the predictor-personality reasoning text. Without it the feature still works (deterministic fallback), just without AI-written reasoning. |

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

### 3. Set Firebase Functions secrets

The Cloud Functions need two secrets:

- **`FOOTBALL_DATA_TOKEN`** — used by `pollFootballData` and `pollTeams` to read fixtures and squads from football-data.org. **Required.**
- **`GEMINI_API_KEY`** — used by `generatePredictorPersonality` to write AI reasoning text for the predictor-personality card. **Optional** — if absent, the feature falls back to a deterministic best-fit with generic reasoning text.

Set them once per project via the CLI:

```bash
firebase functions:secrets:set FOOTBALL_DATA_TOKEN
firebase functions:secrets:set GEMINI_API_KEY
```

Paste each value when prompted. The CLI stores them in Google Cloud Secret Manager; deployed functions pull from there automatically.

#### Emulator: `.secret.local`

The Firebase Functions emulator does **not** read from Secret Manager. To make `defineSecret().value()` work locally, create `functions/.secret.local` with both keys in dotenv format:

```
FOOTBALL_DATA_TOKEN=your-football-data-key
GEMINI_API_KEY=AIzaSy...your-gemini-key
```

This file is already covered by `functions/.gitignore` (`*.local`) — do not commit it. The values can be read back from Secret Manager at any time via `firebase functions:secrets:access <NAME>`.

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

**One-time setup**: create a service account with deploy permissions, generate a JSON key, and add it to GitHub as the secret `FIREBASE_SERVICE_ACCOUNT_GOALDEN_693DC` (Firebase CLI's default name). The fastest path is `firebase init hosting:github` — it creates the SA, grants Hosting + Functions roles, sets the GitHub secret, and uploads the key all in one go. Alternatively, do it manually with the `gcloud` commands below.

Easiest path (requires `gcloud` CLI):

```bash
# 1. Create the service account
gcloud iam service-accounts create github-actions-deploy \
  --display-name="GitHub Actions Deploy" \
  --project=goalden-693dc

# 2. Grant the Firebase Admin role (covers hosting, functions, rules, indexes)
gcloud projects add-iam-policy-binding goalden-693dc \
  --member="serviceAccount:github-actions-deploy@goalden-693dc.iam.gserviceaccount.com" \
  --role="roles/firebase.admin"

# 3. Generate a JSON key (writes ./key.json — keep it secret, delete after upload)
gcloud iam service-accounts keys create key.json \
  --iam-account=github-actions-deploy@goalden-693dc.iam.gserviceaccount.com

# 4. Copy the file contents into the GitHub secret named
#    FIREBASE_SERVICE_ACCOUNT_GOALDEN_693DC
#    (repo → Settings → Secrets and variables → Actions → New repository secret)

# 5. Delete the local key file so it can't leak
rm key.json
```

No `gcloud`? Use the [Google Cloud Console UI](https://console.cloud.google.com/iam-admin/serviceaccounts) — pick the `goalden-693dc` project, **Create Service Account**, grant **Firebase Admin** under "Grant this service account access to project", then on the resulting account use **Keys → Add Key → Create new key → JSON**. Paste that JSON into the GitHub secret.

You can re-deploy without a commit via **Actions tab → Deploy to Firebase → Run workflow**.

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
│       ├── global-leagues.ts        Admin-managed global leagues + auto-enroll
│       ├── personality.ts           Callable: generate predictor personality (Gemini)
│       ├── data/                    Static lookup tables (FIFA rankings, etc.)
│       ├── lib/                     Shared helpers (scoring, invite codes, stats)
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

## Predictor personality (AI)

Each user has a "predictor personality" card on `/profile` and `/users/:uid` — an AI-labelled archetype like 🎲 *Against All Odds* or ⚽ *Goal Rush*, plus a short reasoning sentence written by Gemini about the user's specific pick pattern.

Pipeline:

```
User taps "Generate" on /profile
   ↓
generatePredictorPersonality callable
   ├─ Eligibility gate: ≥3 picks, ≥3 new since last gen, ≥12 h since last gen
   ├─ Read predictions + matched fixture metadata
   ├─ Compute deterministic stats (upset %, avg goals, score entropy, ...)
   │  using the snapshot in functions/src/data/fifa-rankings.ts
   ├─ Call Gemini 2.0 Flash with structured-output enum schema
   │  └─ Fall through to deterministic best-fit on any Gemini error
   └─ Write users/{uid}/personality/current
```

Ten fixed archetypes form the taxonomy (Against All Odds, The Statistician, Home Sweet Home, Goal Rush, The Wall, Draw Dealer, Chaos Goblin, Hometown Hero, Sniper, Late Bloomer). The deterministic detection in `functions/src/lib/personality-stats.ts` is also what feeds Gemini's prompt — Gemini's job is to choose the archetype and write the reasoning text, not to do arithmetic.

The card uses an open Firestore read (`users/{uid}/personality/current` — any signed-in user) so league mates can compare. Writes are server-only via the callable; cooldown and pick-count rules are enforced both client-side (UX) and server-side (authoritative).

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
