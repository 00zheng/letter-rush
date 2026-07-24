import type { Metadata } from "next";

import { AppHeader } from "@/components/app-header";

import styles from "./guide.module.css";

export const metadata: Metadata = {
  title: "Guide | Letter Rush",
  description:
    "How to play Letter Rush, understand scoring, configure boards, and troubleshoot account or connection issues.",
  alternates: { canonical: "/guide" },
};

export default function GuidePage() {
  return (
    <main className={styles.shell}>
      <AppHeader />
      <article className={styles.article}>
        <header className={styles.hero}>
          <h1>How to rush.</h1>
          <p>
            Connect neighboring letters, release to submit, and build the
            highest validated score before the shared clock ends.
          </p>
        </header>

        <section className={styles.section}>
          <h2>Core rules</h2>
          <ol>
            <li>
              Start on any active tile, then drag through letters touching by an
              edge or corner.
            </li>
            <li>
              A tile may appear only once in one word. Once selected, tiles stay
              in the path until release; dragging backward does not undo them.
            </li>
            <li>
              Release to submit. Words must meet the displayed minimum length
              and exist in the versioned Letter Rush dictionary.
            </li>
            <li>
              A new valid word turns the selected path green. A duplicate turns
              it yellow. White selection means it is incomplete or invalid.
            </li>
          </ol>
          <p>
            The compact header above the board keeps word count, score, and the
            authoritative timer together. Accepted words appear briefly as
            <strong> WORD (+POINTS)</strong>; duplicates show an already-found
            notice. The complete validated word list remains on the final
            results screen instead of occupying space during the round.
          </p>
          <h3>Classic scoring</h3>
          <p>
            Three letters score 100; four score 400; five score 800; six score
            1,400; seven score 1,800; eight or more score 2,200. Results list
            words by points, then length, then alphabetically.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Game modes</h2>
          <div className={styles.modes}>
            <article>
              <h3>Single Player</h3>
              <p>
                A server-timed personal run. Every result is regenerated and
                validated before statistics for that exact ruleset update. An
                unfinished round resumes with its original board and clock. An
                expired round is cancelled and replaced automatically.
              </p>
            </article>
            <article>
              <h3>Ranked Quick Match</h3>
              <p>
                Two players receive the same fixed 4×4, 60-second rules
                snapshot. Results update Elo exactly once.
              </p>
            </article>
            <article>
              <h3>Private Lobby</h3>
              <p>
                Invite 2–12 players and choose dimensions, duration, shape, or
                an exact connected custom mask.
              </p>
            </article>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Preview, rerolls, and rematches</h2>
          <p>
            Multiplayer rounds show the exact board for about eight seconds.
            Every current participant must approve a reroll; one successful
            reroll creates one new server seed and restarts the preview. A
            decline or timeout keeps the shown board.
          </p>
          <p>
            Ranked rematch proposals last 30 seconds and require the other
            player to accept. Private rematches create a new lobby with the same
            immutable rules and invitations for prior participants.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Leaving Single Player</h2>
          <p>
            Use <strong>Exit round</strong> and confirm to abandon an unfinished
            solo run. Partial words and score are not saved, mode statistics do
            not change, and a new round can start immediately. If a browser
            closes unexpectedly, the next solo request resumes a still-active
            round or replaces it after the server window and network grace
            period have expired.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Accounts and privacy</h2>
          <p>
            Gameplay requires a verified persistent account. If you previously
            played as a guest, use Claim Account: verification upgrades that
            same auth identity, preserving its opaque player ID, rating, and
            history. Public pages show only display names, game statistics, and
            opaque profile IDs—not email addresses or auth UUIDs.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Accessibility</h2>
          <ul>
            <li>
              Every tile and custom-mask cell has a descriptive label and
              pressed or selected state.
            </li>
            <li>
              Submission feedback is announced politely without interrupting the
              timer.
            </li>
            <li>
              Touch targets are sized for phones, focus remains visible, and
              reduced-motion preferences disable nonessential transitions.
            </li>
            <li>
              Color feedback is paired with text; it is never the only source of
              meaning.
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Troubleshooting</h2>
          <h3>Email link expired</h3>
          <p>Request a new confirmation or password-recovery email.</p>
          <h3>Connection dropped during a round</h3>
          <p>
            Reconnect promptly. Multiplayer drafts remain on the device and the
            authoritative server window continues; a missing ranked submission
            can become a forfeit after the recovery window.
          </p>
          <h3>Solo round left unfinished</h3>
          <p>
            Start Single Player again. Letter Rush restores the authoritative
            board while it is active, or expires it and starts a fresh round
            when its grace period has passed.
          </p>
          <h3>Installed app is offline</h3>
          <p>
            The offline screen and guide remain available, but authenticated
            gameplay and saved data require a connection.
          </p>
        </section>
      </article>
    </main>
  );
}
