begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.match_status as enum (
  'waiting',
  'starting',
  'active',
  'completed',
  'cancelled'
);

create type public.match_result_status as enum (
  'pending',
  'winner',
  'loser',
  'tie',
  'forfeit'
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint profiles_display_name_length check (
    char_length(display_name) between 2 and 24
  ),
  constraint profiles_display_name_format check (
    display_name = btrim(display_name)
    and display_name !~ '[[:space:]]{2,}'
    and display_name ~ '^[[:alnum:] _''-]+$'
  )
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  status public.match_status not null default 'waiting',
  host_user_id uuid not null references public.profiles (id) on delete restrict,
  board_seed bigint not null,
  round_duration_seconds integer not null default 60,
  scheduled_start_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  winner_id uuid references public.profiles (id) on delete restrict,
  is_tie boolean not null default false,
  constraint matches_room_code_unique unique (room_code),
  constraint matches_room_code_format check (
    room_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'
  ),
  constraint matches_board_seed_range check (
    board_seed between 0 and 4294967295
  ),
  constraint matches_round_duration_range check (
    round_duration_seconds between 30 and 300
  ),
  constraint matches_start_state check (
    (status in ('waiting', 'cancelled') and scheduled_start_at is null)
    or
    (status in ('starting', 'active', 'completed') and scheduled_start_at is not null)
  ),
  constraint matches_completion_state check (
    (
      status = 'completed'
      and completed_at is not null
      and (
        (is_tie and winner_id is null)
        or
        (not is_tie and winner_id is not null)
      )
    )
    or
    (
      status <> 'completed'
      and completed_at is null
      and winner_id is null
      and not is_tie
    )
  )
);

create table public.match_players (
  match_id uuid not null references public.matches (id) on delete cascade,
  player_user_id uuid not null references public.profiles (id) on delete restrict,
  player_number smallint not null,
  joined_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  validated_score integer,
  validated_words jsonb not null default '[]'::jsonb,
  result_status public.match_result_status not null default 'pending',
  primary key (match_id, player_user_id),
  constraint match_players_one_number_per_match unique (
    match_id,
    player_number
  ),
  constraint match_players_player_number check (player_number in (1, 2)),
  constraint match_players_words_array check (
    jsonb_typeof(validated_words) = 'array'
  ),
  constraint match_players_result_state check (
    (
      finished_at is null
      and validated_score is null
      and validated_words = '[]'::jsonb
      and result_status = 'pending'
    )
    or
    (
      finished_at is not null
      and validated_score >= 0
    )
  )
);

create index matches_status_created_at_idx
  on public.matches (status, created_at);
create index matches_host_user_id_idx
  on public.matches (host_user_id);
create index matches_winner_id_idx
  on public.matches (winner_id)
  where winner_id is not null;
create index match_players_player_user_id_match_id_idx
  on public.match_players (player_user_id, match_id);

comment on constraint match_players_one_number_per_match
  on public.match_players is
  'Together with player_number in (1,2), this is the hard database limit of two players per match.';

create table private.approved_words (
  word text primary key,
  constraint approved_words_uppercase check (word = upper(word)),
  constraint approved_words_minimum_length check (char_length(word) >= 3)
);

insert into private.approved_words (word)
values
  ('ALE'),
  ('ALONE'),
  ('ART'),
  ('CAR'),
  ('CARE'),
  ('CART'),
  ('CAT'),
  ('CATS'),
  ('EAR'),
  ('EAT'),
  ('LAME'),
  ('LAST'),
  ('LATE'),
  ('LEAST'),
  ('LIE'),
  ('LINE'),
  ('LION'),
  ('LONG'),
  ('MASTER'),
  ('MASTERING'),
  ('MAT'),
  ('MATE'),
  ('MEAL'),
  ('MEAT'),
  ('MEN'),
  ('ONE'),
  ('RACE'),
  ('RAT'),
  ('RATE'),
  ('REAL'),
  ('REALIST'),
  ('REALM'),
  ('SALE'),
  ('SAME'),
  ('SAT'),
  ('SON'),
  ('SONG'),
  ('STAIR'),
  ('STALE'),
  ('STAR'),
  ('STARE'),
  ('START'),
  ('STEAM'),
  ('STONE'),
  ('STREAM'),
  ('TALE'),
  ('TAME'),
  ('TAR'),
  ('TEA'),
  ('TEAM'),
  ('TEAMS'),
  ('TEAR'),
  ('TIE'),
  ('TIER'),
  ('TILE'),
  ('TIN'),
  ('TIRE'),
  ('TON'),
  ('TONE');

