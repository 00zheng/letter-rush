export type RerollConsensus = "open" | "unanimous" | "closed";

export function deriveRerollConsensus(input: {
  participantCount: number;
  approvals: number;
  completedRerolls: number;
  previewOpen: boolean;
}): RerollConsensus {
  if (input.completedRerolls >= 3 || !input.previewOpen) return "closed";
  if (
    input.participantCount >= 2 &&
    input.approvals === input.participantCount
  ) {
    return "unanimous";
  }
  return "open";
}

export type RematchProposalState =
  "pending" | "accepted" | "declined" | "expired";

export function resolveRematchProposal(input: {
  state: RematchProposalState;
  databaseNowMs: number;
  expiresAtMs: number;
  response?: "accept" | "decline";
}): RematchProposalState {
  if (input.state !== "pending") return input.state;
  if (input.databaseNowMs >= input.expiresAtMs) return "expired";
  if (input.response === "accept") return "accepted";
  if (input.response === "decline") return "declined";
  return "pending";
}

export type SortableValidatedWord = {
  word: string;
  score: number;
};

export function sortValidatedWords<T extends SortableValidatedWord>(
  words: readonly T[],
): T[] {
  return [...words].sort(
    (first, second) =>
      second.score - first.score ||
      second.word.length - first.word.length ||
      first.word.localeCompare(second.word),
  );
}
