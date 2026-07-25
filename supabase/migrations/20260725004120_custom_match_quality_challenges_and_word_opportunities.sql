begin;

-- Custom rounds expose one familiar 60-second choice plus a bounded custom
-- value. Ranked remains locked to its immutable 60-second snapshot.
alter table public.matches
  drop constraint matches_round_duration_range,
  add constraint matches_round_duration_range check (
    round_duration_seconds between 10 and 180
  );

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

  if duration_seconds not between 10 and 180 then
    raise exception 'Round duration must be from 10 through 180 seconds.';
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
  'Validates 3-10 dimensions, a whole-number 10-180 second duration, immutable versions, connectivity, and canonical server-generated masks.';

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
    or duration_seconds not between 10 and 180 then
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

-- Prefix probes are the pruning boundary for the exact adjacency solver.
create index if not exists approved_words_prefix_search_idx
  on private.approved_words (
    dictionary_version,
    word text_pattern_ops
  );

create table private.common_game_words (
  dictionary_version text not null,
  word text not null,
  frequency_rank integer not null,
  primary key (dictionary_version, word),
  constraint common_game_words_rank_positive check (frequency_rank > 0),
  constraint common_game_words_lower_alpha check (
    word = pg_catalog.lower(word)
    and word ~ '^[a-z]+$'
  )
);

-- This compact, reviewed vocabulary is used only as a recognizability signal.
-- Every entry is intersected with the authoritative ENABLE dictionary.
insert into private.common_game_words (
  dictionary_version,
  word,
  frequency_rank
)
select
  'enable2k-af52415-v1',
  source.word,
  source.frequency_rank::integer
from pg_catalog.regexp_split_to_table(
  pg_catalog.btrim($common_words$
about above accept across act action add after again age ago agree ahead air
all allow almost alone along already also always among amount animal answer
appear apple area arm around arrive art ask attack avoid away baby back bad
ball bank base basic be bear beat beautiful because become bed before begin
behind believe best better big bird bit black blood blue board boat body book
born both box boy break bring brother build burn business buy call can car
care carry case cat catch cause cell center chair chance change check child
choice choose city class clear close cold color come common company complete
consider continue control cook cool copy corner cost could country course
cover create cross cry cut dance dark day dead deal decide deep develop die
different difficult dinner dog door down draw dream drive drop during each
early earth east easy eat edge end enjoy enough enter even ever every example
eye face fact fall family far fast father feel few field fight fill final find
fine fire first fish five floor fly follow food foot force form four free
friend front full fun game garden get girl give glass go good great green
ground group grow guess hair half hand happen happy hard have head hear heart
heavy help high hold home hope horse hot hour house human idea important inside
into job join jump just keep key kid kill kind king know land large last late
later laugh lead learn leave left leg less let letter life light like line list
little live long look lose love low machine main make man many map mark matter
may mean meet men middle might mind miss moment money month more morning most
mother move much music must name near need never new next night nine north
note nothing notice now number offer often old once one only open order other
out outside over own page paper parent part party pass past pay people perhaps
person pick picture place plan plant play point possible power problem pull
push put quick quite rain read ready real reason red remember rest right river
road rock room round rule run same save say school sea second see seem set
seven shape share she ship short show side simple since sing sister sit six
sleep small smile snow some song soon sound south space speak special spend
stand star start state stay step still stop story street strong study such
summer sun sure swim table take talk teach tell ten test than thank that the
their them then there they thing think three through time together too top
town tree true try turn two under until up use very wait walk want warm watch
water way week well west what when where which white who whole why win wind
with woman wonder word work world would write wrong year yellow yes yet young
$common_words$),
  '[[:space:]]+'
) with ordinality as source(word, frequency_rank)
join private.approved_words as dictionary
  on dictionary.dictionary_version = 'enable2k-af52415-v1'
  and dictionary.word = source.word
where pg_catalog.char_length(source.word) >= 3
on conflict (dictionary_version, word) do nothing;

revoke all on table private.common_game_words
  from public, anon, authenticated;

create or replace function private.board_rules_key(p_ruleset jsonb)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'rows', p_ruleset -> 'rows',
      'columns', p_ruleset -> 'columns',
      'activeCells', p_ruleset -> 'activeCells',
      'minimumWordLength', p_ruleset -> 'minimumWordLength',
      'dictionaryVersion', p_ruleset -> 'dictionaryVersion',
      'boardGenerationVersion', p_ruleset -> 'boardGenerationVersion'
    )::text
  );