revoke all on table private.approved_words from public, anon, authenticated;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function private.touch_updated_at();

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  guest_number integer;
begin
  guest_number :=
    (
      (('x' || substr(replace(new.id::text, '-', ''), 1, 8))::bit(32)::bigint)
      % 9000
    )::integer + 1000;

  insert into public.profiles (id, display_name)
  values (new.id, 'Guest ' || lpad(guest_number::text, 4, '0'))
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger create_profile_for_new_auth_user
after insert on auth.users
for each row execute function private.handle_new_auth_user();

comment on function private.handle_new_auth_user() is
  'Creates the non-sensitive guest profile at auth-user creation time. It is SECURITY DEFINER because auth users cannot write auth.users triggers themselves.';

create or replace function private.is_match_participant(
  p_match_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.match_players as mp
    where mp.match_id = p_match_id
      and mp.player_user_id = p_user_id
  );
$$;

create or replace function private.players_share_match(
  p_first_user_id uuid,
  p_second_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_first_user_id = p_second_user_id
    or exists (
      select 1
      from public.match_players as first_player
      join public.match_players as second_player
        on second_player.match_id = first_player.match_id
      where first_player.player_user_id = p_first_user_id
        and second_player.player_user_id = p_second_user_id
    );
$$;

alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;

create policy profiles_select_self_or_opponent
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or private.players_share_match(id, (select auth.uid()))
);

create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (id = (select auth.uid()));

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy matches_select_participant_only
on public.matches
for select
to authenticated
using (
  private.is_match_participant(id, (select auth.uid()))
);

create policy match_players_select_participant_match_only
on public.match_players
for select
to authenticated
using (
  private.is_match_participant(match_id, (select auth.uid()))
);

comment on policy matches_select_participant_only on public.matches is
  'Room codes are not a discovery API. A signed-in user can read a private match only after an atomic RPC has added that user as a participant.';
comment on policy match_players_select_participant_match_only
  on public.match_players is
  'Participants may see both result rows for their own match, but no direct INSERT or UPDATE privilege is granted on this table.';

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.matches from public, anon, authenticated;
revoke all on table public.match_players from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant insert (id, display_name) on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;
grant select on table public.matches to authenticated;
grant select on table public.match_players to authenticated;
grant usage on type public.match_status to authenticated;
grant usage on type public.match_result_status to authenticated;

create or replace function private.random_room_code()
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select string_agg(
    substr(
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
      floor(random() * 32)::integer + 1,
      1
    ),
    ''
  )
  from generate_series(1, 6);
$$;

create or replace function private.board_letter(
  p_seed bigint,
  p_row integer,
  p_column integer
)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  board_rows constant text[] := array['CATS', 'REAM', 'TILE', 'SONG'];
  next_state bigint;
  transform_number integer;
  source_row integer;
  source_column integer;
begin
  if p_seed < 0 or p_seed > 4294967295 then
    raise exception 'Board seed is outside the uint32 range.';
  end if;

  if p_row not between 0 and 3 or p_column not between 0 and 3 then
    raise exception 'Tile coordinate is outside the board.';
  end if;

  next_state := mod(
    p_seed * 1664525 + 1013904223,
    4294967296
  );
  transform_number := floor(
    (next_state * 8)::numeric / 4294967296
  )::integer;

  case transform_number
    when 0 then
      source_row := p_row;
      source_column := p_column;
    when 1 then
      source_row := 3 - p_column;
      source_column := p_row;
    when 2 then
      source_row := 3 - p_row;
      source_column := 3 - p_column;
    when 3 then
      source_row := p_column;
      source_column := 3 - p_row;
    when 4 then
      source_row := p_row;
      source_column := 3 - p_column;
    when 5 then
      source_row := 3 - p_column;
      source_column := 3 - p_row;
    when 6 then
      source_row := 3 - p_row;
      source_column := p_column;
    when 7 then
      source_row := p_column;
      source_column := p_row;
    else
      raise exception 'Unsupported board transform.';
  end case;

  return substr(
    board_rows[source_row + 1],
    source_column + 1,
    1
  );
end;
$$;

revoke all on function private.random_room_code()
  from public, anon, authenticated;
revoke all on function private.board_letter(bigint, integer, integer)
  from public, anon, authenticated;

