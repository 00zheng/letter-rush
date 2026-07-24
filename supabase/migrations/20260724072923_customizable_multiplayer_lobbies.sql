begin;

-- This migration evolves the original two-player model in place. Existing
-- matches receive the legacy 4x4 board algorithm as an immutable v2 ruleset;
-- the original migration is intentionally left untouched.
alter table public.matches
  add column max_players smallint not null default 2,
  add column ruleset jsonb not null default
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
      "boardGenerationVersion":"legacy-v1"
    }'::jsonb,
  add column dictionary_version text not null default 'enable2k-af52415-v1',
  add column board_generation_version text not null default 'legacy-v1',
  add column ruleset_version text not null default '2';

update public.matches
set ruleset = jsonb_set(
  ruleset,
  '{roundDurationSeconds}',
  to_jsonb(round_duration_seconds)
);

alter table public.matches
  add constraint matches_max_players_range
    check (max_players between 2 and 12),
  add constraint matches_ruleset_object
    check (jsonb_typeof(ruleset) = 'object'),
  add constraint matches_version_fields_present
    check (
      char_length(dictionary_version) between 1 and 64
      and char_length(board_generation_version) between 1 and 32
      and char_length(ruleset_version) between 1 and 16
    );

alter table public.match_players
  drop constraint match_players_player_number,
  add constraint match_players_player_number
    check (player_number between 1 and 12);

comment on constraint match_players_one_number_per_match
  on public.match_players is
  'Player numbers are unique per match; matches.max_players and the row-locked join RPC impose the 2-12 player capacity.';
comment on column public.matches.ruleset is
  'Immutable after countdown start. This snapshot is the authoritative board, dictionary, duration, scoring, and generation configuration.';

-- Preserve the original placeholder table for audit/rollback while replacing
-- it with a version-keyed lexicon used by generalized result validation.
alter table private.approved_words rename to approved_words_legacy;

create table private.approved_words (
  dictionary_version text not null,
  word text not null,
  primary key (dictionary_version, word),
  constraint approved_words_lowercase_alpha
    check (word = lower(word) and word ~ '^[a-z]+$'),
  constraint approved_words_minimum_length check (char_length(word) >= 2)
);

insert into private.approved_words (dictionary_version, word)
select 'enable2k-af52415-v1', lower(word)
from private.approved_words_legacy
on conflict do nothing;

revoke all on table private.approved_words
  from public, anon, authenticated;

