begin;

alter table public.matches
  add column abandoned_at timestamptz;

alter table public.match_players
  add column connection_status text not null default 'connected',
  add column last_connected_at timestamptz not null
    default pg_catalog.clock_timestamp(),
  add column disconnect_deadline_at timestamptz,
  add column explicitly_left_at timestamptz,
  add column departed_at timestamptz,
  add constraint match_players_connection_status check (
    connection_status in ('connected', 'disconnected', 'left', 'forfeited')
  ),
  add constraint match_players_connection_state check (
    (
      connection_status = 'connected'
      and disconnect_deadline_at is null
      and departed_at is null
    )
    or
    (
      connection_status = 'disconnected'
      and disconnect_deadline_at is not null
      and departed_at is null
    )
    or
    (
      connection_status in ('left', 'forfeited')
      and disconnect_deadline_at is null
      and departed_at is not null
    )
  ),
  add constraint match_players_explicit_leave_state check (
    explicitly_left_at is null
    or (
      connection_status in ('left', 'forfeited')
      and departed_at is not null
    )
  );

create index match_players_presence_cleanup_idx
  on public.match_players (
    connection_status,
    disconnect_deadline_at,
    last_connected_at
  )
  where finished_at is null;

comment on column public.matches.abandoned_at is
  'Authoritative timestamp for a cancelled round whose participants all left or exceeded the reconnect grace period.';
comment on column public.match_players.connection_status is
  'Durable participant presence state. Realtime only prompts refetches; server timestamps decide departures and forfeits.';
comment on column public.match_players.last_connected_at is
  'Rate-limited authenticated gameplay heartbeat used with the scheduled start and reconnect grace window.';
comment on column public.match_players.disconnect_deadline_at is
  'Database-authored deadline after which an unfinished disconnected participant is finalized as departed.';
comment on column public.match_players.explicitly_left_at is
  'Set only by the authenticated participant explicit-exit RPC; browser disconnects cannot impersonate another player.';

create or replace function private.generate_shape_mask(
  p_rows integer,
  p_columns integer,
  p_shape text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  center_row numeric;
  center_column numeric;
  normalized_row_distance numeric;
  normalized_column_distance numeric;
  edge_allowance numeric;
  generated_mask jsonb := '[]'::jsonb;
  active_count integer := 0;
  cell_index integer;
  cell_row integer;
  cell_column integer;
  cell_active boolean;
begin
  if p_rows not between 3 and 10
    or p_columns not between 3 and 10 then
    raise exception 'Board rows and columns must be from 3 through 10.';
  end if;
  if p_shape not in ('rectangle', 'diamond', 'cross') then
    raise exception 'Only generated board shapes have canonical masks.';
  end if;

  center_row := (p_rows - 1)::numeric / 2;
  center_column := (p_columns - 1)::numeric / 2;
  edge_allowance := greatest(
    1::numeric / greatest(p_rows - 1, 1),
    1::numeric / greatest(p_columns - 1, 1)
  );

  for cell_index in 0..(p_rows * p_columns - 1) loop
    cell_row := cell_index / p_columns;
    cell_column := mod(cell_index, p_columns);

    if p_shape = 'rectangle' then
      cell_active := true;
    elsif p_shape = 'cross' then
      cell_active :=
        pg_catalog.abs(cell_row - center_row) <= 0.5
        or pg_catalog.abs(cell_column - center_column) <= 0.5;
    else
      normalized_row_distance :=
        pg_catalog.abs(cell_row - center_row) / greatest(center_row, 0.5);
      normalized_column_distance :=
        pg_catalog.abs(cell_column - center_column)
        / greatest(center_column, 0.5);
      cell_active :=
        normalized_row_distance + normalized_column_distance
        <= 1 + edge_allowance;
    end if;

    if cell_active then
      active_count := active_count + 1;
    end if;
    generated_mask :=
      generated_mask || pg_catalog.jsonb_build_array(cell_active);
  end loop;

  if active_count < 9 then
    return (
      select pg_catalog.jsonb_agg(true order by generated.index)
      from pg_catalog.generate_series(
        0,
        p_rows * p_columns - 1
      ) as generated(index)
    );
  end if;

  return generated_mask;
end;
$$;

revoke all on function private.generate_shape_mask(integer, integer, text)
  from public, anon, authenticated;

comment on function private.generate_shape_mask(integer, integer, text) is
  'Generates the canonical 3-10 rectangle, cross, or normalized diamond mask used to reject client-supplied shape mismatches.';

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
  board_shape text;
begin
  if p_max_players not between 2 and 12 then
    raise exception 'Maximum players must be from 2 through 12.';
  end if;

  if p_ruleset is null or pg_catalog.jsonb_typeof(p_ruleset) <> 'object' then
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
  board_shape := p_ruleset ->> 'shape';

  if board_rows not between 3 and 10
    or board_columns not between 3 and 10 then
    raise exception 'Board rows and columns must be from 3 through 10.';
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
    or coalesce(board_shape, '')
      not in ('rectangle', 'diamond', 'cross', 'custom') then
    raise exception 'The ruleset contains an unsupported version or shape.';
  end if;

  if pg_catalog.jsonb_typeof(active_mask) is distinct from 'array' then
    raise exception 'The active-cell mask is malformed.';
  end if;

  if pg_catalog.jsonb_array_length(active_mask) <> board_rows * board_columns
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(active_mask) as cell(value)
      where pg_catalog.jsonb_typeof(cell.value) <> 'boolean'
    ) then
    raise exception 'The active-cell mask is malformed.';
  end if;

  if board_shape <> 'custom'
    and active_mask
      <> private.generate_shape_mask(board_rows, board_columns, board_shape) then
    raise exception 'The active-cell mask does not match the selected shape.';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(cell.ordinality - 1)::integer
  into active_count, first_active
  from pg_catalog.jsonb_array_elements(active_mask)
    with ordinality as cell(value, ordinality)
  where cell.value = 'true'::jsonb;

  if active_count < 9 then
    raise exception 'A board needs at least 9 active cells.';
  end if;

  queue := array[first_active];
  visited := array[first_active];

  while coalesce(pg_catalog.array_length(queue, 1), 0) > 0 loop
    current_index := queue[1];
    queue := pg_catalog.array_remove(queue, current_index);
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
          visited := pg_catalog.array_append(visited, neighbor_index);
          queue := pg_catalog.array_append(queue, neighbor_index);
        end if;
      end loop;
    end loop;
  end loop;

  if pg_catalog.array_length(visited, 1) <> active_count then
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

  normalized := pg_catalog.jsonb_build_object(
    'version', '2',
    'rows', board_rows,
    'columns', board_columns,
    'activeCells', active_mask,
    'shape', board_shape,
    'roundDurationSeconds', duration_seconds,
    'minimumWordLength', minimum_word_length,
    'dictionaryVersion', 'enable2k-af52415-v1',
    'scoringRulesVersion', 'classic-v1',
    'boardGenerationVersion', p_ruleset ->> 'boardGenerationVersion'
  );

  return normalized;
