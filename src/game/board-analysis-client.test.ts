import { describe, expect, it, vi } from "vitest";

import { BoardAnalysisRegistry } from "./board-analysis-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const CAT = { score: 100, word: "CAT", word_length: 3 };
const CATER = { score: 800, word: "CATER", word_length: 5 };

describe("BoardAnalysisRegistry", () => {
  it("starts the worker immediately before the optional server cache", async () => {
    const order: string[] = [];
    const registry = new BoardAnalysisRegistry(() => undefined);
    const subscription = registry.request({
      key: "board-a",
      loadServerCache: async () => {
        order.push("server");
        return [];
      },
      solveLocally: async () => {
        order.push("worker");
        return [CAT];
      },
    });

    expect(order).toEqual(["worker", "server"]);
    await expect(subscription.promise).resolves.toMatchObject({
      source: "worker",
      words: [{ ...CAT, recognizable: true }],
    });
  });

  it.each([
    new Error("HTTP 500"),
    { code: "57014", message: "canceling statement due to statement timeout" },
    new Error("advisory lock unavailable"),
  ])(
    "falls back to the worker when the server fails with %o",
    async (error) => {
      const registry = new BoardAnalysisRegistry(() => undefined);
      const subscription = registry.request({
        key: `fallback-${String(error)}`,
        loadServerCache: async () => {
          throw error;
        },
        solveLocally: async () => [CAT],
      });
      await expect(subscription.promise).resolves.toMatchObject({
        source: "worker",
        words: [{ ...CAT, recognizable: true }],
      });
    },
  );

  it("does not let a never-resolving server keep a successful worker loading", async () => {
    const registry = new BoardAnalysisRegistry(() => undefined);
    const subscription = registry.request({
      deadlineMs: 25,
      key: "hanging-server",
      loadServerCache: () => new Promise(() => undefined),
      solveLocally: async () => [CAT],
    });
    await expect(subscription.promise).resolves.toMatchObject({
      source: "worker",
    });
  });

  it("moves a failed worker to a bounded error instead of loading forever", async () => {
    const registry = new BoardAnalysisRegistry(() => undefined);
    const subscription = registry.request({
      deadlineMs: 10,
      key: "worker-failure",
      loadServerCache: () => new Promise(() => undefined),
      solveLocally: async () => {
        throw new Error("worker failed");
      },
    });
    await expect(subscription.promise).rejects.toThrow(
      "taking longer than expected",
    );
  });

  it("preserves the Retry-state message when the worker reaches its own timeout", async () => {
    const registry = new BoardAnalysisRegistry(() => undefined);
    const subscription = registry.request({
      key: "worker-timeout",
      loadServerCache: async () => [],
      solveLocally: async () => {
        throw new Error(
          "Possible-word analysis is taking longer than expected.",
        );
      },
    });
    await expect(subscription.promise).rejects.toThrow(
      "Possible-word analysis is taking longer than expected.",
    );
  });

  it("deduplicates repeated subscribers for the same stable key", async () => {
    const local = deferred<unknown>();
    const solveLocally = vi.fn(() => local.promise);
    const registry = new BoardAnalysisRegistry(() => undefined);
    const first = registry.request({ key: "same-board", solveLocally });
    const second = registry.request({ key: "same-board", solveLocally });

    expect(solveLocally).toHaveBeenCalledTimes(1);
    expect(first.generationId).toBe(second.generationId);
    expect(first.promise).toBe(second.promise);
    local.resolve([CAT]);
    await Promise.all([first.promise, second.promise]);
  });

  it("preserves in-flight work across a same-turn effect cleanup and remount", async () => {
    const local = deferred<unknown>();
    const solveLocally = vi.fn(() => local.promise);
    const registry = new BoardAnalysisRegistry(() => undefined);
    const first = registry.request({ key: "strict-mode-board", solveLocally });
    first.release();
    const remounted = registry.request({
      key: "strict-mode-board",
      solveLocally,
    });
    await Promise.resolve();

    expect(solveLocally).toHaveBeenCalledTimes(1);
    expect(remounted.generationId).toBe(first.generationId);
    local.resolve([CAT]);
    await expect(remounted.promise).resolves.toMatchObject({
      source: "worker",
    });
  });

  it("reuses successful session results without launching another worker", async () => {
    const solveLocally = vi.fn(async () => [CAT]);
    const registry = new BoardAnalysisRegistry(() => undefined);
    await registry.request({ key: "cached-board", solveLocally }).promise;
    const cached = registry.request({ key: "cached-board", solveLocally });

    await expect(cached.promise).resolves.toMatchObject({
      source: "session-cache",
    });
    expect(solveLocally).toHaveBeenCalledTimes(1);
  });

  it("uses different generations and work for different board keys", async () => {
    const solveLocally = vi.fn(async () => [CAT]);
    const registry = new BoardAnalysisRegistry(() => undefined);
    const first = registry.request({ key: "board-one", solveLocally });
    const second = registry.request({ key: "board-two", solveLocally });
    await Promise.all([first.promise, second.promise]);

    expect(first.generationId).not.toBe(second.generationId);
    expect(solveLocally).toHaveBeenCalledTimes(2);
  });

  it("ignores stale server completion after worker success", async () => {
    const server = deferred<unknown>();
    const registry = new BoardAnalysisRegistry(() => undefined);
    const subscription = registry.request({
      key: "worker-wins",
      loadServerCache: () => server.promise,
      solveLocally: async () => [CATER],
    });
    await expect(subscription.promise).resolves.toMatchObject({
      source: "worker",
      words: [{ ...CATER, recognizable: true }],
    });
    server.resolve([CAT]);
    await Promise.resolve();
    await expect(subscription.promise).resolves.toMatchObject({
      source: "worker",
    });
  });

  it("ignores stale worker completion after a valid server cache wins", async () => {
    const worker = deferred<unknown>();
    const registry = new BoardAnalysisRegistry(() => undefined);
    const subscription = registry.request({
      key: "server-wins",
      loadServerCache: async () => [{ ...CAT, recognizable: false }],
      solveLocally: () => worker.promise,
    });
    await expect(subscription.promise).resolves.toMatchObject({
      source: "server-cache",
      words: [{ ...CAT, recognizable: false }],
    });
    worker.resolve([CATER]);
    await Promise.resolve();
    await expect(subscription.promise).resolves.toMatchObject({
      source: "server-cache",
    });
  });

  it("aborts an obsolete worker when the last subscriber unmounts", async () => {
    const registry = new BoardAnalysisRegistry(() => undefined);
    const workerSignals: AbortSignal[] = [];
    const subscription = registry.request({
      key: "unmounted-board",
      solveLocally: (signal) => {
        workerSignals.push(signal);
        return new Promise(() => undefined);
      },
    });
    subscription.release();
    await Promise.resolve();

    expect(workerSignals[0].aborted).toBe(true);
    await expect(subscription.promise).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("launches exactly one new generation when a failed request is retried", async () => {
    const solveLocally = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce([CAT]);
    const registry = new BoardAnalysisRegistry(() => undefined);
    await expect(
      registry.request({ key: "retry-board", solveLocally }).promise,
    ).rejects.toThrow();
    await expect(
      registry.request({ key: "retry-board", solveLocally }).promise,
    ).resolves.toMatchObject({ source: "worker" });
    expect(solveLocally).toHaveBeenCalledTimes(2);
  });

  it("validates, deduplicates, sorts, and caps successful results at ten", async () => {
    const words = Array.from({ length: 12 }, (_, index) => {
      const word = "A".repeat(index + 3);
      return { score: index, word, word_length: word.length };
    });
    const registry = new BoardAnalysisRegistry(() => undefined);
    const result = await registry.request({
      key: "bounded-results",
      solveLocally: async () => [...words, words[11]],
    }).promise;

    expect(result.words).toHaveLength(10);
    expect(result.words[0].word_length).toBe(14);
    expect(new Set(result.words.map(({ word }) => word)).size).toBe(10);
  });
});
