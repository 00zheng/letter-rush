# Letter Rush

Letter Rush is a mobile-first word-grid game built with Next.js App Router,
React, TypeScript, CSS Modules, and Supabase. It includes an offline-friendly
single-player game plus invite-only, anonymous private lobbies for 2–12
players.

Players drag through horizontal, vertical, or diagonal neighbors with mouse,
touch, or stylus. Pointer movement and connection-line rendering stay local;
Supabase synchronizes only durable, low-frequency lobby and result state.

## Requirements

- Node.js 20.9 or newer
- npm
- A Supabase project for private lobbies
- Supabase CLI and Docker only if running the optional local database checks

Single Player does not require Supabase. It remains available when Supabase is
unconfigured, offline, or temporarily unavailable.

## Quick start

```bash
npm install
npm run dictionary:generate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The dictionary source and generated outputs are already versioned. Generation
is required only after changing the source or override files, but running it is
safe and repeatable.

## Supabase project setup

1. Create a Supabase project.
2. In the Dashboard, open **Authentication → Providers → Anonymous Sign-Ins**
   and enable anonymous sign-ins.
3. Copy `.env.example` to `.env.local`:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

   These are public client values. Do not add a service-role key, secret key,
   database password, or other privileged credential. `.env.local` is ignored
   by Git.

4. Apply all migrations in timestamp order:

   - `supabase/migrations/20260724005143_private_two_player_matches.sql`
   - `supabase/migrations/20260724072923_customizable_multiplayer_lobbies.sql`
   - `supabase/migrations/20260724072929_enable2k_dictionary_seed.sql`

   With an authenticated and linked Supabase CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

   The first migration creates anonymous profiles, the original match schema,
   RLS, secure RPCs, Realtime publication entries, and legacy validation. The
   second safely evolves that schema to immutable versioned rulesets,
   rectangular and masked boards, 2–12-player capacities, atomic lobby joins,
   host-only start/update/cancel operations, generalized authoritative result
   validation, and ranked finalization. Existing match rows are mapped to the
   preserved `legacy-v1` 4×4 generator. The third is a generated data migration
   containing the pinned ENABLE 2K lexicon.

The repository does not apply hosted migrations automatically. The application
shows a clear development error when either public environment variable is
missing, without blocking Single Player.

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

## Vercel deployment

1. Import the repository into Vercel.
2. Keep the detected Next.js framework and npm build command.
3. Configure exactly these environment variables for the desired environments:

   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

4. Apply the Supabase migrations separately.
5. Deploy. HTTPS enables service-worker installation.

No service-role key or database credential belongs in Vercel for this app.

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
- Realtime uses RLS-protected Postgres Changes as a notification. Durable
  database reads remain authoritative and a five-second polling fallback
  handles socket interruptions.
- Only the project URL and publishable key are used. There is no privileged
  credential in browser or server application code.

## Quality checks

```bash
npm run dictionary:generate
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Optional local Supabase checks:

```bash
npx supabase start
npx supabase db reset
npx supabase db lint --local --level warning
```

These need Docker. Hosted integration tests are intentionally not claimed when
no authenticated/local Supabase test instance is available; pure tests cover
rulesets, masks, joins, ranking, dictionary behavior, deterministic boards,
paths, scoring, timing, reconnection, and idempotency.

## Project structure

```text
dictionary/                       Pinned source, license, overrides, generated list
scripts/                          Dictionary generation and lookup tools
src/app/
  api/matches/results/route.ts    Authenticated result-validation endpoint
  manifest.ts                     App Router PWA manifest
  offline/page.tsx                Offline fallback
src/components/
  game-app.tsx                    Deterministic mode menu and lobby creation
  lobby-configurator.tsx          Host rules and custom mask editor
  letter-rush-game.tsx            Shared responsive Pointer Events game
  private-match-room.tsx          Realtime lobby, recovery, and rankings
src/game/
  board.ts                        Legacy and weighted deterministic generators
  dictionary.ts                   Lazy versioned dictionary lookup
  logic.ts                        Pure path, word, duplicate, and score rules
  ruleset.ts                      Typed validation, shapes, masks, and versions
src/multiplayer/
  lobby.ts                        Pure lobby transition checks
  state.ts                        Timing, reconnection, and ranking logic
  validation.ts                   Authoritative submission validation
src/generated/dictionary/         Generated lazy client/server buckets
public/sw.js                      Conservative service worker
supabase/migrations/              Original, lobby evolution, and dictionary seed
```

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
- There are no public random matches, global leaderboards, ratings, friends,
  chat, rematches, or permanent registered accounts. Public matchmaking is
  intentionally deferred.
