# Letter Rush

Letter Rush is a mobile-first word-grid game built with Next.js App Router,
React, TypeScript, CSS Modules, and Supabase. Persistent email/password accounts
can play:

- server-authoritative Single Player with statistics saved per exact mode;
- fixed-rules, two-player ranked Quick Match with Elo;
- invite-only private lobbies for 2–12 players with versioned custom rules.

Players connect horizontal, vertical, or diagonal neighbors with mouse, touch,
or stylus. Pointer movement and provisional feedback stay local. Supabase owns
identity, seeds, rules snapshots, clocks, durable votes/proposals, validated
results, statistics, and rating changes.

Production origin:
[https://letter-rush-tau.vercel.app](https://letter-rush-tau.vercel.app/)

## Requirements

- Node.js 20.9 or newer
- npm
- a Supabase project
- Supabase CLI and Docker for local database integration tests

All gameplay requires a verified persistent account and a network connection.
The installed app keeps a static guide and offline screen available, but never
pretends cached gameplay or user data is authoritative.

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Copy `.env.example` to the ignored `.env.local` and provide public values only:

```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Never add a service-role key, secret key, database password, or access token.
Production `NEXT_PUBLIC_APP_URL` must be an HTTPS origin without a path, query,
fragment, or credentials.

The dictionary is pinned and generated from repository files. No dictionary is
downloaded at install, build, or runtime:

```bash
npm run dictionary:generate
npm run dictionary:lookup -- quixotic
```

## Supabase setup

Use project reference `rrkhmsotcwxphufrlvah`.

### Authentication settings

In **Authentication → Providers → Email**:

- enable email/password signups;
- require email confirmation in production;
- keep secure password requirements appropriate for the project;
- enable manual identity linking so an anonymous user can be converted in
  place by adding and verifying an email, then setting a password.

Anonymous sign-in may remain enabled only for migration compatibility with
already-issued guest sessions. The application does not create new anonymous
sessions and the database rejects anonymous gameplay writes.
Disable anonymous sign-ins only after the announced upgrade window has ended
and all retained guest sessions have either been claimed or expired. Disabling
them earlier can strand a legacy player before they attach email credentials.

In **Authentication → URL Configuration** set:

- Site URL: `https://letter-rush-tau.vercel.app`
- local redirect: `http://localhost:3000/**`
- production redirect: `https://letter-rush-tau.vercel.app/**`
- each trusted preview HTTPS origin if preview auth links are required.

Email confirmation and recovery links return through `/auth/callback` or
`/auth/confirm`; these routes consume the one-time credential and immediately
redirect without leaving it in the browser URL.

The hosted default SMTP service is suitable only for limited testing. Configure
production SMTP and review Supabase email rate limits before launch.

### Forward-only migrations

Apply every file in timestamp order. Never rewrite a migration that has reached
another environment.

1. `20260724005143_private_two_player_matches.sql`
2. `20260724072923_customizable_multiplayer_lobbies.sql`
3. `20260724072929_enable2k_dictionary_seed.sql`
4. `20260724092826_sync_enable2k_dictionary_v1.sql`
5. `20260724095312_ranked_quick_match.sql`
6. `20260724174854_fix_public_profile_identity_regression.sql`
7. `20260724185144_persistent_accounts_gameplay_progression.sql`
8. `20260724193900_persistent_accounts_gameplay_progression_schema.sql`
9. `20260724203145_fix_qualified_sql_expressions.sql`
10. `20260724211935_repair_solo_session_lifecycle.sql`

The exact hosted apply sequence is:

```bash
npx supabase login
npx supabase link --project-ref rrkhmsotcwxphufrlvah
npx supabase db push
```

This repository never applies hosted migrations automatically.

The first progression migration commits the `solo` match-mode enum label.
PostgreSQL must commit a new enum label before a later transaction can use it.
The following progression schema migration adds:

- persistent-caller enforcement at the database write boundary;
- in-place legacy guest claiming without changing auth UUID, display name,
  opaque public profile ID, rating, statistics, or history;
- server-authoritative solo sessions using the existing Postgres word/path
  validator;
- canonical mode keys containing category, dimensions, mask, duration,
  minimum length, dictionary, scoring, board-generation, and ruleset versions;
- idempotent per-mode statistics and bounded UUID-free public projections;
- eight-second exact-board previews and one unanimous reroll;
- 30-second ranked rematch proposals and private rematch invitations;
- narrow RLS, explicit grants, empty `search_path` on every new
  `SECURITY DEFINER`, and RPC identity derived only from `auth.uid()`.

The conditional-expression repair migration replaces deployed function bodies that incorrectly
schema-qualified PostgreSQL conditional expressions. The earlier migration
remains immutable because it is already recorded in hosted migration history.
The solo lifecycle repair adds atomic create-or-resume and authenticated
abandonment RPCs while retaining the original `create_solo_session` signature
for older clients.

## Accounts

New visitors see Sign In, Create Account, Guide, and Leaderboard. Sign up
collects a validated display name, email, and password. The UI includes password
confirmation, visibility, a strength indicator, confirmation-pending state,
recovery, reset, expired-session handling, and rate-limit-safe messages keyed
from Supabase Auth error codes rather than raw database text.

Legacy anonymous users see **Claim Account**. Claiming follows Supabase's
supported conversion sequence:

1. `updateUser({ email })`
2. verify the email
3. `updateUser({ password })`

The same auth UUID remains attached to the same profile. No client supplies a
user ID or public profile ID to an identity RPC.

Protected pages are checked in `src/proxy.ts` for early redirects and checked
again in Server Components or Route Handlers. Database RPCs remain the final
authorization boundary.

## Gameplay

### Shared interaction rules

- Connect tiles touching by an edge or corner.
- A tile cannot repeat within one word.
- A selected path cannot be shortened by swiping backward; selected tiles stay
  locked until release or cancellation.
- Words must meet the stored minimum length and versioned dictionary.
- Selected tiles are neutral white, a locally confirmed new word is green, and
  a valid duplicate is yellow.
- New words show `WORD (+POINTS)` above the board for 1.5 seconds. Duplicates
  show `WORD — ALREADY FOUND` in yellow for about one second. Invalid releases
  clear silently while accessible status remains available.
- Active play shows only the compact word-count, score, timer, notification
  space, and board. The complete word list and points appear on results.
- Results order accepted words by points descending, length descending, then
  alphabetically and show the validated point value.

Classic scoring:

| Word length | Points |
| ----------- | -----: |
| 3           |    100 |
| 4           |    400 |
| 5           |    800 |
| 6           |  1,400 |
| 7           |  1,800 |
| 8+          |  2,200 |

### Single Player

Starting a solo round calls `create_or_resume_solo_session`. Under a per-player
transaction lock, the database returns a still-active session with its original
match ID, seed, rules, start time, and end time. If its authoritative end plus
the 15-second network grace has passed, the old session is cancelled without
statistics and a fresh session is created atomically. `create_solo_session`
remains as a backward-compatible wrapper.

The visible **Exit round** action confirms before calling
`abandon_solo_session`. Cancellation saves no partial score or mode statistics
and permits an immediate new round. Repeated abandon calls are idempotent;
completed rounds cannot be abandoned. Submission still uses the same
participant-scoped `/api/matches/results` route and Postgres
`submit_match_result` validator as multiplayer.

### Ranked Quick Match

Ranked is always `ranked-v1`: 4×4 rectangle, 60 seconds, minimum length 3,
`enable2k-af52415-v1`, `classic-v1`, and `weighted-v2`.

Queue entry derives `auth.uid()`, snapshots the server-owned rating, uses a
per-user advisory lock, expires stale heartbeats, and selects one compatible
opponent with `FOR UPDATE SKIP LOCKED`. The rating gap starts at 150, widens by
50 every ten seconds to 600, then opens after 90 seconds. Realtime is only a
refetch notification; heartbeat and bounded polling recover socket loss.

Every ranked result is regenerated and validated twice. Atomic finalization
locks the match and stat rows, applies K=32 zero-sum integer Elo with a 100
floor, and writes one immutable rating ledger row per participant. A missing
result becomes a forfeit after the recovery window; two missing results abandon
without rating or statistic changes.

After completion either participant can open one 30-second rematch proposal.
Only the other participant may accept or decline. Acceptance transactionally
creates exactly one fixed ranked match with a new seed and a fresh preview.
Players with another active match cannot request or accept.

### Private lobbies

Hosts may choose:

- every square preset from 3×3 through 8×8;
- independent rectangle rows and columns from 3 through 8;
- rectangle, dynamically scaled diamond, dynamically scaled cross, or an exact
  custom mask;
- 30, 60, 90, 120, or 180 seconds;
- 2–12 players.

The custom editor supports pointer painting and keyboard buttons, active-cell
counting, reset, fill, clear, diamond, and cross presets. A valid mask contains
at least nine cells and is one connected component using the same
eight-direction adjacency as gameplay. The exact mask is immutable after start
and controls generation, rendering gaps, selection, and server validation.

Joins lock the lobby before checking status, duplicate membership, and capacity.
Only the host can change waiting rules, start, or cancel.

A private rematch creates one new waiting lobby, copies the complete rules and
capacity, generates a new seed and room code, makes the requester host, and
notifies prior participants with invitations. Invitees join explicitly; they
are not forced into an active match.

### Pregame preview and reroll

Ranked and private rounds show the exact seeded board for eight seconds. Current
participants may approve or decline one reroll. Only unanimous approval before
the database deadline consumes it, produces exactly one different server seed,
and restarts the preview. A decline or timeout keeps the original board and
cannot delay play indefinitely.

## Saved modes and public statistics

`private.mode_key(category, ruleset)` hashes a canonical JSONB object containing
all result-affecting inputs. Solo, ranked, and private never collide even when
their board rules match. A per-match/per-user event table makes stat updates
idempotent under retries.

Saved rows include games, wins/losses/ties/forfeits, best and total score, total
words, best word and score, win/unbeaten streaks, the immutable rules snapshot,
and timestamps. Direct rows are self-only. Public RPCs project bounded,
explicit columns using only opaque profile IDs and display names.

Public ranked profiles, ranked history, saved modes, and leaderboards never
return auth UUIDs, email, provider metadata, tokens, queue state, or private
lobby history.

## Dictionary and deterministic boards

The dictionary is ENABLE 2K pinned to commit
`af52415c13af809bd8757a40f17f46e79d09583c`. Its public-domain notice is in
`dictionary/LICENSE-ENABLE.txt`.

Generation normalizes lowercase ASCII, applies explicit allow/block files,
creates 26 lazy first-letter modules, and can create a new CLI-generated SQL
migration. The expected version/count is
`enable2k-af52415-v1` / `173528`.

- `legacy-v1` preserves historical 4×4 boards.
- `weighted-v2` uses an explicit weighted distribution and deterministic vowel
  floor for rectangular/masked boards through 8×8.
- Stored seed, rules, mask, dictionary, scoring, and generation versions make
  old results reproducible.

## Responsive and accessible UI

- Active gameplay targets one `100dvh` screen at 320, 375, and 430 CSS pixels,
  portrait and landscape.
- Board sizing is constrained by both viewport width and remaining height.
- Safe-area insets protect notches and installed-app chrome.
- Menus and results can scroll; active play clips page scrolling while keeping
  the compact scoreboard, transient word notice, and complete board visible.
- The board supports Pointer Events, pointer cancellation, lost capture,
  coalesced/interpolated fast swipes, backgrounding, rotation, and Visual
  Viewport/ResizeObserver remeasurement.
- Custom cells and all controls are keyboard operable.
- Visible focus, text equivalents, live regions, non-color status, semantic
  landmarks, and reduced-motion behavior are included.
- The logo always links home. Active match navigation asks for confirmation.

## PWA and service-worker policy

`public/sw.js` caches only the static offline page, guide, icons, manifest, and
immutable same-origin Next.js assets. It does not cache:

- authenticated/user-specific pages or gameplay;
- `/api`, `/auth`, Supabase, Realtime, or other cross-origin traffic;
- authorization-bearing requests;
- non-GET requests;
- match, lobby, queue, vote, proposal, result, profile, or statistic data.

Navigation remains network-first and falls back only to the offline page.

Service workers require HTTPS outside localhost. Install from Safari's
**Add to Home Screen** or Chrome's **Install app**.

## Security model

- All exposed tables have RLS and explicit privileges.
- Persistent account state is checked against `auth.users`; an anonymous JWT
  cannot bypass old RPC definitions.
- Gameplay identity is always `auth.uid()`.
- Profile creation has one collision-retrying server path and never replaces an
  existing opaque public ID.
- Clients cannot write match state, participants, validated results, ratings,
  statistics, reroll votes, or rematch proposals directly.
- Every new `SECURITY DEFINER` sets `search_path = ''`, fully qualifies
  sensitive objects, revokes default execution, and grants only intended roles.
- Realtime payloads are notifications; clients refetch RLS-filtered durable
  state and retain polling fallbacks.
- No privileged Supabase credential is used by the application.

## Verification

Run:

```bash
npm run dictionary:generate
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Local database checks require Docker:

```bash
npx supabase start
npx supabase db reset
npx supabase db lint --local --level warning
npx supabase test db --local supabase/tests/profile_identity_regression.test.sql
npx supabase test db --local supabase/tests/ranked_quick_match.test.sql
npx supabase test db --local supabase/tests/persistent_accounts_gameplay_progression.test.sql
npx supabase test db --local supabase/tests/qualified_conditional_expressions_regression.test.sql
npx supabase test db --local supabase/tests/solo_session_lifecycle.test.sql
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="<local publishable key>"
npm run test:supabase-ranked
```

The three-client concurrency script creates local email/password users and
checks collision-safe identity initialization, one profile/stat row under
concurrency, exactly one two-player match, a waiting third player, recovery,
cancellation guards, and queue RLS.

## Deployment order

1. Finish and review local checks.
2. Commit the application and migration files locally, but do not push yet.
3. Link the intended Supabase project and review the target.
4. Review pending SQL, then run `npx supabase db push`.
5. Confirm Auth email/linking/URL/SMTP settings.
6. Push `main` so Vercel deploys the already-migrated application.
7. Verify the Vercel source commit equals `git rev-parse HEAD`.
8. Run the production manual checklist below.

Do not deploy the app before the required migration is present: new client RPC
calls will not exist yet. Do not apply a migration to the wrong project.

## Manual verification checklist

1. Create a new account with a valid display name.
2. Confirm weak password guidance and visibility toggle.
3. Confirm the confirmation-pending screen.
4. Verify email and sign in.
5. Reject an incorrect password with a friendly message.
6. Request password recovery.
7. Open the recovery link and set a new password.
8. Confirm expired/used links fail safely without token leakage.
9. Trigger rate limiting and confirm friendly copy.
10. Sign out and confirm protected routes redirect.
11. Open Leaderboard and a public player page while signed out.
12. Claim a legacy anonymous account in place.
13. Confirm its opaque player ID did not change.
14. Confirm its display name, rating, and history did not change.
15. Start a solo game and refresh during the round.
16. Confirm refresh resumes the same seed and authoritative timer.
17. Exit solo early, confirm no partial statistics, and immediately start again.
18. Let a solo round expire through its grace period and confirm one fresh round
    replaces it without a retry.
19. Complete solo and confirm exact-mode statistics update once.
20. Click Play Again and confirm a new seed and no stale path/notification.
21. Create a 3×3 private square.
22. Create an 8×8 private square.
23. Create a 3×8 and an 8×3 rectangle.
24. Compare 4×4 and 8×8 diamonds.
25. Compare 4×4 and 8×8 crosses.
26. Paint a custom mask by mouse/touch.
27. Edit the mask by keyboard.
28. Reject fewer than nine or disconnected custom cells.
29. Verify preview gaps exactly match the active-game gaps.
30. Join a private lobby from a second persistent account.
31. Start and compare exact preview boards on both devices.
32. Approve a unanimous reroll and compare the new boards.
33. Decline a reroll and confirm the original board starts on time.
34. Complete private results and compare placements/words/points.
35. Create a private rematch and accept its invitation.
36. Confirm copied rules/capacity and new seed/room code.
37. Queue two ranked accounts and leave a third waiting.
38. Confirm the eight-second ranked preview.
39. Complete ranked and compare opposite Elo deltas.
40. Request/accept a ranked rematch within 30 seconds.
41. Decline and separately expire a ranked rematch proposal.
42. Verify active-match guards reject duplicate rematches.
43. Test active gameplay at 320, 375, and 430 pixels.
44. Test phone portrait, landscape, safe areas, and rotation mid-drag.
45. Confirm white/green/yellow feedback during a rapid swipe and release.
46. Confirm accepted-word notices overlay without shifting the board.
47. Confirm accepted words use required result ordering.
48. Use the logo during active play and confirm the leave warning.
49. Install the PWA and inspect Cache Storage.
50. Confirm no auth, API, profile, match, or Realtime response is cached.
51. Go offline and confirm only the offline screen/guide are offered.
52. Inspect public RPC responses for UUID, email, token, and private data.
53. Refresh during queue, preview, game, result wait, and rematch proposal.
54. Confirm realtime reconnect and polling recovery without duplicate writes.

## Known limitations

- Hosted database tests are not run automatically; use a local Docker stack or
  a deliberately configured test project.
- Production SMTP, abuse controls, moderation, and final raster install icons
  are operational launch work.
- The broad permissive dictionary can contain obscure words; policy changes
  require explicit overrides and a new version.
- There is no cron dependency. Stale cleanup occurs through bounded returning
  player/queue traffic.
- Social login, friends, chat, spectators, seasons, tournaments, clans, and
  purchases are intentionally outside this phase.