$$;

revoke all on function private.board_rules_key(jsonb)
  from public, anon, authenticated;

create table private.board_solution_cache (
  rules_key text not null,
  board_seed bigint not null,
  word_count integer not null default 0,
  solved_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (rules_key, board_seed),
  constraint board_solution_rules_key_format check (
    rules_key ~ '^[0-9a-f]{32}$'
  ),
  constraint board_solution_seed_range check (
    board_seed between 0 and 4294967295
  ),
  constraint board_solution_word_count_nonnegative check (word_count >= 0)
);

create table private.board_solution_words (
  rules_key text not null,
  board_seed bigint not null,
  word text not null,
  word_length integer not null,
  score integer not null,
  recognizable boolean not null,
  primary key (rules_key, board_seed, word),
  foreign key (rules_key, board_seed)
    references private.board_solution_cache (rules_key, board_seed)
    on delete cascade,
  constraint board_solution_word_upper_alpha check (
    word = pg_catalog.upper(word)
    and word ~ '^[A-Z]+$'
  ),
  constraint board_solution_word_length_exact check (
    word_length = pg_catalog.char_length(word)
    and word_length >= 3
  ),
  constraint board_solution_score_valid check (
    score in (100, 400, 800, 1400, 1800, 2200)
  )
);

create index board_solution_words_longest_idx
  on private.board_solution_words (
    rules_key,
    board_seed,
    word_length desc,
    recognizable desc,
    word
  );

create table private.custom_board_pool (
  rules_key text not null,
  board_seed bigint not null,
  word_count integer not null,
  three_letter_words integer not null,
  four_letter_words integer not null,
  long_words integer not null,
  recognizable_words integer not null,
  dominant_family_ratio numeric(6, 5) not null,
  quality_report jsonb not null,
  use_count integer not null default 0,
  approved_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_used_at timestamptz,
  primary key (rules_key, board_seed),
  foreign key (rules_key, board_seed)
    references private.board_solution_cache (rules_key, board_seed)
    on delete cascade,
  constraint custom_board_pool_counts_nonnegative check (
    word_count >= 0
    and three_letter_words >= 0
    and four_letter_words >= 0
    and long_words >= 0
    and recognizable_words >= 0
    and use_count >= 0
  ),
  constraint custom_board_pool_family_ratio check (
    dominant_family_ratio between 0 and 1
  ),
  constraint custom_board_pool_report_object check (
    pg_catalog.jsonb_typeof(quality_report) = 'object'
    and quality_report ->> 'approved' = 'true'
  )
);

create index custom_board_pool_reuse_idx
  on private.custom_board_pool (
    rules_key,
    use_count,
    last_used_at,
    board_seed
  );

revoke all on table private.board_solution_cache
  from public, anon, authenticated;
revoke all on table private.board_solution_words
  from public, anon, authenticated;
revoke all on table private.custom_board_pool
  from public, anon, authenticated;

