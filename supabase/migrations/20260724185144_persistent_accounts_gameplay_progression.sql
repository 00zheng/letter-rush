-- Commit the new enum label before the following transactional schema
-- migration uses it in constraints, indexes, functions, and tests.
alter type public.match_mode add value if not exists 'solo';
