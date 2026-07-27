create or replace function public.get_my_match_preview_votes(p_match_id uuid)
returns table (
  board_revision integer,
  reroll_sequence integer,
  reroll_voted boolean,
  skip_voted boolean,
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
  where match_row.id = p_match_id;

  if not found
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;

  return query
  select
    locked_match.board_revision,
    locked_match.reroll_sequence,
    exists (
      select 1
      from public.match_reroll_votes as vote
      where vote.match_id = locked_match.id
        and vote.board_revision = locked_match.board_revision
        and vote.vote_revision = locked_match.reroll_vote_revision
        and vote.user_id = current_user_id
        and vote.approve
    ),
    exists (
      select 1
      from public.match_countdown_skip_votes as vote
      where vote.match_id = locked_match.id
        and vote.board_revision = locked_match.board_revision
        and vote.user_id = current_user_id
    ),
    database_now;
end;
$$;

revoke all on function public.get_my_match_preview_votes(uuid)
  from public, anon, authenticated;
grant execute on function public.get_my_match_preview_votes(uuid)
  to authenticated;

comment on function public.get_my_match_preview_votes(uuid) is
  'Returns the caller''s revision-scoped mutual reroll and countdown-skip votes so reconnects restore submitted button state without exposing other participant identities.';

create or replace function public.vote_match_reroll_cycle(
  p_match_id uuid,
  p_board_revision integer,
  p_approve boolean
)
returns table (
  board_seed bigint,
  board_revision integer,
  reroll_sequence integer,
  reroll_vote_revision integer,
  reroll_status text,
  reroll_approvals integer,
  reroll_declines integer,
  reroll_expires_at timestamptz,
  skip_approvals integer,
  participant_count integer,
  preview_started_at timestamptz,
  preview_ends_at timestamptz,
  scheduled_start_at timestamptz,
  match_status public.match_status,
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
  current_vote_revision integer;
  approval_count integer;
  player_count integer;
  next_seed bigint;
begin
  if p_approve is distinct from true then
    raise exception 'Reroll votes can only be submitted.';
  end if;

  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;
  if locked_match.mode not in ('ranked', 'private')
    or locked_match.status <> 'starting'
    or locked_match.preview_ends_at is null
    or database_now >= locked_match.preview_ends_at then
    raise exception 'Reroll voting is closed.';
  end if;
  if p_board_revision is distinct from locked_match.board_revision then
    raise exception 'The board changed. Refresh the preview and vote again.';
  end if;
  if locked_match.reroll_sequence >= 3 then
    raise exception 'The three-reroll limit has been reached.';
  end if;

  if locked_match.reroll_status <> 'pending' then
    current_vote_revision := locked_match.reroll_vote_revision + 1;
    update public.matches as match_row
    set
      reroll_vote_revision = current_vote_revision,
      reroll_status = 'pending',
      reroll_requested_by = current_user_id,
      reroll_requested_at = database_now,
      reroll_vote_expires_at = locked_match.preview_ends_at
    where match_row.id = locked_match.id;

    locked_match.reroll_vote_revision := current_vote_revision;
    locked_match.reroll_status := 'pending';
    locked_match.reroll_requested_by := current_user_id;
    locked_match.reroll_requested_at := database_now;
    locked_match.reroll_vote_expires_at := locked_match.preview_ends_at;
  else
    current_vote_revision := locked_match.reroll_vote_revision;
  end if;

  insert into public.match_reroll_votes (
    match_id,
    board_revision,
    vote_revision,
    user_id,
    approve,
    expires_at,
    voted_at
  )
  values (
    locked_match.id,
    locked_match.board_revision,
    current_vote_revision,
    current_user_id,
    true,
    locked_match.preview_ends_at,
    database_now
  )
  on conflict on constraint match_reroll_votes_pkey
    do nothing;

  select pg_catalog.count(*)::integer
  into player_count
  from public.match_players as participant
  where participant.match_id = locked_match.id
    and participant.finished_at is null
    and participant.connection_status in ('connected', 'disconnected');

  select pg_catalog.count(*)::integer
  into approval_count
  from public.match_reroll_votes as vote
  join public.match_players as participant
    on participant.match_id = vote.match_id
    and participant.player_user_id = vote.user_id
  where vote.match_id = locked_match.id
    and vote.board_revision = locked_match.board_revision
    and vote.vote_revision = current_vote_revision
    and vote.approve
    and participant.finished_at is null
    and participant.connection_status in ('connected', 'disconnected');

  if approval_count = player_count and player_count > 0 then
    if locked_match.mode = 'private' then
      next_seed := private.select_quality_board_seed(
        locked_match.ruleset,
        locked_match.board_seed
      );
    else
      next_seed :=
        pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
      if next_seed = locked_match.board_seed then
        next_seed := mod(next_seed + 1, 4294967296::bigint);
      end if;
    end if;

    update public.matches as match_row
    set
      board_seed = next_seed,
      board_revision = match_row.board_revision + 1,
      reroll_sequence = match_row.reroll_sequence + 1,
      reroll_used = true,
      reroll_status = 'idle',
      reroll_requested_by = null,
      reroll_requested_at = null,
      reroll_vote_expires_at = null,
      preview_started_at = database_now,
      preview_ends_at = database_now + interval '8 seconds',
      scheduled_start_at = database_now + interval '8 seconds'
    where match_row.id = locked_match.id
      and match_row.reroll_sequence < 3
    returning * into locked_match;

    delete from public.match_reroll_votes as vote
    where vote.match_id = locked_match.id
      and vote.board_revision < locked_match.board_revision;
    delete from public.match_countdown_skip_votes as vote
    where vote.match_id = locked_match.id
      and vote.board_revision < locked_match.board_revision;
  end if;

  return query
  select *
  from public.get_match_preview_state(locked_match.id);
end;
$$;

revoke all on function public.vote_match_reroll_cycle(
  uuid,
  integer,
  boolean
) from public, anon, authenticated;
grant execute on function public.vote_match_reroll_cycle(
  uuid,
  integer,
  boolean
) to authenticated;

comment on function public.vote_match_reroll_cycle(uuid, integer, boolean) is
  'Records one idempotent auth.uid() reroll vote for the exact board; only unanimous current-participant consent advances the board and completed reroll count, capped at three rerolls per match.';

create or replace function public.vote_match_countdown_skip(
  p_match_id uuid,
  p_board_revision integer
)
returns table (
  board_seed bigint,
  board_revision integer,
  reroll_sequence integer,
  reroll_vote_revision integer,
  reroll_status text,
  reroll_approvals integer,
  reroll_declines integer,
  reroll_expires_at timestamptz,
  skip_approvals integer,
  participant_count integer,
  preview_started_at timestamptz,
  preview_ends_at timestamptz,
  scheduled_start_at timestamptz,
  match_status public.match_status,
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
  approval_count integer;
  player_count integer;
  synchronized_start timestamptz;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;
  if locked_match.status <> 'starting'
    or locked_match.preview_ends_at is null
    or database_now >= locked_match.preview_ends_at then
    raise exception 'Countdown voting is closed.';
  end if;
  if locked_match.board_revision is distinct from p_board_revision then
    raise exception 'The board changed. Refresh the preview and vote again.';
  end if;

  insert into public.match_countdown_skip_votes (
    match_id,
    board_revision,
    user_id,
    voted_at
  )
  values (
    locked_match.id,
    locked_match.board_revision,
    current_user_id,
    database_now
  )
  on conflict on constraint match_countdown_skip_votes_pkey
    do nothing;

  select pg_catalog.count(*)::integer
  into player_count
  from public.match_players as participant
  where participant.match_id = locked_match.id
    and participant.finished_at is null
    and participant.connection_status in ('connected', 'disconnected');

  select pg_catalog.count(*)::integer
  into approval_count
  from public.match_countdown_skip_votes as vote
  join public.match_players as participant
    on participant.match_id = vote.match_id
    and participant.player_user_id = vote.user_id
  where vote.match_id = locked_match.id
    and vote.board_revision = locked_match.board_revision
    and participant.finished_at is null
    and participant.connection_status in ('connected', 'disconnected');

  if approval_count = player_count
    and player_count > 0
    and locked_match.scheduled_start_at >
      database_now + interval '250 milliseconds' then
    synchronized_start := database_now + interval '250 milliseconds';
    update public.matches as match_row
    set
      scheduled_start_at = synchronized_start,
      preview_ends_at = synchronized_start
    where match_row.id = locked_match.id
      and match_row.board_revision = locked_match.board_revision
      and match_row.status = 'starting'
      and match_row.scheduled_start_at > synchronized_start;
  end if;

  return query
  select *
  from public.get_match_preview_state(locked_match.id);
end;
$$;

revoke all on function public.vote_match_countdown_skip(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.vote_match_countdown_skip(uuid, integer)
  to authenticated;

comment on function public.vote_match_countdown_skip(uuid, integer) is
  'Records one idempotent auth.uid() skip vote for the exact board and moves the shared start timestamp forward once, only after unanimous current-participant consent.';
