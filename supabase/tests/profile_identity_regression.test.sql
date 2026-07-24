-- Run after `npx supabase db reset`:
--   npx supabase test db supabase/tests/profile_identity_regression.test.sql
-- The transaction is rolled back, so these auth users never persist.
begin;

create extension if not exists pgtap with schema extensions;
select plan(26);

create temporary table identity_test_lobbies (
  scenario text primary key,
  match_id uuid not null,
  room_code text not null
) on commit drop;
grant select, insert on table identity_test_lobbies to authenticated;

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
select
  '00000000-0000-0000-0000-000000000000',
  fixture.id,
  'authenticated',
  'authenticated',
  null,
  '',
  '{"provider":"anonymous","providers":[]}'::jsonb,
  '{}'::jsonb,
  true,
  clock_timestamp(),
  clock_timestamp()
from (
  values
    ('50000000-0000-4000-8000-000000000005'::uuid),
    ('60000000-0000-4000-8000-000000000006'::uuid),
    ('70000000-0000-4000-8000-000000000007'::uuid),
    ('80000000-0000-4000-8000-000000000008'::uuid),
    ('90000000-0000-4000-8000-000000000009'::uuid)
) as fixture(id);

select is(
  (
    select count(*)::integer
    from public.profiles as profile
    where profile.id = '50000000-0000-4000-8000-000000000005'
  ),
  1,
  'a new anonymous auth user receives a profile'
);

select ok(
  (
    select
      profile.public_profile_id is not null
      and profile.public_profile_id
        ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
    from public.profiles as profile
    where profile.id = '50000000-0000-4000-8000-000000000005'
  ),
  'a new anonymous profile receives a valid opaque public ID'
);

select is(
  (
    select count(*)::integer
    from public.ranked_stats as stats
    where stats.user_id = '50000000-0000-4000-8000-000000000005'
  ),
  1,
  'a new anonymous auth user receives ranked statistics'
);

-- Simulate the supported in-place claim flow: the auth UUID and profile stay
-- unchanged while GoTrue marks the verified user as persistent.
update auth.users as auth_user
set
  is_anonymous = false,
  email = 'claimed-' || auth_user.id::text || '@example.test',
  raw_app_meta_data =
    '{"provider":"email","providers":["email"]}'::jsonb
where auth_user.id in (
  '50000000-0000-4000-8000-000000000005',
  '60000000-0000-4000-8000-000000000006',
  '70000000-0000-4000-8000-000000000007',
  '80000000-0000-4000-8000-000000000008',
  '90000000-0000-4000-8000-000000000009'
);

update public.profiles as profile
set
  display_name = 'Existing Player',
  public_profile_id = 'KEEPAA2345'
where profile.id = '50000000-0000-4000-8000-000000000005';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '50000000-0000-4000-8000-000000000005',
  true
);

select lives_ok(
  $$
    select pg_catalog.count(*)
    from public.ensure_current_player_identity() as first_identity
    cross join public.ensure_current_player_identity() as second_identity
  $$,
  'repeated current-player initialization is idempotent'
);
reset role;

select is(
  (
    select profile.public_profile_id
    from public.profiles as profile
    where profile.id = '50000000-0000-4000-8000-000000000005'
  ),
  'KEEPAA2345',
  'initialization preserves an existing public profile ID'
);

select is(
  (
    select profile.display_name
    from public.profiles as profile
    where profile.id = '50000000-0000-4000-8000-000000000005'
  ),
  'Existing Player',
  'initialization preserves an existing display name'
);

select is(
  (
    select count(*)::integer
    from public.profiles as profile
    where profile.id = '50000000-0000-4000-8000-000000000005'
  ),
  1,
  'repeated initialization cannot duplicate a profile'
);

delete from public.ranked_stats as stats
where stats.user_id = '50000000-0000-4000-8000-000000000005';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '50000000-0000-4000-8000-000000000005',
  true
);
select lives_ok(
  $$ select public.ensure_current_player_identity() $$,
  'initialization repairs missing ranked statistics'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.ranked_stats as stats
    where stats.user_id = '50000000-0000-4000-8000-000000000005'
  ),
  1,
  'ranked statistics exist after repair'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '50000000-0000-4000-8000-000000000005',
  true
);
select lives_ok(
  $$
    insert into identity_test_lobbies (scenario, match_id, room_code)
    select
      'existing-profile',
      lobby.match_id,
      lobby.room_code
    from public.create_private_lobby(
      '{
        "version":"2",
        "rows":4,
        "columns":4,
        "activeCells":[true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true],
        "shape":"rectangle",
        "roundDurationSeconds":60,
        "minimumWordLength":3,
        "dictionaryVersion":"enable2k-af52415-v1",
        "scoringRulesVersion":"classic-v1",
        "boardGenerationVersion":"weighted-v2"
      }'::jsonb,
      4
    ) as lobby
  $$,
  'creating a private lobby succeeds for an existing profile'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.matches as match_row
    join identity_test_lobbies as fixture
      on fixture.match_id = match_row.id
    where fixture.scenario = 'existing-profile'
      and match_row.host_user_id =
        '50000000-0000-4000-8000-000000000005'
  ),
  1,
  'the existing-profile lobby records the authenticated caller as host'
);

