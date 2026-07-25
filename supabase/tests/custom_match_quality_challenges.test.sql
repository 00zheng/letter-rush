-- Run after `npx supabase db reset`:
--   npx supabase test db --local supabase/tests/custom_match_quality_challenges.test.sql
begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table quality_fixture (
  label text primary key,
  challenge_id uuid,
  match_id uuid,
  board_seed bigint
) on commit drop;
grant select, insert, update on table quality_fixture to authenticated;

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
    'e1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'quality-one@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Quality One"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'quality-two@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Quality Two"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e3000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'quality-three@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Quality Three"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e4000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'quality-four@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Quality Four"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

update public.profiles as profile
set public_profile_id = case profile.id
  when 'e1000000-0000-4000-8000-000000000001'
    then 'CHALAA2345'
  when 'e2000000-0000-4000-8000-000000000002'
    then 'CHALBB2345'
  when 'e3000000-0000-4000-8000-000000000003'
    then 'CHALCC2345'
  when 'e4000000-0000-4000-8000-000000000004'
    then 'CHALDD2345'
  else profile.public_profile_id
end
where profile.id in (
  'e1000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000002',
  'e3000000-0000-4000-8000-000000000003',
  'e4000000-0000-4000-8000-000000000004'
);

select lives_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{roundDurationSeconds}',
        '10'::jsonb
      ),
      2
    )
  $$,
  'the minimum custom duration is accepted'
);

select lives_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{roundDurationSeconds}',
        '45'::jsonb
      ),
      2
    )
  $$,
  'a non-preset custom duration is accepted'
);

select lives_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{roundDurationSeconds}',
        '180'::jsonb
      ),
      2
    )
  $$,
  'the maximum custom duration is accepted'
);

select throws_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{roundDurationSeconds}',
        '9'::jsonb
      ),
      2
    )
  $$,
  'Round duration must be from 10 through 180 seconds.',
  'a duration below ten seconds is rejected'
);

select throws_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_set(
        private.ranked_ruleset(),
        '{roundDurationSeconds}',
        '181'::jsonb
      ),
      2
    )
  $$,
  'Round duration must be from 10 through 180 seconds.',
  'a duration above one hundred eighty seconds is rejected'
);

select ok(
  (
    select pg_catalog.count(*) >= 80
    from private.solve_board_words(3, private.ranked_ruleset())
  ),
  'the deterministic solver enumerates a strong seed against the real dictionary'
);

select ok(
  exists (
    select 1
    from private.solve_board_words(3, private.ranked_ruleset()) as solution
    where solution.word = 'FAST'
  ),
  'the solver follows diagonal adjacency used by gameplay'
);

select is(
  private.board_quality_report(
    3,
    private.ranked_ruleset()
  ) ->> 'approved',
  'true',
  'a board with easy, long, recognizable, and diverse words is approved'
);

select is(
  private.board_quality_report(
    9,
    private.ranked_ruleset()
  ) ->> 'approved',
  'false',
  'a sparse awkward board is rejected'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'e1000000-0000-4000-8000-000000000001',
  true
);

insert into quality_fixture (label, match_id, board_seed)
select 'custom-lobby', lobby.match_id, lobby.board_seed
from public.create_private_lobby(
  pg_catalog.jsonb_set(
    private.ranked_ruleset(),
    '{roundDurationSeconds}',
    '45'::jsonb
  ),
  2
) as lobby;

select is(
  (
    select match_row.round_duration_seconds
    from public.matches as match_row
    join quality_fixture as fixture
      on fixture.match_id = match_row.id
    where fixture.label = 'custom-lobby'
  ),
  45,
  'private lobby creation preserves the validated custom duration'
);

select ok(
  exists (
    select 1
    from public.matches as match_row
    join quality_fixture as fixture
      on fixture.match_id = match_row.id
    join private.custom_board_pool as pool
      on pool.rules_key = private.board_rules_key(match_row.ruleset)
      and pool.board_seed = match_row.board_seed
    where fixture.label = 'custom-lobby'
      and pool.quality_report ->> 'approved' = 'true'
  ),
  'private lobby creation stores one exact server-approved shared board seed'
);

