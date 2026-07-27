-- Run after `npx supabase db reset`:
--   npx supabase test db supabase/tests/persistent_accounts_gameplay_progression.test.sql
begin;

create extension if not exists pgtap with schema extensions;
select plan(45);

create temporary table progression_fixture (
  label text primary key,
  id uuid not null,
  seed bigint
) on commit drop;
grant select, insert, update on table progression_fixture to authenticated;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'one@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Player One"}'::jsonb,
    false,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a2000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'two@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Player Two"}'::jsonb,
    false,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a3000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'three@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Player Three"}'::jsonb,
    false,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a4000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":[]}'::jsonb,
    '{}'::jsonb,
    true,
    clock_timestamp(),
    clock_timestamp()
  );

select is(
  (
    select profile.display_name
    from public.profiles as profile
    where profile.id = 'a1000000-0000-4000-8000-000000000001'
  ),
  'Player One',
  'signup metadata initializes a validated display name'
);

select ok(
  (
    select profile.public_profile_id
      ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
    from public.profiles as profile
    where profile.id = 'a1000000-0000-4000-8000-000000000001'
  ),
  'persistent signup receives an opaque profile ID'
);

select is(
  (
    select count(*)::integer
    from public.ranked_stats as stats
    where stats.user_id = 'a1000000-0000-4000-8000-000000000001'
  ),
  1,
  'persistent signup receives a ranked statistics row'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a4000000-0000-4000-8000-000000000004',
  true
);
select throws_like(
  $$
    select public.create_solo_session(private.ranked_ruleset())
  $$,
  '%Create or claim an account%',
  'anonymous gameplay is rejected at the database boundary'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    insert into progression_fixture (label, id, seed)
    select 'solo', session.match_id, session.board_seed
    from public.create_solo_session(private.ranked_ruleset()) as session
  $$,
  'a persistent player can create a server-authoritative solo session'
);
reset role;

select ok(
  (
    select
      match_row.mode = 'solo'
      and match_row.max_players = 1
      and match_row.mode_key =
        private.mode_key('solo', match_row.ruleset)
      and match_row.scheduled_start_at is not null
    from public.matches as match_row
    join progression_fixture as fixture on fixture.id = match_row.id
    where fixture.label = 'solo'
  ),
  'solo session stores its authoritative seed, clock, rules, and mode key'
);

update public.match_players as player
set
  finished_at = clock_timestamp(),
  validated_score = 800,
  validated_words = '[{"word":"CRATE","score":800}]'::jsonb
where player.match_id = (
  select fixture.id from progression_fixture as fixture
  where fixture.label = 'solo'
);

select is(
  (
    select match_row.status::text
    from public.matches as match_row
    join progression_fixture as fixture on fixture.id = match_row.id
    where fixture.label = 'solo'
  ),
  'completed',
  'the first immutable solo result completes the session'
);

select is(
  (
    select stats.games_played
    from public.player_mode_stats as stats
    where stats.user_id = 'a1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  1,
  'solo completion updates the exact saved mode once'
);

select is(
  (
    select stats.best_word
    from public.player_mode_stats as stats
    where stats.user_id = 'a1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  'CRATE',
  'saved mode statistics retain the validated best word and score'
);

select is(
  (
    select stats.display_label
    from public.player_mode_stats as stats
    where stats.user_id = 'a1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  'Single Player · 4×4 Rectangle · 60 seconds',
  'saved mode labels are generated from the validated rules snapshot'
);

select is(
  (
    select stats.wins
    from public.player_mode_stats as stats
    where stats.user_id = 'a1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  0,
  'solo statistics remain score-only instead of recording competition wins'
);

select lives_ok(
  $$
    select private.record_mode_statistics(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'solo'
      )
    )
  $$,
  'repeated mode-stat finalization is accepted'
);

select is(
  (
    select stats.games_played
    from public.player_mode_stats as stats
    where stats.user_id = 'a1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  1,
  'mode-stat event idempotency prevents double counting'
);

select isnt(
  private.mode_key('solo', private.ranked_ruleset()),
  private.mode_key('ranked', private.ranked_ruleset()),
  'the category is part of the canonical mode key'
);

select isnt(
  private.mode_key('private', private.ranked_ruleset()),
  private.mode_key(
    'private',
    jsonb_set(
      private.ranked_ruleset(),
      '{roundDurationSeconds}',
      '90'::jsonb
    )
  ),
  'round duration changes the canonical mode key'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
insert into progression_fixture (label, id, seed)
select 'private', lobby.match_id, lobby.board_seed
from public.create_private_lobby(private.ranked_ruleset(), 4) as lobby;

select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.join_private_match(
      (
        select match_row.room_code
        from public.matches as match_row
        join progression_fixture as fixture on fixture.id = match_row.id
        where fixture.label = 'private'
      )
    )
  $$,
  'a persistent participant can join the private lobby'
);

select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.start_private_match(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      )
    )
  $$,
  'the host can start an eight-second preview'
);
reset role;

select ok(
  (
    select
      match_row.preview_ends_at = match_row.scheduled_start_at
      and match_row.preview_ends_at - match_row.preview_started_at
        = interval '8 seconds'
    from public.matches as match_row
    join progression_fixture as fixture on fixture.id = match_row.id
    where fixture.label = 'private'
  ),
  'the database owns the pregame preview window'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.vote_match_reroll_cycle(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      0,
      true
    )
  $$,
  'the first participant can approve a reroll'
);
select lives_ok(
  $$
    select public.vote_match_reroll_cycle(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      0,
      true
    )
  $$,
  'a duplicate reroll vote is idempotent and unambiguous'
);
select is(
  (
    select state.reroll_approvals
    from public.get_match_preview_state(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      )
    ) as state
  ),
  1,
  'a duplicate reroll vote remains one approval'
);

select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.vote_match_reroll(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      true
    )
  $$,
  'the final unanimous vote atomically rerolls'
);
reset role;

