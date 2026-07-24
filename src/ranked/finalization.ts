import type { RankedOutcome } from "./rating";

export type RankedFinalizationDecision =
  | { status: "waiting" }
  | { status: "abandoned" }
  | {
      status: "complete";
      firstOutcome: RankedOutcome;
      secondOutcome: RankedOutcome;
    };

/**
 * Pure mirror of the database timeout policy. A client may present this state,
 * but only the locked database finalizer may persist outcomes or ratings.
 */
export function decideRankedFinalization(input: {
  firstScore: number | null;
  secondScore: number | null;
  recoveryWindowExpired: boolean;
}): RankedFinalizationDecision {
  const { firstScore, secondScore } = input;

  if (firstScore === null || secondScore === null) {
    if (!input.recoveryWindowExpired) return { status: "waiting" };
    if (firstScore === null && secondScore === null) {
      return { status: "abandoned" };
    }
    return firstScore !== null
      ? {
          status: "complete",
          firstOutcome: "win",
          secondOutcome: "forfeit",
        }
      : {
          status: "complete",
          firstOutcome: "forfeit",
          secondOutcome: "win",
        };
  }

  if (firstScore === secondScore) {
    return {
      status: "complete",
      firstOutcome: "tie",
      secondOutcome: "tie",
    };
  }

  return firstScore > secondScore
    ? {
        status: "complete",
        firstOutcome: "win",
        secondOutcome: "loss",
      }
    : {
        status: "complete",
        firstOutcome: "loss",
        secondOutcome: "win",
      };
}
