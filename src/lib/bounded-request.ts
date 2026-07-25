export type BoundedRequest<T> = {
  generationId: number;
  promise: Promise<T>;
};

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export class BoundedRequestGate {
  #active:
    | {
        controller: AbortController;
        generationId: number;
        reject: (reason: Error) => void;
      }
    | undefined;
  #latestGenerationId = 0;

  get isPending(): boolean {
    return this.#active !== undefined;
  }

  isLatest(generationId: number): boolean {
    return this.#latestGenerationId === generationId;
  }

  start<T>(
    operation: (signal: AbortSignal, generationId: number) => Promise<T>,
    timeoutMs: number,
  ): BoundedRequest<T> | null {
    if (this.#active) return null;

    const generationId = ++this.#latestGenerationId;
    const controller = new AbortController();
    let rejectBound!: (reason: Error) => void;
    const bounded = new Promise<never>((_, reject) => {
      rejectBound = reject;
    });
    this.#active = {
      controller,
      generationId,
      reject: rejectBound,
    };
    const timeoutId = globalThis.setTimeout(() => {
      if (this.#active?.generationId !== generationId) return;
      controller.abort();
      rejectBound(abortError("The request timed out."));
    }, timeoutMs);

    let operationPromise: Promise<T>;
    try {
      operationPromise = operation(controller.signal, generationId);
    } catch (error) {
      operationPromise = Promise.reject(error);
    }

    const promise = Promise.race([operationPromise, bounded]).finally(() => {
      globalThis.clearTimeout(timeoutId);
      if (this.#active?.generationId === generationId) {
        this.#active = undefined;
      }
    });
    return { generationId, promise };
  }

  cancel(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    active.controller.abort();
    active.reject(abortError("The request was cancelled."));
  }
}