-- Enumerate exact playable paths. A path may move horizontally, vertically,
-- or diagonally and each physical cell may appear at most once. Prefix probes
-- prune branches without changing the final set of dictionary words.
create or replace function private.solve_board_words(
  p_seed bigint,
  p_ruleset jsonb
)
returns table (
  word text,
  word_length integer,
  score integer,
  recognizable boolean
)
language sql
stable
strict
security invoker
set search_path = ''
as $$
  with recursive
  settings as materialized (
    select
      (p_ruleset ->> 'rows')::integer as board_rows,
      (p_ruleset ->> 'columns')::integer as board_columns,
      (p_ruleset ->> 'minimumWordLength')::integer as minimum_word_length,
      p_ruleset ->> 'dictionaryVersion' as dictionary_version,
      p_ruleset -> 'activeCells' as active_mask,
      private.generate_board_letters(p_seed, p_ruleset) as letters,
      (
        select pg_catalog.count(*)::integer
        from pg_catalog.jsonb_array_elements(p_ruleset -> 'activeCells')
          as cell(value)
        where cell.value = 'true'::jsonb
      ) as active_count
  ),
  bounds as materialized (
    select
      settings.*,
      least(
        settings.active_count,
        coalesce(
          (
            select pg_catalog.max(pg_catalog.char_length(dictionary.word))
            from private.approved_words as dictionary
            where dictionary.dictionary_version =
              settings.dictionary_version
          ),
          0
        )
      ) as maximum_word_length
    from settings
  ),
  board as materialized (
    select
      letter.ordinality::integer - 1 as cell_index,
      (letter.ordinality::integer - 1) / bounds.board_columns as row_number,
      mod(
        letter.ordinality::integer - 1,
        bounds.board_columns
      ) as column_number,
      letter.value as letter
    from bounds
    cross join lateral pg_catalog.unnest(bounds.letters)
      with ordinality as letter(value, ordinality)
    where (bounds.active_mask -> (letter.ordinality::integer - 1))
      = 'true'::jsonb
      and letter.value is not null
  ),
  paths (
    cell_index,
    row_number,
    column_number,
    path_word,
    used_cells
  ) as (
    select
      board.cell_index,
      board.row_number,
      board.column_number,
      board.letter,
      array[board.cell_index]::integer[]
    from board
    cross join bounds
    where exists (
      select 1
      from private.approved_words as dictionary
      where dictionary.dictionary_version = bounds.dictionary_version
        and dictionary.word like pg_catalog.lower(board.letter) || '%'
    )

    union all

    select
      neighbor.cell_index,
      neighbor.row_number,
      neighbor.column_number,
      path.path_word || neighbor.letter,
      pg_catalog.array_append(path.used_cells, neighbor.cell_index)
    from paths as path
    join board as neighbor
      on neighbor.cell_index <> path.cell_index
      and pg_catalog.abs(neighbor.row_number - path.row_number) <= 1
      and pg_catalog.abs(neighbor.column_number - path.column_number) <= 1
      and not (neighbor.cell_index = any(path.used_cells))
    cross join bounds
    where pg_catalog.char_length(path.path_word) <
      bounds.maximum_word_length
      and exists (
        select 1
        from private.approved_words as dictionary
        where dictionary.dictionary_version = bounds.dictionary_version
          and dictionary.word like
            pg_catalog.lower(path.path_word || neighbor.letter) || '%'
      )
  ),
  solved as (
    select distinct pg_catalog.upper(dictionary.word) as word
    from paths
    cross join bounds
    join private.approved_words as dictionary
      on dictionary.dictionary_version = bounds.dictionary_version
      and dictionary.word = pg_catalog.lower(paths.path_word)
    where pg_catalog.char_length(paths.path_word) >=
      bounds.minimum_word_length
  )
  select
    solved.word,
    pg_catalog.char_length(solved.word)::integer as word_length,
    case pg_catalog.char_length(solved.word)
      when 3 then 100
      when 4 then 400
      when 5 then 800
      when 6 then 1400
      when 7 then 1800
      else 2200
    end as score,
    exists (
      select 1
      from private.common_game_words as common_word
      cross join bounds
      where common_word.dictionary_version = bounds.dictionary_version
        and common_word.word = pg_catalog.lower(solved.word)
    ) as recognizable
  from solved;
$$;

revoke all on function private.solve_board_words(bigint, jsonb)
  from public, anon, authenticated;

comment on function private.solve_board_words(bigint, jsonb) is
  'Deterministically enumerates every dictionary word reachable through the authoritative board adjacency and no-tile-reuse rules.';

