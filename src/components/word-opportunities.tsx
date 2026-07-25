import type { WordOpportunity } from "@/hooks/use-word-opportunities";

import styles from "./word-opportunities.module.css";

type WordOpportunitiesProps = {
  error?: string | null;
  isLoading?: boolean;
  onRetry?: () => void;
  words: readonly WordOpportunity[];
};

export function WordOpportunities({
  error = null,
  isLoading = false,
  onRetry,
  words,
}: WordOpportunitiesProps) {
  return (
    <section className={styles.opportunities} aria-labelledby="longest-words">
      <div>
        <p>Board review</p>
        <h2 id="longest-words">10 longest possible words</h2>
      </div>
      {isLoading ? (
        <p role="status">Solving the complete board…</p>
      ) : error ? (
        <div role="status">
          <p>{error}</p>
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              Retry analysis
            </button>
          ) : null}
        </div>
      ) : words.length ? (
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
      ) : (
        <p>No playable words were available for this board.</p>
      )}
    </section>
  );
}
