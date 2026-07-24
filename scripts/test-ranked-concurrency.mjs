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

const initializedIdentities = await Promise.all(
  clients.map((supabase) => supabase.rpc("ensure_current_player_identity")),
);
for (const initialization of initializedIdentities) {
  assert.ifError(initialization.error);
  const identity = initialization.data?.[0];
  assert(identity, "Identity initialization must return one profile.");
  assert.deepEqual(
    Object.keys(identity).sort(),
    ["display_name", "public_profile_id"],
    "The identity RPC must not expose an auth UUID.",
  );
  assert.match(
    identity.public_profile_id,
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/u,
    "Every public profile ID must use the opaque server format.",
  );
}
assert.equal(
  new Set(
    initializedIdentities.map(
      (initialization) => initialization.data[0].public_profile_id,
    ),
  ).size,
  clients.length,
  "Anonymous users must receive unique public profile IDs.",
);

const concurrentIdentityAttempts = await Promise.all(
  Array.from({ length: 12 }, () =>
    clients[0].rpc("ensure_current_player_identity"),
  ),
);
for (const initialization of concurrentIdentityAttempts) {
  assert.ifError(initialization.error);
  assert.equal(
    initialization.data?.[0]?.public_profile_id,
    initializedIdentities[0].data[0].public_profile_id,
    "Concurrent initialization must preserve the first public profile ID.",
  );
}

const {
  data: { user: firstUser },
} = await clients[0].auth.getUser();
assert(firstUser, "The first anonymous session must have an auth user.");
const profileRows = await clients[0]
  .from("profiles")
  .select("display_name, public_profile_id")
  .eq("id", firstUser.id);
assert.ifError(profileRows.error);
assert.equal(
  profileRows.data?.length,
  1,
  "Concurrent initialization must leave exactly one profile row.",
);
const rankedRows = await clients[0]
  .from("ranked_stats")
  .select("current_rating")
  .eq("user_id", firstUser.id);
assert.ifError(rankedRows.error);
assert.equal(
  rankedRows.data?.length,
  1,
  "Concurrent initialization must leave exactly one ranked-stat row.",
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
  "Ranked local concurrency checks passed: collision-safe profile initialization, one profile/stat row under concurrent retries, one two-player match, one waiting entrant, idempotent recovery, cancellation guard, and queue RLS.",
);
