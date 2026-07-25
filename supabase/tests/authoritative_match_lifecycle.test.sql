-- Run after `npx supabase db reset`:
--   npx supabase test db --local supabase/tests/authoritative_match_lifecycle.test.sql
begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table lifecycle_fixture (
  label text primary key,
  match_id uuid,
  proposal_id uuid
) on commit drop;
grant select, insert, update on table lifecycle_fixture to authenticated;

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
    'd1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'lifecycle-one@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Lifecycle One"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd2000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'lifecycle-two@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Lifecycle Two"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd3000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'lifecycle-three@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Lifecycle Three"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd4000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'lifecycle-four@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Lifecycle Four"}'::jsonb,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

select is(
  pg_catalog.jsonb_array_length(
    private.generate_shape_mask(10, 10, 'rectangle')
  ),
  100,
  'the server preserves all one hundred coordinates in a 10 by 10 mask'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.jsonb_array_elements(
      private.generate_shape_mask(4, 4, 'diamond')
    ) as cell(value)
    where cell.value = 'true'::jsonb
  ),
  12,
  'the canonical 4 by 4 diamond fixture has twelve cells'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.jsonb_array_elements(
      private.generate_shape_mask(5, 5, 'diamond')
    ) as cell(value)
    where cell.value = 'true'::jsonb
  ),
  13,
  'the canonical 5 by 5 diamond fixture has thirteen cells'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.jsonb_array_elements(
      private.generate_shape_mask(6, 6, 'diamond')
    ) as cell(value)
    where cell.value = 'true'::jsonb
  ),
  24,
  'the canonical 6 by 6 diamond uses materially more than the 4 by 4 grid'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.jsonb_array_elements(
      private.generate_shape_mask(8, 8, 'diamond')
    ) as cell(value)
    where cell.value = 'true'::jsonb
  ),
  40,
  'the canonical 8 by 8 diamond scales to forty cells'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.jsonb_array_elements(
      private.generate_shape_mask(10, 10, 'diamond')
    ) as cell(value)
    where cell.value = 'true'::jsonb
  ),
  60,
  'the canonical 10 by 10 diamond scales to sixty cells'
);

select lives_ok(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_build_object(
        'version', '2',
        'rows', 10,
        'columns', 10,
        'activeCells', private.generate_shape_mask(10, 10, 'diamond'),
        'shape', 'diamond',
        'roundDurationSeconds', 60,
        'minimumWordLength', 3,
        'dictionaryVersion', 'enable2k-af52415-v1',
        'scoringRulesVersion', 'classic-v1',
        'boardGenerationVersion', 'weighted-v2'
      ),
      2
    )
  $$,
  'server rules accept the same 10 by 10 normalized diamond as the client'
);
select throws_like(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_build_object(
        'version', '2',
        'rows', 11,
        'columns', 10,
        'activeCells', '[]'::jsonb,
        'shape', 'custom',
        'roundDurationSeconds', 60,
        'minimumWordLength', 3,
        'dictionaryVersion', 'enable2k-af52415-v1',
        'scoringRulesVersion', 'classic-v1',
        'boardGenerationVersion', 'weighted-v2'
      ),
      2
    )
  $$,
  '%3 through 10%',
  'server rules reject dimensions above ten'
);
select throws_like(
  $$
    select private.validate_game_ruleset(
      pg_catalog.jsonb_build_object(
        'version', '2',
        'rows', 6,
        'columns', 6,
        'activeCells', private.generate_shape_mask(6, 6, 'rectangle'),
        'shape', 'diamond',
        'roundDurationSeconds', 60,
        'minimumWordLength', 3,
        'dictionaryVersion', 'enable2k-af52415-v1',
        'scoringRulesVersion', 'classic-v1',
        'boardGenerationVersion', 'weighted-v2'
      ),
      2
    )
  $$,
  '%does not match%',
  'a client cannot label an arbitrary mask as a generated diamond'
);
select isnt(
  private.mode_key(
    'private',
    pg_catalog.jsonb_build_object(
      'version', '2',
      'rows', 8,
      'columns', 10,
      'activeCells', private.generate_shape_mask(8, 10, 'rectangle'),
      'shape', 'rectangle',
      'roundDurationSeconds', 60,
      'minimumWordLength', 3,
      'dictionaryVersion', 'enable2k-af52415-v1',
      'scoringRulesVersion', 'classic-v1',
      'boardGenerationVersion', 'weighted-v2'
    )
  ),
  private.mode_key(
    'private',
    pg_catalog.jsonb_build_object(
      'version', '2',
      'rows', 10,
      'columns', 8,
      'activeCells', private.generate_shape_mask(10, 8, 'rectangle'),
      'shape', 'rectangle',
      'roundDurationSeconds', 60,
      'minimumWordLength', 3,
      'dictionaryVersion', 'enable2k-af52415-v1',
      'scoringRulesVersion', 'classic-v1',
      'boardGenerationVersion', 'weighted-v2'
    )
  ),
  'mode keys change when rectangular dimensions change'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'first ranked lifecycle player enters the queue'
);
select set_config(
  'request.jwt.claim.sub',
  'd2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'second ranked lifecycle player creates the match'
);
reset role;

