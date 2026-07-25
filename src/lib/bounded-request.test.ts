import { describe, expect, it, vi } from "vitest";

import { BoundedRequestGate } from "./bounded-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("BoundedRequestGate", () => {
  it("ignores rapid duplicate starts while one request is pending", async () => {
    const pending = deferred<string>();
    const operation = vi.fn(() => pending.promise);
    const gate = new BoundedRequestGate();
    const first = gate.start(operation, 1_000);
    const duplicate = gate.start(operation, 1_000);

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(operation).toHaveBeenCalledTimes(1);
    pending.resolve("created");
    await expect(first!.promise).resolves.toBe("created");
    expect(gate.isPending).toBe(false);
  });

  it("restores availability after failure and starts one explicit retry", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValueOnce("created");
    const gate = new BoundedRequestGate();
    await expect(gate.start(operation, 1_000)!.promise).rejects.toThrow(
      "HTTP 500",
    );
    await expect(gate.start(operation, 1_000)!.promise).resolves.toBe(
      "created",
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("bounds a request even when the underlying operation never resolves", async () => {
    const gate = new BoundedRequestGate();
    const signals: AbortSignal[] = [];
    const request = gate.start((requestSignal) => {
      signals.push(requestSignal);
      return new Promise(() => undefined);
    }, 5)!;

    await expect(request.promise).rejects.toMatchObject({
      message: "The request timed out.",
      name: "AbortError",
    });
    expect(signals[0].aborted).toBe(true);
    expect(gate.isPending).toBe(false);
  });

  it("cancels navigation-obsolete work and ignores its late success", async () => {
    const pending = deferred<string>();
    const gate = new BoundedRequestGate();
    const request = gate.start(() => pending.promise, 1_000)!;
    gate.cancel();
    pending.resolve("obsolete lobby");

    await expect(request.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(gate.isPending).toBe(false);
  });
});
