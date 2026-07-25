begin;

-- Complete-board analysis is informational. User-facing match creation and
-- rerolls use only this small, bounded letter-distribution check.
create or replace function private.lightweight_board_quality_report(
  p_seed bigint,
  p_ruleset jsonb
)
returns jsonb
language sql
stable
strict
security invoker
set search_path = ''
as $$
  with settings as materialized (
    select
      p_ruleset -> 'activeCells' as active_mask,
      private.generate_board_letters(p_seed, p_ruleset) as letters
  ),
  metrics as (
    select
      pg_catalog.count(*)::integer as active_count,
      pg_catalog.count(*) filter (
        where letter.value in ('A', 'E', 'I', 'O', 'U')
      )::integer as vowel_count,
      pg_catalog.count(*) filter (
        where letter.value in ('J', 'Q', 'X', 'Z')
      )::integer as rare_letter_count
    from settings
    cross join lateral pg_catalog.unnest(settings.letters)
      with ordinality as letter(value, ordinality)
    where (
      settings.active_mask -> (letter.ordinality::integer - 1)
    ) = 'true'::jsonb
      and letter.value is not null
  )
  select pg_catalog.jsonb_build_object(
    'approved',
      metrics.vowel_count >= greatest(
        1,
        pg_catalog.floor(metrics.active_count * 0.18)::integer
      )
      and metrics.vowel_count <=
        pg_catalog.ceil(metrics.active_count * 0.62)::integer
      and metrics.rare_letter_count <= greatest(
        1,
        pg_catalog.ceil(metrics.active_count * 0.10)::integer
      ),
    'activeCells', metrics.active_count,
    'vowelCount', metrics.vowel_count,
    'rareLetterCount', metrics.rare_letter_count
  )
  from metrics;
$$;

revoke all on function private.lightweight_board_quality_report(bigint, jsonb)
  from public, anon, authenticated;

comment on function private.lightweight_board_quality_report(bigint, jsonb) is
  'Performs only bounded board-letter distribution checks; it never traverses the dictionary.';

create or replace function private.select_quality_board_seed(
  p_ruleset jsonb,
  p_excluded_seed bigint default null
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  generated_rules_key text := private.board_rules_key(p_ruleset);
  generated_seed bigint;
  pooled_seed bigint;
  candidate_report jsonb;
  fallback_seed bigint;
  fallback_penalty numeric;
  candidate_penalty numeric;
  attempt integer;
begin
  -- Prepared exact-board pools remain useful, but a locked or empty pool can
  -- never hold up a browser request.
  select pool.board_seed
  into pooled_seed
  from private.custom_board_pool as pool
  where pool.rules_key = generated_rules_key
    and pool.board_seed is distinct from p_excluded_seed
  order by
    pool.use_count,
    pool.last_used_at nulls first,
    pool.board_seed
  limit 1
  for update skip locked;

  if found then
    update private.custom_board_pool as pool
    set
      use_count = pool.use_count + 1,
      last_used_at = pg_catalog.clock_timestamp()
    where pool.rules_key = generated_rules_key
      and pool.board_seed = pooled_seed;
    return pooled_seed;
  end if;

  -- Eight seed checks inspect at most rows*columns generated letters each.
  -- No dictionary row, recursive word path, solution cache, or advisory lock
  -- participates in this synchronous path.
  for attempt in 1..8 loop
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;
    if generated_seed is not distinct from p_excluded_seed then
      generated_seed := mod(generated_seed + 1, 4294967296::bigint);
    end if;

    candidate_report :=
      private.lightweight_board_quality_report(generated_seed, p_ruleset);
    if (candidate_report ->> 'approved')::boolean then
      return generated_seed;
    end if;

    candidate_penalty :=
      pg_catalog.abs(
        (candidate_report ->> 'vowelCount')::numeric -
          (candidate_report ->> 'activeCells')::numeric * 0.40
      ) +
      (candidate_report ->> 'rareLetterCount')::numeric * 4;
    if fallback_penalty is null or candidate_penalty < fallback_penalty then
      fallback_seed := generated_seed;
      fallback_penalty := candidate_penalty;
    end if;
  end loop;

  return fallback_seed;
end;
$$;

revoke all on function private.select_quality_board_seed(jsonb, bigint)
  from public, anon, authenticated;

comment on function private.select_quality_board_seed(jsonb, bigint) is
  'Returns an unlocked prepared seed immediately or chooses a server-owned seed through eight bounded letter-distribution checks without solving the board.';

create or replace function private.enforce_private_board_quality()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_ruleset jsonb;
begin
  if new.mode <> 'private' then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.ruleset is not distinct from old.ruleset
    and new.board_seed is not distinct from old.board_seed then
    return new;
  end if;

  normalized_ruleset := private.validate_game_ruleset(
    new.ruleset,
    new.max_players
  );
  if new.board_seed is null
    or new.board_seed < 0
    or new.board_seed > 4294967295 then
    raise exception 'The server-generated board seed is invalid.'
      using errcode = '22023';
  end if;

  new.ruleset := normalized_ruleset;
  new.round_duration_seconds :=
    (normalized_ruleset ->> 'roundDurationSeconds')::integer;
  new.dictionary_version := normalized_ruleset ->> 'dictionaryVersion';
  new.board_generation_version :=
    normalized_ruleset ->> 'boardGenerationVersion';
  new.ruleset_version := normalized_ruleset ->> 'version';
  return new;
end;
$$;

revoke all on function private.enforce_private_board_quality()
  from public, anon, authenticated;

comment on function private.enforce_private_board_quality() is
  'Validates private rules and a server-owned seed without replacing it or invoking complete-board analysis.';

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
  if not exists (
    select 1
    from private.board_solution_cache as cache
    where cache.rules_key = generated_rules_key
      and cache.board_seed = match_record.board_seed
      and cache.solved_at is not null
  ) then
    return;
  end if;

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
  'Returns an authorized cached top ten immediately and returns no rows on cache miss; it never solves or waits for an advisory lock.';

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

  generated_seed := private.select_quality_board_seed(
    source_match.ruleset,
    source_match.board_seed
  );

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

comment on function public.create_private_rematch(uuid) is
  'Idempotently creates one prior-participant private rematch using fast server-owned seed selection without complete-board analysis.';

commit;