insert into lifecycle_fixture (label, match_id)
select 'ranked-explicit', match_row.id
from public.matches as match_row
where match_row.mode = 'ranked'
  and match_row.rating_status = 'pending';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.exit_current_match(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'ranked-explicit'
      )
    )
  $$,
  'an explicit ranked exit is finalized by the server immediately'
);
reset role;

select is(
  (
    select player.result_status::text
    from public.match_players as player
    join lifecycle_fixture as fixture on fixture.match_id = player.match_id
    where fixture.label = 'ranked-explicit'
      and player.player_user_id =
        'd1000000-0000-4000-8000-000000000001'
  ),
  'forfeit',
  'the authenticated exiting ranked player is the forfeiter'
);
select is(
  (
    select player.result_status::text
    from public.match_players as player
    join lifecycle_fixture as fixture on fixture.match_id = player.match_id
    where fixture.label = 'ranked-explicit'
      and player.player_user_id =
        'd2000000-0000-4000-8000-000000000002'
  ),
  'winner',
  'the ranked opponent receives the authoritative win'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.rating_history as history
    join lifecycle_fixture as fixture on fixture.match_id = history.match_id
    where fixture.label = 'ranked-explicit'
  ),
  2,
  'the ranked forfeit writes exactly one immutable rating row per player'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.exit_current_match(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'ranked-explicit'
      )
    )
  $$,
  'repeating the ranked exit is idempotent'
);
reset role;
select is(
  (
    select pg_catalog.count(*)::integer
    from public.rating_history as history
    join lifecycle_fixture as fixture on fixture.match_id = history.match_id
    where fixture.label = 'ranked-explicit'
  ),
  2,
  'idempotent exit cannot apply ranked rating twice'
);

with inserted_match as (
  insert into public.matches (
    room_code,
    status,
    host_user_id,
    board_seed,
    scheduled_start_at,
    max_players
  )
  values (
    'LFC234',
    'active',
    'd1000000-0000-4000-8000-000000000001',
    1234,
    pg_catalog.clock_timestamp(),
    3
  )
  returning id
)
insert into lifecycle_fixture (label, match_id)
select 'private-group', inserted_match.id
from inserted_match;

insert into public.match_players (
  match_id,
  player_user_id,
  player_number
)
select
  fixture.match_id,
  participant.user_id,
  participant.player_number
from lifecycle_fixture as fixture
cross join (
  values
    ('d1000000-0000-4000-8000-000000000001'::uuid, 1::smallint),
    ('d2000000-0000-4000-8000-000000000002'::uuid, 2::smallint),
    ('d3000000-0000-4000-8000-000000000003'::uuid, 3::smallint)
) as participant(user_id, player_number)
where fixture.label = 'private-group';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select public.exit_current_match(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-group'
      )
    )
  $$,
  'one private participant can leave explicitly'
);
reset role;
select is(
  (
    select match_row.status::text
    from public.matches as match_row
    join lifecycle_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'private-group'
  ),
  'active',
  'one private departure does not terminate the remaining match'
);
select is(
  (
    select player.connection_status
    from public.match_players as player
    join lifecycle_fixture as fixture on fixture.match_id = player.match_id
    where fixture.label = 'private-group'
      and player.player_user_id =
        'd1000000-0000-4000-8000-000000000001'
  ),
  'left',
  'the departed private participant is durably inactive'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd4000000-0000-4000-8000-000000000004',
  true
);
select throws_like(
  $$
    select public.exit_current_match(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-group'
      )
    )
  $$,
  '%not a participant%',
  'a user cannot exit another participant from a match'
);
reset role;

