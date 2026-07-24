-- Run after `npx supabase db reset`:
--   npx supabase test db supabase/tests/ranked_quick_match.test.sql
-- The transaction is rolled back, so this fixture never persists test users.
begin;

create extension if not exists pgtap with schema extensions;
select plan(28);

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
    '10000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":[]}'::jsonb,
    '{}'::jsonb,
    true,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":[]}'::jsonb,
    '{}'::jsonb,
    true,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '30000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":[]}'::jsonb,
    '{}'::jsonb,
    true,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000004',
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

update public.profiles as profile
set
  public_profile_id = case profile.id
    when '10000000-0000-4000-8000-000000000001'
      then 'TESTAA2345'
    when '20000000-0000-4000-8000-000000000002'
      then 'TESTBB2345'
    when '30000000-0000-4000-8000-000000000003'
      then 'TESTCC2345'
    else 'TESTDD2345'
  end,
  display_name = case profile.id
    when '10000000-0000-4000-8000-000000000001'
      then 'Queue Alpha'
    when '20000000-0000-4000-8000-000000000002'
      then 'Queue Bravo'
    when '30000000-0000-4000-8000-000000000003'
      then 'Private Alpha'
    else 'Private Bravo'
  end
where profile.id in (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004'
);

select is(
  (
    select stats.current_rating
    from public.ranked_stats as stats
    where stats.user_id = '10000000-0000-4000-8000-000000000001'
  ),
  1000,
  'ranked players start at 1000 Elo'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'first player can enter Quick Match'
);

select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'second player atomically creates a match'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.matches as match_row
    where match_row.mode = 'ranked'
  ),
  1,
  'exactly one ranked match is created'
);

select is(
  (
    select count(*)::integer
    from public.match_players as player
    join public.matches as match_row on match_row.id = player.match_id
    where match_row.mode = 'ranked'
  ),
  2,
  'the ranked match contains exactly two players'
);

select ok(
  (
    select
      match_row.ruleset = private.ranked_ruleset()
      and match_row.round_duration_seconds = 60
      and match_row.dictionary_version = 'enable2k-af52415-v1'
      and match_row.board_generation_version = 'weighted-v2'
      and match_row.scoring_version = 'classic-v1'
    from public.matches as match_row
    where match_row.mode = 'ranked'
  ),
  'the database stores the canonical ranked rules snapshot'
);

update public.match_players as player
set
  finished_at = clock_timestamp(),
  validated_score = case when player.player_number = 1 then 800 else 400 end,
  validated_words = case
    when player.player_number = 1
      then '[{"word":"CRATE","score":800}]'::jsonb
    else '[{"word":"RATE","score":400}]'::jsonb
  end
where player.match_id = (
  select match_row.id
  from public.matches as match_row
  where match_row.mode = 'ranked'
);

select ok(
  private.finalize_completed_lobby(
    (
      select match_row.id
      from public.matches as match_row
      where match_row.mode = 'ranked'
    )
  ),
  'ranked finalization succeeds'
);

select is(
  (
    select sum(history.rating_delta)::integer
    from public.rating_history as history
  ),
  0,
  'integer Elo changes are zero-sum'
);

select is(
  (
    select count(*)::integer
    from public.rating_history as history
  ),
  2,
  'one immutable rating-history row is written per player'
);

select is(
  (
    select stats.current_rating
    from public.ranked_stats as stats
    where stats.user_id = '10000000-0000-4000-8000-000000000001'
  ),
  1016,
  'the winner gains 16 Elo in an even match'
);

select is(
  (
    select stats.current_rating
    from public.ranked_stats as stats
    where stats.user_id = '20000000-0000-4000-8000-000000000002'
  ),
  984,
  'the loser loses 16 Elo in an even match'
);

select ok(
  private.finalize_completed_lobby(
    (
      select match_row.id
      from public.matches as match_row
      where match_row.mode = 'ranked'
    )
  ),
  'a repeated finalization request is accepted idempotently'
);

select is(
  (
    select count(*)::integer
    from public.rating_history as history
  ),
  2,
  'a repeated finalization cannot add rating-history rows'
);

insert into public.matches (
  room_code,
  status,
  host_user_id,
  board_seed,
  scheduled_start_at
)
values (
  'TST234',
  'active',
  '30000000-0000-4000-8000-000000000003',
  42,
  clock_timestamp()
);

insert into public.match_players (
  match_id,
  player_user_id,
  player_number,
  finished_at,
  validated_score,
  validated_words
)
select
  match_row.id,
  player.user_id,
  player.player_number,
  clock_timestamp(),
  player.score,
  '[]'::jsonb
