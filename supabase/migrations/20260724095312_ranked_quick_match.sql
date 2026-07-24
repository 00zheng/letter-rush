begin;

-- Ranked play is additive. Private lobbies keep their existing rules, room
-- codes, result behavior, and statistics isolation.
create type public.match_mode as enum ('private', 'ranked');
create type public.ranked_rating_status as enum (
  'not_applicable',
  'pending',
  'applied',
  'abandoned'
);
create type public.ranked_queue_status as enum (
  'waiting',
  'matched',
  'cancelled',
  'completed'
);

alter table public.matches
  alter column room_code drop not null,
  alter column host_user_id drop not null,
  add column mode public.match_mode not null default 'private',
  add column scoring_version text not null default 'classic-v1',
  add column ranked_ruleset_version text,
  add column rating_status public.ranked_rating_status
    not null default 'not_applicable',
  add column rating_applied_at timestamptz;

comment on column public.matches.mode is
  'Private lobbies and ranked quick matches share authoritative gameplay storage but have separate creation and rating paths.';
comment on column public.matches.rating_status is
  'The match-row lock and this state make ranked Elo/stat application atomic and idempotent.';

create or replace function private.ranked_ruleset()
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select '{
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
  }'::jsonb;
$$;

alter table public.matches
  add constraint matches_ranked_snapshot check (
    (
      mode = 'private'
      and room_code is not null
      and host_user_id is not null
      and ranked_ruleset_version is null
      and rating_status = 'not_applicable'
      and rating_applied_at is null
    )
    or
    (
      mode = 'ranked'
      and room_code is null
      and host_user_id is null
      and max_players = 2
      and round_duration_seconds = 60
      and ruleset = private.ranked_ruleset()
      and dictionary_version = 'enable2k-af52415-v1'
      and board_generation_version = 'weighted-v2'
      and ruleset_version = '2'
      and scoring_version = 'classic-v1'
      and ranked_ruleset_version = 'ranked-v1'
      and rating_status <> 'not_applicable'
      and (
        (rating_status = 'applied' and rating_applied_at is not null)
        or
        (rating_status <> 'applied' and rating_applied_at is null)
      )
    )
  );

create index matches_ranked_status_created_idx
  on public.matches (status, created_at desc, id)
  where mode = 'ranked';

-- Public profile identifiers are opaque, stable, and unrelated to auth UUIDs.
create or replace function private.random_public_profile_id()
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
  from generate_series(1, 10);
$$;

alter table public.profiles
  add column public_profile_id text;

create unique index profiles_public_profile_id_unique_idx
  on public.profiles (public_profile_id)
  where public_profile_id is not null;

do $$
declare
  profile_row record;
  candidate text;
begin
  for profile_row in
    select profile.id
    from public.profiles as profile
    where profile.public_profile_id is null
    order by profile.id
  loop
    loop
      candidate := private.random_public_profile_id();
      begin
        update public.profiles as profile
        set public_profile_id = candidate
        where profile.id = profile_row.id;
        exit;
      exception
        when unique_violation then
          null;
      end;
    end loop;
  end loop;
end;
$$;

alter table public.profiles
  alter column public_profile_id set not null,
  add constraint profiles_public_profile_id_format check (
    public_profile_id ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'
  );

create table public.ranked_stats (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  current_rating integer not null default 1000,
  peak_rating integer not null default 1000,
  games_played integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  ties integer not null default 0,
  forfeits integer not null default 0,
  best_score integer not null default 0,
  total_score bigint not null default 0,
  current_win_streak integer not null default 0,
  best_win_streak integer not null default 0,
  current_unbeaten_streak integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  last_ranked_match_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint ranked_stats_rating_floor check (
    current_rating >= 100 and peak_rating >= current_rating
  ),
  constraint ranked_stats_nonnegative check (
    games_played >= 0
    and wins >= 0
    and losses >= 0
    and ties >= 0
    and forfeits >= 0
    and best_score >= 0
    and total_score >= 0
    and current_win_streak >= 0
    and best_win_streak >= current_win_streak
    and current_unbeaten_streak >= 0
  ),
  constraint ranked_stats_game_totals check (
    games_played = wins + losses + ties
    and forfeits <= losses
  )
);

insert into public.ranked_stats (user_id)
select profile.id
from public.profiles as profile
on conflict (user_id) do nothing;

