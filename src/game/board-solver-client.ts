import type { SolvedBoardWord } from "./board-solver";
import type { GameRuleset } from "./ruleset";
import type { LetterBoard } from "./types";

type WorkerResponse =
  { id: number; words: SolvedBoardWord[] } | { id: number; error: string };

type PendingRequest = {
  reject: (reason: Error) => void;
  resolve: (words: SolvedBoardWord[]) => void;
  timeoutId: number;
};

const pending = new Map<number, PendingRequest>();
let nextRequestId = 0;
let solverWorker: Worker | null = null;

function getWorker(): Worker {
  if (solverWorker) return solverWorker;
  solverWorker = new Worker(
    new URL("../workers/board-solver.worker.ts", import.meta.url),
    { name: "letter-rush-board-solver", type: "module" },
  );
  solverWorker.addEventListener(
    "message",
    (event: MessageEvent<WorkerResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      window.clearTimeout(request.timeoutId);
      pending.delete(event.data.id);
      if ("error" in event.data) {
        request.reject(new Error(event.data.error));
      } else {
        request.resolve(event.data.words);
      }
    },
  );
  solverWorker.addEventListener("error", () => {
    for (const request of pending.values()) {
      window.clearTimeout(request.timeoutId);
      request.reject(new Error("Possible-word analysis failed."));
    }
    pending.clear();
    solverWorker?.terminate();
    solverWorker = null;
  });
  return solverWorker;
}

export function createBoardSolverCacheKey(
  board: LetterBoard,
  ruleset: GameRuleset,
): string {
  return JSON.stringify({
    activeCells: ruleset.activeCells,
    board,
    dictionaryVersion: ruleset.dictionaryVersion,
    minimumWordLength: ruleset.minimumWordLength,
    scoringRulesVersion: ruleset.scoringRulesVersion,
  });
}

export function solveBoardInWorker(
  board: LetterBoard,
  ruleset: GameRuleset,
  timeoutMs = 7_000,
): Promise<SolvedBoardWord[]> {
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pending.delete(id);
      console.warn("Board solver exceeded its bounded analysis window.", {
        boardSize: `${ruleset.rows}x${ruleset.columns}`,
        dictionaryVersion: ruleset.dictionaryVersion,
      });
      reject(
        new Error("Possible-word analysis is taking longer than expected."),
      );
    }, timeoutMs);
    pending.set(id, { reject, resolve, timeoutId });
    getWorker().postMessage({
      activeCells: [...ruleset.activeCells],
      board,
      cacheKey: createBoardSolverCacheKey(board, ruleset),
      columns: ruleset.columns,
      dictionaryVersion: ruleset.dictionaryVersion,
      id,
      minimumWordLength: ruleset.minimumWordLength,
      rows: ruleset.rows,
      scoringRulesVersion: ruleset.scoringRulesVersion,
    });
  });
}
