begin;

-- Preview state is versioned so clients never combine a vote from one board
-- with the seed or countdown from another board.
alter table public.matches
  drop constraint matches_reroll_state;

alter table public.matches
  add column board_revision integer not null default 0,
  add column reroll_sequence integer not null default 0,
  add column reroll_vote_revision integer not null default 0,
  add column reroll_vote_expires_at timestamptz,
  add constraint matches_board_revision_nonnegative check (
    board_revision >= 0
  ),
  add constraint matches_reroll_sequence_nonnegative check (
    reroll_sequence >= 0
  ),
  add constraint matches_reroll_vote_revision_nonnegative check (
    reroll_vote_revision >= 0
  );

update public.matches as match_row
set
  reroll_sequence = case when match_row.reroll_used then 1 else 0 end,
  reroll_status = 'idle',
  reroll_requested_by = null,
  reroll_requested_at = null,
  reroll_vote_expires_at = null;

alter table public.matches
  add constraint matches_revisioned_reroll_state check (
    (
      reroll_status = 'idle'
      and reroll_requested_by is null
      and reroll_requested_at is null
      and reroll_vote_expires_at is null
    )
    or
    (
      reroll_status in ('pending', 'declined', 'expired')
      and reroll_requested_by is not null
      and reroll_requested_at is not null
      and reroll_vote_expires_at is not null
    )
  );

comment on column public.matches.board_revision is
  'Monotonic board snapshot revision. A successful reroll increments this value exactly once.';
comment on column public.matches.reroll_sequence is
  'Unbounded count of successful unanimous rerolls for this match.';
comment on column public.matches.reroll_vote_revision is
  'Monotonic vote-cycle revision, independent from successful board revisions.';
comment on column public.matches.reroll_vote_expires_at is
  'Database-authored deadline for the current reroll vote cycle.';

delete from public.match_reroll_votes;

alter table public.match_reroll_votes
  drop constraint match_reroll_votes_pkey,
  add column board_revision integer not null default 0,
  add column vote_revision integer not null default 0,
  add column expires_at timestamptz not null
    default pg_catalog.clock_timestamp(),
  add primary key (match_id, board_revision, vote_revision, user_id),
  add constraint match_reroll_votes_revisions_nonnegative check (
    board_revision >= 0 and vote_revision >= 0
  );

create index match_reroll_votes_match_revision_idx
  on public.match_reroll_votes (
    match_id,
    board_revision,
    vote_revision,
    approve
  );

drop policy if exists match_reroll_votes_participant_select
  on public.match_reroll_votes;
revoke all on table public.match_reroll_votes
  from public, anon, authenticated;

comment on table public.match_reroll_votes is
  'RPC-only, revision-scoped reroll votes. Old revisions cannot affect the current preview and raw auth UUIDs are not exposed through the Data API.';

create table public.match_countdown_skip_votes (
  match_id uuid not null references public.matches (id) on delete cascade,
  board_revision integer not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  voted_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (match_id, board_revision, user_id),
  constraint match_countdown_skip_revision_nonnegative check (
    board_revision >= 0
  )
);

create index match_countdown_skip_match_revision_idx
  on public.match_countdown_skip_votes (match_id, board_revision, voted_at);

alter table public.match_countdown_skip_votes enable row level security;
revoke all on table public.match_countdown_skip_votes
  from public, anon, authenticated;

comment on table public.match_countdown_skip_votes is
  'RPC-only countdown-skip votes scoped to one authoritative board revision; raw auth UUIDs are not exposed through the Data API.';

create or replace function private.lock_user_activity(p_user_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'player-activity:' || p_user_id::text,
        0
      )
    );
  end if;
end;
$$;

revoke all on function private.lock_user_activity(uuid)
  from public, anon, authenticated;

comment on function private.lock_user_activity(uuid) is
  'Serializes authoritative match-entry decisions for one auth identity without exposing the identity through a public RPC.';

create or replace function private.try_lock_user_activity(p_user_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    p_user_id is not null
    and pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'player-activity:' || p_user_id::text,
        0
      )
    );
$$;

revoke all on function private.try_lock_user_activity(uuid)
  from public, anon, authenticated;

comment on function private.try_lock_user_activity(uuid) is
  'Lets matchmaking skip a busy candidate instead of deadlocking against a stable two-player activity lock.';

