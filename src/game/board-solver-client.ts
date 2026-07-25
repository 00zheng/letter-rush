import type { SolvedBoardWord } from "./board-solver";
import type { GameRuleset } from "./ruleset";
import type { LetterBoard } from "./types";

type WorkerResponse =
  { id: number; words: SolvedBoardWord[] } | { id: number; error: string };

type PendingRequest = {
  reject: (reason: Error) => void;
  resolve: (words: SolvedBoardWord[]) => void;
  timeoutId: number;
  abortSignal: AbortSignal | null;
  handleAbort: (() => void) | null;
};

const pending = new Map<number, PendingRequest>();
let nextRequestId = 0;
let solverWorker: Worker | null = null;

export type BoardSolverInput = {
  activeCells: boolean[];
  board: LetterBoard;
  columns: number;
  dictionaryVersion: string;
  minimumWordLength: number;
  rows: number;
  scoringRulesVersion: string;
};

function disposeRequest(id: number): PendingRequest | null {
  const request = pending.get(id);
  if (!request) return null;
  window.clearTimeout(request.timeoutId);
  if (request.abortSignal && request.handleAbort) {
    request.abortSignal.removeEventListener("abort", request.handleAbort);
  }
  pending.delete(id);
  return request;
}

function terminateWorkerWhenIdle() {
  if (pending.size > 0) return;
  solverWorker?.terminate();
  solverWorker = null;
}

function failAndTerminateWorker(error: Error) {
  for (const id of [...pending.keys()]) {
    disposeRequest(id)?.reject(error);
  }
  solverWorker?.terminate();
  solverWorker = null;
}

function getWorker(): Worker {
  if (solverWorker) return solverWorker;
  solverWorker = new Worker(
    new URL("../workers/board-solver.worker.ts", import.meta.url),
    { name: "letter-rush-board-solver", type: "module" },
  );
  solverWorker.addEventListener(
    "message",
    (event: MessageEvent<WorkerResponse>) => {
      const request = disposeRequest(event.data.id);
      if (!request) return;
      if ("error" in event.data) {
        request.reject(new Error(event.data.error));
      } else {
        request.resolve(event.data.words);
      }
    },
  );
  solverWorker.addEventListener("error", () => {
    failAndTerminateWorker(new Error("Possible-word analysis failed."));
  });
  return solverWorker;
}

export function createBoardSolverCacheKey(
  board: LetterBoard,
  ruleset: GameRuleset,
): string {
  return JSON.stringify(createBoardSolverInput(board, ruleset));
}

export function createBoardSolverInput(
  board: LetterBoard,
  ruleset: GameRuleset,
): BoardSolverInput {
  return {
    activeCells: Array.from(
      { length: ruleset.rows * ruleset.columns },
      (_, index) => ruleset.activeCells[index] === true,
    ),
    board: Array.from({ length: ruleset.rows }, (_, row) =>
      Array.from(
        { length: ruleset.columns },
        (_, column) => board[row]?.[column]?.toUpperCase() ?? null,
      ),
    ),
    columns: ruleset.columns,
    dictionaryVersion: ruleset.dictionaryVersion,
    minimumWordLength: ruleset.minimumWordLength,
    rows: ruleset.rows,
    scoringRulesVersion: ruleset.scoringRulesVersion,
  };
}

export function parseBoardSolverCacheKey(key: string): BoardSolverInput {
  return JSON.parse(key) as BoardSolverInput;
}

export function solveBoardInWorker(
  input: BoardSolverInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SolvedBoardWord[]> {
  const { signal, timeoutMs = 7_000 } = options;
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Board analysis was cancelled.", "AbortError"));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const request = disposeRequest(id);
      if (!request) return;
      console.warn("Board solver exceeded its bounded analysis window.", {
        boardSize: `${input.rows}x${input.columns}`,
        dictionaryVersion: input.dictionaryVersion,
      });
      request.reject(
        new Error("Possible-word analysis is taking longer than expected."),
      );
      failAndTerminateWorker(
        new Error("Possible-word analysis is taking longer than expected."),
      );
    }, timeoutMs);
    const handleAbort = signal
      ? () => {
          const request = disposeRequest(id);
          if (!request) return;
          request.reject(
            new DOMException("Board analysis was cancelled.", "AbortError"),
          );
          terminateWorkerWhenIdle();
        }
      : null;
    pending.set(id, {
      reject,
      resolve,
      timeoutId,
      abortSignal: signal ?? null,
      handleAbort,
    });
    signal?.addEventListener("abort", handleAbort!, { once: true });
    getWorker().postMessage({
      activeCells: input.activeCells,
      board: input.board,
      cacheKey: JSON.stringify(input),
      columns: input.columns,
      dictionaryVersion: input.dictionaryVersion,
      id,
      minimumWordLength: input.minimumWordLength,
      rows: input.rows,
      scoringRulesVersion: input.scoringRulesVersion,
    });
  });
}
