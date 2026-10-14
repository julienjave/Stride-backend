-- Custom SQL migration (2026-10-14): remove the BLANK instruction steps that
-- databases already hold.
--
-- Two exercises of the imported library — "Barbell Squat To A Bench" and
-- "Clean" — came from upstream with an empty step 2. The app refuses blank
-- steps since D-1 (IsExerciseList: each item must match \S, "at least one
-- non-whitespace character"), so editing those instructions was refused
-- until the practitioner removed the empty step, and the step showed as an
-- empty numbered item. scripts/seed-exercises.ts now cleans steps on import
-- (cleanInstructions), but it SKIPS exercises it already has, so re-running
-- it fixes nothing: existing databases need this.
--
-- What it changes:
--   - the library (`exercises`) — any exercise, imported or custom (custom
--     ones went through the API's rule, so in practice the two above);
--   - programs' own copies (`assigned_program_exercises`) of such an
--     exercise — a program assigned before this migration copied the blank
--     step with the rest. Removing an EMPTY step loses nothing.
-- What it leaves alone: sessions' copies (`session_exercises`) — they are
-- the record of what a session was given (step D-2), fixed by the 0033 guard;
-- a migration doesn't rewrite history, even an empty line of it.
--
-- How: the array is rebuilt from its own elements — `unnest … WITH
-- ORDINALITY` gives each step with its position, the WHERE keeps the steps
-- with something visible (`~ '\S'`, the same test as the DTOs — not
-- `btrim`, which only trims spaces), ORDER BY the position keeps their order,
-- and ARRAY(…) turns the rows back into an array. Only rows that HAVE a blank
-- step are updated (the WHERE EXISTS), so every other row is untouched.
--
-- Run as the tables' owner, which the closed-program (0031) and
-- retired-exercise (0033) guards exempt — a closed program's copy is cleaned
-- too. No audit entry: an entry names the user who acted, and a migration has
-- none; this file is the record (as for 0032, 0034 and 0035).
UPDATE "exercises"
SET "instructions" = ARRAY(
  SELECT s.step
  FROM unnest("instructions") WITH ORDINALITY AS s(step, position)
  WHERE s.step ~ '\S'
  ORDER BY s.position
)
WHERE EXISTS (
  SELECT 1 FROM unnest("instructions") AS s(step) WHERE s.step !~ '\S'
);--> statement-breakpoint
UPDATE "assigned_program_exercises"
SET "instructions" = ARRAY(
  SELECT s.step
  FROM unnest("instructions") WITH ORDINALITY AS s(step, position)
  WHERE s.step ~ '\S'
  ORDER BY s.position
)
WHERE EXISTS (
  SELECT 1 FROM unnest("instructions") AS s(step) WHERE s.step !~ '\S'
);