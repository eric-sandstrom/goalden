# Goalden

FIFA World Cup 2026 prediction game. Users predict match scores, podium finishers, and a knockout bracket. Leaderboards are global and league-scoped. League invites are link/QR based.

Name: portmanteau of *goal* + *golden*. Ties to the gold tertiary in the Material theme.

## Firebase

- **Project ID:** `goalden-693dc`
- **Console:** https://console.firebase.google.com/project/goalden-693dc
- **Hosting URL (default):** https://goalden-693dc.web.app
- **Functions region:** `europe-west1` (close to football-data.org origin)
- **Plan:** Blaze required (Cloud Functions need it). Free-tier quotas are generous; expected monthly cost during tournament is ~$0.

## Angular conventions

Project-level Angular conventions live in [.claude/CLAUDE.md](.claude/CLAUDE.md) (auto-loaded). Key rules to remember while building Goalden:

- Standalone components only (Angular 20+ default; do NOT set `standalone: true` in decorators).
- Signals for all state; `computed()` for derived; never `mutate()`, use `update()` / `set()`.
- `OnPush` change detection on every component.
- `inject()` for DI, not constructor injection.
- Use `input()` / `output()` functions (not decorators).
- Use `@if` / `@for` / `@switch` — never `*ngIf` / `*ngFor` / `*ngSwitch`.
- Use `class` / `style` bindings — never `ngClass` / `ngStyle`.
- Reactive forms, not template-driven.
- `host` object for host bindings — no `@HostBinding` / `@HostListener`.
- `NgOptimizedImage` for static images (team flags, etc.).
- AXE-clean, WCAG AA — focus, contrast, ARIA.
- No arrow functions in templates.

## Hard deadlines

| Date | Event | What must ship |
|---|---|---|
| 2026-06-11 | Group stage kickoff | Auth, fixtures ingest, match predictions, podium picks, leagues, leaderboards, scoring engine |
| 2026-06-27 | Group stage ends; bracket locks at first R32 | Bracket UI + bracket scoring |
| 2026-07-19 | Final | App fully operational; scoring finalised |

The bracket UI is the highest-scope feature and intentionally falls in Phase 2. If Phase 1 slips, the cut list (bottom of this doc) shows what to drop first.

## Tech stack