end;
$$;

revoke all on function private.validate_game_ruleset(jsonb, integer)
  from public, anon, authenticated;

comment on function private.validate_game_ruleset(jsonb, integer) is
  'Independently validates 3-10 dimensions, immutable versions, connectivity, and exact server-generated masks before accepting private or solo rules.';

create or replace function private.mode_display_label(
  p_category text,
  p_ruleset jsonb
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  normalized_category text :=
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_category, '')));
  normalized_shape text :=
    pg_catalog.lower(
      pg_catalog.btrim(coalesce(p_ruleset ->> 'shape', 'custom'))
    );
  rows_count integer := (p_ruleset ->> 'rows')::integer;
  columns_count integer := (p_ruleset ->> 'columns')::integer;
  duration_seconds integer :=
    (p_ruleset ->> 'roundDurationSeconds')::integer;
begin
  if normalized_category not in ('solo', 'ranked', 'private')
    or normalized_shape not in ('rectangle', 'diamond', 'cross', 'custom')
    or rows_count not between 3 and 10
    or columns_count not between 3 and 10
    or duration_seconds not between 30 and 180 then
    raise exception 'A validated ruleset is required for a mode label.';
  end if;

  return
    case normalized_category
      when 'solo' then 'Single Player'
      when 'ranked' then 'Ranked'
      else 'Private'
    end
    || ' · '
    || rows_count::text
    || '×'
    || columns_count::text
    || ' '
    || pg_catalog.initcap(normalized_shape)
    || ' · '
    || duration_seconds::text
    || ' seconds';
end;
$$;

revoke all on function private.mode_display_label(text, jsonb)
  from public, anon, authenticated;

comment on function private.mode_display_label(text, jsonb) is
  'Builds bounded public labels from already-validated 3-10 mode snapshots without exposing account identifiers.';

