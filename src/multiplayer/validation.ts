import { isDictionaryWord } from "../game/dictionary";
import {
  calculateWordScore,
  createWordFromPath,
  isDuplicateWord,
  validateTilePath,
} from "../game/logic";
import type {
  LetterBoard,
  ScoredWordSubmission,
  TileCoordinate,
  WordPathSubmission,
} from "../game/types";

export const RESULT_SUBMISSION_GRACE_MS = 15_000;
export const MAX_WORDS_PER_ROUND = 64;

export type SubmissionValidation =
  | {
      isValid: true;
      score: number;
      submissions: ScoredWordSubmission[];
    }
  | { isValid: false; message: string };

export function validateMatchSubmissions(
  board: LetterBoard,
  submissions: readonly WordPathSubmission[],
): SubmissionValidation {
  if (submissions.length > MAX_WORDS_PER_ROUND) {
    return { isValid: false, message: "Too many submitted words." };
  }

  const validatedSubmissions: ScoredWordSubmission[] = [];
  const seenWords: string[] = [];

  for (const submission of submissions) {
    const claimedWord = submission.word.trim().toUpperCase();
    const pathValidation = validateTilePath(submission.path, board.length);

    if (!pathValidation.isValid) {
      return {
        isValid: false,
        message: `${claimedWord || "A word"} has an invalid tile path.`,
      };
    }

    if (submission.path.length > board.length * board.length) {
      return { isValid: false, message: "A submitted path is too long." };
    }

    const generatedWord = createWordFromPath(board, submission.path);

    if (generatedWord !== claimedWord) {
      return {
        isValid: false,
        message: `${claimedWord || "A word"} does not match its tile path.`,
      };
    }

    if (generatedWord.length < 3) {
      return {
        isValid: false,
        message: `${generatedWord} is shorter than three letters.`,
      };
    }

    if (!isDictionaryWord(generatedWord)) {
      return {
        isValid: false,
        message: `${generatedWord} is not in the approved dictionary.`,
      };
    }

    if (isDuplicateWord(generatedWord, seenWords)) {
      return {
        isValid: false,
        message: `${generatedWord} was submitted more than once.`,
      };
    }

    const score = calculateWordScore(generatedWord);
    seenWords.push(generatedWord);
    validatedSubmissions.push({
      word: generatedWord,
      path: submission.path,
      score,
    });
  }

  return {
    isValid: true,
    score: validatedSubmissions.reduce(
      (total, submission) => total + submission.score,
      0,
    ),
    submissions: validatedSubmissions,
  };
}

export function isWithinResultSubmissionWindow(
  scheduledStartAt: string,
  roundDurationSeconds: number,
  serverNow: string,
  graceMs = RESULT_SUBMISSION_GRACE_MS,
): boolean {
  const startTimeMs = Date.parse(scheduledStartAt);
  const serverNowMs = Date.parse(serverNow);
  const endTimeMs = startTimeMs + roundDurationSeconds * 1_000;

  return serverNowMs >= startTimeMs && serverNowMs <= endTimeMs + graceMs;
}

type ResultRequestParse =
  | {
      isValid: true;
      matchId: string;
      submissions: WordPathSubmission[];
    }
  | { isValid: false; message: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCoordinate(value: unknown): value is TileCoordinate {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  return Number.isInteger(candidate.row) && Number.isInteger(candidate.column);
}

export function parseResultRequest(value: unknown): ResultRequestParse {
  if (!value || typeof value !== "object") {
    return { isValid: false, message: "The result payload must be an object." };
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.matchId !== "string" ||
    !UUID_PATTERN.test(candidate.matchId)
  ) {
    return { isValid: false, message: "A valid match ID is required." };
  }

  if (!Array.isArray(candidate.submissions)) {
    return { isValid: false, message: "Submitted words are required." };
  }

  if (candidate.submissions.length > MAX_WORDS_PER_ROUND) {
    return { isValid: false, message: "Too many submitted words." };
  }

  const submissions: WordPathSubmission[] = [];

  for (const rawSubmission of candidate.submissions) {
    if (!rawSubmission || typeof rawSubmission !== "object") {
      return { isValid: false, message: "A submitted word is malformed." };
    }

    const submission = rawSubmission as Record<string, unknown>;

    if (
      typeof submission.word !== "string" ||
      !Array.isArray(submission.path) ||
      !submission.path.every(isCoordinate)
    ) {
      return { isValid: false, message: "A submitted word is malformed." };
    }

    submissions.push({
      word: submission.word,
      path: submission.path.map((coordinate) => ({
        row: coordinate.row,
        column: coordinate.column,
      })),
    });
  }

  return {
    isValid: true,
    matchId: candidate.matchId,
    submissions,
  };
}

export type FinalizedSubmission = {
  finishedAt: string | null;
  score: number | null;
  words: readonly string[];
};

export function applyIdempotentSubmission(
  existing: FinalizedSubmission,
  incoming: FinalizedSubmission,
): { changed: boolean; result: FinalizedSubmission } {
  if (existing.finishedAt) {
    return { changed: false, result: existing };
  }

  return { changed: true, result: incoming };
}
