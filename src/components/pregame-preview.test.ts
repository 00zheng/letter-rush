import { describe, expect, it } from "vitest";

import { isNewerPreviewState, type PreviewState } from "./pregame-preview";

function state(overrides: Partial<PreviewState> = {}): PreviewState {
  return {
    board_revision: 2,
    board_seed: 20,
    match_status: "starting",
    participant_count: 2,
    preview_ends_at: "2026-07-25T00:00:08.000Z",
    preview_started_at: "2026-07-25T00:00:00.000Z",
    reroll_approvals: 0,
    reroll_declines: 0,
    reroll_expires_at: null,
    reroll_sequence: 2,
    reroll_status: "idle",
    reroll_vote_revision: 3,
    scheduled_start_at: "2026-07-25T00:00:08.000Z",
    server_now: "2026-07-25T00:00:01.000Z",
    skip_approvals: 0,
    ...overrides,
  };
}

describe("preview snapshot ordering", () => {
  it("rejects an older board even if its response arrives later", () => {
    expect(
      isNewerPreviewState(
        state({
          board_revision: 1,
          server_now: "2026-07-25T00:00:07.000Z",
        }),
        state(),
      ),
    ).toBe(false);
  });

  it("rejects an old vote cycle on the current board", () => {
    expect(
      isNewerPreviewState(
        state({ reroll_vote_revision: 2 }),
        state({ reroll_vote_revision: 3 }),
      ),
    ).toBe(false);
  });

  it("accepts a newer board atomically", () => {
    expect(isNewerPreviewState(state({ board_revision: 3 }), state())).toBe(
      true,
    );
  });
});
