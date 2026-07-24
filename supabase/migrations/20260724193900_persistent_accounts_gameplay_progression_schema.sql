begin;

create or replace function private.is_persistent_caller()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and exists (
      select 1
      from auth.users as auth_user
      where auth_user.id = auth.uid()
        and not pg_catalog.coalesce(auth_user.is_anonymous, false)
    );
$$;

create or replace function private.require_persistent_caller()
returns uuid
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

  if not private.is_persistent_caller() then
    raise exception 'Create or claim an account to play.'
      using errcode = '28000';
  end if;

  return current_user_id;
end;
$$;

revoke all on function private.is_persistent_caller()
  from public, anon, authenticated;
revoke all on function private.require_persistent_caller()
  from public, anon, authenticated;

-- The auth trigger may initialize an anonymous profile so it can later be
-- claimed in place. Calls made by that anonymous user cannot initialize or use
-- gameplay state until the same auth UUID has been upgraded.
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

  if auth.uid() = p_user_id and not private.is_persistent_caller() then
    raise exception 'Create or claim an account to play.'
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

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_display_name text :=
    pg_catalog.btrim(
      pg_catalog.coalesce(new.raw_user_meta_data ->> 'display_name', '')
    );
begin
  perform private.ensure_ranked_identity(new.id);

  if pg_catalog.char_length(requested_display_name) between 2 and 24
    and requested_display_name !~ '[[:space:]]{2,}'
    and requested_display_name ~ '^[[:alnum:] _''-]+$' then
    update public.profiles as profile
    set display_name = requested_display_name
    where profile.id = new.id;
  end if;

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
  current_user_id uuid := private.require_persistent_caller();
begin
  perform private.ensure_ranked_identity(current_user_id);

  return query
  select profile.display_name, profile.public_profile_id
  from public.profiles as profile
  where profile.id = current_user_id;
end;
$$;

revoke all on function public.ensure_current_player_identity()
  from public, anon, authenticated;
grant execute on function public.ensure_current_player_identity()
  to authenticated;

-- A final database boundary protects old RPC definitions as well as direct
-- table operations. Internal migrations and the auth trigger have no auth.uid()
-- and therefore remain able to repair legacy identities.
create or replace function private.reject_anonymous_gameplay_write()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.is_persistent_caller() then
    raise exception 'Create or claim an account to play.'
      using errcode = '28000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.reject_anonymous_gameplay_write()
  from public, anon, authenticated;

create trigger profiles_require_persistent_write
before insert or update or delete on public.profiles
for each row execute function private.reject_anonymous_gameplay_write();

create trigger matches_require_persistent_write
before insert or update or delete on public.matches
for each row execute function private.reject_anonymous_gameplay_write();

create trigger match_players_require_persistent_write
before insert or update or delete on public.match_players
for each row execute function private.reject_anonymous_gameplay_write();

create trigger ranked_queue_require_persistent_write
before insert or update or delete on public.ranked_queue
for each row execute function private.reject_anonymous_gameplay_write();

-- Canonical saved-mode identity includes every rule input that can alter a
-- board or result. jsonb has deterministic key ordering, so the same immutable
-- snapshot always produces the same key.
create or replace function private.mode_key(
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
    pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_category, '')));
  canonical_rules jsonb;
begin
  if normalized_category not in ('solo', 'ranked', 'private') then
    raise exception 'Mode category is invalid.';
  end if;

  canonical_rules := pg_catalog.jsonb_build_object(
    'category', normalized_category,
    'rows', p_ruleset -> 'rows',
    'columns', p_ruleset -> 'columns',
    'activeCells', p_ruleset -> 'activeCells',
    'roundDurationSeconds', p_ruleset -> 'roundDurationSeconds',
    'minimumWordLength', p_ruleset -> 'minimumWordLength',
    'dictionaryVersion', p_ruleset -> 'dictionaryVersion',
    'scoringRulesVersion', p_ruleset -> 'scoringRulesVersion',
    'boardGenerationVersion', p_ruleset -> 'boardGenerationVersion',
    'rulesetVersion', p_ruleset -> 'version'
  );

  return normalized_category || ':' || pg_catalog.md5(canonical_rules::text);
end;
$$;

revoke all on function private.mode_key(text, jsonb)
  from public, anon, authenticated;

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
    pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_category, '')));
  normalized_shape text :=
    pg_catalog.lower(
      pg_catalog.btrim(pg_catalog.coalesce(p_ruleset ->> 'shape', 'custom'))
    );
  rows_count integer := (p_ruleset ->> 'rows')::integer;
  columns_count integer := (p_ruleset ->> 'columns')::integer;
  duration_seconds integer :=
    (p_ruleset ->> 'roundDurationSeconds')::integer;
begin
  if normalized_category not in ('solo', 'ranked', 'private')
    or normalized_shape not in ('rectangle', 'diamond', 'cross', 'custom')
    or rows_count not between 3 and 8
    or columns_count not between 3 and 8
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

alter table public.matches
  add column mode_key text,
  add column rematch_of uuid references public.matches (id) on delete set null,
  add column preview_started_at timestamptz,
  add column preview_ends_at timestamptz,
  add column reroll_used boolean not null default false,
  add column reroll_status text not null default 'idle',
  add column reroll_requested_by uuid
    references public.profiles (id) on delete set null,
  add column reroll_requested_at timestamptz;

update public.matches as match_row
set
  mode_key = private.mode_key(match_row.mode::text, match_row.ruleset),
  preview_started_at = case
    when match_row.scheduled_start_at is not null
      then match_row.scheduled_start_at - interval '5 seconds'
    else null
  end,
  preview_ends_at = match_row.scheduled_start_at;