create or replace function private.cancel_abandoned_match(
  p_match_id uuid,
  p_database_now timestamptz
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  match_mode public.match_mode;
begin
  select match_row.mode
  into match_mode
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found then
    return;
  end if;

  update public.match_players as player
  set
    finished_at = coalesce(player.finished_at, p_database_now),
    validated_score = coalesce(player.validated_score, 0),
    validated_words = coalesce(player.validated_words, '[]'::jsonb),
    result_status = 'forfeit',
    connection_status = case
      when match_mode = 'ranked' then 'forfeited'
      else 'left'
    end,
    disconnect_deadline_at = null,
    departed_at = coalesce(player.departed_at, p_database_now)
  where player.match_id = p_match_id;

  update public.matches as match_row
  set
    status = 'cancelled',
    scheduled_start_at = null,
    completed_at = null,
    winner_id = null,
    is_tie = false,
    preview_started_at = null,
    preview_ends_at = null,
    abandoned_at = coalesce(match_row.abandoned_at, p_database_now),
    rating_status = case
      when match_row.mode = 'ranked'
        then 'abandoned'::public.ranked_rating_status
      else match_row.rating_status
    end,
    rating_applied_at = case
      when match_row.mode = 'ranked' then null
      else match_row.rating_applied_at
    end
  where match_row.id = p_match_id
    and match_row.status in ('starting', 'active');

  if match_mode = 'ranked' then
    update public.ranked_queue as queue
    set status = 'cancelled'
    where queue.match_id = p_match_id
      and queue.status = 'matched';
  end if;
end;
$$;

revoke all on function private.cancel_abandoned_match(uuid, timestamptz)
  from public, anon, authenticated;

comment on function private.cancel_abandoned_match(uuid, timestamptz) is
  'Cancels a fully departed match without fabricating a winner or applying ranked rating changes.';

create or replace function private.finalize_ranked_forfeit(
  p_match_id uuid,
  p_forfeiting_user_id uuid,
  p_explicit boolean,
  p_database_now timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  locked_match public.matches%rowtype;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or locked_match.mode <> 'ranked' then
    return false;
  end if;
  if locked_match.status in ('completed', 'cancelled') then
    return true;
  end if;
  if locked_match.status not in ('starting', 'active')
    or not exists (
      select 1
      from public.match_players as player
      where player.match_id = p_match_id
        and player.player_user_id = p_forfeiting_user_id
    ) then
    return false;
  end if;

  update public.match_players as player
  set
    finished_at = coalesce(player.finished_at, p_database_now),
    validated_score = coalesce(player.validated_score, 0),
    validated_words = coalesce(player.validated_words, '[]'::jsonb),
    result_status = 'forfeit',
    connection_status = 'forfeited',
    disconnect_deadline_at = null,
    explicitly_left_at = case
      when p_explicit
        then coalesce(player.explicitly_left_at, p_database_now)
      else player.explicitly_left_at
    end,
    departed_at = coalesce(player.departed_at, p_database_now)
  where player.match_id = p_match_id
    and player.player_user_id = p_forfeiting_user_id;

  update public.match_players as player
  set
    finished_at = coalesce(player.finished_at, p_database_now),
    validated_score = coalesce(player.validated_score, 0),
    validated_words = coalesce(player.validated_words, '[]'::jsonb)
  where player.match_id = p_match_id
    and player.player_user_id <> p_forfeiting_user_id;

  if not private.finalize_completed_lobby(p_match_id) then
    raise exception 'The ranked forfeit could not be finalized.';
  end if;

  return true;
end;
$$;

revoke all on function private.finalize_ranked_forfeit(
  uuid,
  uuid,
  boolean,
  timestamptz
) from public, anon, authenticated;

comment on function private.finalize_ranked_forfeit(
  uuid,
  uuid,
  boolean,
  timestamptz
) is
  'Finalizes one locked ranked participant forfeit and applies the existing idempotent Elo finalizer exactly once.';

create or replace function private.finalize_or_abandon_private_match(
  p_match_id uuid,
  p_database_now timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  unfinished_count integer;
  eligible_result_count integer;
begin
  select
    pg_catalog.count(*) filter (
      where player.finished_at is null
    )::integer,
    pg_catalog.count(*) filter (
      where player.finished_at is not null
        and player.result_status <> 'forfeit'
    )::integer
  into unfinished_count, eligible_result_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if unfinished_count > 0 then
    return false;
  end if;
  if eligible_result_count = 0 then
    perform private.cancel_abandoned_match(p_match_id, p_database_now);
    return true;
  end if;

  return private.finalize_completed_lobby(p_match_id);
end;
$$;

revoke all on function private.finalize_or_abandon_private_match(
  uuid,
  timestamptz
) from public, anon, authenticated;

comment on function private.finalize_or_abandon_private_match(
  uuid,
  timestamptz
) is
  'Keeps private matches alive for remaining players, finalizes submitted results, and abandons only an all-departed lobby.';

create or replace function private.reconcile_match_lifecycle(
  p_match_id uuid,
  p_database_now timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  locked_match public.matches%rowtype;
  expired_count integer;
  unfinished_count integer;
  eligible_result_count integer;
  expired_ranked_user_id uuid;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found then
    return false;
  end if;
  if locked_match.status in ('completed', 'cancelled') then
    return true;
  end if;
  if locked_match.mode = 'solo'
    or locked_match.status not in ('starting', 'active') then
    return false;
  end if;

  select
    pg_catalog.count(*) filter (
      where player.finished_at is null
        and (
          (
            player.connection_status = 'disconnected'
            and player.disconnect_deadline_at <= p_database_now
          )
          or
          (
            player.connection_status = 'connected'
            and p_database_now >= greatest(
              player.last_connected_at,
              coalesce(
                locked_match.scheduled_start_at,
                player.last_connected_at
              )
            ) + interval '15 seconds'
          )
        )
    )::integer,
    pg_catalog.count(*) filter (
      where player.finished_at is null
    )::integer,
    pg_catalog.count(*) filter (
      where player.finished_at is not null
        and player.result_status <> 'forfeit'
    )::integer
  into expired_count, unfinished_count, eligible_result_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if expired_count = 0 then
    return false;
  end if;

  if locked_match.mode = 'ranked' then
    if expired_count = unfinished_count
      and eligible_result_count = 0 then
      perform private.cancel_abandoned_match(p_match_id, p_database_now);
      return true;
    end if;

    select player.player_user_id
    into expired_ranked_user_id
    from public.match_players as player
    where player.match_id = p_match_id
      and player.finished_at is null
      and (
        (
          player.connection_status = 'disconnected'
          and player.disconnect_deadline_at <= p_database_now
        )
        or
        (
          player.connection_status = 'connected'
          and p_database_now >= greatest(
            player.last_connected_at,
            coalesce(
              locked_match.scheduled_start_at,
              player.last_connected_at
            )
          ) + interval '15 seconds'
        )
      )
    order by player.player_number
    limit 1;

    return private.finalize_ranked_forfeit(
      p_match_id,
      expired_ranked_user_id,
      false,
      p_database_now
    );
  end if;

  update public.match_players as player
  set
    finished_at = p_database_now,
    validated_score = 0,
    validated_words = '[]'::jsonb,
    result_status = 'forfeit',
    connection_status = 'left',
    disconnect_deadline_at = null,
    departed_at = p_database_now
  where player.match_id = p_match_id
    and player.finished_at is null
    and (
      (
        player.connection_status = 'disconnected'
        and player.disconnect_deadline_at <= p_database_now
      )
      or
      (
        player.connection_status = 'connected'
        and p_database_now >= greatest(
          player.last_connected_at,
          coalesce(
            locked_match.scheduled_start_at,
            player.last_connected_at
          )
        ) + interval '15 seconds'
      )
    );

  return private.finalize_or_abandon_private_match(
    p_match_id,
    p_database_now
  );
end;
$$;

revoke all on function private.reconcile_match_lifecycle(uuid, timestamptz)
  from public, anon, authenticated;

comment on function private.reconcile_match_lifecycle(uuid, timestamptz) is
  'Uses database timestamps under the match-row lock to restore within 15 seconds, forfeit expired ranked players, and remove only expired private participants.';

create or replace function public.heartbeat_match_presence(p_match_id uuid)
returns table (
  match_status public.match_status,
  participant_status text,
  disconnect_deadline_at timestamptz,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  locked_match public.matches%rowtype;
  player public.match_players%rowtype;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  join public.match_players as caller
    on caller.match_id = match_row.id
  where match_row.id = p_match_id
    and caller.player_user_id = current_user_id
  for update of match_row;

  select participant.*
  into player
  from public.match_players as participant
  where participant.match_id = p_match_id
    and participant.player_user_id = current_user_id;

  if not found or locked_match.id is null then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;

  if locked_match.status in ('starting', 'active')
    and locked_match.mode <> 'solo' then
    perform private.reconcile_match_lifecycle(p_match_id, database_now);

    update public.match_players as participant
    set
      connection_status = 'connected',
      last_connected_at = database_now,
      disconnect_deadline_at = null
    from public.matches as match_row
    where participant.match_id = p_match_id
      and participant.player_user_id = current_user_id
      and participant.finished_at is null
      and participant.connection_status in ('connected', 'disconnected')
      and match_row.id = participant.match_id
      and match_row.status in ('starting', 'active');
  end if;

  return query
  select
    match_row.status,
    participant.connection_status,
    participant.disconnect_deadline_at,
    database_now
  from public.matches as match_row
  join public.match_players as participant
    on participant.match_id = match_row.id
  where match_row.id = p_match_id
    and participant.player_user_id = current_user_id;
end;
$$;

revoke all on function public.heartbeat_match_presence(uuid)
  from public, anon, authenticated;
grant execute on function public.heartbeat_match_presence(uuid)
  to authenticated;

comment on function public.heartbeat_match_presence(uuid) is
  'Rate-limited client heartbeat that derives the participant from auth.uid(), reconciles expired state first, and restores only an unfinished player still inside the 15-second grace period.';

create or replace function public.report_match_disconnect(p_match_id uuid)
returns table (
  match_status public.match_status,
  participant_status text,
  disconnect_deadline_at timestamptz,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  locked_match public.matches%rowtype;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  join public.match_players as player on player.match_id = match_row.id
  where match_row.id = p_match_id
    and player.player_user_id = current_user_id
  for update of match_row;

  if not found then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;

  if locked_match.status in ('starting', 'active')
    and locked_match.mode <> 'solo' then
    update public.match_players as player
    set
      connection_status = 'disconnected',
      disconnect_deadline_at = coalesce(
        player.disconnect_deadline_at,
        database_now + interval '15 seconds'
      )
    where player.match_id = p_match_id
      and player.player_user_id = current_user_id
      and player.finished_at is null
      and player.connection_status in ('connected', 'disconnected');
  end if;

  return query
  select
    match_row.status,
    player.connection_status,
    player.disconnect_deadline_at,
    database_now
  from public.matches as match_row
  join public.match_players as player on player.match_id = match_row.id
  where match_row.id = p_match_id
    and player.player_user_id = current_user_id;
end;
$$;

revoke all on function public.report_match_disconnect(uuid)
  from public, anon, authenticated;
grant execute on function public.report_match_disconnect(uuid)
  to authenticated;

comment on function public.report_match_disconnect(uuid) is
  'Marks only auth.uid() temporarily disconnected and creates one non-extendable 15-second database deadline without declaring a winner.';

create or replace function public.reconcile_match_presence(p_match_id uuid)
returns table (
  match_status public.match_status,
  participant_status text,
  disconnect_deadline_at timestamptz,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  if not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;

  perform private.reconcile_match_lifecycle(p_match_id, database_now);

  return query
  select
    match_row.status,
    player.connection_status,
    player.disconnect_deadline_at,
    database_now
  from public.matches as match_row
  join public.match_players as player on player.match_id = match_row.id
  where match_row.id = p_match_id
    and player.player_user_id = current_user_id;
end;
$$;

revoke all on function public.reconcile_match_presence(uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_match_presence(uuid)
  to authenticated;

comment on function public.reconcile_match_presence(uuid) is
  'Lets an authenticated participant request authoritative cleanup while database timestamps—not Realtime or client claims—decide outcomes.';

create or replace function public.exit_current_match(p_match_id uuid)
returns table (
  match_status public.match_status,
  participant_status text,
  outcome text,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  locked_match public.matches%rowtype;
  current_participant public.match_players%rowtype;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  join public.match_players as player on player.match_id = match_row.id
  where match_row.id = p_match_id
    and player.player_user_id = current_user_id
  for update of match_row;

  if not found then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;

  if locked_match.status in ('completed', 'cancelled') then
    return query
    select
      locked_match.status,
      player.connection_status,
      'already_finalized'::text,
      database_now
    from public.match_players as player
    where player.match_id = p_match_id
      and player.player_user_id = current_user_id;
    return;
  end if;

  if locked_match.status not in ('starting', 'active') then
    raise exception 'This match is not in an active round.';
  end if;

  if locked_match.mode = 'solo' then
    if locked_match.host_user_id <> current_user_id then
      raise exception 'This solo round is unavailable.'
        using errcode = '42501';
    end if;

    update public.matches as match_row
    set
      status = 'cancelled',
      scheduled_start_at = null,
      preview_started_at = null,
      preview_ends_at = null,
      abandoned_at = coalesce(match_row.abandoned_at, database_now)
    where match_row.id = p_match_id;

    update public.match_players as player
    set
      connection_status = 'left',
      disconnect_deadline_at = null,
      explicitly_left_at = coalesce(
        player.explicitly_left_at,
        database_now
      ),
      departed_at = coalesce(player.departed_at, database_now)
    where player.match_id = p_match_id
      and player.player_user_id = current_user_id;
  elsif locked_match.mode = 'ranked' then
    perform private.finalize_ranked_forfeit(
      p_match_id,
      current_user_id,
      true,
      database_now
    );
  else
    update public.match_players as player
    set
      finished_at = coalesce(player.finished_at, database_now),
      validated_score = coalesce(player.validated_score, 0),
      validated_words = coalesce(player.validated_words, '[]'::jsonb),
      result_status = 'forfeit',
      connection_status = 'left',
      disconnect_deadline_at = null,
      explicitly_left_at = coalesce(
        player.explicitly_left_at,
        database_now
      ),
      departed_at = coalesce(player.departed_at, database_now)
    where player.match_id = p_match_id
      and player.player_user_id = current_user_id;

    perform private.finalize_or_abandon_private_match(
      p_match_id,
      database_now
    );
  end if;

  select player.*
  into current_participant
  from public.match_players as player
  where player.match_id = p_match_id
    and player.player_user_id = current_user_id;

  return query
  select
    match_row.status,
    current_participant.connection_status,
    case
      when locked_match.mode = 'ranked' then 'forfeited'
      when locked_match.mode = 'private' then 'left'
      else 'abandoned'
    end,
    database_now
  from public.matches as match_row
  where match_row.id = p_match_id;
end;
$$;

revoke all on function public.exit_current_match(uuid)
  from public, anon, authenticated;
grant execute on function public.exit_current_match(uuid)
  to authenticated;

comment on function public.exit_current_match(uuid) is
  'Derives the exiting participant from auth.uid(): solo cancels without score, ranked forfeits and rates once, and private removes only that participant.';

create or replace function public.abandon_solo_session(p_match_id uuid)
returns table (
  match_id uuid,
  round_status text,
  abandoned boolean,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  locked_match public.matches%rowtype;
begin
  if p_match_id is null then
    raise exception 'This solo round is unavailable.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('solo-session:' || current_user_id::text, 0)
  );

  select match_row.*
  into locked_match
  from public.matches as match_row
  join public.match_players as player on player.match_id = match_row.id
  where match_row.id = p_match_id
    and match_row.host_user_id = current_user_id
    and player.player_user_id = current_user_id
  for update of match_row;

  if not found or locked_match.mode <> 'solo' then
    raise exception 'This solo round is unavailable.';
  end if;
  if locked_match.status = 'completed' then
    raise exception 'This round was already completed.';
  end if;
  if locked_match.status = 'cancelled' then
    return query
    select locked_match.id, 'cancelled'::text, false, database_now;
    return;
  end if;
  if locked_match.status not in ('starting', 'active') then
    raise exception 'This solo round cannot be abandoned.';
  end if;

  update public.matches as match_row
  set
    status = 'cancelled',
    scheduled_start_at = null,
    preview_started_at = null,
    preview_ends_at = null,
    abandoned_at = coalesce(match_row.abandoned_at, database_now)
  where match_row.id = locked_match.id
    and match_row.status in ('starting', 'active');

  update public.match_players as player
  set
    connection_status = 'left',
    disconnect_deadline_at = null,
    explicitly_left_at = coalesce(
      player.explicitly_left_at,
      database_now
    ),
    departed_at = coalesce(player.departed_at, database_now)
  where player.match_id = locked_match.id
    and player.player_user_id = current_user_id;

  return query
  select locked_match.id, 'cancelled'::text, true, database_now;
end;
$$;

revoke all on function public.abandon_solo_session(uuid)
  from public, anon, authenticated;
grant execute on function public.abandon_solo_session(uuid)
  to authenticated;

comment on function public.abandon_solo_session(uuid) is
  'Idempotently cancels only auth.uid() unfinished solo round, records intentional departure, and never submits partial words or mode statistics.';

create or replace function private.has_active_match(p_user_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  candidate_match_id uuid;
begin
  for candidate_match_id in
    select match_row.id
    from public.matches as match_row
    join public.match_players as player on player.match_id = match_row.id
    where player.player_user_id = p_user_id
      and player.finished_at is null
      and player.connection_status in ('connected', 'disconnected')
      and match_row.status in ('starting', 'active')
      and match_row.mode <> 'solo'
    order by match_row.created_at, match_row.id
  loop
    perform private.reconcile_match_lifecycle(
      candidate_match_id,
      pg_catalog.clock_timestamp()
    );
  end loop;

  return exists (
    select 1
    from public.match_players as player
    join public.matches as match_row on match_row.id = player.match_id
    where player.player_user_id = p_user_id
      and player.finished_at is null
      and player.connection_status in ('connected', 'disconnected')
      and match_row.status in ('starting', 'active')
  );
end;
$$;

revoke all on function private.has_active_match(uuid)
  from public, anon, authenticated;

comment on function private.has_active_match(uuid) is
  'Reconciles stale database presence before preventing auth.uid() from entering a second active multiplayer match.';

create or replace function private.cleanup_stale_match_lifecycle()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  database_now timestamptz := pg_catalog.clock_timestamp();
  candidate_match_id uuid;
  cleaned_count integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'Presence cleanup is restricted to the scheduler.'
      using errcode = '42501';
  end if;

  for candidate_match_id in
    select match_row.id
    from public.matches as match_row
    where match_row.status in ('starting', 'active')
      and match_row.mode in ('private', 'ranked')
      and exists (
        select 1
        from public.match_players as player
        where player.match_id = match_row.id
          and player.finished_at is null
          and (
            (
              player.connection_status = 'disconnected'
              and player.disconnect_deadline_at <= database_now
            )
            or
            (
              player.connection_status = 'connected'
              and database_now >= greatest(
                player.last_connected_at,
                coalesce(
                  match_row.scheduled_start_at,
                  player.last_connected_at
                )
              ) + interval '15 seconds'
            )
          )
      )
    order by match_row.created_at, match_row.id
    for update skip locked
  loop
    if private.reconcile_match_lifecycle(
      candidate_match_id,
      database_now
    ) then
      cleaned_count := cleaned_count + 1;
    end if;
  end loop;

  return cleaned_count;
end;
$$;

revoke all on function private.cleanup_stale_match_lifecycle()
  from public, anon, authenticated;

comment on function private.cleanup_stale_match_lifecycle() is
  'Privileged bounded cleanup for fully disconnected multiplayer matches; every decision still comes from durable heartbeat and deadline timestamps.';

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'letter-rush-match-presence-cleanup',
  '15 seconds',
  'select private.cleanup_stale_match_lifecycle()'
);

create table public.two_player_rematch_proposals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  source_match_id uuid not null unique
    references public.matches (id) on delete cascade,
  requester_id uuid not null
    references public.profiles (id) on delete cascade,
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_match_id uuid unique
    references public.matches (id) on delete set null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  responded_at timestamptz,
  constraint two_player_rematch_status check (
    status in ('pending', 'accepted', 'declined', 'expired', 'cancelled')
  ),
  constraint two_player_rematch_state check (
    (
      status = 'pending'
      and responded_at is null
      and created_match_id is null
    )
    or
    (
      status = 'accepted'
      and responded_at is not null
      and created_match_id is not null
    )
    or
    (
      status in ('declined', 'expired', 'cancelled')
      and responded_at is not null
      and created_match_id is null
    )
  )
);

comment on table public.two_player_rematch_proposals is
  'One database-timed 15-second mutual-consent proposal per finalized ranked or two-participant private match; acceptance creates exactly one direct rematch.';

revoke all on function public.request_ranked_rematch(uuid)
  from public, anon, authenticated;
revoke all on function public.respond_ranked_rematch(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.get_ranked_rematch_state(uuid)
  from public, anon, authenticated;

create or replace function private.enforce_rematch_creation_path()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  source_participant_count integer;
begin
  if new.rematch_of is null
    or new.mode <> 'private'
    or new.status <> 'waiting' then
    return new;
  end if;

  select pg_catalog.count(*)::integer
  into source_participant_count
  from public.match_players as player
  where player.match_id = new.rematch_of;

  if source_participant_count = 2 then
    raise exception 'Two-player private rematches require mutual consent.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_rematch_creation_path()
  from public, anon, authenticated;

comment on function private.enforce_rematch_creation_path() is
  'Prevents the legacy invitation-lobby RPC from bypassing mutual consent for a two-participant private source while preserving group rematches.';

create trigger matches_enforce_rematch_creation_path
before insert on public.matches
for each row execute function private.enforce_rematch_creation_path();

alter table public.two_player_rematch_proposals enable row level security;

create policy two_player_rematch_participant_select
on public.two_player_rematch_proposals
for select
to authenticated
using (
  private.is_persistent_caller()
  and private.is_match_participant(source_match_id, (select auth.uid()))
);

revoke all on table public.two_player_rematch_proposals
  from public, anon, authenticated;
grant select on table public.two_player_rematch_proposals to authenticated;

create or replace function public.request_two_player_rematch(p_match_id uuid)
returns table (
  proposal_id uuid,
  proposal_status text,
  requested_by_me boolean,
  can_respond boolean,
  expires_at timestamptz,
  created_match_id uuid,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  locked_match public.matches%rowtype;
  proposal public.two_player_rematch_proposals%rowtype;
  participant_count integer;
begin
  if not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'Not a participant.'
      using errcode = '42501';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or locked_match.status <> 'completed' then
    raise exception 'Previous match not finalized.';
  end if;
  if locked_match.mode not in ('ranked', 'private') then
    raise exception 'This match does not support a two-player rematch.';
  end if;

  select pg_catalog.count(*)::integer
  into participant_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if participant_count <> 2 then
    raise exception 'This match uses the group lobby rematch flow.';
  end if;
  if private.has_active_match(current_user_id) then
    raise exception 'Player already in another match.';
  end if;
  if exists (
    select 1
    from public.matches as rematch
    where rematch.rematch_of = p_match_id
  ) then
    raise exception 'A rematch already exists for this match.';
  end if;

  insert into public.two_player_rematch_proposals (
    source_match_id,
    requester_id,
    expires_at
  )
  values (
    p_match_id,
    current_user_id,
    database_now + interval '15 seconds'
  )
  on conflict (source_match_id) do nothing;

  select candidate.*
  into proposal
  from public.two_player_rematch_proposals as candidate
  where candidate.source_match_id = p_match_id
  for update;

  if proposal.status = 'pending'
    and proposal.expires_at <= database_now then
    update public.two_player_rematch_proposals as candidate
    set
      status = 'expired',
      responded_at = database_now
    where candidate.id = proposal.id;
    proposal.status := 'expired';
    proposal.responded_at := database_now;
  end if;

  return query
  select
    proposal.id,
    proposal.status,
    proposal.requester_id = current_user_id,
    proposal.requester_id <> current_user_id
      and proposal.status = 'pending',
    proposal.expires_at,
    proposal.created_match_id,
    database_now;
end;
$$;

revoke all on function public.request_two_player_rematch(uuid)
  from public, anon, authenticated;
grant execute on function public.request_two_player_rematch(uuid)
  to authenticated;

comment on function public.request_two_player_rematch(uuid) is
  'Creates one 15-second request for auth.uid() after verifying a finalized eligible two-player source and no other active match.';

create or replace function public.get_two_player_rematch_state(
  p_match_id uuid
)
returns table (
  proposal_id uuid,
  proposal_status text,
  requested_by_me boolean,
  can_respond boolean,
  expires_at timestamptz,
  created_match_id uuid,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  if not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'Not a participant.'
      using errcode = '42501';
  end if;

  update public.two_player_rematch_proposals as proposal
  set
    status = 'expired',
    responded_at = database_now
  where proposal.source_match_id = p_match_id
    and proposal.status = 'pending'
    and proposal.expires_at <= database_now;

  return query
  select
    proposal.id,
    proposal.status,
    proposal.requester_id = current_user_id,
    proposal.requester_id <> current_user_id
      and proposal.status = 'pending',
    proposal.expires_at,
    proposal.created_match_id,
    database_now
  from public.two_player_rematch_proposals as proposal
  where proposal.source_match_id = p_match_id;
end;
$$;

revoke all on function public.get_two_player_rematch_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_two_player_rematch_state(uuid)
  to authenticated;

comment on function public.get_two_player_rematch_state(uuid) is
  'Returns only a source participant rematch state, expiring it against database time so refresh restores the same countdown.';

create or replace function public.cancel_two_player_rematch(
  p_proposal_id uuid
)
returns table (
  proposal_status text,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  proposal public.two_player_rematch_proposals%rowtype;
begin
  select candidate.*
  into proposal
  from public.two_player_rematch_proposals as candidate
  where candidate.id = p_proposal_id
    and private.is_match_participant(
      candidate.source_match_id,
      current_user_id
    )
  for update;

  if not found then
    raise exception 'Not a participant.'
      using errcode = '42501';
  end if;
  if proposal.requester_id <> current_user_id then
    raise exception 'Only the requester can cancel this rematch.'
      using errcode = '42501';
  end if;

  if proposal.status = 'pending' then
    update public.two_player_rematch_proposals as candidate
    set
      status = case
        when proposal.expires_at <= database_now then 'expired'
        else 'cancelled'
      end,
      responded_at = database_now
    where candidate.id = proposal.id
    returning candidate.status into proposal.status;
  end if;

  return query select proposal.status, database_now;
end;
$$;

revoke all on function public.cancel_two_player_rematch(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_two_player_rematch(uuid)
  to authenticated;

comment on function public.cancel_two_player_rematch(uuid) is
  'Allows only the auth.uid() requester to cancel a still-pending proposal; terminal proposals remain immutable and idempotent.';

create or replace function public.respond_two_player_rematch(
  p_proposal_id uuid,
  p_accept boolean
)
returns table (
  proposal_status text,
  match_id uuid,
  expires_at timestamptz,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  proposal public.two_player_rematch_proposals%rowtype;
  source_match public.matches%rowtype;
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  attempt integer;
begin
  select candidate.*
  into proposal
  from public.two_player_rematch_proposals as candidate
  where candidate.id = p_proposal_id
    and private.is_match_participant(
      candidate.source_match_id,
      current_user_id
    )
  for update;

  if not found then
    raise exception 'Not a participant.'
      using errcode = '42501';
  end if;
  if proposal.requester_id = current_user_id then
    raise exception 'The requester has already accepted this rematch.';
  end if;

  if proposal.status <> 'pending' then
    return query
    select
      proposal.status,
      proposal.created_match_id,
      proposal.expires_at,
      database_now;
    return;
  end if;

  if database_now >= proposal.expires_at then
    update public.two_player_rematch_proposals as candidate
    set
      status = 'expired',
      responded_at = database_now
    where candidate.id = proposal.id;

    return query
    select
      'expired'::text,
      null::uuid,
      proposal.expires_at,
      database_now;
    return;
  end if;

  if not p_accept then
    update public.two_player_rematch_proposals as candidate
    set
      status = 'declined',
      responded_at = database_now
    where candidate.id = proposal.id;

    return query
    select
      'declined'::text,
      null::uuid,
      proposal.expires_at,
      database_now;
    return;
  end if;

  select match_row.*
  into source_match
  from public.matches as match_row
  where match_row.id = proposal.source_match_id
  for update;

  if source_match.status <> 'completed' then
    raise exception 'Previous match not finalized.';
  end if;
  if private.has_active_match(proposal.requester_id)
    or private.has_active_match(current_user_id) then
    raise exception 'Player already in another match.';
  end if;

  generated_seed :=
    pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
  while generated_seed = source_match.board_seed loop
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
  end loop;

  if source_match.mode = 'ranked' then
    generated_match_id := pg_catalog.gen_random_uuid();
    insert into public.matches (
      id,
      room_code,
      status,
      host_user_id,
      board_seed,
      round_duration_seconds,
      scheduled_start_at,
      max_players,
      ruleset,
      dictionary_version,
      board_generation_version,
      ruleset_version,
      mode,
      mode_key,
      scoring_version,
      ranked_ruleset_version,
      rating_status,
      rematch_of
    )
    values (
      generated_match_id,
      null,
      'starting',
      null,
      generated_seed,
      60,
      database_now + interval '8 seconds',
      2,
      private.ranked_ruleset(),
      'enable2k-af52415-v1',
      'weighted-v2',
      '2',
      'ranked',
      private.mode_key('ranked', private.ranked_ruleset()),
      'classic-v1',
      'ranked-v1',
      'pending',
      source_match.id
    );
  elsif source_match.mode = 'private' then
    for attempt in 1..12 loop
      generated_match_id := pg_catalog.gen_random_uuid();
      generated_room_code := private.random_room_code();
      begin
        insert into public.matches (
          id,
          room_code,
          status,
          host_user_id,
          board_seed,
          round_duration_seconds,
          scheduled_start_at,
          max_players,
          ruleset,
          dictionary_version,
          board_generation_version,
          ruleset_version,
          mode,
          mode_key,
          scoring_version,
          ranked_ruleset_version,
          rating_status,
          rematch_of
        )
        values (
          generated_match_id,
          generated_room_code,
          'starting',
          proposal.requester_id,
          generated_seed,
          source_match.round_duration_seconds,
          database_now + interval '8 seconds',
          2,
          source_match.ruleset,
          source_match.dictionary_version,
          source_match.board_generation_version,
          source_match.ruleset_version,
          'private',
          source_match.mode_key,
          source_match.scoring_version,
          null,
          'not_applicable',
          source_match.id
        );
        exit;
      exception
        when unique_violation then
          if attempt = 12 then
            raise exception 'A unique private rematch could not be allocated.';
          end if;
      end;
    end loop;
  else
    raise exception 'This match uses the group lobby rematch flow.';
  end if;

  insert into public.match_players (
    match_id,
    player_user_id,
    player_number
  )
  values
    (generated_match_id, proposal.requester_id, 1),
    (generated_match_id, current_user_id, 2);

  update public.two_player_rematch_proposals as candidate
  set
    status = 'accepted',
    responded_at = database_now,
    created_match_id = generated_match_id
  where candidate.id = proposal.id;

  return query
  select
    'accepted'::text,
    generated_match_id,
    proposal.expires_at,
    database_now;
end;
$$;

revoke all on function public.respond_two_player_rematch(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.respond_two_player_rematch(uuid, boolean)
  to authenticated;

comment on function public.respond_two_player_rematch(uuid, boolean) is
  'Lets only the non-requesting auth.uid() participant answer before the database deadline; acceptance transaction-locks the proposal and creates one new seeded match with copied private or fixed ranked rules.';

do $add_rematch_realtime$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'two_player_rematch_proposals'
  ) then
    alter publication supabase_realtime
      add table public.two_player_rematch_proposals;
  end if;
end;
$add_rematch_realtime$;

commit;