create or replace function public.get_server_time()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  return clock_timestamp();
end;
$$;

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

  insert into public.profiles (id, display_name)
  values (
    current_user_id,
    'Guest ' || lpad(
      (
        (
          (('x' || substr(replace(current_user_id::text, '-', ''), 1, 8))
            ::bit(32)::bigint) % 9000
        ) + 1000
      )::text,
      4,
      '0'
    )
  )
  on conflict (id) do nothing;

  for attempt in 1..12 loop
    generated_match_id := gen_random_uuid();
    generated_room_code := private.random_room_code();
    generated_seed := floor(random() * 4294967296)::bigint;

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
        clock_timestamp();
      return;
    exception
      when unique_violation then
        -- The nested block is a subtransaction: a rare room-code collision
        -- rolls back both inserts before the next code is attempted.
        null;
    end;
  end loop;

  raise exception 'A unique room code could not be generated. Try again.';
end;
$$;

create or replace function public.join_private_match(p_room_code text)
returns table (
  match_id uuid,
  room_code text,
  status public.match_status,
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
  normalized_code text;
  locked_match public.matches%rowtype;
  player_count integer;
  start_time timestamptz;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  normalized_code := regexp_replace(
    upper(coalesce(p_room_code, '')),
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

  if not found then
    raise exception 'That room is missing or expired.';
  end if;

  if locked_match.created_at < clock_timestamp() - interval '2 hours' then
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
    raise exception 'The host cannot occupy both player positions.';
  end if;

  select count(*)
  into player_count
  from public.match_players as existing_player
  where existing_player.match_id = locked_match.id;

  if player_count >= 2 then
    raise exception 'That private room is full.';
  end if;

  insert into public.profiles (id, display_name)
  values (
    current_user_id,
    'Guest ' || lpad(
      (
        (
          (('x' || substr(replace(current_user_id::text, '-', ''), 1, 8))
            ::bit(32)::bigint) % 9000
        ) + 1000
      )::text,
      4,
      '0'
    )
  )
  on conflict (id) do nothing;

  insert into public.match_players (
    match_id,
    player_user_id,
    player_number
  )
  values (locked_match.id, current_user_id, 2);

  start_time := clock_timestamp() + interval '5 seconds';

  update public.matches as match_row
  set
    status = 'starting',
    scheduled_start_at = start_time
  where match_row.id = locked_match.id;

  return query
  select
    locked_match.id,
    locked_match.room_code,
    'starting'::public.match_status,
    locked_match.board_seed,
    locked_match.round_duration_seconds,
    start_time,
    clock_timestamp();
end;
$$;

comment on function public.join_private_match(text) is
  'Locks the room row before checking capacity and adding player two. This serializes simultaneous joins and never trusts a client-supplied user ID.';

create or replace function public.cancel_private_match(p_match_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  locked_match public.matches%rowtype;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found or locked_match.host_user_id <> current_user_id then
    raise exception 'Only the room host can cancel this match.';
  end if;

  if locked_match.status not in ('waiting', 'starting')
    or (
      locked_match.scheduled_start_at is not null
      and clock_timestamp() >= locked_match.scheduled_start_at
    ) then
    raise exception 'A match cannot be cancelled after it begins.';
  end if;

  update public.matches as match_row
  set
    status = 'cancelled',
    scheduled_start_at = null
  where match_row.id = p_match_id;

  return true;
end;
$$;

create or replace function public.activate_private_match(p_match_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  locked_match public.matches%rowtype;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.';
  end if;

  if locked_match.status = 'active' then
    return true;
  end if;

  if locked_match.status <> 'starting'
    or clock_timestamp() < locked_match.scheduled_start_at then
    return false;
  end if;

  update public.matches as match_row
  set status = 'active'
  where match_row.id = p_match_id;

  return true;
end;
$$;

create or replace function public.submit_match_result(
  p_match_id uuid,
  p_submissions jsonb
)
returns table (
  validated_score integer,
  already_finalized boolean,
  match_completed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  locked_match public.matches%rowtype;
  locked_player public.match_players%rowtype;
  submission_value jsonb;
  coordinate_value jsonb;
  claimed_word text;
  generated_word text;
  tile_key text;
  seen_tiles text[];
  seen_words text[] := array[]::text[];
  row_number integer;
  column_number integer;
  previous_row integer;
  previous_column integer;
  path_length integer;
  word_score integer;
  total_score integer := 0;
  validated_word_list jsonb := '[]'::jsonb;
  finished_player_count integer;
  first_player public.match_players%rowtype;
  second_player public.match_players%rowtype;
  winning_user_id uuid;
  did_complete boolean := false;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found then
    raise exception 'That match was not found.';
  end if;

  select player_row.*
  into locked_player
  from public.match_players as player_row
  where player_row.match_id = p_match_id
    and player_row.player_user_id = current_user_id
  for update;

  if not found then
    raise exception 'You are not a participant in this match.';
  end if;

  -- An exact retry returns the first immutable, server-validated result.
  if locked_player.finished_at is not null then
    return query
    select
      locked_player.validated_score,
      true,
      locked_match.status = 'completed';
    return;
  end if;

  if locked_match.status not in ('starting', 'active')
    or locked_match.scheduled_start_at is null then
    raise exception 'This match is not accepting results.';
  end if;

  if clock_timestamp() < locked_match.scheduled_start_at
    or clock_timestamp() >
      locked_match.scheduled_start_at
      + make_interval(secs => locked_match.round_duration_seconds)
      + interval '15 seconds' then
    raise exception 'The result is outside the permitted round window.';
  end if;

  if p_submissions is null
    or jsonb_typeof(p_submissions) is distinct from 'array' then
    raise exception 'Submitted words must be a JSON array.';
  end if;

  if jsonb_array_length(p_submissions) > 64 then
    raise exception 'Too many words were submitted.';
  end if;

  for submission_value in
    select submitted.value
    from jsonb_array_elements(p_submissions) as submitted(value)
  loop
    if jsonb_typeof(submission_value) is distinct from 'object'
      or jsonb_typeof(submission_value -> 'word') is distinct from 'string'
      or jsonb_typeof(submission_value -> 'path') is distinct from 'array' then
      raise exception 'A submitted word is malformed.';
    end if;

    claimed_word := upper(btrim(submission_value ->> 'word'));
    path_length := jsonb_array_length(submission_value -> 'path');

    if path_length < 1 or path_length > 16 then
      raise exception 'A submitted tile path has an invalid length.';
    end if;

    generated_word := '';
    seen_tiles := array[]::text[];
    previous_row := null;
    previous_column := null;

    for coordinate_value in
      select coordinate.value
      from jsonb_array_elements(submission_value -> 'path')
        as coordinate(value)
    loop
      if jsonb_typeof(coordinate_value) is distinct from 'object'
        or jsonb_typeof(coordinate_value -> 'row') is distinct from 'number'
        or jsonb_typeof(coordinate_value -> 'column') is distinct from 'number'
        or (coordinate_value ->> 'row') !~ '^-?[0-9]+$'
        or (coordinate_value ->> 'column') !~ '^-?[0-9]+$' then
        raise exception 'A tile coordinate is malformed.';
      end if;

      row_number := (coordinate_value ->> 'row')::integer;
      column_number := (coordinate_value ->> 'column')::integer;

      if row_number not between 0 and 3
        or column_number not between 0 and 3 then
        raise exception 'A tile coordinate is outside the board.';
      end if;

      tile_key := row_number::text || ':' || column_number::text;

      if tile_key = any(seen_tiles) then
        raise exception 'A tile was repeated within one word.';
      end if;

      if previous_row is not null
        and (
          greatest(
            abs(row_number - previous_row),
            abs(column_number - previous_column)
          ) <> 1
        ) then
        raise exception 'Consecutive tiles are not adjacent.';
      end if;

      seen_tiles := array_append(seen_tiles, tile_key);
      generated_word := generated_word || private.board_letter(
        locked_match.board_seed,
        row_number,
        column_number
      );
      previous_row := row_number;
      previous_column := column_number;
    end loop;

    if generated_word <> claimed_word then
      raise exception 'A claimed word does not match its tile path.';
    end if;

    if char_length(generated_word) < 3 then
      raise exception 'Words must contain at least three letters.';
    end if;

    if not exists (
      select 1
      from private.approved_words as dictionary
      where dictionary.word = generated_word
    ) then
      raise exception 'A submitted word is not in the approved dictionary.';
    end if;

    if generated_word = any(seen_words) then
      raise exception 'A word was submitted more than once.';
    end if;

    word_score := case char_length(generated_word)
      when 3 then 100
      when 4 then 400
      when 5 then 800
      when 6 then 1400
      when 7 then 1800
      else 2200
    end;

    total_score := total_score + word_score;
    seen_words := array_append(seen_words, generated_word);
    validated_word_list := validated_word_list || jsonb_build_array(
      jsonb_build_object(
        'word', generated_word,
        'score', word_score
      )
    );
  end loop;

  update public.match_players as player_row
  set
    finished_at = clock_timestamp(),
    validated_score = total_score,
    validated_words = validated_word_list
  where player_row.match_id = p_match_id
    and player_row.player_user_id = current_user_id;

  if locked_match.status = 'starting' then
    update public.matches as match_row
    set status = 'active'
    where match_row.id = p_match_id;
  end if;

  select count(*)
  into finished_player_count
  from public.match_players as player_row
  where player_row.match_id = p_match_id
    and player_row.finished_at is not null;

  if finished_player_count = 2 then
    select player_row.*
    into first_player
    from public.match_players as player_row
    where player_row.match_id = p_match_id
      and player_row.player_number = 1;

    select player_row.*
    into second_player
    from public.match_players as player_row
    where player_row.match_id = p_match_id
      and player_row.player_number = 2;

    if first_player.validated_score = second_player.validated_score then
      update public.match_players as player_row
      set result_status = 'tie'
      where player_row.match_id = p_match_id;

      update public.matches as match_row
      set
        status = 'completed',
        completed_at = clock_timestamp(),
        winner_id = null,
        is_tie = true
      where match_row.id = p_match_id;
    else
      winning_user_id := case
        when first_player.validated_score > second_player.validated_score
          then first_player.player_user_id
        else second_player.player_user_id
      end;

      update public.match_players as player_row
      set result_status = case
        when player_row.player_user_id = winning_user_id
          then 'winner'::public.match_result_status
        else 'loser'::public.match_result_status
      end
      where player_row.match_id = p_match_id;

      update public.matches as match_row
      set
        status = 'completed',
        completed_at = clock_timestamp(),
        winner_id = winning_user_id,
        is_tie = false
      where match_row.id = p_match_id;
    end if;

    did_complete := true;
  end if;

  return query
  select total_score, false, did_complete;
end;
$$;

comment on function public.submit_match_result(uuid, jsonb) is
  'Security-sensitive result boundary. It derives auth.uid(), locks the match/player rows, regenerates every board letter, validates adjacency/repeats/dictionary/duplicates/timing, recomputes score, and finalizes the winner atomically.';

create or replace function public.finalize_stale_match(p_match_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  locked_match public.matches%rowtype;
  finished_count integer;
  submitted_user_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.';
  end if;

  if locked_match.status in ('completed', 'cancelled') then
    return true;
  end if;

  if locked_match.scheduled_start_at is null
    or clock_timestamp() <
      locked_match.scheduled_start_at
      + make_interval(secs => locked_match.round_duration_seconds)
      + interval '45 seconds' then
    return false;
  end if;

  select count(*) filter (where player_row.finished_at is not null)
  into finished_count
  from public.match_players as player_row
  where player_row.match_id = p_match_id;

  if finished_count = 0 then
    update public.matches as match_row
    set
      status = 'cancelled',
      scheduled_start_at = null
    where match_row.id = p_match_id;
    return true;
  end if;

  if finished_count = 1 then
    select player_row.player_user_id
    into submitted_user_id
    from public.match_players as player_row
    where player_row.match_id = p_match_id
      and player_row.finished_at is not null
    limit 1;

    update public.match_players as player_row
    set
      finished_at = clock_timestamp(),
      validated_score = 0,
      validated_words = '[]'::jsonb,
      result_status = 'forfeit'
    where player_row.match_id = p_match_id
      and player_row.finished_at is null;

    update public.match_players as player_row
    set result_status = 'winner'
    where player_row.match_id = p_match_id
      and player_row.player_user_id = submitted_user_id;

    update public.matches as match_row
    set
      status = 'completed',
      completed_at = clock_timestamp(),
      winner_id = submitted_user_id,
      is_tie = false
    where match_row.id = p_match_id;
  end if;

  return true;
end;
$$;

revoke all on function public.get_server_time()
  from public, anon;
revoke all on function public.create_private_match()
  from public, anon;
revoke all on function public.join_private_match(text)
  from public, anon;
revoke all on function public.cancel_private_match(uuid)
  from public, anon;
revoke all on function public.activate_private_match(uuid)
  from public, anon;
revoke all on function public.submit_match_result(uuid, jsonb)
  from public, anon;
revoke all on function public.finalize_stale_match(uuid)
  from public, anon;

grant execute on function public.get_server_time()
  to authenticated;
grant execute on function public.create_private_match()
  to authenticated;
grant execute on function public.join_private_match(text)
  to authenticated;
grant execute on function public.cancel_private_match(uuid)
  to authenticated;
grant execute on function public.activate_private_match(uuid)
  to authenticated;
grant execute on function public.submit_match_result(uuid, jsonb)
  to authenticated;
grant execute on function public.finalize_stale_match(uuid)
  to authenticated;

comment on function public.create_private_match() is
  'Creates the host participant atomically and retries rare six-character room-code collisions.';
comment on function public.finalize_stale_match(uuid) is
  'Participant-only cleanup after the round and a 45-second recovery window. A missing result forfeits; if nobody submitted, the abandoned match is cancelled.';

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'matches'
    ) then
      alter publication supabase_realtime add table public.matches;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'match_players'
    ) then
      alter publication supabase_realtime add table public.match_players;
    end if;
  end if;
end;
$$;

commit;