select ok(
  (
    select
      match_row.reroll_used
      and match_row.reroll_status = 'idle'
      and match_row.reroll_requested_by is null
      and match_row.reroll_requested_at is null
      and match_row.board_revision = 1
      and match_row.reroll_sequence = 1
      and match_row.board_seed <> fixture.seed
      and match_row.preview_ends_at - match_row.preview_started_at
        = interval '8 seconds'
    from public.matches as match_row
    join progression_fixture as fixture on fixture.id = match_row.id
    where fixture.label = 'private'
  ),
  'one successful reroll advances the revision and restarts preview'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.vote_match_reroll(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      true
    )
  $$,
  'a second reroll cycle can be requested'
);

select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.vote_match_reroll(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      true
    )
  $$,
  'a second unanimous reroll succeeds'
);
reset role;

select ok(
  (
    select
      match_row.board_revision = 2
      and match_row.reroll_sequence = 2
      and match_row.reroll_status = 'idle'
      and match_row.preview_ends_at - match_row.preview_started_at
        = interval '8 seconds'
    from public.matches as match_row
    join progression_fixture as fixture on fixture.id = match_row.id
    where fixture.label = 'private'
  ),
  'rerolls remain unlimited and revision-scoped'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
select throws_like(
  $$
    select public.vote_match_reroll_cycle(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      1,
      true
    )
  $$,
  '%board changed%',
  'a vote from an old board revision is rejected'
);
select lives_ok(
  $$
    select public.vote_match_countdown_skip(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      2
    )
  $$,
  'the first player can vote to skip the current revision countdown'
);
select lives_ok(
  $$
    select public.vote_match_countdown_skip(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      2
    )
  $$,
  'a duplicate skip vote is idempotent and unambiguous'
);
select is(
  (
    select state.skip_approvals
    from public.get_match_preview_state(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      )
    ) as state
  ),
  1,
  'a nonunanimous skip vote leaves one approval'
);

select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.vote_match_countdown_skip(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      ),
      2
    )
  $$,
  'the final participant can unanimously skip the countdown'
);
reset role;

select ok(
  (
    select
      match_row.scheduled_start_at <= pg_catalog.clock_timestamp()
        + interval '1 second'
      and (
        select pg_catalog.count(*)
        from public.match_countdown_skip_votes as vote
        where vote.match_id = match_row.id
          and vote.board_revision = 2
      ) = 2
    from public.matches as match_row
    join progression_fixture as fixture on fixture.id = match_row.id
    where fixture.label = 'private'
  ),
  'unanimous skip uses one database-authored synchronized start timestamp'
);

update public.match_players as player
set
  finished_at = clock_timestamp(),
  validated_score = case when player.player_number = 1 then 400 else 100 end,
  validated_words = '[]'::jsonb
where player.match_id = (
  select fixture.id from progression_fixture as fixture
  where fixture.label = 'private'
);
select ok(
  private.finalize_completed_lobby(
    (
      select fixture.id from progression_fixture as fixture
      where fixture.label = 'private'
    )
  ),
  'private results still finalize after preview and reroll'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
insert into progression_fixture (label, id)
select 'private-proposal', rematch.proposal_id
from public.request_two_player_rematch(
  (
    select fixture.id from progression_fixture as fixture
    where fixture.label = 'private'
  )
) as rematch;
select lives_ok(
  $$
    select public.request_two_player_rematch(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private'
      )
    )
  $$,
  'two-player private rematch requests are idempotent'
);