- **Angular** (current stable at scaffold time), standalone components only — no NgModules
- **Zoneless change detection** via `provideZonelessChangeDetection()`
- **Signals** as the only state primitive (`signal`, `computed`, `effect`) — no NgRx, no Subjects-as-state, no BehaviorSubjects
- **OnPush** change detection on every component
- **Angular Material** (Material 3), themed with green primary + gold tertiary, light/dark via `prefers-color-scheme` (no toggle)
- **Firebase JS SDK (raw)** — wired via custom DI providers in `src/app/core/firebase/firebase.providers.ts` (Angular 21 + AngularFire peer-dep mismatch made the raw SDK the cleaner choice; signals integrate directly from `onSnapshot` callbacks)
- **Firebase**: Auth, Firestore, Cloud Functions (2nd gen), Hosting, Cloud Messaging
- **PWA** (manifest + service worker) — installable, web-push capable on iOS 16.4+ if installed to home screen
- **Data source**: [football-data.org](https://www.football-data.org/) free tier

## Architecture

### State pattern

Signal-based services, one per domain, in `src/app/core/services/`:

| Service | Responsibility | Key signals |
|---|---|---|
| `AuthService` | Firebase Auth wrapper, current user | `user`, `isAuthenticated` |
| `FixturesService` | Live fixtures map, updated via `onSnapshot` | `fixtures` (Map<matchId, Fixture>) |
| `PredictionsService` | Current user's match + podium + bracket predictions | `matchPredictions`, `podiumPick`, `bracketPicks` |
| `LeaguesService` | User's league memberships, current league members | `myLeagues`, `currentLeagueMembers` |
| `LeaderboardService` | Global top-N, paginated; per-league rankings | `globalTopN`, `currentLeagueLeaderboard` |

Conventions:
- Services expose signals as `.asReadonly()`. Mutation happens only inside the service.
- Wrap Firestore listeners by calling `signal()` and updating it from inside `onSnapshot()` callbacks. Tear down listeners via `inject(DestroyRef)` + a cleanup callback registered in the constructor.
- Use `computed()` for derived state. Never use `effect()` for derived state.
- Use `effect()` only for side effects (localStorage sync, FCM token persistence). Clean up with `onCleanup` or `inject(DestroyRef) + takeUntilDestroyed()`.
- Use `resource()` for async reads keyed on a reactive parameter — i.e. "when this selection changes, (re)load the data for it and expose loading/error states." Rules:
  - `params` must return a **stable primitive key** (e.g. the `${compId}_${season}` string), not a fresh object — the resource compares params by `===`, so an object literal reloads on every recompute. Return `undefined` to leave the resource idle (no load).
  - The `loader` is a plain `async` function that **returns** the data and must **not** write signals. Back it with a dedicated one-shot service method (e.g. `FixturesService.loadFixtures()`), not the `onSnapshot`-backed shared signals — this keeps it callable from reactive code without tripping NG0600.
  - Always pass `defaultValue` so `value()` is never `undefined`. Drive view states off `isLoading()` / `status() === 'error'` / `value()`; expose a `retry()` that calls `resource.reload()`.
  - Live/real-time data stays on `onSnapshot` signals. When a resource-loaded view also needs live updates, overlay a live signal onto `resource.value()` in a `computed()` rather than merging into the resource.
- Firestore listeners cost money. Tear them down when unmounted.

### Firestore data model

```
users/{uid}
  displayName: string
  photoURL: string | null
  createdAt: Timestamp
  deletedAt: Timestamp | null

users/{uid}/totals/summary
  totalPoints: number
  matchPoints: number
  podiumPoints: number
  bracketPoints: number
  exactScoreHits: number       // tiebreaker 1
  correctOutcomeHits: number   // tiebreaker 2
  updatedAt: Timestamp

users/{uid}/devices/{deviceId}
  fcmToken: string
  platform: 'web-android' | 'web-ios' | 'web-desktop'
  updatedAt: Timestamp

fixtures/{matchId}
  homeTeam: { id, name, code, flag }
  awayTeam: { id, name, code, flag }
  utcKickoff: Timestamp
  status: 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'AWARDED'
  stage: 'GROUP' | 'R32' | 'R16' | 'QF' | 'SF' | 'F' | 'THIRD_PLACE'
  group: 'A' | 'B' | ... | 'L' | null
  score: { fullTime: { home, away } | null, winner: 'HOME' | 'AWAY' | 'DRAW' | null }
  lastSyncedAt: Timestamp

predictions/{uid}/matches/{matchId}
  homeScore: number
  awayScore: number
  submittedAt: Timestamp
  points: number | null        // null until match is scored
  pointsCategory: 'exact' | 'outcome' | 'wrong' | null

predictions/{uid}/podium/picks
  winnerTeamId: string
  secondTeamId: string
  thirdTeamId: string
  submittedAt: Timestamp
  points: number | null

predictions/{uid}/bracket/picks
  r32: { matchId: teamId }[]   // 16 entries
  r16: { matchId: teamId }[]   // 8 entries
  qf: { matchId: teamId }[]    // 4 entries
  sf: { matchId: teamId }[]    // 2 entries
  final: { matchId: teamId }   // 1 entry
  submittedAt: Timestamp
  points: number | null

leagues/{leagueId}
  name: string
  ownerId: string
  inviteCode: string           // e.g. "H7K2-MX9P"
  memberCount: number
  createdAt: Timestamp

leagues/{leagueId}/members/{uid}
  joinedAt: Timestamp
  role: 'owner' | 'member'

leagues_public/{inviteCode}
  leagueId: string
  name: string
  memberCount: number          // mirrored from leagues/{id}; client-readable without league membership
```

Composite indexes required:
- `users` collection — `(deletedAt asc, totals.totalPoints desc)` for global leaderboard
- `predictions` collection group — `(userId asc, matchId asc)` if needed for scoring trigger
- `leagues/{id}/members` — sort by joined date is fine via single-field index

## Scoring

| Source | Rule | Max |
|---|---|---|
| Per match (104 total) | 3 pts exact full-time score / 1 pt correct outcome (W/D/L) / 0 otherwise. Full-time score only; ET/penalties ignored for score, but reflected in bracket scoring. | 312 |
| Podium | Winner +25 / 2nd +15 / 3rd +10 | 50 |
| Bracket | R32 +1 each (×16), R16 +2 (×8), QF +4 (×4), SF +6 (×2), Final +10 (×1) | 70 |
| **Grand total** | | **432** |

Tiebreaker cascade:

1. `totals.totalPoints`
2. `totals.exactScoreHits`
3. `totals.correctOutcomeHits`
4. `totals.bracketPoints`
5. `displayName` (alphabetical)

## Lock times

| Prediction surface | Locks at |
|---|---|
| Match prediction | The match's `utcKickoff` (driven by `status: IN_PLAY`) |
| Podium picks (winner / 2nd / 3rd) | First match kickoff (2026-06-11) |
| Bracket picks | First R32 match kickoff (2026-06-27) |

All lock checks happen server-side in Firestore security rules. Clients also gate the UI for snappy UX, but the server is authoritative.

## League model

- **Model A**: one user, one set of predictions, N league memberships. Leagues are leaderboard filters over the same predictions.
- **Invite link**: `https://<host>/j/<INVITE_CODE>`. Anyone with the link → instant join (capability URL). No approval flow.
- **Invite code**: 8 chars, uppercase alphanumeric, no `0/O/I/1`, dash in middle for readability (e.g. `H7K2-MX9P`). Generated server-side by a Cloud Function to guarantee uniqueness across the `leagues` collection.
- **QR code**: generated client-side from the URL via `angularx-qrcode`. The QR encodes the URL, nothing more.
- **Owner powers**: rename, regenerate invite code, kick member, transfer ownership, delete league.
- **Owner cannot leave** without transferring ownership first.
- **Soft cap**: 500 members per league.
- **No cap** on memberships per user.
- **Privacy**: leagues are invite-only and not discoverable. No browse/search of leagues.

`leagues_public/{inviteCode}` is the client-readable doc that the `/j/<code>` landing page reads — exposes only `name` and `memberCount`, so visitors can see what they're joining without being granted full league read access.

## Security rules (outline)

Non-negotiable rules. The full rules file lives at `firestore.rules` (write on day 12 of the plan).

1. **Predictions are write-only by the owner, and only before kickoff.**
   ```
   match /predictions/{uid}/matches/{matchId} {
     allow read: if request.auth.uid == uid;
     allow write: if request.auth.uid == uid
                  && get(/databases/$(db)/documents/fixtures/$(matchId)).data.status == 'TIMED';
   }
   ```
2. **Podium picks writable only before 2026-06-11 first kickoff.**
3. **Bracket picks writable only before 2026-06-27 first R32 kickoff.**
4. **`totals` is read-only from the client.** Cloud Functions write (via Admin SDK, bypassing rules).
5. **`fixtures` is read-only from the client.** Cron Function writes.
6. **League members can read the league + members subcollection. Non-members get only `leagues_public/{inviteCode}` (name + memberCount).**
7. **Only the league owner can write to league config or delete the league.**
8. **Clients do not directly write to `leagues/{id}/members`.** They call the `joinLeague` Cloud Function with the invite code; the function validates and writes.

Test rules in the Firebase Emulator + Rules Playground. Untested rules are the #1 launch-day risk.

## Cloud Functions (2nd gen)

| Function | Trigger | Job |
|---|---|---|
| `pollFootballData` | Scheduled (cron, every 2 min during match windows, every 30 min otherwise) | Hits football-data.org, upserts `fixtures/{matchId}` |
| `scoreMatch` | Firestore `onDocumentUpdated('fixtures/{matchId}')` when `status` transitions to `FINISHED` | Iterates predictions for that match, computes points, updates `predictions/{uid}/matches/{matchId}.points` and `users/{uid}/totals` |
| `scorePodium` | Triggered after the final + 3rd-place playoff | Awards podium points |
| `scoreBracketRound` | Triggered after a knockout round completes | Awards bracket points for that round |
| `generateInviteCode` | Callable | Creates a unique invite code on league creation / regenerate |
| `joinLeague` | Callable (input: inviteCode) | Validates code, writes member doc, increments `memberCount` |
| `sendMatchReminder` | Scheduled (every 5 min) | Finds matches kicking off in 55–65 min, finds users without a prediction, sends FCM multicast |

Use the `firebase-functions/v2` API. Deploy region = single region close to football-data.org's origin (likely `europe-west1`).

## Notifications

Single message type for v1: **"Match in 1hr: <home> vs <away> — predict now"** to users without a prediction for that match.

- Opt-in moment: after the user's first prediction is submitted. Modal with explicit value prop.
- iOS push works only when PWA is installed to home screen. Show this caveat on opt-in for iOS users.
- Toggle in Profile to enable later if user declined.
- No in-app notification center.

Cut everything else for v1: scored-match notifications, leaderboard movements, lock-time reminders. The home-screen banners already cover lock urgency in-app.

## UI patterns

### Home screen (top to bottom)

1. "Today's matches" horizontal scroll of `mat-card` rows with inline prediction inputs (empty state: countdown to next match)
2. "Your standings" list — one row per league with rank + score, tap → that league's leaderboard
3. "Global rank" pill (tap → global leaderboard scrolled to your row)
4. Bottom nav (custom — Material doesn't ship `mat-bottom-nav`): Home / Predict / Leaderboards / Leagues / Profile

### Predict tab

- Chronological list grouped by date
- Filter chips at top: All / Upcoming / Group / Knockouts (default: Upcoming)
- Each row: home team flag + name, two `mat-form-field` score inputs, away team flag + name, kickoff time, lock status badge
- Autosave on blur, `mat-snack-bar` "Saved" for 1.5s
- Lock visualisation:
  - `>1h` to kickoff: open inputs, neutral
  - `<1h` to kickoff: yellow `mat-chip` "Locks in 47m"
  - Past kickoff: read-only, shows prediction + actual + points (or "Pending")

### Leaderboard tabs

- `mat-tab-group`: Global | per-league tabs + "+" to join/create
- Default tab: a league if user is in any, else Global
- `mat-table` + virtual scroll for global; full list for league (≤500 members)
- "Find me" button on global leaderboard (scrolls + highlights your row)

### Material component map

| Use case | Component |
|---|---|
| Top bar | `mat-toolbar` |
| Match prediction row | `mat-card` + `mat-form-field` (outline, type=number) |
| Filter chips | `mat-chip-listbox` |
| Podium picks | `mat-select` (with flag emoji + name) |
| Leaderboard | `mat-table` + `mat-sort` + `cdk-virtual-scroll-viewport` |
| League list | `mat-list` |
| Create league | `mat-dialog` |
| Save toast | `mat-snack-bar` (1500ms) |
| Loading | `mat-progress-spinner` |
| Lock countdown | `mat-chip` |

### Theme

Material 3, generated from primary `#0F7B3A` (football-pitch green) and tertiary `#D4A017` (gold). Light + dark schemes both generated; OS preference selects via `prefers-color-scheme` (no in-app toggle).

## Coding conventions

- **Standalone components only.** No NgModules anywhere.
- **OnPush** on every component.
- **Signals** for all reactive state. No `BehaviorSubject` or imperative `EventEmitter` for state.
- **inject()** for DI inside class fields, not constructor injection (unless the legacy form is needed for a specific reason).
- **Routing**: lazy-load each feature route. Use `loadComponent` + standalone routes config.
- **File layout**:
  ```
  src/app/
    core/
      services/        (auth, fixtures, predictions, leagues, leaderboard)
      guards/          (authGuard, etc.)
      models/          (Match, Team, Prediction, League, ...)
    features/
      home/
      predict/
      leaderboard/
      leagues/
      profile/
      onboarding/
      join-league/     (the /j/<code> route)
    shared/
      components/      (BottomNav, TeamBadge, LockChip, ...)
      pipes/
  ```
- **No barrel `index.ts` files.** Import directly from source files. Barrels cause circular import pain in standalone codebases.
- **Always split components into `.ts` + `.html` + `.scss`.** No inline `template:` or `styles:` blocks, regardless of size.
- **No CSS frameworks** beyond Angular Material + a thin global stylesheet for the bottom nav and any non-Material custom pieces.

## Phase 1 plan (May 26 → June 11)

| Day | Date | Goal |
|---|---|---|
| 1 | May 26 | Project scaffolded, Firebase project created, Firebase SDK providers wired, deployed-empty on `*.web.app` |
| 2 | May 27 | Auth (Google + email/pw), displayName screen, profile shell |
| 3 | May 28 | Firestore schema + security rules v0, fixtures seed script |
| 4 | May 29 | `pollFootballData` cron, `scoreMatch` skeleton |
| 5 | May 30 | Match prediction list UI (chronological, filters) |
| 6 | May 31 | Inline score boxes, autosave, lock states, "today's matches" home card |
| 7 | Jun 1 | Podium pick screen + lock enforcement |
| 8 | Jun 2 | Scoring engine — match + podium, totals denormalisation |
| 9 | Jun 3 | Global leaderboard (top 100, paginated, "find me") |
| 10 | Jun 4 | League create/leave/delete, invite-code function, regenerate |
| 11 | Jun 5 | League leaderboard, `/j/<code>` landing, join flow |
| 12 | Jun 6 | Security rules hardening + emulator tests (do not skip) |
| 13 | Jun 7 | PWA manifest, service worker, mobile polish |
| 14 | Jun 8 | Friends-test alpha (invite 3 people, predict real upcoming matches) |
| 15 | Jun 9 | Bug fixes, copy polish |
| 16 | Jun 10 | Buffer day. Final deploy, podium-lock cron deployed, smoke test |
| - | Jun 11 | Tournament starts. Podium picks lock at first kickoff. |

## Phase 2 plan (June 11 → June 27)

Bracket UI + bracket scoring. While the tournament runs and you babysit production:

- Days 17–22: bracket tree UI (flat list-per-round first, upgrade to tree visualization if time)
- Days 23–25: bracket scoring engine integration
- Days 26–28: alpha test with users who finished group stage
- Days 29–31: polish + ship before R32 first kickoff (June 27)

## Cut list

Checkpoints — if you're behind, cut top-down.

**Day 9 (Jun 3) check — are you on or ahead of schedule?**
- Drop "find me" button (just paginate)
- Drop filter chips on Predict tab (chronological all only)
- Drop profile photos (initials only)

**Day 12 (Jun 6) check — is core flow working end-to-end?**
- Drop PWA service worker + install prompt (ship as plain web app)
- Drop multi-device FCM token support (single token per user)

**Day 14 (Jun 8) check — is alpha smoke test passing?**
- Drop regenerate invite code (one code forever)
- Drop transfer ownership (block owner-leave, manual ops via "contact developer")

**Phase 2 day 20-ish (Jun 14) — bracket UI rough?**
- Fall back to **implicit bracket bonus**: derive picks from per-match score predictions. Award bracket points based on whether the user's predicted-winner of each knockout match matches the actual winner. No separate bracket UI, no separate `predictions/{uid}/bracket` doc. Loses the visible bracket but keeps the scoring concept.

## External resources

- football-data.org docs: https://docs.football-data.org/general/v4/index.html
- Free tier — includes WORLD_CUP competition, 10 req/min
- API key required (env var `FOOTBALL_DATA_TOKEN`, set as Cloud Function secret)
- Angular Material M3 theming: https://material.angular.dev/guide/theming
- Firebase JS SDK (modular): https://firebase.google.com/docs/web/modular-upgrade
- Firebase pricing calculator: https://firebase.google.com/pricing

## Explicitly out of scope for v1

- Friends/following (use leagues instead)
- Chat or comments
- Match details beyond score (stadium, lineups, statistics)
- Stats pages ("you're better than 80% at predicting Brazil")
- Social sharing
- Dark mode toggle (uses OS preference silently)
- Email digests
- Admin moderation tools
- Multiple languages
- Top scorer / dark horse / first goal scorer bonus picks
- Anonymous/guest auth

Add post-tournament if there's appetite. None of these are needed to launch.