alter table public.matches
  alter column mode_key set not null,
  add constraint matches_mode_key_format check (
    mode_key ~ '^(solo|ranked|private):[0-9a-f]{32}$'
  ),
  add constraint matches_reroll_status check (
    reroll_status in ('idle', 'pending', 'declined', 'approved', 'expired')
  ),
  add constraint matches_reroll_state check (
    (
      reroll_status = 'idle'
      and reroll_requested_by is null
      and reroll_requested_at is null
      and not reroll_used
    )
    or
    (
      reroll_status in ('pending', 'declined', 'expired')
      and reroll_requested_by is not null
      and reroll_requested_at is not null
      and not reroll_used
    )
    or
    (
      reroll_status = 'approved'
      and reroll_requested_by is not null
      and reroll_requested_at is not null
      and reroll_used
    )
  ),
  add constraint matches_preview_window check (
    (
      scheduled_start_at is null
      and preview_started_at is null
      and preview_ends_at is null
    )
    or
    (
      mode = 'solo'
      and scheduled_start_at is not null
      and preview_started_at is null
      and preview_ends_at is null
    )
    or
    (
      scheduled_start_at is not null
      and preview_started_at is not null
      and preview_ends_at = scheduled_start_at
      and preview_started_at < preview_ends_at
    )
  );

alter table public.matches
  drop constraint matches_max_players_range,
  add constraint matches_max_players_range check (max_players between 1 and 12);

alter table public.matches drop constraint matches_ranked_snapshot;
alter table public.matches
  add constraint matches_ranked_snapshot check (
    (
      mode = 'private'
      and room_code is not null
      and host_user_id is not null
      and max_players between 2 and 12
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
    or
    (
      mode = 'solo'
      and room_code is null
      and host_user_id is not null
      and max_players = 1
      and ranked_ruleset_version is null
      and rating_status = 'not_applicable'
      and rating_applied_at is null
    )
  );

create unique index matches_ranked_rematch_once_idx
  on public.matches (rematch_of)
  where mode = 'ranked' and rematch_of is not null;
create unique index matches_private_rematch_once_idx
  on public.matches (rematch_of)
  where mode = 'private' and rematch_of is not null;
create index matches_mode_key_completed_idx
  on public.matches (mode_key, completed_at desc, id)
  where status = 'completed';

comment on column public.matches.mode_key is
  'Canonical category-plus-rules snapshot key used to isolate saved statistics.';
comment on column public.matches.preview_ends_at is
  'Authoritative end of the pregame preview; it is also the gameplay start time.';

create or replace function private.initialize_match_preview()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  if new.status = 'starting'
    and (tg_op = 'INSERT' or old.status is distinct from 'starting') then
    new.preview_started_at := database_now;
    new.preview_ends_at := database_now + interval '8 seconds';
    new.scheduled_start_at := new.preview_ends_at;
  elsif tg_op = 'INSERT'
    and new.mode <> 'solo'
    and new.scheduled_start_at is not null
    and new.preview_started_at is null
    and new.preview_ends_at is null then
    new.preview_started_at := new.scheduled_start_at - interval '8 seconds';
    new.preview_ends_at := new.scheduled_start_at;
  elsif tg_op = 'UPDATE'
    and new.status = 'active'
    and old.status = 'starting'
    and new.reroll_status = 'pending' then
    new.reroll_status := 'expired';
  elsif new.scheduled_start_at is null then
    new.preview_started_at := null;
    new.preview_ends_at := null;
  end if;

  new.mode_key := private.mode_key(new.mode::text, new.ruleset);
  return new;
end;
$$;

revoke all on function private.initialize_match_preview()
  from public, anon, authenticated;

create trigger matches_initialize_preview
before insert or update of status, ruleset, mode on public.matches
for each row execute function private.initialize_match_preview();

create table public.player_mode_stats (
  user_id uuid not null references public.profiles (id) on delete cascade,
  mode_key text not null,
  category text not null,
  display_label text not null,
  ruleset jsonb not null,
  games_played integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  ties integer not null default 0,
  forfeits integer not null default 0,
  best_score integer not null default 0,
  total_score bigint not null default 0,
  total_words integer not null default 0,
  best_word text,
  best_word_score integer not null default 0,
  current_win_streak integer not null default 0,
  best_win_streak integer not null default 0,
  current_unbeaten_streak integer not null default 0,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, mode_key),
  constraint player_mode_stats_key_format check (
    mode_key ~ '^(solo|ranked|private):[0-9a-f]{32}$'
  ),
  constraint player_mode_stats_category check (
    category in ('solo', 'ranked', 'private')
  ),
  constraint player_mode_stats_display_label check (
    pg_catalog.char_length(display_label) between 1 and 100
  ),
  constraint player_mode_stats_nonnegative check (
    games_played >= 0
    and wins >= 0
    and losses >= 0
    and ties >= 0
    and forfeits >= 0
    and best_score >= 0
    and total_score >= 0
    and total_words >= 0
    and best_word_score >= 0
    and current_win_streak >= 0
    and best_win_streak >= current_win_streak
    and current_unbeaten_streak >= 0
  ),
  constraint player_mode_stats_result_totals check (
    category = 'solo'
    or games_played = wins + losses + ties
  )
);

create index player_mode_stats_leaderboard_idx
  on public.player_mode_stats (
    mode_key,
    best_score desc,
    games_played desc,
    user_id
  )
  where games_played > 0;

comment on table public.player_mode_stats is
  'Per-auth-user aggregates isolated by a canonical category and immutable rules snapshot. Raw rows are self-only; public comparisons use bounded projections.';

alter table public.player_mode_stats enable row level security;
create policy player_mode_stats_select_self
on public.player_mode_stats
for select
to authenticated
using (
  user_id = (select auth.uid())
  and private.is_persistent_caller()
);