create or replace function private.board_quality_report(
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
  with
  solved as materialized (
    select solution.*
    from private.solve_board_words(p_seed, p_ruleset) as solution
  ),
  board_metrics as (
    select
      pg_catalog.count(*) filter (
        where letter.value is not null
      )::integer as active_count,
      pg_catalog.count(*) filter (
        where letter.value in ('A', 'E', 'I', 'O', 'U')
      )::integer as vowel_count,
      pg_catalog.count(*) filter (
        where letter.value in ('J', 'Q', 'X', 'Z')
      )::integer as rare_letter_count
    from pg_catalog.unnest(
      private.generate_board_letters(p_seed, p_ruleset)
    ) as letter(value)
  ),
  word_metrics as (
    select
      pg_catalog.count(*)::integer as word_count,
      pg_catalog.count(*) filter (
        where solved.word_length = 3
      )::integer as three_letter_words,
      pg_catalog.count(*) filter (
        where solved.word_length = 4
      )::integer as four_letter_words,
      pg_catalog.count(*) filter (
        where solved.word_length >= 6
      )::integer as long_words,
      pg_catalog.count(*) filter (
        where solved.recognizable
      )::integer as recognizable_words
    from solved
  ),
  families as (
    select
      case
        when solved.word_length <= 4 then pg_catalog.lower(solved.word)
        else pg_catalog.regexp_replace(
          pg_catalog.lower(solved.word),
          '(ingly|edly|ations|ation|ments|ment|nesses|ness|ers|ies|ing|ed|es|s|ly)$',
          ''
        )
      end as family_key,
      pg_catalog.count(*)::integer as family_count
    from solved
    group by 1
  ),
  family_metrics as (
    select coalesce(pg_catalog.max(families.family_count), 0)::integer
      as dominant_family_count
    from families
  ),
  thresholds as (
    select
      board_metrics.*,
      word_metrics.*,
      family_metrics.dominant_family_count,
      case
        when board_metrics.active_count <= 9 then 25
        when board_metrics.active_count <= 16 then 80
        when board_metrics.active_count <= 25 then 160
        else 220
      end as minimum_word_count,
      case
        when board_metrics.active_count <= 9 then 14
        when board_metrics.active_count <= 16 then 28
        when board_metrics.active_count <= 25 then 45
        else 60
      end as minimum_three_letter_words,
      case
        when board_metrics.active_count <= 9 then 4
        when board_metrics.active_count <= 16 then 14
        when board_metrics.active_count <= 25 then 28
        else 40
      end as minimum_four_letter_words,
      case
        when board_metrics.active_count <= 9 then 1
        when board_metrics.active_count <= 16 then 4
        when board_metrics.active_count <= 25 then 15
        else 24
      end as minimum_long_words,
      case
        when board_metrics.active_count <= 9 then 1
        when board_metrics.active_count <= 16 then 4
        when board_metrics.active_count <= 25 then 7
        else 10
      end as minimum_recognizable_words,
      greatest(1, pg_catalog.ceil(board_metrics.active_count * 0.10)::integer)
        as maximum_rare_letters
    from board_metrics
    cross join word_metrics
    cross join family_metrics
  )
  select pg_catalog.jsonb_build_object(
    'approved',
      thresholds.word_count >= thresholds.minimum_word_count
      and thresholds.three_letter_words >=
        thresholds.minimum_three_letter_words
      and thresholds.four_letter_words >=
        thresholds.minimum_four_letter_words
      and thresholds.long_words >= thresholds.minimum_long_words
      and thresholds.recognizable_words >=
        thresholds.minimum_recognizable_words
      and thresholds.rare_letter_count <= thresholds.maximum_rare_letters
      and thresholds.vowel_count <=
        pg_catalog.ceil(thresholds.active_count * 0.62)::integer
      and (
        thresholds.word_count = 0
        or thresholds.dominant_family_count::numeric /
          thresholds.word_count <= 0.20
      ),
    'wordCount', thresholds.word_count,
    'threeLetterWords', thresholds.three_letter_words,
    'fourLetterWords', thresholds.four_letter_words,
    'longWords', thresholds.long_words,
    'recognizableWords', thresholds.recognizable_words,
    'activeCells', thresholds.active_count,
    'vowelCount', thresholds.vowel_count,
    'rareLetterCount', thresholds.rare_letter_count,
    'dominantFamilyCount', thresholds.dominant_family_count,
    'dominantFamilyRatio',
      case
        when thresholds.word_count = 0 then 0
        else pg_catalog.round(
          thresholds.dominant_family_count::numeric /
            thresholds.word_count,
          5
        )
      end,
    'minimumWordCount', thresholds.minimum_word_count,
    'minimumThreeLetterWords', thresholds.minimum_three_letter_words,
    'minimumFourLetterWords', thresholds.minimum_four_letter_words,
    'minimumLongWords', thresholds.minimum_long_words,
    'minimumRecognizableWords', thresholds.minimum_recognizable_words,
    'maximumRareLetters', thresholds.maximum_rare_letters
  )
  from thresholds;
$$;

revoke all on function private.board_quality_report(bigint, jsonb)
  from public, anon, authenticated;

comment on function private.board_quality_report(bigint, jsonb) is
  'Scores an exact solved board for total vocabulary, easy and long words, recognizable words, rare letters, and word-family diversity.';

create or replace function private.cache_board_solution(
  p_seed bigint,
  p_ruleset jsonb
)
returns integer
language plpgsql
volatile
strict
security invoker
set search_path = ''
as $$
declare
  generated_rules_key text := private.board_rules_key(p_ruleset);
  cached_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'board-solution:' || generated_rules_key || ':' || p_seed::text,
      0
    )
  );

  select cache.word_count
  into cached_count
  from private.board_solution_cache as cache
  where cache.rules_key = generated_rules_key
    and cache.board_seed = p_seed;

  if found and cached_count > 0 then
    return cached_count;
  end if;

  insert into private.board_solution_cache (
    rules_key,
    board_seed,
    word_count
  )
  values (generated_rules_key, p_seed, 0)
  on conflict (rules_key, board_seed) do nothing;

  insert into private.board_solution_words (
    rules_key,
    board_seed,
    word,
    word_length,
    score,
    recognizable
  )
  select
    generated_rules_key,
    p_seed,
    solution.word,
    solution.word_length,
    solution.score,
    solution.recognizable
  from private.solve_board_words(p_seed, p_ruleset) as solution
  on conflict (rules_key, board_seed, word) do nothing;

  select pg_catalog.count(*)::integer
  into cached_count
  from private.board_solution_words as solution
  where solution.rules_key = generated_rules_key
    and solution.board_seed = p_seed;

  update private.board_solution_cache as cache
  set
    word_count = cached_count,
    solved_at = pg_catalog.clock_timestamp()
  where cache.rules_key = generated_rules_key
    and cache.board_seed = p_seed;

  return cached_count;