create index ranked_stats_rating_leaderboard_idx
  on public.ranked_stats (
    current_rating desc,
    peak_rating desc,
    games_played desc,
    user_id
  )
  where games_played > 0;
create index ranked_stats_best_score_leaderboard_idx
  on public.ranked_stats (
    best_score desc,
    current_rating desc,
    games_played,
    user_id
  )
  where games_played > 0;
create index ranked_stats_wins_leaderboard_idx
  on public.ranked_stats (
    wins desc,
    current_rating desc,
    games_played,
    user_id
  )
  where games_played > 0;

create table public.rating_history (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  opponent_user_id uuid not null
    references public.profiles (id) on delete restrict,
  rating_before integer not null,
  rating_delta integer not null,
  rating_after integer not null,
  result_status public.match_result_status not null,
  validated_score integer not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint rating_history_once_per_player_match unique (match_id, user_id),
  constraint rating_history_distinct_players check (
    user_id <> opponent_user_id
  ),
  constraint rating_history_rating_floor check (
    rating_before >= 100
    and rating_after >= 100
    and rating_after = rating_before + rating_delta
  ),
  constraint rating_history_ranked_result check (
    result_status in ('winner', 'loser', 'tie', 'forfeit')
  ),
  constraint rating_history_score_nonnegative check (validated_score >= 0)
);

create index rating_history_user_created_idx
  on public.rating_history (user_id, created_at desc, id desc);
create index rating_history_match_idx
  on public.rating_history (match_id);
create index rating_history_opponent_idx
  on public.rating_history (opponent_user_id, created_at desc);

create table public.ranked_queue (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  status public.ranked_queue_status not null default 'waiting',
  rating_snapshot integer not null,
  joined_at timestamptz not null default clock_timestamp(),
  heartbeat_at timestamptz not null default clock_timestamp(),
  match_id uuid references public.matches (id) on delete set null,
  matched_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint ranked_queue_rating_floor check (rating_snapshot >= 100),
  constraint ranked_queue_state check (
    (
      status = 'waiting'
      and match_id is null
      and matched_at is null
      and cancelled_at is null
    )
    or
    (
      status in ('matched', 'completed')
      and match_id is not null
      and matched_at is not null
      and cancelled_at is null
    )
    or
    (
      status = 'cancelled'
      and match_id is null
      and matched_at is null
      and cancelled_at is not null
    )
  )
);

create index ranked_queue_waiting_match_idx
  on public.ranked_queue (
    joined_at,
    rating_snapshot,
    user_id
  )
  where status = 'waiting';
create index ranked_queue_stale_idx
  on public.ranked_queue (heartbeat_at)
  where status = 'waiting';
create index ranked_queue_match_idx
  on public.ranked_queue (match_id)
  where match_id is not null;

alter table public.ranked_stats enable row level security;
alter table public.rating_history enable row level security;
alter table public.ranked_queue enable row level security;

create policy ranked_stats_select_self
on public.ranked_stats
for select
to authenticated
using (user_id = (select auth.uid()));

create policy rating_history_select_self
on public.rating_history
for select
to authenticated
using (user_id = (select auth.uid()));

create policy ranked_queue_select_self
on public.ranked_queue
for select
to authenticated
using (user_id = (select auth.uid()));

comment on policy ranked_stats_select_self on public.ranked_stats is
  'Raw aggregate rows expose auth UUIDs, so direct access is self-only. Public views use explicitly sanitized SECURITY DEFINER functions.';
comment on policy rating_history_select_self on public.rating_history is
  'A player may inspect only their own raw rating ledger. Public match history is projected through a UUID-free function.';
comment on policy ranked_queue_select_self on public.ranked_queue is
  'Queue membership is private. Matchmaking writes are RPC-only and never trust a client-supplied user ID or rating.';

revoke all on table public.ranked_stats from public, anon, authenticated;
revoke all on table public.rating_history from public, anon, authenticated;
revoke all on table public.ranked_queue from public, anon, authenticated;
grant select on table public.ranked_stats to authenticated;
grant select on table public.rating_history to authenticated;
grant select on table public.ranked_queue to authenticated;
grant usage on type public.match_mode to authenticated;
grant usage on type public.ranked_rating_status to authenticated;
grant usage on type public.ranked_queue_status to authenticated;