revoke all on table public.player_mode_stats
  from public, anon, authenticated;
grant select on table public.player_mode_stats to authenticated;

create table private.mode_stat_events (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (match_id, user_id)
);

revoke all on table private.mode_stat_events
  from public, anon, authenticated;

create or replace function private.record_mode_statistics(p_match_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  match_row public.matches%rowtype;
  player_row public.match_players%rowtype;
  word_count integer;
  top_word text;
  top_word_score integer;
  inserted_event integer;
begin
  select candidate.*
  into match_row
  from public.matches as candidate
  where candidate.id = p_match_id
    and candidate.status = 'completed';

  if not found then
    return;
  end if;

  for player_row in
    select player.*
    from public.match_players as player
    where player.match_id = p_match_id
      and player.finished_at is not null
      and player.validated_score is not null
    order by player.player_user_id
  loop
    insert into private.mode_stat_events (match_id, user_id)
    values (p_match_id, player_row.player_user_id)
    on conflict do nothing;
    get diagnostics inserted_event = row_count;
    if inserted_event = 0 then
      continue;
    end if;

    select
      pg_catalog.count(*)::integer,
      best.word,
      best.score
    into word_count, top_word, top_word_score
    from pg_catalog.jsonb_array_elements(player_row.validated_words)
      as words(value)
    left join lateral (
      select
        words.value ->> 'word' as word,
        pg_catalog.coalesce((words.value ->> 'score')::integer, 0) as score
    ) as best on true
    group by best.word, best.score
    order by best.score desc, pg_catalog.char_length(best.word) desc, best.word
    limit 1;

    word_count := pg_catalog.jsonb_array_length(player_row.validated_words);
    top_word_score := pg_catalog.coalesce(top_word_score, 0);

    insert into public.player_mode_stats (
      user_id,
      mode_key,
      category,
      display_label,
      ruleset,
      games_played,
      wins,
      losses,
      ties,
      forfeits,
      best_score,
      total_score,
      total_words,
      best_word,
      best_word_score,
      current_win_streak,
      best_win_streak,
      current_unbeaten_streak
    )
    values (
      player_row.player_user_id,
      match_row.mode_key,
      match_row.mode::text,
      private.mode_display_label(match_row.mode::text, match_row.ruleset),
      match_row.ruleset,
      1,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status = 'winner' then 1
        else 0
      end,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status in ('loser', 'forfeit') then 1
        else 0
      end,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status = 'tie' then 1
        else 0
      end,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status = 'forfeit' then 1
        else 0
      end,
      player_row.validated_score,
      player_row.validated_score,
      word_count,
      top_word,
      top_word_score,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status = 'winner' then 1
        else 0
      end,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status = 'winner' then 1
        else 0
      end,
      case
        when match_row.mode <> 'solo'
          and player_row.result_status in ('winner', 'tie') then 1
        else 0
      end
    )
    on conflict (user_id, mode_key) do update
    set
      games_played = public.player_mode_stats.games_played + 1,
      wins = public.player_mode_stats.wins + excluded.wins,
      losses = public.player_mode_stats.losses + excluded.losses,
      ties = public.player_mode_stats.ties + excluded.ties,
      forfeits = public.player_mode_stats.forfeits + excluded.forfeits,
      best_score = pg_catalog.greatest(
        public.player_mode_stats.best_score,
        excluded.best_score
      ),
      total_score =
        public.player_mode_stats.total_score + excluded.total_score,
      total_words =
        public.player_mode_stats.total_words + excluded.total_words,
      best_word = case
        when excluded.best_word_score
          > public.player_mode_stats.best_word_score then excluded.best_word
        when excluded.best_word_score
          < public.player_mode_stats.best_word_score
          then public.player_mode_stats.best_word
        when excluded.best_word is null
          then public.player_mode_stats.best_word
        when public.player_mode_stats.best_word is null
          then excluded.best_word
        when pg_catalog.char_length(excluded.best_word)
          > pg_catalog.char_length(public.player_mode_stats.best_word)
          then excluded.best_word
        when pg_catalog.char_length(excluded.best_word)
          < pg_catalog.char_length(public.player_mode_stats.best_word)
          then public.player_mode_stats.best_word
        else pg_catalog.least(
          excluded.best_word,
          public.player_mode_stats.best_word
        )
      end,
      best_word_score = pg_catalog.greatest(
        public.player_mode_stats.best_word_score,
        excluded.best_word_score
      ),
      current_win_streak = case
        when excluded.wins = 1
          then public.player_mode_stats.current_win_streak + 1
        else 0
      end,
      best_win_streak = pg_catalog.greatest(
        public.player_mode_stats.best_win_streak,
        case
          when excluded.wins = 1
            then public.player_mode_stats.current_win_streak + 1
          else 0
        end
      ),
      current_unbeaten_streak = case
        when excluded.wins = 1 or excluded.ties = 1
          then public.player_mode_stats.current_unbeaten_streak + 1
        else 0
      end,
      updated_at = pg_catalog.clock_timestamp();
  end loop;
end;
$$;

revoke all on function private.record_mode_statistics(uuid)
  from public, anon, authenticated;

create or replace function private.on_match_completed()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed'
    and old.status is distinct from 'completed' then
    perform private.record_mode_statistics(new.id);
  end if;
  return new;
end;
$$;

revoke all on function private.on_match_completed()
  from public, anon, authenticated;

create trigger matches_record_mode_statistics
after update of status on public.matches
for each row execute function private.on_match_completed();

-- A one-player match uses the same immutable match snapshot and the existing
-- submit_match_result validator. This trigger completes it atomically after the
-- first immutable validated submission.
create or replace function private.complete_solo_match()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  match_category public.match_mode;
begin
  if old.finished_at is not null or new.finished_at is null then
    return new;
  end if;

  select match_row.mode
  into match_category
  from public.matches as match_row
  where match_row.id = new.match_id
  for update;

  if match_category <> 'solo' then
    return new;
  end if;

  update public.match_players as player
  set result_status = 'winner'
  where player.match_id = new.match_id
    and player.player_user_id = new.player_user_id;

  update public.matches as match_row
  set
    status = 'completed',
    completed_at = pg_catalog.clock_timestamp(),
    winner_id = new.player_user_id,
    is_tie = false
  where match_row.id = new.match_id
    and match_row.status in ('starting', 'active');

  return new;
end;
$$;

revoke all on function private.complete_solo_match()
  from public, anon, authenticated;

create trigger match_players_complete_solo
after update of finished_at on public.match_players
for each row execute function private.complete_solo_match();

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
declare
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  normalized_ruleset jsonb;
  generated_match_id uuid := pg_catalog.gen_random_uuid();
  generated_seed bigint :=
    pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
  generated_mode_key text;
begin
  perform private.ensure_ranked_identity(current_user_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('solo-session:' || current_user_id::text, 0)
  );

  update public.matches as match_row
  set
    status = 'cancelled',
    scheduled_start_at = null
  from public.match_players as player
  where player.match_id = match_row.id
    and player.player_user_id = current_user_id
    and match_row.mode = 'solo'
    and match_row.status in ('starting', 'active')
    and match_row.scheduled_start_at
      + pg_catalog.make_interval(
        secs => match_row.round_duration_seconds
      )
      + interval '15 seconds' < database_now;

  if exists (
    select 1
    from public.matches as match_row
    join public.match_players as player on player.match_id = match_row.id
    where player.player_user_id = current_user_id
      and match_row.mode = 'solo'
      and match_row.status in ('starting', 'active')
  ) then
    raise exception 'Finish or restore your active solo round first.';
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
    database_now;
end;
$$;

comment on function public.create_solo_session(jsonb) is
  'Creates one server-timed solo match for auth.uid() using a validated immutable ruleset and collision-safe server seed.';
revoke all on function public.create_solo_session(jsonb)
  from public, anon, authenticated;
grant execute on function public.create_solo_session(jsonb)
  to authenticated;

create or replace function public.get_current_mode_stats(
  p_category text default null,
  p_page integer default 1
)
returns table (
  mode_key text,
  category text,
  display_label text,
  ruleset jsonb,
  games_played integer,
  wins integer,
  losses integer,
  ties integer,
  forfeits integer,
  best_score integer,
  total_score bigint,
  total_words integer,
  best_word text,
  best_word_score integer,
  current_win_streak integer,
  best_win_streak integer,
  current_unbeaten_streak integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
  normalized_category text :=
    pg_catalog.nullif(
      pg_catalog.lower(pg_catalog.btrim(p_category)),
      ''
    );
  safe_page integer := pg_catalog.greatest(
    1,
    pg_catalog.least(pg_catalog.coalesce(p_page, 1), 10000)
  );
begin
  if normalized_category is not null
    and normalized_category not in ('solo', 'ranked', 'private') then
    raise exception 'Mode category is invalid.';
  end if;

  return query
  select
    stats.mode_key,
    stats.category,
    stats.display_label,
    stats.ruleset,
    stats.games_played,
    stats.wins,
    stats.losses,
    stats.ties,
    stats.forfeits,
    stats.best_score,
    stats.total_score,
    stats.total_words,
    stats.best_word,
    stats.best_word_score,
    stats.current_win_streak,
    stats.best_win_streak,
    stats.current_unbeaten_streak,
    stats.updated_at
  from public.player_mode_stats as stats
  where stats.user_id = current_user_id
    and (
      normalized_category is null
      or stats.category = normalized_category
    )
  order by stats.updated_at desc, stats.mode_key
  limit 25 offset ((safe_page - 1) * 25);
end;
$$;

revoke all on function public.get_current_mode_stats(text, integer)
  from public, anon, authenticated;
grant execute on function public.get_current_mode_stats(text, integer)
  to authenticated;

create or replace function public.get_public_mode_leaderboard(
  p_mode_key text,
  p_page integer default 1
)
returns table (
  public_profile_id text,
  display_name text,
  mode_key text,
  category text,
  games_played integer,
  wins integer,
  ties integer,
  best_score integer,
  total_score bigint,
  total_words integer,
  best_word text,
  best_word_score integer,
  competition_rank bigint,
  total_players bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_key text :=
    pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_mode_key, '')));
  safe_page integer := pg_catalog.greatest(
    1,
    pg_catalog.least(pg_catalog.coalesce(p_page, 1), 10000)
  );