create or replace function private.validate_game_ruleset(
  p_ruleset jsonb,
  p_max_players integer
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  normalized jsonb;
  board_rows integer;
  board_columns integer;
  duration_seconds integer;
  minimum_word_length integer;
  active_mask jsonb;
  active_count integer;
  first_active integer;
  current_index integer;
  current_row integer;
  current_column integer;
  neighbor_row integer;
  neighbor_column integer;
  neighbor_index integer;
  queue integer[] := array[]::integer[];
  visited integer[] := array[]::integer[];
begin
  if p_max_players not between 2 and 12 then
    raise exception 'Maximum players must be from 2 through 12.';
  end if;

  if p_ruleset is null or jsonb_typeof(p_ruleset) <> 'object' then
    raise exception 'A ruleset object is required.';
  end if;

  if coalesce(p_ruleset ->> 'rows', '') !~ '^[0-9]+$'
    or coalesce(p_ruleset ->> 'columns', '') !~ '^[0-9]+$'
    or coalesce(p_ruleset ->> 'roundDurationSeconds', '') !~ '^[0-9]+$'
    or coalesce(p_ruleset ->> 'minimumWordLength', '') !~ '^[0-9]+$' then
    raise exception 'Ruleset dimensions, duration, and minimum word length must be whole numbers.';
  end if;

  board_rows := (p_ruleset ->> 'rows')::integer;
  board_columns := (p_ruleset ->> 'columns')::integer;
  duration_seconds := (p_ruleset ->> 'roundDurationSeconds')::integer;
  minimum_word_length := (p_ruleset ->> 'minimumWordLength')::integer;
  active_mask := p_ruleset -> 'activeCells';

  if board_rows not between 3 and 8
    or board_columns not between 3 and 8 then
    raise exception 'Board rows and columns must be from 3 through 8.';
  end if;

  if duration_seconds not in (30, 60, 90, 120, 180) then
    raise exception 'Choose a supported round duration.';
  end if;

  if minimum_word_length not between 3 and 8 then
    raise exception 'Minimum word length must be from 3 through 8.';
  end if;

  if coalesce(p_ruleset ->> 'version', '') <> '2'
    or coalesce(p_ruleset ->> 'dictionaryVersion', '')
      <> 'enable2k-af52415-v1'
    or coalesce(p_ruleset ->> 'scoringRulesVersion', '') <> 'classic-v1'
    or coalesce(p_ruleset ->> 'boardGenerationVersion', '')
      not in ('legacy-v1', 'weighted-v2')
    or coalesce(p_ruleset ->> 'shape', '')
      not in ('rectangle', 'diamond', 'cross', 'custom') then
    raise exception 'The ruleset contains an unsupported version or shape.';
  end if;

  if jsonb_typeof(active_mask) is distinct from 'array' then
    raise exception 'The active-cell mask is malformed.';
  end if;

  if jsonb_array_length(active_mask) <> board_rows * board_columns
    or exists (
      select 1
      from jsonb_array_elements(active_mask) as cell(value)
      where jsonb_typeof(cell.value) <> 'boolean'
    ) then
    raise exception 'The active-cell mask is malformed.';
  end if;

  select count(*)::integer, min(cell.ordinality - 1)::integer
  into active_count, first_active
  from jsonb_array_elements(active_mask) with ordinality as cell(value, ordinality)
  where cell.value = 'true'::jsonb;

  if active_count < 9 then
    raise exception 'A board needs at least 9 active cells.';
  end if;

  queue := array[first_active];
  visited := array[first_active];

  while coalesce(array_length(queue, 1), 0) > 0 loop
    current_index := queue[1];
    queue := array_remove(queue, current_index);
    current_row := current_index / board_columns;
    current_column := mod(current_index, board_columns);

    for neighbor_row in
      greatest(0, current_row - 1)..least(board_rows - 1, current_row + 1)
    loop
      for neighbor_column in
        greatest(0, current_column - 1)..least(
          board_columns - 1,
          current_column + 1
        )
      loop
        neighbor_index := neighbor_row * board_columns + neighbor_column;
        if neighbor_index <> current_index
          and (active_mask -> neighbor_index) = 'true'::jsonb
          and not (neighbor_index = any(visited)) then
          visited := array_append(visited, neighbor_index);
          queue := array_append(queue, neighbor_index);
        end if;
      end loop;
    end loop;
  end loop;

  if array_length(visited, 1) <> active_count then
    raise exception 'All active cells must form one connected shape.';
  end if;

  if p_ruleset ->> 'boardGenerationVersion' = 'legacy-v1'
    and (
      board_rows <> 4
      or board_columns <> 4
      or active_count <> 16
    ) then
    raise exception 'Legacy board generation supports only a full 4 by 4 board.';
  end if;

  normalized := jsonb_build_object(
    'version', '2',
    'rows', board_rows,
    'columns', board_columns,
    'activeCells', active_mask,
    'shape', p_ruleset ->> 'shape',
    'roundDurationSeconds', duration_seconds,
    'minimumWordLength', minimum_word_length,
    'dictionaryVersion', 'enable2k-af52415-v1',
    'scoringRulesVersion', 'classic-v1',
    'boardGenerationVersion', p_ruleset ->> 'boardGenerationVersion'
  );

  return normalized;
end;
$$;

create or replace function private.generate_board_letters(
  p_seed bigint,
  p_ruleset jsonb
)
returns text[]
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  distribution constant text :=
    'EEEEEEEEEEEEAAAAAAAAAIIIIIIIIIOOOOOOOONNNNNNRRRRRRTTTTTTLLLLSSSSUUUUDDDDGGGBBCCMMPPFFHHVVWWYYKJXQZ';
  vowels constant text := 'AEIOU';
  uint32_range constant bigint := 4294967296;
  board_rows integer := (p_ruleset ->> 'rows')::integer;
  board_columns integer := (p_ruleset ->> 'columns')::integer;
  active_mask jsonb := p_ruleset -> 'activeCells';
  cell_count integer := board_rows * board_columns;
  letters text[] := array_fill(null::text, array[board_rows * board_columns]);
  consonant_positions integer[] := array[]::integer[];
  state bigint := p_seed;
  cell_index integer;
  array_position integer;
  choice integer;
  letter text;
  active_count integer := 0;
  vowel_count integer := 0;
  minimum_vowels integer;
begin
  if p_seed not between 0 and 4294967295 then
    raise exception 'Board seed is outside the uint32 range.';
  end if;

  if p_ruleset ->> 'boardGenerationVersion' = 'legacy-v1' then
    for cell_index in 0..15 loop
      letters[cell_index + 1] := private.board_letter(
        p_seed,
        cell_index / 4,
        mod(cell_index, 4)
      );
    end loop;
    return letters;
  end if;

  if p_ruleset ->> 'boardGenerationVersion' <> 'weighted-v2' then
    raise exception 'Unsupported board-generation version.';
  end if;

  for cell_index in 0..cell_count - 1 loop
    if (active_mask -> cell_index) = 'true'::jsonb then
      state := mod(state * 1664525 + 1013904223, uint32_range);
      letter := substr(
        distribution,
        floor(
          (state * char_length(distribution))::numeric / uint32_range
        )::integer + 1,
        1
      );
      letters[cell_index + 1] := letter;
      active_count := active_count + 1;

      if position(letter in vowels) > 0 then
        vowel_count := vowel_count + 1;
      else
        consonant_positions := array_append(
          consonant_positions,
          cell_index + 1
        );
      end if;
    end if;
  end loop;

  minimum_vowels := greatest(2, ceil(active_count * 0.28)::integer);
  while vowel_count < minimum_vowels
    and coalesce(array_length(consonant_positions, 1), 0) > 0 loop
    state := mod(state * 1664525 + 1013904223, uint32_range);
    choice := floor(
      (state * array_length(consonant_positions, 1))::numeric / uint32_range
    )::integer + 1;
    array_position := consonant_positions[choice];
    consonant_positions := array_remove(
      consonant_positions,
      array_position
    );

    state := mod(state * 1664525 + 1013904223, uint32_range);
    letters[array_position] := substr(
      vowels,
      floor((state * char_length(vowels))::numeric / uint32_range)::integer + 1,
      1
    );
    vowel_count := vowel_count + 1;
  end loop;

  return letters;
end;
$$;

create or replace function private.finalize_completed_lobby(p_match_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  participant_count integer;
  unfinished_count integer;
  best_score integer;
  top_count integer;
  winning_user_id uuid;
begin
  select
    count(*)::integer,
    count(*) filter (where player.finished_at is null)::integer
  into participant_count, unfinished_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if participant_count < 2 or unfinished_count > 0 then
    return false;
  end if;

  select max(player.validated_score)
  into best_score
  from public.match_players as player
  where player.match_id = p_match_id
    and player.result_status <> 'forfeit';

  if best_score is null then
    return false;
  end if;

  select count(*)::integer
  into top_count
  from public.match_players as player
  where player.match_id = p_match_id
    and player.result_status <> 'forfeit'
    and player.validated_score = best_score;

  if top_count = 1 then
    select player.player_user_id
    into winning_user_id
    from public.match_players as player
    where player.match_id = p_match_id
      and player.result_status <> 'forfeit'
      and player.validated_score = best_score;
  end if;

  update public.match_players as player
  set result_status = case
    when player.result_status = 'forfeit'
      then 'forfeit'::public.match_result_status
    when player.validated_score = best_score and top_count > 1
      then 'tie'::public.match_result_status
    when player.validated_score = best_score
      then 'winner'::public.match_result_status
    else 'loser'::public.match_result_status
  end
  where player.match_id = p_match_id;

  update public.matches as match_row
  set
    status = 'completed',
    completed_at = clock_timestamp(),
    winner_id = winning_user_id,
    is_tie = top_count > 1
  where match_row.id = p_match_id;

  return true;
end;
$$;

revoke all on function private.validate_game_ruleset(jsonb, integer)
  from public, anon, authenticated;
revoke all on function private.generate_board_letters(bigint, jsonb)
  from public, anon, authenticated;
revoke all on function private.finalize_completed_lobby(uuid)
  from public, anon, authenticated;

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

  normalized_ruleset := private.validate_game_ruleset(
    p_ruleset,
    p_max_players
  );

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
        clock_timestamp(),
        p_max_players::smallint,
        normalized_ruleset;
      return;
    exception
      when unique_violation then
        -- The nested block is a subtransaction, so a rare room-code
        -- collision rolls back both inserts before another code is tried.
        null;
    end;
  end loop;

  raise exception 'A unique room code could not be generated. Try again.';
end;
$$;

-- Return type changed to include lobby capacity/rules, so drop/recreate the
-- original function explicitly rather than relying on CREATE OR REPLACE.
drop function public.join_private_match(text);

create function public.join_private_match(p_room_code text)
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

  if not found
    or locked_match.created_at < clock_timestamp() - interval '2 hours' then
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

  select count(*)::integer
  into player_count
  from public.match_players as existing_player
  where existing_player.match_id = locked_match.id;

  if player_count >= locked_match.max_players then
    raise exception 'That private lobby is full.';
  end if;

  select candidate.player_number
  into available_number
  from generate_series(2, locked_match.max_players) as candidate(player_number)
  where not exists (
    select 1
    from public.match_players as existing_player
    where existing_player.match_id = locked_match.id
      and existing_player.player_number = candidate.player_number
  )
  order by candidate.player_number
  limit 1;

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
  values (locked_match.id, current_user_id, available_number);

  return query
  select
    locked_match.id,
    locked_match.room_code,
    locked_match.status,
    locked_match.board_seed,
    locked_match.round_duration_seconds,
    locked_match.scheduled_start_at,
    clock_timestamp(),
    locked_match.max_players,
    locked_match.ruleset;
end;
$$;

create or replace function public.start_private_match(p_match_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  locked_match public.matches%rowtype;
  participant_count integer;
  start_time timestamptz;
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
    raise exception 'Only the lobby host can start this match.';
  end if;

  if locked_match.status <> 'waiting'
    or locked_match.scheduled_start_at is not null then
    raise exception 'That lobby can no longer be started.';
  end if;

  select count(*)::integer
  into participant_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if participant_count < 2 then
    raise exception 'At least two players are required to start.';
  end if;

  start_time := clock_timestamp() + interval '5 seconds';
  update public.matches as match_row
  set
    status = 'starting',
    scheduled_start_at = start_time
  where match_row.id = p_match_id;

  return start_time;
end;
$$;

create or replace function public.update_private_match_rules(
  p_match_id uuid,
  p_ruleset jsonb,
  p_max_players integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  locked_match public.matches%rowtype;
  participant_count integer;
  normalized_ruleset jsonb;
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
    raise exception 'Only the lobby host can change its rules.';
  end if;

  if locked_match.status <> 'waiting'
    or locked_match.scheduled_start_at is not null then
    raise exception 'Lobby rules are immutable after countdown starts.';
  end if;

  select count(*)::integer
  into participant_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if p_max_players < participant_count then
    raise exception 'Maximum players cannot be lower than the current lobby size.';
  end if;

  normalized_ruleset := private.validate_game_ruleset(
    p_ruleset,
    p_max_players
  );

  update public.matches as match_row
  set
    max_players = p_max_players,
    ruleset = normalized_ruleset,
    round_duration_seconds =
      (normalized_ruleset ->> 'roundDurationSeconds')::integer,
    dictionary_version = normalized_ruleset ->> 'dictionaryVersion',
    board_generation_version =
      normalized_ruleset ->> 'boardGenerationVersion',
    ruleset_version = normalized_ruleset ->> 'version'
  where match_row.id = p_match_id;

  return normalized_ruleset;
end;
$$;

create or replace function public.leave_private_match(p_match_id uuid)
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

  if not found or locked_match.status <> 'waiting' then
    raise exception 'Players may leave only while the lobby is waiting.';
  end if;

  if locked_match.host_user_id = current_user_id then
    raise exception 'The host must cancel the lobby instead.';
  end if;

  delete from public.match_players as player
  where player.match_id = p_match_id
    and player.player_user_id = current_user_id;

  if not found then
    raise exception 'You are not a participant in this lobby.';
  end if;

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
  rules jsonb;
  board_letters text[];
  active_mask jsonb;
  board_rows integer;
  board_columns integer;
  minimum_word_length integer;
  maximum_path_length integer;
  claimed_word text;
  generated_word text;
  tile_key text;
  seen_tiles text[];
  seen_words text[] := array[]::text[];
  row_number integer;
  column_number integer;
  cell_index integer;
  previous_row integer;
  previous_column integer;
  path_length integer;
  word_score integer;
  total_score integer := 0;
  validated_word_list jsonb := '[]'::jsonb;
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

  -- Idempotency boundary: the first validated result is immutable.
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
    or jsonb_typeof(p_submissions) <> 'array'
    or jsonb_array_length(p_submissions) > 256 then
    raise exception 'Submitted words must be a bounded JSON array.';
  end if;

  rules := locked_match.ruleset;
  board_rows := (rules ->> 'rows')::integer;
  board_columns := (rules ->> 'columns')::integer;
  active_mask := rules -> 'activeCells';
  minimum_word_length := (rules ->> 'minimumWordLength')::integer;
  select count(*)::integer
  into maximum_path_length
  from jsonb_array_elements(active_mask) as cell(value)
  where cell.value = 'true'::jsonb;
  board_letters := private.generate_board_letters(
    locked_match.board_seed,
    rules
  );

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
    if path_length < 1 or path_length > maximum_path_length then
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
      if row_number not between 0 and board_rows - 1
        or column_number not between 0 and board_columns - 1 then
        raise exception 'A tile coordinate is outside the board.';
      end if;

      cell_index := row_number * board_columns + column_number;
      if (active_mask -> cell_index) <> 'true'::jsonb then
        raise exception 'A tile coordinate is inactive.';
      end if;

      tile_key := row_number::text || ':' || column_number::text;
      if tile_key = any(seen_tiles) then
        raise exception 'A tile was repeated within one word.';
      end if;

      if previous_row is not null
        and greatest(
          abs(row_number - previous_row),
          abs(column_number - previous_column)
        ) <> 1 then
        raise exception 'Consecutive tiles are not adjacent.';
      end if;

      seen_tiles := array_append(seen_tiles, tile_key);
      generated_word := generated_word || board_letters[cell_index + 1];
      previous_row := row_number;
      previous_column := column_number;
    end loop;

    if generated_word <> claimed_word then
      raise exception 'A claimed word does not match its tile path.';
    end if;

    if char_length(generated_word) < minimum_word_length then
      raise exception 'A submitted word is shorter than the ruleset minimum.';
    end if;

    if not exists (
      select 1
      from private.approved_words as dictionary
      where dictionary.dictionary_version = locked_match.dictionary_version
        and dictionary.word = lower(generated_word)
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
      jsonb_build_object('word', generated_word, 'score', word_score)
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

  did_complete := private.finalize_completed_lobby(p_match_id);
  return query select total_score, false, did_complete;
end;
$$;

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

  select count(*) filter (where player.finished_at is not null)::integer
  into finished_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if finished_count = 0 then
    update public.matches as match_row
    set
      status = 'cancelled',
      scheduled_start_at = null
    where match_row.id = p_match_id;
    return true;
  end if;

  update public.match_players as player
  set
    finished_at = clock_timestamp(),
    validated_score = 0,
    validated_words = '[]'::jsonb,
    result_status = 'forfeit'
  where player.match_id = p_match_id
    and player.finished_at is null;

  return private.finalize_completed_lobby(p_match_id);
end;
$$;

comment on function public.create_private_lobby(jsonb, integer) is
  'Atomically creates a private 2-12 player lobby from a server-normalized ruleset and retries room-code collisions.';
comment on function public.join_private_match(text) is
  'Locks the match row before capacity checks and insertion, so concurrent joins cannot exceed max_players.';
comment on function public.start_private_match(uuid) is
  'Host-only atomic start. Stores one database-scheduled timestamp after at least two participants have joined.';
comment on function public.submit_match_result(uuid, jsonb) is
  'Security boundary: derives auth.uid(), locks result state, regenerates the versioned masked board, validates paths/dictionary/timing/duplicates, recomputes score, and finalizes all players atomically.';

revoke all on function public.create_private_lobby(jsonb, integer)
  from public, anon;
revoke all on function public.join_private_match(text)
  from public, anon;
revoke all on function public.start_private_match(uuid)
  from public, anon;
revoke all on function public.update_private_match_rules(uuid, jsonb, integer)
  from public, anon;
revoke all on function public.leave_private_match(uuid)
  from public, anon;

grant execute on function public.create_private_lobby(jsonb, integer)
  to authenticated;
grant execute on function public.join_private_match(text)
  to authenticated;
grant execute on function public.start_private_match(uuid)
  to authenticated;
grant execute on function public.update_private_match_rules(
  uuid,
  jsonb,
  integer
) to authenticated;
grant execute on function public.leave_private_match(uuid)
  to authenticated;

commit;
