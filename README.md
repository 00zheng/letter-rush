# Letter Rush

Letter Rush is a mobile-first word-grid game built with Next.js App Router,
React, TypeScript, CSS Modules, and Supabase. It includes the original local
60-second game plus invite-only, anonymous two-player rooms.

Players drag through horizontal, vertical, or diagonal neighbors with mouse,
pen, or touch. Pointer movements and path rendering stay entirely local;
Supabase synchronizes only room state, scheduled timing, and validated results.

## Requirements

- Node.js 20.9 or newer
- npm
- A Supabase project for private matches
- Supabase CLI access if applying migrations from the command line

Single Player does not require Supabase and remains usable when configuration
is absent or Supabase is temporarily unavailable.

## Supabase project setup

1. Create a Supabase project.
2. In the Supabase Dashboard, open **Authentication → Providers** and enable
   **Anonymous Sign-Ins**. This is the only dashboard setting Letter Rush
   requires.
3. Copy `.env.example` to `.env.local` and add the project's public URL and
   publishable key:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

   Both values are designed for public application clients. Do not add a
   service-role key, secret key, database password, or other privileged
   credential. `.env.local` is ignored by Git.

4. Apply
   `supabase/migrations/20260724005143_private_two_player_matches.sql`.

   With an authenticated and linked Supabase CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

   Alternatively, paste that migration into the Supabase Dashboard SQL Editor
   and run it once. The migration creates all required tables, types, indexes,
   triggers, RLS policies, RPCs, the private approved-word table, and Realtime
   publication entries. This repository does not assume those objects already
   exist.

The app throws a clear multiplayer development error naming
`NEXT_PUBLIC_SUPABASE_URL` and/or
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` when either is missing, while preserving
the local game.

## Local development

Install dependencies and start Next.js:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For a realistic private-room check:

1. Open the app in a normal browser window and choose **Create Private
   Match**.
2. Copy its invite link.
3. Open that link in an incognito/private window. The separate cookie jar
   creates a different anonymous Supabase user.
4. Join the room and leave both windows visible through the scheduled
   countdown, round, submission, and results screens.
5. Refresh either window during the countdown or round to verify URL,
   database-state, and local word-draft restoration.

Do not test both player positions in two tabs that share the same browser
profile: the same anonymous account is intentionally prohibited from occupying
both slots.

## How to play

1. Choose **Single Player**, **Create Private Match**, or **Join Private
   Match**.
2. During a round, press or touch a tile and drag through neighboring tiles.
3. Move horizontally, vertically, or diagonally. A tile may appear only once
   in a word.
4. Release the pointer to submit the current word.
5. Words must contain at least three letters, be in the placeholder practice
   dictionary, and not have been accepted earlier in the round.

Dragging back to the immediately previous tile removes the last letter. The
page is prevented from scrolling while a board drag is active.

### Private-room flow

The host receives a six-character, unambiguous room code and can copy either
the code or an invite URL. A row-locked database RPC admits exactly one second
player, then stores one start timestamp five seconds in the future. Both
browsers derive their countdown and authoritative ending timestamp from that
database schedule and a sampled database clock offset.

Gameplay remains immediate and offline-tolerant because tile gestures are not
sent over Realtime. At round end, the browser submits words and their tile
paths. The authenticated Next.js Route Handler regenerates the seeded board,
checks every path and word, and recomputes the score. The database RPC repeats
the security-sensitive validation before storing an immutable result. Results
appear after both players submit; after the recovery window, a missing result
is treated as a forfeit.

## Scoring

| Word length | Points |
| ----------- | -----: |
| 3 letters   |    100 |
| 4 letters   |    400 |
| 5 letters   |    800 |
| 6 letters   |  1,400 |
| 7 letters   |  1,800 |
| 8+ letters  |  2,200 |

The same pure `calculateWordScore` function is used by local gameplay and the
Next.js validator. The migration mirrors this fixed score table as a second
defense against direct RPC calls.

## Security model

- Anonymous users receive the normal Supabase `authenticated` role. Existing
  cookie-backed sessions are reused rather than recreated on refresh.
- Every exposed table has RLS enabled. Profiles are visible only to their owner
  and players who share a match.
- A match and its participant rows are readable only after the requesting user
  has atomically become one of that match's two participants.
- Authenticated clients receive no direct write privilege for matches,
  participant identities, scores, submitted words, finish timestamps, winners,
  or tie state.
- `create_private_match` and `join_private_match` derive the caller from
  `auth.uid()`. Join locks the match row before checking capacity.
- `submit_match_result` derives the caller, locks result state, enforces a
  15-second network grace period, regenerates the deterministic board, and
  validates bounds, adjacency, repeated tiles, claimed letters, dictionary
  membership, duplicate words, and score.
- The first validated result is immutable. Retried submissions return it
  idempotently. Only the finalization functions can set winner, loss, tie, or
  forfeit state.
- Realtime uses Postgres Changes on the RLS-protected match tables. There is no
  public Broadcast channel and no pointer or tile-path stream.
- Only the Supabase URL and publishable key are used. No privileged credential
  is required by the browser, Route Handler, proxy, or migration workflow.

## Quality checks

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

The Vitest suite covers the original adjacency, repeated-tile, path, word,
dictionary-boundary, duplicate, and scoring rules plus seeded board generation,
room-code normalization/validation, multiplayer state transitions, clock
correction, reconnection selection, server-side path and word validation,
score recomputation, duplicate rejection, result comparison, and idempotent
submission behavior.

### Local Supabase schema checks

The pure unit suite does not require a database. To lint and exercise the
migration later with Docker and the Supabase CLI installed:

```bash
npx supabase start
npx supabase db reset
npx supabase db lint --local --level warning
```

Then run the normal/incognito browser scenario against the local project
values. A hosted migration is not applied automatically by this repository.

## Project structure

```text
src/
  app/
    api/matches/results/route.ts   Authenticated result-validation endpoint
    page.tsx                       App entry point
  components/
    game-app.tsx                   Mode menu and create/join controls
    letter-rush-game.tsx           Shared Pointer Events game interface
    private-match-room.tsx         Room, Realtime, recovery, and results UI
  game/
    board.ts                       Default and deterministic seeded boards
    dictionary.ts                  Small placeholder dictionary
    logic.ts                       Pure reusable game rules and scoring
  hooks/
    use-anonymous-auth.ts          Session reuse and guest profile state
  lib/supabase/
    client.ts                      Browser client
    server.ts                      Cookie-aware server client
    database.types.ts              Tables, enums, and RPC result types
  multiplayer/
    display-name.ts                Guest-name sanitization
    room-code.ts                   Room-code normalization and validation
    state.ts                       Pure room-state and reconnection logic
    validation.ts                  Pure authoritative submission checks
src/proxy.ts                       Session refresh proxy
supabase/migrations/
  20260724005143_private_two_player_matches.sql
```

## Known limitations

- The hand-curated dictionary is deliberately small. Replace both
  `src/game/dictionary.ts` and the migration's private approved-word seed with
  the same properly licensed English word source before expanding boards.
- Anonymous identities are device/session scoped. Account recovery and
  cross-device identity are not included.
- CAPTCHA and other anonymous-sign-in abuse controls are not configured by the
  application; enable appropriate Supabase protections before a public launch.
- Realtime has a five-second polling fallback, so temporary socket failures may
  update less immediately.
- There are no rematches, spectators, public rooms, rankings, or random
  matchmaking. Public matchmaking is intentionally deferred to a later phase.
