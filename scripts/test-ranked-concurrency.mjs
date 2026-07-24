import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(url)) {
  throw new Error(
    "Ranked concurrency tests are local-only; NEXT_PUBLIC_SUPABASE_URL must use localhost or 127.0.0.1.",
  );
}
if (!publishableKey) {
  throw new Error(
    "Set the local NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY returned by `npx supabase status`.",
  );
}

function client() {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const clients = [client(), client(), client()];
await Promise.all(
  clients.map(async (supabase) => {
    const { error } = await supabase.auth.signInAnonymously();
    assert.ifError(error);
  }),
);

const attempts = await Promise.all(
  clients.map((supabase) => supabase.rpc("enter_ranked_queue")),
);
for (const attempt of attempts) assert.ifError(attempt.error);

const states = attempts.map((attempt) => attempt.data?.[0]);
assert(states.every(Boolean), "Every entrant must receive a queue state.");
const matched = states.filter((state) => state.queue_status === "matched");
const waiting = states.filter((state) => state.queue_status === "waiting");
assert.equal(matched.length, 2, "Exactly two of three entrants must match.");
assert.equal(waiting.length, 1, "The third entrant must remain waiting.");
assert.equal(
  new Set(matched.map((state) => state.match_id)).size,
  1,
  "Both matched players must receive the same match.",
);

const matchedClientIndex = states.findIndex(
  (state) => state.queue_status === "matched",
);
const waitingClientIndex = states.findIndex(
  (state) => state.queue_status === "waiting",
);

const duplicate = await clients[matchedClientIndex].rpc("enter_ranked_queue");
assert.ifError(duplicate.error);
assert.equal(
  duplicate.data?.[0]?.match_id,
  matched[0].match_id,
  "A duplicate enqueue must recover the existing active match.",
);

const enumerationChecks = await Promise.all(
  clients.map((supabase) =>
    supabase.from("ranked_queue").select("status, match_id"),
  ),
);
for (const check of enumerationChecks) {
  assert.ifError(check.error);
  assert.equal(
    check.data?.length,
    1,
    "RLS must expose only the caller's queue row.",
  );
}

const matchedCancel = await clients[matchedClientIndex].rpc(
  "cancel_ranked_queue",
);
assert(matchedCancel.error, "A matched queue row must not be cancellable.");
const waitingCancel = await clients[waitingClientIndex].rpc(
  "cancel_ranked_queue",
);
assert.ifError(waitingCancel.error);

console.log(
  "Ranked local concurrency checks passed: one two-player match, one waiting entrant, idempotent recovery, cancellation guard, and queue RLS.",
);
