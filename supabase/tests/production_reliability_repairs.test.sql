-- Run after `npx supabase db reset`:
--   npx supabase test db --local supabase/tests/production_reliability_repairs.test.sql
begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

select unlike(
  pg_catalog.pg_get_functiondef(
    'public.get_match_word_opportunities(uuid)'::regprocedure
  ),
  '%cache_board_solution%',
  'Board Review never starts a synchronous server solve'
);

select unlike(
  pg_catalog.pg_get_functiondef(
    'public.get_match_word_opportunities(uuid)'::regprocedure
  ),
  '%advisory%',
  'Board Review never waits for an advisory lock'
);

select like(
  pg_catalog.pg_get_functiondef(
    'public.get_match_word_opportunities(uuid)'::regprocedure
  ),
  '%board_solution_cache%',
  'Board Review reads only the optional completed cache'
);

select unlike(
  pg_catalog.pg_get_functiondef(
    'private.select_quality_board_seed(jsonb,bigint)'::regprocedure
  ),
  '%solve_board_words%',
  'private seed selection never invokes the exhaustive dictionary solver'
);

select unlike(
  pg_catalog.pg_get_functiondef(
    'private.select_quality_board_seed(jsonb,bigint)'::regprocedure
  ),
  '%cache_board_solution%',
  'private seed selection never populates a complete solution synchronously'
);

select like(
  pg_catalog.pg_get_functiondef(
    'private.select_quality_board_seed(jsonb,bigint)'::regprocedure
  ),
  '%lightweight_board_quality_report%',
  'private seed selection uses only bounded letter-distribution checks'
);

select unlike(
  pg_catalog.pg_get_functiondef(
    'private.enforce_private_board_quality()'::regprocedure
  ),
  '%select_quality_board_seed%',
  'the private board trigger does not perform duplicate seed selection'
);

select unlike(
  pg_catalog.pg_get_functiondef(
    'private.enforce_private_board_quality()'::regprocedure
  ),
  '%board_quality_report%',
  'the private board trigger never performs full dictionary analysis'
);

select like(
  pg_catalog.pg_get_functiondef(
    'public.create_private_rematch(uuid)'::regprocedure
  ),
  '%select_quality_board_seed%',
  'private rematches use the fast seed selector'
);

select like(
  pg_catalog.pg_get_functiondef(
    'public.vote_match_reroll_cycle(uuid,integer,boolean)'::regprocedure
  ),
  '%select_quality_board_seed%',
  'private rerolls use the fast seed selector'
);

create temporary table reliability_fixture (
  label text primary key,
  match_id uuid,
  board_seed bigint
) on commit drop;
grant select, insert, update on table reliability_fixture to authenticated;

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
values (
  '00000000-0000-0000-0000-000000000000',
  'f1000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'reliability@example.test',
  '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Reliability Player"}'::jsonb,
  false,
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

update public.profiles as profile
set public_profile_id = 'REPAIR2345'
where profile.id = 'f1000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'f1000000-0000-4000-8000-000000000001',
  true
);
set local statement_timeout = '2s';

insert into reliability_fixture (label, match_id, board_seed)
select 'standard', lobby.match_id, lobby.board_seed
from public.create_private_lobby(private.ranked_ruleset(), 2) as lobby;

select ok(
  (
    select fixture.board_seed between 0 and 4294967295
    from reliability_fixture as fixture
    where fixture.label = 'standard'
  ),
  'a standard 4x4 lobby promptly receives a server-owned seed'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.matches as match_row
    join public.match_players as participant
      on participant.match_id = match_row.id
    join reliability_fixture as fixture
      on fixture.match_id = match_row.id
    where fixture.label = 'standard'
      and match_row.host_user_id =
        'f1000000-0000-4000-8000-000000000001'
      and participant.player_user_id = match_row.host_user_id
      and participant.player_number = 1
  ),
  1,
  'lobby and host participant insertion are atomic'
);

select lives_ok(
  $$
    select public.cancel_private_match(
      (
        select fixture.match_id
        from reliability_fixture as fixture
        where fixture.label = 'standard'
      )
    )
  $$,
  'the standard lobby can be closed before creating the large fixture'
);

insert into reliability_fixture (label, match_id, board_seed)
select 'large', lobby.match_id, lobby.board_seed
from public.create_private_lobby(
  pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{rows}',
        '10'::jsonb
      ),
      '{columns}',
      '10'::jsonb
    ),
    '{activeCells}',
    private.generate_shape_mask(10, 10, 'rectangle')
  ),
  2
) as lobby;

select is(
  (
    select (match_row.ruleset ->> 'rows')::integer
    from public.matches as match_row
    join reliability_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'large'
  ),
  10,
  'a custom 10x10 lobby completes within the bounded statement deadline'
);

select throws_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{rows}',
        '11'::jsonb
      ),
      2
    )
  $$,
  'Board rows and columns must be from 3 through 10.',
  'ruleset validation remains server-authoritative'
);

select like(
  pg_catalog.pg_get_functiondef(
    'public.submit_match_result(uuid,jsonb)'::regprocedure
  ),
  '%private.approved_words%',
  'official submitted-word dictionary validation remains unchanged'
);

select like(
  pg_catalog.pg_get_functiondef(
    'public.submit_match_result(uuid,jsonb)'::regprocedure
  ),
  '%seen_tiles%',
  'official no-reuse and adjacency path validation remains unchanged'
);

select * from finish();
rollback;