begin
  if normalized_key !~ '^(solo|ranked|private):[0-9a-f]{32}$' then
    return;
  end if;

  return query
  with ranked as (
    select
      stats.user_id,
      stats.mode_key,
      stats.category,
      stats.games_played,
      stats.wins,
      stats.ties,
      stats.best_score,
      stats.total_score,
      stats.total_words,
      stats.best_word,
      stats.best_word_score,
      pg_catalog.rank() over (
        order by
          stats.best_score desc,
          stats.total_score desc,
          stats.games_played
      ) as competition_rank,
      pg_catalog.count(*) over () as total_players
    from public.player_mode_stats as stats
    where stats.mode_key = normalized_key
      and stats.games_played > 0
  )
  select
    profile.public_profile_id,
    profile.display_name,
    ranked.mode_key,
    ranked.category,
    ranked.games_played,
    ranked.wins,
    ranked.ties,
    ranked.best_score,
    ranked.total_score,
    ranked.total_words,
    ranked.best_word,
    ranked.best_word_score,
    ranked.competition_rank,
    ranked.total_players
  from ranked
  join public.profiles as profile on profile.id = ranked.user_id
  order by
    ranked.best_score desc,
    ranked.total_score desc,
    ranked.games_played,
    profile.public_profile_id
  limit 25 offset ((safe_page - 1) * 25);