select is(
  (
    select fixture.board_seed
    from quality_fixture as fixture
    where fixture.label = 'custom-lobby'
  ),
  (
    select match_row.board_seed
    from public.matches as match_row
    join quality_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'custom-lobby'
  ),
  'the create-lobby RPC returns the exact approved seed stored for every player'
);

select lives_ok(
  $$
    select public.cancel_private_match(
      (
        select fixture.match_id
        from quality_fixture as fixture
        where fixture.label = 'custom-lobby'
      )
    )
  $$,
  'the custom lobby fixture can be closed before challenge tests'
);

insert into quality_fixture (label, challenge_id)
select 'casual-challenge', challenge.challenge_id
from public.create_player_challenge('CHALBB2345', false) as challenge;

select is(
  (
    select challenge.challenge_id
    from public.create_player_challenge('CHALBB2345', false) as challenge
  ),
  (
    select fixture.challenge_id
    from quality_fixture as fixture
    where fixture.label = 'casual-challenge'
  ),
  'repeated challenge creation returns the existing pending challenge'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.player_challenges as challenge
    where challenge.status = 'pending'
      and challenge.challenger_id = 'e1000000-0000-4000-8000-000000000001'
      and challenge.challenged_id = 'e2000000-0000-4000-8000-000000000002'
  ),
  1,
  'duplicate challenge clicks create only one pending row'
);

select ok(
  (
    select challenge.opponent_public_profile_id = 'CHALBB2345'
      and challenge.direction = 'outgoing'
      and not challenge.rated
    from public.get_current_player_challenges() as challenge
    join quality_fixture as fixture
      on fixture.challenge_id = challenge.challenge_id
    where fixture.label = 'casual-challenge'
  ),
  'the challenge projection contains only the opaque opponent identity and casual mode'
);

select set_config(
  'request.jwt.claim.sub',
  'e2000000-0000-4000-8000-000000000002',
  true
);

with response as (
  select accepted.match_id
  from quality_fixture as fixture
  cross join lateral public.respond_player_challenge(
    fixture.challenge_id,
    true
  ) as accepted
  where fixture.label = 'casual-challenge'
)
update quality_fixture as fixture
set match_id = response.match_id
from response
where fixture.label = 'casual-challenge';

reset role;

select ok(
  (
    select match_row.mode = 'private'
      and match_row.max_players = 2
      and match_row.round_duration_seconds = 60
      and pg_catalog.count(player.player_user_id) = 2
    from quality_fixture as fixture
    join public.matches as match_row on match_row.id = fixture.match_id
    join public.match_players as player on player.match_id = match_row.id
    where fixture.label = 'casual-challenge'
    group by
      match_row.mode,
      match_row.max_players,
      match_row.round_duration_seconds
  ),
  'accepting a casual challenge atomically starts one shared non-Elo match'
);

select ok(
  exists (
    select 1
    from quality_fixture as fixture
    join public.matches as match_row on match_row.id = fixture.match_id
    join private.custom_board_pool as pool
      on pool.rules_key = private.board_rules_key(match_row.ruleset)
      and pool.board_seed = match_row.board_seed
    where fixture.label = 'casual-challenge'
  ),
  'casual challenges use the same high-quality private-board boundary'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'e3000000-0000-4000-8000-000000000003',
  true
);

insert into quality_fixture (label, challenge_id)
select 'rated-challenge', challenge.challenge_id
from public.create_player_challenge('CHALDD2345', true) as challenge;

select set_config(
  'request.jwt.claim.sub',
  'e4000000-0000-4000-8000-000000000004',
  true
);