update public.match_players as player
set
  connection_status = 'disconnected',
  disconnect_deadline_at = pg_catalog.clock_timestamp() + interval '15 seconds'
where player.match_id = (
  select fixture.match_id
  from lifecycle_fixture as fixture
  where fixture.label = 'private-group'
)
  and player.player_user_id =
    'd2000000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.heartbeat_match_presence(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-group'
      )
    )
  $$,
  'a temporary disconnect can heartbeat back inside the grace period'
);
reset role;
select is(
  (
    select player.connection_status
    from public.match_players as player
    join lifecycle_fixture as fixture on fixture.match_id = player.match_id
    where fixture.label = 'private-group'
      and player.player_user_id =
        'd2000000-0000-4000-8000-000000000002'
  ),
  'connected',
  'the reconnect restores the participant instead of forfeiting'
);

update public.match_players as player
set
  connection_status = 'disconnected',
  disconnect_deadline_at = pg_catalog.clock_timestamp() - interval '1 second'
where player.match_id = (
  select fixture.match_id
  from lifecycle_fixture as fixture
  where fixture.label = 'private-group'
)
  and player.player_user_id =
    'd2000000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd3000000-0000-4000-8000-000000000003',
  true
);
select lives_ok(
  $$
    select public.reconcile_match_presence(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-group'
      )
    )
  $$,
  'an opponent can request database-time cleanup after the grace period'
);
reset role;
select is(
  (
    select player.connection_status
    from public.match_players as player
    join lifecycle_fixture as fixture on fixture.match_id = player.match_id
    where fixture.label = 'private-group'
      and player.player_user_id =
        'd2000000-0000-4000-8000-000000000002'
  ),
  'left',
  'an expired private disconnect removes only that participant'
);
select is(
  (
    select match_row.status::text
    from public.matches as match_row
    join lifecycle_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'private-group'
  ),
  'active',
  'the last connected private participant keeps playing'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd3000000-0000-4000-8000-000000000003',
  true
);
select lives_ok(
  $$
    select public.exit_current_match(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-group'
      )
    )
  $$,
  'the final private participant can leave'
);
reset role;
select ok(
  (
    select
      match_row.status = 'cancelled'
      and match_row.abandoned_at is not null
      and match_row.winner_id is null
    from public.matches as match_row
    join lifecycle_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'private-group'
  ),
  'an all-departed private match is bounded, abandoned, and has no fabricated winner'
);

with inserted_match as (
  insert into public.matches (
    room_code,
    status,
    host_user_id,
    board_seed,
    scheduled_start_at,
    max_players
  )
  values (
    'GRP234',
    'active',
    'd1000000-0000-4000-8000-000000000001',
    6543,
    pg_catalog.clock_timestamp(),
    4
  )
  returning id
)
insert into lifecycle_fixture (label, match_id)
select 'group-rematch-source', inserted_match.id
from inserted_match;

insert into public.match_players (
  match_id,
  player_user_id,
  player_number,
  finished_at,
  validated_score,
  validated_words
)
select
  fixture.match_id,
  participant.user_id,
  participant.player_number,
  pg_catalog.clock_timestamp(),
  participant.score,
  '[]'::jsonb
from lifecycle_fixture as fixture
cross join (
  values
    ('d1000000-0000-4000-8000-000000000001'::uuid, 1::smallint, 300),
    ('d2000000-0000-4000-8000-000000000002'::uuid, 2::smallint, 200),
    ('d3000000-0000-4000-8000-000000000003'::uuid, 3::smallint, 100)
) as participant(user_id, player_number, score)
where fixture.label = 'group-rematch-source';

select ok(
  private.finalize_completed_lobby(
    (
      select fixture.match_id
      from lifecycle_fixture as fixture
      where fixture.label = 'group-rematch-source'
    )
  ),
  'a three-participant source finalizes for the group rematch flow'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    insert into lifecycle_fixture (label, match_id)
    select 'group-rematch', rematch.match_id
    from public.create_private_rematch(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'group-rematch-source'
      )
    ) as rematch
  $$,
  'three-player private matches retain the invitation-lobby rematch flow'
);
reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from public.private_rematch_invitations as invitation
    join lifecycle_fixture as fixture on fixture.match_id = invitation.match_id
    where fixture.label = 'group-rematch'
  ),
  2,
  'the group rematch invites both non-requesting prior participants'
);

update public.matches as match_row
set status = 'cancelled'
where match_row.id = (
  select fixture.match_id
  from lifecycle_fixture as fixture
  where fixture.label = 'group-rematch'
);

