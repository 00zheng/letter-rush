begin;

-- This is the only function that creates a missing profile. It serializes
-- initialization per auth user, retries opaque-ID collisions, and never
-- changes an existing profile's display name or public identifier.
create or replace function private.ensure_ranked_identity(p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  guest_number integer;
  candidate text;
begin
  if p_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'profile-identity:' || p_user_id::text,
      0
    )
  );

  guest_number :=
    (
      (
        (
          'x'
          || pg_catalog.substr(
            pg_catalog.replace(p_user_id::text, '-', ''),
            1,
            8
          )
        )::bit(32)::bigint
      )
      % 9000
    )::integer + 1000;

  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_user_id
  ) then
    loop
      candidate := private.random_public_profile_id();

      begin
        insert into public.profiles (
          id,
          public_profile_id,
          display_name
        )
        values (
          p_user_id,
          candidate,
          'Guest ' || pg_catalog.lpad(guest_number::text, 4, '0')
        )
        on conflict (id) do nothing;

        exit when exists (
          select 1
          from public.profiles as profile
          where profile.id = p_user_id
        );
      exception
        when unique_violation then
          -- A collision on public_profile_id retries with a fresh opaque ID.
          null;
      end;
    end loop;
  end if;

  insert into public.ranked_stats (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function private.ensure_ranked_identity(uuid)
  from public, anon, authenticated;

-- Auth creation and every public gameplay RPC delegate to the same identity
-- initializer instead of maintaining independent profile-insert logic.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_ranked_identity(new.id);
  return new;
end;
$$;

revoke all on function private.handle_new_auth_user()
  from public, anon, authenticated;

create or replace function public.ensure_current_player_identity()
returns table (
  display_name text,
  public_profile_id text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform private.ensure_ranked_identity(current_user_id);

  return query
  select
    profile.display_name,
    profile.public_profile_id
  from public.profiles as profile
  where profile.id = current_user_id;
end;
$$;

comment on function public.ensure_current_player_identity() is
  'Idempotently initializes the authenticated caller and returns only its display name and opaque public profile ID.';

revoke all on function public.ensure_current_player_identity()
  from public, anon, authenticated;
grant execute on function public.ensure_current_player_identity()
  to authenticated;

-- Repair auth users that predate a complete profile/ranked identity. Existing
-- profile values are left untouched.
do $$
declare
  user_row record;
begin
  for user_row in
    select auth_user.id
    from auth.users as auth_user
    left join public.profiles as profile
      on profile.id = auth_user.id
    left join public.ranked_stats as stats
      on stats.user_id = auth_user.id
    where profile.id is null
      or stats.user_id is null
    order by auth_user.id
  loop
    perform private.ensure_ranked_identity(user_row.id);
  end loop;
end;
$$;

-- Browser clients may still update their display name, but profile creation is
-- RPC-only after this migration.
revoke insert on table public.profiles from authenticated;
revoke insert (id, display_name) on public.profiles from authenticated;

create or replace function public.create_private_match()
returns table (
  match_id uuid,
  room_code text,
  board_seed bigint,
  round_duration_seconds integer,
  scheduled_start_at timestamptz,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  attempt integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform private.ensure_ranked_identity(current_user_id);

  for attempt in 1..12 loop
    generated_match_id := pg_catalog.gen_random_uuid();
    generated_room_code := private.random_room_code();
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;

    begin
      insert into public.matches (
        id,
        room_code,
        host_user_id,
        board_seed
      )
      values (
        generated_match_id,
        generated_room_code,
        current_user_id,
        generated_seed
      );

      insert into public.match_players (
        match_id,
        player_user_id,
        player_number
      )
      values (generated_match_id, current_user_id, 1);

      return query
      select
        generated_match_id,
        generated_room_code,
        generated_seed,
        60,
        null::timestamptz,
        pg_catalog.clock_timestamp();
      return;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  raise exception 'A unique room code could not be generated. Try again.';
end;
$$;

comment on function public.create_private_match() is
  'Creates the legacy two-player private match after idempotently initializing the authenticated host.';

revoke all on function public.create_private_match()
  from public, anon, authenticated;
grant execute on function public.create_private_match()
  to authenticated;

create or replace function public.create_private_lobby(
  p_ruleset jsonb,
  p_max_players integer
)
returns table (
  match_id uuid,
  room_code text,
  board_seed bigint,
  round_duration_seconds integer,
  scheduled_start_at timestamptz,
  server_now timestamptz,
  max_players smallint,
  ruleset jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_ruleset jsonb;
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  attempt integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform private.ensure_ranked_identity(current_user_id);

  normalized_ruleset := private.validate_game_ruleset(
    p_ruleset,
    p_max_players
  );

  for attempt in 1..12 loop
    generated_match_id := pg_catalog.gen_random_uuid();
    generated_room_code := private.random_room_code();
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;

    begin
      insert into public.matches (
        id,
        room_code,
        host_user_id,
        board_seed,
        round_duration_seconds,
        max_players,
        ruleset,
        dictionary_version,
        board_generation_version,
        ruleset_version
      )
      values (
        generated_match_id,
        generated_room_code,
        current_user_id,
        generated_seed,
        (normalized_ruleset ->> 'roundDurationSeconds')::integer,
        p_max_players,
        normalized_ruleset,
        normalized_ruleset ->> 'dictionaryVersion',
        normalized_ruleset ->> 'boardGenerationVersion',
        normalized_ruleset ->> 'version'
      );

      insert into public.match_players (
        match_id,
        player_user_id,
        player_number
      )
      values (generated_match_id, current_user_id, 1);

      return query
      select
        generated_match_id,
        generated_room_code,
        generated_seed,
        (normalized_ruleset ->> 'roundDurationSeconds')::integer,
        null::timestamptz,
        pg_catalog.clock_timestamp(),
        p_max_players::smallint,
        normalized_ruleset;
      return;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  raise exception 'A unique room code could not be generated. Try again.';
end;
$$;

comment on function public.create_private_lobby(jsonb, integer) is
  'Atomically initializes the authenticated host and creates a private 2-12 player lobby with collision-safe room-code retries.';

revoke all on function public.create_private_lobby(jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.create_private_lobby(jsonb, integer)
  to authenticated;

create or replace function public.join_private_match(p_room_code text)
returns table (
  match_id uuid,
  room_code text,
  status public.match_status,
  board_seed bigint,
  round_duration_seconds integer,
  scheduled_start_at timestamptz,
  server_now timestamptz,
  max_players smallint,
  ruleset jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_code text;
  locked_match public.matches%rowtype;
  player_count integer;
  available_number integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform private.ensure_ranked_identity(current_user_id);

  normalized_code := pg_catalog.regexp_replace(
    pg_catalog.upper(coalesce(p_room_code, '')),
    '[[:space:]-]+',
    '',
    'g'
  );

  if normalized_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    raise exception 'That room code is invalid.';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.room_code = normalized_code
  for update;

  if not found
    or locked_match.created_at
      < pg_catalog.clock_timestamp() - interval '2 hours' then
    raise exception 'That room is missing or expired.';
  end if;

  if locked_match.status = 'cancelled' then
    raise exception 'That room was cancelled.';
  elsif locked_match.status = 'completed' then
    raise exception 'That match is already completed.';
  elsif locked_match.status <> 'waiting'
    or locked_match.scheduled_start_at is not null then
    raise exception 'That match has already started.';
  end if;

  if exists (
    select 1
    from public.match_players as existing_player
    where existing_player.match_id = locked_match.id
      and existing_player.player_user_id = current_user_id
  ) then
    raise exception 'This account is already in that lobby.';
  end if;

  select pg_catalog.count(*)::integer
  into player_count
  from public.match_players as existing_player
  where existing_player.match_id = locked_match.id;

  if player_count >= locked_match.max_players then
    raise exception 'That private lobby is full.';
  end if;

  select candidate.player_number
  into available_number
  from pg_catalog.generate_series(
    2,
    locked_match.max_players
  ) as candidate(player_number)
  where not exists (
    select 1
    from public.match_players as existing_player
    where existing_player.match_id = locked_match.id
      and existing_player.player_number = candidate.player_number
  )
  order by candidate.player_number
  limit 1;

  insert into public.match_players (
    match_id,
    player_user_id,
    player_number
  )
  values (locked_match.id, current_user_id, available_number);

  return query
  select
    locked_match.id,
    locked_match.room_code,
    locked_match.status,
    locked_match.board_seed,
    locked_match.round_duration_seconds,
    locked_match.scheduled_start_at,
    pg_catalog.clock_timestamp(),
    locked_match.max_players,
    locked_match.ruleset;
end;
$$;

comment on function public.join_private_match(text) is
  'Initializes the authenticated caller, then locks the lobby before capacity checks and insertion.';

revoke all on function public.join_private_match(text)
  from public, anon, authenticated;
grant execute on function public.join_private_match(text)
  to authenticated;

commit;