with response as (
  select accepted.match_id
  from quality_fixture as fixture
  cross join lateral public.respond_player_challenge(
    fixture.challenge_id,
    true
  ) as accepted
  where fixture.label = 'rated-challenge'
)
update quality_fixture as fixture
set match_id = response.match_id
from response
where fixture.label = 'rated-challenge';

reset role;

select ok(
  (
    select match_row.mode = 'ranked'
      and match_row.rating_status = 'pending'
      and match_row.ruleset = private.ranked_ruleset()
    from quality_fixture as fixture
    join public.matches as match_row on match_row.id = fixture.match_id
    where fixture.label = 'rated-challenge'
  ),
  'accepting an Elo challenge uses the immutable ranked rules and rating path'
);

update public.match_players as player
set
  finished_at = pg_catalog.clock_timestamp(),
  validated_score = case player.player_number when 1 then 400 else 100 end,
  validated_words = '[]'::jsonb,
  result_status = case
    when player.player_number = 1 then 'winner'::public.match_result_status
    else 'loser'::public.match_result_status
  end
from quality_fixture as fixture
where fixture.label = 'casual-challenge'
  and player.match_id = fixture.match_id;

update public.matches as match_row
set
  status = 'completed',
  completed_at = pg_catalog.clock_timestamp(),
  winner_id = 'e1000000-0000-4000-8000-000000000001',
  is_tie = false
from quality_fixture as fixture
where fixture.label = 'casual-challenge'
  and match_row.id = fixture.match_id;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'e1000000-0000-4000-8000-000000000001',
  true
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.get_match_word_opportunities(
      (
        select fixture.match_id
        from quality_fixture as fixture
        where fixture.label = 'casual-challenge'
      )
    )
  ),
  10,
  'a participant receives the ten longest possible words after completion'
);

select ok(
  not exists (
    select 1
    from public.get_match_word_opportunities(
      (
        select fixture.match_id
        from quality_fixture as fixture
        where fixture.label = 'casual-challenge'
      )
    ) as opportunity
    where opportunity.word_length <> pg_catalog.char_length(opportunity.word)
      or opportunity.word !~ '^[A-Z]+$'
  ),
  'word opportunities preserve exact uppercase dictionary words and lengths'
);

insert into quality_fixture (label, match_id)
select 'expired-solo', session.match_id
from public.create_or_resume_solo_session(
  private.ranked_ruleset()
) as session;

reset role;

update public.matches as match_row
set scheduled_start_at =
  pg_catalog.clock_timestamp() - interval '2 minutes'
from quality_fixture as fixture
where fixture.label = 'expired-solo'
  and match_row.id = fixture.match_id;

insert into public.ranked_queue (
  user_id,
  status,
  rating_snapshot,
  joined_at,
  heartbeat_at,
  match_id,
  matched_at,
  cancelled_at
)
values (
  'e1000000-0000-4000-8000-000000000001',
  'waiting',
  1000,
  pg_catalog.clock_timestamp() - interval '2 minutes',
  pg_catalog.clock_timestamp() - interval '2 minutes',
  null,
  null,
  null
)
on conflict (user_id) do update
set
  status = 'waiting',
  rating_snapshot = excluded.rating_snapshot,
  joined_at = excluded.joined_at,
  heartbeat_at = excluded.heartbeat_at,
  match_id = null,
  matched_at = null,
  cancelled_at = null;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'e1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.create_player_challenge('CHALBB2345', false)
  $$,
  'completed history, an expired solo session, and a stale queue do not block a new challenge'
);
reset role;

select is(
  (
    select match_row.status
    from public.matches as match_row
    join quality_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'expired-solo'
  ),
  'cancelled'::public.match_status,
  'challenge cleanup cancels the expired solo session'
);

select is(
  (
    select queue.status
    from public.ranked_queue as queue
    where queue.user_id = 'e1000000-0000-4000-8000-000000000001'
  ),
  'cancelled'::public.ranked_queue_status,
  'challenge cleanup cancels the stale ranked queue entry'
);

select * from finish();
rollback;
