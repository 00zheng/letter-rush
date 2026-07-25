import { compareSolvedBoardWords, type SolvedBoardWord } from "./board-solver";

export type BoardAnalysisWord = SolvedBoardWord & {
  recognizable: boolean;
};

export type BoardAnalysisSource = "session-cache" | "server-cache" | "worker";

export type BoardAnalysisResult = {
  generationId: number;
  source: BoardAnalysisSource;
  words: BoardAnalysisWord[];
};

export type BoardAnalysisRequest = {
  key: string;
  deadlineMs?: number;
  loadServerCache?: (
    signal: AbortSignal,
    generationId: number,
  ) => Promise<unknown>;
  solveLocally: (signal: AbortSignal, generationId: number) => Promise<unknown>;
};

export type BoardAnalysisSubscription = {
  generationId: number;
  promise: Promise<BoardAnalysisResult>;
  release: () => void;
};

type InFlightAnalysis = {
  controller: AbortController;
  generationId: number;
  promise: Promise<BoardAnalysisResult>;
  subscribers: number;
};

type DiagnosticEvent = {
  elapsedMs?: number;
  generationId: number;
  key: string;
  phase:
    | "cache-hit"
    | "request-cancelled"
    | "request-start"
    | "server-cache-miss"
    | "server-failed"
    | "server-start"
    | "success"
    | "timeout"
    | "worker-failed"
    | "worker-start";
  source?: BoardAnalysisSource;
};

function abortError(message = "Board analysis was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function normalizeWords(
  value: unknown,
  recognizableByDefault: boolean,
): BoardAnalysisWord[] | null {
  if (!Array.isArray(value)) return null;

  const unique = new Map<string, BoardAnalysisWord>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as Record<string, unknown>;
    const word = record.word;
    const wordLength = record.word_length;
    const score = record.score;
    const recognizable = record.recognizable;
    if (
      typeof word !== "string" ||
      !/^[A-Z]+$/u.test(word) ||
      !Number.isInteger(wordLength) ||
      wordLength !== word.length ||
      !Number.isInteger(score) ||
      (score as number) < 0 ||
      (recognizable !== undefined && typeof recognizable !== "boolean")
    ) {
      return null;
    }
    unique.set(word, {
      recognizable:
        typeof recognizable === "boolean"
          ? recognizable
          : recognizableByDefault,
      score: score as number,
      word,
      word_length: wordLength as number,
    });
  }

  return [...unique.values()].sort(compareSolvedBoardWords).slice(0, 10);
}

function defaultDiagnostic(event: DiagnosticEvent): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug("Board analysis diagnostic.", event);
}

export class BoardAnalysisRegistry {
  readonly #cache = new Map<string, BoardAnalysisWord[]>();
  readonly #inFlight = new Map<string, InFlightAnalysis>();
  readonly #diagnostic: (event: DiagnosticEvent) => void;
  #nextGenerationId = 0;

  constructor(
    diagnostic: (event: DiagnosticEvent) => void = defaultDiagnostic,
  ) {
    this.#diagnostic = diagnostic;
  }