from public.matches as match_row
cross join (
  values
    ('30000000-0000-4000-8000-000000000003'::uuid, 1::smallint, 400),
    ('40000000-0000-4000-8000-000000000004'::uuid, 2::smallint, 100)
) as player(user_id, player_number, score)
where match_row.room_code = 'TST234';

select ok(
  private.finalize_completed_lobby(
    (
      select match_row.id
      from public.matches as match_row
      where match_row.room_code = 'TST234'
    )
  ),
  'private lobby finalization still succeeds'
);

select is(
  (
    select sum(stats.games_played)::integer
    from public.ranked_stats as stats
    where stats.user_id in (
      '30000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000004'
    )
  ),
  0,
  'private lobbies never change ranked statistics'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

select is(
  (
    select count(*)::integer
    from public.get_ranked_leaderboard('rating', 1)
  ),
  2,
  'leaderboards exclude profiles with zero completed ranked games'
);

select ok(
  (
    select not (
      to_jsonb(profile_result)
      ?| array['id', 'user_id', 'email', 'created_at', 'updated_at']
    )
    from public.get_public_player_profile('TESTAA2345')
      as profile_result
  ),
  'the public profile RPC omits private identifiers and account fields'
);

select is(
  (select count(*)::integer from public.ranked_queue),
  1,
  'queue RLS prevents enumeration of other players'
);

select throws_ok(
  $$ update public.ranked_stats set wins = 999 $$,
  'clients cannot directly manipulate ranked statistics'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'a player can queue after a private match'
);
select set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000004',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'the private opponent can create a separate ranked match'
);
reset role;

update public.matches as match_row
set
  status = 'active',
  scheduled_start_at = clock_timestamp() - interval '2 minutes'
where match_row.mode = 'ranked'
  and match_row.rating_status = 'pending'
  and exists (
    select 1
    from public.match_players as player
    where player.match_id = match_row.id
      and player.player_user_id =
        '30000000-0000-4000-8000-000000000003'
  );

update public.match_players as player
set
  finished_at = clock_timestamp() - interval '1 minute',
  validated_score = 400,
  validated_words = '[{"word":"RATE","score":400}]'::jsonb
where player.player_user_id =
    '30000000-0000-4000-8000-000000000003'
  and player.match_id in (
    select match_row.id
    from public.matches as match_row
    where match_row.mode = 'ranked'
      and match_row.rating_status = 'pending'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003',
  true
);
select ok(
  public.finalize_stale_match(
    (
      select player.match_id
      from public.match_players as player
      join public.matches as match_row on match_row.id = player.match_id
      where player.player_user_id =
          '30000000-0000-4000-8000-000000000003'
        and match_row.mode = 'ranked'
        and match_row.rating_status = 'pending'
    )
  ),
  'one missing submission finalizes after the recovery window'
);
reset role;

select is(
  (
    select player.result_status::text
    from public.match_players as player
    join public.matches as match_row on match_row.id = player.match_id
    where player.player_user_id =
        '40000000-0000-4000-8000-000000000004'
      and match_row.mode = 'ranked'
  ),
  'forfeit',
  'the missing player is recorded as a forfeit'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'a completed ranked player can enter a new queue'
);
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'a second completed player can create another ranked match'
);
reset role;

update public.matches as match_row
set
  status = 'active',
  scheduled_start_at = clock_timestamp() - interval '2 minutes'
where match_row.mode = 'ranked'
  and match_row.rating_status = 'pending'
  and exists (
    select 1
    from public.match_players as player
    where player.match_id = match_row.id
      and player.player_user_id =
        '10000000-0000-4000-8000-000000000001'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select ok(
  public.finalize_stale_match(
    (
      select match_row.id
      from public.matches as match_row
      join public.match_players as player on player.match_id = match_row.id
      where player.player_user_id =
          '10000000-0000-4000-8000-000000000001'
        and match_row.mode = 'ranked'
        and match_row.rating_status = 'pending'
    )
  ),
  'two missing submissions abandon after the recovery window'
);
reset role;

select is(
  (
    select match_row.rating_status::text
    from public.matches as match_row
    join public.match_players as player on player.match_id = match_row.id
    where player.player_user_id =
        '10000000-0000-4000-8000-000000000001'
      and match_row.mode = 'ranked'
      and match_row.status = 'cancelled'
  ),
  'abandoned',
  'an abandoned match records no rating application'
);

select is(
  (
    select stats.games_played
    from public.ranked_stats as stats
    where stats.user_id = '10000000-0000-4000-8000-000000000001'
  ),
  1,
  'an abandoned match does not increment games played'
);

select * from finish();
rollback;
