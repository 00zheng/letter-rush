import { NextResponse } from "next/server";

import { generateBoard } from "@/game/board";
import { assertDictionaryVersion } from "@/game/dictionary";
import { SCORING_RULES_VERSION, validateRuleset } from "@/game/ruleset";
import type { Json } from "@/lib/supabase/database.types";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  isWithinResultSubmissionWindow,
  parseResultRequest,
  validateMatchSubmissions,
} from "@/multiplayer/validation";
import { RANKED_RULESET_VERSION, isRankedRuleset } from "@/ranked/ruleset";

const MAX_RESULT_BODY_BYTES = 500_000;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);

  if (contentLength > MAX_RESULT_BODY_BYTES) {
    return NextResponse.json(
      { error: "The result payload is too large." },
      { status: 413 },
    );
  }

  let rawBody: unknown;

  try {
    const text = await request.text();

    if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BODY_BYTES) {
      return NextResponse.json(
        { error: "The result payload is too large." },
        { status: 413 },
      );
    }

    rawBody = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "The result payload must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = parseResultRequest(rawBody);

  if (!parsed.isValid) {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "A valid anonymous session is required." },
        { status: 401 },
      );
    }

    const [
      { data: match, error: matchError },
      { data: player, error: playerError },
      { data: serverNow, error: timeError },
    ] = await Promise.all([
      supabase
        .from("matches")
        .select(
          "id, board_seed, round_duration_seconds, scheduled_start_at, status, ruleset, dictionary_version, mode, scoring_version, ranked_ruleset_version",
        )
        .eq("id", parsed.matchId)
        .maybeSingle(),
      supabase
        .from("match_players")
        .select("finished_at, validated_score")
        .eq("match_id", parsed.matchId)
        .eq("player_user_id", user.id)
        .maybeSingle(),
      supabase.rpc("get_server_time"),
    ]);

    if (
      matchError ||
      playerError ||
      timeError ||
      !match ||
      !player ||
      !serverNow
    ) {
      console.error("Participant-scoped result state could not be loaded.", {
        category: "result_state_unavailable",
        matchReadFailed: Boolean(matchError),
        playerReadFailed: Boolean(playerError),
        timeReadFailed: Boolean(timeError),
      });
      return NextResponse.json(
        { error: "You cannot access this match or it is no longer available." },
        { status: 403 },
      );
    }

    if (player.finished_at) {
      return NextResponse.json({
        score: player.validated_score ?? 0,
        alreadyFinalized: true,
        message: "This result was already validated.",
      });
    }

    if (!match.scheduled_start_at) {
      return NextResponse.json(
        { error: "This match has not been scheduled." },
        { status: 409 },
      );
    }

    if (
      !isWithinResultSubmissionWindow(
        match.scheduled_start_at,
        match.round_duration_seconds,
        serverNow,
      )
    ) {
      return NextResponse.json(
        {
          error:
            "The result arrived outside the round window and 15-second network grace period.",
        },
        { status: 409 },
      );
    }

    const rulesetValidation = validateRuleset(match.ruleset);
    if (!rulesetValidation.isValid) {
      return NextResponse.json(
        { error: "This match uses an unsupported ruleset." },
        { status: 409 },
      );
    }

    if (
      match.mode === "ranked" &&
      (!isRankedRuleset(rulesetValidation.ruleset) ||
        match.scoring_version !== SCORING_RULES_VERSION ||
        match.ranked_ruleset_version !== RANKED_RULESET_VERSION)
    ) {
      console.error("Rejected ranked result with a non-canonical snapshot.", {
        category: "ranked_ruleset_mismatch",
      });
      return NextResponse.json(
        { error: "This ranked match uses an unsupported rules snapshot." },
        { status: 409 },
      );
    }

    assertDictionaryVersion(match.dictionary_version);
    const board = generateBoard(match.board_seed, rulesetValidation.ruleset);
    const validation = await validateMatchSubmissions(
      board,
      parsed.submissions,
      rulesetValidation.ruleset,
    );

    if (!validation.isValid) {
      return NextResponse.json({ error: validation.message }, { status: 422 });
    }

    const normalizedSubmissions = validation.submissions.map(
      ({ word, path }) => ({ word, path }),
    );
    const { data, error } = await supabase.rpc("submit_match_result", {
      p_match_id: parsed.matchId,
      p_submissions: normalizedSubmissions as unknown as Json,
    });
    const result = data?.[0];

    if (error || !result) {
      console.error("Validated result could not be finalized.", {
        category: "result_storage_failure",
        databaseCode: error?.code ?? "missing_result",
      });
      return NextResponse.json(
        { error: "The validated result could not be finalized. Try again." },
        { status: 409 },
      );
    }

    return NextResponse.json({
      score: result.validated_score,
      alreadyFinalized: result.already_finalized,
      matchCompleted: result.match_completed,
      message: result.already_finalized
        ? "This result was already validated."
        : "Result validated by the server.",
    });
  } catch (error) {
    console.error("Authoritative result validation failed.", {
      category: "result_validation_failure",
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      {
        error: "Multiplayer validation is temporarily unavailable. Try again.",
      },
      { status: 503 },
    );
  }
}
