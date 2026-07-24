-- Repair functions deployed by the persistent-account migration that
-- schema-qualified PostgreSQL conditional expressions. COALESCE, NULLIF,
-- GREATEST, and LEAST are SQL syntax constructs, not ordinary functions.

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
        and not coalesce(auth_user.is_anonymous, false)
    );
$$;

revoke all on function private.is_persistent_caller()
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
      coalesce(new.raw_user_meta_data ->> 'display_name', '')
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
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_category, '')));
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
        coalesce((words.value ->> 'score')::integer, 0) as score
    ) as best on true
    group by best.word, best.score
    order by best.score desc, pg_catalog.char_length(best.word) desc, best.word
    limit 1;

    word_count := pg_catalog.jsonb_array_length(player_row.validated_words);
    top_word_score := coalesce(top_word_score, 0);

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
      best_score = greatest(
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
        else least(
          excluded.best_word,
          public.player_mode_stats.best_word
        )
      end,
      best_word_score = greatest(
        public.player_mode_stats.best_word_score,
        excluded.best_word_score
      ),
      current_win_streak = case
        when excluded.wins = 1
          then public.player_mode_stats.current_win_streak + 1
        else 0
      end,
      best_win_streak = greatest(
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
    nullif(
      pg_catalog.lower(pg_catalog.btrim(p_category)),
      ''
    );
  safe_page integer := greatest(
    1,
    least(coalesce(p_page, 1), 10000)
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
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_mode_key, '')));
  safe_page integer := greatest(
    1,
    least(coalesce(p_page, 1), 10000)
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
      pg_catalog.btrim(coalesce(p_public_profile_id, ''))
    );
  safe_page integer := greatest(
    1,
    least(coalesce(p_page, 1), 10000)
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
    reroll_requested_by = coalesce(
      match_row.reroll_requested_by,
      current_user_id
    ),
    reroll_requested_at = coalesce(
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
    set accepted_at = coalesce(
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
  set accepted_at = coalesce(invitation.accepted_at, database_now)
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

commit;