end;
$$;

revoke all on function private.cache_board_solution(bigint, jsonb)
  from public, anon, authenticated;

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
  candidate_report jsonb;
  fallback_seed bigint;
  available_pool_count integer;
  maximum_attempts integer;
  attempt integer;
begin
  select pg_catalog.count(*)::integer
  into available_pool_count
  from private.custom_board_pool as pool
  where pool.rules_key = generated_rules_key
    and pool.board_seed is distinct from p_excluded_seed;

  maximum_attempts := case when available_pool_count > 0 then 1 else 12 end;

  for attempt in 1..maximum_attempts loop
    generated_seed :=
      pg_catalog.floor(pg_catalog.random() * 4294967296)::bigint;

    if generated_seed is not distinct from p_excluded_seed
      or exists (
        select 1
        from private.custom_board_pool as pool
        where pool.rules_key = generated_rules_key
          and pool.board_seed = generated_seed
      ) then
      continue;
    end if;

    candidate_report :=
      private.board_quality_report(generated_seed, p_ruleset);

    if (candidate_report ->> 'approved')::boolean then
      perform private.cache_board_solution(generated_seed, p_ruleset);

      insert into private.custom_board_pool (
        rules_key,
        board_seed,
        word_count,
        three_letter_words,
        four_letter_words,
        long_words,
        recognizable_words,
        dominant_family_ratio,
        quality_report,
        use_count,
        last_used_at
      )
      values (
        generated_rules_key,
        generated_seed,
        (candidate_report ->> 'wordCount')::integer,
        (candidate_report ->> 'threeLetterWords')::integer,
        (candidate_report ->> 'fourLetterWords')::integer,
        (candidate_report ->> 'longWords')::integer,
        (candidate_report ->> 'recognizableWords')::integer,
        (candidate_report ->> 'dominantFamilyRatio')::numeric,
        candidate_report,
        1,
        pg_catalog.clock_timestamp()
      )
      on conflict (rules_key, board_seed) do update
      set
        use_count = private.custom_board_pool.use_count + 1,
        last_used_at = excluded.last_used_at;

      return generated_seed;
    end if;
  end loop;

  select pool.board_seed
  into fallback_seed
  from private.custom_board_pool as pool
  where pool.rules_key = generated_rules_key
    and pool.board_seed is distinct from p_excluded_seed
  order by
    pool.use_count,
    pool.last_used_at nulls first,
    pool.board_seed
  limit 1
  for update;

  if fallback_seed is null then
    raise exception 'A high-quality board could not be prepared. Please try again.';
  end if;

  update private.custom_board_pool as pool
  set
    use_count = pool.use_count + 1,
    last_used_at = pg_catalog.clock_timestamp()
  where pool.rules_key = generated_rules_key
    and pool.board_seed = fallback_seed;

  return fallback_seed;
end;
$$;