end;
$$;

revoke all on function public.get_public_mode_leaderboard(text, integer)
  from public, anon, authenticated;
grant execute on function public.get_public_mode_leaderboard(text, integer)
  to anon, authenticated;

create or replace function public.get_public_player_mode_stats(
  p_public_profile_id text,
  p_page integer default 1
)
returns table (
  mode_key text,
  category text,
  display_label text,
  ruleset jsonb,
  games_played integer,
  wins integer,
  losses integer,
  ties integer,
  best_score integer,
  total_score bigint,
  total_words integer,
  best_word text,
  best_word_score integer,
  current_win_streak integer,
  best_win_streak integer,
  current_unbeaten_streak integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_id text :=
    pg_catalog.upper(
      pg_catalog.btrim(pg_catalog.coalesce(p_public_profile_id, ''))
    );
  safe_page integer := pg_catalog.greatest(
    1,
    pg_catalog.least(pg_catalog.coalesce(p_page, 1), 10000)
  );
begin
  if normalized_id !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' then
    return;
  end if;

  return query
  select
    stats.mode_key,
    stats.category,
    stats.display_label,
    stats.ruleset,
    stats.games_played,
    stats.wins,
    stats.losses,
    stats.ties,
    stats.best_score,
    stats.total_score,
    stats.total_words,
    stats.best_word,
    stats.best_word_score,
    stats.current_win_streak,
    stats.best_win_streak,
    stats.current_unbeaten_streak,
    stats.updated_at
  from public.profiles as profile
  join public.player_mode_stats as stats on stats.user_id = profile.id
  where profile.public_profile_id = normalized_id
  order by stats.updated_at desc, stats.mode_key
  limit 25 offset ((safe_page - 1) * 25);
end;
$$;

revoke all on function public.get_public_player_mode_stats(text, integer)
  from public, anon, authenticated;
grant execute on function public.get_public_player_mode_stats(text, integer)
  to anon, authenticated;

create table public.match_reroll_votes (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  approve boolean not null,
  voted_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (match_id, user_id)
);

comment on table public.match_reroll_votes is
  'Durable participant votes during the bounded pregame preview. Writes are RPC-only and unanimous approval can consume at most one reroll.';

alter table public.match_reroll_votes enable row level security;
create policy match_reroll_votes_participant_select
on public.match_reroll_votes
for select
to authenticated
using (
  private.is_persistent_caller()
  and private.is_match_participant(match_id, (select auth.uid()))
);
revoke all on table public.match_reroll_votes
  from public, anon, authenticated;
grant select on table public.match_reroll_votes to authenticated;

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
  current_user_id uuid := private.require_persistent_caller();
  database_now timestamptz := pg_catalog.clock_timestamp();
  locked_match public.matches%rowtype;
  approval_count integer;
  decline_count integer;
  player_count integer;
  next_seed bigint;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'You are not a participant in this match.';
  end if;
  if locked_match.mode not in ('ranked', 'private')
    or locked_match.status <> 'starting'
    or locked_match.preview_ends_at is null
    or database_now >= locked_match.preview_ends_at then
    raise exception 'Reroll voting is closed.';
  end if;
  if locked_match.reroll_used then
    raise exception 'This match already used its one reroll.';
  end if;
  if locked_match.reroll_status in ('declined', 'expired') then
    raise exception 'Reroll voting is closed.';
  end if;

  insert into public.match_reroll_votes (match_id, user_id, approve)
  values (p_match_id, current_user_id, p_approve)
  on conflict (match_id, user_id) do update
  set
    approve = public.match_reroll_votes.approve and excluded.approve,
    voted_at = database_now;

  update public.matches as match_row
  set
    reroll_status = case when p_approve then 'pending' else 'declined' end,
    reroll_requested_by = pg_catalog.coalesce(
      match_row.reroll_requested_by,
      current_user_id
    ),
    reroll_requested_at = pg_catalog.coalesce(
      match_row.reroll_requested_at,
      database_now
    )
  where match_row.id = p_match_id
    and match_row.reroll_status = 'idle';

  select
    pg_catalog.count(*) filter (where vote.approve)::integer,
    pg_catalog.count(*) filter (where not vote.approve)::integer
  into approval_count, decline_count
  from public.match_reroll_votes as vote
  where vote.match_id = p_match_id;

  if decline_count > 0 then
    update public.matches as match_row
    set reroll_status = 'declined'
    where match_row.id = p_match_id;
    locked_match.reroll_status := 'declined';
  end if;

  select pg_catalog.count(*)::integer
  into player_count
  from public.match_players as player
  where player.match_id = p_match_id;

  if approval_count = player_count and decline_count = 0 then
    next_seed := pg_catalog.floor(
      pg_catalog.random() * 4294967296
    )::bigint;
    if next_seed = locked_match.board_seed then
      next_seed := (next_seed + 1) % 4294967296;
    end if;

    update public.matches as match_row
    set
      board_seed = next_seed,
      reroll_used = true,
      reroll_status = 'approved',
      preview_started_at = database_now,
      preview_ends_at = database_now + interval '8 seconds',
      scheduled_start_at = database_now + interval '8 seconds'
    where match_row.id = p_match_id;

    delete from public.match_reroll_votes as vote
    where vote.match_id = p_match_id;

    locked_match.board_seed := next_seed;
    locked_match.preview_ends_at := database_now + interval '8 seconds';
    locked_match.reroll_used := true;
    locked_match.reroll_status := 'approved';
    approval_count := 0;
    decline_count := 0;
  end if;

  return query
  select
    locked_match.reroll_used,
    approval_count,
    decline_count,
    player_count,
    locked_match.board_seed,
    locked_match.preview_ends_at,
    database_now;
end;
$$;

revoke all on function public.vote_match_reroll(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.vote_match_reroll(uuid, boolean)
  to authenticated;

create type public.rematch_proposal_status as enum (
  'pending',
  'accepted',
  'declined',
  'expired'
);

create table public.ranked_rematch_proposals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  source_match_id uuid not null unique
    references public.matches (id) on delete cascade,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  status public.rematch_proposal_status not null default 'pending',
  expires_at timestamptz not null,
  created_match_id uuid unique
    references public.matches (id) on delete set null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  responded_at timestamptz,
  constraint ranked_rematch_proposal_state check (
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
      status in ('declined', 'expired')
      and responded_at is not null
      and created_match_id is null
    )
  )
);