delete from public.profiles as profile
where profile.id = '60000000-0000-4000-8000-000000000006';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000006',
  true
);
select lives_ok(
  $$
    insert into identity_test_lobbies (scenario, match_id, room_code)
    select
      'missing-profile',
      lobby.match_id,
      lobby.room_code
    from public.create_private_lobby(
      '{
        "version":"2",
        "rows":4,
        "columns":4,
        "activeCells":[true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true],
        "shape":"rectangle",
        "roundDurationSeconds":60,
        "minimumWordLength":3,
        "dictionaryVersion":"enable2k-af52415-v1",
        "scoringRulesVersion":"classic-v1",
        "boardGenerationVersion":"weighted-v2"
      }'::jsonb,
      4
    ) as lobby
  $$,
  'creating a private lobby repairs a recoverable missing profile'
);
reset role;

select ok(
  exists (
    select 1
    from public.profiles as profile
    where profile.id = '60000000-0000-4000-8000-000000000006'
      and profile.public_profile_id
        ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
  ),
  'the recovered lobby host has a complete profile'
);

select is(
  (
    select count(*)::integer
    from public.ranked_stats as stats
    where stats.user_id = '60000000-0000-4000-8000-000000000006'
  ),
  1,
  'the recovered lobby host has ranked statistics'
);

delete from public.profiles as profile
where profile.id = '80000000-0000-4000-8000-000000000008';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '80000000-0000-4000-8000-000000000008',
  true
);
select lives_ok(
  $$ select public.create_private_match() $$,
  'the legacy private-match RPC repairs a missing profile'
);
reset role;

select ok(
  exists (
    select 1
    from public.profiles as profile
    join public.ranked_stats as stats
      on stats.user_id = profile.id
    join public.matches as match_row
      on match_row.host_user_id = profile.id
    where profile.id = '80000000-0000-4000-8000-000000000008'
      and profile.public_profile_id
        ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
  ),
  'the legacy private-match caller receives complete identity state'
);

delete from public.profiles as profile
where profile.id = '70000000-0000-4000-8000-000000000007';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '70000000-0000-4000-8000-000000000007',
  true
);
select lives_ok(
  $$
    select public.join_private_match(
      (
        select fixture.room_code
        from identity_test_lobbies as fixture
        where fixture.scenario = 'existing-profile'
      )
    )
  $$,
  'joining a private lobby repairs a missing profile'
);
reset role;

select ok(
  exists (
    select 1
    from identity_test_lobbies as fixture
    join public.match_players as player
      on player.match_id = fixture.match_id
    join public.profiles as profile
      on profile.id = player.player_user_id
    join public.ranked_stats as stats
      on stats.user_id = profile.id
    where fixture.scenario = 'existing-profile'
      and player.player_user_id =
        '70000000-0000-4000-8000-000000000007'
      and profile.public_profile_id
        ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
  ),
  'the joined player has one complete profile and ranked-stat row'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('private', 'public')
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ~* 'insert[[:space:]]+into[[:space:]]+public[.]profiles'
  ),
  1,
  'only the canonical private initializer inserts profiles'
);

select ok(
  (
    select
      pg_catalog.pg_get_functiondef(procedure.oid)
        ~* 'insert[[:space:]]+into[[:space:]]+public[.]profiles[[:space:]]*[(][[:space:]]*id[[:space:]]*,[[:space:]]*public_profile_id[[:space:]]*,[[:space:]]*display_name'
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = 'ensure_ranked_identity'
  ),
  'the canonical profile insert supplies every required identity field'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.profiles',
    'INSERT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated',
    'public.profiles',
    'id',
    'INSERT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated',
    'public.profiles',
    'display_name',
    'INSERT'
  ),
  'authenticated clients cannot bypass the canonical profile initializer'
);

select ok(
  not exists (
    select 1
    from public.profiles as profile
    where profile.public_profile_id
      !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
  )
  and (
    select pg_catalog.count(*)
    from public.profiles as profile
  ) = (
    select pg_catalog.count(distinct profile.public_profile_id)
    from public.profiles as profile
  ),
  'all public profile IDs satisfy the format and uniqueness constraints'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '50000000-0000-4000-8000-000000000005',
  true
);
select ok(
  (
    select not (
      to_jsonb(identity_result)
      ?| array['id', 'user_id', 'auth_user_id']
    )
    from public.ensure_current_player_identity() as identity_result
  ),
  'the public identity initializer never exposes an auth UUID'
);

select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'an initialized private-lobby player can still enter Quick Match'
);

select set_config(
  'request.jwt.claim.sub',
  '70000000-0000-4000-8000-000000000007',
  true
);
select lives_ok(
  $$ select public.enter_ranked_queue() $$,
  'a second initialized player can still create a ranked match'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.matches as match_row
    where match_row.mode = 'ranked'
  ),
  1,
  'Ranked Quick Match still creates exactly one match'
);

select * from finish();
rollback;