select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
insert into progression_fixture (label, id)
select 'private-rematch', response.match_id
from public.respond_two_player_rematch(
  (
    select fixture.id from progression_fixture as fixture
    where fixture.label = 'private-proposal'
  ),
  true
) as response;

reset role;

select is(
  (
    select count(*)::integer
    from public.matches as match_row
    join progression_fixture as source
      on source.id = match_row.rematch_of
    where source.label = 'private'
      and match_row.mode = 'private'
  ),
  1,
  'a completed two-player private match produces exactly one direct rematch'
);

select is(
  (
    select count(*)::integer
    from public.match_players as player
    join progression_fixture as fixture on fixture.id = player.match_id
    where fixture.label = 'private-rematch'
  ),
  2,
  'both private players enter the accepted rematch directly'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.respond_two_player_rematch(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'private-proposal'
      ),
      true
    )
  $$,
  'private mutual acceptance is idempotent'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.private_rematch_invitations as invitation
    join progression_fixture as fixture on fixture.id = invitation.match_id
    where fixture.label = 'private-rematch'
  ),
  0,
  'the two-player mutual flow does not create group invitations'
);

update public.matches as match_row
set
  status = 'cancelled',
  scheduled_start_at = null,
  preview_started_at = null,
  preview_ends_at = null
where match_row.id = (
  select fixture.id from progression_fixture as fixture
  where fixture.label = 'private-rematch'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select public.enter_ranked_queue();
select set_config(
  'request.jwt.claim.sub',
  'a3000000-0000-4000-8000-000000000003',
  true
);
select public.enter_ranked_queue();
reset role;

insert into progression_fixture (label, id, seed)
select 'ranked', match_row.id, match_row.board_seed
from public.matches as match_row
join public.match_players as player on player.match_id = match_row.id
where match_row.mode = 'ranked'
  and player.player_user_id =
    'a2000000-0000-4000-8000-000000000002'
order by match_row.created_at desc
limit 1;

update public.match_players as player
set
  finished_at = clock_timestamp(),
  validated_score = case when player.player_number = 1 then 800 else 400 end,
  validated_words = '[]'::jsonb
where player.match_id = (
  select fixture.id from progression_fixture as fixture
  where fixture.label = 'ranked'
);
select private.finalize_completed_lobby(
  (
    select fixture.id from progression_fixture as fixture
    where fixture.label = 'ranked'
  )
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.request_two_player_rematch(
      (
        select fixture.id from progression_fixture as fixture
        where fixture.label = 'ranked'
      )
    )
  $$,
  'a completed ranked participant can request a rematch'
);

select set_config(
  'request.jwt.claim.sub',
  'a3000000-0000-4000-8000-000000000003',
  true
);
select lives_ok(
  $$
    select public.respond_two_player_rematch(
      (
        select proposal.id
        from public.two_player_rematch_proposals as proposal
        join progression_fixture as fixture
          on fixture.id = proposal.source_match_id
        where fixture.label = 'ranked'
      ),
      true
    )
  $$,
  'the other ranked participant can accept within 15 seconds'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.matches as match_row
    join progression_fixture as fixture
      on fixture.id = match_row.rematch_of
    where fixture.label = 'ranked'
      and match_row.mode = 'ranked'
  ),
  1,
  'ranked rematch acceptance creates exactly one match'
);

select ok(
  (
    select
      rematch.board_seed <> source.seed
      and rematch.ruleset = private.ranked_ruleset()
      and rematch.preview_ends_at - rematch.preview_started_at
        = interval '8 seconds'
    from public.matches as rematch
    join progression_fixture as source on source.id = rematch.rematch_of
    where source.label = 'ranked'
  ),
  'ranked rematch uses fixed rules, a new seed, and a fresh preview'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'a3000000-0000-4000-8000-000000000003',
  true
);
select lives_ok(
  $$
    select public.respond_two_player_rematch(
      (
        select proposal.id
        from public.two_player_rematch_proposals as proposal
        join progression_fixture as fixture
          on fixture.id = proposal.source_match_id
        where fixture.label = 'ranked'
      ),
      true
    )
  $$,
  'an accepted ranked proposal returns idempotently without a duplicate match'
);
reset role;

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prosecdef
      and not (
        exists (
          select 1
          from pg_catalog.unnest(
            coalesce(
              procedure.proconfig,
              array[]::text[]
            )
          ) as setting(value)
          where setting.value in ('search_path=', 'search_path=""')
        )
      )
  ),
  'every SECURITY DEFINER function keeps an explicit empty search_path'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.player_mode_stats',
    'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.match_reroll_votes',
    'INSERT'
  ),
  'clients cannot bypass progression or reroll RPCs with direct writes'
);

select * from finish();
rollback;