comment on table public.ranked_rematch_proposals is
  'One transaction-locked 30-second proposal per completed ranked match. Acceptance points to exactly one new ranked match.';

alter table public.ranked_rematch_proposals enable row level security;
create policy ranked_rematch_participant_select
on public.ranked_rematch_proposals
for select
to authenticated
using (
  private.is_persistent_caller()
  and private.is_match_participant(source_match_id, (select auth.uid()))
);
revoke all on table public.ranked_rematch_proposals
  from public, anon, authenticated;
grant select on table public.ranked_rematch_proposals to authenticated;
grant usage on type public.rematch_proposal_status to authenticated;

create table public.private_rematch_invitations (
  match_id uuid not null references public.matches (id) on delete cascade,
  invited_user_id uuid not null
    references public.profiles (id) on delete cascade,
  source_match_id uuid not null
    references public.matches (id) on delete cascade,
  accepted_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (match_id, invited_user_id),
  constraint private_rematch_invitation_response check (
    accepted_at is null or declined_at is null
  )
);

comment on table public.private_rematch_invitations is
  'Prior private participants are notified but join the new waiting lobby explicitly, so an invitation never forces an unrelated active match.';

alter table public.private_rematch_invitations enable row level security;
create policy private_rematch_invitation_select
on public.private_rematch_invitations
for select
to authenticated
using (
  private.is_persistent_caller()
  and invited_user_id = (select auth.uid())
);
revoke all on table public.private_rematch_invitations
  from public, anon, authenticated;
grant select on table public.private_rematch_invitations to authenticated;

create or replace function private.has_active_match(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.match_players as player
    join public.matches as match_row on match_row.id = player.match_id
    where player.player_user_id = p_user_id
      and match_row.status in ('starting', 'active')
  );
$$;

revoke all on function private.has_active_match(uuid)
  from public, anon, authenticated;

