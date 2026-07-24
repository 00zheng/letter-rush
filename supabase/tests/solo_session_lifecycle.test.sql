-- Run after `npx supabase db reset`:
--   npx supabase test db --local supabase/tests/solo_session_lifecycle.test.sql
begin;

create extension if not exists pgtap with schema extensions;
select plan(19);

create temporary table solo_lifecycle_fixture (
  label text primary key,
  match_id uuid,
  board_seed bigint,
  scheduled_start_at timestamptz,
  session_action text,
  ruleset jsonb
) on commit drop;
grant select, insert, update on table solo_lifecycle_fixture to authenticated;

insert into solo_lifecycle_fixture (label, ruleset)
values ('rules', private.ranked_ruleset());

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
    'c1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'solo-one@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Solo One"}'::jsonb,
    false,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c2000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'solo-two@example.test',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Solo Two"}'::jsonb,
    false,
    clock_timestamp(),
    clock_timestamp()
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'c1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    insert into solo_lifecycle_fixture (
      label,
      match_id,
      board_seed,
      scheduled_start_at,
      session_action
    )
    select
      'initial',
      session.match_id,
      session.board_seed,
      session.scheduled_start_at,
      session.session_action
    from public.create_or_resume_solo_session(
      (
        select fixture.ruleset
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'rules'
      )
    ) as session
  $$,
  'no previous session creates a new solo session'
);
select is(
  (
    select fixture.session_action
    from solo_lifecycle_fixture as fixture
    where fixture.label = 'initial'
  ),
  'created',
  'new solo startup reports the created state'
);
select lives_ok(
  $$
    insert into solo_lifecycle_fixture (
      label,
      match_id,
      board_seed,
      scheduled_start_at,
      session_action
    )
    select
      'resumed',
      session.match_id,
      session.board_seed,
      session.scheduled_start_at,
      session.session_action
    from public.create_or_resume_solo_session(
      (
        select fixture.ruleset
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'rules'
      )
    ) as session
  $$,
  'a second start request resumes the unfinished round'
);
select is(
  (
    select fixture.session_action
    from solo_lifecycle_fixture as fixture
    where fixture.label = 'resumed'
  ),
  'resumed',
  'the repeated request reports the resumed state'
);
reset role;

select ok(
  (
    select
      first.match_id = resumed.match_id
      and first.board_seed = resumed.board_seed
      and first.scheduled_start_at = resumed.scheduled_start_at
    from solo_lifecycle_fixture as first
    cross join solo_lifecycle_fixture as resumed
    where first.label = 'initial'
      and resumed.label = 'resumed'
  ),
  'refresh restores the same match, board seed, and authoritative clock'
);
select is(
  (
    select count(*)::integer
    from public.matches as match_row
    join public.match_players as player on player.match_id = match_row.id
    where player.player_user_id =
        'c1000000-0000-4000-8000-000000000001'
      and match_row.mode = 'solo'
      and match_row.status in ('starting', 'active')
  ),
  1,
  'repeated or concurrent-style starts leave one active solo session'
);

update public.matches as match_row
set scheduled_start_at = clock_timestamp() - interval '80 seconds'
where match_row.id = (
  select fixture.match_id
  from solo_lifecycle_fixture as fixture
  where fixture.label = 'initial'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'c1000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    insert into solo_lifecycle_fixture (
      label,
      match_id,
      board_seed,
      scheduled_start_at,
      session_action
    )
    select
      'replacement',
      session.match_id,
      session.board_seed,
      session.scheduled_start_at,
      session.session_action
    from public.create_or_resume_solo_session(
      (
        select fixture.ruleset
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'rules'
      )
    ) as session
  $$,
  'an expired solo session is replaced in the same operation'
);
reset role;

select is(
  (
    select fixture.session_action
    from solo_lifecycle_fixture as fixture
    where fixture.label = 'replacement'
  ),
  'replaced',
  'expired replacement reports its recoverable state'
);
select is(
  (
    select match_row.status::text
    from public.matches as match_row
    join solo_lifecycle_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'initial'
  ),
  'cancelled',
  'the expired session is cancelled without a result'
);
select is(
  (
    select count(*)::integer
    from public.player_mode_stats as stats
    where stats.user_id = 'c1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  0,
  'expiration does not update solo statistics'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'c1000000-0000-4000-8000-000000000001',
  true
);
select is(
  (
    select result.abandoned
    from public.abandon_solo_session(
      (
        select fixture.match_id
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'replacement'
      )
    ) as result
  ),
  true,
  'an intentional exit abandons the active solo session'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.player_mode_stats as stats
    where stats.user_id = 'c1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  0,
  'intentional abandonment does not update solo statistics'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'c1000000-0000-4000-8000-000000000001',
  true
);
select is(
  (
    select result.abandoned
    from public.abandon_solo_session(
      (
        select fixture.match_id
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'replacement'
      )
    ) as result
  ),
  false,
  'repeated abandonment is idempotent'
);
select lives_ok(
  $$
    insert into solo_lifecycle_fixture (
      label,
      match_id,
      board_seed,
      scheduled_start_at,
      session_action
    )
    select
      'after-abandon',
      session.match_id,
      session.board_seed,
      session.scheduled_start_at,
      session.session_action
    from public.create_or_resume_solo_session(
      (
        select fixture.ruleset
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'rules'
      )
    ) as session
  $$,
  'an abandoned session permits an immediate new round'
);
select is(
  (
    select fixture.session_action
    from solo_lifecycle_fixture as fixture
    where fixture.label = 'after-abandon'
  ),
  'created',
  'the post-abandon round is newly created'
);

select set_config(
  'request.jwt.claim.sub',
  'c2000000-0000-4000-8000-000000000002',
  true
);
select throws_like(
  $$
    select public.abandon_solo_session(
      (
        select fixture.match_id
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'after-abandon'
      )
    )
  $$,
  '%unavailable%',
  'a player cannot abandon another player''s solo round'
);
reset role;

update public.match_players as player
set
  finished_at = clock_timestamp(),
  validated_score = 400,
  validated_words = '[{"word":"RATE","score":400}]'::jsonb
where player.match_id = (
  select fixture.match_id
  from solo_lifecycle_fixture as fixture
  where fixture.label = 'after-abandon'
);

select is(
  (
    select match_row.status::text
    from public.matches as match_row
    join solo_lifecycle_fixture as fixture on fixture.match_id = match_row.id
    where fixture.label = 'after-abandon'
  ),
  'completed',
  'a submitted solo round still completes through authoritative validation'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'c1000000-0000-4000-8000-000000000001',
  true
);
select throws_like(
  $$
    select public.abandon_solo_session(
      (
        select fixture.match_id
        from solo_lifecycle_fixture as fixture
        where fixture.label = 'after-abandon'
      )
    )
  $$,
  '%already completed%',
  'a completed solo session cannot be abandoned retroactively'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.player_mode_stats as stats
    where stats.user_id = 'c1000000-0000-4000-8000-000000000001'
      and stats.category = 'solo'
  ),
  1,
  'only the completed solo round updates saved statistics'
);

select * from finish();
rollback;