revoke all on function private.select_quality_board_seed(jsonb, bigint)
  from public, anon, authenticated;

comment on function private.select_quality_board_seed(jsonb, bigint) is
  'Regenerates private boards within a fixed attempt budget and falls back only to a previously solved, approved board for the exact immutable board rules.';

create or replace function private.enforce_private_board_quality()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_ruleset jsonb;
  excluded_seed bigint;
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
  excluded_seed := case when tg_op = 'UPDATE' then old.board_seed else null end;

  new.ruleset := normalized_ruleset;
  new.round_duration_seconds :=
    (normalized_ruleset ->> 'roundDurationSeconds')::integer;
  new.dictionary_version := normalized_ruleset ->> 'dictionaryVersion';
  new.board_generation_version :=
    normalized_ruleset ->> 'boardGenerationVersion';
  new.ruleset_version := normalized_ruleset ->> 'version';

  if new.board_seed is distinct from excluded_seed
    and exists (
      select 1
      from private.custom_board_pool as pool
      where pool.rules_key = private.board_rules_key(normalized_ruleset)
        and pool.board_seed = new.board_seed
    ) then
    return new;
  end if;

  new.board_seed := private.select_quality_board_seed(
    normalized_ruleset,
    excluded_seed
  );

  return new;
end;
$$;

revoke all on function private.enforce_private_board_quality()
  from public, anon, authenticated;

create trigger matches_validate_private_quality_board
before insert or update of board_seed, ruleset on public.matches
for each row execute function private.enforce_private_board_quality();

comment on function private.enforce_private_board_quality() is
  'Server-owned trigger boundary ensuring every newly created, rerolled, or reconfigured private match receives one exact solved and approved board seed.';

-- Waiting rooms have not exposed a countdown board yet, so they can be
-- upgraded safely. Starting, active, and historical snapshots stay immutable.
update public.matches as match_row
set board_seed = mod(match_row.board_seed + 1, 4294967296::bigint)
where match_row.mode = 'private'
  and match_row.status = 'waiting';

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
  normalized_ruleset jsonb;
  generated_match_id uuid;
  generated_room_code text;
  generated_seed bigint;
  attempt integer;
begin
  perform private.ensure_ranked_identity(current_user_id);

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
        pg_catalog.clock_timestamp(),
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
begin
  perform private.require_persistent_caller();

  return query
  select
    lobby.match_id,
    lobby.room_code,
    lobby.board_seed,
    lobby.round_duration_seconds,
    lobby.scheduled_start_at,
    lobby.server_now
  from public.create_private_lobby(
    private.ranked_ruleset(),
    2
  ) as lobby;
end;
$$;

revoke all on function public.create_private_match()
  from public, anon, authenticated;
grant execute on function public.create_private_match()
  to authenticated;

comment on function public.create_private_lobby(jsonb, integer) is
  'Creates a private lobby only after auth.uid() identity initialization and exact server-side board solving, preserving the approved seed returned to the caller.';
comment on function public.create_private_match() is
  'Legacy two-player wrapper over the canonical high-quality private-lobby creation path.';

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
    if locked_match.mode = 'private' then
      next_seed := private.select_quality_board_seed(
        locked_match.ruleset,
        locked_match.board_seed
      );
    else
      next_seed := pg_catalog.floor(
        pg_catalog.random() * 4294967296
      )::bigint;
      if next_seed = locked_match.board_seed then
        next_seed := mod(next_seed + 1, 4294967296::bigint);
      end if;
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

comment on function public.vote_match_reroll(uuid, boolean) is
  'Keeps one-vote-per-player authorization and makes an approved private reroll return the exact newly solved board seed.';

create table public.player_challenges (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  challenger_id uuid not null
    references public.profiles (id) on delete cascade,
  challenged_id uuid not null
    references public.profiles (id) on delete cascade,
  rated boolean not null,
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_match_id uuid references public.matches (id) on delete set null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  responded_at timestamptz,
  constraint player_challenges_distinct_players check (
    challenger_id <> challenged_id
  ),
  constraint player_challenges_status check (
    status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')
  ),
  constraint player_challenges_state check (
    (
      status = 'pending'
      and created_match_id is null
      and responded_at is null
    )
    or
    (
      status = 'accepted'
      and created_match_id is not null
      and responded_at is not null
    )
    or
    (
      status in ('declined', 'cancelled', 'expired')
      and created_match_id is null
      and responded_at is not null
    )
  ),
  constraint player_challenges_expiry_order check (
    expires_at > created_at
  )
);

