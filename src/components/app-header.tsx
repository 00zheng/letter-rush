import styles from "./letter-rush-game.module.css";

export function AppHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          LR
        </span>
        <div>
          <strong>Letter Rush</strong>
          <small>Daily word sprint</small>
        </div>
      </div>
      <p>
        Find fast.
        <br />
        Link smart.
      </p>
      <span className={styles.issue}>No. 002</span>
    </header>
  );
}