with inserted_match as (
  insert into public.matches (
    room_code,
    status,
    host_user_id,
    board_seed,
    scheduled_start_at,
    max_players
  )
  values (
    'RMT234',
    'active',
    'd1000000-0000-4000-8000-000000000001',
    9876,
    pg_catalog.clock_timestamp(),
    2
  )
  returning id
)
insert into lifecycle_fixture (label, match_id)
select 'private-rematch', inserted_match.id
from inserted_match;

insert into public.match_players (
  match_id,
  player_user_id,
  player_number,
  finished_at,
  validated_score,
  validated_words
)
select
  fixture.match_id,
  participant.user_id,
  participant.player_number,
  pg_catalog.clock_timestamp(),
  participant.score,
  '[]'::jsonb
from lifecycle_fixture as fixture
cross join (
  values
    ('d1000000-0000-4000-8000-000000000001'::uuid, 1::smallint, 400),
    ('d2000000-0000-4000-8000-000000000002'::uuid, 2::smallint, 100)
) as participant(user_id, player_number, score)
where fixture.label = 'private-rematch';

select ok(
  private.finalize_completed_lobby(
    (
      select fixture.match_id
      from lifecycle_fixture as fixture
      where fixture.label = 'private-rematch'
    )
  ),
  'the two-player private source is finalized before rematch consent'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    insert into lifecycle_fixture (label, proposal_id)
    select 'proposal', proposal.proposal_id
    from public.request_two_player_rematch(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-rematch'
      )
    ) as proposal
  $$,
  'the first rematch press creates one authoritative proposal'
);
select lives_ok(
  $$
    select public.request_two_player_rematch(
      (
        select fixture.match_id
        from lifecycle_fixture as fixture
        where fixture.label = 'private-rematch'
      )
    )
  $$,
  'a repeated requester press is idempotent'
);
reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from public.two_player_rematch_proposals as proposal
    join lifecycle_fixture as fixture
      on fixture.match_id = proposal.source_match_id
    where fixture.label = 'private-rematch'
  ),
  1,
  'duplicate proposal creation is prevented'
);
select ok(
  (
    select
      proposal.expires_at > proposal.created_at + interval '14 seconds'
      and proposal.expires_at < proposal.created_at + interval '16 seconds'
    from public.two_player_rematch_proposals as proposal
    join lifecycle_fixture as fixture
      on fixture.match_id = proposal.source_match_id
    where fixture.label = 'private-rematch'
  ),
  'the opponent receives exactly the database-timed 15-second window'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'd2000000-0000-4000-8000-000000000002',
  true
);
select lives_ok(
  $$
    select public.respond_two_player_rematch(
      (
        select fixture.proposal_id
        from lifecycle_fixture as fixture
        where fixture.label = 'proposal'
      ),
      true
    )
  $$,
  'opponent acceptance creates the direct rematch'
);
select lives_ok(
  $$
    select public.respond_two_player_rematch(
      (
        select fixture.proposal_id
        from lifecycle_fixture as fixture
        where fixture.label = 'proposal'
      ),
      true
    )
  $$,
  'simultaneous or repeated acceptance returns the same terminal proposal'
);
reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from public.matches as match_row
    join lifecycle_fixture as fixture
      on fixture.match_id = match_row.rematch_of
    where fixture.label = 'private-rematch'
  ),
  1,
  'one completed source creates exactly one new match'
);
select ok(
  (
    select
      rematch.ruleset = source.ruleset
      and rematch.round_duration_seconds = source.round_duration_seconds
      and rematch.dictionary_version = source.dictionary_version
      and rematch.scoring_version = source.scoring_version
      and rematch.board_generation_version = source.board_generation_version
      and rematch.ruleset_version = source.ruleset_version
      and rematch.board_seed <> source.board_seed
    from public.matches as rematch
    join public.matches as source on source.id = rematch.rematch_of
    join lifecycle_fixture as fixture on fixture.match_id = source.id
    where fixture.label = 'private-rematch'
  ),
  'private rematch settings copy exactly while the server generates a new seed'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.match_players as player
    join public.matches as rematch on rematch.id = player.match_id
    join lifecycle_fixture as fixture on fixture.match_id = rematch.rematch_of
    where fixture.label = 'private-rematch'
  ),
  2,
  'both consenting players are inserted directly into the rematch'
);

select * from finish();
rollback;