  request(input: BoardAnalysisRequest): BoardAnalysisSubscription {
    const generationId = ++this.#nextGenerationId;
    const cached = this.#cache.get(input.key);
    if (cached) {
      this.#diagnostic({
        generationId,
        key: input.key,
        phase: "cache-hit",
        source: "session-cache",
      });
      return {
        generationId,
        promise: Promise.resolve({
          generationId,
          source: "session-cache",
          words: cached,
        }),
        release: () => undefined,
      };
    }

    const existing = this.#inFlight.get(input.key);
    if (existing) {
      existing.subscribers += 1;
      return this.subscriptionFor(input.key, existing);
    }

    const controller = new AbortController();
    const analysis: InFlightAnalysis = {
      controller,
      generationId,
      promise: Promise.resolve({
        generationId,
        source: "worker",
        words: [],
      }),
      subscribers: 1,
    };
    analysis.promise = this.run(input, controller, generationId)
      .then((result) => {
        if (this.#cache.size >= 32 && !this.#cache.has(input.key)) {
          this.#cache.delete(this.#cache.keys().next().value ?? "");
        }
        this.#cache.set(input.key, result.words);
        return result;
      })
      .finally(() => {
        const current = this.#inFlight.get(input.key);
        if (current?.generationId === generationId) {
          this.#inFlight.delete(input.key);
        }
      });
    this.#inFlight.set(input.key, analysis);
    return this.subscriptionFor(input.key, analysis);
  }

  clear(): void {
    for (const analysis of this.#inFlight.values()) {
      analysis.controller.abort();
    }
    this.#inFlight.clear();
    this.#cache.clear();
  }

  private subscriptionFor(
    key: string,
    analysis: InFlightAnalysis,
  ): BoardAnalysisSubscription {
    let released = false;
    return {
      generationId: analysis.generationId,
      promise: analysis.promise,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#inFlight.get(key);
        if (!current || current.generationId !== analysis.generationId) return;
        current.subscribers -= 1;
        if (current.subscribers > 0) return;
        queueMicrotask(() => {
          const abandoned = this.#inFlight.get(key);
          if (
            !abandoned ||
            abandoned.generationId !== analysis.generationId ||
            abandoned.subscribers > 0
          ) {
            return;
          }
          this.#diagnostic({
            generationId: abandoned.generationId,
            key,
            phase: "request-cancelled",
          });
          abandoned.controller.abort();
        });
      },
    };
  }

  private run(
    input: BoardAnalysisRequest,
    controller: AbortController,
    generationId: number,
  ): Promise<BoardAnalysisResult> {
    const deadlineMs = input.deadlineMs ?? 8_000;
    this.#diagnostic({
      generationId,
      key: input.key,
      phase: "request-start",
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let workerSettled = false;
      let serverSettled = !input.loadServerCache;
      let lastError: unknown = null;
      const startedAt = performance.now();

      const finish = (
        source: Exclude<BoardAnalysisSource, "session-cache">,
        words: BoardAnalysisWord[],
      ) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(deadline);
        controller.signal.removeEventListener("abort", handleAbort);
        this.#diagnostic({
          elapsedMs: Math.round(performance.now() - startedAt),
          generationId,
          key: input.key,
          phase: "success",
          source,
        });
        resolve({ generationId, source, words });
        controller.abort();
      };

      const failIfComplete = () => {
        if (settled || !workerSettled || !serverSettled) return;
        settled = true;
        globalThis.clearTimeout(deadline);
        controller.signal.removeEventListener("abort", handleAbort);
        reject(
          isAbortError(lastError)
            ? lastError
            : lastError instanceof Error &&
                lastError.message.includes("taking longer than expected")
              ? lastError
              : new Error("Possible-word analysis could not be completed."),
        );
      };

      const handleAbort = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(deadline);
        reject(abortError());
      };

      const deadline = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", handleAbort);
        this.#diagnostic({
          elapsedMs: Math.round(performance.now() - startedAt),
          generationId,
          key: input.key,
          phase: "timeout",
        });
        controller.abort();
        reject(
          new Error("Possible-word analysis is taking longer than expected."),
        );
      }, deadlineMs);
      controller.signal.addEventListener("abort", handleAbort, { once: true });

      this.#diagnostic({
        generationId,
        key: input.key,
        phase: "worker-start",
      });
      let workerPromise: Promise<unknown>;
      try {
        workerPromise = input.solveLocally(controller.signal, generationId);
      } catch (error) {
        workerPromise = Promise.reject(error);
      }
      void workerPromise.then(
        (value) => {
          workerSettled = true;
          const words = normalizeWords(value, true);
          if (words) {
            finish("worker", words);
            return;
          }
          lastError = new Error("The local solver returned invalid data.");
          this.#diagnostic({
            generationId,
            key: input.key,
            phase: "worker-failed",
          });
          failIfComplete();
        },
        (error: unknown) => {
          workerSettled = true;
          lastError = error;
          this.#diagnostic({
            generationId,
            key: input.key,
            phase: "worker-failed",
          });
          failIfComplete();
        },
      );

      if (input.loadServerCache) {
        this.#diagnostic({
          generationId,
          key: input.key,
          phase: "server-start",
        });
        let serverPromise: Promise<unknown>;
        try {
          serverPromise = input.loadServerCache(
            controller.signal,
            generationId,
          );
        } catch (error) {
          serverPromise = Promise.reject(error);
        }
        void serverPromise.then(
          (value) => {
            serverSettled = true;
            const words = normalizeWords(value, false);
            if (words && words.length > 0) {
              finish("server-cache", words);
              return;
            }
            this.#diagnostic({
              generationId,
              key: input.key,
              phase: "server-cache-miss",
            });
            failIfComplete();
          },
          (error: unknown) => {
            serverSettled = true;
            if (!isAbortError(error)) lastError = error;
            this.#diagnostic({
              generationId,
              key: input.key,
              phase: "server-failed",
            });
            failIfComplete();
          },
        );
      }
    });
  }
}

export const boardAnalysisRegistry = new BoardAnalysisRegistry();

export { isAbortError as isBoardAnalysisAbortError };
