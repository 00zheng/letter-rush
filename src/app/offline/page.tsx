import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="offline-page">
      <section>
        <p>Letter Rush · offline</p>
        <h1>No signal yet.</h1>
        <p>
          Authenticated games and saved statistics require a connection.
          Reconnect, then restore your round or start a new one.
        </p>
        <Link href="/guide">Read the cached guide</Link>
      </section>
    </main>
  );
}