create unique index player_challenges_one_pending_pair_idx
  on public.player_challenges (
    least(challenger_id, challenged_id),
    greatest(challenger_id, challenged_id)
  )
  where status = 'pending';
create index player_challenges_challenged_pending_idx
  on public.player_challenges (challenged_id, expires_at, created_at)
  where status = 'pending';
create index player_challenges_challenger_pending_idx
  on public.player_challenges (challenger_id, expires_at, created_at)
  where status = 'pending';
create index player_challenges_created_match_idx
  on public.player_challenges (created_match_id)
  where created_match_id is not null;

alter table public.player_challenges enable row level security;
revoke all on table public.player_challenges
  from public, anon, authenticated;

comment on table public.player_challenges is
  'RPC-only direct player challenges. Raw participant UUIDs are never granted through the Data API; public RPCs project opaque profile IDs only.';

create or replace function private.has_open_multiplayer_state(p_user_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if private.has_active_match(p_user_id) then
    return true;
  end if;

  return exists (
    select 1
    from public.match_players as player
    join public.matches as match_row on match_row.id = player.match_id
    where player.player_user_id = p_user_id
      and player.finished_at is null
      and player.connection_status in ('connected', 'disconnected')
      and match_row.mode <> 'solo'
      and match_row.status = 'waiting'
  )
  or exists (
    select 1
    from public.ranked_queue as queue
    where queue.user_id = p_user_id
      and queue.status = 'waiting'
  );
end;
$$;

revoke all on function private.has_open_multiplayer_state(uuid)
  from public, anon, authenticated;

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
    raise exception 'That player profile was not found.';
  end if;

  select profile.*
  into challenged_profile
  from public.profiles as profile
  where profile.public_profile_id = normalized_profile_id;

  if not found then
    raise exception 'That player profile was not found.';
  end if;
  if challenged_profile.id = current_user_id then
    raise exception 'You cannot challenge your own profile.';
  end if;
  if not exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = challenged_profile.id
      and not coalesce(auth_user.is_anonymous, false)
  ) then
    raise exception 'That player is not available for account matches.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'player-challenge:'
      || least(current_user_id::text, challenged_profile.id::text)
      || ':'
      || greatest(current_user_id::text, challenged_profile.id::text),
      0
    )
  );

  update public.player_challenges as challenge
  set
    status = 'expired',
    responded_at = database_now
  where challenge.status = 'pending'
    and challenge.expires_at <= database_now
    and current_user_id in (
      challenge.challenger_id,
      challenge.challenged_id
    );

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
    if existing_challenge.rated is distinct from p_rated then
      raise exception 'A challenge with different rating rules is already pending.';
    end if;

    return query
    select
      existing_challenge.id,
      case
        when existing_challenge.challenger_id = current_user_id
          then 'outgoing'
        else 'incoming'
      end,
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

  if private.has_open_multiplayer_state(current_user_id) then
    raise exception 'Finish or leave your current multiplayer activity first.';
  end if;
  if private.has_open_multiplayer_state(challenged_profile.id) then
    raise exception 'That player is already in another multiplayer activity.';
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
    database_now + interval '60 seconds'
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

create or replace function public.get_current_player_challenges()
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
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  update public.player_challenges as challenge
  set
    status = 'expired',
    responded_at = database_now
  where challenge.status = 'pending'
    and challenge.expires_at <= database_now
    and current_user_id in (
      challenge.challenger_id,
      challenge.challenged_id
    );

  return query
  select
    challenge.id,
    case
      when challenge.challenger_id = current_user_id then 'outgoing'
      else 'incoming'
    end,
    opponent.public_profile_id,
    opponent.display_name,
    challenge.rated,
    challenge.status,
    challenge.expires_at,
    challenge.created_match_id,
    match_row.mode,
    match_row.room_code,
    database_now
  from public.player_challenges as challenge
  join public.profiles as opponent
    on opponent.id = case
      when challenge.challenger_id = current_user_id
        then challenge.challenged_id
      else challenge.challenger_id
    end
  left join public.matches as match_row
    on match_row.id = challenge.created_match_id
  where current_user_id in (
      challenge.challenger_id,
      challenge.challenged_id
    )
    and (
      (
        challenge.status = 'pending'
        and challenge.expires_at > database_now
      )
      or
      (
        challenge.status = 'accepted'
        and match_row.status in ('waiting', 'starting', 'active')
      )
    )
  order by challenge.created_at desc, challenge.id
  limit 20;