-- Existing and future anonymous users receive both an opaque public identity
-- and an isolated ranked-stat row. Collision retries happen inside the trigger.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  guest_number integer;
  candidate text;
begin
  guest_number :=
    (
      (('x' || substr(replace(new.id::text, '-', ''), 1, 8))::bit(32)::bigint)
      % 9000
    )::integer + 1000;

  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = new.id
  ) then
    loop
      candidate := private.random_public_profile_id();
      begin
        insert into public.profiles (id, public_profile_id, display_name)
        values (
          new.id,
          candidate,
          'Guest ' || lpad(guest_number::text, 4, '0')
        );
        exit;
      exception
        when unique_violation then
          if exists (
            select 1
            from public.profiles as profile
            where profile.id = new.id
          ) then
            exit;
          end if;
      end;
    end loop;
  end if;

  insert into public.ranked_stats (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

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

  guest_number :=
    (
      (('x' || substr(replace(p_user_id::text, '-', ''), 1, 8))::bit(32)::bigint)
      % 9000
    )::integer + 1000;

  if not exists (
    select 1 from public.profiles as profile where profile.id = p_user_id
  ) then
    loop
      candidate := private.random_public_profile_id();
      begin
        insert into public.profiles (id, public_profile_id, display_name)
        values (
          p_user_id,
          candidate,
          'Guest ' || lpad(guest_number::text, 4, '0')
        );
        exit;
      exception
        when unique_violation then
          if exists (
            select 1
            from public.profiles as profile
            where profile.id = p_user_id
          ) then
            exit;
          end if;
      end;
    end loop;
  end if;

  insert into public.ranked_stats (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function private.ranked_ruleset()
  from public, anon, authenticated;
revoke all on function private.random_public_profile_id()
  from public, anon, authenticated;
revoke all on function private.ensure_ranked_identity(uuid)
  from public, anon, authenticated;

create trigger ranked_stats_touch_updated_at
before update on public.ranked_stats
for each row execute function private.touch_updated_at();

create trigger ranked_queue_touch_updated_at
before update on public.ranked_queue
for each row execute function private.touch_updated_at();

create or replace function private.expire_stale_ranked_queue(
  p_database_now timestamptz
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  expired_count integer;
begin
  update public.ranked_queue as queue
  set
    status = 'cancelled',
    cancelled_at = p_database_now
  where queue.status = 'waiting'
    and queue.heartbeat_at < p_database_now - interval '35 seconds';

  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

create or replace function private.rank_gap_for_wait(p_wait interval)
returns integer
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_wait > interval '90 seconds' then 2147483647
    else least(
      600,
      150 + floor(
        greatest(0, extract(epoch from p_wait)) / 10
      )::integer * 50
    )
  end;
$$;

revoke all on function private.expire_stale_ranked_queue(timestamptz)
  from public, anon, authenticated;
revoke all on function private.rank_gap_for_wait(interval)
  from public, anon, authenticated;

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
  current_user_id uuid := auth.uid();
  database_now timestamptz := clock_timestamp();
  current_rating integer;
  own_queue public.ranked_queue%rowtype;
  opponent_queue public.ranked_queue%rowtype;
  recovered_match_id uuid;
  generated_match_id uuid;
  generated_seed bigint;
  start_time timestamptz;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  -- One transaction per user may change queue state at a time. Match candidates
  -- are separately row-locked below in a stable queue order.
  perform pg_advisory_xact_lock(
    hashtextextended('ranked-queue:' || current_user_id::text, 0)
  );
  perform private.ensure_ranked_identity(current_user_id);
  perform private.expire_stale_ranked_queue(database_now);

  select match_row.id
  into recovered_match_id
  from public.matches as match_row
  join public.match_players as player
    on player.match_id = match_row.id
  where player.player_user_id = current_user_id
    and match_row.mode = 'ranked'
    and match_row.status in ('starting', 'active')
  order by match_row.created_at desc, match_row.id
  limit 1
  for update of match_row;

  if recovered_match_id is not null then
    select stats.current_rating
    into current_rating
    from public.ranked_stats as stats
    where stats.user_id = current_user_id;

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

  select stats.current_rating
  into current_rating
  from public.ranked_stats as stats
  where stats.user_id = current_user_id;

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
    and abs(candidate.rating_snapshot - own_queue.rating_snapshot)
      <= private.rank_gap_for_wait(
        greatest(
          database_now - candidate.joined_at,
          database_now - own_queue.joined_at
        )
      )
  order by
    candidate.joined_at,
    abs(candidate.rating_snapshot - own_queue.rating_snapshot),
    candidate.user_id
  limit 1
  for update skip locked;

  if opponent_queue.user_id is not null then
    generated_match_id := gen_random_uuid();
    generated_seed := floor(random() * 4294967296)::bigint;
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
      scoring_version,
      ranked_ruleset_version,
      rating_status
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
      'classic-v1',
      'ranked-v1',
      'pending'
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

create or replace function public.heartbeat_ranked_queue()
returns table (
  queue_status public.ranked_queue_status,
  match_id uuid,
  joined_at timestamptz,
  heartbeat_at timestamptz,
  rating_snapshot integer,
  server_now timestamptz
)
language sql
volatile
security definer
set search_path = ''
as $$
  select * from public.enter_ranked_queue();
$$;

create or replace function public.get_ranked_queue_state()
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
  current_user_id uuid := auth.uid();
  database_now timestamptz := clock_timestamp();
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform private.expire_stale_ranked_queue(database_now);

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

create or replace function public.cancel_ranked_queue()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  database_now timestamptz := clock_timestamp();
  locked_queue public.ranked_queue%rowtype;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ranked-queue:' || current_user_id::text, 0)
  );
  perform private.expire_stale_ranked_queue(database_now);

  select queue.*
  into locked_queue
  from public.ranked_queue as queue
  where queue.user_id = current_user_id
  for update;

  if not found or locked_queue.status = 'cancelled' then
    return true;
  end if;

  if locked_queue.status <> 'waiting' then
    raise exception 'A found match cannot be cancelled from the queue.';
  end if;

  update public.ranked_queue as queue
  set
    status = 'cancelled',
    cancelled_at = database_now
  where queue.user_id = current_user_id;

  return true;
end;
$$;

comment on function public.enter_ranked_queue() is
  'Atomic Quick Match entry: derives auth.uid(), snapshots server-owned Elo, expires stale heartbeats, row-locks one compatible opponent with SKIP LOCKED, and creates exactly one fixed two-player ranked match.';
comment on function public.heartbeat_ranked_queue() is
  'Refreshes the caller heartbeat and re-attempts matching so rating windows widen using database time.';
comment on function public.cancel_ranked_queue() is
  'Cancels only the caller waiting row; matched rows cannot be cancelled through this endpoint.';

revoke all on function public.enter_ranked_queue()
  from public, anon;
revoke all on function public.heartbeat_ranked_queue()
  from public, anon;
revoke all on function public.get_ranked_queue_state()
  from public, anon;
revoke all on function public.cancel_ranked_queue()
  from public, anon;
grant execute on function public.enter_ranked_queue()
  to authenticated;
grant execute on function public.heartbeat_ranked_queue()
  to authenticated;
grant execute on function public.get_ranked_queue_state()
  to authenticated;
grant execute on function public.cancel_ranked_queue()
  to authenticated;

create or replace function private.apply_ranked_rating(p_match_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  locked_match public.matches%rowtype;
  player_one public.match_players%rowtype;
  player_two public.match_players%rowtype;
  stats_one public.ranked_stats%rowtype;
  stats_two public.ranked_stats%rowtype;
  expected_one numeric;
  actual_one numeric;
  raw_delta integer;
  rating_delta integer;
  rating_one_after integer;
  rating_two_after integer;
  one_is_win boolean;
  two_is_win boolean;
  one_is_tie boolean;
  two_is_tie boolean;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found or locked_match.mode <> 'ranked' then
    return false;
  end if;

  if locked_match.rating_status = 'applied' then
    return true;
  end if;

  if locked_match.rating_status <> 'pending' then
    return false;
  end if;

  select player.*
  into player_one
  from public.match_players as player
  where player.match_id = p_match_id
    and player.player_number = 1;

  select player.*
  into player_two
  from public.match_players as player
  where player.match_id = p_match_id
    and player.player_number = 2;

  if player_one.player_user_id is null
    or player_two.player_user_id is null
    or player_one.finished_at is null
    or player_two.finished_at is null
    or player_one.result_status = 'pending'
    or player_two.result_status = 'pending' then
    return false;
  end if;

  perform 1
  from public.ranked_stats as stats
  where stats.user_id in (
    player_one.player_user_id,
    player_two.player_user_id
  )
  order by stats.user_id
  for update;

  select stats.*
  into stats_one
  from public.ranked_stats as stats
  where stats.user_id = player_one.player_user_id;

  select stats.*
  into stats_two
  from public.ranked_stats as stats
  where stats.user_id = player_two.player_user_id;

  expected_one := 1 / (
    1 + power(
      10::numeric,
      (stats_two.current_rating - stats_one.current_rating)::numeric / 400
    )
  );
  actual_one := case
    when player_one.result_status = 'winner' then 1
    when player_one.result_status = 'tie' then 0.5
    else 0
  end;
  raw_delta := round(32 * (actual_one - expected_one))::integer;

  -- Clamp to the intersection of both 100-point floors. The mirrored delta
  -- remains integer and zero-sum even at the floor.
  rating_delta := greatest(
    100 - stats_one.current_rating,
    least(stats_two.current_rating - 100, raw_delta)
  );
  rating_one_after := stats_one.current_rating + rating_delta;
  rating_two_after := stats_two.current_rating - rating_delta;

  one_is_win := player_one.result_status = 'winner';
  two_is_win := player_two.result_status = 'winner';
  one_is_tie := player_one.result_status = 'tie';
  two_is_tie := player_two.result_status = 'tie';

  update public.ranked_stats as stats
  set
    current_rating = rating_one_after,
    peak_rating = greatest(stats.peak_rating, rating_one_after),
    games_played = stats.games_played + 1,
    wins = stats.wins + case when one_is_win then 1 else 0 end,
    losses = stats.losses + case
      when player_one.result_status in ('loser', 'forfeit') then 1
      else 0
    end,
    ties = stats.ties + case when one_is_tie then 1 else 0 end,
    forfeits = stats.forfeits + case
      when player_one.result_status = 'forfeit' then 1
      else 0
    end,
    best_score = greatest(stats.best_score, player_one.validated_score),
    total_score = stats.total_score + player_one.validated_score,
    current_win_streak = case
      when one_is_win then stats.current_win_streak + 1
      else 0
    end,
    best_win_streak = greatest(
      stats.best_win_streak,
      case when one_is_win then stats.current_win_streak + 1 else 0 end
    ),
    current_unbeaten_streak = case
      when one_is_win or one_is_tie
        then stats.current_unbeaten_streak + 1
      else 0
    end,
    last_ranked_match_at = clock_timestamp()
  where stats.user_id = player_one.player_user_id;

  update public.ranked_stats as stats
  set
    current_rating = rating_two_after,
    peak_rating = greatest(stats.peak_rating, rating_two_after),
    games_played = stats.games_played + 1,
    wins = stats.wins + case when two_is_win then 1 else 0 end,
    losses = stats.losses + case
      when player_two.result_status in ('loser', 'forfeit') then 1
      else 0
    end,
    ties = stats.ties + case when two_is_tie then 1 else 0 end,
    forfeits = stats.forfeits + case
      when player_two.result_status = 'forfeit' then 1
      else 0
    end,
    best_score = greatest(stats.best_score, player_two.validated_score),
    total_score = stats.total_score + player_two.validated_score,
    current_win_streak = case
      when two_is_win then stats.current_win_streak + 1
      else 0
    end,
    best_win_streak = greatest(
      stats.best_win_streak,
      case when two_is_win then stats.current_win_streak + 1 else 0 end
    ),
    current_unbeaten_streak = case
      when two_is_win or two_is_tie
        then stats.current_unbeaten_streak + 1
      else 0
    end,
    last_ranked_match_at = clock_timestamp()
  where stats.user_id = player_two.player_user_id;

  insert into public.rating_history (
    match_id,
    user_id,
    opponent_user_id,
    rating_before,
    rating_delta,
    rating_after,
    result_status,
    validated_score
  )
  values
    (
      p_match_id,
      player_one.player_user_id,
      player_two.player_user_id,
      stats_one.current_rating,
      rating_delta,
      rating_one_after,
      player_one.result_status,
      player_one.validated_score
    ),
    (
      p_match_id,
      player_two.player_user_id,
      player_one.player_user_id,
      stats_two.current_rating,
      -rating_delta,
      rating_two_after,
      player_two.result_status,
      player_two.validated_score
    );

  return true;
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
  locked_match public.matches%rowtype;
  participant_count integer;
  unfinished_count integer;
  best_score integer;
  top_count integer;
  winning_user_id uuid;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found then
    return false;
  end if;

  if locked_match.status = 'completed' then
    return locked_match.mode = 'private'
      or locked_match.rating_status = 'applied';
  end if;

  select
    count(*)::integer,
    count(*) filter (where player.finished_at is null)::integer
  into participant_count, unfinished_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if participant_count < 2 or unfinished_count > 0 then
    return false;
  end if;

  if locked_match.mode = 'ranked' and participant_count <> 2 then
    raise exception 'A ranked match must contain exactly two players.';
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

  if locked_match.mode = 'ranked'
    and not private.apply_ranked_rating(p_match_id) then
    raise exception 'Ranked rating finalization could not be completed.';
  end if;

  update public.matches as match_row
  set
    status = 'completed',
    completed_at = clock_timestamp(),
    winner_id = winning_user_id,
    is_tie = top_count > 1,
    rating_status = case
      when locked_match.mode = 'ranked'
        then 'applied'::public.ranked_rating_status
      else match_row.rating_status
    end,
    rating_applied_at = case
      when locked_match.mode = 'ranked' then clock_timestamp()
      else match_row.rating_applied_at
    end
  where match_row.id = p_match_id;

  if locked_match.mode = 'ranked' then
    update public.ranked_queue as queue
    set status = 'completed'
    where queue.match_id = p_match_id
      and queue.status = 'matched';
  end if;

  return true;
end;
$$;

comment on function private.apply_ranked_rating(uuid) is
  'Called only while the ranked match row is locked. Locks both stat rows in UUID order, applies K=32 integer zero-sum Elo with a 100 floor, writes one ledger row per player, and commits atomically with match completion.';
comment on function private.finalize_completed_lobby(uuid) is
  'Shared result finalizer. Private lobbies retain score-only results; ranked matches additionally apply Elo and ranked aggregates exactly once.';

revoke all on function private.apply_ranked_rating(uuid)
  from public, anon, authenticated;
revoke all on function private.finalize_completed_lobby(uuid)
  from public, anon, authenticated;

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
      scheduled_start_at = null,
      rating_status = case
        when locked_match.mode = 'ranked'
          then 'abandoned'::public.ranked_rating_status
        else match_row.rating_status
      end
    where match_row.id = p_match_id;

    if locked_match.mode = 'ranked' then
      update public.ranked_queue as queue
      set status = 'completed'
      where queue.match_id = p_match_id
        and queue.status = 'matched';
    end if;

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

comment on function public.finalize_stale_match(uuid) is
  'After the documented 45-second recovery window, one missing ranked submission becomes a forfeit. If neither player submitted, the match is abandoned with no rating or stat change.';

create or replace function public.get_current_ranked_profile()
returns table (
  public_profile_id text,
  display_name text,
  current_rating integer,
  peak_rating integer,
  games_played integer,
  wins integer,
  losses integer,
  ties integer,
  forfeits integer,
  best_score integer,
  total_score bigint,
  current_win_streak integer,
  best_win_streak integer,
  current_unbeaten_streak integer,
  ranked_since timestamptz
)
language plpgsql
stable
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

  return query
  select
    profile.public_profile_id,
    profile.display_name,
    stats.current_rating,
    stats.peak_rating,
    stats.games_played,
    stats.wins,
    stats.losses,
    stats.ties,
    stats.forfeits,
    stats.best_score,
    stats.total_score,
    stats.current_win_streak,
    stats.best_win_streak,
    stats.current_unbeaten_streak,
    stats.created_at
  from public.profiles as profile
  join public.ranked_stats as stats
    on stats.user_id = profile.id
  where profile.id = current_user_id;
end;
$$;

create or replace function public.get_public_player_profile(
  p_public_profile_id text
)
returns table (
  public_profile_id text,
  display_name text,
  current_rating integer,
  peak_rating integer,
  games_played integer,
  wins integer,
  losses integer,
  ties integer,
  forfeits integer,
  best_score integer,
  total_score bigint,
  current_win_streak integer,
  best_win_streak integer,
  current_unbeaten_streak integer,
  ranked_since timestamptz,
  rating_rank bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_id text := upper(btrim(coalesce(p_public_profile_id, '')));
begin
  if normalized_id !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' then
    return;
  end if;

  return query
  with ranked as (
    select
      stats.user_id,
      rank() over (order by stats.current_rating desc) as rating_rank
    from public.ranked_stats as stats
    where stats.games_played > 0
  )
  select
    profile.public_profile_id,
    profile.display_name,
    stats.current_rating,
    stats.peak_rating,
    stats.games_played,
    stats.wins,
    stats.losses,
    stats.ties,
    stats.forfeits,
    stats.best_score,
    stats.total_score,
    stats.current_win_streak,
    stats.best_win_streak,
    stats.current_unbeaten_streak,
    stats.created_at,
    ranked.rating_rank
  from public.profiles as profile
  join public.ranked_stats as stats
    on stats.user_id = profile.id
  left join ranked
    on ranked.user_id = profile.id
  where profile.public_profile_id = normalized_id;
end;
$$;

create or replace function public.get_ranked_leaderboard(
  p_category text,
  p_page integer default 1
)
returns table (
  public_profile_id text,
  display_name text,
  current_rating integer,
  peak_rating integer,
  games_played integer,
  wins integer,
  best_score integer,
  metric_value bigint,
  competition_rank bigint,
  total_players bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_category text := lower(btrim(coalesce(p_category, '')));
  safe_page integer := greatest(1, least(coalesce(p_page, 1), 10000));
begin
  if normalized_category not in ('rating', 'best-score', 'wins') then
    raise exception 'Leaderboard category is invalid.';
  end if;

  return query
  with candidates as (
    select
      profile.public_profile_id,
      profile.display_name,
      stats.current_rating,
      stats.peak_rating,
      stats.games_played,
      stats.wins,
      stats.best_score,
      case normalized_category
        when 'rating' then stats.current_rating::bigint
        when 'best-score' then stats.best_score::bigint
        else stats.wins::bigint
      end as metric_value
    from public.ranked_stats as stats
    join public.profiles as profile
      on profile.id = stats.user_id
    where stats.games_played > 0
  ),
  ranked as (
    select
      candidate.*,
      rank() over (order by candidate.metric_value desc)
        as competition_rank,
      count(*) over () as total_players
    from candidates as candidate
  )
  select
    ranked.public_profile_id,
    ranked.display_name,
    ranked.current_rating,
    ranked.peak_rating,
    ranked.games_played,
    ranked.wins,
    ranked.best_score,
    ranked.metric_value,
    ranked.competition_rank,
    ranked.total_players
  from ranked
  order by
    ranked.metric_value desc,
    case
      when normalized_category = 'rating' then ranked.peak_rating
    end desc,
    case
      when normalized_category <> 'rating' then ranked.current_rating
    end desc,
    case
      when normalized_category = 'rating' then ranked.games_played
    end desc,
    case
      when normalized_category <> 'rating' then ranked.games_played
    end,
    ranked.public_profile_id
  limit 25
  offset ((safe_page - 1) * 25);
end;
$$;

create or replace function public.get_current_ranked_placement(
  p_category text
)
returns table (
  public_profile_id text,
  metric_value bigint,
  competition_rank bigint,
  total_players bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_category text := lower(btrim(coalesce(p_category, '')));
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '28000';
  end if;

  if normalized_category not in ('rating', 'best-score', 'wins') then
    raise exception 'Leaderboard category is invalid.';
  end if;

  return query
  with candidates as (
    select
      stats.user_id,
      case normalized_category
        when 'rating' then stats.current_rating::bigint
        when 'best-score' then stats.best_score::bigint
        else stats.wins::bigint
      end as metric_value
    from public.ranked_stats as stats
    where stats.games_played > 0
  ),
  ranked as (
    select
      candidate.user_id,
      candidate.metric_value,
      rank() over (order by candidate.metric_value desc)
        as competition_rank,
      count(*) over () as total_players
    from candidates as candidate
  )
  select
    profile.public_profile_id,
    ranked.metric_value,
    ranked.competition_rank,
    ranked.total_players
  from ranked
  join public.profiles as profile
    on profile.id = ranked.user_id
  where ranked.user_id = current_user_id;
end;
$$;

create or replace function public.get_public_ranked_matches(
  p_public_profile_id text,
  p_limit integer default 10
)
returns table (
  match_public_id text,
  completed_at timestamptz,
  player_score integer,
  opponent_public_profile_id text,
  opponent_display_name text,
  opponent_score integer,
  result_status public.match_result_status,
  rating_before integer,
  rating_delta integer,
  rating_after integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_id text := upper(btrim(coalesce(p_public_profile_id, '')));
  safe_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
begin
  if normalized_id !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' then
    return;
  end if;

  return query
  select
    md5(match_row.id::text || ':letter-rush-ranked') as match_public_id,
    match_row.completed_at,
    player.validated_score,
    opponent_profile.public_profile_id,
    opponent_profile.display_name,
    opponent.validated_score,
    history.result_status,
    history.rating_before,
    history.rating_delta,
    history.rating_after
  from public.profiles as player_profile
  join public.match_players as player
    on player.player_user_id = player_profile.id
  join public.matches as match_row
    on match_row.id = player.match_id
  join public.match_players as opponent
    on opponent.match_id = match_row.id
    and opponent.player_user_id <> player.player_user_id
  join public.profiles as opponent_profile
    on opponent_profile.id = opponent.player_user_id
  join public.rating_history as history
    on history.match_id = match_row.id
    and history.user_id = player.player_user_id
  where player_profile.public_profile_id = normalized_id
    and match_row.mode = 'ranked'
    and match_row.status = 'completed'
    and match_row.rating_status = 'applied'
  order by match_row.completed_at desc, match_row.id desc
  limit safe_limit;
end;
$$;

create or replace function public.get_ranked_match_result(p_match_id uuid)
returns table (
  public_profile_id text,
  display_name text,
  player_number smallint,
  validated_score integer,
  validated_words jsonb,
  result_status public.match_result_status,
  rating_before integer,
  rating_delta integer,
  rating_after integer,
  match_status public.match_status,
  rating_status public.ranked_rating_status,
  completed_at timestamptz,
  server_now timestamptz
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

  if not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.';
  end if;

  return query
  select
    profile.public_profile_id,
    profile.display_name,
    player.player_number,
    player.validated_score,
    player.validated_words,
    player.result_status,
    history.rating_before,
    history.rating_delta,
    history.rating_after,
    match_row.status,
    match_row.rating_status,
    match_row.completed_at,
    clock_timestamp()
  from public.matches as match_row
  join public.match_players as player
    on player.match_id = match_row.id
  join public.profiles as profile
    on profile.id = player.player_user_id
  left join public.rating_history as history
    on history.match_id = match_row.id
    and history.user_id = player.player_user_id
  where match_row.id = p_match_id
    and match_row.mode = 'ranked'
  order by player.player_number;
end;
$$;

comment on function public.get_public_player_profile(text) is
  'UUID-free public profile projection. It exposes game statistics only, never auth identities or queue state.';
comment on function public.get_ranked_leaderboard(text, integer) is
  'Bounded 25-row all-time leaderboard using competition ranking and deterministic secondary ordering.';
comment on function public.get_public_ranked_matches(text, integer) is
  'Bounded UUID-free public ranked history. The public match identifier is a one-way UUID-derived value, not a database key.';
comment on function public.get_ranked_match_result(uuid) is
  'Participant-only projection for the ranked results screen, including each validated result and atomic rating ledger entry.';

revoke all on function public.get_current_ranked_profile()
  from public, anon;
revoke all on function public.get_public_player_profile(text)
  from public;
revoke all on function public.get_ranked_leaderboard(text, integer)
  from public;
revoke all on function public.get_current_ranked_placement(text)
  from public, anon;
revoke all on function public.get_public_ranked_matches(text, integer)
  from public;
revoke all on function public.get_ranked_match_result(uuid)
  from public, anon;

grant execute on function public.get_current_ranked_profile()
  to authenticated;
grant execute on function public.get_public_player_profile(text)
  to anon, authenticated;
grant execute on function public.get_ranked_leaderboard(text, integer)
  to anon, authenticated;
grant execute on function public.get_current_ranked_placement(text)
  to authenticated;
grant execute on function public.get_public_ranked_matches(text, integer)
  to anon, authenticated;
grant execute on function public.get_ranked_match_result(uuid)
  to authenticated;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ranked_queue'
  ) then
    alter publication supabase_realtime add table public.ranked_queue;
  end if;
end;
$$;

commit;
