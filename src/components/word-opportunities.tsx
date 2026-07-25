import type {
  WordOpportunity,
  WordOpportunityRequestStatus,
} from "@/hooks/use-word-opportunities";

import styles from "./word-opportunities.module.css";

type WordOpportunitiesProps = {
  error?: string | null;
  onRetry?: () => void;
  status: WordOpportunityRequestStatus;
  words: readonly WordOpportunity[];
};

export function WordOpportunities({
  error = null,
  onRetry,
  status,
  words,
}: WordOpportunitiesProps) {
  return (
    <section className={styles.opportunities} aria-labelledby="longest-words">
      <div>
        <p>Board review</p>
        <h2 id="longest-words">10 longest possible words</h2>
      </div>
      {status === "loading" ? (
        <p role="status">Solving the complete board…</p>
      ) : status === "error" ? (
        <div role="status">
          <p>{error ?? "Possible-word analysis could not be completed."}</p>
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              Retry analysis
            </button>
          ) : null}
        </div>
      ) : status === "success" && words.length ? (
        <ol>
          {words.map((entry) => (
            <li key={entry.word}>
              <strong>{entry.word}</strong>
              <span>
                {entry.word_length} letters · {entry.score.toLocaleString()}
                {entry.was_found ? " · Found" : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : status === "success" ? (
        <p>No playable words were available for this board.</p>
      ) : (
        <p>Possible-word analysis is waiting for the completed board.</p>
      )}
    </section>
  );
}