end;
$$;

revoke all on function public.get_current_player_challenges()
  from public, anon, authenticated;
grant execute on function public.get_current_player_challenges()
  to authenticated;

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
  attempt integer;
begin
  perform private.ensure_ranked_identity(current_user_id);

  select candidate.*
  into challenge
  from public.player_challenges as candidate
  where candidate.id = p_challenge_id
  for update;

  if not found or challenge.challenged_id <> current_user_id then
    raise exception 'That challenge is not available to this account.';
  end if;

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

  if challenge.status <> 'pending' then
    return query
    select
      challenge.status,
      null::uuid,
      null::public.match_mode,
      null::text,
      database_now;
    return;
  end if;

  if challenge.expires_at <= database_now then
    update public.player_challenges as candidate
    set
      status = 'expired',
      responded_at = database_now
    where candidate.id = challenge.id;

    return query
    select
      'expired'::text,
      null::uuid,
      null::public.match_mode,
      null::text,
      database_now;
    return;
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
    raise exception 'The challenger is no longer available.';
  end if;

  if private.has_open_multiplayer_state(challenge.challenger_id)
    or private.has_open_multiplayer_state(challenge.challenged_id) then
    raise exception 'Both players must leave other multiplayer activity first.';
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
      'starting',
      null,
      generated_seed,
      60,
      2,
      private.ranked_ruleset(),
      'enable2k-af52415-v1',
      'weighted-v2',
      '2',
      'ranked',
      private.mode_key('ranked', private.ranked_ruleset()),
      'classic-v1',
      'ranked-v1',
      'pending'
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
          generated_room_code,
          'starting',
          challenge.challenger_id,
          generated_seed,
          60,
          2,
          private.ranked_ruleset(),
          'enable2k-af52415-v1',
          'weighted-v2',
          '2',
          'private',
          private.mode_key('private', private.ranked_ruleset()),
          'classic-v1',
          null,
          'not_applicable'
        );
        exit;
      exception
        when unique_violation then
          if attempt = 12 then
            raise exception 'A private challenge room could not be allocated.';
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
  where candidate.id = challenge.id;

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

create or replace function public.cancel_player_challenge(
  p_challenge_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := private.require_persistent_caller();
begin
  update public.player_challenges as challenge
  set
    status = 'cancelled',
    responded_at = pg_catalog.clock_timestamp()
  where challenge.id = p_challenge_id
    and challenge.challenger_id = current_user_id
    and challenge.status = 'pending';

  return found;
end;
$$;

revoke all on function public.cancel_player_challenge(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_player_challenge(uuid)
  to authenticated;

comment on function public.create_player_challenge(text, boolean) is
  'Creates an idempotent rated or casual challenge from auth.uid() to an opaque public profile ID without exposing either auth UUID.';
comment on function public.get_current_player_challenges() is
  'Returns only auth.uid() challenge projections with opaque opponent identity and active accepted-match routing data.';
comment on function public.respond_player_challenge(uuid, boolean) is
  'Lets only the challenged auth.uid() accept or decline, then atomically creates a server-owned rated or casual shared match.';
comment on function public.cancel_player_challenge(uuid) is
  'Lets only the authenticated challenger cancel their still-pending challenge.';

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
    raise exception 'Word opportunities are available after the match is complete.';
  end if;

  select player.*
  into player_record
  from public.match_players as player
  where player.match_id = p_match_id
    and player.player_user_id = current_user_id;

  if not found then
    raise exception 'You are not a participant in this match.';
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
    ) as was_found
  from private.board_solution_words as solution
  where solution.rules_key = generated_rules_key
    and solution.board_seed = match_record.board_seed
  order by
    solution.word_length desc,
    solution.recognizable desc,
    solution.word
  limit 10;
end;
$$;

revoke all on function public.get_match_word_opportunities(uuid)
  from public, anon, authenticated;
grant execute on function public.get_match_word_opportunities(uuid)
  to authenticated;

comment on function public.get_match_word_opportunities(uuid) is
  'Participant-only top-ten longest exact board solution, labeled when auth.uid() found the word; no opponent identity or raw auth UUID is returned.';

commit;