create or replace function public.request_ranked_rematch(p_match_id uuid)
returns table (
  proposal_id uuid,
  proposal_status public.rematch_proposal_status,
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
  locked_match public.matches%rowtype;
  proposal public.ranked_rematch_proposals%rowtype;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or locked_match.mode <> 'ranked'
    or locked_match.status <> 'completed'
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'Only a completed ranked match participant can request a rematch.';
  end if;
  if private.has_active_match(current_user_id) then
    raise exception 'Finish your active match before requesting a rematch.';
  end if;

  insert into public.ranked_rematch_proposals (
    source_match_id,
    requester_id,
    expires_at
  )
  values (p_match_id, current_user_id, database_now + interval '30 seconds')
  on conflict (source_match_id) do nothing;

  select candidate.*
  into proposal
  from public.ranked_rematch_proposals as candidate
  where candidate.source_match_id = p_match_id;

  return query
  select proposal.id, proposal.status, proposal.expires_at, database_now;
end;
$$;

revoke all on function public.request_ranked_rematch(uuid)
  from public, anon, authenticated;
grant execute on function public.request_ranked_rematch(uuid)
  to authenticated;

create or replace function public.respond_ranked_rematch(
  p_proposal_id uuid,
  p_accept boolean
)
returns table (
  proposal_status public.rematch_proposal_status,
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
  proposal public.ranked_rematch_proposals%rowtype;
  source_match public.matches%rowtype;
  opponent_id uuid;
  generated_match_id uuid;
  generated_seed bigint;
begin
  select candidate.*
  into proposal
  from public.ranked_rematch_proposals as candidate
  where candidate.id = p_proposal_id
  for update;

  if not found or proposal.status <> 'pending' then
    raise exception 'This rematch proposal is no longer pending.';
  end if;
  if database_now >= proposal.expires_at then
    update public.ranked_rematch_proposals as candidate
    set status = 'expired', responded_at = database_now
    where candidate.id = p_proposal_id;
    return query
    select
      'expired'::public.rematch_proposal_status,
      null::uuid,
      proposal.expires_at,
      database_now;
    return;
  end if;
  if proposal.requester_id = current_user_id
    or not private.is_match_participant(
      proposal.source_match_id,
      current_user_id
    ) then
    raise exception 'Only the other participant can answer this proposal.';
  end if;

  if not p_accept then
    update public.ranked_rematch_proposals as candidate
    set status = 'declined', responded_at = database_now
    where candidate.id = p_proposal_id;
    return query
    select
      'declined'::public.rematch_proposal_status,
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

  select player.player_user_id
  into opponent_id
  from public.match_players as player
  where player.match_id = proposal.source_match_id
    and player.player_user_id <> proposal.requester_id;

  if private.has_active_match(proposal.requester_id)
    or private.has_active_match(current_user_id) then
    raise exception 'Both players must be free of active matches.';
  end if;

  generated_match_id := pg_catalog.gen_random_uuid();
  generated_seed :=
    pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;

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
    proposal.source_match_id
  );

  insert into public.match_players (
    match_id,
    player_user_id,
    player_number
  )
  values
    (generated_match_id, proposal.requester_id, 1),
    (generated_match_id, opponent_id, 2);

  update public.ranked_rematch_proposals as candidate
  set
    status = 'accepted',
    responded_at = database_now,
    created_match_id = generated_match_id
  where candidate.id = p_proposal_id;

  return query
  select
    'accepted'::public.rematch_proposal_status,
    generated_match_id,
    proposal.expires_at,
    database_now;
end;
$$;

revoke all on function public.respond_ranked_rematch(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.respond_ranked_rematch(uuid, boolean)
  to authenticated;

create or replace function public.create_private_rematch(p_match_id uuid)
returns table (
  match_id uuid,
  room_code text,
  board_seed bigint,
  max_players smallint,
  ruleset jsonb,
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
  source_match public.matches%rowtype;
  existing_match public.matches%rowtype;
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  attempt integer;
begin
  select match_row.*
  into source_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or source_match.mode <> 'private'
    or source_match.status <> 'completed'
    or not private.is_match_participant(p_match_id, current_user_id) then
    raise exception 'Only a completed private match participant can create a rematch.';
  end if;
  if private.has_active_match(current_user_id) then
    raise exception 'Finish your active match before creating a rematch.';
  end if;

  select candidate.*
  into existing_match
  from public.matches as candidate
  where candidate.rematch_of = p_match_id
    and candidate.mode = 'private';

  if found then
    return query
    select
      existing_match.id,
      existing_match.room_code,
      existing_match.board_seed,
      existing_match.max_players,
      existing_match.ruleset,
      database_now;
    return;
  end if;

  for attempt in 1..12 loop
    generated_match_id := pg_catalog.gen_random_uuid();
    generated_room_code := private.random_room_code();
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
    begin
      insert into public.matches (
        id,
        room_code,
        status,
        host_user_id,
        board_seed,
        round_duration_seconds,
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
        'waiting',
        current_user_id,
        generated_seed,
        source_match.round_duration_seconds,
        source_match.max_players,
        source_match.ruleset,
        source_match.dictionary_version,
        source_match.board_generation_version,
        source_match.ruleset_version,
        'private',
        private.mode_key('private', source_match.ruleset),
        source_match.scoring_version,
        null,
        'not_applicable',
        p_match_id
      );

      insert into public.match_players (
        match_id,
        player_user_id,
        player_number
      )
      values (generated_match_id, current_user_id, 1);

      insert into public.private_rematch_invitations (
        match_id,
        invited_user_id,
        source_match_id
      )
      select
        generated_match_id,
        player.player_user_id,
        p_match_id
      from public.match_players as player
      where player.match_id = p_match_id
        and player.player_user_id <> current_user_id;

      return query
      select
        generated_match_id,
        generated_room_code,
        generated_seed,
        source_match.max_players,
        source_match.ruleset,
        database_now;
      return;
    exception
      when unique_violation then
        if exists (
          select 1
          from public.matches as candidate
          where candidate.rematch_of = p_match_id
            and candidate.mode = 'private'
        ) then
          select candidate.*
          into existing_match
          from public.matches as candidate
          where candidate.rematch_of = p_match_id
            and candidate.mode = 'private';
          return query
          select
            existing_match.id,
            existing_match.room_code,
            existing_match.board_seed,
            existing_match.max_players,
            existing_match.ruleset,
            database_now;
          return;
        end if;
    end;
  end loop;

  raise exception 'A unique rematch room could not be generated. Try again.';
end;
$$;

revoke all on function public.create_private_rematch(uuid)
  from public, anon, authenticated;
grant execute on function public.create_private_rematch(uuid)
  to authenticated;

create or replace function public.accept_private_rematch_invite(p_match_id uuid)
returns table (
  match_id uuid,
  room_code text,
  player_number smallint,
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
  available_number integer;
begin
  select match_row.*
  into locked_match
  from public.matches as match_row
  where match_row.id = p_match_id
  for update;

  if not found
    or locked_match.mode <> 'private'
    or locked_match.status <> 'waiting'
    or not exists (
      select 1
      from public.private_rematch_invitations as invitation
      where invitation.match_id = p_match_id
        and invitation.invited_user_id = current_user_id
        and invitation.declined_at is null
    ) then
    raise exception 'This private rematch invitation is unavailable.';
  end if;
  if private.has_active_match(current_user_id) then
    raise exception 'Finish your active match before joining a rematch.';
  end if;

  select player.player_number
  into available_number
  from public.match_players as player
  where player.match_id = p_match_id
    and player.player_user_id = current_user_id;

  if available_number is not null then
    update public.private_rematch_invitations as invitation
    set accepted_at = pg_catalog.coalesce(
      invitation.accepted_at,
      database_now
    )
    where invitation.match_id = p_match_id
      and invitation.invited_user_id = current_user_id;

    return query
    select
      locked_match.id,
      locked_match.room_code,
      available_number::smallint,
      database_now;
    return;
  end if;

  select candidate.player_number
  into available_number
  from pg_catalog.generate_series(
    2,
    locked_match.max_players
  ) as candidate(player_number)
  where not exists (
    select 1
    from public.match_players as player
    where player.match_id = p_match_id
      and player.player_number = candidate.player_number
  )
  order by candidate.player_number
  limit 1;

  if available_number is null then
    raise exception 'That private rematch lobby is full.';
  end if;

  insert into public.match_players (
    match_id,
    player_user_id,
    player_number
  )
  values (p_match_id, current_user_id, available_number)
  on conflict (match_id, player_user_id) do nothing;

  update public.private_rematch_invitations as invitation
  set accepted_at = pg_catalog.coalesce(invitation.accepted_at, database_now)
  where invitation.match_id = p_match_id
    and invitation.invited_user_id = current_user_id;

  return query
  select
    locked_match.id,
    locked_match.room_code,
    available_number::smallint,
    database_now;
end;
$$;

revoke all on function public.accept_private_rematch_invite(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_private_rematch_invite(uuid)
  to authenticated;

create or replace function public.get_pending_private_rematches()
returns table (
  match_id uuid,
  room_code text,
  source_match_id uuid,
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
begin
  return query
  select
    invitation.match_id,
    match_row.room_code,
    invitation.source_match_id,
    match_row.created_at + interval '2 hours',
    invitation.created_at
  from public.private_rematch_invitations as invitation
  join public.matches as match_row on match_row.id = invitation.match_id
  where invitation.invited_user_id = current_user_id
    and invitation.accepted_at is null
    and invitation.declined_at is null
    and match_row.status = 'waiting'
    and match_row.created_at > pg_catalog.clock_timestamp() - interval '2 hours'
  order by invitation.created_at desc
  limit 25;
end;
$$;

revoke all on function public.get_pending_private_rematches()
  from public, anon, authenticated;
grant execute on function public.get_pending_private_rematches()
  to authenticated;

create or replace function public.get_ranked_rematch_state(p_match_id uuid)
returns table (
  proposal_id uuid,
  proposal_status public.rematch_proposal_status,
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
    raise exception 'You are not a participant in this match.';
  end if;

  update public.ranked_rematch_proposals as proposal
  set status = 'expired', responded_at = database_now
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
  from public.ranked_rematch_proposals as proposal
  where proposal.source_match_id = p_match_id;
end;
$$;

revoke all on function public.get_ranked_rematch_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_ranked_rematch_state(uuid)
  to authenticated;

comment on function public.vote_match_reroll(uuid, boolean) is
  'Records the authenticated participant vote. Only unanimous current participants can atomically consume the one reroll and restart the eight-second preview.';
comment on function public.respond_ranked_rematch(uuid, boolean) is
  'The non-requesting participant accepts or declines a locked 30-second proposal; acceptance creates exactly one fixed ranked match with a new server seed.';
comment on function public.create_private_rematch(uuid) is
  'Idempotently creates one new waiting lobby from an immutable completed private snapshot and invites prior participants without adding them to an active match.';
comment on function private.is_persistent_caller() is
  'Checks the authenticated Supabase user record without exposing auth.users to client roles.';
comment on function private.require_persistent_caller() is
  'Returns only auth.uid() after enforcing that gameplay uses a non-anonymous Supabase account.';
comment on function private.ensure_ranked_identity(uuid) is
  'Transaction-locks canonical profile and ranked-stat creation; it is private so callers cannot initialize an arbitrary user ID.';
comment on function private.handle_new_auth_user() is
  'Trusted auth.users trigger that initializes the new auth UUID and applies only validated display-name metadata.';
comment on function public.ensure_current_player_identity() is
  'Initializes only auth.uid() and returns the bounded public identity projection without exposing the auth UUID.';
comment on function private.reject_anonymous_gameplay_write() is
  'Trigger boundary preventing anonymous sessions from mutating gameplay tables through legacy or direct paths.';
comment on function private.initialize_match_preview() is
  'Trigger that owns canonical mode keys and server-timed pregame preview transitions.';
comment on function private.record_mode_statistics(uuid) is
  'Applies validated completed-match aggregates exactly once through a private idempotency ledger.';
comment on function private.on_match_completed() is
  'Completion trigger that invokes authoritative mode-stat aggregation after the match becomes immutable.';
comment on function private.complete_solo_match() is
  'Completes one-player matches only after the existing server-validated submission path stores a result.';
comment on function public.get_current_mode_stats(text, integer) is
  'Returns a bounded self-only saved-mode projection for auth.uid().';
comment on function public.get_public_mode_leaderboard(text, integer) is
  'Returns a bounded UUID-free public leaderboard for a validated canonical mode key.';
comment on function public.get_public_player_mode_stats(text, integer) is
  'Returns bounded sanitized mode statistics selected only by opaque public profile ID.';
comment on function private.has_active_match(uuid) is
  'Private active-match check used only after public rematch RPCs derive and validate participants.';
comment on function public.request_ranked_rematch(uuid) is
  'Allows only a completed ranked participant to create the single locked 30-second proposal.';
comment on function public.accept_private_rematch_invite(uuid) is
  'Joins auth.uid() only when a durable prior-participant invitation exists for the waiting rematch.';
comment on function public.get_pending_private_rematches() is
  'Returns only unexpired private rematch invitations addressed to auth.uid().';
comment on function public.get_ranked_rematch_state(uuid) is
  'Returns and expires only the ranked rematch proposal visible to an authenticated source-match participant.';

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'match_reroll_votes'
    ) then
      alter publication supabase_realtime
        add table public.match_reroll_votes;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'ranked_rematch_proposals'
    ) then
      alter publication supabase_realtime
        add table public.ranked_rematch_proposals;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'private_rematch_invitations'
    ) then
      alter publication supabase_realtime
        add table public.private_rematch_invitations;
    end if;
  end if;
end;
$$;

-- New public objects are not implicitly available through the Data API.
grant usage on schema public to anon, authenticated;

commit;
