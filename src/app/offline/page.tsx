import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="offline-page">
      <section>
        <p>Letter Rush · offline</p>
        <h1>No signal yet.</h1>
        <p>
          A loaded single-player round keeps working without a connection.
          Private lobbies, authentication, Realtime updates, and result
          submission require the network.
        </p>
        <Link href="/">Try the cached game shell</Link>
      </section>
    </main>
  );
}
