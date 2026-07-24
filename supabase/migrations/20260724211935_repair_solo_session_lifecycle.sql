-- Make solo startup resumable and provide an explicit, authenticated abandon
-- path. Existing completed/cancelled history remains immutable.

begin;

create or replace function public.create_or_resume_solo_session(
  p_ruleset jsonb
)
returns table (
  match_id uuid,
  board_seed bigint,
  scheduled_start_at timestamptz,
  round_duration_seconds integer,
  ruleset jsonb,
  mode_key text,
  server_now timestamptz,
  session_action text
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
  normalized_ruleset jsonb;
  generated_match_id uuid := pg_catalog.gen_random_uuid();
  generated_seed bigint :=
    pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
  generated_mode_key text;
  expired_session_count integer := 0;
  replaced_expired_session boolean := false;
begin
  perform private.ensure_ranked_identity(current_user_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('solo-session:' || current_user_id::text, 0)
  );

  -- Cancel every legacy unfinished row whose authoritative window has
  -- elapsed. No completed transition means no statistics are recorded.
  update public.matches as match_row
  set
    status = 'cancelled',
    scheduled_start_at = null,
    preview_started_at = null,
    preview_ends_at = null
  from public.match_players as player
  where player.match_id = match_row.id
    and player.player_user_id = current_user_id
    and match_row.host_user_id = current_user_id
    and match_row.mode = 'solo'
    and match_row.status in ('starting', 'active')
    and (
      match_row.scheduled_start_at is null
      or match_row.scheduled_start_at
        + pg_catalog.make_interval(
          secs => match_row.round_duration_seconds
        )
        + interval '15 seconds' < database_now
    );
  get diagnostics expired_session_count = row_count;
  replaced_expired_session := expired_session_count > 0;

  select match_row.*
  into locked_match
  from public.matches as match_row
  join public.match_players as player on player.match_id = match_row.id
  where player.player_user_id = current_user_id
    and match_row.host_user_id = current_user_id
    and match_row.mode = 'solo'
    and match_row.status in ('starting', 'active')
    and match_row.scheduled_start_at is not null
    and match_row.scheduled_start_at
      + pg_catalog.make_interval(
        secs => match_row.round_duration_seconds
      )
      + interval '15 seconds' >= database_now
  order by match_row.created_at desc, match_row.id
  limit 1
  for update of match_row;

  if found then
    return query
    select
      locked_match.id,
      locked_match.board_seed,
      locked_match.scheduled_start_at,
      locked_match.round_duration_seconds,
      locked_match.ruleset,
      locked_match.mode_key,
      database_now,
      'resumed'::text;
    return;
  end if;

  normalized_ruleset := private.validate_game_ruleset(p_ruleset, 2);
  generated_mode_key := private.mode_key('solo', normalized_ruleset);

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
    rating_status
  )
  values (
    generated_match_id,
    null,
    'active',
    current_user_id,
    generated_seed,
    (normalized_ruleset ->> 'roundDurationSeconds')::integer,
    database_now,
    1,
    normalized_ruleset,
    normalized_ruleset ->> 'dictionaryVersion',
    normalized_ruleset ->> 'boardGenerationVersion',
    normalized_ruleset ->> 'version',
    'solo',
    generated_mode_key,
    normalized_ruleset ->> 'scoringRulesVersion',
    null,
    'not_applicable'
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
    generated_seed,
    database_now,
    (normalized_ruleset ->> 'roundDurationSeconds')::integer,
    normalized_ruleset,
    generated_mode_key,
    database_now,
    case
      when replaced_expired_session then 'replaced'
      else 'created'
    end::text;
end;
$$;

revoke all on function public.create_or_resume_solo_session(jsonb)
  from public, anon, authenticated;
grant execute on function public.create_or_resume_solo_session(jsonb)
  to authenticated;

create or replace function public.create_solo_session(p_ruleset jsonb)
returns table (
  match_id uuid,
  board_seed bigint,
  scheduled_start_at timestamptz,
  round_duration_seconds integer,
  ruleset jsonb,
  mode_key text,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_persistent_caller();

  return query
  select
    session.match_id,
    session.board_seed,
    session.scheduled_start_at,
    session.round_duration_seconds,
    session.ruleset,
    session.mode_key,
    session.server_now
  from public.create_or_resume_solo_session(p_ruleset) as session;
end;
$$;

revoke all on function public.create_solo_session(jsonb)
  from public, anon, authenticated;
grant execute on function public.create_solo_session(jsonb)
  to authenticated;

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
    preview_ends_at = null
  where match_row.id = locked_match.id
    and match_row.status in ('starting', 'active');

  return query
  select locked_match.id, 'cancelled'::text, true, database_now;
end;
$$;

revoke all on function public.abandon_solo_session(uuid)
  from public, anon, authenticated;
grant execute on function public.abandon_solo_session(uuid)
  to authenticated;

comment on function public.create_or_resume_solo_session(jsonb) is
  'Atomically creates, resumes, or replaces an expired solo round for auth.uid().';
comment on function public.create_solo_session(jsonb) is
  'Backward-compatible solo startup that resumes an unfinished auth.uid() round.';
comment on function public.abandon_solo_session(uuid) is
  'Idempotently cancels an unfinished solo round owned by auth.uid() without saving statistics.';

commit;
