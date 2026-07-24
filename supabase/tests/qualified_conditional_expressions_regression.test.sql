-- Run after `npx supabase db reset`:
--   npx supabase test db supabase/tests/qualified_conditional_expressions_regression.test.sql
begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

select lives_ok(
  $$
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
      'b1000000-0000-4000-8000-000000000001',
      'authenticated',
      'authenticated',
      'named-signup@example.test',
      '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"display_name":"Signup Player"}'::jsonb,
      false,
      clock_timestamp(),
      clock_timestamp()
    )
  $$,
  'email and password signup initializes without a missing-function error'
);

select is(
  (
    select profile.display_name
    from public.profiles as profile
    where profile.id = 'b1000000-0000-4000-8000-000000000001'
  ),
  'Signup Player',
  'signup display-name metadata reaches the public profile'
);

select lives_ok(
  $$
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
      'b2000000-0000-4000-8000-000000000002',
      'authenticated',
      'authenticated',
      'unnamed-signup@example.test',
      '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      false,
      clock_timestamp(),
      clock_timestamp()
    )
  $$,
  'signup without display-name metadata initializes safely'
);

select matches(
  (
    select profile.display_name
    from public.profiles as profile
    where profile.id = 'b2000000-0000-4000-8000-000000000002'
  ),
  '^Guest [0-9]{4}$',
  'missing display-name metadata keeps the generated guest fallback'
);

select lives_ok(
  $$
    select private.mode_key('solo', private.ranked_ruleset())
  $$,
  'mode-key generation executes without a missing-function error'
);

select lives_ok(
  $$
    select private.mode_display_label('solo', private.ranked_ruleset())
  $$,
  'mode-label generation executes without a missing-function error'
);

set local role anon;
select lives_ok(
  $$
    select *
    from public.get_public_player_mode_stats(
      (
        select profile.public_profile_id
        from public.profiles as profile
        where profile.id = 'b1000000-0000-4000-8000-000000000001'
      ),
      1
    )
  $$,
  'public player mode statistics execute without a missing-function error'
);
reset role;

select * from finish();
rollback;