create or replace function private.lock_user_activity_pair(
  p_first_user_id uuid,
  p_second_user_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform private.lock_user_activity(
    least(p_first_user_id, p_second_user_id)
  );
  perform private.lock_user_activity(
    greatest(p_first_user_id, p_second_user_id)
  );
end;
$$;

revoke all on function private.lock_user_activity_pair(uuid, uuid)
  from public, anon, authenticated;

comment on function private.lock_user_activity_pair(uuid, uuid) is
  'Locks two player activity keys in stable UUID order so challenges and rematches cannot race another match-entry path.';

create index player_challenges_pending_expiration_idx
  on public.player_challenges (expires_at, id)
  where status = 'pending';
create index two_player_rematches_pending_expiration_idx
  on public.two_player_rematch_proposals (expires_at, id)
  where status = 'pending';
create index match_players_active_user_idx
  on public.match_players (player_user_id, match_id)
  where finished_at is null;

-- This is the canonical stale-state repair boundary used before deciding
-- whether a player is occupied. Presence remains advisory; durable match,
-- queue, and database timestamps are authoritative.
create or replace function private.cleanup_user_activity(
  p_user_id uuid,
  p_database_now timestamptz
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  candidate_match_id uuid;
begin
  if p_user_id is null then
    return;
  end if;

  update public.ranked_queue as queue
  set
    status = 'cancelled',
    cancelled_at = p_database_now
  where queue.user_id = p_user_id
    and queue.status = 'waiting'
    and queue.heartbeat_at < p_database_now - interval '35 seconds';

  update public.player_challenges as challenge
  set
    status = 'expired',
    responded_at = p_database_now
  where challenge.status = 'pending'
    and challenge.expires_at <= p_database_now
    and p_user_id in (challenge.challenger_id, challenge.challenged_id);

  update public.two_player_rematch_proposals as proposal
  set
    status = 'expired',
    responded_at = p_database_now
  where proposal.status = 'pending'
    and proposal.expires_at <= p_database_now
    and exists (
      select 1
      from public.match_players as participant
      where participant.match_id = proposal.source_match_id
        and participant.player_user_id = p_user_id
    );

  -- Expired solo sessions are cancelled before occupancy is evaluated.
  update public.matches as match_row
  set
    status = 'cancelled',
    scheduled_start_at = null,
    preview_started_at = null,
    preview_ends_at = null,
    abandoned_at = coalesce(match_row.abandoned_at, p_database_now)
  from public.match_players as participant
  where participant.match_id = match_row.id
    and participant.player_user_id = p_user_id
    and match_row.mode = 'solo'
    and match_row.status in ('starting', 'active')
    and (
      match_row.scheduled_start_at is null
      or match_row.scheduled_start_at
        + pg_catalog.make_interval(
          secs => match_row.round_duration_seconds
        )
        + interval '15 seconds' < p_database_now
    );

  update public.match_players as participant
  set
    finished_at = coalesce(participant.finished_at, p_database_now),
    validated_score = coalesce(participant.validated_score, 0),
    validated_words = coalesce(participant.validated_words, '[]'::jsonb),
    result_status = 'forfeit',
    connection_status = 'left',
    disconnect_deadline_at = null,
    departed_at = coalesce(participant.departed_at, p_database_now)
  from public.matches as match_row
  where match_row.id = participant.match_id
    and participant.player_user_id = p_user_id
    and match_row.mode = 'solo'
    and match_row.status = 'cancelled'
    and participant.finished_at is null;

  -- A waiting private room with no durable activity for two hours is stale.
  for candidate_match_id in
    select distinct match_row.id
    from public.matches as match_row
    join public.match_players as participant
      on participant.match_id = match_row.id
    where participant.player_user_id = p_user_id
      and participant.finished_at is null
      and match_row.mode = 'private'
      and match_row.status = 'waiting'
      and match_row.created_at < p_database_now - interval '2 hours'
      and not exists (
        select 1
        from public.match_players as current_participant
        where current_participant.match_id = match_row.id
          and current_participant.finished_at is null
          and current_participant.last_connected_at >=
            p_database_now - interval '2 hours'
      )
  loop
    update public.matches as match_row
    set
      status = 'cancelled',
      abandoned_at = coalesce(match_row.abandoned_at, p_database_now)
    where match_row.id = candidate_match_id
      and match_row.status = 'waiting';

    update public.match_players as participant
    set
      finished_at = coalesce(participant.finished_at, p_database_now),
      validated_score = coalesce(participant.validated_score, 0),
      validated_words = coalesce(participant.validated_words, '[]'::jsonb),
      result_status = 'forfeit',
      connection_status = 'left',
      disconnect_deadline_at = null,
      departed_at = coalesce(participant.departed_at, p_database_now)
    where participant.match_id = candidate_match_id
      and participant.finished_at is null;
  end loop;

  for candidate_match_id in
    select distinct match_row.id
    from public.matches as match_row
    join public.match_players as participant
      on participant.match_id = match_row.id
    where participant.player_user_id = p_user_id
      and match_row.mode in ('private', 'ranked')
      and match_row.status in ('starting', 'active')
  loop
    perform private.reconcile_match_lifecycle(
      candidate_match_id,
      p_database_now
    );
  end loop;
end;
$$;

revoke all on function private.cleanup_user_activity(uuid, timestamptz)
  from public, anon, authenticated;

comment on function private.cleanup_user_activity(uuid, timestamptz) is
  'Canonical server-timestamp cleanup for stale queues, challenges, rematches, solo sessions, waiting lobbies, and multiplayer recovery state before occupancy checks.';

create or replace function private.user_has_active_match(
  p_user_id uuid,
  p_database_now timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform private.cleanup_user_activity(p_user_id, p_database_now);

  return exists (
    select 1
    from public.match_players as participant
    join public.matches as match_row on match_row.id = participant.match_id
    where participant.player_user_id = p_user_id
      and match_row.status in ('waiting', 'starting', 'active')
      and (
        match_row.status = 'waiting'
        or match_row.scheduled_start_at is null
        or match_row.scheduled_start_at
          + pg_catalog.make_interval(
            secs => match_row.round_duration_seconds
          )
          + interval '45 seconds' >= p_database_now
      )
  );
end;
$$;

revoke all on function private.user_has_active_match(uuid, timestamptz)
  from public, anon, authenticated;

comment on function private.user_has_active_match(uuid, timestamptz) is
  'Canonical authoritative active-match definition after opportunistic cleanup; it never consults client Presence or client-supplied online state.';

create or replace function private.has_active_match(p_user_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.user_has_active_match(
    p_user_id,
    pg_catalog.clock_timestamp()
  );
$$;

revoke all on function private.has_active_match(uuid)
  from public, anon, authenticated;

create or replace function private.user_waiting_ranked(
  p_user_id uuid,
  p_database_now timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform private.cleanup_user_activity(p_user_id, p_database_now);
  return exists (
    select 1
    from public.ranked_queue as queue
    where queue.user_id = p_user_id
      and queue.status = 'waiting'
      and queue.heartbeat_at >= p_database_now - interval '35 seconds'
  );
end;
$$;

revoke all on function private.user_waiting_ranked(uuid, timestamptz)
  from public, anon, authenticated;

create or replace function private.has_open_multiplayer_state(p_user_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    private.user_has_active_match(
      p_user_id,
      pg_catalog.clock_timestamp()
    )
    or private.user_waiting_ranked(
      p_user_id,
      pg_catalog.clock_timestamp()
    );
$$;

revoke all on function private.has_open_multiplayer_state(uuid)
  from public, anon, authenticated;

create or replace function public.get_match_preview_state(p_match_id uuid)
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

  if locked_match.reroll_status = 'pending'
    and locked_match.reroll_vote_expires_at <= database_now then
    update public.matches as match_row
    set reroll_status = 'expired'
    where match_row.id = locked_match.id
      and match_row.board_revision = locked_match.board_revision
      and match_row.reroll_vote_revision =
        locked_match.reroll_vote_revision
      and match_row.reroll_status = 'pending';
    locked_match.reroll_status := 'expired';
  end if;

  return query
  select
    locked_match.board_seed,
    locked_match.board_revision,
    locked_match.reroll_sequence,
    locked_match.reroll_vote_revision,
    locked_match.reroll_status,
    (
      select pg_catalog.count(*)::integer
      from public.match_reroll_votes as vote
      join public.match_players as participant
        on participant.match_id = vote.match_id
        and participant.player_user_id = vote.user_id
      where vote.match_id = locked_match.id
        and vote.board_revision = locked_match.board_revision
        and vote.vote_revision = locked_match.reroll_vote_revision
        and vote.approve
        and participant.finished_at is null
        and participant.connection_status in ('connected', 'disconnected')
    ),
    (
      select pg_catalog.count(*)::integer
      from public.match_reroll_votes as vote
      join public.match_players as participant
        on participant.match_id = vote.match_id
        and participant.player_user_id = vote.user_id
      where vote.match_id = locked_match.id
        and vote.board_revision = locked_match.board_revision
        and vote.vote_revision = locked_match.reroll_vote_revision
        and not vote.approve
        and participant.finished_at is null
        and participant.connection_status in ('connected', 'disconnected')
    ),
    locked_match.reroll_vote_expires_at,
    (
      select pg_catalog.count(*)::integer
      from public.match_countdown_skip_votes as vote
      join public.match_players as participant
        on participant.match_id = vote.match_id
        and participant.player_user_id = vote.user_id
      where vote.match_id = locked_match.id
        and vote.board_revision = locked_match.board_revision
        and participant.finished_at is null
        and participant.connection_status in ('connected', 'disconnected')
    ),
    (
      select pg_catalog.count(*)::integer
      from public.match_players as participant
      where participant.match_id = locked_match.id
        and participant.finished_at is null
        and participant.connection_status in ('connected', 'disconnected')
    ),
    locked_match.preview_started_at,
    locked_match.preview_ends_at,
    locked_match.scheduled_start_at,
    locked_match.status,
    database_now;
end;
$$;

revoke all on function public.get_match_preview_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_match_preview_state(uuid)
  to authenticated;

comment on function public.get_match_preview_state(uuid) is
  'Returns one participant-only atomic preview snapshot and expires only its current revision against database time; Realtime events merely prompt this authoritative refetch.';

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
  decline_count integer;
  player_count integer;
  next_seed bigint;
begin
  if p_approve is null then
    raise exception 'Choose whether to approve or decline the reroll.';
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

  if locked_match.reroll_status = 'pending'
    and locked_match.reroll_vote_expires_at <= database_now then
    update public.matches as match_row
    set reroll_status = 'expired'
    where match_row.id = locked_match.id;
    locked_match.reroll_status := 'expired';
  end if;

  if locked_match.reroll_status in ('idle', 'declined', 'expired') then
    if not p_approve then
      raise exception 'No reroll vote is pending.';
    end if;

    current_vote_revision := locked_match.reroll_vote_revision + 1;
    update public.matches as match_row
    set
      reroll_vote_revision = current_vote_revision,
      reroll_status = 'pending',
      reroll_requested_by = current_user_id,
      reroll_requested_at = database_now,
      reroll_vote_expires_at = least(
        database_now + interval '8 seconds',
        locked_match.preview_ends_at
      )
    where match_row.id = locked_match.id;

    locked_match.reroll_vote_revision := current_vote_revision;
    locked_match.reroll_status := 'pending';
    locked_match.reroll_requested_by := current_user_id;
    locked_match.reroll_requested_at := database_now;
    locked_match.reroll_vote_expires_at := least(
      database_now + interval '8 seconds',
      locked_match.preview_ends_at
    );
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
    p_approve,
    locked_match.reroll_vote_expires_at,
    database_now
  )
  on conflict (match_id, board_revision, vote_revision, user_id)
    do nothing;

  select pg_catalog.count(*)::integer
  into player_count
  from public.match_players as participant
  where participant.match_id = locked_match.id
    and participant.finished_at is null
    and participant.connection_status in ('connected', 'disconnected');

  select
    pg_catalog.count(*) filter (where vote.approve)::integer,
    pg_catalog.count(*) filter (where not vote.approve)::integer
  into approval_count, decline_count
  from public.match_reroll_votes as vote
  join public.match_players as participant
    on participant.match_id = vote.match_id
    and participant.player_user_id = vote.user_id
  where vote.match_id = locked_match.id
    and vote.board_revision = locked_match.board_revision
    and vote.vote_revision = current_vote_revision
    and participant.finished_at is null
    and participant.connection_status in ('connected', 'disconnected');

  if decline_count > 0 then
    update public.matches as match_row
    set reroll_status = 'declined'
    where match_row.id = locked_match.id;
    locked_match.reroll_status := 'declined';
  elsif approval_count = player_count and player_count > 0 then
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
  'Records one auth.uid() vote for an exact board and vote revision; unanimous approval atomically advances the seed, board revision, reroll sequence, and shared database countdown with no reroll limit.';

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
  if locked_match.reroll_status = 'pending' then
    raise exception 'Finish the reroll vote before skipping the countdown.';
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
  on conflict (match_id, board_revision, user_id) do nothing;

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

  if approval_count = player_count and player_count > 0 then
    synchronized_start := database_now + interval '750 milliseconds';
    update public.matches as match_row
    set
      scheduled_start_at = synchronized_start,
      preview_ends_at = synchronized_start
    where match_row.id = locked_match.id
      and match_row.board_revision = locked_match.board_revision
      and match_row.status = 'starting';
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
  'Records one auth.uid() skip vote for the exact board revision and, only when every current participant agrees, moves the shared database start timestamp forward with a 750ms synchronization buffer.';

-- Backward-compatible wrapper for older clients. New clients use the
-- revision-aware cycle RPC.
create or replace function public.vote_match_reroll(
  p_match_id uuid,
  p_approve boolean
)
returns table (
  reroll_used boolean,
  approvals integer,
  declines integer,
  participant_count integer,
  board_seed bigint,
  preview_ends_at timestamptz,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_revision integer;
begin
  perform private.require_persistent_caller();

  select match_row.board_revision
  into current_revision
  from public.matches as match_row
  where match_row.id = p_match_id;

  if not found then
    raise exception 'You are not a participant in this match.';
  end if;

  return query
  select
    state.reroll_sequence > 0,
    state.reroll_approvals,
    state.reroll_declines,
    state.participant_count,
    state.board_seed,
    state.preview_ends_at,
    state.server_now
  from public.vote_match_reroll_cycle(
    p_match_id,
    current_revision,
    p_approve
  ) as state;
end;
$$;

revoke all on function public.vote_match_reroll(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.vote_match_reroll(uuid, boolean)
  to authenticated;

comment on function public.vote_match_reroll(uuid, boolean) is
  'Compatibility wrapper over the revision-scoped unlimited reroll RPC; caller identity still comes only from auth.uid().';

create or replace function public.create_player_challenge(
  p_public_profile_id text,
  p_rated boolean
)
returns table (
  challenge_id uuid,
  direction text,
  opponent_public_profile_id text,
  opponent_display_name text,
  rated boolean,
  challenge_status text,
  expires_at timestamptz,
  match_id uuid,
  match_mode public.match_mode,
  room_code text,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  normalized_profile_id text :=
    pg_catalog.upper(pg_catalog.btrim(coalesce(p_public_profile_id, '')));
  challenged_profile public.profiles%rowtype;
  existing_challenge public.player_challenges%rowtype;
  created_challenge public.player_challenges%rowtype;
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform private.ensure_ranked_identity(current_user_id);

  if p_rated is null then
    raise exception 'Choose a rated or casual challenge.';
  end if;
  if normalized_profile_id !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' then
    raise exception 'Player profile was not found';
  end if;

  select profile.*
  into challenged_profile
  from public.profiles as profile
  where profile.public_profile_id = normalized_profile_id;

  if not found then
    raise exception 'Player profile was not found';
  end if;
  if challenged_profile.id = current_user_id then
    raise exception 'You cannot challenge yourself';
  end if;
  if not exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = challenged_profile.id
      and not coalesce(auth_user.is_anonymous, false)
  ) then
    raise exception 'Player profile was not found';
  end if;

  perform private.ensure_ranked_identity(challenged_profile.id);
  perform private.lock_user_activity_pair(
    current_user_id,
    challenged_profile.id
  );

  perform private.cleanup_user_activity(current_user_id, database_now);
  perform private.cleanup_user_activity(challenged_profile.id, database_now);

  select challenge.*
  into existing_challenge
  from public.player_challenges as challenge
  where challenge.status = 'pending'
    and challenge.expires_at > database_now
    and least(challenge.challenger_id, challenge.challenged_id)
      = least(current_user_id, challenged_profile.id)
    and greatest(challenge.challenger_id, challenge.challenged_id)
      = greatest(current_user_id, challenged_profile.id)
  for update;

  if found then
    if existing_challenge.challenger_id <> current_user_id then
      raise exception 'That player already challenged you';
    end if;
    if existing_challenge.rated is distinct from p_rated then
      raise exception 'You already sent this player a challenge';
    end if;

    return query
    select
      existing_challenge.id,
      'outgoing'::text,
      challenged_profile.public_profile_id,
      challenged_profile.display_name,
      existing_challenge.rated,
      existing_challenge.status,
      existing_challenge.expires_at,
      null::uuid,
      null::public.match_mode,
      null::text,
      database_now;
    return;
  end if;

  if private.user_has_active_match(current_user_id, database_now) then
    raise exception 'You are already in an active match';
  end if;
  if private.user_has_active_match(challenged_profile.id, database_now) then
    raise exception 'That player is already in an active match';
  end if;
  if private.user_waiting_ranked(current_user_id, database_now) then
    raise exception 'You are already waiting in ranked matchmaking';
  end if;
  if private.user_waiting_ranked(challenged_profile.id, database_now) then
    raise exception 'That player is already waiting in ranked matchmaking';
  end if;

  insert into public.player_challenges (
    challenger_id,
    challenged_id,
    rated,
    expires_at
  )
  values (
    current_user_id,
    challenged_profile.id,
    p_rated,
    database_now + interval '30 seconds'
  )
  returning * into created_challenge;

  return query
  select
    created_challenge.id,
    'outgoing'::text,
    challenged_profile.public_profile_id,
    challenged_profile.display_name,
    created_challenge.rated,
    created_challenge.status,
    created_challenge.expires_at,
    null::uuid,
    null::public.match_mode,
    null::text,
    database_now;
end;
$$;

revoke all on function public.create_player_challenge(text, boolean)
  from public, anon, authenticated;
grant execute on function public.create_player_challenge(text, boolean)
  to authenticated;

comment on function public.create_player_challenge(text, boolean) is
  'Creates one 30-second direct challenge from auth.uid() to an opaque profile ID after canonical stale-state cleanup; Presence is never an authorization input.';

create or replace function public.respond_player_challenge(
  p_challenge_id uuid,
  p_accept boolean
)
returns table (
  challenge_status text,
  match_id uuid,
  match_mode public.match_mode,
  room_code text,
  server_now timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  challenge public.player_challenges%rowtype;
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  database_now timestamptz := pg_catalog.clock_timestamp();
  scheduled_start timestamptz := database_now + interval '8 seconds';
  attempt integer;
begin
  if p_accept is null then
    raise exception 'Choose whether to accept or decline the challenge.';
  end if;

  perform private.ensure_ranked_identity(current_user_id);

  select candidate.*
  into challenge
  from public.player_challenges as candidate
  where candidate.id = p_challenge_id;

  if not found or challenge.challenged_id <> current_user_id then
    raise exception 'Challenge service is unavailable'
      using errcode = '42501';
  end if;

  perform private.lock_user_activity_pair(
    challenge.challenger_id,
    challenge.challenged_id
  );
  perform private.ensure_ranked_identity(challenge.challenger_id);
  perform private.ensure_ranked_identity(challenge.challenged_id);

  select candidate.*
  into challenge
  from public.player_challenges as candidate
  where candidate.id = p_challenge_id
  for update;

  if challenge.status = 'accepted' then
    return query
    select
      challenge.status,
      match_row.id,
      match_row.mode,
      match_row.room_code,
      database_now
    from public.matches as match_row
    where match_row.id = challenge.created_match_id;
    return;
  end if;
  if challenge.status = 'declined' then
    return query
    select
      'declined'::text,
      null::uuid,
      null::public.match_mode,
      null::text,
      database_now;
    return;
  end if;
  if challenge.status = 'expired'
    or challenge.expires_at <= database_now then
    update public.player_challenges as candidate
    set
      status = 'expired',
      responded_at = coalesce(candidate.responded_at, database_now)
    where candidate.id = challenge.id
      and candidate.status = 'pending';
    return query
    select
      'expired'::text,
      null::uuid,
      null::public.match_mode,
      null::text,
      database_now;
    return;
  end if;
  if challenge.status <> 'pending' then
    raise exception 'Challenge service is unavailable';
  end if;

  if not p_accept then
    update public.player_challenges as candidate
    set
      status = 'declined',
      responded_at = database_now
    where candidate.id = challenge.id;

    return query
    select
      'declined'::text,
      null::uuid,
      null::public.match_mode,
      null::text,
      database_now;
    return;
  end if;

  if not exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = challenge.challenger_id
      and not coalesce(auth_user.is_anonymous, false)
  ) then
    raise exception 'Player profile was not found';
  end if;

  perform private.cleanup_user_activity(
    challenge.challenger_id,
    database_now
  );
  perform private.cleanup_user_activity(
    challenge.challenged_id,
    database_now
  );

  if private.user_has_active_match(challenge.challenger_id, database_now) then
    raise exception 'That player is already in an active match';
  end if;
  if private.user_has_active_match(challenge.challenged_id, database_now) then
    raise exception 'You are already in an active match';
  end if;
  if private.user_waiting_ranked(challenge.challenger_id, database_now)
    or private.user_waiting_ranked(challenge.challenged_id, database_now) then
    raise exception 'A player is already waiting in ranked matchmaking';
  end if;

  generated_match_id := pg_catalog.gen_random_uuid();
  generated_seed :=
    pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;

  if challenge.rated then
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
      preview_started_at,
      preview_ends_at
    )
    values (
      generated_match_id,
      null,
      'starting',
      null,
      generated_seed,
      60,
      scheduled_start,
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
      database_now,
      scheduled_start
    );
  else
    for attempt in 1..12 loop
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
          preview_started_at,
          preview_ends_at
        )
        values (
          generated_match_id,
          generated_room_code,
          'starting',
          challenge.challenger_id,
          generated_seed,
          60,
          scheduled_start,
          2,
          private.ranked_ruleset(),
          'enable2k-af52415-v1',
          'weighted-v2',
          '2',
          'private',
          private.mode_key('private', private.ranked_ruleset()),
          'classic-v1',
          null,
          'not_applicable',
          database_now,
          scheduled_start
        );
        exit;
      exception
        when unique_violation then
          if attempt = 12 then
            raise exception 'Challenge service is unavailable';
          end if;
      end;
    end loop;
  end if;

  insert into public.match_players (
    match_id,
    player_user_id,
    player_number
  )
  values
    (generated_match_id, challenge.challenger_id, 1),
    (generated_match_id, challenge.challenged_id, 2);

  update public.player_challenges as candidate
  set
    status = 'accepted',
    created_match_id = generated_match_id,
    responded_at = database_now
  where candidate.id = challenge.id
    and candidate.status = 'pending';

  return query
  select
    'accepted'::text,
    generated_match_id,
    case
      when challenge.rated then 'ranked'::public.match_mode
      else 'private'::public.match_mode
    end,
    generated_room_code,
    database_now;
end;
$$;

revoke all on function public.respond_player_challenge(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.respond_player_challenge(uuid, boolean)
  to authenticated;

comment on function public.respond_player_challenge(uuid, boolean) is
  'Lets only the challenged auth.uid() answer before the 30-second database deadline and atomically creates one shared pregame match after rechecking both authoritative activity states.';

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
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  normalized_ruleset jsonb;
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  attempt integer;
begin
  perform private.ensure_ranked_identity(current_user_id);
  perform private.lock_user_activity(current_user_id);
  perform private.cleanup_user_activity(current_user_id, database_now);

  if private.user_has_active_match(current_user_id, database_now) then
    raise exception 'You are already in an active match';
  end if;
  if private.user_waiting_ranked(current_user_id, database_now) then
    raise exception 'Leave ranked matchmaking before creating a private lobby';
  end if;

  normalized_ruleset := private.validate_game_ruleset(
    p_ruleset,
    p_max_players
  );
  generated_seed := private.select_quality_board_seed(
    normalized_ruleset,
    null
  );

  for attempt in 1..12 loop
    generated_match_id := pg_catalog.gen_random_uuid();
    generated_room_code := private.random_room_code();

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
        database_now,
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

revoke all on function public.create_private_lobby(jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.create_private_lobby(jsonb, integer)
  to authenticated;

comment on function public.create_private_lobby(jsonb, integer) is
  'Creates one high-quality private lobby for auth.uid() only after canonical stale-state cleanup and authoritative active-match and ranked-queue checks.';

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
  synchronized_start timestamptz := database_now + interval '8 seconds';
  proposal public.two_player_rematch_proposals%rowtype;
  source_match public.matches%rowtype;
  generated_match_id uuid := pg_catalog.gen_random_uuid();
  generated_room_code text;
  generated_seed bigint;
  opponent_user_id uuid;
  participant_count integer;
  attempt integer;
begin
  if p_accept is null then
    raise exception 'Choose whether to accept or decline the rematch.';
  end if;

  select candidate.*
  into proposal
  from public.two_player_rematch_proposals as candidate
  where candidate.id = p_proposal_id
    and private.is_match_participant(
      candidate.source_match_id,
      current_user_id
    );

  if not found then
    raise exception 'Only match participants can answer this rematch.'
      using errcode = '42501';
  end if;

  perform private.lock_user_activity_pair(
    proposal.requester_id,
    current_user_id
  );
  perform private.ensure_ranked_identity(proposal.requester_id);
  perform private.ensure_ranked_identity(current_user_id);

  select match_row.*
  into source_match
  from public.matches as match_row
  where match_row.id = proposal.source_match_id
  for update;

  select candidate.*
  into proposal
  from public.two_player_rematch_proposals as candidate
  where candidate.id = p_proposal_id
  for update;

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

  if source_match.id is null or source_match.status <> 'completed' then
    raise exception 'The previous match is not finalized yet.';
  end if;
  if source_match.mode not in ('ranked', 'private') then
    raise exception 'This match uses the group rematch flow.';
  end if;

  select pg_catalog.count(*)::integer
  into participant_count
  from public.match_players as participant
  where participant.match_id = source_match.id;

  select participant.player_user_id
  into opponent_user_id
  from public.match_players as participant
  where participant.match_id = source_match.id
    and participant.player_user_id <> current_user_id
  order by participant.player_number
  limit 1;

  if participant_count <> 2
    or opponent_user_id is distinct from proposal.requester_id then
    raise exception 'This match uses the group rematch flow.';
  end if;

  perform private.cleanup_user_activity(
    proposal.requester_id,
    database_now
  );
  perform private.cleanup_user_activity(current_user_id, database_now);

  if private.user_has_active_match(proposal.requester_id, database_now)
    or private.user_has_active_match(current_user_id, database_now) then
    raise exception 'A player is already in another active match.';
  end if;

  if private.user_waiting_ranked(proposal.requester_id, database_now)
    or private.user_waiting_ranked(current_user_id, database_now) then
    raise exception 'A player is already waiting in ranked matchmaking.';
  end if;

  if exists (
    select 1
    from public.matches as rematch
    where rematch.rematch_of = source_match.id
  ) then
    raise exception 'A rematch already exists for this match.';
  end if;

  if source_match.mode = 'private' then
    generated_seed := private.select_quality_board_seed(
      source_match.ruleset,
      source_match.board_seed
    );
  else
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
    while generated_seed = source_match.board_seed loop
      generated_seed :=
        pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
    end loop;
  end if;

  if source_match.mode = 'ranked' then
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
      rematch_of,
      preview_started_at,
      preview_ends_at
    )
    values (
      generated_match_id,
      null,
      'starting',
      null,
      generated_seed,
      60,
      synchronized_start,
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
      source_match.id,
      database_now,
      synchronized_start
    );
  else
    for attempt in 1..12 loop
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
          rematch_of,
          preview_started_at,
          preview_ends_at
        )
        values (
          generated_match_id,
          generated_room_code,
          'starting',
          proposal.requester_id,
          generated_seed,
          source_match.round_duration_seconds,
          synchronized_start,
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
          source_match.id,
          database_now,
          synchronized_start
        );
        exit;
      exception
        when unique_violation then
          if attempt = 12 then
            raise exception 'A unique private rematch could not be allocated.';
          end if;
      end;
    end loop;
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
  where candidate.id = proposal.id
    and candidate.status = 'pending';

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
  'Lets only the nonrequesting auth.uid() answer within 15 database seconds; acceptance rechecks canonical activity and atomically creates one direct rematch with complete preview timestamps.';

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
  replaced_expired_session boolean := false;
begin
  perform private.ensure_ranked_identity(current_user_id);
  perform private.lock_user_activity(current_user_id);

  if exists (
    select 1
    from public.matches as match_row
    join public.match_players as participant
      on participant.match_id = match_row.id
    where participant.player_user_id = current_user_id
      and match_row.mode = 'solo'
      and match_row.status in ('starting', 'active')
      and (
        match_row.scheduled_start_at is null
        or match_row.scheduled_start_at
          + pg_catalog.make_interval(
            secs => match_row.round_duration_seconds
          )
          + interval '15 seconds' < database_now
      )
  ) then
    replaced_expired_session := true;
  end if;

  perform private.cleanup_user_activity(current_user_id, database_now);

  select match_row.*
  into locked_match
  from public.matches as match_row
  join public.match_players as participant
    on participant.match_id = match_row.id
  where participant.player_user_id = current_user_id
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

  if private.user_has_active_match(current_user_id, database_now) then
    raise exception 'Finish or leave your active match before playing solo.';
  end if;
  if private.user_waiting_ranked(current_user_id, database_now) then
    raise exception 'Leave ranked matchmaking before playing solo.';
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

comment on function public.create_or_resume_solo_session(jsonb) is
  'Resumes a valid auth.uid() solo session or creates one only after the canonical activity reconciler removes expired solo state and confirms no other active match or ranked queue.';

create or replace function public.enter_ranked_queue()
returns table (
  queue_status public.ranked_queue_status,
  match_id uuid,
  joined_at timestamptz,
  heartbeat_at timestamptz,
  rating_snapshot integer,
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
  current_rating integer;
  own_queue public.ranked_queue%rowtype;
  opponent_queue public.ranked_queue%rowtype;
  recovered_match_id uuid;
  generated_match_id uuid;
  generated_seed bigint;
  start_time timestamptz;
begin
  perform private.lock_user_activity(current_user_id);
  perform private.ensure_ranked_identity(current_user_id);
  perform private.expire_stale_ranked_queue(database_now);
  perform private.cleanup_user_activity(current_user_id, database_now);

  select match_row.id
  into recovered_match_id
  from public.matches as match_row
  join public.match_players as participant
    on participant.match_id = match_row.id
  where participant.player_user_id = current_user_id
    and match_row.mode = 'ranked'
    and match_row.status in ('starting', 'active')
  order by match_row.created_at desc, match_row.id
  limit 1
  for update of match_row;

  select stats.current_rating
  into current_rating
  from public.ranked_stats as stats
  where stats.user_id = current_user_id;

  if recovered_match_id is not null then
    insert into public.ranked_queue (
      user_id,
      status,
      rating_snapshot,
      joined_at,
      heartbeat_at,
      match_id,
      matched_at,
      cancelled_at
    )
    values (
      current_user_id,
      'matched',
      current_rating,
      database_now,
      database_now,
      recovered_match_id,
      database_now,
      null
    )
    on conflict (user_id) do update
    set
      status = 'matched',
      heartbeat_at = excluded.heartbeat_at,
      match_id = excluded.match_id,
      matched_at = coalesce(
        public.ranked_queue.matched_at,
        excluded.matched_at
      ),
      cancelled_at = null;

    return query
    select
      queue.status,
      queue.match_id,
      queue.joined_at,
      queue.heartbeat_at,
      queue.rating_snapshot,
      database_now
    from public.ranked_queue as queue
    where queue.user_id = current_user_id;
    return;
  end if;

  if private.user_has_active_match(current_user_id, database_now) then
    raise exception 'Finish or leave your active match before joining ranked matchmaking.';
  end if;

  select queue.*
  into own_queue
  from public.ranked_queue as queue
  where queue.user_id = current_user_id
  for update;

  if found
    and own_queue.status = 'cancelled'
    and own_queue.cancelled_at > database_now - interval '2 seconds' then
    raise exception 'Please wait a moment before rejoining Quick Match.';
  end if;

  if own_queue.user_id is null or own_queue.status <> 'waiting' then
    insert into public.ranked_queue (
      user_id,
      status,
      rating_snapshot,
      joined_at,
      heartbeat_at,
      match_id,
      matched_at,
      cancelled_at
    )
    values (
      current_user_id,
      'waiting',
      current_rating,
      database_now,
      database_now,
      null,
      null,
      null
    )
    on conflict (user_id) do update
    set
      status = 'waiting',
      rating_snapshot = excluded.rating_snapshot,
      joined_at = excluded.joined_at,
      heartbeat_at = excluded.heartbeat_at,
      match_id = null,
      matched_at = null,
      cancelled_at = null;
  else
    update public.ranked_queue as queue
    set heartbeat_at = database_now
    where queue.user_id = current_user_id;
  end if;

  select queue.*
  into own_queue
  from public.ranked_queue as queue
  where queue.user_id = current_user_id
  for update;

  select candidate.*
  into opponent_queue
  from public.ranked_queue as candidate
  where candidate.status = 'waiting'
    and candidate.user_id <> current_user_id
    and candidate.heartbeat_at >= database_now - interval '35 seconds'
    and not exists (
      select 1
      from public.match_players as participant
      join public.matches as match_row
        on match_row.id = participant.match_id
      where participant.player_user_id = candidate.user_id
        and match_row.status in ('waiting', 'starting', 'active')
    )
    and pg_catalog.abs(
      candidate.rating_snapshot - own_queue.rating_snapshot
    ) <= private.rank_gap_for_wait(
      greatest(
        database_now - candidate.joined_at,
        database_now - own_queue.joined_at
      )
    )
  order by
    candidate.joined_at,
    pg_catalog.abs(candidate.rating_snapshot - own_queue.rating_snapshot),
    candidate.user_id
  limit 1
  for update skip locked;

  if opponent_queue.user_id is not null then
    if not private.try_lock_user_activity(opponent_queue.user_id) then
      opponent_queue.user_id := null;
    end if;
  end if;

  if opponent_queue.user_id is not null then
    perform private.cleanup_user_activity(opponent_queue.user_id, database_now);
    if private.user_has_active_match(opponent_queue.user_id, database_now) then
      update public.ranked_queue as queue
      set
        status = 'cancelled',
        cancelled_at = database_now
      where queue.user_id = opponent_queue.user_id
        and queue.status = 'waiting';
      opponent_queue.user_id := null;
    end if;
  end if;

  if opponent_queue.user_id is not null then
    generated_match_id := pg_catalog.gen_random_uuid();
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
    start_time := database_now + interval '5 seconds';

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
      preview_started_at,
      preview_ends_at
    )
    values (
      generated_match_id,
      null,
      'starting',
      null,
      generated_seed,
      60,
      start_time,
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
      database_now,
      start_time
    );

    insert into public.match_players (
      match_id,
      player_user_id,
      player_number
    )
    values
      (generated_match_id, opponent_queue.user_id, 1),
      (generated_match_id, current_user_id, 2);

    update public.ranked_queue as queue
    set
      status = 'matched',
      match_id = generated_match_id,
      matched_at = database_now,
      heartbeat_at = database_now
    where queue.user_id in (opponent_queue.user_id, current_user_id)
      and queue.status = 'waiting';
  end if;

  return query
  select
    queue.status,
    queue.match_id,
    queue.joined_at,
    queue.heartbeat_at,
    queue.rating_snapshot,
    database_now
  from public.ranked_queue as queue
  where queue.user_id = current_user_id;
end;
$$;

revoke all on function public.enter_ranked_queue()
  from public, anon, authenticated;
grant execute on function public.enter_ranked_queue()
  to authenticated;

comment on function public.enter_ranked_queue() is
  'Queues auth.uid() only after canonical stale-state cleanup, recovers an existing ranked match idempotently, and creates a complete revisioned pregame snapshot for exactly one opponent pair.';

create or replace function public.get_match_word_opportunities(
  p_match_id uuid
)
returns table (
  word text,
  word_length integer,
  score integer,
  recognizable boolean,
  was_found boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  match_record public.matches%rowtype;
  player_record public.match_players%rowtype;
  generated_rules_key text;
begin
  select match_row.*
  into match_record
  from public.matches as match_row
  where match_row.id = p_match_id;

  if not found or match_record.status <> 'completed' then
    raise exception 'Possible words are available only after the match is complete.';
  end if;

  select participant.*
  into player_record
  from public.match_players as participant
  where participant.match_id = p_match_id
    and participant.player_user_id = current_user_id;

  if not found then
    raise exception 'You are not a participant in this match.'
      using errcode = '42501';
  end if;

  generated_rules_key := private.board_rules_key(match_record.ruleset);
  perform private.cache_board_solution(
    match_record.board_seed,
    match_record.ruleset
  );

  return query
  select
    solution.word,
    solution.word_length,
    solution.score,
    solution.recognizable,
    exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        coalesce(player_record.validated_words, '[]'::jsonb)
      ) as submitted(value)
      where pg_catalog.upper(submitted.value ->> 'word') = solution.word
    )
  from private.board_solution_words as solution
  where solution.rules_key = generated_rules_key
    and solution.board_seed = match_record.board_seed
  order by
    solution.word_length desc,
    solution.score desc,
    solution.word
  limit 10;
end;
$$;

revoke all on function public.get_match_word_opportunities(uuid)
  from public, anon, authenticated;
grant execute on function public.get_match_word_opportunities(uuid)
  to authenticated;

comment on function public.get_match_word_opportunities(uuid) is
  'Returns only an authenticated completed-match participant top ten, solved from the exact immutable board and ordered by length, score, then alphabetically.';

commit;
