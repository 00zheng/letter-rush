# Letter Rush

Letter Rush is a mobile-first word-grid game built with Next.js App Router,
React, TypeScript, CSS Modules, and Supabase. It includes an offline-friendly
single-player game, anonymous two-player ranked Quick Match, public ranked
profiles and leaderboards, plus invite-only private lobbies for 2–12 players.

Players drag through horizontal, vertical, or diagonal neighbors with mouse,
touch, or stylus. Pointer movement and connection-line rendering stay local;
Supabase synchronizes only durable, low-frequency lobby and result state.

Production origin: [https://letter-rush-tau.vercel.app](https://letter-rush-tau.vercel.app/)

## Requirements

- Node.js 20.9 or newer
- npm
- A Supabase project for multiplayer, ranked profiles, and leaderboards
- Supabase CLI and Docker only if running the optional local database checks

Single Player does not require Supabase. It remains available when Supabase is
unconfigured, offline, or temporarily unavailable.

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`NEXT_PUBLIC_APP_URL` falls back to `http://localhost:3000` in development.
Set it explicitly when using another local origin so copied invite links point
to the address other devices can reach.

The dictionary source and generated outputs are versioned. `npm run build`
runs the deterministic generator first, using only repository files; no
dictionary is downloaded during installation, build, or application runtime.
Run `npm run dictionary:generate` directly after changing a source or override
file.

## Supabase project setup

1. Create a Supabase project.
2. In the Dashboard, open **Authentication → Providers → Anonymous Sign-Ins**
   and enable anonymous sign-ins.
3. Copy `.env.example` to `.env.local`:

   ```env
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

   These are public client values. `NEXT_PUBLIC_APP_URL` must contain only an
   absolute application origin: no path, query, fragment, or credentials.
   Production requires HTTPS. Do not add a service-role key, secret key,
   database password, or other privileged credential. `.env.local` is ignored
   by Git.

4. Apply all migrations in timestamp order:

   - `supabase/migrations/20260724005143_private_two_player_matches.sql`
   - `supabase/migrations/20260724072923_customizable_multiplayer_lobbies.sql`
   - `supabase/migrations/20260724072929_enable2k_dictionary_seed.sql`
   - `supabase/migrations/20260724092826_sync_enable2k_dictionary_v1.sql`
   - `supabase/migrations/20260724095312_ranked_quick_match.sql`

   With an authenticated and linked Supabase CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref rrkhmsotcwxphufrlvah
   npx supabase db push
   ```

   The first migration creates anonymous profiles, the original match schema,
   RLS, secure RPCs, Realtime publication entries, and legacy validation. The
   second safely evolves that schema to immutable versioned rulesets,
   rectangular and masked boards, 2–12-player capacities, atomic lobby joins,
   host-only start/update/cancel operations, generalized authoritative result
   validation, and ranked finalization. Existing match rows are mapped to the
   preserved `legacy-v1` 4×4 generator. The third is a generated data migration
   containing the pinned ENABLE 2K lexicon. The fourth performs an exact,
   idempotent synchronization of that same version, removes drift within only
   that version, and asserts both its expected count and the `crate` regression
   word. The fifth adds opaque public profile IDs, the private ranked queue,
   fixed ranked matches, Elo and aggregate statistics, rating history,
   sanitized public-read RPCs, narrow RLS, and atomic/idempotent ranked
   finalization. Existing migration files remain immutable.

The repository does not apply hosted migrations automatically. The application
shows a clear development error when either Supabase environment variable is
missing, without blocking Single Player. A production build fails clearly when
`NEXT_PUBLIC_APP_URL` is missing or invalid, preventing localhost canonical and
invite URLs from reaching a deployment.

### Normal/incognito multiplayer test

1. Open the app in a normal window and create a private lobby.
2. Copy the invite link.
3. Open it in an incognito/private window so Supabase creates a different
   anonymous user.
4. Join with the room code. Add more private windows or browser profiles to
   test larger lobbies.
5. Have the host start the countdown.
6. Keep all windows visible through countdown, play, validation, and ranked
   results.
7. Refresh one window during the lobby, countdown, and round to verify URL,
   database-state, clock, and local-draft restoration.
8. Briefly take one player offline. The local board remains responsive and the
   room shows an offline state; reconnect before result submission.

Two tabs sharing one browser profile share the same anonymous account and
cannot occupy two positions. This is intentional.

For ranked Quick Match, open `/quick-match` in a normal window and an Incognito
window. Queue both guests, verify they enter one shared match, and keep both
windows open through validation and the rating result. A third independent
browser profile should remain waiting rather than joining the two-player match.

## Gameplay and lobby rules

### Single Player

The original full 4×4 board and 60-second scoring loop are preserved. Press or
touch a tile, drag through adjacent tiles, and release to submit. A tile cannot
be repeated in one word. Dragging back to the immediately previous tile removes
the last letter.

### Private lobbies

Before creating a lobby, the host chooses:

- 4×4, 5×5, 6×6, or 8×8 presets, or a custom 3×3–8×8 rectangle
- Rectangle, diamond, cross, or a custom connected active-cell mask
- 30, 60, 90, 120, or 180 seconds
- A maximum of 2–12 players

Custom boards need at least nine active cells and must be connected. Inactive
cells contain no letters, cannot be selected, and do not participate in path
validation.

The host shares a six-character room code or invite URL. Joins are serialized
by a row lock and cannot exceed the stored capacity. Only the host can start
or cancel a waiting lobby. Once started, nobody else can join and the ruleset
snapshot is immutable.

All participants receive the same board seed, ruleset, board-generation
version, dictionary version, scheduled start, and duration. Everyone plays an
independent local copy of that board. Results use competition ranking: equal
scores share a placement, so rankings can read `1, 1, 3`.

### Ranked Quick Match

Quick Match has no host or settings. It always creates exactly two participant
rows and snapshots `ranked-v1`: a full 4×4 rectangle, all 16 cells active, a
60-second round, minimum word length 3, `enable2k-af52415-v1`,
`classic-v1`, and `weighted-v2`. The database supplies one uint32 board seed
and one start time five seconds in the future. Both browsers preload the
board-relevant dictionary buckets during the countdown; pointer movement and
provisional scoring stay local.

Queue entry is one transactional RPC. It derives the player from `auth.uid()`,
reads the current authoritative rating, takes a per-user advisory lock, expires
heartbeats older than 35 seconds, and row-locks the oldest compatible candidate
with `FOR UPDATE SKIP LOCKED`. A queue row is unique per user. A player already
in a starting or active ranked match is returned to that match instead of
receiving another.

The initial rating gap is 150 points. Database time widens it by 50 every 10
seconds, reaches 600 at 90 seconds, and accepts any waiting rating after 90
seconds. The browser heartbeats about every 10 seconds and polls as a fallback;
Realtime is only a refetch notification. Queue timers are presentation-only.
Cancellation is allowed only while waiting, and a two-second database throttle
discourages rapid enter/cancel loops.

Ranked results reuse both validation layers: the Next.js Route Handler and
Postgres independently regenerate the board, verify coordinates, adjacency,
tile uniqueness, claimed letters, dictionary membership, duplicate words,
timing, and classic score. The stored ranked snapshot must exactly match the
supported version. The normal round has a 15-second submission network grace
period. After an additional 45-second recovery window, one missing result is a
forfeit and the submitted player wins; two missing results abandon the match
with no game, statistic, or rating change.

### Elo ratings and ranked statistics

Every player starts at 1,000. Letter Rush uses standard Elo expected score,
K-factor 32, actual scores 1/0.5/0 for win/tie/loss, whole-number changes, and a
display floor of 100. The first player’s rounded delta is mirrored for the
second so every match remains zero-sum. A forfeit is a loss; an equal validated
score is a tie.

Finalization locks the match and both statistic rows in UUID order. It updates
rating, peak, games, wins, losses, ties, forfeits, best and total validated
score, current/best win streak, current unbeaten streak, and last match time in
the same transaction as two immutable rating-history entries. A match-level
rating state plus the `(match_id, user_id)` history uniqueness constraint makes
retries idempotent. Private lobby finalization never enters this branch.

A win increments the current win streak. A tie, loss, or forfeit resets it;
best win streak retains the maximum. An abandoned match changes nothing.

### Public profiles and leaderboards

The database assigns every profile a stable 10-character identifier from
unambiguous uppercase characters. Collision retries happen server-side, and
public URLs never contain the auth UUID. `/profile` opens the signed-in guest’s
page; `/players/[publicProfileId]` shows a sanitized name, deterministic
initials badge, rating, peak, record, win percentage, scores, streaks, ranked
join date, and at most 10 recent ranked matches. The profile link can be copied
from the page. Private-lobby history and auth data are never included.

`/leaderboards` provides all-time Rating, Best Score, and Wins views, 25 rows
per page. Zero-game profiles are excluded. Equal primary values use competition
ranking (`1, 1, 3`). Rating ties use peak rating, games descending, then public
ID. Best Score and Wins ties use rating, games ascending, then public ID. A
separate bounded query shows the signed-in player’s placement when their row is
outside the current page.

## Scoring

| Word length | Points |
| ----------- | -----: |
| 3 letters   |    100 |
| 4 letters   |    400 |
| 5 letters   |    800 |
| 6 letters   |  1,400 |
| 7 letters   |  1,800 |
| 8+ letters  |  2,200 |

`classic-v1` is shared by local play, the Next.js validator, and the database
validator.

## Dictionary

Letter Rush uses the public-domain ENABLE 2K list pinned to
`BartMassey/wordlists` commit
`af52415c13af809bd8757a40f17f46e79d09583c`. The upstream public-domain notice
is in `dictionary/LICENSE-ENABLE.txt`; source and override details are in
`dictionary/README.md`.

Generation:

```bash
npm run dictionary:generate
npm run dictionary:lookup -- quixotic
```

The generator normalizes lowercase ASCII alphabetic entries, applies
`dictionary/custom-allowed.txt` and `dictionary/custom-blocked.txt`, produces a
versioned normalized file, creates 26 lazy first-letter modules for the client
and server, and can regenerate the SQL data migration. A phone loads only the
first-letter bucket needed for a submitted word.

The game and database both identify the lexicon as
`enable2k-af52415-v1`. This is Letter Rush’s own permissive game lexicon. It is
not, and does not claim to match, GamePigeon Word Hunt, Scrabble, or another
proprietary commercial dictionary.

For non-sensitive production troubleshooting, `GET /api/dictionary` returns
only the active dictionary version and word count. For example:

```bash
curl https://letter-rush-tau.vercel.app/api/dictionary
```

The expected response is
`{"version":"enable2k-af52415-v1","wordCount":173528}`.

To regenerate the SQL data migration after an intentional dictionary-version
change:

```bash
npm run dictionary:generate -- --sql-output=supabase/migrations/YOUR_CLI_GENERATED_MIGRATION.sql
```

Always create `YOUR_CLI_GENERATED_MIGRATION.sql` first with
`npx supabase migration new ...`; never rewrite an applied migration.

## Deterministic boards

- `legacy-v1` preserves the original rotated/reflected 4×4 board for existing
  matches.
- `weighted-v2` uses an explicit English-weighted distribution and a
  deterministic vowel floor.
- Seed, complete ruleset, active-cell mask, and generation version are stored
  with the match.
- Known-seed fixtures cover 4×4, 5×5, 6×6, and 8×8 boards.

A future generator must use a new version identifier rather than silently
changing stored boards.

## Mobile and Pointer Events behavior

- Layouts begin at 320 CSS pixels with no horizontal board scrolling.
- Tile, gap, type, radius, and line widths scale for boards through 8×8.
- Safe-area insets are used on menu, lobby, game, results, and offline screens.
- The manifest does not disable browser zoom.
- Pointer Events support mouse, touch, and stylus.
- Body scrolling is locked only during an active board gesture, then restored.
- The board blocks accidental selection, dragging, and context menus.
- Pointer cancellation, lost capture, window blur, and hidden tabs clear the
  selected path.
- A `ResizeObserver`, orientation listener, and Visual Viewport resize/scroll
  listeners remeasure the SVG path from actual tile centers.
- Pointer coordinates and animation frames are never sent through Supabase.

## PWA and phone testing

Run the dev server on all local interfaces:

```bash
npm run dev -- --hostname 0.0.0.0
```

Find the computer’s LAN address:

- Windows: run `ipconfig` and use the Wi-Fi adapter’s IPv4 address.
- macOS/Linux: run `ifconfig` or `ip addr` and use the Wi-Fi/LAN address.

With the phone on the same Wi-Fi, open
`http://YOUR_COMPUTER_IP:3000`. Allow Node.js through the local firewall if the
phone cannot connect.

To make copied invite links use that LAN address, set this local public value
before starting the development server:

```env
NEXT_PUBLIC_APP_URL=http://YOUR_COMPUTER_IP:3000
```

Phone checklist:

1. Test widths near 320, 375, and 430 CSS pixels.
2. Test portrait and landscape.
3. Play 4×4, 5×5, 6×6, and 8×8 rectangle boards.
4. Test diamond, cross, and custom masks.
5. Drag off the board, background the app, rotate mid-drag, and trigger an
   interrupted touch; selection and scroll locking must clear.
6. Confirm text selection, image dragging, and long-press context menus do not
   interfere with the board.
7. Confirm page scrolling works on menu/results and after a drag.
8. Toggle airplane mode: loaded Single Player remains local, while multiplayer
   reports offline/reconnecting and never pretends to be authoritative.
9. Reconnect and verify the room and result recover.

Install:

- iOS/iPadOS Safari: **Share → Add to Home Screen**.
- Android Chrome: browser menu → **Install app** or **Add to Home screen**.

The current SVG icons are explicit placeholders. Platform install prompts and
icon treatment vary; replace them with production PNG/maskable artwork before
release. Service workers require HTTPS outside localhost. The production-only
service worker caches a credential-free root shell, offline fallback, icons,
manifest, and immutable Next.js static assets. It never caches cross-origin
Supabase requests, `/api` or `/auth`, authorization-bearing requests, non-GET
requests, Realtime traffic, or result submissions.

The validated `NEXT_PUBLIC_APP_URL` is the single source for canonical and Open
Graph metadata, manifest identity/start/scope/icon URLs, and copied private
invite links. Runtime API and service-worker requests remain same-origin.

## Vercel deployment

1. Import the repository into Vercel.
2. Keep the detected Next.js framework and npm build command.
3. Configure exactly these environment variables for the desired environments:

   - `NEXT_PUBLIC_APP_URL=https://letter-rush-tau.vercel.app`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

   Set the production value in the Production environment. Preview builds also
   run in production mode, so configure `NEXT_PUBLIC_APP_URL` for Preview too:
   use a stable Preview HTTPS origin when available, or reuse the Production
   origin when previews should deliberately canonicalize and invite into the
   public app.

4. Apply the Supabase migrations separately.
5. Redeploy after changing a `NEXT_PUBLIC_` value because Next.js embeds public
   environment variables at build time. HTTPS enables service-worker
   installation.

No service-role key or database credential belongs in Vercel for this app.
Ranked play requires no new environment variable: it uses the existing
application origin, Supabase URL, and publishable key. Apply the migration
before redeploying the pushed commit; then use **Redeploy** in the Vercel
deployment menu (or let the `origin/main` push trigger the configured
deployment).

## Hydration diagnosis

The attributes `data-new-gr-c-s-check-loaded` and `data-gr-ext-installed` are
injected by grammar-browser extensions; Letter Rush does not render them. Do
not hide that warning with `suppressHydrationWarning`. Verify extension-only
warnings in Incognito or a clean browser profile.

The application keeps the initial server/client tree deterministic:

- no render-time `Math.random()` or `Date.now()`
- no render-time `window`, `document`, or `localStorage` reads
- a stable UUID-derived guest name
- versioned deterministic board generation
- fixed-locale score formatting
- authentication, URL restoration, online state, clocks, and storage reads
  begin in effects

An automated server-render determinism test renders the initial app twice and
compares the markup.

## Security model

- Anonymous users use Supabase’s `authenticated` role and reuse one
  cookie-backed browser session.
- Every exposed table has RLS. Matches, participant rows, and participant
  profiles are readable only to people already in that match.
- Raw queue, ranked-stat, and rating-history rows are self-only. Clients have
  no insert, update, or delete privilege on them; queue and rating changes are
  narrow RPC-only operations.
- Public profile, recent-match, and leaderboard RPCs return explicit sanitized
  columns and opaque public IDs. They never expose auth UUIDs, emails, tokens,
  provider data, queue membership, or private-lobby history.
- Clients have no direct write privilege for match state, participant
  identity, scores, words, finish timestamps, winner, or tie state.
- Security-definer RPCs derive identity from `auth.uid()`; they never trust a
  client-supplied user ID and use an empty `search_path`.
- Create normalizes the complete ruleset. Join locks the match row before
  checking duplicate membership, status, and capacity. Start/update/cancel are
  host-only.
- The Next.js Route Handler authenticates the requester, reads only an
  RLS-visible match, validates the stored ruleset and dictionary version,
  regenerates the board, verifies every path, and recomputes score.
- `submit_match_result` repeats the sensitive checks in Postgres before an
  immutable idempotent write. It enforces database time plus a documented
  15-second network grace period.
- Only database finalization assigns winner/tie/loss/forfeit state.
- Ranked finalization locks the match and stat rows, recomputes K=32 Elo in
  Postgres, and writes a unique two-sided rating ledger. Browsers cannot choose
  ratings, deltas, outcomes, statistics, or leaderboard ranks.
- Realtime uses RLS-protected Postgres Changes as a notification. Durable
  database reads remain authoritative and a five-second polling fallback
  handles socket interruptions.
- Only the project URL and publishable key are used. There is no privileged
  credential in browser or server application code.

## Quality checks

```bash
npm run dictionary:generate
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run build` repeats dictionary generation through `prebuild`, so CI and
Vercel verify the pinned archive checksum and recreate the committed artifacts
before compiling Next.js.

Optional local Supabase checks:

```bash
npx supabase start
npx supabase db reset
npx supabase db lint --local --level warning
npx supabase test db --local supabase/tests/ranked_quick_match.test.sql
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="<local publishable key>"
npm run test:supabase-ranked
```

These need Docker. Hosted integration tests are intentionally not claimed when
no authenticated/local Supabase test instance is available. The rollback-only
pgTAP fixture covers fixed match creation, private/ranked isolation, Elo
idempotency, queue RLS, public projections, forfeits, and abandonment. The
local-only three-client script checks simultaneous matching, the two-player
limit, a waiting third player, duplicate recovery, cancellation guards, and
queue enumeration. Pure tests cover the remaining rule and state logic.

## Project structure

```text
dictionary/                       Pinned source, license, overrides, generated list
scripts/                          Dictionary generation and lookup tools
src/app/
  api/dictionary/route.ts         Public dictionary version/count diagnostics
  api/matches/results/route.ts    Authenticated result-validation endpoint
  manifest.ts                     App Router PWA manifest
  offline/page.tsx                Offline fallback
  quick-match/page.tsx            Ranked queue route
  ranked/[matchId]/page.tsx       Ranked countdown/game/result recovery
  leaderboards/page.tsx           Paginated all-time rankings
  players/[publicProfileId]/      Sanitized public player profile
  profile/page.tsx                Current-player profile entry point
src/components/
  game-app.tsx                    Deterministic mode menu and lobby creation
  lobby-configurator.tsx          Host rules and custom mask editor
  letter-rush-game.tsx            Shared responsive Pointer Events game
  private-match-room.tsx          Realtime lobby, recovery, and rankings
  quick-match-client.tsx          Heartbeat, widening queue, and cancellation
  ranked-match-room.tsx           Ranked game/reconnect/result UI
  ranked-pages.tsx                Profile and leaderboard UI
src/game/
  board.ts                        Legacy and weighted deterministic generators
  dictionary.ts                   Lazy versioned dictionary lookup
  logic.ts                        Pure path, word, duplicate, and score rules
  ruleset.ts                      Typed validation, shapes, masks, and versions
src/multiplayer/
  lobby.ts                        Pure lobby transition checks
  state.ts                        Timing, reconnection, and ranking logic
  validation.ts                   Authoritative submission validation
src/ranked/
  ruleset.ts                      Canonical fixed ranked snapshot
  rating.ts                       Pure Elo and aggregate-stat logic
  matchmaking.ts                  Pure widening, stale, and recovery states
  finalization.ts                 Pure forfeit/abandonment decisions
src/lib/app-url.ts                Validated canonical and invite-link origin
src/generated/dictionary/         Generated lazy client/server buckets
public/sw.js                      Conservative, versioned service-worker cache
supabase/migrations/              Schema evolution and versioned dictionary sync
supabase/tests/                   Rollback-only ranked pgTAP fixture
```

## Production dictionary verification

After pushing `main` and applying pending hosted migrations:

1. Confirm the Vercel deployment source commit matches `git rev-parse HEAD`.
2. Confirm the build log runs `prebuild` and reports 173,528 generated words.
3. Request `/api/dictionary` and verify version `enable2k-af52415-v1` and word
   count `173528`.
4. Reload once so the `letter-rush-shell-v3` service worker activates. If a
   browser still displays an older offline shell, close all app tabs, unregister
   the old worker in browser developer tools, and reload.
5. In Single Player, trace `C→R→A→T→E` on the default board and verify
   `CRATE accepted - +800 points`.
6. In a migrated private lobby, submit a valid word and confirm authoritative
   result validation completes instead of reporting dictionary-version drift.

## Known limitations and deferred work

- Anonymous identity is browser/session scoped; clearing data or switching
  devices creates another guest. Permanent accounts are intentionally absent.
- The dictionary is broad and may include obscure terms. Policy changes should
  use the explicit allow/block files and a new dictionary version.
- The custom mask editor validates 8-direction connectivity because diagonal
  movement is legal.
- Realtime and multiplayer do not work offline; only local gameplay does.
- Production raster icons and store-grade install artwork are not included.
- Automated hosted Supabase concurrency tests require a configured test project
  or local Docker instance.
- Opportunistic cleanup needs a queue or returning participant request; there
  is no cron dependency. A fully abandoned database row may remain until a
  participant returns, while its stale queue membership is retired by normal
  queue traffic.
- Anonymous guests can clear browser storage to create a new identity. Queue
  throttling and database constraints provide basic abuse resistance, not a
  complete public-launch moderation or device-attestation system.
- Friends, chat, rematches, public custom-game queues, seasons, tournaments,
  clans, purchases, social/email login, spectators, and permanent registered
  accounts remain intentionally deferred.

## Post-migration ranked verification

Do not treat the feature as deployed until the new migration is applied and
Vercel is redeployed from the pushed commit.

1. Run `npx supabase login`.
2. Run `npx supabase link --project-ref rrkhmsotcwxphufrlvah`.
3. Run `npx supabase db push`.
4. Open a normal browser and an Incognito browser.
5. Queue both users and confirm they match exactly once.
6. Confirm both see the same board and synchronized countdown.
7. Submit different scores.
8. Confirm rating deltas are opposite integers and sum to zero.
9. Confirm winner/loser games, record, score, and streak statistics.
10. Confirm the rating leaderboard and each user’s placement.
11. Open both opaque public-profile URLs and copy one profile link.
12. Complete a private custom game and confirm neither rating changes.
13. Cancel a waiting queue entry.
14. Refresh while queued and confirm the wait is restored.
15. Refresh after match found and confirm the same match is restored.
16. Refresh during the game and confirm board, clock, and draft recovery.
17. Refresh while waiting for the opponent result.
18. Close a waiting browser for more than 35 seconds, generate queue traffic
    from another browser, and confirm stale cleanup.
19. Let one player submit and the other miss the 45-second recovery window;
    confirm a clearly labeled forfeit.
20. Let neither player submit; confirm abandonment and no rating/stat change.
21. Test Quick Match at 320, 375, and 430 CSS pixels and on a real phone.
22. Install the PWA and confirm queue, profile, leaderboard, and result data are
    current rather than served from cache.
23. Inspect public profile and leaderboard network responses and confirm no
    UUID, email, token, queue, or private-lobby data appears.
24. Use a third independent browser profile and confirm one two-player match
    forms while the third user remains queued.
